import type { JobRecord, Persistence, WorkspaceRecord } from "@research/application";
import type { ChatMessage, Claim, Dataset, Evidence, RunRecords } from "@research/contracts";
import { emptyWorkspaceState, type JobState } from "@research/domain";
import { describe, expect, it } from "vitest";

const AT = "2026-10-11T00:00:00.000Z";
const CHECKSUM = "a".repeat(64);

export interface PersistenceHooks {
	readonly persistence: Persistence;
	/**
	 * Row count in an allowlisted table: transitions and events by run id,
	 * claim edges by claim id.
	 */
	readonly count: (
		table: "job_transitions" | "job_events" | "claim_evidence",
		ownerId: string,
		parentId: string,
	) => Promise<number>;
}

function owner(): string {
	return `owner-${crypto.randomUUID()}@example.test`;
}

function record(workspaceId: string, title: string, version = 0): WorkspaceRecord {
	return {
		summary: { workspaceId, title, version, createdAt: AT, updatedAt: AT },
		state: { ...emptyWorkspaceState(workspaceId), version },
	};
}

function evidence(evidenceId: string): Evidence {
	return {
		evidenceId,
		sourceUrl: "https://news.example.org/articles/one",
		title: "Orders rise",
		publisher: "Example News",
		publishedAt: null,
		retrievedAt: AT,
		effectiveAt: null,
		excerpt: "Orders for grid storage reached 100 GWh in 2026.",
		checksum: CHECKSUM,
		sourceClass: "news",
	};
}

function claim(claimId: string, evidenceId: string | null): Claim {
	return {
		claimId,
		text: "Grid storage orders reached 100 GWh in 2026.",
		claimType: "observation",
		status: "supported",
		links:
			evidenceId === null
				? []
				: [{ evidenceId, relation: "supports", quote: "Orders for grid storage reached 100 GWh" }],
		issues: [],
	};
}

function dataset(datasetId: string, citedEvidenceId: string | null): Dataset {
	return {
		datasetId,
		title: "Demand",
		columns: [{ key: "note", label: "Note", kind: "text" }],
		rows:
			citedEvidenceId === null
				? [{ note: { v: "plain note" } }]
				: [{ note: { v: "orders rose", sourceId: citedEvidenceId } }],
		createdAt: AT,
	};
}

function message(messageId: string, seq: number, text: string): ChatMessage {
	return { messageId, seq, role: "owner", text, runId: null, claimIds: [], createdAt: AT };
}

const EMPTY_RECORDS: RunRecords = {
	evidence: [],
	claims: [],
	scenarios: [],
	securities: [],
	supplierLinks: [],
	financialObservations: [],
	positionObservations: [],
	investorFilings: [],
	pricingPower: [],
};

function job(
	ownerId: string,
	runId: string,
	workspaceId: string | null,
	state: JobState,
): JobRecord {
	return {
		runId,
		ownerId,
		kind: "research",
		state,
		request: null,
		workspaceId,
		usage: {
			agentSteps: 0,
			toolCalls: 0,
			inputBytes: 0,
			knownCostUsd: 0,
			hasUnmeteredUsage: false,
		},
		attempt: 0,
		maxAttempts: 3,
		leaseGeneration: 0,
		leaseOwnerId: null,
		leaseExpiresAt: null,
		lastEventSeq: -1,
		cancelRequested: false,
		failureCode: null,
		failureDetail: null,
		approvalRequest: null,
		retryOfRunId: null,
		contextAnchorSeq: null,
		verificationStatus: null,
		providerModel: null,
		providerSessionRef: null,
		completedGeneration: null,
		provenance: null,
		version: 0,
		createdAt: AT,
		updatedAt: AT,
	};
}

/**
 * Repository behaviour shared by both persistence backends (D1 and
 * node:sqlite run this same suite): rename, guarded enqueue, first-question
 * naming, and atomic conversation deletion with its ownership rule.
 */
export function defineConversationPersistenceSuite(hooks: () => PersistenceHooks): void {
	const persistence = () => hooks().persistence;

	describe("workspace rename (repository)", () => {
		it("updates the title only and reports unknown workspaces as null", async () => {
			const db = persistence().workspaces;
			const id = owner();
			await db.insert(id, record("ws_1", "Old", 3));
			const renamed = await db.rename(id, "ws_1", "New", "2026-10-12T00:00:00.000Z");
			expect(renamed).toMatchObject({ workspaceId: "ws_1", title: "New", version: 3 });
			expect(renamed?.updatedAt).toBe("2026-10-12T00:00:00.000Z");
			expect(await db.rename(id, "ws_missing", "New", "2026-10-12T00:00:00.000Z")).toBeNull();
			expect(
				await db.rename("nobody@example.test", "ws_1", "New", "2026-10-12T00:00:00.000Z"),
			).toBeNull();
		});

		it("lists every record of the owner", async () => {
			const db = persistence().workspaces;
			const id = owner();
			await db.insert(id, record("ws_1", "One"));
			await db.insert(id, record("ws_2", "Two"));
			const records = await db.listRecords(id);
			expect(records.map((entry) => entry.summary.workspaceId).sort()).toEqual(["ws_1", "ws_2"]);
			expect(await persistence().workspaces.listRecords("nobody@example.test")).toEqual([]);
		});
	});

	describe("guarded enqueue (repository)", () => {
		it("refuses a job for a deleted workspace without writing anything", async () => {
			const ports = persistence();
			const id = owner();
			const outcome = await ports.unitOfWork.enqueueResearch({
				job: job(id, "run_ghost", "ws_gone", "pending"),
				idempotencyKey: "key-ghost-1",
				requestFingerprint: "fp",
				ownerMessage: { messageId: "msg_ghost", text: "Hello?" },
				maxUnfinished: 5,
			});
			expect(outcome).toEqual({ kind: "no-workspace" });
			expect(await ports.jobs.get(id, "run_ghost")).toBeNull();
			expect(await ports.chat.list(id, "ws_gone", { beforeSeq: null, limit: 10 })).toEqual([]);
		});

		it("still enqueues when the workspace exists", async () => {
			const ports = persistence();
			const id = owner();
			await ports.workspaces.insert(id, record("ws_1", "New chat"));
			const outcome = await ports.unitOfWork.enqueueResearch({
				job: job(id, "run_1", "ws_1", "pending"),
				idempotencyKey: "key-ok-1",
				requestFingerprint: "fp",
				ownerMessage: { messageId: "msg_1", text: "Hello?" },
				maxUnfinished: 5,
			});
			expect(outcome).toEqual({ kind: "inserted" });
		});
	});

	describe("first-question naming (repository)", () => {
		it("names an untitled, messageless conversation and never renames again", async () => {
			const ports = persistence();
			const id = owner();
			await ports.workspaces.insert(id, record("ws_1", "New chat"));
			await ports.unitOfWork.enqueueResearch({
				job: job(id, "run_1", "ws_1", "pending"),
				idempotencyKey: "key-name-1",
				requestFingerprint: "fp1",
				ownerMessage: { messageId: "msg_1", text: "Why is storage growing?\nMore?" },
				maxUnfinished: 5,
			});
			expect((await ports.workspaces.get(id, "ws_1"))?.summary.title).toBe(
				"Why is storage growing?",
			);
			// A second question leaves the title alone.
			await ports.unitOfWork.enqueueResearch({
				job: job(id, "run_2", "ws_1", "pending"),
				idempotencyKey: "key-name-2",
				requestFingerprint: "fp2",
				ownerMessage: { messageId: "msg_2", text: "Another question?" },
				maxUnfinished: 5,
			});
			expect((await ports.workspaces.get(id, "ws_1"))?.summary.title).toBe(
				"Why is storage growing?",
			);
		});

		it("leaves an owner-named conversation alone", async () => {
			const ports = persistence();
			const id = owner();
			await ports.workspaces.insert(id, record("ws_1", "Mine"));
			await ports.unitOfWork.enqueueResearch({
				job: job(id, "run_1", "ws_1", "pending"),
				idempotencyKey: "key-name-3",
				requestFingerprint: "fp",
				ownerMessage: { messageId: "msg_1", text: "Why is storage growing?" },
				maxUnfinished: 5,
			});
			expect((await ports.workspaces.get(id, "ws_1"))?.summary.title).toBe("Mine");
		});
	});

	describe("conversation deletion (repository)", () => {
		it("reports unknown conversations as not-found", async () => {
			const outcome = await persistence().unitOfWork.deleteWorkspace({
				ownerId: owner(),
				workspaceId: "ws_missing",
				keepEvidenceIds: [],
				keepDatasetIds: [],
				keepClaimIds: [],
			});
			expect(outcome).toBe("not-found");
		});

		it("refuses while a run is unfinished and deletes nothing", async () => {
			const ports = persistence();
			const id = owner();
			await ports.workspaces.insert(id, record("ws_busy", "New chat"));
			await ports.unitOfWork.enqueueResearch({
				job: job(id, "run_busy", "ws_busy", "pending"),
				idempotencyKey: "key-busy-1",
				requestFingerprint: "fp",
				ownerMessage: { messageId: "msg_busy", text: "Work?" },
				maxUnfinished: 5,
			});
			// The first question named the conversation; the run is still pending.
			expect((await ports.workspaces.get(id, "ws_busy"))?.summary.title).toBe("Work?");
			const outcome = await ports.unitOfWork.deleteWorkspace({
				ownerId: id,
				workspaceId: "ws_busy",
				keepEvidenceIds: [],
				keepDatasetIds: [],
				keepClaimIds: [],
			});
			expect(outcome).toBe("has-unfinished");
			expect(await ports.workspaces.get(id, "ws_busy")).not.toBeNull();
			expect(await ports.jobs.get(id, "run_busy")).not.toBeNull();
		});

		it("deletes everything the conversation solely owns, atomically", async () => {
			const ports = persistence();
			const id = owner();
			const runId = "run_doomed";
			await ports.unitOfWork.importWorkspace({
				ownerId: id,
				record: record("ws_doomed", "Doomed"),
				importRunId: "imp_doomed",
				records: {
					...EMPTY_RECORDS,
					evidence: [evidence("ev_doomed")],
					claims: [claim("cl_doomed", "ev_doomed")],
				},
				datasets: [dataset("ds_doomed", null)],
				messages: [message("msg_doomed", 0, "Hello?")],
				at: AT,
			});
			const inserted = await ports.jobs.insert(
				job(id, runId, "ws_doomed", "pending"),
				"key-doomed-1",
				"fp",
				5,
			);
			expect(inserted.kind).toBe("inserted");
			const written = await ports.jobs.write(id, {
				runId,
				expectedVersion: 0,
				patch: { state: "completed" },
				audits: [{ fromState: "pending", toState: "completed", actor: "owner", reason: "test" }],
				at: AT,
			});
			expect(written).toBe(true);

			const outcome = await ports.unitOfWork.deleteWorkspace({
				ownerId: id,
				workspaceId: "ws_doomed",
				keepEvidenceIds: [],
				keepDatasetIds: [],
				keepClaimIds: [],
			});
			expect(outcome).toBe("deleted");

			expect(await ports.workspaces.get(id, "ws_doomed")).toBeNull();
			expect(await ports.workspaces.list(id)).toEqual([]);
			expect(await ports.jobs.get(id, runId)).toBeNull();
			expect(await ports.jobs.list(id, { workspaceId: null, limit: 20 })).toEqual([]);
			expect(await hooks().count("job_transitions", id, runId)).toBe(0);
			expect(await hooks().count("job_events", id, runId)).toBe(0);
			expect(await hooks().count("claim_evidence", id, "cl_doomed")).toBe(0);
			expect(await ports.records.recordsForRuns(id, ["imp_doomed", runId])).toMatchObject({
				evidence: [],
				claims: [],
				scenarios: [],
			});
			expect(await ports.records.datasetsForWorkspace(id, "ws_doomed")).toEqual([]);
			expect(await ports.records.runIdsForWorkspace(id, "ws_doomed")).toEqual([]);
			expect(await ports.chat.list(id, "ws_doomed", { beforeSeq: null, limit: 10 })).toEqual([]);
			expect(await ports.chat.listConversations(id, 200)).toEqual([]);
		});

		it("keeps borrowed datasets, evidence and claims", async () => {
			const ports = persistence();
			const id = owner();
			await ports.unitOfWork.importWorkspace({
				ownerId: id,
				record: record("ws_lender", "Lender"),
				importRunId: "imp_lender",
				records: {
					...EMPTY_RECORDS,
					evidence: [evidence("ev_shared")],
					claims: [claim("cl_shared", "ev_shared")],
				},
				datasets: [dataset("ds_shared", null)],
				messages: [message("msg_lender", 0, "Hello?")],
				at: AT,
			});
			// A surviving conversation's dataset cites the lender's evidence.
			await ports.unitOfWork.importWorkspace({
				ownerId: id,
				record: record("ws_kept", "Kept"),
				importRunId: "imp_kept",
				records: { ...EMPTY_RECORDS, evidence: [evidence("ev_kept")] },
				datasets: [dataset("ds_kept", "ev_shared")],
				messages: [message("msg_kept", 0, "Hi.")],
				at: AT,
			});

			const outcome = await ports.unitOfWork.deleteWorkspace({
				ownerId: id,
				workspaceId: "ws_lender",
				keepEvidenceIds: [],
				keepDatasetIds: ["ds_shared"],
				keepClaimIds: ["cl_shared"],
			});
			expect(outcome).toBe("deleted");

			// The kept dataset and claim survive, and the kept claim's edge
			// keeps its evidence alive with it. (The kept dataset row still
			// carries its original workspace id; it resolves by id for the
			// surviving conversation.)
			expect(
				(await ports.records.datasetsForWorkspace(id, "ws_lender")).map((entry) => entry.datasetId),
			).toEqual(["ds_shared"]);
			const kept = await ports.records.resolve(id, {
				datasetIds: ["ds_shared"],
				evidenceIds: ["ev_shared"],
				claimIds: ["cl_shared"],
			});
			expect(kept.datasets.map((entry) => entry.datasetId)).toEqual(["ds_shared"]);
			expect(kept.claims.map((entry) => entry.claimId)).toEqual(["cl_shared"]);
			expect(kept.evidence.map((entry) => entry.evidenceId)).toEqual(["ev_shared"]);
			// The surviving dataset's citation also protects the evidence on
			// its own: drop the claim keep and the evidence still survives.
			expect(await hooks().count("claim_evidence", id, "cl_shared")).toBe(1);
		});

		it("drops evidence no survivor cites, even when its claim is kept elsewhere", async () => {
			const ports = persistence();
			const id = owner();
			await ports.unitOfWork.importWorkspace({
				ownerId: id,
				record: record("ws_lender", "Lender"),
				importRunId: "imp_lender",
				records: {
					...EMPTY_RECORDS,
					evidence: [evidence("ev_gone"), evidence("ev_cited")],
					claims: [claim("cl_gone", "ev_gone")],
				},
				datasets: [],
				messages: [],
				at: AT,
			});
			await ports.unitOfWork.importWorkspace({
				ownerId: id,
				record: record("ws_kept", "Kept"),
				importRunId: "imp_kept",
				records: { ...EMPTY_RECORDS, evidence: [evidence("ev_kept")] },
				datasets: [dataset("ds_kept", "ev_cited")],
				messages: [],
				at: AT,
			});
			const outcome = await ports.unitOfWork.deleteWorkspace({
				ownerId: id,
				workspaceId: "ws_lender",
				keepEvidenceIds: [],
				keepDatasetIds: [],
				keepClaimIds: [],
			});
			expect(outcome).toBe("deleted");
			const remaining = await ports.records.resolve(id, {
				datasetIds: [],
				evidenceIds: ["ev_gone", "ev_cited", "ev_kept"],
				claimIds: [],
			});
			// Cited by the surviving dataset: stays. Cited by nothing: goes.
			expect(remaining.evidence.map((entry) => entry.evidenceId).sort()).toEqual([
				"ev_cited",
				"ev_kept",
			]);
		});
	});
}
