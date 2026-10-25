import type { MarketSeries, WatchlistResponse, WidgetSize } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, type JSX } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiFailure } from "../src/api/http.ts";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { WatchlistPricesWidget } from "../src/home/widgets/WatchlistPricesWidget.tsx";
import { listSeriesLookup, webPageSeriesIds } from "../src/widgets/pageSeries.ts";
import { watchlistPricesWidget } from "../src/widgets/widgetModel.ts";
import { makeStock } from "./watchlistHarness.ts";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const STOCKS = [
	makeStock({ stockId: "us:AAPL", symbol: "AAPL", name: "Apple Inc" }),
	makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" }),
	makeStock({ stockId: "jp:7203", market: "JP", symbol: "7203", name: "Toyota Motor" }),
	makeStock({ stockId: "us:NVDA", symbol: "NVDA", name: "NVIDIA Corp" }),
	makeStock({ stockId: "us:AMD", symbol: "AMD", name: null }),
	makeStock({ stockId: "us:INTC", symbol: "INTC", name: "Intel Corp" }),
];

function watchlist(stockIds: readonly string[] = ["us:AAPL", "us:MSFT", "jp:7203"]) {
	return {
		stocks: STOCKS,
		lists: [
			{
				listId: "list_1",
				title: "Chips and cars",
				stockIds: [...stockIds],
				version: 3,
				createdAt: "2026-10-25T00:00:00Z",
				updatedAt: "2026-10-25T00:00:00Z",
			},
		],
		refresh: {
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
		},
		feed: { enabled: false, createdAt: null },
		googleCalendar: {
			status: "disconnected",
			authUrl: null,
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			lastSync: null,
			inSync: null,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: null,
		},
	} satisfies WatchlistResponse;
}

function twelve(
	symbol: string,
	closes: readonly (readonly [string, number])[],
	unavailable: MarketSeries["unavailable"] = null,
): MarketSeries {
	return {
		seriesId: `twelve-data:${symbol}`,
		provider: "twelve-data",
		symbol,
		title: `${symbol} (Twelve Data)`,
		unit: "USD",
		frequency: "daily",
		publisher: "Twelve Data",
		sourceUrl: "https://twelvedata.com/",
		lastRefreshedAt: "2026-10-25T00:00:00Z",
		retrievedAt: "2026-10-25T00:00:00Z",
		unavailable,
		observations: closes.map(([date, value]) => [date, value] as [string, number]),
	};
}

const SERIES = [
	twelve("AAPL", [
		["2026-10-22", 250],
		["2026-10-23", 252.5],
	]),
	twelve("MSFT", [
		["2026-10-22", 500],
		["2026-10-23", 495],
	]),
	twelve("7203:JPX", [], {
		code: "PLAN_NOT_ENTITLED",
		reason: "This symbol is not available on the current plan.",
		upstreamStatus: null,
	}),
];

const NO_FAILURE: ApiFailure | null = null;

function renderWidget(
	options: {
		readonly size?: WidgetSize;
		readonly watchlist?: WatchlistResponse | null;
		readonly error?: ApiFailure | null;
		readonly series?: readonly MarketSeries[];
		readonly pageSeries?: ReadonlySet<string>;
		readonly listId?: string;
		readonly onRetry?: () => void;
		readonly wrap?: (ui: () => JSX.Element) => JSX.Element;
	} = {},
) {
	const current = options.watchlist === undefined ? watchlist() : options.watchlist;
	const byId = new Map((options.series ?? SERIES).map((entry) => [entry.seriesId, entry] as const));
	const served =
		options.pageSeries ??
		new Set(
			webPageSeriesIds(
				[{ ...watchlistPricesWidget(options.listId ?? "list_1", "Chips and cars", "w-1") }],
				current,
			),
		);
	const widget = {
		...watchlistPricesWidget(options.listId ?? "list_1", "Chips and cars", "w-1"),
		size: options.size ?? "medium",
	};
	const ui = () => (
		<WatchlistPricesWidget
			widget={widget}
			seriesById={() => byId}
			watchlist={() => current}
			watchlistError={() => options.error ?? NO_FAILURE}
			onRetryWatchlist={options.onRetry ?? (() => {})}
			pageSeries={() => served}
		/>
	);
	return render(() => (options.wrap === undefined ? ui() : options.wrap(ui)));
}

function rowNames(): string[] {
	return screen
		.getAllByRole("rowheader")
		.map((header) => header.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

describe("Watchlist prices widget (ADR-0040 §5)", () => {
	it("shows the list's current title, its count, and one row per stock in list order", () => {
		renderWidget();
		expect(screen.getByText("Chips and cars")).toBeTruthy();
		expect(screen.getByText("3 stocks")).toBeTruthy();
		const table = screen.getByRole("table", {
			name: "Chips and cars: last close and change from the previous close",
		});
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(["Stock", "Last close", "Change", "Change %", "As of"]);
		expect(rowNames()).toEqual([
			"Open chart: Apple Inc AAPL",
			"Open chart: Microsoft Corp MSFT",
			"Toyota Motor 7203",
		]);
		const rows = within(table).getAllByRole("row");
		// The change from the previous close: amount and percent, sign and arrow-free text.
		expect(rows[1]?.textContent).toContain("252.5");
		expect(rows[1]?.textContent).toContain("+2.5");
		expect(rows[1]?.textContent).toContain("+1.00%");
		expect(rows[2]?.textContent).toContain("-5");
		expect(rows[2]?.textContent).toContain("-1.00%");
		expect(rows[1]?.querySelector("time")?.getAttribute("datetime")).toBe("2026-10-23");
		// A Japanese stock on the free plan: the stored reason, as a Stock table row says it.
		expect(rows[3]?.textContent).toMatch(/^Toyota Motor 7203unavailable \(/);
		// The Twelve Data session note and the source line.
		expect(screen.getByText(/^Twelve Data daily bars/)).toBeTruthy();
		const footer = document.querySelector('[data-field="widget-footer"]');
		expect(footer?.textContent).toBe("Sources: Twelve Data");
	});

	it("opens the chart viewer from a row with data", async () => {
		ensureHomeIconLibraries();
		renderWidget();
		fireEvent.click(screen.getByRole("button", { name: "Open chart: Apple Inc AAPL" }));
		await waitFor(
			() => expect(document.querySelector("sl-dialog.chart-viewer[open]")).not.toBeNull(),
			{ timeout: 10_000 },
		);
	});

	it("shows a symbol and the percentage only at Small, with the rows past the floor counted", () => {
		renderWidget({
			size: "small",
			watchlist: watchlist(["us:AAPL", "us:MSFT", "jp:7203", "us:NVDA", "us:AMD", "us:INTC"]),
		});
		const table = screen.getByRole("table");
		expect(
			within(table)
				.getAllByRole("columnheader")
				.map((cell) => cell.textContent),
		).toEqual(["Stock", "Change %"]);
		// No layout in the DOM tests: the floor of four rows.
		expect(rowNames()).toEqual(["Open chart: AAPL", "Open chart: MSFT", "7203", "NVDA"]);
		expect(screen.getByText("2 more — a larger size shows every stock")).toBeTruthy();
	});

	it("adds the source column at Large", () => {
		renderWidget({ size: "large" });
		expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
			"Stock",
			"Last close",
			"Change",
			"Change %",
			"As of",
			"Source",
		]);
		expect(screen.getAllByRole("link", { name: "Twelve Data" }).length).toBeGreaterThan(1);
	});

	it("says Not shown for a row past the page's series limit, never no data", () => {
		renderWidget({ pageSeries: new Set(["twelve-data:AAPL"]) });
		const rows = screen.getAllByRole("row");
		expect(rows[2]?.textContent).toBe(
			"Microsoft Corp MSFTNot shown: this page already shows 30 price series",
		);
		// A row the page is not served has no chart opener.
		expect(screen.queryByRole("button", { name: /MSFT/ })).toBeNull();
	});

	it("says unavailable for a stock whose series has not arrived", () => {
		renderWidget({ series: [] });
		expect(screen.getAllByRole("row")[1]?.textContent).toBe(
			"Apple Inc AAPLunavailable (The provider returned no data for this series.)",
		);
	});

	it("names a nameless stock by its symbol alone, never the series' placeholder title", () => {
		renderWidget({
			watchlist: watchlist(["us:AMD"]),
			series: [
				{
					...twelve("AMD", [
						["2026-10-22", 150],
						["2026-10-23", 151],
					]),
					title: "AMD",
				},
			],
		});
		expect(rowNames()).toEqual(["Open chart: AMD"]);
		cleanup();
		// A placeholder series with no data: the symbol once, then the reason.
		const base = watchlist([]);
		const japan = makeStock({ stockId: "jp:6758", market: "JP", symbol: "6758", name: null });
		renderWidget({
			watchlist: {
				...base,
				stocks: [...STOCKS, japan],
				lists: base.lists.map((entry) => ({ ...entry, stockIds: ["jp:6758"] })),
			},
			series: [{ ...twelve("6758:JPX", []), title: "6758:JPX" }],
		});
		expect(rowNames()).toEqual(["6758"]);
	});

	it("says the list was deleted", () => {
		renderWidget({ listId: "list_gone" });
		expect(screen.getByText("This list was deleted.")).toBeTruthy();
		expect(screen.getByText("Remove this widget from its menu.")).toBeTruthy();
		expect(screen.queryByRole("table")).toBeNull();
	});

	it("says an empty list has no stocks and links to the Watchlist page", () => {
		renderWidget({ watchlist: watchlist([]) });
		expect(screen.getByText("0 stocks")).toBeTruthy();
		expect(screen.getByText("No stocks in this list yet.")).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Add stocks on the Watchlist page" }).getAttribute("href"),
		).toBe("#/watchlist");
	});

	it("shows loading, then a failed load with Try again", () => {
		const { unmount } = renderWidget({ watchlist: null });
		expect(screen.getByText("Loading the watchlist…")).toBeTruthy();
		unmount();
		const onRetry = vi.fn();
		renderWidget({
			watchlist: null,
			error: {
				kind: "network",
				code: "NETWORK_ERROR",
				status: null,
				message: "The request failed: offline",
				detail: null,
				issues: [],
			},
			onRetry,
		});
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("The watchlist did not load.");
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledOnce();
	});

	it("follows the list live: a stock added to the list appears as a new row", () => {
		const [current, setCurrent] = createSignal<WatchlistResponse>(watchlist(["us:AAPL"]));
		const byId = new Map(SERIES.map((entry) => [entry.seriesId, entry] as const));
		render(() => (
			<WatchlistPricesWidget
				widget={watchlistPricesWidget("list_1", "Chips and cars", "w-1")}
				seriesById={() => byId}
				watchlist={current}
				watchlistError={() => null}
				onRetryWatchlist={() => {}}
				pageSeries={() => new Set(["twelve-data:AAPL", "twelve-data:MSFT"])}
			/>
		));
		expect(rowNames()).toEqual(["Open chart: Apple Inc AAPL"]);
		const before = screen.getByRole("button", { name: "Open chart: Apple Inc AAPL" });
		setCurrent(watchlist(["us:AAPL", "us:MSFT"]));
		expect(rowNames()).toEqual(["Open chart: Apple Inc AAPL", "Open chart: Microsoft Corp MSFT"]);
		// The existing row stays mounted (keyed by its series id).
		expect(screen.getByRole("button", { name: "Open chart: Apple Inc AAPL" })).toBe(before);
	});

	it("speaks Japanese", () => {
		renderWidget({
			watchlist: watchlist([]),
			wrap: (ui) => <LocaleProvider locale={() => "ja"}>{ui()}</LocaleProvider>,
		});
		expect(screen.getByText("0 銘柄")).toBeTruthy();
		expect(screen.getByText("このリストにはまだ銘柄がありません。")).toBeTruthy();
		cleanup();
		renderWidget({
			pageSeries: new Set(["twelve-data:AAPL"]),
			wrap: (ui) => <LocaleProvider locale={() => "ja"}>{ui()}</LocaleProvider>,
		});
		expect(screen.getAllByRole("columnheader")[0]?.textContent).toBe("銘柄");
		// MSFT and 7203 are past the page's series: each row says so.
		expect(screen.getAllByText(/^表示されません：このページはすでに 30 件/)).toHaveLength(2);
	});
});

describe("the web's page series (ADR-0040 §4)", () => {
	it("resolves a list to its stocks' price series through the domain mapping", () => {
		const lookup = listSeriesLookup(watchlist());
		expect(lookup("list_1")).toEqual([
			"twelve-data:AAPL",
			"twelve-data:MSFT",
			"twelve-data:7203:JPX",
		]);
		expect(lookup("list_gone")).toBeUndefined();
		expect(listSeriesLookup(null)("list_1")).toBeUndefined();
	});

	it("puts named series first and stops at 30", () => {
		const named = Array.from({ length: 29 }, (_, index) => `fred:S${index}`);
		const ids = webPageSeriesIds(
			[
				watchlistPricesWidget("list_1", "Chips and cars", "w-1"),
				{
					widgetId: "w-2",
					type: "stock-table",
					title: "Named",
					size: "medium",
					seriesIds: named.slice(0, 12),
				},
				{
					widgetId: "w-3",
					type: "stock-table",
					title: "Named 2",
					size: "medium",
					seriesIds: named.slice(12, 24),
				},
				{
					widgetId: "w-4",
					type: "stock-table",
					title: "Named 3",
					size: "medium",
					seriesIds: named.slice(24),
				},
			],
			watchlist(),
		);
		expect(ids).toHaveLength(30);
		expect(ids.slice(0, 29)).toEqual(named);
		expect(ids[29]).toBe("twelve-data:AAPL");
	});
});
