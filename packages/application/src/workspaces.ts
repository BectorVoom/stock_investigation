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
	ChatRepository,
	Clock,
	IdGenerator,
	ResearchRecordRepository,
	WorkspaceRepository,
} from "./ports.ts";
import { commandContext, knownIds, toLookup, workspaceReferences } from "./workspaceCommands.ts";

const MAX_WORKSPACES = 50;
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
}

export interface SubmittedCommand {
	readonly state: WorkspaceState;
	readonly replayed: boolean;
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

		/** Workspace state plus every dataset, source and asset its components reference. */
		async view(ownerId: string, workspaceId: string): Promise<UseCaseResult<WorkspaceView>> {
			const record = await deps.workspaces.get(ownerId, workspaceId);
			if (record === null) return fail("NOT_FOUND", "Workspace not found.");
			const resolved = await deps.records.resolve(ownerId, {
				...toLookup(workspaceReferences(record.state, deps.catalog.validateProps)),
				// The view ships datasets, sources and assets; claim badges were checked when stored.
				claimIds: [],
			});
			return ok({
				workspace: record.summary,
				state: record.state,
				datasets: [...resolved.datasets],
				sources: [...resolved.evidence],
				assets: [...resolved.assets],
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
				assetIds: [],
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
	};
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
