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
	chartScaleExponent,
	formatExactAmount,
	formatMillions,
	formatPeriodEnd,
	MINUS_SIGN,
	roundedMillions,
	scaledForChart,
	UNDER_ONE_MILLION,
} from "../src/equities/financialFormat.ts";
import {
	isMarkedSeparate,
	sharedCurrency,
	showsUnderOne,
	statementTableModel,
	valuesScope,
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
		expect(formatMillions("0")).toBe("0");
	});

	it("shows a non-zero amount under half a million as <1, never as a reported 0", () => {
		expect(UNDER_ONE_MILLION).toBe("<1");
		expect(formatMillions("499999.99")).toBe("<1");
		expect(formatMillions("1")).toBe("<1");
		expect(formatMillions("0.5")).toBe("<1");
		expect(formatMillions("-1")).toBe(`${MINUS_SIGN}<1`);
		expect(formatMillions("-499999")).toBe(`${MINUS_SIGN}<1`);
		// Half a million rounds to one; zero stays zero.
		expect(formatMillions("500000")).toBe("1");
		expect(formatMillions("-500000")).toBe(`${MINUS_SIGN}1`);
		expect(formatMillions("0")).toBe("0");
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
			expect(scaledForChart(bad, 6)).toBeNull();
		}
	});

	it("moves the point on the digits for the chart, without rounding twice", () => {
		expect(scaledForChart("391035500000", 6)).toBe(391035.5);
		expect(scaledForChart("391035000000", 9)).toBe(391.035);
		expect(scaledForChart("-4289000000", 6)).toBe(-4289);
		expect(scaledForChart("1164922000000", 8)).toBe(11649.22);
		expect(scaledForChart("400000", 6)).toBe(0.4);
		expect(scaledForChart("-0.5", 6)).toBe(-0.0000005);
		expect(scaledForChart("0", 9)).toBe(0);
		expect(Object.is(scaledForChart("0", 9), -0)).toBe(false);
		// Far beyond 2^53 in base units: the shifted text parses to the nearest double.
		expect(scaledForChart("123456789012345678901234567", 12)).toBe(
			Number("123456789012345.678901234567"),
		);
	});

	it("picks one chart scale per series so the largest value stays under 100,000 units", () => {
		// Apple's revenue: USD billions in English, 億 in Japanese.
		const apple = ["274515000000", "391035000000", "-4289000000"];
		expect(chartScaleExponent(apple, "en")).toBe(9);
		expect(chartScaleExponent(apple, "ja")).toBe(8);
		// Nintendo's revenue (1.16 trillion yen): JPY billions, 億円.
		expect(chartScaleExponent(["1164922000000"], "en")).toBe(9);
		expect(chartScaleExponent(["1164922000000"], "ja")).toBe(8);
		// Small amounts stay in millions; 99,999 million is the last millions value.
		expect(chartScaleExponent(["99999000000", "12.5"], "en")).toBe(6);
		expect(chartScaleExponent(["100000000000"], "en")).toBe(9);
		// Toyota-sized (45 trillion yen) goes to 兆 in Japanese.
		expect(chartScaleExponent(["45095325000000"], "ja")).toBe(12);
		expect(chartScaleExponent(["45095325000000"], "en")).toBe(9);
		// No values, or none canonical: millions.
		expect(chartScaleExponent([], "en")).toBe(6);
		expect(chartScaleExponent(["1e15"], "ja")).toBe(6);
		// Beyond every scale: the largest.
		expect(chartScaleExponent(["1".padEnd(30, "0")], "en")).toBe(12);
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
		// The API's own failure when a completion names an issuer another tracked company has.
		const conflict = makeCompany({
			sync: {
				...makeCompany().sync,
				status: "failed",
				failure: {
					code: "FINANCIAL_IDENTITY_CONFLICT",
					upstreamStatus: null,
					at: "2026-10-31T09:00:00Z",
				},
			},
		});
		expect(syncFailureText(conflict, en)).toBe(
			"Another tracked company is the same issuer at the source (for example GOOGL and GOOG). Stop tracking one of them.",
		);
		expect(syncFailureText(conflict, equitiesMessages.ja)).toBe(
			"追跡中の別の企業が取得元で同じ発行体です（例: GOOGL と GOOG）。どちらかの追跡を停止してください。",
		);
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

	it("tells a separate-only row from a mixed one, marking only a mixed row's separate values", () => {
		const consolidated = withScope("consolidated");
		const separate = withScope("separate");
		expect(valuesScope([])).toBeNull();
		expect(valuesScope([consolidated, null])).toBe("consolidated");
		expect(valuesScope([separate, separate])).toBe("separate");
		expect(valuesScope([consolidated, separate])).toBe("mixed");
		// A missing value has no scope and does not mix a row.
		expect(valuesScope([separate, { ...separate, valueDecimal: null, scope: null }])).toBe(
			"separate",
		);
		expect(isMarkedSeparate(separate, "mixed")).toBe(true);
		expect(isMarkedSeparate(consolidated, "mixed")).toBe(false);
		expect(isMarkedSeparate(separate, "separate")).toBe(false);
	});

	it("knows which values show <1", () => {
		expect(showsUnderOne({ ...withScope("consolidated"), valueDecimal: "400000" })).toBe(true);
		expect(showsUnderOne({ ...withScope("consolidated"), valueDecimal: "-1" })).toBe(true);
		expect(showsUnderOne({ ...withScope("consolidated"), valueDecimal: "0" })).toBe(false);
		expect(showsUnderOne({ ...withScope("consolidated"), valueDecimal: "500000" })).toBe(false);
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

/** A fixture cell in one scope. */
function withScope(scope: "consolidated" | "separate") {
	const base = appleStatement("income-statement").rows[0]?.cells[0];
	if (base === undefined) throw new Error("fixture has no cell");
	return { ...base, scope };
}
