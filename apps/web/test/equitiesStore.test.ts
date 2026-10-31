import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FINANCIAL_FRESH_MS,
	refreshCompanyReads,
	statementEntryFor,
} from "../src/equities/financialStore.ts";
import { APPLE_ID, createEquitiesServer } from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE } from "./fakeBackend.ts";

/** Lets the fake backend answer and the store settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	vi.restoreAllMocks();
});

describe("financial reads after a sync (ADR-0048 §8)", () => {
	it("re-reads only the reads a view shows, leaving a released one for its next view", async () => {
		const server = createEquitiesServer();
		const income = statementEntryFor(server.api, APPLE_ID, "income-statement", 5);
		const releaseIncome = income.attach(ALWAYS_VISIBLE);
		await settle();
		releaseIncome();
		const balance = statementEntryFor(server.api, APPLE_ID, "balance-sheet", 5);
		const releaseBalance = balance.attach(ALWAYS_VISIBLE);
		await settle();
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
		expect(server.requests("GET", /\/statements\/balance-sheet/)).toHaveLength(1);

		refreshCompanyReads(server.api, APPLE_ID);
		await settle();
		// The shown read re-reads now; the released one waits for its next view.
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
		expect(server.requests("GET", /\/statements\/balance-sheet/)).toHaveLength(2);
		releaseBalance();
	});

	it("shows a released read again without asking inside the fresh window, re-reads after it", async () => {
		let nowMs = Date.parse("2026-10-31T10:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
		const server = createEquitiesServer();
		const income = statementEntryFor(server.api, APPLE_ID, "income-statement", 10);
		income.attach(ALWAYS_VISIBLE)();
		await settle();
		// A view that shows it again within the window shows the kept answer (ADR-0049 §3 rule 3)…
		nowMs += FINANCIAL_FRESH_MS - 1;
		const releaseSoon = income.attach(ALWAYS_VISIBLE);
		await settle();
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
		expect(income.value()?.statement).toBe("income-statement");
		releaseSoon();
		// …and after it, re-reads conditionally (with its ETag).
		nowMs += 2;
		const releaseAgain = income.attach(ALWAYS_VISIBLE);
		await settle();
		const reads = server.requests("GET", /\/statements\/income-statement/);
		expect(reads).toHaveLength(2);
		expect(reads[1]?.headers["if-none-match"]).toBe('"st-eqc_apple-income-statement-10-1"');
		releaseAgain();
	});

	it("treats only EQUITY_COMPANY_NOT_FOUND as a missing company", async () => {
		const server = createEquitiesServer({ companies: [] });
		const gone = statementEntryFor(server.api, "eqc_gone", "income-statement", 5);
		const release = gone.attach(ALWAYS_VISIBLE);
		await settle();
		expect(gone.missing()).toBe(true);
		expect(gone.failure()).toBeNull();
		release();
	});
});

describe("a finished sync and the freshness window (ADR-0049 §3, review finding)", () => {
	const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

	it("re-reads a hidden statement on its next showing even inside the window", async () => {
		let nowMs = Date.parse("2026-10-31T10:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
		const server = createEquitiesServer();
		const income = statementEntryFor(server.api, APPLE_ID, "income-statement", 5);
		const release = income.attach(ALWAYS_VISIBLE);
		await settle();
		release(); // the owner switched to another tab
		// The sync finishes with new values; the page tells the store.
		server.revision += 1;
		nowMs += 20_000;
		refreshCompanyReads(server.api, APPLE_ID);
		await settle();
		// No request yet: nothing shows the statement.
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
		// Back to the Financial statements tab, 30 s after its last answer.
		nowMs += 10_000;
		const again = income.attach(ALWAYS_VISIBLE);
		await settle();
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(2);
		again();
	});
});
