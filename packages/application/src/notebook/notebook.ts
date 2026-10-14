/**
 * The per-conversation Notebook (ADR-0020): stored, served and edited through
 * the owner API with compare-and-set, kept with a 20-deep undo history, and
 * the `notebook-assist` job that lets the assistant apply validated commands.
 *
 * The pure command layer (`notebookAgent.ts`) is shared with the runner: the
 * runner pre-checks a model's commands against its copy, the completion path
 * below applies them again against the stored notebook, all or nothing.
 */
import {
	type ChatMessage,
	CONVERSATION_CONTEXT_LIMITS,
	type CompleteJobRequest,
	type ConversationContextMessage,
	EMPTY_NOTEBOOK,
	NOTEBOOK_LIMITS,
	type Notebook,
	type NotebookAssistJobRequest,
	type NotebookAssistRequest,
	type NotebookChange,
	type NotebookResponse,
	type NotebookTurn,
	notebookCapacityProblem,
	type ResearchRun,
} from "@research/contracts";
import { EMPTY_USAGE, err, ok, type Result } from "@research/domain";
import { fail, type UseCaseResult } from "../errors.ts";
import type {
	AuditLog,
	ChatRepository,
	Clock,
	Hasher,
	IdGenerator,
	JobRecord,
	JobRepository,
	NotebookRepository,
	RateLimiter,
	ResearchUnitOfWork,
	SettingsRepository,
	WorkspaceRepository,
} from "../ports.ts";
import { buildConversationContextBeforeAnchor } from "../research/conversationContext.ts";
import { MAX_JOB_ATTEMPTS } from "../researchRuns.ts";
import { toRunView } from "../runView.ts";
import { applyNotebookCommands, stampNotebook, toNotebookWidgetCore } from "./notebookAgent.ts";

const JOBS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const MAX_UNFINISHED_JOBS = 5;
const PROGRESS_LIMIT = 100;
/** How many of the most recent chat rows one notebook claim reads (same budget as research). */
const CONTEXT_LOAD_LIMIT = CONVERSATION_CONTEXT_LIMITS.maxMessages;

export interface NotebookServiceDeps {
	readonly notebooks: NotebookRepository;
	readonly workspaces: WorkspaceRepository;
	readonly jobs: JobRepository;
	readonly chat: ChatRepository;
	readonly settings: SettingsRepository;
	readonly unitOfWork: ResearchUnitOfWork;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly hasher: Hasher;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
}

export interface NotebookAssistResult {
	readonly message: ChatMessage;
	readonly run: ResearchRun;
	/** True when the idempotency key matched an earlier identical request. */
	readonly replayed: boolean;
}

const CONFLICT_MESSAGE = "The notebook changed; reload and try again.";
const UNREADABLE_SHOWN = "The stored notebook could not be read, so it cannot be shown.";
const UNREADABLE_SAVED = "The stored notebook could not be read, so it cannot be saved.";
const UNREADABLE_QUEUED =
	"The stored notebook could not be read, so the instruction cannot be queued.";
const UNREADABLE_APPLIED = "The stored notebook could not be read, so nothing was applied.";
const NOTEBOOK_CHANGED_MESSAGE =
	"The notebook changed while the assistant was working, so nothing was applied. Ask again.";

function invalidResearchWidget(title: string): string {
	return `Research widget "${title}" names a canvas component that is not in this conversation.`;
}

export function createNotebookService(deps: NotebookServiceDeps) {
	async function view(job: JobRecord): Promise<ResearchRun> {
		return toRunView(job, await deps.jobs.listProgress(job.ownerId, job.runId, PROGRESS_LIMIT));
	}

	async function responseOf(
		ownerId: string,
		workspaceId: string,
		notebook: Notebook,
		version: number,
		updatedAt: string | null,
	): Promise<NotebookResponse> {
		const turns = await deps.notebooks.listTurns(
			ownerId,
			workspaceId,
			NOTEBOOK_LIMITS.maxTurnsReturned,
		);
		const undoAvailable =
			version > 0 && (await deps.notebooks.getRevision(ownerId, workspaceId, version - 1)) !== null;
		return {
			workspaceId,
			notebook,
			version,
			updatedAt,
			undoAvailable,
			turns: [...turns],
		};
	}

	return {
		async getNotebook(
			ownerId: string,
			workspaceId: string,
		): Promise<UseCaseResult<NotebookResponse>> {
			const workspace = await deps.workspaces.get(ownerId, workspaceId);
			if (workspace === null) return fail("NOT_FOUND", "Workspace not found.");
			const stored = await deps.notebooks.get(ownerId, workspaceId);
			if (stored === "unreadable") return fail("STORED_NOTEBOOK_UNREADABLE", UNREADABLE_SHOWN);
			if (stored === null) {
				const turns = await deps.notebooks.listTurns(
					ownerId,
					workspaceId,
					NOTEBOOK_LIMITS.maxTurnsReturned,
				);
				return ok({
					workspaceId,
					notebook: EMPTY_NOTEBOOK,
					version: 0,
					updatedAt: null,
					undoAvailable: false,
					turns: [...turns],
				});
			}
			return ok(
				await responseOf(ownerId, workspaceId, stored.notebook, stored.version, stored.updatedAt),
			);
		},

		async putNotebook(
			ownerId: string,
			workspaceId: string,
			notebook: Notebook,
			expectedVersion: number,
		): Promise<UseCaseResult<NotebookResponse>> {
			const workspace = await deps.workspaces.get(ownerId, workspaceId);
			if (workspace === null) return fail("NOT_FOUND", "Workspace not found.");
			const stored = await deps.notebooks.get(ownerId, workspaceId);
			if (stored === "unreadable") return fail("STORED_NOTEBOOK_UNREADABLE", UNREADABLE_SAVED);
			const previous = stored === null ? EMPTY_NOTEBOOK : stored.notebook;
			const canvasIds = new Set(
				workspace.state.components.map((component) => component.componentId),
			);
			for (const widget of notebook.widgets) {
				if (widget.type === "research" && !canvasIds.has(widget.componentId)) {
					return fail("INVALID_NOTEBOOK", invalidResearchWidget(widget.title));
				}
			}
			const capacity = notebookCapacityProblem(notebook.widgets, previous.widgets);
			if (capacity !== null) return fail("INVALID_NOTEBOOK", capacity.message);
			const now = deps.clock.nowIso();
			// New widgets keep the client's origin — except an `assistant`
			// origin, which only the assistant path may claim (rewritten here).
			const clientOrigin = new Map(
				notebook.widgets.map((widget) => [widget.widgetId, widget.origin] as const),
			);
			const stamped = stampNotebook(
				previous,
				notebook.widgets.map(toNotebookWidgetCore),
				now,
				(core) => {
					const claimed = clientOrigin.get(core.widgetId);
					if (claimed !== undefined && claimed.kind !== "assistant") return claimed;
					return { kind: "owner", messageId: null, runId: null, componentId: null };
				},
			);
			const written = await deps.notebooks.put(ownerId, workspaceId, stamped, expectedVersion, now);
			if (written === "version-conflict") {
				return fail("VERSION_CONFLICT", CONFLICT_MESSAGE);
			}
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "notebook.update",
				resource: workspaceId,
				detail: `widgets=${stamped.widgets.length}`,
				at: now,
			});
			const reread = await deps.notebooks.get(ownerId, workspaceId);
			if (reread === null || reread === "unreadable") return fail("INTERNAL", "Internal error.");
			return ok(
				await responseOf(ownerId, workspaceId, reread.notebook, reread.version, reread.updatedAt),
			);
		},

		/**
		 * Restores the body kept before `expectedVersion` as a new version.
		 * The restored body is re-validated against the current canvas (fail
		 * closed) and re-stamped, so the undo itself is one undoable version.
		 */
		async undoNotebook(
			ownerId: string,
			workspaceId: string,
			expectedVersion: number,
		): Promise<UseCaseResult<NotebookResponse>> {
			const workspace = await deps.workspaces.get(ownerId, workspaceId);
			if (workspace === null) return fail("NOT_FOUND", "Workspace not found.");
			const stored = await deps.notebooks.get(ownerId, workspaceId);
			if (stored === "unreadable") return fail("STORED_NOTEBOOK_UNREADABLE", UNREADABLE_SAVED);
			if (stored === null || stored.version !== expectedVersion) {
				return fail("VERSION_CONFLICT", CONFLICT_MESSAGE);
			}
			const body = await deps.notebooks.getRevision(ownerId, workspaceId, expectedVersion - 1);
			if (body === null) {
				return fail("NOTHING_TO_UNDO", "There is no earlier notebook version to restore.");
			}
			const canvasIds = new Set(
				workspace.state.components.map((component) => component.componentId),
			);
			for (const widget of body.widgets) {
				if (widget.type === "research" && !canvasIds.has(widget.componentId)) {
					return fail("INVALID_NOTEBOOK", invalidResearchWidget(widget.title));
				}
			}
			const now = deps.clock.nowIso();
			// The restored body is trusted (the server stamped it when it was
			// written): kept origins stay as they were.
			const keptOrigin = new Map(
				body.widgets.map((widget) => [widget.widgetId, widget.origin] as const),
			);
			const stamped = stampNotebook(
				stored.notebook,
				body.widgets.map(toNotebookWidgetCore),
				now,
				(core) =>
					keptOrigin.get(core.widgetId) ?? {
						kind: "owner",
						messageId: null,
						runId: null,
						componentId: null,
					},
			);
			const written = await deps.notebooks.put(ownerId, workspaceId, stamped, expectedVersion, now);
			if (written === "version-conflict") {
				return fail("VERSION_CONFLICT", CONFLICT_MESSAGE);
			}
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "notebook.undo",
				resource: workspaceId,
				detail: `widgets=${stamped.widgets.length}`,
				at: now,
			});
			const reread = await deps.notebooks.get(ownerId, workspaceId);
			if (reread === null || reread === "unreadable") return fail("INTERNAL", "Internal error.");
			return ok(
				await responseOf(ownerId, workspaceId, reread.notebook, reread.version, reread.updatedAt),
			);
		},

		/**
		 * Stores the instruction as the owner's chat message (the same path a
		 * research question takes, `runId` set) and queues a `notebook-assist`
		 * job carrying the instruction, the selection, the version the owner
		 * saw, and the agent choices currently saved in Settings → AI agent.
		 */
		async assistNotebook(
			ownerId: string,
			workspaceId: string,
			request: NotebookAssistRequest,
			idempotencyKey: string,
		): Promise<UseCaseResult<NotebookAssistResult>> {
			const fingerprint = await deps.hasher.sha256Hex(
				JSON.stringify({
					workspaceId,
					instruction: request.instruction,
					selectedWidgetIds: request.selectedWidgetIds,
					notebookVersion: request.notebookVersion,
				}),
			);
			// A repeated key is answered from the stored job BEFORE any
			// admission control runs: a replay is not a new request (ARCH-016).
			const replay = await deps.jobs.findByIdempotencyKey(ownerId, idempotencyKey);
			if (replay !== null) {
				if (replay.requestFingerprint !== fingerprint) {
					return fail(
						"IDEMPOTENCY_KEY_REUSED",
						"This idempotency key was already used for a different request.",
					);
				}
				const message = await deps.chat.findByRunId(ownerId, workspaceId, replay.job.runId);
				if (message === null) return fail("INTERNAL", "Internal error.");
				return ok({ message, run: await view(replay.job), replayed: true });
			}

			const workspace = await deps.workspaces.get(ownerId, workspaceId);
			if (workspace === null) return fail("NOT_FOUND", "Workspace not found.");
			const saved = await deps.settings.getAgentSettings(ownerId);
			if (saved === null || saved.settings.defaultAgentId === null) {
				return fail(
					"AGENT_NOT_CONFIGURED",
					"No AI backend is configured. Choose one in Settings → AI agent, then ask again.",
				);
			}
			const agentId = saved.settings.defaultAgentId;
			const stored = await deps.notebooks.get(ownerId, workspaceId);
			if (stored === "unreadable") return fail("STORED_NOTEBOOK_UNREADABLE", UNREADABLE_QUEUED);
			const known = new Set(
				(stored === null ? EMPTY_NOTEBOOK : stored.notebook).widgets.map(
					(widget) => widget.widgetId,
				),
			);
			const unknown = request.selectedWidgetIds.filter((id) => !known.has(id));
			if (unknown.length > 0) {
				return fail(
					"INVALID_NOTEBOOK_SELECTION",
					`The selection names widgets that are not in the notebook: ${unknown.join(", ")}.`,
				);
			}
			const active = await deps.jobs.findActiveNotebookAssist(ownerId, workspaceId);
			if (active !== null) {
				return fail(
					"NOTEBOOK_ASSIST_ACTIVE",
					"A notebook-assistant turn for this conversation is still running. Wait for it to finish, then ask again.",
				);
			}
			const allowed = await deps.rateLimiter.consume({
				ownerId,
				bucket: "job-create",
				limit: JOBS_PER_HOUR,
				windowMs: HOUR_MS,
				nowMs: deps.clock.nowMs(),
			});
			if (!allowed) return fail("RATE_LIMITED", "Too many runs were started; try again later.");

			const now = deps.clock.nowIso();
			const job: JobRecord = {
				kind: "notebook-assist",
				request: {
					instruction: request.instruction,
					selectedWidgetIds: [...request.selectedWidgetIds],
					notebookVersion: request.notebookVersion,
					agent: {
						agentId,
						model: saved.settings.models[agentId] ?? null,
						effort: saved.settings.effort,
					},
				},
				workspaceId,
				retryOfRunId: null,
				contextAnchorSeq: null,
				runId: deps.ids.newId("run"),
				ownerId,
				state: "pending",
				usage: { ...EMPTY_USAGE },
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
			const outcome = await deps.unitOfWork.enqueueResearch({
				job,
				idempotencyKey,
				requestFingerprint: fingerprint,
				ownerMessage: { messageId: deps.ids.newId("msg"), text: request.instruction },
				maxUnfinished: MAX_UNFINISHED_JOBS,
			});
			if (outcome.kind === "at-capacity") {
				return fail("RATE_LIMITED", `At most ${MAX_UNFINISHED_JOBS} unfinished runs are allowed.`);
			}
			if (outcome.kind === "no-workspace") return fail("NOT_FOUND", "Workspace not found.");
			if (outcome.kind === "kind-active") {
				// A concurrent instruction won the single-active-turn guard;
				// retrying with the same key answers from that run.
				return fail(
					"NOTEBOOK_ASSIST_ACTIVE",
					"A notebook-assistant turn for this conversation is still running. Wait for it to finish, then ask again.",
				);
			}
			const queued = outcome.kind === "inserted" ? job : outcome.job;
			if (outcome.kind === "existing" && !outcome.sameRequest) {
				return fail(
					"IDEMPOTENCY_KEY_REUSED",
					"This idempotency key was already used for a different request.",
				);
			}
			if (outcome.kind === "inserted") {
				await deps.audit.record({
					ownerId,
					actor: "owner",
					action: "notebook.assist.create",
					resource: job.runId,
					detail: `selected=${request.selectedWidgetIds.length}`,
					at: now,
				});
			}
			const message = await deps.chat.findByRunId(ownerId, workspaceId, queued.runId);
			if (message === null) return fail("INTERNAL", "Internal error.");
			return ok({ message, run: await view(queued), replayed: outcome.kind === "existing" });
		},
	};
}

export type NotebookService = ReturnType<typeof createNotebookService>;

/* ---------- Claim and completion (used by the runner-job service) ---------- */

/** Why a notebook-assist job is failed at claim time instead of leased. */
export interface NotebookClaimRefusal {
	/** Audit reason (fixed text, never provider data). */
	readonly reason: string;
	readonly failureCode: "STORED_NOTEBOOK_UNREADABLE" | "INTERNAL";
}

export interface NotebookClaimData {
	readonly agent: NotebookAssistJobRequest["agent"];
	readonly instruction: string;
	readonly selectedWidgetIds: readonly string[];
	readonly notebook: Notebook;
	readonly notebookVersion: number;
	readonly conversationContext: readonly ConversationContextMessage[];
}

export interface NotebookClaimDeps {
	readonly notebooks: NotebookRepository;
	readonly chat: ChatRepository;
}

/**
 * The claim-time payload of a notebook-assist job: the notebook as stored at
 * claim time and its version, the request's instruction and selection (ids no
 * longer in the notebook are dropped), the frozen agent choices, and the
 * bounded conversation context the research claim also carries.
 */
export async function prepareNotebookAssistClaim(
	deps: NotebookClaimDeps,
	ownerId: string,
	job: JobRecord,
): Promise<Result<NotebookClaimData, NotebookClaimRefusal>> {
	const request = job.request !== null && "instruction" in job.request ? job.request : null;
	if (request === null || job.workspaceId === null) {
		return err({ reason: "notebook-assist job without its request", failureCode: "INTERNAL" });
	}
	const stored = await deps.notebooks.get(ownerId, job.workspaceId);
	if (stored === "unreadable") {
		return err({ reason: "stored notebook unreadable", failureCode: "STORED_NOTEBOOK_UNREADABLE" });
	}
	const notebook = stored === null ? EMPTY_NOTEBOOK : stored.notebook;
	const notebookVersion = stored === null ? 0 : stored.version;
	const present = new Set(notebook.widgets.map((widget) => widget.widgetId));
	const rows =
		job.contextAnchorSeq === null
			? []
			: await deps.chat.list(ownerId, job.workspaceId, {
					beforeSeq: job.contextAnchorSeq,
					limit: CONTEXT_LOAD_LIMIT,
				});
	return ok({
		agent: request.agent,
		instruction: request.instruction,
		selectedWidgetIds: request.selectedWidgetIds.filter((id) => present.has(id)),
		notebook,
		notebookVersion,
		conversationContext: buildConversationContextBeforeAnchor(rows, job.contextAnchorSeq),
	});
}

export interface NotebookCompletionDeps {
	readonly notebooks: NotebookRepository;
	readonly workspaces: WorkspaceRepository;
	readonly ids: IdGenerator;
}

export interface NotebookCompletionEffects {
	readonly notebook: {
		readonly workspaceId: string;
		readonly expectedVersion: number;
		readonly notebook: Notebook;
		readonly updatedAt: string;
	} | null;
	readonly notebookTurn: { readonly workspaceId: string; readonly turn: NotebookTurn } | null;
	readonly assistantMessage: {
		readonly messageId: string;
		readonly workspaceId: string;
		readonly text: string;
		readonly claimIds: readonly string[];
	};
}

/**
 * Effects of a `notebook-assisted` completion. The stored notebook is loaded;
 * when its version is not `baseVersion` nothing is applied and the turn
 * records `NOTEBOOK_CHANGED`. Otherwise the commands are applied through the
 * shared agent layer (all or nothing — `remove` is refused there and travels
 * back as `proposedRemovals`); on failure the turn records the failure's code
 * and message and nothing is applied; on success the stamped body is written
 * at `baseVersion` (a compare-and-set loss is `NOTEBOOK_CHANGED` too, decided
 * by the commit). In every case the reply becomes the run's assistant chat
 * message. Failed / cancelled jobs never reach here (no notebook change).
 */
export async function notebookAssistedEffects(
	deps: NotebookCompletionDeps,
	job: JobRecord,
	request: Extract<CompleteJobRequest, { readonly outcome: "notebook-assisted" }>,
	now: string,
): Promise<UseCaseResult<NotebookCompletionEffects>> {
	if (job.workspaceId === null) return fail("INTERNAL", "Internal error.");
	const workspaceId = job.workspaceId;
	const assistantMessage = {
		messageId: `${job.runId}_answer`,
		workspaceId,
		text: request.reply,
		claimIds: [] as readonly string[],
	};
	const failedTurn = (failure: NotebookTurn["failure"]): NotebookCompletionEffects => ({
		notebook: null,
		notebookTurn: {
			workspaceId,
			turn: {
				runId: job.runId,
				baseVersion: request.baseVersion,
				appliedVersion: null,
				changes: [] as NotebookChange[],
				proposedRemovals: [],
				failure,
				createdAt: now,
			},
		},
		assistantMessage,
	});

	const stored = await deps.notebooks.get(job.ownerId, workspaceId);
	if (stored === "unreadable") {
		return ok(failedTurn({ code: "STORED_NOTEBOOK_UNREADABLE", message: UNREADABLE_APPLIED }));
	}
	const current = stored === null ? EMPTY_NOTEBOOK : stored.notebook;
	const currentVersion = stored === null ? 0 : stored.version;
	if (currentVersion !== request.baseVersion) {
		return ok(failedTurn({ code: "NOTEBOOK_CHANGED", message: NOTEBOOK_CHANGED_MESSAGE }));
	}
	const workspace = await deps.workspaces.get(job.ownerId, workspaceId);
	if (workspace === null) return fail("INTERNAL", "Internal error.");
	const canvasIds = new Set(workspace.state.components.map((component) => component.componentId));
	const applied = await applyNotebookCommands(current, request.commands, {
		knownComponentIds: canvasIds,
		newWidgetId: () => deps.ids.newId("w"),
	});
	if (!applied.ok) {
		return ok(
			failedTurn({ code: applied.error.failure.code, message: applied.error.failure.message }),
		);
	}
	const stamped = stampNotebook(current, applied.value.widgets, now, () => ({
		kind: "assistant",
		messageId: null,
		runId: job.runId,
		componentId: null,
	}));
	const titles = new Map(stamped.widgets.map((widget) => [widget.widgetId, widget.title] as const));
	const proposedRemovals = request.proposedRemovals.flatMap((widgetId) => {
		const title = titles.get(widgetId);
		return title === undefined ? [] : [{ widgetId, title }];
	});
	// A turn whose commands change nothing (resizing a widget to the size it
	// has, a reply with no commands) writes no version: there is nothing to
	// undo, and a new version would make the owner's open tab stale for nothing.
	const changed = applied.value.changes.length > 0;
	return ok({
		notebook: changed
			? {
					workspaceId,
					expectedVersion: request.baseVersion,
					notebook: stamped,
					updatedAt: now,
				}
			: null,
		notebookTurn: {
			workspaceId,
			turn: {
				runId: job.runId,
				baseVersion: request.baseVersion,
				appliedVersion: changed ? request.baseVersion + 1 : null,
				changes: [...applied.value.changes],
				proposedRemovals,
				failure: null,
				createdAt: now,
			},
		},
		assistantMessage,
	});
}
