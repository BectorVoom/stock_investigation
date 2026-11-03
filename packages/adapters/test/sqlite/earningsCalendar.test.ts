import { fileURLToPath } from "node:url";
import type { EarningsCalendarEvent } from "@research/contracts";
import { describe, expect, it } from "vitest";
import type { SqlDatabase } from "../../src/sql/database.ts";
import {
	createEarningsCalendarRepository,
	earningsCalendarStatements,
} from "../../src/sql/earningsCalendar.ts";
import {
	applySqlMigrations,
	initializeSqlSchema,
	openNodeSqlite,
	readSqlMigrations,
	readSqlSchema,
} from "../../src/sqlite/index.ts";

/**
 * The stored earnings calendars (ADR-0068) on real SQLite, migrated and
 * built from `db/schema.sql`: a completion replaces one market's rows,
 * keeping only the owner's stock-list symbols, all or nothing on its guard;
 * the Stocks page reads one stock's rows from today, soonest first.
 */
const MIGRATIONS = fileURLToPath(new URL("../../../../infra/migrations", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../../../../db/schema.sql", import.meta.url));

const OWNER = "owner_1";
const OTHER = "owner_2";
const ALWAYS = { sql: "1 = 1", values: [] };
const NEVER = { sql: "1 = 0", values: [] };

function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(db, readSqlMigrations(MIGRATIONS));
	return db;
}

function openFromSchema() {
	const db = openNodeSqlite(":memory:");
	initializeSqlSchema(db, readSqlSchema(SCHEMA), readSqlMigrations(MIGRATIONS));
	return db;
}

async function list(db: SqlDatabase, owner: string, market: "US" | "JP", symbols: string[]) {
	for (const symbol of symbols) {
		await db
			.prepare(
				`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
					symbol_key, name_key, local_name_key, search_key)
				VALUES (?, ?, ?, ?, NULL, ?, ?, 'n', 'l', 's')`,
			)
			.bind(owner, market, symbol, symbol, market === "US" ? "nyse" : "tse-prime", symbol)
			.run();
	}
}

function event(
	symbol: string,
	periodKey: string,
	announcementDate: string | null,
): EarningsCalendarEvent {
	return {
		symbol,
		periodKey,
		announcementDate,
		fiscalPeriodLabel: periodKey.toUpperCase(),
		fiscalPeriodEnd: null,
		timing: "unknown",
	};
}

function store(
	db: SqlDatabase,
	owner: string,
	market: "US" | "JP",
	events: EarningsCalendarEvent[],
	guard = ALWAYS,
	syncedAt = "2026-11-03T01:00:00.000Z",
) {
	return db.batch(
		earningsCalendarStatements(
			db,
			owner,
			{
				market,
				fromDate: "2026-11-03",
				toDate: "2027-05-07",
				syncedAt,
				events,
				truncatedDates: market === "US" ? ["2026-11-05"] : [],
			},
			guard,
		),
	);
}

describe.each([
	["migrated", openMigrated],
	["built from db/schema.sql", openFromSchema],
])("earnings calendars on a %s database (ADR-0068)", (_label, open) => {
	it("stores a market's stock-list stocks only, and reads one stock from today", async () => {
		const db = open();
		try {
			const calendars = createEarningsCalendarRepository(db);
			expect(await calendars.marketState(OWNER, "US")).toBeNull();
			expect(await calendars.stockEvents(OWNER, "US", "KO", "2026-11-03", 8)).toBeNull();
			await list(db, OWNER, "US", ["KO", "BH-A"]);
			await store(db, OWNER, "US", [
				event("KO", "2027-q1", "2027-02-10"),
				event("KO", "2026-q4", "2026-11-05"),
				event("KO", "2026-q3", "2026-10-21"),
				event("KO", "2027-q2", null),
				event("BH-A", "2026-q3", "2026-11-04"),
				// Not in the owner's stock list: never stored.
				event("ZZZZ", "2026-q3", "2026-11-04"),
			]);
			expect(await calendars.marketState(OWNER, "US")).toEqual({
				syncedAt: "2026-11-03T01:00:00.000Z",
				fromDate: "2026-11-03",
				toDate: "2027-05-07",
			});
			const ko = await calendars.stockEvents(OWNER, "US", "KO", "2026-11-03", 8);
			// From today, dated soonest first, then undecided.
			expect(ko?.events.map((row) => row.periodKey)).toEqual(["2026-q4", "2027-q1", "2027-q2"]);
			expect(ko?.events[0]).toEqual({
				periodKey: "2026-q4",
				announcementDate: "2026-11-05",
				fiscalPeriodLabel: "2026-Q4",
				fiscalPeriodEnd: null,
				timing: "unknown",
			});
			expect(
				(await calendars.stockEvents(OWNER, "US", "KO", "2026-11-03", 1))?.events,
			).toHaveLength(1);
			// A listed stock with no rows: the calendar is stored, the list empty.
			expect(await calendars.stockEvents(OWNER, "US", "ZZZZ", "2026-11-03", 8)).toEqual({
				syncedAt: "2026-11-03T01:00:00.000Z",
				events: [],
			});
			const count = await db
				.prepare(
					"SELECT count(*) AS n, max(truncated_dates) AS t FROM stock_earnings_calendar_market",
				)
				.first();
			expect(count).toEqual({ n: 1, t: '["2026-11-05"]' });
			// Another owner and the other market see nothing of it.
			expect(await calendars.marketState(OTHER, "US")).toBeNull();
			expect(await calendars.marketState(OWNER, "JP")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("replaces only the synced market's rows, and nothing when the guard fails", async () => {
		const db = open();
		try {
			const calendars = createEarningsCalendarRepository(db);
			await list(db, OWNER, "US", ["KO"]);
			await list(db, OWNER, "JP", ["1380"]);
			await store(db, OWNER, "US", [event("KO", "2026-q4", "2026-11-05")]);
			await store(db, OWNER, "JP", [event("1380", "fy2027-q2", "2026-11-13")]);
			await store(
				db,
				OWNER,
				"US",
				[event("KO", "2027-q1", "2027-02-10")],
				ALWAYS,
				"2026-11-04T01:00:00.000Z",
			);
			expect(
				(await calendars.stockEvents(OWNER, "US", "KO", "2026-11-03", 8))?.events.map(
					(row) => row.periodKey,
				),
			).toEqual(["2027-q1"]);
			expect(
				(await calendars.stockEvents(OWNER, "JP", "1380", "2026-11-03", 8))?.events,
			).toHaveLength(1);
			// A lost compare-and-set changes nothing.
			await store(db, OWNER, "US", [], NEVER, "2026-11-05T01:00:00.000Z");
			expect((await calendars.marketState(OWNER, "US"))?.syncedAt).toBe("2026-11-04T01:00:00.000Z");
			expect(
				(await calendars.stockEvents(OWNER, "US", "KO", "2026-11-03", 8))?.events,
			).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});
