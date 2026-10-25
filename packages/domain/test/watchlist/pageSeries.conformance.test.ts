import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { DashboardWidget } from "../../src/market/dashboard.ts";
import {
	pageSeriesIds,
	stockPriceSeriesId,
	watchlistListIdsOf,
} from "../../src/watchlist/lists.ts";
import type { WatchMarket } from "../../src/watchlist/stockId.ts";

/**
 * Conformance between the page series rule and its Lean 4 model,
 * `formal/ResearchFormal/PageSeries.lean` (ADR-0040 §4).
 *
 * The theorems (no repeats, at most `limit`, sound, named series first and
 * never pushed out by a list, complete when everything fits, a list shown
 * twice counts once) are about the Lean definitions. `formal/Export.lean`
 * evaluates them over exhaustive small grids and writes the `pageSeries`
 * family of `formal/vectors.json`; every vector is replayed here through real
 * widget objects and real series-id strings, so a divergence between model
 * and code fails this suite.
 *
 * The model abstracts the page to three inputs: the named series in widget
 * order, the list ids of the `watchlist-prices` widgets in widget order, and
 * a lookup. Where the list widgets stand among the others does not matter to
 * it, so every vector is replayed with three widget orders (named first,
 * lists first, interleaved), each with content widgets mixed in.
 */

// The domain project typechecks without Node globals, so the vectors come in
// through a JSON module import (resolved by Vite at test time) and are parsed
// with zod like every other boundary.
const VECTORS_PATH = new URL("../../../../formal/vectors.json", import.meta.url).pathname;

const natList = z.array(z.number().int().nonnegative());
const pageSeriesVector = z.object({
	named: natList,
	refs: natList,
	listIds: natList,
	lists: z.array(z.tuple([z.number().int().nonnegative(), natList])),
	pages: z.array(natList).length(5),
});
const jsonModule = z.object({
	default: z.object({ pageSeries: z.array(pageSeriesVector) }),
});
const imported: unknown = await import(/* @vite-ignore */ VECTORS_PATH, {
	with: { type: "json" },
});
const vectors = jsonModule.parse(imported).default.pageSeries;

/** The model's series ids 0..3 as real stocks, through the one stock → series mapping. */
const STOCKS: readonly (readonly [WatchMarket, string])[] = [
	["US", "AAPL"],
	["JP", "7203"],
	["US", "BRK.B"],
	["JP", "130A"],
];
const SERIES = STOCKS.map(([market, symbol]) => stockPriceSeriesId(market, symbol));

function seriesOf(id: number): string {
	const series = SERIES[id];
	if (series === undefined)
		throw new Error(`series id ${String(id)} is outside the model's alphabet`);
	return series;
}

const listIdOf = (id: number): string => `list-${String(id)}`;

/** A widget naming one series, cycling through every widget type that names series. */
function namedWidget(index: number, seriesId: string): DashboardWidget {
	const base = { widgetId: `named-${String(index)}`, title: "Named", size: "medium" } as const;
	switch (index % 4) {
		case 0:
			return { ...base, type: "market-metric", seriesId };
		case 1:
			return { ...base, type: "line-chart", seriesIds: [seriesId], range: "1y" };
		case 2:
			return { ...base, type: "stock-table", seriesIds: [seriesId] };
		default:
			return { ...base, type: "indicator-table", seriesIds: [seriesId] };
	}
}

const listWidget = (index: number, listId: string): DashboardWidget => ({
	type: "watchlist-prices",
	widgetId: `list-widget-${String(index)}`,
	title: "List",
	size: "medium",
	listId,
});

const CONTENT: readonly DashboardWidget[] = [
	{ type: "text", widgetId: "text", title: "Note", size: "small" },
	{
		type: "earnings-calendar",
		widgetId: "calendar",
		title: "Earnings",
		size: "small",
		daysAhead: 30,
	},
];

/** Alternates the two lists, starting with `first`, then appends what is left of either. */
function interleave(
	first: readonly DashboardWidget[],
	second: readonly DashboardWidget[],
): DashboardWidget[] {
	const out: DashboardWidget[] = [];
	for (let index = 0; index < Math.max(first.length, second.length); index += 1) {
		const a = first[index];
		const b = second[index];
		if (a !== undefined) out.push(a);
		if (b !== undefined) out.push(b);
	}
	return out;
}

/** The widget orders every vector is replayed with: the model says they all agree. */
function layouts(
	named: readonly DashboardWidget[],
	lists: readonly DashboardWidget[],
): readonly (readonly [string, DashboardWidget[]])[] {
	const [textWidget, calendarWidget] = CONTENT;
	if (textWidget === undefined || calendarWidget === undefined) throw new Error("content widgets");
	return [
		["named first", [textWidget, ...named, calendarWidget, ...lists]],
		["lists first", [...lists, textWidget, ...named, calendarWidget]],
		["interleaved", [calendarWidget, ...interleave(lists, named), textWidget]],
	];
}

describe("Lean model conformance: page series (ADR-0040)", () => {
	it("replays the full grid", () => {
		expect(vectors.length).toBe(4296);
	});

	it(`agrees with pageSeriesIds on all ${vectors.length} vectors, limits 0..4, three widget orders`, () => {
		for (const vector of vectors) {
			const named = vector.named.map((id, index) => namedWidget(index, seriesOf(id)));
			const lists = vector.refs.map((id, index) => listWidget(index, listIdOf(id)));
			const table = new Map(
				vector.lists.map(([id, series]) => [listIdOf(id), series.map(seriesOf)] as const),
			);
			const listSeries = (listId: string): readonly string[] | undefined => table.get(listId);
			const expected = vector.pages.map((page) => page.map(seriesOf));
			for (const [layout, widgets] of layouts(named, lists)) {
				const context = `${layout} ${JSON.stringify(vector)}`;
				expect(watchlistListIdsOf(widgets), context).toEqual(vector.listIds.map(listIdOf));
				expected.forEach((page, limit) => {
					expect(
						pageSeriesIds(widgets, listSeries, limit),
						`${context} limit ${String(limit)}`,
					).toEqual(page);
				});
				// At most four distinct ids exist, so the default page limit (30) is limit 4.
				expect(pageSeriesIds(widgets, listSeries), context).toEqual(expected[4]);
			}
		}
	});
});
