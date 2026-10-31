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
		let nowMs = Date.parse("2026-10-31T10:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => nowMs);
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
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
		expect(server.requests("GET", /\/statements\/balance-sheet/)).toHaveLength(2);
		releaseBalance();

		// A view that shows the released read again within the fresh window
		// shows the kept answer without asking (ADR-0049 §3 rule 3)…
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
		expect(reads[1]?.headers["if-none-match"]).toBe('"st-eqc_apple-income-statement-5-1"');
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
