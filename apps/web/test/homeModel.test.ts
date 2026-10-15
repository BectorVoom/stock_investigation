import { widgetSeriesIds } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	buildHomeLineModel,
	changeDirection,
	formatAbsDelta,
	formatChange,
	formatPctValue,
	formatSignedDelta,
	formatValue,
	hasFredSeries,
	isPercentUnit,
	needsAutoRefresh,
	seriesById,
	sparklinePath,
	staleFailureReason,
	toPoints,
	unavailableText,
} from "../src/home/homeModel.ts";

describe("home view-model", () => {
	it("formats values with the magnitude rule: 2 digits at |value| >= 10, 4 below", () => {
		expect(formatValue(4195.84955)).toBe("4,195.85");
		expect(formatValue(4168.4404)).toBe("4,168.44");
		expect(formatValue(15.41)).toBe("15.41");
		expect(formatValue(10)).toBe("10");
		expect(formatValue(9.999)).toBe("9.999");
		expect(formatValue(4.18)).toBe("4.18");
		expect(formatValue(0.5812)).toBe("0.5812");
		expect(formatValue(159400)).toBe("159,400");
		expect(formatValue(0)).toBe("0");
		// F5: a whole displayed value means whole deltas — no forced ".00".
		expect(formatSignedDelta(10)).toBe("+10");
		expect(formatSignedDelta(-27.40914)).toBe("-27.41");
		expect(formatSignedDelta(0.33)).toBe("+0.33");
		expect(formatSignedDelta(0.00123)).toBe("+0.0012");
		expect(formatAbsDelta(-27.40914, "USD")).toBe("-27.41 USD");
		expect(formatAbsDelta(0.00123, "USD")).toBe("+0.0012 USD");
	});

	it("formats a delta with its series' latest value digits, not the delta's own", () => {
		// Hand-worked from the real-data screenshot: gold at 4,173.67 moved
		// +4.2525 (+0.10%). |4173.67| >= 10, so 2 digits: "+4.25", not "+4.2525".
		const gold = formatChange(
			{
				previous: { observedOn: "2026-10-09", value: 4169.4175 },
				latest: { observedOn: "2026-10-10", value: 4173.67 },
				absoluteChange: 4.2525,
				percentChange: 0.102,
			},
			"USD per XAU (troy ounce of gold)",
		);
		expect(gold.text).toBe("▲ +4.25 (+0.10%)");
		// Hand-worked: CPI at 334.13 moved +1.318 (+0.40%).
		// 1.318 / 332.81 × 100 = 0.396, so 2 digits: "+1.32 (+0.40%)".
		const cpi = formatChange(
			{
				previous: { observedOn: "2026-07-01", value: 332.812 },
				latest: { observedOn: "2026-08-01", value: 334.13 },
				absoluteChange: 1.318,
				percentChange: 0.396,
			},
			"Index 1982-1984=100, seasonally adjusted",
		);
		expect(cpi.text).toBe("▲ +1.32 (+0.40%)");
		// Hand-worked: a 0.44 spread moved −0.03. |0.44| < 10 keeps the
		// below-10 rule, so "−0.03" is unchanged by the fix.
		const spread = formatChange(
			{
				previous: { observedOn: "2026-10-08", value: 0.47 },
				latest: { observedOn: "2026-10-09", value: 0.44 },
				absoluteChange: -0.03,
				percentChange: -6.383,
			},
			"Percent",
		);
		expect(spread.text).toBe("▼ -0.03 pp");
		// A tiny delta on a large whole value shows no decimals (F5: the latest
		// "150" displays no fraction digits, so neither does its delta); with
		// exceptZero a delta that rounds to zero shows no sign.
		expect(formatSignedDelta(0.00123, 150)).toBe("0");
		expect(formatSignedDelta(4.2525, 4173.67)).toBe("+4.25");
		// The stock table passes the row's latest value through.
		expect(formatAbsDelta(4.2525, "USD", 4173.67)).toBe("+4.25 USD");
		expect(formatAbsDelta(-2.96, "USD", 226.32)).toBe("-2.96 USD");
		expect(formatAbsDelta(-0.03, "Percent", 0.44)).toBe("-0.03 pp");
	});

	it("detects percent units", () => {
		expect(isPercentUnit("Percent")).toBe(true);
		expect(isPercentUnit("Percent, seasonally adjusted")).toBe(true);
		expect(isPercentUnit("Index")).toBe(false);
		expect(isPercentUnit("USD")).toBe(false);
	});

	it("formats a change with its percent", () => {
		// Hand-worked: 110 against 100 → +10 absolute, +10%. The latest "110"
		// displays no fraction digits (F5), so the delta shows none either.
		const formatted = formatChange(
			{
				previous: { observedOn: "2026-09-01", value: 100 },
				latest: { observedOn: "2026-09-02", value: 110 },
				absoluteChange: 10,
				percentChange: 10,
			},
			"Index",
		);
		expect(formatted.text).toBe("▲ +10 (+10.00%)");
		expect(formatted.direction).toBe("up");
		expect(formatted.word).toBe("up");
	});

	it("marks falls and flat lines", () => {
		expect(changeDirection(0.5)).toBe("up");
		expect(changeDirection(-0.5)).toBe("down");
		expect(changeDirection(0)).toBe("unchanged");
		const flat = formatChange(
			{
				previous: { observedOn: "2026-09-01", value: 100 },
				latest: { observedOn: "2026-09-02", value: 100 },
				absoluteChange: 0,
				percentChange: 0,
			},
			"Index",
		);
		expect(flat.text).toBe("▬ 0 (0.00%)");
		expect(flat.word).toBe("unchanged");
	});

	it("shows percentage points for percent-unit series, never a percent of a percent", () => {
		// Hand-worked: 5.5 against 5.0 → +0.5 points, not +10%. The latest
		// "5.5" displays one fraction digit (F5), so the delta shows one.
		const formatted = formatChange(
			{
				previous: { observedOn: "2026-09-01", value: 5 },
				latest: { observedOn: "2026-09-02", value: 5.5 },
				absoluteChange: 0.5,
				percentChange: 10,
			},
			"Percent",
		);
		expect(formatted.text).toBe("▲ +0.5 pp");
		expect(formatAbsDelta(0.5, "Percent")).toBe("+0.5 pp");
		expect(formatPctValue(10, "Percent")).toBeNull();
		expect(formatPctValue(10, "Index")).toBe("+10.00%");
		expect(formatPctValue(null, "Index")).toBeNull();
	});

	it("omits the percent when the base is zero", () => {
		const formatted = formatChange(
			{
				previous: { observedOn: "2026-09-01", value: 0 },
				latest: { observedOn: "2026-09-02", value: 3 },
				absoluteChange: 3,
				percentChange: null,
			},
			"USD",
		);
		expect(formatted.text).toBe("▲ +3");
	});

	it("F5: whole-number series show whole deltas — the PAYEMS hand-worked case", () => {
		// From the real dashboard: All Employees, Total Nonfarm (fred:PAYEMS)
		// latest 159,044, previous 159,015 → change +29 (not "+29.00"); the
		// 1-year change +496 (not "+496.00"). The percent keeps 2 digits.
		expect(formatValue(159044)).toBe("159,044");
		const change = formatChange(
			{
				previous: { observedOn: "2026-09-01", value: 159015 },
				latest: { observedOn: "2026-10-01", value: 159044 },
				absoluteChange: 29,
				percentChange: (29 / 159015) * 100,
			},
			"Thousands of Persons",
		);
		expect(change.text).toBe("▲ +29 (+0.02%)");
		expect(change.direction).toBe("up");
		const yearChange = formatChange(
			{
				previous: { observedOn: "2025-10-01", value: 158548 },
				latest: { observedOn: "2026-10-01", value: 159044 },
				absoluteChange: 496,
				percentChange: (496 / 158548) * 100,
			},
			"Thousands of Persons",
		);
		expect(yearChange.text).toBe("▲ +496 (+0.31%)");
		// And a two-decimal series keeps its decimals: latest 334.13,
		// previous 332.81 → "+1.32".
		const twoDecimal = formatChange(
			{
				previous: { observedOn: "2026-09-01", value: 332.81 },
				latest: { observedOn: "2026-10-01", value: 334.13 },
				absoluteChange: 334.13 - 332.81,
				percentChange: ((334.13 - 332.81) / 332.81) * 100,
			},
			"Index",
		);
		expect(twoDecimal.text).toBe("▲ +1.32 (+0.40%)");
	});

	it("notes a failed refresh beside stored values, never instead of them", () => {
		const failed = {
			seriesId: "fred:VIXCLS",
			provider: "fred",
			symbol: "VIXCLS",
			title: "VIX",
			unit: "Index",
			frequency: "daily",
			publisher: "p",
			sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
			lastRefreshedAt: "2026-10-12T12:00:00Z",
			retrievedAt: "2026-10-11T00:00:00Z",
			unavailable: { code: "SOURCE_FAILED", reason: "The data source request failed." },
			observations: [
				["2026-10-07", 15.08],
				["2026-10-08", 15.41],
			] as [string, number][],
		} as const;
		expect(staleFailureReason({ ...failed })).toBe("The data source request failed.");
		expect(staleFailureReason({ ...failed, unavailable: null })).toBeNull();
		expect(
			staleFailureReason({ ...failed, observations: [] as unknown as [string, number][] }),
		).toBeNull();
	});

	it("maps series and widget series ids", () => {
		const series = [
			{
				seriesId: "fred:VIXCLS",
				provider: "fred",
				symbol: "VIXCLS",
				title: "VIX",
				unit: "Index",
				frequency: "daily",
				publisher: "p",
				sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
				lastRefreshedAt: null,
				retrievedAt: null,
				unavailable: null,
				observations: [["2026-10-08", 15.41]] as [string, number][],
			},
		] as const;
		const byId = seriesById([...series]);
		expect(byId.get("fred:VIXCLS")?.title).toBe("VIX");
		expect(toPoints([["2026-10-08", 15.41]])).toEqual([{ observedOn: "2026-10-08", value: 15.41 }]);
		expect(
			widgetSeriesIds({
				type: "market-metric",
				widgetId: "w",
				title: "t",
				size: "small",
				seriesId: "fred:VIXCLS",
			}),
		).toEqual(["fred:VIXCLS"]);
		expect(
			widgetSeriesIds({
				type: "stock-table",
				widgetId: "w",
				title: "t",
				size: "medium",
				seriesIds: ["twelve-data:AAPL"],
			}),
		).toEqual(["twelve-data:AAPL"]);
		// The earnings calendar carries no market series (FR-018).
		expect(
			widgetSeriesIds({
				type: "earnings-calendar",
				widgetId: "w",
				title: "t",
				size: "large",
				daysAhead: 90,
			}),
		).toEqual([]);
	});

	it("decides the one automatic refresh per visit", () => {
		const now = Date.parse("2026-10-12T12:00:00Z");
		// V3: an empty series list never needs a refresh.
		expect(needsAutoRefresh([], now)).toBe(false);
		expect(needsAutoRefresh([null], now)).toBe(true);
		expect(needsAutoRefresh(["2026-10-12T11:45:01Z"], now)).toBe(false);
		expect(needsAutoRefresh(["2026-10-12T11:29:59Z"], now)).toBe(true);
		expect(needsAutoRefresh(["not-a-date"], now)).toBe(true);
	});

	it("detects FRED series for the attribution line", () => {
		expect(hasFredSeries(["fred:VIXCLS", "twelve-data:AAPL"])).toBe(true);
		expect(hasFredSeries(["twelve-data:AAPL"])).toBe(false);
		expect(hasFredSeries([])).toBe(false);
	});

	it("uses the fixed unavailable wording, naming the key to set", () => {
		expect(unavailableText("NEVER_REFRESHED")).toContain("refresh");
		expect(unavailableText("SOURCE_NOT_CONFIGURED", "fred")).toContain("FRED_API_KEY");
		expect(unavailableText("SOURCE_NOT_CONFIGURED", "twelve-data")).toContain(
			"TWELVE_DATA_API_KEY",
		);
	});

	it("builds a sparkline path, flat as the midline", () => {
		expect(
			sparklinePath(
				[
					{ observedOn: "2026-10-07", value: 10 },
					{ observedOn: "2026-10-08", value: 20 },
				],
				100,
				30,
			),
		).toBe("M0.00,30.00 L100.00,0.00");
		expect(
			sparklinePath(
				[
					{ observedOn: "2026-10-07", value: 5 },
					{ observedOn: "2026-10-08", value: 5 },
				],
				100,
				30,
			),
		).toBe("M0.00,15.00 L100.00,15.00");
		expect(sparklinePath([{ observedOn: "2026-10-08", value: 5 }], 100, 30)).toBe("");
	});

	it("builds line paths over a union date axis without bridging gaps", () => {
		const model = buildHomeLineModel(
			[
				{
					key: "a",
					label: "A",
					points: [
						{ observedOn: "2026-10-06", value: 1 },
						{ observedOn: "2026-10-07", value: 2 },
						{ observedOn: "2026-10-08", value: 3 },
					],
				},
				{
					key: "b",
					label: "B",
					points: [
						{ observedOn: "2026-10-06", value: 10 },
						{ observedOn: "2026-10-08", value: 30 },
					],
				},
			],
			"max",
		);
		expect(model).not.toBeNull();
		expect(model?.plottedCount).toBe(5);
		// D2 (requirement change): each series' own consecutive observations
		// are connected, so series B skipping 2026-10-07 draws one segment
		// through its own two points instead of dots only.
		const b = model?.series.find((entry) => entry.key === "b");
		expect(b?.paths).toHaveLength(1);
		expect(b?.circles).toHaveLength(2);
		const a = model?.series.find((entry) => entry.key === "a");
		expect(a?.paths).toHaveLength(1);
		expect(a?.values.get(2)).toBe(3);
		expect(model?.yTicks.length).toBeGreaterThan(0);
		expect(model?.xTicks.length).toBeGreaterThan(0);
	});

	it("D2: a monthly series among daily points draws lines, not dots only", () => {
		const daily = [
			{ observedOn: "2026-09-01", value: 100 },
			{ observedOn: "2026-09-02", value: 101 },
			{ observedOn: "2026-09-03", value: 102 },
			{ observedOn: "2026-10-01", value: 103 },
			{ observedOn: "2026-10-02", value: 104 },
			{ observedOn: "2026-11-01", value: 105 },
		];
		const model = buildHomeLineModel(
			[
				{ key: "daily", label: "Daily", points: daily },
				{
					key: "monthly",
					label: "Monthly",
					points: [
						{ observedOn: "2026-09-01", value: 5 },
						{ observedOn: "2026-10-01", value: 6 },
						{ observedOn: "2026-11-01", value: 7 },
					],
				},
			],
			"max",
		);
		expect(model).not.toBeNull();
		const monthly = model?.series.find((entry) => entry.key === "monthly");
		expect(monthly?.circles).toHaveLength(3);
		expect(monthly?.paths).toHaveLength(1);
	});

	it("returns null when nothing is plottable", () => {
		expect(buildHomeLineModel([], "max")).toBeNull();
		expect(buildHomeLineModel([{ key: "a", label: "A", points: [] }], "1y")).toBeNull();
	});
});
