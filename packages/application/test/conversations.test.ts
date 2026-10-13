import type { ComponentCatalog } from "@research/contracts";
import { emptyWorkspaceState, ok, type WorkspaceState } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	type AuditEntry,
	type AuditLog,
	type ChatRepository,
	type Clock,
	CONVERSATION_TITLE_LIMIT,
	createWorkspaceService,
	type DeleteWorkspaceInput,
	type DeleteWorkspaceOutcome,
	deriveConversationTitle,
	type IdGenerator,
	type ResearchRecordRepository,
	type ResearchUnitOfWork,
	type WorkspaceRecord,
	type WorkspaceRepository,
	type WorkspaceService,
} from "../src/index.ts";
import { fixedClock } from "./support.ts";

const OWNER = "owner-conversations-test";

function ids(): IdGenerator {
	let counter = 0;
	return {
		newId: (prefix: string) => {
			counter += 1;
			return `${prefix}_test${counter}`;
		},
	};
}

function record(state: WorkspaceState, title: string, at: string): WorkspaceRecord {
	return {
		summary: {
			workspaceId: state.workspaceId,
			title,
			version: state.version,
			createdAt: at,
			updatedAt: at,
		},
		state,
	};
}

function memoryWorkspaces(): WorkspaceRepository & {
	readonly rows: Map<string, WorkspaceRecord>;
} {
	const rows = new Map<string, WorkspaceRecord>();
	return {
		rows,
		list: async (ownerId: string) =>
			ownerId === OWNER ? [...rows.values()].map((entry) => entry.summary) : [],
		get: async (ownerId: string, workspaceId: string) =>
			ownerId === OWNER ? (rows.get(workspaceId) ?? null) : null,
		insert: async (ownerId: string, entry: WorkspaceRecord) => {
			if (ownerId === OWNER) rows.set(entry.summary.workspaceId, entry);
		},
		rename: async (ownerId: string, workspaceId: string, title: string, updatedAt: string) => {
			if (ownerId !== OWNER) return null;
			const current = rows.get(workspaceId) ?? null;
			if (current === null) return null;
			const summary = { ...current.summary, title, updatedAt };
			rows.set(workspaceId, { summary, state: current.state });
			return summary;
		},
		listRecords: async (ownerId: string) => (ownerId === OWNER ? [...rows.values()] : []),
		findCommand: async () => null,
		write: async () => "written" as const,
		listCommandsAfter: async () => [],
	};
}

function stubChat(): ChatRepository {
	return {
		list: async () => {
			throw new Error("unused");
		},
		listConversations: async () => {
			throw new Error("unused");
		},
	};
}

function stubRecords(): ResearchRecordRepository {
	return {
		resolve: async () => {
			throw new Error("unused");
		},
		recordsForRuns: async () => {
			throw new Error("unused");
		},
		claimsByIds: async () => {
			throw new Error("unused");
		},
		runIdsForWorkspace: async () => {
			throw new Error("unused");
		},
		datasetsForWorkspace: async () => {
			throw new Error("unused");
		},
	};
}

function auditing(): AuditLog & { readonly entries: AuditEntry[] } {
	const entries: AuditEntry[] = [];
	return {
		entries,
		record: async (entry: AuditEntry) => {
			entries.push(entry);
		},
	};
}

/** A catalog that reports canned references per component type. */
function cannedCatalog(): ComponentCatalog {
	return {
		validateProps: (componentType: string) => {
			if (componentType === "survivor-widget") {
				return ok({
					props: {},
					schemaVersion: 1,
					references: {
						datasetRefs: ["ds_keep"],
						sourceIds: ["ev_keep"],
						claims: [{ claimId: "cl_keep", status: "supported", claimType: "observation" }],
					},
				});
			}
			return ok({
				props: {},
				schemaVersion: 1,
				references: {
					datasetRefs: ["ds_doomed"],
					sourceIds: ["ev_doomed"],
					claims: [{ claimId: "cl_doomed", status: "supported", claimType: "observation" }],
				},
			});
		},
		componentTypes: () => ["survivor-widget", "doomed-widget"],
		currentSchemaVersion: () => 1,
	};
}

function stateWith(workspaceId: string, componentType: string): WorkspaceState {
	return {
		...emptyWorkspaceState(workspaceId),
		components: [{ componentId: "c1", componentType, schemaVersion: 1, props: {} }],
		layout: { order: ["c1"], columns: 1 },
	};
}

function stubUnitOfWork(outcome: DeleteWorkspaceOutcome): ResearchUnitOfWork & {
	readonly seen: DeleteWorkspaceInput[];
} {
	const seen: DeleteWorkspaceInput[] = [];
	return {
		seen,
		enqueueResearch: async () => {
			throw new Error("unused");
		},
		commitCompletion: async () => {
			throw new Error("unused");
		},
		importWorkspace: async () => {
			throw new Error("unused");
		},
		deleteWorkspace: async (input: DeleteWorkspaceInput) => {
			seen.push(input);
			return outcome;
		},
	};
}

function service(
	workspaces: WorkspaceRepository,
	unitOfWork: ResearchUnitOfWork,
	audit: AuditLog,
	clock: Clock,
): WorkspaceService {
	return createWorkspaceService({
		workspaces,
		records: stubRecords(),
		chat: stubChat(),
		catalog: cannedCatalog(),
		clock,
		ids: ids(),
		audit,
		unitOfWork,
	});
}

describe("deriveConversationTitle", () => {
	it("keeps a short question as is", () => {
		expect(deriveConversationTitle("Which products will see demand growth?")).toBe(
			"Which products will see demand growth?",
		);
	});

	it("collapses whitespace and takes the first line only", () => {
		expect(deriveConversationTitle("  Why\tis   storage\ngrowing?\nThird")).toBe("Why is storage");
		expect(deriveConversationTitle("First line\r\nSecond line")).toBe("First line");
	});

	it("keeps exactly 60 characters without an ellipsis", () => {
		const question = "a".repeat(60);
		expect(deriveConversationTitle(question)).toBe(question);
	});

	it("cuts longer titles to 59 characters plus an ellipsis", () => {
		const title = deriveConversationTitle("a".repeat(61));
		expect(title).toBe(`${"a".repeat(59)}…`);
		expect(title !== null && title.length <= CONVERSATION_TITLE_LIMIT).toBe(true);
	});

	it("never splits a surrogate pair at the cut", () => {
		const title = deriveConversationTitle("😀".repeat(100));
		expect(title).toBe(`${"😀".repeat(59)}…`);
		expect(title !== null && Array.from(title).length).toBe(60);
		const mixed = deriveConversationTitle(`${"a".repeat(58)}😀 and more`);
		expect(mixed).toBe(`${"a".repeat(58)}😀…`);
	});

	it("returns null when the first line has no usable text", () => {
		expect(deriveConversationTitle("   \t  ")).toBeNull();
		expect(deriveConversationTitle("\nSecond line")).toBeNull();
		expect(deriveConversationTitle("")).toBeNull();
	});
});

describe("workspace rename (application)", () => {
	it("renames, moves updatedAt, keeps the canvas version, and audits", async () => {
		const time = fixedClock();
		const workspaces = memoryWorkspaces();
		const audit = auditing();
		const services = service(workspaces, stubUnitOfWork("deleted"), audit, time.clock);
		const at = time.clock.nowIso();
		await workspaces.insert(
			OWNER,
			record({ ...emptyWorkspaceState("ws_1"), version: 4 }, "Old", at),
		);

		time.advance(5_000);
		const renamed = await services.rename(OWNER, "ws_1", "New title");
		expect(renamed.ok).toBe(true);
		if (!renamed.ok) return;
		expect(renamed.value.title).toBe("New title");
		expect(renamed.value.version).toBe(4);
		expect(Date.parse(renamed.value.updatedAt)).toBeGreaterThan(Date.parse(at));
		expect(audit.entries).toEqual([
			{
				ownerId: OWNER,
				actor: "owner",
				action: "workspace.rename",
				resource: "ws_1",
				detail: "",
				at: renamed.value.updatedAt,
			},
		]);
	});

	it("renaming to the current title succeeds", async () => {
		const time = fixedClock();
		const workspaces = memoryWorkspaces();
		const services = service(workspaces, stubUnitOfWork("deleted"), auditing(), time.clock);
		const at = time.clock.nowIso();
		await workspaces.insert(OWNER, record(emptyWorkspaceState("ws_1"), "Same", at));
		const renamed = await services.rename(OWNER, "ws_1", "Same");
		expect(renamed.ok).toBe(true);
	});

	it("reports NOT_FOUND for an unknown id without auditing", async () => {
		const time = fixedClock();
		const workspaces = memoryWorkspaces();
		const audit = auditing();
		const services = service(workspaces, stubUnitOfWork("deleted"), audit, time.clock);
		const result = await services.rename(OWNER, "ws_missing", "New title");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("NOT_FOUND");
		expect(audit.entries).toEqual([]);
	});
});

describe("workspace remove (application)", () => {
	it("passes surviving references as keep lists and audits the delete", async () => {
		const time = fixedClock();
		const workspaces = memoryWorkspaces();
		const at = time.clock.nowIso();
		await workspaces.insert(OWNER, record(stateWith("ws_doomed", "doomed-widget"), "Doomed", at));
		await workspaces.insert(OWNER, record(stateWith("ws_kept", "survivor-widget"), "Kept", at));
		const unitOfWork = stubUnitOfWork("deleted");
		const audit = auditing();
		const services = service(workspaces, unitOfWork, audit, time.clock);

		const result = await services.remove(OWNER, "ws_doomed");
		expect(result.ok).toBe(true);
		expect(unitOfWork.seen).toHaveLength(1);
		const input = unitOfWork.seen[0];
		expect(input?.ownerId).toBe(OWNER);
		expect(input?.workspaceId).toBe("ws_doomed");
		// Only the survivor's canvas contributes.
		expect(input?.keepDatasetIds).toEqual(["ds_keep"]);
		expect(input?.keepEvidenceIds).toEqual(["ev_keep"]);
		expect(input?.keepClaimIds).toEqual(["cl_keep"]);
		expect(audit.entries.map((entry) => entry.action)).toEqual(["workspace.remove"]);
	});

	it("maps a missing conversation to NOT_FOUND without auditing", async () => {
		const time = fixedClock();
		const audit = auditing();
		const services = service(memoryWorkspaces(), stubUnitOfWork("not-found"), audit, time.clock);
		const result = await services.remove(OWNER, "ws_missing");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("NOT_FOUND");
		expect(audit.entries).toEqual([]);
	});

	it("refuses a conversation with an unfinished run and tells the owner to stop it first", async () => {
		const time = fixedClock();
		const audit = auditing();
		const services = service(
			memoryWorkspaces(),
			stubUnitOfWork("has-unfinished"),
			audit,
			time.clock,
		);
		const result = await services.remove(OWNER, "ws_busy");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("CONFLICT");
		expect(result.error.message).toContain("Stop the running question first");
		expect(audit.entries).toEqual([]);
	});
});
