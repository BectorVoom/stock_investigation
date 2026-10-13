import type { AgentRegistry, ToolRegistry } from "@research/agent-core";
import {
	type Clock,
	type FeedFetchDeps,
	type Hasher,
	ingestSources,
	MAX_JOB_ATTEMPTS,
	type MarketSourceRegistry,
	type PipelineOutcome,
	type PipelineReporter,
	PROMPT_VERSION,
	runResearchPipeline,
} from "@research/application";
import {
	BUNDLE_LIMITS,
	type ClaimedJob,
	type CompleteJobRequest,
	type HeartbeatResponse,
	leasedJobStateSchema,
	MARKET_LIMITS,
	MAX_RUNNER_EVENTS_PER_REQUEST,
	type RunnerEvent,
} from "@research/contracts";
import { EMPTY_USAGE, parseMarketSeriesId, type ResourceUsage } from "@research/domain";
import type { EventLogger, LogFields } from "@research/effects";
import type { RunnerApi, RunnerApiResult } from "./apiClient.ts";
import type { MarketPacer } from "./marketPacing.ts";

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
	/** Provider registry (ARCH-006); an entry is absent until its key is configured. */
	readonly marketSources: MarketSourceRegistry;
	/** Per-provider request pacing (API-007), shared across jobs. */
	readonly marketPacer: MarketPacer;
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

/** Counts of progress entries reported for one job, by kind. */
export interface ProgressCounts {
	state: number;
	note: number;
	tool: number;
}

/**
 * What the compact run card no longer shows — identifiers, codes and counts
 * only, never prompts, question text, progress text or error messages
 * (SEC-010) — logged once per terminal submission on `job_finished`, so the
 * facts stay observable in `runner.log`. Budget ceilings apply to research
 * jobs only; news-ingest jobs carry no budget and omit those fields.
 * `promptVersion` is the short template version (e.g. `research-v4`), never
 * prompt text; `null` when the job publishes no research result.
 */
export function runFinishedFields(
	job: ClaimedJob,
	completion: CompleteJobRequest,
	state: string,
	progress: ProgressCounts,
): LogFields {
	const bundle =
		completion.outcome === "completed" || completion.outcome === "partial"
			? completion.bundle
			: null;
	const fields: Record<string, string | number | boolean | null> = {
		runId: job.runId,
		state,
		attempt: job.attempt,
		maxAttempts: MAX_JOB_ATTEMPTS,
		agentId: job.kind === "research" ? job.request.agentId : null,
		providerModel: bundle?.provenance.providerModel ?? null,
		promptVersion:
			job.kind === "research" ? (bundle?.provenance.promptVersion ?? PROMPT_VERSION) : null,
		agentSteps: completion.usage.agentSteps,
		toolCalls: completion.usage.toolCalls,
		inputBytes: completion.usage.inputBytes,
		knownCostUsd: completion.usage.knownCostUsd,
		hasUnmeteredUsage: completion.usage.hasUnmeteredUsage,
		// An unknown cost is never reported as zero (AGT-008): `costKnown`
		// says whether the total is known, `costUsd` is the known portion.
		costKnown: !completion.usage.hasUnmeteredUsage,
		costUsd: completion.usage.knownCostUsd,
		failureCode:
			completion.outcome === "failed" || completion.outcome === "partial"
				? completion.failureCode
				: null,
		verificationStatus: bundle?.verificationStatus ?? null,
		progressCount: progress.state + progress.note + progress.tool,
		progressStateCount: progress.state,
		progressNoteCount: progress.note,
		progressToolCount: progress.tool,
	};
	if (job.kind === "research") {
		fields.maxAgentSteps = job.request.budget.maxAgentSteps;
		fields.maxToolCalls = job.request.budget.maxToolCalls;
		fields.maxWallClockMs = job.request.budget.maxWallClockMs;
		fields.maxInputBytes = job.request.budget.maxInputBytes;
		fields.maxSpendUsd = job.request.budget.maxSpendUsd;
	}
	return fields;
}

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
	const progress: ProgressCounts = { state: 0, note: 0, tool: 0 };
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
			progress.state += 1;
			enqueue({ type: "state", state: leasedState(state) });
			await flush();
		},
		async note(text) {
			progress.note += 1;
			enqueue({ type: "note", text: text.slice(0, 500) });
			if (queue.length >= NOTE_FLUSH_THRESHOLD) await flush();
		},
		async tool(toolId, outcome, detail) {
			progress.tool += 1;
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
		if (job.kind === "market-refresh") {
			completion = await executeMarketRefresh(job, deps, abort.signal, reporter);
		} else if (job.kind === "news-ingest") {
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
			logger.info(
				"job_finished",
				runFinishedFields(job, completion, submitted.value.state, progress),
			);
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
		const completion: CompleteJobRequest = {
			outcome: "failed",
			leaseGeneration: job.leaseGeneration,
			usage,
			failureCode: `RUNNER_ERROR_${name}`.slice(0, 80),
			retryable: true,
		};
		const submitted = await api.complete(job.runId, completion);
		if (submitted.ok) {
			logger.info(
				"job_finished",
				runFinishedFields(job, completion, submitted.value.state, progress),
			);
		} else {
			logger.warn("completion_rejected", { runId: job.runId, code: submitted.error.code });
		}
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

/**
 * Runs a claimed market-refresh job: fetches every series sequentially,
 * pacing each provider through the shared gate, honouring cancellation. One
 * failing series never aborts the others; a series whose provider has no
 * keyed adapter honestly reports SOURCE_NOT_CONFIGURED.
 *
 * Progress walks the same leased states as a news-ingest job (the completion
 * must come from `publishing`, like every other completion).
 */
async function executeMarketRefresh(
	job: Extract<ClaimedJob, { kind: "market-refresh" }>,
	deps: JobExecutionDeps,
	signal: AbortSignal,
	reporter: PipelineReporter,
): Promise<CompleteJobRequest> {
	await reporter.state("planning");
	await reporter.state("collecting");
	const series: Extract<CompleteJobRequest, { outcome: "market-refreshed" }>["series"] = [];
	for (const query of job.series) {
		if (signal.aborted) break;
		const fetchedAt = deps.clock.nowIso();
		const parsed = parseMarketSeriesId(query.seriesId);
		if (!parsed.ok) {
			series.push({
				seriesId: query.seriesId,
				fetchedAt,
				meta: null,
				observations: [],
				errorCode: "SERIES_NOT_FOUND",
			});
			continue;
		}
		const source = deps.marketSources.get(parsed.value.provider);
		if (source === undefined) {
			series.push({
				seriesId: query.seriesId,
				fetchedAt,
				meta: null,
				observations: [],
				errorCode: "SOURCE_NOT_CONFIGURED",
			});
			continue;
		}
		// The provider's window must admit this request before it is sent
		// (API-007); an abort while waiting ends the refresh without fetching.
		const paced = await deps.marketPacer.pace(parsed.value.provider, signal);
		if (!paced || signal.aborted) break;
		let result: Awaited<ReturnType<typeof source.fetchSeries>>;
		try {
			result = await source.fetchSeries({
				symbol: parsed.value.symbol,
				since: query.latestObservedOn,
				maxObservations: MARKET_LIMITS.maxObservationsPerResponse,
				signal,
			});
		} catch (error) {
			// An adapter throws only for the unexpected: log its class name
			// (never its message or URL, SEC-010) and report the series as
			// failed without aborting the others.
			deps.logger.warn("market_series_failed", {
				seriesId: query.seriesId,
				error: error instanceof Error ? error.name : "unknown",
			});
			series.push({
				seriesId: query.seriesId,
				fetchedAt,
				meta: null,
				observations: [],
				errorCode: "SOURCE_FAILED",
			});
			continue;
		}
		if (!result.ok) {
			series.push({
				seriesId: query.seriesId,
				fetchedAt,
				meta: null,
				observations: [],
				errorCode: result.error.code,
			});
			continue;
		}
		series.push({
			seriesId: query.seriesId,
			fetchedAt,
			meta: { ...result.value.meta },
			observations: result.value.observations
				.slice(-MARKET_LIMITS.maxObservationsPerResponse)
				.map((point): [string, number] => [point.observedOn, point.value]),
			errorCode: null,
		});
	}
	await reporter.state("analyzing");
	await reporter.state("verifying");
	await reporter.state("publishing");
	return {
		outcome: "market-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		series,
	};
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
