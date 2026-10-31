import {
	type MarketSeries,
	type StockPricesResponse,
	stockPricesResponseSchema,
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
		<ChartTab
			api={server.api}
			visibility={ALWAYS_VISIBLE}
			stock={stock}
			active={shown}
			onSelectTab={() => {}}
		/>
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
		expect(document.querySelector('[data-field="stock-chart-summary"]')?.textContent).toContain(
			"250 USD",
		);
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
	it("states the last close, the change with its sign, the as-of date and the source", async () => {
		const server = pricesServer(appleSeries());
		renderTab(server);
		const summary = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-chart-summary"]');
			if (!(found instanceof HTMLElement)) throw new Error("no summary");
			return found;
		});
		expect(summary.getAttribute("aria-label")).toBe("Latest close");
		const text = summary.textContent ?? "";
		expect(text).toContain("Last close");
		expect(text).toContain("250 USD");
		// Sign and colour, never colour alone: the Stock table's signed amount and percent.
		expect(text).toMatch(/\+\d[\d.]* USD \(\+\d[\d.]*%\)/);
		expect(text).toContain("2026-10-30");
		expect(within(summary).getByRole("link", { name: "Twelve Data" }).getAttribute("href")).toBe(
			"https://twelvedata.com/stocks/AAPL",
		);
	});

	it("opens the inline viewer at 1Y, without a dialog or a Close button", async () => {
		const server = pricesServer(appleSeries());
		renderTab(server);
		await chartRegion();
		expect(
			screen.getByRole("heading", { level: 4, name: "Apple Inc. · AAPL — daily closes" }),
		).toBeTruthy();
		expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("true");
		expect(document.querySelector("sl-dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		// The data-table twin is there, closed until opened.
		expect(screen.getByText(/^Data table: Apple Inc\. · AAPL — daily closes/)).toBeTruthy();
	});

	it("says no prices are stored, with a link to Home, and never asks for a refresh", async () => {
		const server = pricesServer(null);
		renderTab(server);
		const none = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-chart-none"]');
			if (!(found instanceof HTMLElement)) throw new Error("no empty state");
			return found;
		});
		expect(none.textContent).toContain(
			"No prices are stored for AAPL. Prices are downloaded for stocks shown on Home or in a notebook.",
		);
		expect(within(none).getByRole("link", { name: "Open Home" }).getAttribute("href")).toBe(
			"#/home",
		);
		expect(document.querySelector('section[aria-label="Chart"]')).toBeNull();
		// Only the one read: nothing else (no refresh) went to the API.
		expect(server.reads()).toHaveLength(1);
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

	it("needs two closes to draw: one close shows the summary and says why", async () => {
		const server = pricesServer(appleSeries({ observations: [["2026-10-30", 250]] }));
		renderTab(server);
		const note = await waitFor(() => {
			const found = document.querySelector('[data-field="stock-chart-one-close"]');
			if (!(found instanceof HTMLElement)) throw new Error("no one-close note");
			return found;
		});
		expect(note.textContent).toContain("at least two stored closes");
		const summary = document.querySelector('[data-field="stock-chart-summary"]')?.textContent ?? "";
		expect(summary).toContain("250 USD");
		expect(summary.match(/needs more history/g)).toHaveLength(1);
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
		await waitFor(() =>
			expect(
				document.querySelector('[data-field="stock-chart-summary"]')?.textContent,
			).not.toContain("250 USD"),
		);
		expect(server.reads()).toHaveLength(2);
	});
});
