import {
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncSource,
	isRetryableEquitySyncFailure,
} from "@research/adapters/finance";
import type { AgentRegistry, ToolRegistry } from "@research/agent-core";
import {
	type Clock,
	type EarningsSourceRegistry,
	type FeedFetchDeps,
	type Hasher,
	ingestSources,
	MAX_JOB_ATTEMPTS,
	type MarketRequestAdmission,
	type MarketSeriesSource,
	type MarketSourceRegistry,
	type PipelineOutcome,
	type PipelineReporter,
	PROMPT_VERSION,
	runNotebookAssistTurn,
	runResearchPipeline,
	type StockDirectoryData,
	type StockDirectoryFailure,
	type StockDirectorySourceRegistry,
} from "@research/application";
import {
	BUNDLE_LIMITS,
	type ClaimedJob,
	type CompleteJobRequest,
	completeJobRequestSchema,
	EARNINGS_LIMITS,
	type EarningsSourceId,
	type HeartbeatResponse,
	leasedJobStateSchema,
	MARKET_LIMITS,
	MAX_RUNNER_EVENTS_PER_REQUEST,
	type MarketProviderId,
	type MarketSeriesMeta,
	parseStockId,
	type RunnerEvent,
	STOCK_DIRECTORY_SOURCES,
	type WatchMarket,
} from "@research/contracts";
import {
	EARNINGS_SOURCE_BY_MARKET,
	EMPTY_USAGE,
	type EquityProvider,
	err,
	firstHistoryFetch,
	type HistoryFetch,
	type HistoryPoint,
	type HistoryRefreshRequest,
	historyOutcome,
	parseMarketSeriesId,
	type ResourceUsage,
	type Result,
	thrownName,
} from "@research/domain";
import { type EventLogger, type LogFields, logIsolated } from "@research/effects";
import type { RunnerApi, RunnerApiResult } from "./apiClient.ts";
import {
	discardStoredGoogleGrant,
	executeGoogleCalendar,
	type GoogleExecutionEnv,
	type GoogleRunnerDeps,
} from "./googleCalendar.ts";
import type { MarketRequestPacer } from "./marketPacing.ts";

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
	/** Earnings-date source registry (ARCH-006); JPX needs no key, Finnhub does. */
	readonly earningsSources: EarningsSourceRegistry;
	/**
	 * Stock-directory sources by market (ADR-0034): SEC for US (unconfigured
	 * without `SEC_USER_AGENT`), JPX for JP.
	 */
	readonly stockDirectorySources: StockDirectorySourceRegistry;
	/**
	 * Financial statement sources by provider (ADR-0045): SEC (US) and EDINET
	 * (JP). An unconfigured source fails its jobs with
	 * FINANCIAL_SOURCE_NOT_CONFIGURED itself; an absent one is treated the same.
	 */
	readonly equitySyncSources: ReadonlyMap<EquityProvider, EquitySyncSource>;
	/** Per-provider request pacing (API-007), shared across jobs. */
	readonly marketPacer: MarketRequestPacer;
	/** Google Calendar sync (FR-019): OAuth credentials, token file, narrow HTTP, sleep. */
	readonly google: GoogleRunnerDeps;
	/**
	 * Test seam for `google-calendar` jobs (the E2E harness scripts the
	 * OAuth dance: no browser, no Google). Absent in production, where the
	 * real `executeGoogleCalendar` below always runs.
	 */
	readonly executeGoogleCalendar?: (
		job: Extract<ClaimedJob, { kind: "google-calendar" }>,
		env: GoogleExecutionEnv,
		signal: AbortSignal,
		reporter: PipelineReporter,
		sendAuthUrl: (url: string) => Promise<boolean>,
	) => Promise<CompleteJobRequest>;
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
 * `promptVersion` is the short template version (e.g. `research-v5`), never
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
 * did submit would be rejected by generation fencing anyway. An orderly
 * shutdown hands the lease back instead (ADR-0036), so the job is claimable at
 * once and the interrupted attempt is not counted.
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
			// The Worker refuses an empty note (`text` is min(1)) and a refused batch
			// stays queued, so one empty note would block every later event.
			const cut = text.slice(0, 500);
			if (cut === "") return;
			progress.note += 1;
			enqueue({ type: "note", text: cut });
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
		logIsolated(() => logger.warn("heartbeat_failed", { runId: job.runId, code }));
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
		// Captured before the dispatch narrows `job`: the final else is
		// unreachable today (every known kind has a branch) but must still
		// build a completion if a new kind arrives.
		const generation = job.leaseGeneration;
		if (job.kind === "market-refresh") {
			completion = await executeMarketRefresh(job, deps, abort.signal, reporter);
		} else if (job.kind === "earnings-refresh") {
			completion = await executeEarningsRefresh(job, deps, abort.signal, reporter);
		} else if (job.kind === "stock-directory-refresh") {
			completion = await executeStockDirectoryRefresh(job, deps, abort.signal, reporter);
		} else if (job.kind === "financial-sync") {
			completion = await executeEquitySync(job, deps, abort.signal, reporter);
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
		} else if (job.kind === "research") {
			const agent = deps.agents.get(job.request.agentId);
			const outcome: PipelineOutcome =
				agent === undefined
					? {
							kind: "failed",
							failureCode: "AGENT_NOT_REGISTERED",
							failureDetail: null,
							failureUpstreamStatus: null,
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
		} else if (job.kind === "notebook-assist") {
			const agent = deps.agents.get(job.agent.agentId);
			if (agent === undefined) {
				completion = {
					outcome: "failed",
					leaseGeneration: job.leaseGeneration,
					usage,
					failureCode: "AGENT_NOT_REGISTERED",
					retryable: false,
				};
			} else {
				const assist = await runNotebookAssistTurn(
					{
						...job,
						signal: abort.signal,
						allowUnverifiedToolIsolation: deps.allowUnverifiedToolIsolation,
					},
					{
						agent,
						clock: deps.clock,
						reporter,
						newFenceToken: deps.newFenceToken,
						scratchDirectory,
					},
				);
				usage = assist.usage;
				if (assist.kind === "assisted") {
					completion = {
						outcome: "notebook-assisted",
						leaseGeneration: job.leaseGeneration,
						usage,
						baseVersion: assist.baseVersion,
						reply: assist.reply,
						commands: [...assist.commands],
						proposedRemovals: [...assist.proposedRemovals],
					};
				} else if (assist.kind === "failed") {
					completion = {
						outcome: "failed",
						leaseGeneration: job.leaseGeneration,
						usage,
						failureCode: assist.failureCode.slice(0, 80),
						...upstreamField(assist.failureUpstreamStatus),
						retryable: assist.retryable,
					};
				} else {
					completion = { outcome: "cancelled", leaseGeneration: job.leaseGeneration, usage };
				}
			}
		} else if (job.kind === "google-calendar") {
			// Queued once; a repeat call only re-sends what is undelivered.
			// Delivered means the whole queue went out (events are ordered).
			let authUrlQueued = false;
			const sendAuthUrl = async (url: string): Promise<boolean> => {
				if (!authUrlQueued) {
					enqueue({ type: "google-auth-url", url });
					authUrlQueued = true;
				}
				await flush();
				return queue.length === 0;
			};
			completion = await (deps.executeGoogleCalendar ?? executeGoogleCalendar)(
				job,
				deps,
				abort.signal,
				reporter,
				sendAuthUrl,
			);
		} else {
			// Unknown job kind: fail closed instead of running it.
			completion = {
				outcome: "failed",
				leaseGeneration: generation,
				usage,
				failureCode: "UNKNOWN_JOB_KIND",
				retryable: false,
			};
		}
		await flush();

		// FR-019: a connect that stored its grant must end `completed`, or
		// the stored refresh token is given back — the API will report "not
		// connected", and the app could never disconnect a grant it denies.
		const storedGrant = completion.outcome === "google-calendar-connected";
		const reason = currentStopReason();
		if (reason === "lease-lost" || reason === "shutdown") {
			if (storedGrant) await discardStoredGoogleGrant(deps, job.runId);
			// ADR-0036: a runner that is shutting down hands its lease back, so
			// the next runner claims the job within one poll and the interrupted
			// attempt is refunded. A lost lease is not ours to hand back.
			if (reason === "shutdown") await releaseLease(job, usage, deps);
			logger.info("job_abandoned", { runId: job.runId, reason });
			return;
		}
		if (reason === "cancelled") {
			completion = { outcome: "cancelled", leaseGeneration: job.leaseGeneration, usage };
		}
		const submitted = await api.complete(job.runId, completion);
		const kept = reason !== "cancelled" && submitted.ok && submitted.value.state === "completed";
		if (storedGrant && !kept) await discardStoredGoogleGrant(deps, job.runId);
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
		const name = thrownName(error);
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
					error: thrownName(error),
				});
			});
		}
	}
}

/**
 * Hands the lease back on shutdown (ADR-0036), with the usage so far: the
 * event queue is not flushed once shutdown starts, so this is the attempt's
 * last chance to record what it spent (AGT-008). Never throws: a refused or
 * unanswered release only leaves the lease to run out, as before.
 */
async function releaseLease(
	job: ClaimedJob,
	usage: ResourceUsage,
	deps: JobExecutionDeps,
): Promise<void> {
	const released = await deps.api
		.release(job.runId, { leaseGeneration: job.leaseGeneration, usage })
		.catch((error: unknown) =>
			err({ code: "RELEASE_REQUEST_FAILED", detail: thrownName(error), transient: false }),
		);
	if (released.ok) {
		deps.logger.info("job_released", { runId: job.runId, state: released.value.state });
	} else {
		deps.logger.warn("release_failed", { runId: job.runId, code: released.error.code });
	}
}

type LeasedState = Extract<RunnerEvent["event"], { type: "state" }>["state"];
/** The pipeline only ever reports lifecycle stages; anything else is a programming error. */
function leasedState(state: string): LeasedState {
	const parsed = leasedJobStateSchema.safeParse(state);
	if (!parsed.success) throw new Error(`pipeline reported a non-lifecycle state: ${state}`);
	return parsed.data;
}

type MarketRefreshEntry = Extract<
	CompleteJobRequest,
	{ outcome: "market-refreshed" }
>["series"][number];

/** One paced provider request for a series: its answer, its failure entry, or a stop. */
type SeriesAnswer =
	| { readonly kind: "stopped" }
	| { readonly kind: "failed"; readonly entry: MarketRefreshEntry }
	| {
			readonly kind: "answered";
			readonly meta: MarketSeriesMeta;
			/** Ascending, date-unique (the adapters guarantee it), at most one response's worth. */
			readonly points: readonly HistoryPoint[];
	  };

/**
 * Asks the provider for the series `seriesId`. The adapter admits each HTTP
 * request it actually sends through the provider's pacing gate (API-007): an
 * abort while waiting stops the refresh without fetching, and a spent daily
 * budget fails the series as `RATE_LIMITED` without sending. The answer is
 * cut to the newest `maxObservationsPerResponse` here, before the history
 * decision, so a write's `replaceFrom` is always one of the dates the
 * completion carries.
 */
async function fetchSeriesAnswer(
	source: MarketSeriesSource,
	seriesId: string,
	target: { readonly provider: MarketProviderId; readonly symbol: string },
	fetch: HistoryFetch,
	fetchedAt: string,
	deps: JobExecutionDeps,
	signal: AbortSignal,
): Promise<SeriesAnswer> {
	let stopped = false;
	const beforeRequest = async (): Promise<MarketRequestAdmission> => {
		const admission = await deps.marketPacer.admit(target.provider, signal);
		// A grant that arrives with the abort still stops the refresh.
		if (admission === "stopped" || signal.aborted) {
			stopped = true;
			return "stopped";
		}
		return admission;
	};
	let result: Awaited<ReturnType<MarketSeriesSource["fetchSeries"]>>;
	try {
		result = await source.fetchSeries({
			symbol: target.symbol,
			from: fetch.kind === "window" ? fetch.from : null,
			maxObservations: MARKET_LIMITS.maxObservationsPerResponse,
			signal,
			beforeRequest,
		});
	} catch (error) {
		if (stopped) return { kind: "stopped" };
		// An adapter throws only for the unexpected: log its class name
		// (never its message or URL, SEC-010) and report the series as
		// failed without aborting the others.
		deps.logger.warn("market_series_failed", {
			seriesId,
			error: thrownName(error),
		});
		return {
			kind: "failed",
			entry: {
				seriesId,
				fetchedAt,
				meta: null,
				observations: [],
				errorCode: "SOURCE_FAILED",
			},
		};
	}
	// A stopped admission sent nothing (or not the rest): nothing is reported for the series.
	if (stopped) return { kind: "stopped" };
	if (!result.ok) {
		return {
			kind: "failed",
			entry: {
				seriesId,
				fetchedAt,
				meta: null,
				observations: [],
				errorCode: result.error.code,
				// The provider's own status, unchanged (§4a).
				upstreamStatus: result.error.upstreamStatus,
			},
		};
	}
	const all = result.value.observations;
	const points =
		all.length > MARKET_LIMITS.maxObservationsPerResponse
			? all.slice(-MARKET_LIMITS.maxObservationsPerResponse)
			: all;
	return { kind: "answered", meta: result.value.meta, points };
}

/**
 * Runs a claimed market-refresh job: fetches every series sequentially,
 * pacing each provider through the shared gate, honouring cancellation. One
 * failing series never aborts the others; a series whose provider has no
 * keyed adapter honestly reports SOURCE_NOT_CONFIGURED.
 *
 * Each series is refreshed incrementally (ADR-0044): the first request asks
 * from the claim's anchor (or for everything when there is none or a full
 * check is due); when the window does not reproduce the anchor, the provider
 * changed older history and a second, paced request fetches everything in
 * the same job. The completion carries how the answer replaces the stored
 * history (`history`), decided by the domain rule.
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
	const series: MarketRefreshEntry[] = [];
	// The API claims each series once; a repeated id is skipped (first wins)
	// because the completion contract refuses two entries for one series —
	// two history writes would not store what merging them one by one does.
	const claimed = new Set<string>();
	for (const query of job.series) {
		if (signal.aborted) break;
		if (claimed.has(query.seriesId)) continue;
		claimed.add(query.seriesId);
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
		const request: HistoryRefreshRequest = { anchor: query.anchor, fullCheck: query.fullCheck };
		const first = firstHistoryFetch(request);
		let answer = await fetchSeriesAnswer(
			source,
			query.seriesId,
			parsed.value,
			first,
			fetchedAt,
			deps,
			signal,
		);
		if (answer.kind === "stopped") break;
		if (answer.kind === "failed") {
			series.push(answer.entry);
			continue;
		}
		let outcome = historyOutcome(request, first, answer.points);
		if (outcome.kind === "refetch-full") {
			const full: HistoryFetch = { kind: "full" };
			answer = await fetchSeriesAnswer(
				source,
				query.seriesId,
				parsed.value,
				full,
				fetchedAt,
				deps,
				signal,
			);
			if (answer.kind === "stopped") break;
			if (answer.kind === "failed") {
				series.push(answer.entry);
				continue;
			}
			outcome = historyOutcome(request, full, answer.points);
		}
		// After a full fetch the outcome is always `store` (Lean
		// `HistoryRefresh.full_fetch_stores`); a null write (an empty
		// answer) merges without replacing anything.
		const write = outcome.kind === "store" ? outcome.write : null;
		series.push({
			seriesId: query.seriesId,
			fetchedAt,
			meta: { ...answer.meta },
			observations: answer.points.map((point): [string, number] => [point.observedOn, point.value]),
			errorCode: null,
			...(write === null ? {} : { history: write }),
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

/**
 * Runs a claimed earnings-refresh job: fetches every watchlist stock's
 * announcement dates, grouping stocks by source so JPX is one batch (one
 * index page plus its workbook set per refresh). One failing stock never
 * aborts the others; a stock whose source has no keyed adapter honestly
 * reports SOURCE_NOT_CONFIGURED.
 *
 * Progress walks the same leased states as a market-refresh job (the
 * completion must come from `publishing`, like every other completion).
 */
async function executeEarningsRefresh(
	job: Extract<ClaimedJob, { kind: "earnings-refresh" }>,
	deps: JobExecutionDeps,
	signal: AbortSignal,
	reporter: PipelineReporter,
): Promise<CompleteJobRequest> {
	await reporter.state("planning");
	await reporter.state("collecting");
	type CompletionStock = Extract<
		CompleteJobRequest,
		{ outcome: "earnings-refreshed" }
	>["stocks"][number];
	const byId = new Map<string, CompletionStock>();
	const bySource = new Map<EarningsSourceId, { symbol: string; needName: boolean }[]>();
	const order: { stockId: string; symbol: string; needName: boolean }[] = [];
	for (const entry of job.stocks) {
		const fetchedAt = deps.clock.nowIso();
		const parsed = parseStockId(entry.stockId);
		if (parsed === null) {
			// Fail closed: a claimed id that no longer parses is a storage
			// fault, reported as a failed stock, never skipped silently.
			byId.set(entry.stockId, {
				stockId: entry.stockId,
				fetchedAt,
				name: null,
				events: [],
				errorCode: "SOURCE_FAILED",
			});
			continue;
		}
		const sourceId = EARNINGS_SOURCE_BY_MARKET[parsed.market];
		const group = bySource.get(sourceId) ?? [];
		group.push({ symbol: parsed.symbol, needName: entry.name === null });
		bySource.set(sourceId, group);
		order.push({ stockId: entry.stockId, symbol: parsed.symbol, needName: entry.name === null });
	}
	for (const [sourceId, group] of bySource) {
		if (signal.aborted) break;
		const fetchedAt = deps.clock.nowIso();
		const source = deps.earningsSources.get(sourceId);
		if (source === undefined) {
			// No keyed adapter for this source: every stock honestly reports it.
			for (const item of order.filter((entry) =>
				group.some((member) => member.symbol === entry.symbol),
			)) {
				byId.set(item.stockId, {
					stockId: item.stockId,
					fetchedAt,
					name: null,
					events: [],
					errorCode: "SOURCE_NOT_CONFIGURED",
				});
			}
			continue;
		}
		// One grant per HTTP request, taken by the adapter immediately
		// before it sends (API-007): the runner only builds the hook from
		// the shared window — Finnhub 30 starts per 60 s, JPX 6 per 60 s.
		// A false hook (an abort while waiting) ends the refresh without
		// fetching anything further.
		const beforeRequest = (): Promise<boolean> => deps.marketPacer.pace(sourceId, signal);
		let results: Awaited<ReturnType<typeof source.fetchEarnings>>;
		try {
			results = await source.fetchEarnings({
				stocks: group,
				fromDate: job.fromDate,
				toDate: job.toDate,
				signal,
				beforeRequest,
			});
		} catch (error) {
			// An adapter throws only for the unexpected: log its class name
			// (never its message or URL, SEC-010) and report every stock of
			// this source as failed without aborting the other source.
			deps.logger.warn("earnings_source_failed", {
				source: sourceId,
				error: thrownName(error),
			});
			for (const item of order.filter((entry) =>
				group.some((member) => member.symbol === entry.symbol),
			)) {
				byId.set(item.stockId, {
					stockId: item.stockId,
					fetchedAt,
					name: null,
					events: [],
					errorCode: "SOURCE_FAILED",
				});
			}
			continue;
		}
		if (results.length !== group.length) {
			// The port promises one result per symbol in order; a short batch
			// is a contract breach, failed closed for the whole source.
			deps.logger.warn("earnings_source_failed", { source: sourceId, error: "RangeError" });
			for (const item of order.filter((entry) =>
				group.some((member) => member.symbol === entry.symbol),
			)) {
				byId.set(item.stockId, {
					stockId: item.stockId,
					fetchedAt,
					name: null,
					events: [],
					errorCode: "SOURCE_FAILED",
				});
			}
			continue;
		}
		group.forEach((query, index) => {
			const item = order.find((entry) => entry.symbol === query.symbol && !byId.has(entry.stockId));
			if (item === undefined) return;
			const result = results[index];
			if (result === undefined || !result.ok) {
				byId.set(item.stockId, {
					stockId: item.stockId,
					fetchedAt,
					// NO_SCHEDULED_DATE is a listed-nothing success: its name
					// still flows into the completion (the profile is not
					// asked again); every other error carries no name.
					name:
						result !== undefined && !result.ok && result.error.code === "NO_SCHEDULED_DATE"
							? result.error.name
							: null,
					events: [],
					errorCode: result === undefined ? "SOURCE_FAILED" : result.error.code,
					// The provider's own status, unchanged (§4a); a listed-nothing success has none.
					upstreamStatus:
						result === undefined || result.error.code === "NO_SCHEDULED_DATE"
							? null
							: result.error.upstreamStatus,
				});
				return;
			}
			byId.set(item.stockId, {
				stockId: item.stockId,
				fetchedAt,
				name: result.value.name,
				events: result.value.events
					.slice(0, EARNINGS_LIMITS.maxEventsPerStock)
					.map((event) => ({ ...event })),
				errorCode: null,
			});
		});
	}
	await reporter.state("analyzing");
	await reporter.state("verifying");
	await reporter.state("publishing");
	// Claim order is preserved for every stock.
	const stocks: CompletionStock[] = [...byId.values()].sort(
		(a, b) =>
			job.stocks.findIndex((entry) => entry.stockId === a.stockId) -
			job.stocks.findIndex((entry) => entry.stockId === b.stockId),
	);
	return {
		outcome: "earnings-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		stocks,
	};
}

/**
 * Runs a claimed stock-directory-refresh job (ADR-0034): downloads the
 * leased market's full list through its source and completes with
 * `stock-directory-refreshed`, or `failed` with a
 * `STOCK_DIRECTORY_FAILURE_CODES` code (never provider text). The source's
 * requests pace through the shared window of its host (`sec`, `jpx`), so a
 * directory refresh and an earnings refresh never exceed JPX's budget
 * together.
 *
 * The completion is checked against its contract before it is sent (row
 * floor and ceiling, symbol shapes, listings, names, distinct symbols): a
 * list the API would refuse fails here as `DIRECTORY_PARSE_FAILED` instead,
 * so a stored list is never replaced by a broken one.
 *
 * Only `DIRECTORY_SOURCE_FAILED` (a network or server failure) is retried
 * by the API; a rate limit is not retried at once (it would spend the next
 * request of the same window), and the other codes need the owner.
 */
async function executeStockDirectoryRefresh(
	job: Extract<ClaimedJob, { kind: "stock-directory-refresh" }>,
	deps: JobExecutionDeps,
	signal: AbortSignal,
	reporter: PipelineReporter,
): Promise<CompleteJobRequest> {
	await reporter.state("planning");
	await reporter.state("collecting");
	const fetchedAt = deps.clock.nowIso();
	const result = await fetchStockDirectory(job.market, deps, signal);
	await reporter.state("analyzing");
	await reporter.state("verifying");
	await reporter.state("publishing");
	const failed = (failure: StockDirectoryFailure): CompleteJobRequest => ({
		outcome: "failed",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		failureCode: failure.code,
		// SEC's or JPX's own status, unchanged (§4a).
		...upstreamField(failure.upstreamStatus),
		retryable: failure.code === "DIRECTORY_SOURCE_FAILED",
	});
	if (!result.ok) return failed(result.error);
	const completion: CompleteJobRequest = {
		outcome: "stock-directory-refreshed",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		market: job.market,
		asOf: result.value.asOf,
		fetchedAt,
		entries: result.value.entries.map((entry) => ({ ...entry })),
	};
	if (!completeJobRequestSchema.safeParse(completion).success) {
		deps.logger.warn("stock_directory_rejected", { runId: job.runId, market: job.market });
		return failed({ code: "DIRECTORY_PARSE_FAILED", upstreamStatus: null });
	}
	deps.logger.info("stock_directory_fetched", {
		runId: job.runId,
		market: job.market,
		entries: completion.entries.length,
	});
	return completion;
}

/** The market's source answer; an absent source is unconfigured, a throw a source failure. */
async function fetchStockDirectory(
	market: WatchMarket,
	deps: JobExecutionDeps,
	signal: AbortSignal,
): Promise<Result<StockDirectoryData, StockDirectoryFailure>> {
	const source = deps.stockDirectorySources.get(market);
	if (source === undefined) return err({ code: "DIRECTORY_NOT_CONFIGURED", upstreamStatus: null });
	const pacerKey = STOCK_DIRECTORY_SOURCES[market].sourceId;
	try {
		return await source.fetchDirectory({
			signal,
			beforeRequest: () => deps.marketPacer.pace(pacerKey, signal),
		});
	} catch (error) {
		// An adapter throws only for the unexpected: log its class name
		// (never its message or URL, SEC-010) and fail with a stable code.
		deps.logger.warn("stock_directory_source_failed", { market, error: thrownName(error) });
		return err({ code: "DIRECTORY_SOURCE_FAILED", upstreamStatus: null });
	}
}

/**
 * Runs a claimed `financial-sync` job (ADR-0045 §6): the provider's source
 * fetches and extracts (SEC paced under `sec`, EDINET under `edinet`, one
 * grant per request), and the job completes with `financial-synced` or
 * `failed` with an `EQUITY_SYNC_FAILURE_CODES` code and the provider's
 * status unchanged (ADR-0037). Rate limits and source failures are
 * retryable; the rest need the owner.
 *
 * The completion is checked against its contract before it is sent: one the
 * API would refuse fails here as FINANCIAL_PARSE_FAILED instead. Logs carry
 * ids, codes and counts only — never a URL (the EDINET key is in its URLs).
 */
async function executeEquitySync(
	job: Extract<ClaimedJob, { kind: "financial-sync" }>,
	deps: JobExecutionDeps,
	signal: AbortSignal,
	reporter: PipelineReporter,
): Promise<CompleteJobRequest> {
	await reporter.state("planning");
	await reporter.state("collecting");
	const provider = job.source.provider;
	const fetchedAt = deps.clock.nowIso();
	const result = await runEquitySyncSource(job, deps, signal);
	await reporter.state("analyzing");
	await reporter.state("verifying");
	await reporter.state("publishing");
	const failed = (failure: EquitySyncFailure): CompleteJobRequest => {
		deps.logger.warn("financial_sync_failed", {
			companyId: job.companyId,
			provider,
			code: failure.code,
			upstreamStatus: failure.upstreamStatus,
		});
		return {
			outcome: "failed",
			leaseGeneration: job.leaseGeneration,
			usage: EMPTY_USAGE,
			failureCode: failure.code,
			...upstreamField(failure.upstreamStatus),
			retryable: isRetryableEquitySyncFailure(failure.code),
		};
	};
	if (!result.ok) return failed(result.error);
	const data = result.value;
	const completion: CompleteJobRequest = {
		outcome: "financial-synced",
		leaseGeneration: job.leaseGeneration,
		usage: EMPTY_USAGE,
		companyId: job.companyId,
		provider,
		fetchedAt,
		identity: data.identity === null ? null : { ...data.identity },
		scannedDays: [...data.scannedDays],
		filings: data.filings.map((filing) => ({ ...filing, facts: [...filing.facts] })),
		more: data.more,
	};
	if (!completeJobRequestSchema.safeParse(completion).success) {
		return failed({
			code: "FINANCIAL_PARSE_FAILED",
			upstreamStatus: null,
			requests: data.requests,
		});
	}
	deps.logger.info("financial_sync_completed", {
		companyId: job.companyId,
		provider,
		filings: data.filings.length,
		facts: data.filings.reduce((total, filing) => total + filing.facts.length, 0),
		scannedDays: data.scannedDays.length,
		more: data.more,
		requests: data.requests,
	});
	return completion;
}

/** The provider's source answer; an absent source is unconfigured, a throw a source failure. */
async function runEquitySyncSource(
	job: Extract<ClaimedJob, { kind: "financial-sync" }>,
	deps: JobExecutionDeps,
	signal: AbortSignal,
): Promise<Result<EquitySyncData, EquitySyncFailure>> {
	const provider = job.source.provider;
	const source = deps.equitySyncSources.get(provider);
	if (source === undefined) {
		return err({ code: "FINANCIAL_SOURCE_NOT_CONFIGURED", upstreamStatus: null, requests: 0 });
	}
	try {
		return await source.sync({
			target: job,
			signal,
			beforeRequest: () => deps.marketPacer.pace(provider, signal, 1),
		});
	} catch (error) {
		// A source throws only for the unexpected: its class name only (SEC-010).
		deps.logger.warn("financial_sync_source_failed", { provider, error: thrownName(error) });
		return err({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests: 0 });
	}
}

/** The completion's `failureUpstreamStatus` field: the external service's status, unchanged (§4a). */
function upstreamField(status: number | null): { readonly failureUpstreamStatus?: number } {
	return status === null ? {} : { failureUpstreamStatus: status };
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
				...upstreamField(outcome.failureUpstreamStatus),
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
				...upstreamField(outcome.failureUpstreamStatus),
				retryable: outcome.retryable,
			};
		case "cancelled":
			return { ...base, outcome: "cancelled" };
		case "waiting_approval":
			return { ...base, outcome: "waiting_approval", approvalRequest: outcome.approvalRequest };
	}
}
