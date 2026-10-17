import {
	type AgentSettings,
	BASELINE_AGENT_IDS,
	type CostModel,
	OPENROUTER_FREE_AGENT_ID,
	type ResearchRequest,
	type ResearchRun,
	type RunRecords,
	runBudget,
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
	const agentId = saved.defaultAgentId;
	return {
		...original,
		agentId,
		model: saved.models[agentId] ?? null,
		effort: saved.effort,
		webAccess: saved.webAccess,
		budget: runBudget(costModelOf(agentId) === "plan-limited" ? null : saved.budget.maxSpendUsd),
	};
}

/**
 * Metered spend needs the owner's consent on the composer (AGT-012). A retry
 * is that same consented action only while backend, model and spend ceiling
 * are unchanged; any other metered retry must be asked again from the
 * composer. The other limits are fixed (ADR-0029), so an older run's
 * different limits do not count as a change.
 */
function sameMeteredChoice(original: ResearchRequest, next: ResearchRequest): boolean {
	return (
		original.agentId === next.agentId &&
		original.model === next.model &&
		original.budget.maxSpendUsd === next.budget.maxSpendUsd
	);
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

	/** Cost model by agent id, as the runner last reported it (openrouter is metered by default). */
	async function costModels(ownerId: string): Promise<CostModels> {
		const status = await deps.runnerStatus.get(ownerId);
		const reported = (agentId: string) => status?.agents.find((agent) => agent.agentId === agentId);
		return {
			known: (agentId) => reported(agentId) !== undefined || isBaselineAgent(agentId),
			of: (agentId) =>
				reported(agentId)?.costModel ?? (agentId === "openrouter" ? "metered" : "plan-limited"),
		};
	}

	/**
	 * A backend is usable when it is one of the four baseline ids or a runner has
	 * reported it. A metered backend additionally needs an explicit spend ceiling:
	 * that ceiling is the owner's consent, and there is no paid fallback (AGT-012).
	 */
	async function checkAgentAndConsent(
		ownerId: string,
		agentId: string,
		budget: ResearchBudget,
		knownModels?: CostModels,
	): Promise<UseCaseResult<void>> {
		const models = knownModels ?? (await costModels(ownerId));
		if (!models.known(agentId)) {
			return fail("UNKNOWN_AGENT", `Agent backend "${agentId}" is not registered.`);
		}
		const costModel = models.of(agentId);
		if (costModel === "metered" && (budget.maxSpendUsd === null || budget.maxSpendUsd <= 0)) {
			return fail(
				"SPEND_CONSENT_REQUIRED",
				"This backend is metered. Set a maximum spend to authorize paid usage.",
			);
		}
		return ok(undefined);
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
			const agent = await checkAgentAndConsent(ownerId, request.agentId, request.budget);
			if (!agent.ok) return agent;
			const admitted = await admit(ownerId);
			if (!admitted.ok) return admitted;

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
					actor: "owner",
					action: "run.create",
					resource: job.runId,
					detail: `agent=${request.agentId}`,
					at: job.createdAt,
				});
			}
			return enqueued(outcome, job);
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
				if (models.of(next.agentId) === "metered" && !sameMeteredChoice(request, next)) {
					return fail(
						"SPEND_CONSENT_REQUIRED",
						"The backend saved in Settings → AI agent is metered and differs from this run's; ask the question again from the composer to confirm the spend.",
					);
				}
				const agent = await checkAgentAndConsent(ownerId, next.agentId, next.budget, models);
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
				const agent = await checkAgentAndConsent(ownerId, current.request.agentId, budget);
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
