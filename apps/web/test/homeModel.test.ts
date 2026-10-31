import { type MarketSeries, widgetSeriesIds } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { homeModelMessages } from "../src/home/homeModel.messages.ts";
import {
	buildHomeLineModel,
	buildSparkline,
	changeDirection,
	formatAbsDelta,
	formatChange,
	formatPctValue,
	formatSignedDelta,
	formatValue,
	hasFredSeries,
	indicatorTrendPreset,
	isPercentUnit,
	marketAddedRefreshScope,
	marketAutoRefreshScope,
	marketFollowUpScope,
	marketRefreshStamps,
	notebookAutoRefreshScope,
	presetPoints,
	seriesById,
	staleFailureReason,
	toPoints,
	unavailableText,
} from "../src/home/homeModel.ts";

const en = homeModelMessages.en;

/** A stored daily FRED series with one observation. */
function vixSeries(): MarketSeries {
	return {
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
		observations: [["2026-10-08", 15.41]],
	};
}

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
			en,
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
			en,
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
			en,
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
			en,
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
			en,
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
			en,
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
			en,
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
			en,
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
			en,
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
			en,
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
			unavailable: {
				code: "SOURCE_FAILED",
				reason: "The data source request failed.",
				upstreamStatus: null,
			},
			observations: [
				["2026-10-07", 15.08],
				["2026-10-08", 15.41],
			] as [string, number][],
		} as const;
		expect(staleFailureReason({ ...failed }, en)).toBe("The data source request failed.");
		expect(staleFailureReason({ ...failed, unavailable: null }, en)).toBeNull();
		expect(
			staleFailureReason({ ...failed, observations: [] as unknown as [string, number][] }, en),
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

	it("decides the one automatic refresh per visit and its scope (ADR-0039)", () => {
		const now = Date.parse("2026-10-12T12:00:00Z");
		const fresh = "2026-10-12T11:45:01Z";
		const stale = "2026-10-12T11:29:59Z";
		// V3: an empty series list never needs a refresh.
		expect(marketAutoRefreshScope([], now)).toBeNull();
		expect(marketAutoRefreshScope([fresh], now)).toBeNull();
		expect(marketAutoRefreshScope([stale], now)).toBe("all");
		expect(marketAutoRefreshScope(["not-a-date"], now)).toBe("all");
		// Never refreshed with the rest fresh: only the missing ones.
		expect(marketAutoRefreshScope([fresh, null], now)).toBe("unrefreshed");
		// Nothing refreshed yet: everything (the same series, and only a
		// refresh of everything sets the "last successful refresh" line).
		expect(marketAutoRefreshScope([null], now)).toBe("all");
		expect(marketAutoRefreshScope([null, null], now)).toBe("all");
		// The OLDEST stamp decides: one stale series beside a fresh one is stale.
		expect(marketAutoRefreshScope([fresh, stale], now)).toBe("all");
		// Stale beats missing: a refresh of everything covers the missing one too.
		expect(marketAutoRefreshScope([null, stale, fresh], now)).toBe("all");
		// Exactly 30 minutes is still fresh.
		expect(marketAutoRefreshScope(["2026-10-12T11:30:00Z"], now)).toBeNull();
	});

	it("follows up after a run only while a series is still never refreshed", () => {
		const now = Date.parse("2026-10-12T12:00:00Z");
		const fresh = "2026-10-12T11:45:01Z";
		const stale = "2026-10-12T11:29:59Z";
		expect(marketFollowUpScope([fresh, fresh], now)).toBeNull();
		// A run that left stale stamps (it failed) is not repeated by itself.
		expect(marketFollowUpScope([stale, fresh], now)).toBeNull();
		expect(marketFollowUpScope([fresh, null], now)).toBe("unrefreshed");
		expect(marketFollowUpScope([stale, null], now)).toBe("all");
		expect(marketFollowUpScope([null, null], now)).toBe("all");
	});

	it("the Notebook uses Home's staleness rule, asking narrowly when nothing has data yet", () => {
		const now = Date.parse("2026-10-12T12:00:00Z");
		const fresh = "2026-10-12T11:45:01Z";
		const stale = "2026-10-12T11:29:59Z";
		// ADR-0044 §4: a stale series queues a refresh, as on Home…
		expect(notebookAutoRefreshScope([stale], now)).toBe("all");
		expect(notebookAutoRefreshScope([fresh, stale], now)).toBe("all");
		expect(notebookAutoRefreshScope(["not-a-date"], now)).toBe("all");
		// …a fresh page queues nothing, and an empty one never does…
		expect(notebookAutoRefreshScope([fresh, fresh], now)).toBeNull();
		expect(notebookAutoRefreshScope(["2026-10-12T11:30:00Z"], now)).toBeNull();
		expect(notebookAutoRefreshScope([], now)).toBeNull();
		// …and a never-refreshed series asks only for the series without data
		// (ADR-0039), even when none has data yet (Home then asks for everything).
		expect(notebookAutoRefreshScope([null], now)).toBe("unrefreshed");
		expect(notebookAutoRefreshScope([null, null], now)).toBe("unrefreshed");
		expect(notebookAutoRefreshScope([fresh, null], now)).toBe("unrefreshed");
		expect(notebookAutoRefreshScope([stale, null], now)).toBe("all");
		expect(notebookAutoRefreshScope(["not-a-date", null], now)).toBe("all");
	});

	it("judges staleness by the fetched series only: imported materials carry no refresh stamp", () => {
		const byId = seriesById([
			{ ...vixSeries(), lastRefreshedAt: "2026-10-12T11:45:00Z" },
			{
				...vixSeries(),
				seriesId: "materials:NDTESTV1",
				provider: "materials",
				symbol: "NDTESTV1",
				lastRefreshedAt: "2026-01-03T12:00:00Z",
			},
		]);
		expect(marketRefreshStamps(["materials:NDTESTV1", "fred:VIXCLS", "fred:DGS10"], byId)).toEqual([
			{ id: "fred:VIXCLS", lastRefreshedAt: "2026-10-12T11:45:00Z" },
			// A series the data does not name yet has no stamp.
			{ id: "fred:DGS10", lastRefreshedAt: null },
		]);
		// A page of materials alone never asks the providers for anything.
		expect(
			marketAutoRefreshScope(
				marketRefreshStamps(["materials:NDTESTV1"], byId).map((stamp) => stamp.lastRefreshedAt),
				Date.parse("2026-10-12T12:00:00Z"),
			),
		).toBeNull();
	});

	it("picks an indicator's Trend range by its native frequency (ADR-0044 §1)", () => {
		expect(indicatorTrendPreset("daily")).toBe("1y");
		expect(indicatorTrendPreset("weekly")).toBe("1y");
		expect(indicatorTrendPreset("monthly")).toBe("5y");
		expect(indicatorTrendPreset("quarterly")).toBe("max");
		expect(indicatorTrendPreset("annual")).toBe("max");
		expect(indicatorTrendPreset("unknown")).toBe("max");
	});

	it("selects the points the chart viewer opens on at a preset", () => {
		const points = [
			{ observedOn: "2019-12-01", value: 1 },
			{ observedOn: "2020-12-01", value: 2 },
			{ observedOn: "2021-01-01", value: 3 },
			{ observedOn: "2025-06-01", value: 4 },
			{ observedOn: "2025-12-01", value: 5 },
		];
		// 1Y back from the last held day, inclusive (the viewer's presetWindow).
		expect(presetPoints(points, "1y").map((point) => point.observedOn)).toEqual([
			"2025-06-01",
			"2025-12-01",
		]);
		// 5Y back from 2025-12-01 is 2020-12-01, which is included.
		expect(presetPoints(points, "5y").map((point) => point.observedOn)).toEqual([
			"2020-12-01",
			"2021-01-01",
			"2025-06-01",
			"2025-12-01",
		]);
		expect(presetPoints(points, "max")).toBe(points);
		// A history shorter than the preset keeps every point (the window clamps to it).
		expect(presetPoints(points.slice(3), "5y")).toEqual(points.slice(3));
		expect(presetPoints([], "1y")).toEqual([]);
		const one = [{ observedOn: "2025-12-01", value: 5 }];
		expect(presetPoints(one, "1y")).toEqual(one);
	});

	it("refreshes after a widget add: the same rule, else only the series without data", () => {
		const now = Date.parse("2026-10-12T12:00:00Z");
		const fresh = "2026-10-12T11:45:01Z";
		const stale = "2026-10-12T11:29:59Z";
		expect(marketAddedRefreshScope([fresh, null], now)).toBe("unrefreshed");
		// The first widget of an empty dashboard: everything.
		expect(marketAddedRefreshScope([null], now)).toBe("all");
		expect(marketAddedRefreshScope([stale, null], now)).toBe("all");
		// Every series stamped (the added one failed before): still only the unrefreshed.
		expect(marketAddedRefreshScope([fresh, fresh], now)).toBe("unrefreshed");
	});

	it("detects FRED series for the attribution line", () => {
		expect(hasFredSeries(["fred:VIXCLS", "twelve-data:AAPL"])).toBe(true);
		expect(hasFredSeries(["twelve-data:AAPL"])).toBe(false);
		expect(hasFredSeries([])).toBe(false);
	});

	it("uses the fixed unavailable wording, naming the key to set", () => {
		expect(unavailableText("NEVER_REFRESHED", en)).toContain("refresh");
		expect(unavailableText("SOURCE_NOT_CONFIGURED", en, "fred")).toContain("FRED_API_KEY");
		expect(unavailableText("SOURCE_NOT_CONFIGURED", en, "twelve-data")).toContain(
			"TWELVE_DATA_API_KEY",
		);
	});

	it("builds a sparkline path, flat as the midline", () => {
		expect(
			buildSparkline(
				[
					{ observedOn: "2026-10-07", value: 10 },
					{ observedOn: "2026-10-08", value: 20 },
				],
				100,
				30,
			),
		).toEqual({ d: "M0.00,30.00 L100.00,0.00", startY: 30, direction: "up" });
		expect(
			buildSparkline(
				[
					{ observedOn: "2026-10-07", value: 5 },
					{ observedOn: "2026-10-08", value: 5 },
				],
				100,
				30,
			),
		).toEqual({ d: "M0.00,15.00 L100.00,15.00", startY: 15, direction: "unchanged" });
		expect(buildSparkline([{ observedOn: "2026-10-08", value: 5 }], 100, 30)).toBeNull();
		expect(buildSparkline([], 100, 30)).toBeNull();
	});

	it("keeps a sparkline's extremes inside the inset and marks its starting value", () => {
		const line = buildSparkline(
			[
				{ observedOn: "2026-10-06", value: 15 },
				{ observedOn: "2026-10-07", value: 20 },
				{ observedOn: "2026-10-08", value: 10 },
			],
			100,
			30,
			2,
		);
		// Max 20 sits at the inset (y 2), min 10 at height - inset (y 28),
		// and the first value 15 halfway between: the dotted reference line.
		expect(line).toEqual({
			d: "M0.00,15.00 L50.00,2.00 L100.00,28.00",
			startY: 15,
			direction: "down",
		});
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
