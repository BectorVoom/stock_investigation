import {
	type AgentSettings,
	BASELINE_AGENT_IDS,
	CLAUDE_API_AGENT_ID,
	type CostModel,
	OPENROUTER_FREE_AGENT_ID,
	type ResearchRequest,
	type ResearchRun,
	type RunRecords,
	runBudget,
	type TaskSpendConsent,
} from "@research/contracts";
import {
	EMPTY_USAGE,
	isLeasedJobState,
	isoToEpochMs,
	isTerminalJobState,
	type JobState,
	ok,
	type ResearchBudget,
} from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import { applyGoogleTerminalOutcome } from "./googleCalendarLink.ts";
import type {
	AuditLog,
	Clock,
	EnqueueResult,
	GoogleCalendarRepository,
	Hasher,
	IdGenerator,
	JobRecord,
	JobRepository,
	JobWrite,
	RateLimiter,
	ResearchRecordRepository,
	ResearchUnitOfWork,
	RunnerStatusRepository,
	SettingsRepository,
	WorkspaceRepository,
} from "./ports.ts";
import { toRunView } from "./runView.ts";

export const MAX_JOB_ATTEMPTS = 3;
const MAX_UNFINISHED_JOBS = 5;
const JOBS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
/**
 * Admission control every job-creating use case shares: one hourly
 * allowance per owner (`job-create` bucket) and one cap on unfinished jobs.
 */
export const JOB_ADMISSION = {
	maxUnfinishedJobs: MAX_UNFINISHED_JOBS,
	jobsPerHour: JOBS_PER_HOUR,
	windowMs: HOUR_MS,
} as const;
const PROGRESS_LIMIT = 100;
const CAS_RETRIES = 4;

export interface ResearchRunServiceDeps {
	readonly jobs: JobRepository;
	readonly workspaces: WorkspaceRepository;
	readonly records: ResearchRecordRepository;
	readonly runnerStatus: RunnerStatusRepository;
	/** The saved agent choice a retry runs on (Settings → AI agent). */
	readonly settings: Pick<SettingsRepository, "getAgentSettings">;
	readonly unitOfWork: ResearchUnitOfWork;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly hasher: Hasher;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
	/** Link-row bookkeeping when the owner cancels a google-calendar run (FR-019). */
	readonly googleCalendar: GoogleCalendarRepository;
}

export interface CreatedRun {
	readonly run: ResearchRun;
	/** True when the idempotency key matched an earlier identical request. */
	readonly replayed: boolean;
}

function isBaselineAgent(agentId: string): boolean {
	return (BASELINE_AGENT_IDS as readonly string[]).includes(agentId);
}

interface CostModels {
	readonly known: (agentId: string) => boolean;
	readonly of: (agentId: string) => CostModel;
}

/**
 * Backends that bill per use. Until a runner reports a backend's cost model,
 * these are assumed metered so a spend ceiling is never dropped by mistake.
 */
const METERED_BY_DEFAULT_AGENT_IDS: readonly string[] = ["openrouter", CLAUDE_API_AGENT_ID];

/** Backends that cannot run without a model chosen in Settings (same rule as the composer). */
const MODEL_REQUIRED_AGENT_IDS: readonly string[] = ["opencode", OPENROUTER_FREE_AGENT_ID];

/**
 * The request a retry runs: the original question, horizon and markets on the
 * agent choice saved NOW — backend, model, effort, web access and spend
 * ceiling — under the fixed limits (RUN_LIMITS, ADR-0029). A failure such as
 * an overloaded model is fixed by choosing another one in Settings, so
 * replaying the old choice would only fail again. With no saved choice the
 * original request runs unchanged. A plan-limited backend never carries a
 * spend allowance, as in the composer.
 */
export function retryRequest(
	original: ResearchRequest,
	saved: AgentSettings | null,
	costModelOf: (agentId: string) => CostModel,
): ResearchRequest {
	if (saved === null || saved.defaultAgentId === null) return original;
	return { ...original, ...savedAgentChoice(saved, saved.defaultAgentId, costModelOf) };
}

/** The agent half of a research request: the fields Settings → AI agent decides. */
export type AgentChoice = Pick<
	ResearchRequest,
	"agentId" | "model" | "effort" | "webAccess" | "budget"
>;

/**
 * The agent choice saved in Settings → AI agent for `agentId`, under the
 * fixed limits (RUN_LIMITS, ADR-0029). A plan-limited backend never carries
 * a spend allowance, as in the composer. Shared by Retry and by scheduled
 * tasks (ADR-0033 §4), which both run on the choice saved at that moment.
 */
function savedAgentChoice(
	saved: AgentSettings,
	agentId: string,
	costModelOf: (agentId: string) => CostModel,
): AgentChoice {
	return {
		agentId,
		model: saved.models[agentId] ?? null,
		effort: saved.effort,
		webAccess: saved.webAccess,
		budget: runBudget(costModelOf(agentId) === "plan-limited" ? null : saved.budget.maxSpendUsd),
	};
}

/** One run a scheduled task asks for — a due occurrence or "Run now" (ADR-0033). */
export interface TaskRunInput {
	readonly taskId: string;
	/** The task's question, in its own conversation. */
	readonly question: Pick<ResearchRequest, "workspaceId" | "question" | "horizonYears" | "markets">;
	readonly spendConsent: TaskSpendConsent | null;
	readonly idempotencyKey: string;
	/**
	 * Fixed per occurrence (`task:<id>:<slot>`, `task-run:<id>`), never the
	 * built request: the saved agent choice may change between a crash and
	 * its replay, and the replay must still answer the run it created.
	 */
	readonly requestFingerprint: string;
	/** `scheduler` for a due occurrence, `owner` for "Run now". */
	readonly actor: "owner" | "scheduler";
}

export function createResearchRunService(deps: ResearchRunServiceDeps) {
	async function view(job: JobRecord): Promise<ResearchRun> {
		return toRunView(job, await deps.jobs.listProgress(job.ownerId, job.runId, PROGRESS_LIMIT));
	}

	function newJob(
		ownerId: string,
		input: Pick<
			JobRecord,
			"kind" | "request" | "workspaceId" | "retryOfRunId" | "contextAnchorSeq"
		>,
	): JobRecord {
		const now = deps.clock.nowIso();
		return {
			...input,
			runId: deps.ids.newId("run"),
			ownerId,
			state: "pending",
			usage: EMPTY_USAGE,
			attempt: 0,
			maxAttempts: MAX_JOB_ATTEMPTS,
			leaseGeneration: 0,
			leaseOwnerId: null,
			leaseExpiresAt: null,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			approvalRequest: null,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 0,
			createdAt: now,
			updatedAt: now,
		};
	}

	/** Shared admission control for anything that enqueues work (section 9.9). */
	async function admit(ownerId: string): Promise<UseCaseResult<void>> {
		const allowed = await deps.rateLimiter.consume({
			ownerId,
			bucket: "job-create",
			limit: JOBS_PER_HOUR,
			windowMs: HOUR_MS,
			nowMs: deps.clock.nowMs(),
		});
		if (!allowed) return fail("RATE_LIMITED", "Too many runs were started; try again later.");
		return ok(undefined);
	}

	const atCapacity = (): UseCaseResult<never> =>
		fail("RATE_LIMITED", `At most ${MAX_UNFINISHED_JOBS} unfinished runs are allowed.`);

	const keyReused = (): UseCaseResult<never> =>
		fail(
			"IDEMPOTENCY_KEY_REUSED",
			"This idempotency key was already used for a different request.",
		);

	/**
	 * A repeated idempotency key is answered from the stored job BEFORE any
	 * admission control runs: a replay is not a new request, so it must neither be
	 * refused by a cap nor consume the hourly allowance (ARCH-016).
	 */
	async function replayOf(
		ownerId: string,
		idempotencyKey: string,
		requestFingerprint: string,
	): Promise<UseCaseResult<CreatedRun> | null> {
		const existing = await deps.jobs.findByIdempotencyKey(ownerId, idempotencyKey);
		if (existing === null) return null;
		return existing.requestFingerprint === requestFingerprint
			? ok({ run: await view(existing.job), replayed: true })
			: keyReused();
	}

	/** Maps the storage outcome of an enqueue, which re-checks key and capacity atomically. */
	async function enqueued(
		outcome: EnqueueResult,
		job: JobRecord,
	): Promise<UseCaseResult<CreatedRun>> {
		if (outcome.kind === "at-capacity") return atCapacity();
		if (outcome.kind === "no-workspace") return fail("NOT_FOUND", "Workspace not found.");
		if (outcome.kind === "kind-active") {
			// S1: the INSERT refused a second active market-refresh job (or a
			// retry of one while another is active) — answer with that run.
			return ok({ run: await view(outcome.job), replayed: true });
		}
		if (outcome.kind === "existing") {
			return outcome.sameRequest
				? ok({ run: await view(outcome.job), replayed: true })
				: keyReused();
		}
		return ok({ run: await view(job), replayed: false });
	}

	/** Cost model by agent id, as the runner last reported it (the API backends are metered by default). */
	async function costModels(ownerId: string): Promise<CostModels> {
		const status = await deps.runnerStatus.get(ownerId);
		const reported = (agentId: string) => status?.agents.find((agent) => agent.agentId === agentId);
		return {
			known: (agentId) => reported(agentId) !== undefined || isBaselineAgent(agentId),
			of: (agentId) =>
				reported(agentId)?.costModel ??
				(METERED_BY_DEFAULT_AGENT_IDS.includes(agentId) ? "metered" : "plan-limited"),
		};
	}

	/** Only registered or baseline backends may be queued. Spending caps are optional. */
	async function checkAgent(
		ownerId: string,
		agentId: string,
		knownModels?: CostModels,
	): Promise<UseCaseResult<void>> {
		const models = knownModels ?? (await costModels(ownerId));
		if (!models.known(agentId)) {
			return fail("UNKNOWN_AGENT", `Agent backend "${agentId}" is not registered.`);
		}
		return ok(undefined);
	}

	/**
	 * Inserts a research job with the owner's question in its conversation
	 * (one batch, ADR-0004) after the caller's admission checks passed.
	 */
	async function enqueueQuestion(
		ownerId: string,
		request: ResearchRequest,
		idempotencyKey: string,
		requestFingerprint: string,
		audit: { readonly actor: string; readonly detail: string },
	): Promise<UseCaseResult<CreatedRun>> {
		const job = newJob(ownerId, {
			kind: "research",
			request,
			workspaceId: request.workspaceId,
			retryOfRunId: null,
			// The enqueue stamps the owner's question seq onto the job in the
			// same batch; reads below see it once the insert committed.
			contextAnchorSeq: null,
		});
		const outcome = await deps.unitOfWork.enqueueResearch({
			job,
			idempotencyKey,
			requestFingerprint,
			ownerMessage: { messageId: deps.ids.newId("msg"), text: request.question },
			maxUnfinished: MAX_UNFINISHED_JOBS,
		});
		if (outcome.kind === "inserted") {
			await deps.audit.record({
				ownerId,
				actor: audit.actor,
				action: "run.create",
				resource: job.runId,
				detail: audit.detail,
				at: job.createdAt,
			});
		}
		return enqueued(outcome, job);
	}

	async function mutate(
		ownerId: string,
		runId: string,
		compute: (
			job: JobRecord,
		) => UseCaseResult<Omit<JobWrite, "runId" | "expectedVersion" | "at"> | null>,
	): Promise<UseCaseResult<JobRecord>> {
		for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
			const job = await deps.jobs.get(ownerId, runId);
			if (job === null) return fail("NOT_FOUND", "Run not found.");
			const change = compute(job);
			if (!change.ok) return change;
			if (change.value === null) return ok(job);
			const written = await deps.jobs.write(ownerId, {
				...change.value,
				runId,
				expectedVersion: job.version,
				at: deps.clock.nowIso(),
			});
			if (written) {
				const updated = await deps.jobs.get(ownerId, runId);
				if (updated !== null) return ok(updated);
			}
		}
		return fail("CONFLICT", "The run changed concurrently; retry the request.");
	}

	return {
		async create(
			ownerId: string,
			request: ResearchRequest,
			idempotencyKey: string,
		): Promise<UseCaseResult<CreatedRun>> {
			const requestFingerprint = await deps.hasher.sha256Hex(JSON.stringify(request));
			const replay = await replayOf(ownerId, idempotencyKey, requestFingerprint);
			if (replay !== null) return replay;

			const workspace = await deps.workspaces.get(ownerId, request.workspaceId);
			if (workspace === null) return fail("NOT_FOUND", "Workspace not found.");
			const agent = await checkAgent(ownerId, request.agentId);
			if (!agent.ok) return agent;
			const admitted = await admit(ownerId);
			if (!admitted.ok) return admitted;
			return enqueueQuestion(ownerId, request, idempotencyKey, requestFingerprint, {
				actor: "owner",
				detail: `agent=${request.agentId}`,
			});
		},

		/**
		 * Queues one run of a scheduled task (ADR-0033 §2–§5) on the agent
		 * choice saved in Settings → AI agent NOW, like Retry. Errors:
		 * `AGENT_NOT_CONFIGURED` (nothing saved), `VALIDATION_FAILED` (the
		 * saved backend needs a model),
		 * `UNKNOWN_AGENT`, `NOT_FOUND` (conversation gone), `RATE_LIMITED`
		 * (hourly allowance or unfinished-run cap). A repeated key answers
		 * its run before any of these checks (ARCH-016).
		 */
		async createForTask(ownerId: string, input: TaskRunInput): Promise<UseCaseResult<CreatedRun>> {
			const replay = await replayOf(ownerId, input.idempotencyKey, input.requestFingerprint);
			if (replay !== null) return replay;

			const saved = await deps.settings.getAgentSettings(ownerId);
			if (saved === null || saved.settings.defaultAgentId === null) {
				return fail(
					"AGENT_NOT_CONFIGURED",
					"No AI backend is configured. Choose one in Settings → AI agent.",
				);
			}
			const models = await costModels(ownerId);
			const request: ResearchRequest = {
				workspaceId: input.question.workspaceId,
				question: input.question.question,
				horizonYears: input.question.horizonYears,
				markets: [...input.question.markets],
				...savedAgentChoice(saved.settings, saved.settings.defaultAgentId, models.of),
			};
			if (MODEL_REQUIRED_AGENT_IDS.includes(request.agentId) && request.model === null) {
				return fail(
					"VALIDATION_FAILED",
					"The backend saved in Settings → AI agent needs a model; choose one there.",
				);
			}
			const agent = await checkAgent(ownerId, request.agentId, models);
			if (!agent.ok) return agent;
			const workspace = await deps.workspaces.get(ownerId, request.workspaceId);
			if (workspace === null) return fail("NOT_FOUND", "Workspace not found.");
			const admitted = await admit(ownerId);
			if (!admitted.ok) return admitted;
			return enqueueQuestion(ownerId, request, input.idempotencyKey, input.requestFingerprint, {
				actor: input.actor,
				detail: `agent=${request.agentId} task=${input.taskId}`,
			});
		},

		/** Queues retrieval of every active subscribed source (FR-003). */
		async createIngest(
			ownerId: string,
			idempotencyKey: string,
		): Promise<UseCaseResult<CreatedRun>> {
			const requestFingerprint = "news-ingest";
			const replay = await replayOf(ownerId, idempotencyKey, requestFingerprint);
			if (replay !== null) return replay;
			const admitted = await admit(ownerId);
			if (!admitted.ok) return admitted;
			const job = newJob(ownerId, {
				kind: "news-ingest",
				request: null,
				workspaceId: null,
				retryOfRunId: null,
				contextAnchorSeq: null,
			});
			return enqueued(
				await deps.jobs.insert(job, idempotencyKey, requestFingerprint, MAX_UNFINISHED_JOBS),
				job,
			);
		},

		/**
		 * Queues a market-data refresh. AT MOST ONE non-terminal
		 * market-refresh job per owner: a request while one is active returns
		 * that active run (no second job).
		 */
		async createMarketRefresh(
			ownerId: string,
			idempotencyKey: string,
		): Promise<UseCaseResult<CreatedRun>> {
			const active = await deps.jobs.findActiveByKind(ownerId, "market-refresh");
			if (active !== null) return ok({ run: await view(active), replayed: true });
			const requestFingerprint = "market-refresh";
			const replay = await replayOf(ownerId, idempotencyKey, requestFingerprint);
			if (replay !== null) return replay;
			const admitted = await admit(ownerId);
			if (!admitted.ok) return admitted;
			const job = newJob(ownerId, {
				kind: "market-refresh",
				request: null,
				workspaceId: null,
				retryOfRunId: null,
				contextAnchorSeq: null,
			});
			const outcome = await deps.jobs.insert(
				job,
				idempotencyKey,
				requestFingerprint,
				MAX_UNFINISHED_JOBS,
			);
			if (outcome.kind === "inserted") {
				await deps.audit.record({
					ownerId,
					actor: "owner",
					action: "run.create_market_refresh",
					resource: job.runId,
					detail: "kind=market-refresh",
					at: job.createdAt,
				});
			}
			return enqueued(outcome, job);
		},

		async get(ownerId: string, runId: string): Promise<UseCaseResult<ResearchRun>> {
			const job = await deps.jobs.get(ownerId, runId);
			if (job === null) return fail("NOT_FOUND", "Run not found.");
			return ok(await view(job));
		},

		async list(ownerId: string, workspaceId: string | null): Promise<readonly ResearchRun[]> {
			const jobs = await deps.jobs.list(ownerId, { workspaceId, limit: 20 });
			// Lists omit progress logs to keep the query count flat (no N+1).
			return jobs.map((job) => toRunView(job, []));
		},

		async records(ownerId: string, runId: string): Promise<UseCaseResult<RunRecords>> {
			const job = await deps.jobs.get(ownerId, runId);
			if (job === null) return fail("NOT_FOUND", "Run not found.");
			return ok(await deps.records.recordsForRuns(ownerId, [runId]));
		},

		/**
		 * Cancellation is immediate when nobody holds a live lease. Otherwise it is
		 * a request the runner observes on its next heartbeat; lease fencing covers
		 * the case where the runner never answers.
		 */
		async cancel(ownerId: string, runId: string): Promise<UseCaseResult<ResearchRun>> {
			const nowMs = deps.clock.nowMs();
			// True only when THIS call moved the run to `cancelled` (the
			// mutation may be re-run after a lost compare-and-set).
			let cancelledHere = false;
			const result = await mutate(ownerId, runId, (job) => {
				cancelledHere = false;
				if (isTerminalJobState(job.state) || job.cancelRequested) return ok(null);
				const leaseLive =
					isLeasedJobState(job.state) &&
					job.leaseExpiresAt !== null &&
					(isoToEpochMs(job.leaseExpiresAt) ?? 0) > nowMs;
				if (leaseLive) return ok({ patch: { cancelRequested: true }, audits: [] });
				const cancelled: JobState = "cancelled";
				cancelledHere = true;
				return ok({
					patch: { state: cancelled, leaseExpiresAt: null, cancelRequested: false },
					audits: [
						{
							fromState: job.state,
							toState: cancelled,
							actor: "owner",
							reason: "cancelled by owner",
						},
					],
				});
			});
			if (!result.ok) return result;
			if (cancelledHere) {
				// No runner will complete this run, so the Google link row is
				// restored here (FR-019 section 2.5): a cancelled connect must
				// not stay `connecting` on a sign-in link nobody listens for.
				await applyGoogleTerminalOutcome(
					deps,
					ownerId,
					result.value,
					"cancelled",
					null,
					deps.clock.nowIso(),
				);
			}
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "run.cancel",
				resource: runId,
				detail: result.value.state,
				at: deps.clock.nowIso(),
			});
			return ok(await view(result.value));
		},

		/** A retry is a NEW run (run ids are immutable) linked to the one it retries. */
		async retry(
			ownerId: string,
			runId: string,
			idempotencyKey: string,
		): Promise<UseCaseResult<CreatedRun>> {
			const requestFingerprint = `retry:${runId}`;
			const replay = await replayOf(ownerId, idempotencyKey, requestFingerprint);
			if (replay !== null) return replay;

			const original = await deps.jobs.get(ownerId, runId);
			if (original === null) return fail("NOT_FOUND", "Run not found.");
			if (original.kind === "google-calendar") {
				return fail(
					"VALIDATION_FAILED",
					"Google Calendar runs are started again from the calendar controls, not retried.",
				);
			}
			if (!isTerminalJobState(original.state) || original.state === "completed") {
				return fail(
					"ILLEGAL_TRANSITION",
					"Only failed, cancelled or partial runs can be retried.",
					original.state,
				);
			}
			let request = original.request;
			if (request !== null && "agentId" in request) {
				const models = await costModels(ownerId);
				const saved = await deps.settings.getAgentSettings(ownerId);
				const next = retryRequest(request, saved?.settings ?? null, models.of);
				if (MODEL_REQUIRED_AGENT_IDS.includes(next.agentId) && next.model === null) {
					return fail(
						"VALIDATION_FAILED",
						"The backend saved in Settings → AI agent needs a model; choose one there and retry.",
					);
				}
				const agent = await checkAgent(ownerId, next.agentId, models);
				if (!agent.ok) return agent;
				request = next;
			}
			const admitted = await admit(ownerId);
			if (!admitted.ok) return admitted;
			const job = newJob(ownerId, {
				kind: original.kind,
				request,
				workspaceId: original.workspaceId,
				retryOfRunId: original.runId,
				// A retry has no owner message of its own: it inherits the
				// original run's anchor, so it gets the same context.
				contextAnchorSeq: original.contextAnchorSeq,
			});
			return enqueued(
				await deps.jobs.insert(job, idempotencyKey, requestFingerprint, MAX_UNFINISHED_JOBS),
				job,
			);
		},

		/** Resumes a run that stopped for an owner decision, under the ceilings the owner now sets. */
		async approve(
			ownerId: string,
			runId: string,
			budget: ResearchBudget,
		): Promise<UseCaseResult<ResearchRun>> {
			const current = await deps.jobs.get(ownerId, runId);
			if (current === null) return fail("NOT_FOUND", "Run not found.");
			if (current.kind === "google-calendar") {
				return fail("VALIDATION_FAILED", "This run does not wait for approval.");
			}
			if (current.request !== null && "agentId" in current.request) {
				const agent = await checkAgent(ownerId, current.request.agentId);
				if (!agent.ok) return agent;
			}
			const result = await mutate(ownerId, runId, (job) => {
				if (job.state !== "waiting_approval") {
					return fail("ILLEGAL_TRANSITION", "This run is not waiting for approval.", job.state);
				}
				const pending: JobState = "pending";
				return ok({
					patch: {
						state: pending,
						approvalRequest: null,
						request:
							job.request !== null && "agentId" in job.request
								? { ...job.request, budget }
								: job.request,
						// An approved continuation is not a failed attempt: it gets the full retry
						// allowance again, so repeated approvals never exhaust the failure ceiling.
						attempt: 0,
					},
					audits: [
						{ fromState: job.state, toState: pending, actor: "owner", reason: "approved by owner" },
					],
				});
			});
			if (!result.ok) return result;
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "run.approve",
				resource: runId,
				detail: "",
				at: deps.clock.nowIso(),
			});
			return ok(await view(result.value));
		},
	};
}

export type ResearchRunService = ReturnType<typeof createResearchRunService>;
