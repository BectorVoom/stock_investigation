import { describe, expect, it } from "vitest";
import { equitiesMessages } from "../src/equities/equities.messages.ts";
import {
	companiesPollSignal,
	formatFiscalYearEnd,
	relativeTime,
	syncFailureText,
	syncStatusText,
} from "../src/equities/equitiesModel.ts";
import {
	formatExactAmount,
	formatMillions,
	formatPeriodEnd,
	MINUS_SIGN,
	millionsForChart,
	roundedMillions,
} from "../src/equities/financialFormat.ts";
import {
	sharedCurrency,
	statementTableModel,
	yearColumnClass,
} from "../src/equities/statementModel.ts";
import { appleStatement, makeCompany, NINTENDO } from "./equitiesHarness.ts";

describe("amounts in whole millions from exact decimal text (ADR-0048 §8)", () => {
	it("rounds half away from zero on the digits", () => {
		expect(roundedMillions("391035000000")).toBe("391035");
		expect(roundedMillions("391035499999")).toBe("391035");
		expect(roundedMillions("391035500000")).toBe("391036");
		expect(roundedMillions("-391035500000")).toBe("-391036");
		expect(roundedMillions("-391035499999.99")).toBe("-391035");
		expect(roundedMillions("499999.9")).toBe("0");
		expect(roundedMillions("500000")).toBe("1");
		expect(roundedMillions("-500000")).toBe("-1");
		expect(roundedMillions("999999.5")).toBe("1");
		expect(roundedMillions("9999500000")).toBe("10000");
		expect(roundedMillions("0")).toBe("0");
		expect(roundedMillions("12.5")).toBe("0");
	});

	it("never signs a zero", () => {
		expect(roundedMillions("-400000")).toBe("0");
		expect(formatMillions("-1")).toBe("0");
	});

	it("keeps every digit of an amount beyond 2^53", () => {
		// 2^53 is 9,007,199,254,740,992; Number would lose the last digits here.
		expect(roundedMillions("123456789012345678901234567")).toBe("123456789012345678901");
		expect(formatMillions("123456789012345678901234567")).toBe("123,456,789,012,345,678,901");
	});

	it("groups thousands and writes a negative with the minus sign", () => {
		expect(formatMillions("391035000000")).toBe("391,035");
		expect(formatMillions("-22354000000")).toBe(`${MINUS_SIGN}22,354`);
		expect(formatMillions("1000000")).toBe("1");
		expect(formatMillions("999000000")).toBe("999");
		expect(formatMillions("1000000000")).toBe("1,000");
	});

	it("refuses text that is not canonical decimal (shown as unavailable, never 0)", () => {
		for (const bad of ["", "1e9", "01", "-0", "1.50", "abc", "1,000", " 1"]) {
			expect(roundedMillions(bad)).toBeNull();
			expect(formatMillions(bad)).toBeNull();
			expect(millionsForChart(bad)).toBeNull();
		}
	});

	it("gives the chart the same rounded millions as a number", () => {
		expect(millionsForChart("391035500000")).toBe(391036);
		expect(millionsForChart("-4289000000")).toBe(-4289);
	});

	it("shows the exact base-unit amount, fraction kept", () => {
		expect(formatExactAmount("391035000000")).toBe("391,035,000,000");
		expect(formatExactAmount("-1234.5")).toBe(`${MINUS_SIGN}1,234.5`);
		expect(formatExactAmount("0.25")).toBe("0.25");
		expect(formatExactAmount("1e3")).toBeNull();
	});
});

describe("dates and statuses in words", () => {
	it("writes a period end in each language without a time zone", () => {
		expect(formatPeriodEnd("2025-03-31", "en")).toBe("Mar 31, 2025");
		expect(formatPeriodEnd("2025-03-31", "ja")).toBe("2025年3月31日");
		expect(formatPeriodEnd("2024-09-28", "en")).toBe("Sep 28, 2024");
		expect(formatPeriodEnd("not a date", "en")).toBe("not a date");
	});

	it("writes a fiscal year end", () => {
		expect(formatFiscalYearEnd("09-28", "en")).toBe("Sep 28");
		expect(formatFiscalYearEnd("03-31", "ja")).toBe("3月31日");
		expect(formatFiscalYearEnd("13-01", "en")).toBe("13-01");
	});

	it("says how long ago, in the UI language", () => {
		const now = Date.parse("2026-10-31T10:00:00Z");
		expect(relativeTime("2026-10-31T08:00:00Z", now, "en")).toBe("2 hours ago");
		expect(relativeTime("2026-10-31T09:55:00Z", now, "en")).toBe("5 minutes ago");
		expect(relativeTime("2026-10-31T09:59:30Z", now, "en")).toBe("now");
		expect(relativeTime("2026-10-31T08:00:00Z", now, "ja")).toBe("2 時間前");
	});

	it("states a sync's status, phase and last success, and a failure with what to do", () => {
		const now = Date.parse("2026-10-31T10:00:00Z");
		const en = equitiesMessages.en;
		expect(syncStatusText(makeCompany(), now, "en", en)).toBe("Synced · Last synced 2 hours ago");
		expect(syncFailureText(makeCompany(), en)).toBeNull();
		const nintendo = NINTENDO();
		expect(syncStatusText(nintendo, now, "en", en)).toBe("Sync failed · checked 1 hour ago");
		expect(syncFailureText(nintendo, en)).toBe(
			"Not configured: set EDINET_API_KEY in apps/runner/.env, then restart the runner.",
		);
		const limited = makeCompany({
			sync: {
				...makeCompany().sync,
				status: "failed",
				failure: {
					code: "FINANCIAL_RATE_LIMITED",
					upstreamStatus: 429,
					at: "2026-10-31T09:00:00Z",
				},
			},
		});
		expect(syncFailureText(limited, en)).toBe(
			"The source limited requests; the sync is tried again later. The source answered HTTP 429.",
		);
		const unconfiguredSec = makeCompany({
			sync: {
				...makeCompany().sync,
				status: "failed",
				failure: {
					code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
					upstreamStatus: null,
					at: "2026-10-31T09:00:00Z",
				},
			},
		});
		expect(syncFailureText(unconfiguredSec, en)).toContain("SEC_USER_AGENT");
		expect(syncFailureText(nintendo, equitiesMessages.ja)).toContain("EDINET_API_KEY");
	});

	it("polls fast only while a sync runs or waits", () => {
		const queued = makeCompany({ sync: { ...makeCompany().sync, status: "queued" } });
		const running = makeCompany({ sync: { ...makeCompany().sync, status: "running" } });
		expect(companiesPollSignal([makeCompany(), NINTENDO()])).toBeNull();
		expect(companiesPollSignal([makeCompany(), queued])).toBe("queued");
		expect(companiesPollSignal([queued, running])).toBe("active");
	});
});

describe("statement table model", () => {
	it("lays fiscal years oldest to newest with their period ends and one currency", () => {
		const model = statementTableModel(appleStatement("income-statement"));
		expect(model.columns.map((column) => column.fiscalYear)).toEqual([
			2020, 2021, 2022, 2023, 2024,
		]);
		expect(model.columns.at(-1)?.periodEnd).toBe("2024-09-28");
		expect(model.newestPeriodEnd).toBe("2024-09-28");
		expect(model.currency).toBe("USD");
		expect(model.rows.map((row) => row.metric)).toEqual([
			"revenue",
			"gross-profit",
			"operating-income",
			"ordinary-income",
			"profit-attributable-to-owners",
		]);
		expect(model.anyRevised).toBe(true);
		expect(model.anyDerived).toBe(false);
		expect(statementTableModel(appleStatement("cash-flow")).anyDerived).toBe(true);
	});

	it("names no shared currency when values differ", () => {
		expect(sharedCurrency([])).toBe("");
		expect(sharedCurrency([withCurrency("USD"), withCurrency(null), null])).toBe("USD");
		expect(sharedCurrency([withCurrency("USD"), withCurrency("JPY")])).toBeNull();
	});

	it("keeps the newest years on a narrow frame", () => {
		expect(yearColumnClass(4, 5)).toBe("");
		expect(yearColumnClass(3, 5)).toBe("");
		expect(yearColumnClass(2, 5)).toBe("hidden @md:table-cell");
		expect(yearColumnClass(1, 5)).toBe("hidden @md:table-cell");
		expect(yearColumnClass(0, 5)).toBe("hidden @2xl:table-cell");
		expect(yearColumnClass(0, 10)).toContain("@6xl");
		expect(yearColumnClass(0, 15)).toContain("@6xl");
	});
});

/** A fixture cell with another currency: only the currency matters to the check. */
function withCurrency(currency: string | null) {
	const base = appleStatement("income-statement").rows[0]?.cells[0];
	if (base === undefined) throw new Error("fixture has no cell");
	return { ...base, currency };
}
