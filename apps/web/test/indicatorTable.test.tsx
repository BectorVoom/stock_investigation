import type { MarketFrequency, MarketSeries } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANGE_TONES } from "../src/components/ui.tsx";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { IndicatorTableWidget } from "../src/home/widgets/IndicatorTableWidget.tsx";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The Indicator table's history (ADR-0044 §1): each row's name opens the
 * detailed chart viewer at the Trend range, and the Trend column draws the
 * stored observations over it — the same last year for every row, whatever
 * its frequency, named once in the column header (ADR-0069).
 */

/** `count` observations `stepMonths` apart, ending 2026-10-01, from `start` by `delta` each. */
function monthly(
	count: number,
	stepMonths: number,
	start: number,
	delta: number,
): [string, number][] {
	const points: [string, number][] = [];
	for (let index = 0; index < count; index += 1) {
		const monthsBack = (count - 1 - index) * stepMonths;
		const date = new Date(Date.UTC(2026, 9 - monthsBack, 1)).toISOString().slice(0, 10);
		points.push([date, start + delta * index]);
	}
	return points;
}

/** Daily observations over the 800 days up to 2026-10-09, from `start` by `delta` each. */
function daily(start: number, delta: number): [string, number][] {
	const last = Date.UTC(2026, 9, 9);
	const points: [string, number][] = [];
	for (let index = 0; index < 800; index += 1) {
		const date = new Date(last - (799 - index) * 86_400_000).toISOString().slice(0, 10);
		points.push([date, start + delta * index]);
	}
	return points;
}

function series(
	symbol: string,
	title: string,
	frequency: MarketFrequency,
	observations: [string, number][],
): MarketSeries {
	return {
		seriesId: `fred:${symbol}`,
		provider: "fred",
		symbol,
		title,
		unit: "Index",
		frequency,
		publisher: "Federal Reserve Bank of St. Louis",
		sourceUrl: `https://fred.stlouisfed.org/series/${symbol}`,
		lastRefreshedAt: "2026-10-12T11:50:00Z",
		retrievedAt: "2026-10-12T11:50:00Z",
		unavailable: null,
		observations,
	};
}

/** Rising daily VIX, falling monthly CPI (ten years), rising quarterly GDP, a one-point weekly series. */
const VIX = series("VIXCLS", "CBOE Volatility Index: VIX", "daily", daily(10, 0.01));
const CPI = series("CPIAUCSL", "Consumer Price Index", "monthly", monthly(120, 1, 400, -0.5));
const GDP = series("GDP", "Gross Domestic Product", "quarterly", monthly(40, 3, 20_000, 50));
const CLAIMS = series("ICSA", "Initial Claims", "weekly", [["2026-10-03", 220_000]]);
const EMPTY: MarketSeries = {
	...series("UNRATE", "Unemployment Rate", "unknown", []),
	lastRefreshedAt: null,
	retrievedAt: null,
	unavailable: {
		code: "NEVER_REFRESHED",
		upstreamStatus: null,
		reason: "No data has been refreshed yet; queue a refresh.",
	},
};
const ALL = [VIX, CPI, GDP, CLAIMS, EMPTY];

function renderTable(locale: "en" | "ja" = "en"): HTMLElement {
	const byId = new Map(ALL.map((entry) => [entry.seriesId, entry] as const));
	const ui = (): JSX.Element => (
		<IndicatorTableWidget
			widget={{
				widgetId: "w-indicators",
				type: "indicator-table",
				title: "US economy",
				size: "large",
				seriesIds: ALL.map((entry) => entry.seriesId),
			}}
			seriesById={() => byId}
		/>
	);
	render(() => <LocaleProvider locale={() => locale}>{ui()}</LocaleProvider>);
	return screen.getByRole("table");
}

/** The Trend cell of the row whose header names `title`. */
function trendCell(table: HTMLElement, title: string): HTMLElement {
	const row = within(table).getByRole("row", { name: new RegExp(title) });
	const cell = row.querySelector('[data-field="indicator-trend"]');
	if (!(cell instanceof HTMLElement)) throw new Error(`${title} has no Trend cell`);
	return cell;
}

/** What the cell shows on screen (its `aria-hidden` parts, the sr-only text left out). */
function shown(cell: HTMLElement): string {
	return [...cell.querySelectorAll("span[aria-hidden='true']")]
		.map((part) => part.textContent ?? "")
		.join("");
}

/** What a screen reader hears from the cell: its sr-only text. */
function spoken(cell: HTMLElement): string {
	return cell.querySelector(".sr-only")?.textContent ?? "";
}

/** Waits for the lazy chart viewer and answers its From/To and its pressed preset. */
async function openedViewer(): Promise<{
	readonly dialog: HTMLElement;
	readonly range: readonly string[];
	readonly pressed: readonly string[];
}> {
	const dialog = await waitFor(() => {
		const found = document.querySelector("sl-dialog.chart-viewer");
		if (!(found instanceof HTMLElement)) throw new Error("the chart viewer did not open");
		return found;
	});
	const range = [...dialog.querySelectorAll('input[type="date"]')]
		.filter((input): input is HTMLInputElement => input instanceof HTMLInputElement)
		.map((input) => input.value);
	const pressed = [...dialog.querySelectorAll('button[aria-pressed="true"]')].map(
		(button) => button.textContent ?? "",
	);
	return { dialog, range, pressed };
}

beforeEach(() => {
	resetGlobalFetchCalls();
	// The viewer's Shoelace controls resolve their icons from the shipped SVGs
	// (Home calls this on mount); without it the kit fetches `data:` URIs.
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("Indicator table history (ADR-0044 §1)", () => {
	it("adds a Trend column after the 1-year change, its year named in the header", () => {
		const table = renderTable();
		expect(table.querySelector("caption")?.textContent).toBe(
			"US economy: latest value, value a month earlier, changes and trend of each indicator",
		);
		const headers = within(table)
			.getAllByRole("columnheader")
			.map((header) => header.textContent);
		expect(headers).toEqual([
			"Indicator",
			"Latest value",
			"As of",
			"1 month earlier",
			"1-month change",
			"1-year change",
			"Trend (1 year)",
			"Source",
		]);
	});

	it("covers the same year on every row, daily, weekly, monthly or quarterly (ADR-0069)", () => {
		const table = renderTable();
		// No per-row range name: the header names the one year.
		for (const title of [
			"VIX",
			"Consumer Price Index",
			"Gross Domestic Product",
			"Initial Claims",
		]) {
			expect(shown(trendCell(table, title))).toBe("");
		}
		expect(spoken(trendCell(table, "VIX"))).toBe("up over 1 year");
		expect(spoken(trendCell(table, "Consumer Price Index"))).toBe("down over 1 year");
		expect(spoken(trendCell(table, "Gross Domestic Product"))).toBe("up over 1 year");
	});

	it("draws a decorative sparkline toned by the year's direction", () => {
		const table = renderTable();
		const up = trendCell(table, "VIX").querySelector("svg");
		expect(up?.getAttribute("aria-hidden")).toBe("true");
		expect(up?.dataset.sparklineDirection).toBe("up");
		expect(up?.getAttribute("class")).toContain(CHANGE_TONES.up);
		// The dotted start line, as on the Metric widget.
		expect(up?.querySelector("line")?.getAttribute("stroke-dasharray")).toBe("1 3");
		const down = trendCell(table, "Consumer Price Index").querySelector("svg");
		expect(down?.dataset.sparklineDirection).toBe("down");
		expect(down?.getAttribute("class")).toContain(CHANGE_TONES.down);
		expect(trendCell(table, "Gross Domestic Product").querySelector("svg")).not.toBeNull();
		// The line is hidden from assistive tech; only the direction is spoken.
		expect(trendCell(table, "VIX").textContent).toBe("up over 1 year");
	});

	it("draws the line over the last year only, whatever the frequency", () => {
		const table = renderTable();
		const steps = (title: string) =>
			(trendCell(table, title).querySelector("path")?.getAttribute("d") ?? "")
				.split(" ")
				.filter((step) => /^[ML]/.test(step)).length;
		// 2025-10-09 … 2026-10-09 inclusive: 366 daily points (the viewer's 1Y window).
		expect(steps("VIX")).toBe(366);
		// 2025-10-01 … 2026-10-01 inclusive: 13 monthly and 5 quarterly points.
		expect(steps("Consumer Price Index")).toBe(13);
		expect(steps("Gross Domestic Product")).toBe(5);
	});

	it("shows no line for a one-point series, and a dash for one with no values", () => {
		const table = renderTable();
		const claims = trendCell(table, "Initial Claims");
		expect(claims.querySelector("svg")).toBeNull();
		expect(spoken(claims)).toBe("too few observations for a trend over 1 year");
		// A row without values shows a dash read as "unavailable"; its value
		// cells say why.
		const empty = trendCell(table, "Unemployment Rate");
		expect(empty.querySelector("svg")).toBeNull();
		expect(shown(empty)).toBe("—");
		expect(spoken(empty)).toBe("unavailable");
	});

	it("hides the Trend column below the @2xl container width, header and cells alike", () => {
		const table = renderTable();
		const container = table.closest(".\\@container");
		expect(container).not.toBeNull();
		const header = within(table).getByRole("columnheader", { name: "Trend (1 year)" });
		const trendCells = [header, ...table.querySelectorAll('[data-field="indicator-trend"]')];
		expect(trendCells).toHaveLength(ALL.length + 1);
		for (const cell of trendCells) {
			expect(cell.classList.contains("hidden")).toBe(true);
			expect(cell.classList.contains("@2xl:table-cell")).toBe(true);
		}
	});

	it("opens the chart viewer from a row name at the Trend's year", async () => {
		const table = renderTable();
		// The name cell is the opener, named like a Stock table row.
		const open = within(table).getByRole("button", {
			name: /^Open chart: Consumer Price Index/,
		});
		expect(open.closest("th")?.getAttribute("scope")).toBe("row");
		fireEvent.click(open);
		const monthlyViewer = await openedViewer();
		expect(monthlyViewer.dialog.textContent).toContain("Consumer Price Index");
		expect(monthlyViewer.pressed).toEqual(["1Y"]);
		// The same dates the Trend line covers.
		expect(monthlyViewer.range).toEqual(["2025-10-01", "2026-10-01"]);
		fireEvent.click(within(monthlyViewer.dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull());

		fireEvent.click(within(table).getByRole("button", { name: /^Open chart: CBOE Volatility/ }));
		const dailyViewer = await openedViewer();
		expect(dailyViewer.pressed).toEqual(["1Y"]);
		expect(dailyViewer.range).toEqual(["2025-10-09", "2026-10-09"]);
	});

	it("has no opener for a series without observations", () => {
		const table = renderTable();
		expect(within(table).queryByRole("button", { name: /Unemployment Rate/ })).toBeNull();
		expect(within(table).getByRole("row", { name: /Unemployment Rate/ })).toBeTruthy();
	});

	it("words the Trend column in Japanese", async () => {
		const table = renderTable("ja");
		expect(table.querySelector("caption")?.textContent).toBe(
			"US economy：各指標の最新値・前月値・変化・推移",
		);
		expect(within(table).getByRole("columnheader", { name: "推移（1年）" })).toBeTruthy();
		expect(spoken(trendCell(table, "VIX"))).toBe("1年で上昇");
		expect(spoken(trendCell(table, "Consumer Price Index"))).toBe("1年で下落");
		expect(spoken(trendCell(table, "Gross Domestic Product"))).toBe("1年で上昇");
		expect(spoken(trendCell(table, "Initial Claims"))).toBe(
			"1年の推移を描くには観測値が足りません",
		);
		expect(spoken(trendCell(table, "Unemployment Rate"))).toBe("取得できません");
		// The accessible name adds a space between the hidden prefix and the visible name.
		fireEvent.click(
			within(table).getByRole("button", { name: /^チャートを開く：\s*Consumer Price Index/ }),
		);
		const viewer = await openedViewer();
		expect(viewer.pressed).toEqual(["1年"]);
	});
});
