import {
	type MarketSeries,
	type StockPricesResponse,
	stockPricesResponseSchema,
	type WatchlistStock,
} from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { ChartTab } from "../src/stocks/ChartTab.tsx";
import { STOCK_FRESH_MS } from "../src/stocks/stockReads.ts";
import type { SelectedStock } from "../src/stocks/stockTabs.ts";
import { ALWAYS_VISIBLE, createFakeBackend, errorResponse, jsonResponse } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The Stocks page's Chart tab (ADR-0049 §4) against a fake API that counts
 * requests: the read is made only while the tab is shown, a second showing
 * answers from the kept value — without a request within the freshness
 * window (`STOCK_FRESH_MS`), with a conditional one (304) after it — the
 * inline viewer is not rebuilt by an unchanged answer or a list re-read,
 * and every state (no stored prices, unavailable, one close, failure) is
 * stated.
 */

const PRICES_PATH = /^\/api\/v1\/stocks\/us%3AAAPL\/prices$/;

/** Ascending ISO dates ending at `lastIso`. */
function isoDays(lastIso: string, count: number): string[] {
	const lastMs = Date.parse(`${lastIso}T00:00:00Z`);
	return Array.from({ length: count }, (_, index) =>
		new Date(lastMs - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
	);
}

function appleSeries(overrides: Partial<MarketSeries> = {}): MarketSeries {
	return {
		seriesId: "twelve-data:AAPL",
		provider: "twelve-data",
		symbol: "AAPL",
		title: "AAPL",
		unit: "USD",
		frequency: "daily",
		publisher: "Twelve Data",
		sourceUrl: "https://twelvedata.com/stocks/AAPL",
		lastRefreshedAt: "2026-10-30T21:00:00Z",
		retrievedAt: "2026-10-30T21:00:00Z",
		unavailable: null,
		observations: isoDays("2026-10-30", 500).map((day, index): [string, number] => [
			day,
			// Ends at 250.00 after 249.00: a change of +1.00 USD (+0.40%).
			index === 499 ? 250 : 100 + index * 0.3,
		]),
		...overrides,
	};
}

function pricesBody(series: MarketSeries | null): StockPricesResponse {
	return stockPricesResponseSchema.parse({
		stockId: "us:AAPL",
		seriesId: "twelve-data:AAPL",
		series,
	});
}

const APPLE: SelectedStock = {
	stockId: "us:AAPL",
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc.",
	watchlist: null,
	company: null,
	listTitles: [],
};

/** Apple on the Watchlist, as the page's watchlist read answers it. */
const WATCHED_APPLE: WatchlistStock = {
	stockId: "us:AAPL",
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc.",
	addedAt: "2026-11-01T00:00:00.000Z",
	source: "finnhub",
	publisher: "Finnhub",
	sourceUrl: "https://finnhub.io/",
	lastRefreshedAt: null,
	retrievedAt: null,
	unavailable: null,
	events: [],
};

/**
 * A fake prices endpoint with ETags: it answers `body()` with ETag
 * `"p-<version>"`, and a 304 when the request carries the current one.
 */
function pricesServer(initial: MarketSeries | null) {
	const backend = createFakeBackend();
	let body = pricesBody(initial);
	let version = 1;
	let failNext = false;
	backend.on("GET", PRICES_PATH, (request) => {
		if (failNext) {
			failNext = false;
			return errorResponse(500, "INTERNAL", "The API failed.");
		}
		const etag = `"p-${version}"`;
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(body, { headers: { ETag: etag } });
	});
	return {
		api: createApiClient({ fetch: backend.fetch }),
		reads: () => backend.requestsTo("GET", PRICES_PATH),
		replace: (series: MarketSeries | null) => {
			body = pricesBody(series);
			version += 1;
		},
		failOnce: () => {
			failNext = true;
		},
	};
}

function renderTab(server: ReturnType<typeof pricesServer>, active = true) {
	const [shown, setShown] = createSignal(active);
	const [stock, setStock] = createSignal<SelectedStock>(APPLE);
	render(() => (
		<ChartTab api={server.api} visibility={ALWAYS_VISIBLE} stock={stock} active={shown} />
	));
	return { setShown, setStock };
}

/** The inline viewer's main chart region, once its chunk has loaded. */
async function chartRegion(): Promise<HTMLElement> {
	return waitFor(() => {
		const region = document.querySelector('section[aria-label="Chart"]');
		if (!(region instanceof HTMLElement)) throw new Error("no chart region yet");
		return region;
	});
}

/** Moves the clock `ms` ahead of real time (the read cache's freshness window); restored after each test. */
function advanceClock(ms: number): void {
	const realNow = Date.now.bind(Date);
	vi.spyOn(Date, "now").mockImplementation(() => realNow() + ms);
}

/** Lets the fake backend answer and the read settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	resetGlobalFetchCalls();
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("Chart tab reads (ADR-0049 §3 rules 3–4)", () => {
	it("makes no request while its panel is hidden, and reads once it is shown", async () => {
		const server = pricesServer(appleSeries());
		const tab = renderTab(server, false);
		await settle();
		expect(server.reads()).toHaveLength(0);

		tab.setShown(true);
		await chartRegion();
		expect(server.reads()).toHaveLength(1);
		expect(server.reads()[0]?.headers["if-none-match"]).toBeUndefined();
	});

	it("shows the kept prices at once on a second showing, without a request while they are fresh", async () => {
		const server = pricesServer(appleSeries());
		const tab = renderTab(server);
		const region = await chartRegion();

		tab.setShown(false);
		await settle();
		tab.setShown(true);
		await settle();
		expect(server.reads()).toHaveLength(1);
		expect(await chartRegion()).toBe(region);
	});

	it("re-checks with the ETag on a showing after the freshness window, keeping the viewer on a 304", async () => {
		const server = pricesServer(appleSeries());
		const tab = renderTab(server);
		const region = await chartRegion();

		tab.setShown(false);
		await settle();
		advanceClock(STOCK_FRESH_MS + 1_000);
		tab.setShown(true);
		await settle();
		const reads = server.reads();
		expect(reads).toHaveLength(2);
		expect(reads[1]?.headers["if-none-match"]).toBe('"p-1"');
		// The unchanged answer (304) leaves the viewer as it was: same element.
		expect(await chartRegion()).toBe(region);
	});

	it("keeps the viewer when the page's list re-reads the same stock", async () => {
		const server = pricesServer(appleSeries());
		const tab = renderTab(server);
		const region = await chartRegion();
		// A preset choice: state the viewer would lose on a rebuild (it reopens at 1Y).
		fireEvent.click(screen.getByRole("button", { name: "3M" }));
		expect(screen.getByRole("button", { name: "3M" }).getAttribute("aria-pressed")).toBe("true");

		tab.setStock({ ...APPLE, listTitles: ["Tech"] });
		await settle();
		expect(await chartRegion()).toBe(region);
		expect(screen.getByRole("button", { name: "3M" }).getAttribute("aria-pressed")).toBe("true");
		expect(server.reads()).toHaveLength(1);
	});
});

describe("Chart tab content (ADR-0049 §4)", () => {
	it("shows the viewer alone: no summary line and no Twelve Data session note above it", async () => {
		const server = pricesServer(appleSeries());
		renderTab(server);
		await chartRegion();
		const tab = document.querySelector('[data-field="stock-chart-tab"]');
		if (!(tab instanceof HTMLElement)) throw new Error("no Chart tab");
		// The inline viewer is the tab's only content: no close, change, as-of or source line before it.
		expect(tab.children).toHaveLength(1);
		expect(tab.firstElementChild?.classList.contains("chart-viewer-inline")).toBe(true);
		expect(document.querySelector('[data-field="stock-chart-summary"]')).toBeNull();
		expect(tab.textContent).not.toContain("unfinished session");
	});

	it("opens the inline viewer at 1Y with no stock heading of its own, without a dialog or a Close button", async () => {
		const server = pricesServer(appleSeries());
		renderTab(server);
		await chartRegion();
		// The page heading names the stock; the tab does not repeat it.
		expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
		expect(screen.getByRole("region", { name: "Apple Inc. · AAPL" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("true");
		expect(document.querySelector("sl-dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		// No data-table twin ("Data table: Apple Inc. · AAPL"): removed 2026-11-01.
		expect(screen.queryByText(/^Data table:/)).toBeNull();
	});

	it("says a stock off the Watchlist has no prices until it is added, and never asks for a refresh", async () => {
		const server = pricesServer(null);
		renderTab(server);
		const none = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-chart-none"]');
			if (!(found instanceof HTMLElement)) throw new Error("no empty state");
			return found;
		});
		expect(none.textContent).toBe(
			"No prices are stored for AAPL. The server downloads the daily closes of every Watchlist stock. Add AAPL to the Watchlist to see its prices.",
		);
		expect(document.querySelector('section[aria-label="Chart"]')).toBeNull();
		// Only the one read: nothing else (no refresh) went to the API.
		expect(server.reads()).toHaveLength(1);
	});

	it("re-reads a Watchlist stock's missing prices sooner until the server's sync stores them (ADR-0055)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const server = pricesServer(null);
			const tab = renderTab(server);
			tab.setStock({ ...APPLE, watchlist: WATCHED_APPLE });
			await vi.advanceTimersByTimeAsync(0);
			const none = document.querySelector('[data-field="stock-chart-none"]');
			expect(none?.textContent).toBe(
				"No prices are stored for AAPL yet. The server downloads the daily closes of every Watchlist stock; they appear here once stored.",
			);
			expect(server.reads()).toHaveLength(1);
			// 5 s, then 10 s: two conditional re-reads that still find nothing.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(server.reads()).toHaveLength(2);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(server.reads()).toHaveLength(3);
			// The server's sync stored the closes: the next re-read draws them.
			server.replace(appleSeries());
			await vi.advanceTimersByTimeAsync(20_000);
			expect(server.reads()).toHaveLength(4);
			expect(document.querySelector('section[aria-label="Chart"]')).not.toBeNull();
			// Found: back to the usual five-minute re-check.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(server.reads()).toHaveLength(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("states a stored series' unavailable reason", async () => {
		const server = pricesServer(
			appleSeries({
				observations: [],
				unavailable: {
					code: "PLAN_NOT_ENTITLED",
					reason: "The provider plan does not include this symbol.",
					upstreamStatus: null,
				},
			}),
		);
		renderTab(server);
		const unavailable = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-chart-unavailable"]');
			if (!(found instanceof HTMLElement)) throw new Error("no unavailable state");
			return found;
		});
		expect(unavailable.textContent).toContain("unavailable (");
		expect(unavailable.textContent).toContain("plan");
		expect(document.querySelector('section[aria-label="Chart"]')).toBeNull();
	});

	it("needs two closes to draw: one close says why", async () => {
		const server = pricesServer(appleSeries({ observations: [["2026-10-30", 250]] }));
		renderTab(server);
		const note = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-chart-one-close"]');
			if (!(found instanceof HTMLElement)) throw new Error("no one-close note");
			return found;
		});
		expect(note.textContent).toContain("at least two stored closes");
		expect(document.querySelector('section[aria-label="Chart"]')).toBeNull();
	});

	it("states a failed read with Try again, which reads again and draws", async () => {
		const server = pricesServer(appleSeries());
		server.failOnce();
		renderTab(server);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The stored prices could not be loaded.");
		expect(alert.textContent).toContain("INTERNAL");
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await chartRegion();
		expect(server.reads()).toHaveLength(2);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("follows a changed answer: new closes redraw the same viewer", async () => {
		const server = pricesServer(appleSeries());
		const tab = renderTab(server);
		await chartRegion();
		server.replace(appleSeries({ observations: appleSeries().observations.slice(0, 400) }));
		tab.setShown(false);
		advanceClock(STOCK_FRESH_MS + 1_000);
		tab.setShown(true);
		// The shortened history ends earlier: the viewer's To date follows it.
		await waitFor(() =>
			expect(screen.getByLabelText("To")).toHaveProperty(
				"value",
				appleSeries().observations[399]?.[0],
			),
		);
		expect(server.reads()).toHaveLength(2);
	});
});
