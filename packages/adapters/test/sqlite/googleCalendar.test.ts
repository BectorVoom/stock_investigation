/**
 * Google Calendar link repository (FR-019 section 2.5): migration-0008
 * table, connect/auth-url/apply semantics and the guarded completion
 * statements, pinned against the real migrations on `node:sqlite`; D1 runs
 * the same SQL text through the API suite.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createGoogleCalendarRepository,
	googleLinkStatements,
	JOB_GUARD_SQL,
} from "../../src/sql/repositories.ts";
import { createResearchUnitOfWork } from "../../src/sql/unitOfWork.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

const AT = "2026-10-13T00:00:00.000Z";

describe("google calendar link repository (FR-019)", () => {
	it("starts disconnected (no row)", async () => {
		const db = openMigrated();
		try {
			expect(await createGoogleCalendarRepository(db).get("owner_1")).toBe(null);
		} finally {
			db.close();
		}
	});

	it("connect remembers the previous status and clears the pending URL", async () => {
		const db = openMigrated();
		try {
			const repository = createGoogleCalendarRepository(db);
			await repository.setConnecting("owner_1", { connectFrom: "disconnected", at: AT });
			expect(await repository.get("owner_1")).toMatchObject({
				status: "connecting",
				connectFrom: "disconnected",
				pendingAuthUrl: null,
			});
			await repository.setPendingAuthUrl(
				"owner_1",
				"https://accounts.google.com/o/oauth2/v2/auth?x",
				AT,
			);
			// A second connect keeps the remembered status honest: it
			// records the CURRENT status (connecting is overwritten, but a
			// failed connect still restores through the completion patch).
			await repository.setConnecting("owner_1", { connectFrom: "needs-reconnect", at: AT });
			expect(await repository.get("owner_1")).toMatchObject({
				status: "connecting",
				connectFrom: "needs-reconnect",
				pendingAuthUrl: null,
			});
		} finally {
			db.close();
		}
	});

	it("stores the sign-in URL only while connecting", async () => {
		const db = openMigrated();
		try {
			const repository = createGoogleCalendarRepository(db);
			const url = "https://accounts.google.com/o/oauth2/v2/auth?state=abc";
			// No row yet: dropped, never stored.
			await repository.setPendingAuthUrl("owner_1", url, AT);
			expect(await repository.get("owner_1")).toBe(null);
			await repository.setConnecting("owner_1", { connectFrom: "disconnected", at: AT });
			await repository.setPendingAuthUrl("owner_1", url, AT);
			expect(await repository.get("owner_1")).toMatchObject({ pendingAuthUrl: url });
			// Connected: a stale runner message is dropped, never stored.
			await repository.apply("owner_1", { status: "connected", calendarId: "cal_1" }, AT);
			await repository.setPendingAuthUrl(
				"owner_1",
				"https://accounts.google.com/o/oauth2/v2/auth?stale",
				AT,
			);
			expect(await repository.get("owner_1")).toMatchObject({ pendingAuthUrl: url });
		} finally {
			db.close();
		}
	});

	it("applies completion patches, clearing with explicit null", async () => {
		const db = openMigrated();
		try {
			const repository = createGoogleCalendarRepository(db);
			await repository.setConnecting("owner_1", { connectFrom: "disconnected", at: AT });
			await repository.apply(
				"owner_1",
				{
					status: "connected",
					connectFrom: null,
					pendingAuthUrl: null,
					calendarId: "cal_1",
					connectedAt: AT,
					syncedDigest: null,
					lastSync: null,
					lastFailureCode: null,
					lastFailureAt: null,
				},
				AT,
			);
			expect(await repository.get("owner_1")).toMatchObject({
				status: "connected",
				connectFrom: null,
				pendingAuthUrl: null,
				calendarId: "cal_1",
				connectedAt: AT,
				syncedDigest: null,
				lastSync: null,
			});
			await repository.apply(
				"owner_1",
				{
					lastSyncedAt: AT,
					syncedDigest: "d".repeat(64),
					lastSync: { inserted: 3, updated: 0, deleted: 1, unchanged: 2 },
				},
				AT,
			);
			expect(await repository.get("owner_1")).toMatchObject({
				status: "connected",
				calendarId: "cal_1",
				lastSyncedAt: AT,
				syncedDigest: "d".repeat(64),
				lastSync: { inserted: 3, updated: 0, deleted: 1, unchanged: 2 },
			});
		} finally {
			db.close();
		}
	});

	it("isolates owners", async () => {
		const db = openMigrated();
		try {
			const repository = createGoogleCalendarRepository(db);
			await repository.setConnecting("owner_1", { connectFrom: "disconnected", at: AT });
			expect(await repository.get("owner_2")).toBe(null);
		} finally {
			db.close();
		}
	});

	it("commits the link patch atomically with the job completion", async () => {
		const db = openMigrated();
		try {
			const repository = createGoogleCalendarRepository(db);
			await repository.setConnecting("owner_1", { connectFrom: "disconnected", at: AT });
			// One job row so the completion guard passes.
			await db
				.prepare(
					`INSERT INTO research_jobs
						(owner_id, run_id, kind, state, idempotency_key, request_fingerprint,
						request_json, workspace_id, usage_json, attempt, max_attempts, lease_generation,
						lease_owner_id, lease_expires_at, last_event_seq, cancel_requested, failure_code,
						approval_request_json, retry_of_run_id, verification_status, provider_model,
						provider_session_ref, completed_generation, provenance_json, version,
						last_mutation_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					"owner_1",
					"run_1",
					"google-calendar",
					"publishing",
					"key-1",
					"google-calendar:connect",
					'{"action":"connect"}',
					null,
					"{}",
					1,
					3,
					2,
					null,
					null,
					-1,
					0,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					null,
					0,
					"mutation-0",
					"2026-10-13T00:00:00.000Z",
					"2026-10-13T00:00:00.000Z",
				)
				.run();
			const unitOfWork = createResearchUnitOfWork(db);
			const committed = await unitOfWork.commitCompletion(
				"owner_1",
				{
					runId: "run_1",
					expectedVersion: 0,
					patch: { state: "completed" },
					audits: [],
					at: "2026-10-13T01:00:00.000Z",
				},
				{
					bundle: null,
					articles: [],
					sourceReports: [],
					workspace: null,
					assistantMessage: null,
					marketSeries: [],
					notebook: null,
					notebookTurn: null,
					google: {
						status: "connected",
						connectFrom: null,
						pendingAuthUrl: null,
						calendarId: "cal_9",
						connectedAt: "2026-10-13T01:00:00.000Z",
						syncedDigest: null,
						lastSync: null,
						lastFailureCode: null,
						lastFailureAt: null,
					},
					earnings: [],
				},
			);
			expect(committed.kind).toBe("committed");
			expect(await repository.get("owner_1")).toMatchObject({
				status: "connected",
				connectFrom: null,
				pendingAuthUrl: null,
				calendarId: "cal_9",
				connectedAt: "2026-10-13T01:00:00.000Z",
			});
		} finally {
			db.close();
		}
	});

	it("builds a guarded UPDATE for a completion patch", async () => {
		const db = openMigrated();
		try {
			const statements = googleLinkStatements(
				db,
				"owner_1",
				{ status: "connected", calendarId: "cal_1" },
				AT,
				{ sql: JOB_GUARD_SQL, values: ["owner_1", "run_1", "mutation-0"] },
			);
			expect(statements).toHaveLength(1);
			expect(
				googleLinkStatements(db, "owner_1", {}, AT, { sql: JOB_GUARD_SQL, values: [] }),
			).toEqual([]);
		} finally {
			db.close();
		}
	});
});
