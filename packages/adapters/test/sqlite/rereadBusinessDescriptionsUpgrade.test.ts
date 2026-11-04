/**
 * Migration 0033 (ADR-0053 §3a) on a populated version-32 database: every
 * `not-found` 10-K or 20-F description is deleted and its company's
 * scheduled sync is due now, so the fixed reader reads the report again;
 * an `extracted` description, a 40-F's `not-found` (never downloaded) and
 * the schedule of every other company stay, and a second run changes
 * nothing.
 */
import { fileURLToPath } from "node:url";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "@research/adapters/sqlite";
import { expect, it } from "vitest";

const MIGRATION = "0033_reread_business_descriptions.sql";
const LATER = "2026-12-01T00:00:00.000Z";
const EARLIER = "2026-01-01T00:00:00.000Z";

it("deletes the 10-K and 20-F descriptions not found and makes their companies due", async () => {
	const db = openNodeSqlite(":memory:");
	try {
		const migrations = readSqlMigrations(
			fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
		);
		const before = migrations.filter((migration) => migration.name < MIGRATION);
		expect(before.at(-1)?.name).toBe("0032_stock_earnings_calendar.sql");
		applySqlMigrations(db, before);
		const run = (sql: string) => db.prepare(sql).run();
		// company, symbol, form, status, next_due_at
		const companies = [
			["eqc_eog", "EOG", "10-K", "not-found", LATER],
			["eqc_wbx", "WBX", "20-F", "not-found", LATER],
			["eqc_late", "CCBG", "10-K", "not-found", EARLIER],
			["eqc_unscheduled", "FCX", "10-K", "not-found", null],
			["eqc_ego", "EGO", "40-F", "not-found", LATER],
			["eqc_aapl", "AAPL", "10-K", "extracted", LATER],
		] as const;
		for (const [companyId, symbol, form, status, nextDueAt] of companies) {
			await run(
				`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, tracked, tracked_at)
				VALUES ('owner', '${companyId}', 'US', '${symbol}', 'sec', 1, '2026-11-01T00:00:00.000Z')`,
			);
			await run(
				`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
				VALUES ('owner', '${companyId}', ${nextDueAt === null ? "NULL" : `'${nextDueAt}'`})`,
			);
			await run(
				`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
					filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
				VALUES ('owner', '${companyId}', '0000000001-26-000001', '${form}', '2026-02-24',
					'2025-12-31', 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/a.htm',
					'${status}', '${status === "extracted" ? '[{"kind":"text","text":"We make phones."}]' : "[]"}',
					0, '2026-11-02T00:00:00.000Z')`,
			);
		}
		const read = async () => ({
			described: (
				await db
					.prepare("SELECT company_id, status FROM equity_business_description ORDER BY company_id")
					.all()
			).results,
			due: (
				await db
					.prepare("SELECT company_id, next_due_at FROM equity_sync_state ORDER BY company_id")
					.all()
			).results,
		});

		const startedAt = new Date().toISOString();
		applySqlMigrations(db, migrations);
		const after = await read();
		expect(after.described).toEqual([
			{ company_id: "eqc_aapl", status: "extracted" },
			{ company_id: "eqc_ego", status: "not-found" },
		]);
		const due = new Map(after.due.map((row) => [row.company_id, row.next_due_at]));
		for (const companyId of ["eqc_eog", "eqc_wbx"]) {
			const nextDueAt = String(due.get(companyId));
			expect(nextDueAt >= startedAt && nextDueAt < LATER).toBe(true);
		}
		// Never later, an unscheduled sync not started, the others untouched.
		expect(due.get("eqc_late")).toBe(EARLIER);
		expect(due.get("eqc_unscheduled")).toBeNull();
		expect(due.get("eqc_ego")).toBe(LATER);
		expect(due.get("eqc_aapl")).toBe(LATER);

		// A second run is a no-op (the runner records 0033 as applied).
		applySqlMigrations(db, migrations);
		expect(await read()).toEqual(after);
	} finally {
		db.close();
	}
});
