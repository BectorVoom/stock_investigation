import type {
	ComponentCatalog,
	Conversation,
	WorkspaceSummary,
	WorkspaceView,
} from "@research/contracts";
import {
	applyUiCommand,
	emptyWorkspaceState,
	ok,
	resolveCommandReferences,
	type UiCommand,
	type WorkspaceState,
} from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AppliedCommand,
	AuditLog,
	ChartEvidenceReferences,
	ChatRepository,
	Clock,
	IdGenerator,
	ResearchRecordRepository,
	ResearchUnitOfWork,
	WorkspaceRepository,
} from "./ports.ts";
import { commandContext, knownIds, toLookup, workspaceReferences } from "./workspaceCommands.ts";

/** Conversations one owner may keep; a scheduled task's own conversation counts too. */
export const MAX_WORKSPACES = 50;
/** A first-question title carries at most this many characters, ellipsis included. */
export const CONVERSATION_TITLE_LIMIT = 60;
/** Default and maximum page size for one conversation; the list endpoint shares the cap. */
export const MESSAGE_LIMIT = 200;
export const CONVERSATION_LIST_LIMIT = 200;
const EVENT_PAGE_SIZE = 100;

export interface ConversationQuery {
	readonly beforeSeq: number | null;
	readonly limit: number;
}

export interface WorkspaceServiceDeps {
	readonly workspaces: WorkspaceRepository;
	readonly records: ResearchRecordRepository;
	readonly chat: ChatRepository;
	readonly catalog: ComponentCatalog;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly audit: AuditLog;
	readonly unitOfWork: ResearchUnitOfWork;
	/** Evidence that chart widgets' copies cite, kept when a conversation goes (ADR-0026). */
	readonly chartEvidence: ChartEvidenceReferences;
}

export interface SubmittedCommand {
	readonly state: WorkspaceState;
	readonly replayed: boolean;
}

/**
 * Names a still-untitled conversation from its first question: the question's
 * first line, whitespace-collapsed, cut to CONVERSATION_TITLE_LIMIT characters
 * with a trailing "…" when cut. Slicing runs over code points, so a cut never
 * splits a surrogate pair. Null when the question has no usable first line, in
 * which case the conversation keeps its current title.
 */
export function deriveConversationTitle(question: string): string | null {
	const firstLine = question.split(/\r?\n/, 1)[0] ?? "";
	const collapsed = firstLine.replace(/\s+/g, " ").trim();
	if (collapsed === "") return null;
	const points = Array.from(collapsed);
	if (points.length <= CONVERSATION_TITLE_LIMIT) return collapsed;
	return `${points
		.slice(0, CONVERSATION_TITLE_LIMIT - 1)
		.join("")
		.trimEnd()}…`;
}

export function createWorkspaceService(deps: WorkspaceServiceDeps) {
	return {
		list: (ownerId: string): Promise<readonly WorkspaceSummary[]> => deps.workspaces.list(ownerId),

		async create(ownerId: string, title: string): Promise<UseCaseResult<WorkspaceSummary>> {
			if ((await deps.workspaces.list(ownerId)).length >= MAX_WORKSPACES) {
				return fail("CONFLICT", `At most ${MAX_WORKSPACES} workspaces are allowed.`);
			}
			const now = deps.clock.nowIso();
			const workspaceId = deps.ids.newId("ws");
			const summary: WorkspaceSummary = {
				workspaceId,
				title,
				version: 0,
				createdAt: now,
				updatedAt: now,
			};
			await deps.workspaces.insert(ownerId, { summary, state: emptyWorkspaceState(workspaceId) });
			return ok(summary);
		},

		/** Workspace state plus every dataset and source its components reference. */
		async view(ownerId: string, workspaceId: string): Promise<UseCaseResult<WorkspaceView>> {
			const record = await deps.workspaces.get(ownerId, workspaceId);
			if (record === null) return fail("NOT_FOUND", "Workspace not found.");
			const resolved = await deps.records.resolve(ownerId, {
				...toLookup(workspaceReferences(record.state, deps.catalog.validateProps)),
				// The view ships datasets and sources; claim badges were checked when stored.
				claimIds: [],
			});
			return ok({
				workspace: record.summary,
				state: record.state,
				datasets: [...resolved.datasets],
				sources: [...resolved.evidence],
			});
		},

		async events(
			ownerId: string,
			workspaceId: string,
			afterVersion: number,
		): Promise<
			UseCaseResult<{ readonly events: readonly AppliedCommand[]; readonly currentVersion: number }>
		> {
			const record = await deps.workspaces.get(ownerId, workspaceId);
			if (record === null) return fail("NOT_FOUND", "Workspace not found.");
			const events = await deps.workspaces.listCommandsAfter(
				ownerId,
				workspaceId,
				afterVersion,
				EVENT_PAGE_SIZE,
			);
			return ok({ events, currentVersion: record.state.version });
		},

		/**
		 * Applies one owner command (UI-006). The command id makes the request
		 * idempotent; the expected version makes it a compare-and-set, so a stale
		 * client is told to refetch instead of silently overwriting newer state.
		 */
		async submitCommand(
			ownerId: string,
			workspaceId: string,
			command: UiCommand,
		): Promise<UseCaseResult<SubmittedCommand>> {
			if (command.workspaceId !== workspaceId) {
				return fail(
					"UI_COMMAND_REJECTED",
					"Command targets a different workspace.",
					"WORKSPACE_MISMATCH",
				);
			}
			const record = await deps.workspaces.get(ownerId, workspaceId);
			if (record === null) return fail("NOT_FOUND", "Workspace not found.");

			const replay = async (): Promise<UseCaseResult<SubmittedCommand> | null> => {
				const applied = await deps.workspaces.findCommand(ownerId, workspaceId, command.commandId);
				if (applied === null) return null;
				if (JSON.stringify(applied.command) !== JSON.stringify(command)) {
					return fail("CONFLICT", "This command id was already used for a different command.");
				}
				const latest = await deps.workspaces.get(ownerId, workspaceId);
				return ok({ state: latest?.state ?? record.state, replayed: true });
			};
			const earlier = await replay();
			if (earlier !== null) return earlier;

			const references = resolveCommandReferences(
				record.state,
				command,
				deps.catalog.validateProps,
			);
			if (!references.ok) {
				return references.error.code === "VERSION_CONFLICT"
					? fail("VERSION_CONFLICT", references.error.detail)
					: fail("UI_COMMAND_REJECTED", references.error.detail, references.error.code);
			}
			const resolved = await deps.records.resolve(ownerId, toLookup(references.value));
			const next = applyUiCommand(
				record.state,
				command,
				commandContext(deps.catalog, knownIds(resolved)),
			);
			if (!next.ok) {
				return fail("UI_COMMAND_REJECTED", next.error.detail, next.error.code);
			}
			const at = deps.clock.nowIso();
			const written = await deps.workspaces.write(ownerId, {
				workspaceId,
				expectedVersion: record.state.version,
				nextState: next.value,
				commands: [{ version: next.value.version, command, appliedAt: at, origin: "owner" }],
				at,
			});
			if (written === "written") return ok({ state: next.value, replayed: false });
			if (written === "duplicate-command") {
				// A concurrent request with the same command id won; report its result.
				const concurrent = await replay();
				if (concurrent !== null) return concurrent;
			}
			return fail("VERSION_CONFLICT", "The workspace changed; reload and try again.");
		},

		/** Stored chat with the claims and evidence its messages cite (FR-010). */
		async conversation(
			ownerId: string,
			workspaceId: string,
			query: ConversationQuery,
		): Promise<UseCaseResult<Conversation>> {
			const record = await deps.workspaces.get(ownerId, workspaceId);
			if (record === null) return fail("NOT_FOUND", "Workspace not found.");
			// One extra row decides `hasEarlier` without a second round trip: when the
			// store holds more than `limit` eligible messages the oldest fetched row is
			// dropped and the flag is set.
			const rows = await deps.chat.list(ownerId, workspaceId, {
				beforeSeq: query.beforeSeq,
				limit: query.limit + 1,
			});
			const hasEarlier = rows.length > query.limit;
			const messages = hasEarlier ? rows.slice(1) : rows;
			const claimIds = [...new Set(messages.flatMap((message) => message.claimIds))];
			const claims = await deps.records.claimsByIds(ownerId, claimIds);
			const evidenceIds = [
				...new Set(claims.flatMap((claim) => claim.links.map((link) => link.evidenceId))),
			];
			const resolved = await deps.records.resolve(ownerId, {
				datasetIds: [],
				evidenceIds,
				claimIds: [],
			});
			return ok({
				messages: [...messages],
				claims: [...claims],
				evidence: [...resolved.evidence],
				hasEarlier,
			});
		},

		/** One summary per workspace of this owner, newest activity first (FR-010). */
		listConversations: (ownerId: string) =>
			deps.chat.listConversations(ownerId, CONVERSATION_LIST_LIMIT),

		/**
		 * Renames a conversation. Renaming to the current title succeeds; the
		 * canvas version never moves, so a rename cannot conflict with a
		 * command write racing it.
		 */
		async rename(
			ownerId: string,
			workspaceId: string,
			title: string,
		): Promise<UseCaseResult<WorkspaceSummary>> {
			const now = deps.clock.nowIso();
			const renamed = await deps.workspaces.rename(ownerId, workspaceId, title, now);
			if (renamed === null) return fail("NOT_FOUND", "Workspace not found.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "workspace.rename",
				resource: workspaceId,
				detail: "",
				at: now,
			});
			return ok(renamed);
		},

		/**
		 * Deletes a conversation and everything it solely owns (ownership rule
		 * in `DeleteWorkspaceInput`). Ids still referenced by a surviving
		 * conversation's canvas are collected first and passed as keep lists,
		 * so borrowed datasets, evidence and claims survive. A concurrent
		 * borrow that commits after this scan may still dangle; reads tolerate
		 * it (unknown ids resolve as absent) and the next write re-validates.
		 */
		async remove(ownerId: string, workspaceId: string): Promise<UseCaseResult<void>> {
			const states = await deps.workspaces.listRecords(ownerId);
			const referenced = states
				.filter((record) => record.summary.workspaceId !== workspaceId)
				.map((record) => workspaceReferences(record.state, deps.catalog.validateProps));
			const lookup = toLookup({
				datasetRefs: referenced.flatMap((refs) => refs.datasetRefs),
				sourceIds: referenced.flatMap((refs) => refs.sourceIds),
				claims: referenced.flatMap((refs) => refs.claims ?? []),
			});
			const chartCited = await deps.chartEvidence.listChartEvidenceIds(ownerId, workspaceId);
			const outcome = await deps.unitOfWork.deleteWorkspace({
				ownerId,
				workspaceId,
				keepEvidenceIds: [...new Set([...lookup.evidenceIds, ...chartCited])],
				keepDatasetIds: [...lookup.datasetIds],
				keepClaimIds: [...lookup.claimIds],
			});
			if (outcome === "not-found") return fail("NOT_FOUND", "Workspace not found.");
			if (outcome === "has-unfinished") {
				return fail(
					"CONFLICT",
					"This conversation still has a running question. Stop the running question first, then delete the conversation.",
				);
			}
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "workspace.remove",
				resource: workspaceId,
				detail: "",
				at: deps.clock.nowIso(),
			});
			return ok(undefined);
		},
	};
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
