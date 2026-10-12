import type { AgentRegistry, ToolRegistry } from "@research/agent-core";
import {
	type Clock,
	type FeedFetchDeps,
	type Hasher,
	ingestSources,
	type PipelineOutcome,
	type PipelineReporter,
	runResearchPipeline,
} from "@research/application";
import {
	BUNDLE_LIMITS,
	type ClaimedJob,
	type CompleteJobRequest,
	type HeartbeatResponse,
	leasedJobStateSchema,
	MAX_RUNNER_EVENTS_PER_REQUEST,
	type RunnerEvent,
} from "@research/contracts";
import { EMPTY_USAGE, type ResourceUsage } from "@research/domain";
import type { EventLogger } from "@research/effects";
import type { RunnerApi, RunnerApiResult } from "./apiClient.ts";

/** Per-job scratch directories (AGT-004): created empty, removed when the job ends. */
export interface ScratchDirectories {
	create(runId: string): Promise<string>;
	remove(path: string): Promise<void>;
}

export interface JobExecutionDeps {
	readonly api: RunnerApi;
	readonly agents: AgentRegistry;
	readonly tools: ToolRegistry;
	readonly feed: FeedFetchDeps & { readonly hasher: Hasher };
	readonly clock: Clock;
	readonly logger: EventLogger;
	readonly scratch: ScratchDirectories;
	/** Starts a repeating timer and returns its stop function. */
	readonly every: (ms: number, task: () => void) => () => void;
	readonly newFenceToken: () => string;
	readonly allowUnverifiedToolIsolation: boolean;
}

/** Why work on a job stopped before it finished on its own. */
type StopReason = "cancelled" | "lease-lost" | "shutdown";

const LEASE_LOST_CODES = new Set(["STALE_LEASE", "NOT_FOUND", "UNAUTHENTICATED"]);
const REJECTED_SUBMISSION_CODES = new Set([
	"INTEGRITY_VIOLATION",
	"VALIDATION_FAILED",
	"ILLEGAL_TRANSITION",
	"PAYLOAD_TOO_LARGE",
]);
const NOTE_FLUSH_THRESHOLD = 10;
const MAX_QUEUED_EVENTS = 400;
const INGEST_STATES = ["planning", "collecting", "analyzing", "verifying", "publishing"] as const;

/**
 * Runs one claimed job to completion under its lease.
 *
 * Recovery model (AGT-011): the runner holds no durable state. If this process
 * dies at any point, nothing is completed; the lease expires and the Worker
 * hands the job to the next claim under a new generation. If the lease is lost
 * while work continues, the runner stops and submits nothing — and anything it
 * did submit would be rejected by generation fencing anyway.
 */
export async function executeJob(
	job: ClaimedJob,
	deps: JobExecutionDeps,
	shutdown: AbortSignal,
): Promise<void> {
	const { api, logger } = deps;
	const abort = new AbortController();
	let stopReason: StopReason | null = null;
	const stop = (reason: StopReason) => {
		stopReason ??= reason;
		abort.abort();
	};
	// Read through a function: the variable is reassigned from timer and network callbacks.
	const currentStopReason = (): StopReason | null => stopReason;
	const onShutdown = () => stop("shutdown");
	if (shutdown.aborted) onShutdown();
	shutdown.addEventListener("abort", onShutdown, { once: true });

	// Starts from what earlier attempts of this run consumed; ceilings apply to the run.
	let usage: ResourceUsage = job.kind === "research" ? job.priorUsage : EMPTY_USAGE;

	/* ----- Progress reporting: ordered, sequence-numbered, idempotent on the server ----- */
	let seq = 0;
	const queue: RunnerEvent[] = [];
	const enqueue = (event: RunnerEvent["event"]) => {
		if (queue.length >= MAX_QUEUED_EVENTS) return;
		queue.push({ seq, at: deps.clock.nowIso(), event });
		seq += 1;
	};
	const flush = async (): Promise<void> => {
		while (queue.length > 0 && currentStopReason() !== "lease-lost") {
			const batch = queue.slice(0, MAX_RUNNER_EVENTS_PER_REQUEST);
			const sent = await api.events(job.runId, {
				leaseGeneration: job.leaseGeneration,
				events: batch,
			});
			if (!sent.ok) {
				if (LEASE_LOST_CODES.has(sent.error.code)) stop("lease-lost");
				else logger.warn("events_not_delivered", { runId: job.runId, code: sent.error.code });
				// Keep the batch queued: sequence numbers make a later resend safe.
				return;
			}
			queue.splice(0, batch.length);
			if (sent.value.cancelRequested) stop("cancelled");
		}
	};
	const reporter: PipelineReporter = {
		async state(state) {
			enqueue({ type: "state", state: leasedState(state) });
			await flush();
		},
		async note(text) {
			enqueue({ type: "note", text: text.slice(0, 500) });
			if (queue.length >= NOTE_FLUSH_THRESHOLD) await flush();
		},
		async tool(toolId, outcome, detail) {
			enqueue({ type: "tool", toolId, outcome, detail: detail.slice(0, 300) });
			if (queue.length >= NOTE_FLUSH_THRESHOLD) await flush();
		},
		async usage(latest) {
			// Keep the latest figure outside the pipeline too: if the runner faults later, the
			// failure it reports must still carry what was already consumed (AGT-008).
			usage = latest;
			enqueue({ type: "usage", usage: latest });
		},
	};

	/* ----- Heartbeat: keeps the lease and carries cancellation back ----- */
	let heartbeatInFlight = false;
	// Records through the logger without ever throwing: this chain is detached
	// (`void`), so a rejection here would escape as an unhandled rejection that
	// the `attempt(...)` around `runRunnerLoop` cannot catch.
	const recordHeartbeatFailure = (code: string): void => {
		try {
			logger.warn("heartbeat_failed", { runId: job.runId, code });
		} catch {
			// The logger counts its own writer failures (`logFailures`); a
			// detached timer has nothing further to do with one.
		}
	};
	const stopHeartbeat = deps.every(job.heartbeatIntervalMs, () => {
		if (heartbeatInFlight || currentStopReason() !== null) return;
		heartbeatInFlight = true;
		let pending: Promise<RunnerApiResult<HeartbeatResponse>>;
		try {
			pending = api.heartbeat(job.runId, job.leaseGeneration);
		} catch {
			heartbeatInFlight = false;
			recordHeartbeatFailure("HEARTBEAT_REQUEST_FAILED");
			return;
		}
		void pending
			.then((beat) => {
				if (beat.ok) {
					if (beat.value.cancelRequested) stop("cancelled");
				} else if (LEASE_LOST_CODES.has(beat.error.code)) {
					stop("lease-lost");
				} else {
					recordHeartbeatFailure(beat.error.code);
				}
			})
			.catch(() => {
				recordHeartbeatFailure("HEARTBEAT_REQUEST_FAILED");
			})
			.finally(() => {
				heartbeatInFlight = false;
			});
	});

	let scratchDirectory: string | null = null;
	try {
		scratchDirectory = await deps.scratch.create(job.runId);
		let completion: CompleteJobRequest;
		if (job.kind === "news-ingest") {
			for (const state of INGEST_STATES.slice(0, 2)) await reporter.state(state);
			const ingested = await ingestSources(
				job.sources,
				{ ...deps.feed, clock: deps.clock },
				{
					signal: abort.signal,
					maxArticles: BUNDLE_LIMITS.articles,
				},
			);
			for (const state of INGEST_STATES.slice(2)) await reporter.state(state);
			completion = {
				outcome: "ingested",
				leaseGeneration: job.leaseGeneration,
				usage,
				articles: [...ingested.articles],
				sourceReports: [...ingested.sourceReports],
			};
		} else {
			const agent = deps.agents.get(job.request.agentId);
			const outcome: PipelineOutcome =
				agent === undefined
					? {
							kind: "failed",
							failureCode: "AGENT_NOT_REGISTERED",
							failureDetail: null,
							retryable: false,
							usage,
						}
					: await runResearchPipeline(
							{
								runId: job.runId,
								request: job.request,
								sources: job.sources,
								workspaceComponents: job.workspaceComponents,
								conversationContext: job.conversationContext,
								priorUsage: job.priorUsage,
								signal: abort.signal,
								allowUnverifiedToolIsolation: deps.allowUnverifiedToolIsolation,
							},
							{
								agent,
								tools: deps.tools,
								clock: deps.clock,
								reporter,
								newFenceToken: deps.newFenceToken,
								scratchDirectory,
							},
						);
			usage = outcome.usage;
			completion = toCompletion(job.leaseGeneration, outcome);
		}
		await flush();

		const reason = currentStopReason();
		if (reason === "lease-lost" || reason === "shutdown") {
			logger.info("job_abandoned", { runId: job.runId, reason });
			return;
		}
		if (reason === "cancelled") {
			completion = { outcome: "cancelled", leaseGeneration: job.leaseGeneration, usage };
		}
		const submitted = await api.complete(job.runId, completion);
		if (submitted.ok) {
			logger.info("job_finished", { runId: job.runId, state: submitted.value.state });
			return;
		}
		logger.warn("completion_rejected", { runId: job.runId, code: submitted.error.code });
		if (REJECTED_SUBMISSION_CODES.has(submitted.error.code)) {
			// The Worker refused the result itself; record that honestly rather than retrying it.
			await api.complete(job.runId, {
				outcome: "failed",
				leaseGeneration: job.leaseGeneration,
				usage,
				failureCode: `SUBMISSION_REJECTED_${submitted.error.code}`.slice(0, 80),
				retryable: false,
			});
		}
	} catch (error) {
		// Unexpected fault inside the runner. Report it so the job can be retried; never swallow it.
		const name = error instanceof Error ? error.name : "unknown";
		logger.error("job_crashed", { runId: job.runId, error: name });
		await api.complete(job.runId, {
			outcome: "failed",
			leaseGeneration: job.leaseGeneration,
			usage,
			failureCode: `RUNNER_ERROR_${name}`.slice(0, 80),
			retryable: true,
		});
	} finally {
		stopHeartbeat();
		shutdown.removeEventListener("abort", onShutdown);
		if (scratchDirectory !== null) {
			await deps.scratch.remove(scratchDirectory).catch((error: unknown) => {
				logger.warn("scratch_not_removed", {
					runId: job.runId,
					error: error instanceof Error ? error.name : "unknown",
				});
			});
		}
	}
}

type LeasedState = Extract<RunnerEvent["event"], { type: "state" }>["state"];

/** The pipeline only ever reports lifecycle stages; anything else is a programming error. */
function leasedState(state: string): LeasedState {
	const parsed = leasedJobStateSchema.safeParse(state);
	if (!parsed.success) throw new Error(`pipeline reported a non-lifecycle state: ${state}`);
	return parsed.data;
}

export function toCompletion(
	leaseGeneration: number,
	outcome: PipelineOutcome,
): CompleteJobRequest {
	const base = { leaseGeneration, usage: outcome.usage };
	switch (outcome.kind) {
		case "completed":
			return {
				...base,
				outcome: "completed",
				bundle: outcome.bundle,
				articles: [...outcome.articles],
				sourceReports: [],
			};
		case "partial":
			return {
				...base,
				outcome: "partial",
				failureCode: outcome.failureCode.slice(0, 80),
				bundle: outcome.bundle,
				articles: [...outcome.articles],
				sourceReports: [],
			};
		case "failed":
			return {
				...base,
				outcome: "failed",
				failureCode: outcome.failureCode.slice(0, 80),
				...(outcome.failureDetail === null
					? {}
					: { failureDetail: outcome.failureDetail.slice(0, 80) }),
				retryable: outcome.retryable,
			};
		case "cancelled":
			return { ...base, outcome: "cancelled" };
		case "waiting_approval":
			return { ...base, outcome: "waiting_approval", approvalRequest: outcome.approvalRequest };
	}
}
