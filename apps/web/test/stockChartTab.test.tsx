import {
	type MarketSeries,
	type StockPricesResponse,
	type StockProfileResponse,
	stockPricesResponseSchema,
	stockProfileResponseSchema,
} from "@research/contracts";
import { stockPriceSeriesId } from "@research/domain";
import { LocaleProvider } from "@research/i18n/solid";
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
 * and every state (no stored prices on the way or never coming, unavailable,
 * one close, failure) is stated, with the source and, for a Japanese stock,
 * J-Quants' delay (ADR-0058 §6).
 */

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

function pricesBody(stock: SelectedStock, series: MarketSeries | null): StockPricesResponse {
	return stockPricesResponseSchema.parse({
		stockId: stock.stockId,
		seriesId: stockPriceSeriesId(stock.market, stock.symbol),
		series,
	});
}

/** The stock's profile: in the stored stock list (`listed`) or not; nothing else is read from it. */
function profileBody(stock: SelectedStock, listed: boolean): StockProfileResponse {
	return stockProfileResponseSchema.parse({
		stockId: stock.stockId,
		market: stock.market,
		symbol: stock.symbol,
		priceSeriesId: stockPriceSeriesId(stock.market, stock.symbol),
		directory: listed
			? {
					name: stock.name ?? stock.symbol,
					localName: null,
					listing: stock.market === "JP" ? "tse-prime" : "nasdaq",
				}
			: null,
		business: listed ? { status: "pending" } : { status: "not-tracked" },
		companyProfile: null,
		company: null,
	});
}

/** Apple, not on the Watchlist: every listed stock's prices are synced (ADR-0058). */
const APPLE: SelectedStock = {
	stockId: "us:AAPL",
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc.",
	watchlist: null,
	listTitles: [],
};

const TOYOTA: SelectedStock = {
	stockId: "jp:7203",
	market: "JP",
	symbol: "7203",
	name: "TOYOTA MOTOR CORPORATION",
	watchlist: null,
	listTitles: [],
};

/**
 * A fake prices endpoint with ETags: it answers `body()` with ETag
 * `"p-<version>"`, and a 304 when the request carries the current one;
 * and the stock's profile, listed unless `listed` is false.
 */
function pricesServer(
	initial: MarketSeries | null,
	options: { readonly stock?: SelectedStock; readonly listed?: boolean } = {},
) {
	const stock = options.stock ?? APPLE;
	const path = encodeURIComponent(stock.stockId);
	const pricesPath = new RegExp(`^/api/v1/stocks/${path}/prices$`);
	const profilePath = new RegExp(`^/api/v1/stocks/${path}$`);
	const backend = createFakeBackend();
	let body = pricesBody(stock, initial);
	let version = 1;
	let failNext = false;
	backend.on("GET", profilePath, () =>
		jsonResponse(profileBody(stock, options.listed ?? true), { headers: { ETag: '"profile"' } }),
	);
	backend.on("GET", pricesPath, (request) => {
		if (failNext) {
			failNext = false;
			return errorResponse(500, "INTERNAL", "The API failed.");
		}
		const etag = `"p-${version}"`;
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(body, { headers: { ETag: etag } });
	});
	return {
		stock,
		api: createApiClient({ fetch: backend.fetch }),
		reads: () => backend.requestsTo("GET", pricesPath),
		profileReads: () => backend.requestsTo("GET", profilePath),
		requests: () => backend.requests,
		replace: (series: MarketSeries | null) => {
			body = pricesBody(stock, series);
			version += 1;
		},
		failOnce: () => {
			failNext = true;
		},
	};
}

function renderTab(server: ReturnType<typeof pricesServer>, active = true) {
	const [shown, setShown] = createSignal(active);
	const [stock, setStock] = createSignal<SelectedStock>(server.stock);
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
	it("shows the viewer first, then only its source: no summary line and no session note", async () => {
		const server = pricesServer(
			appleSeries({ publisher: "Massive", sourceUrl: "https://massive.com/" }),
		);
		renderTab(server);
		await chartRegion();
		const tab = document.querySelector('[data-field="stock-chart-tab"]');
		if (!(tab instanceof HTMLElement)) throw new Error("no Chart tab");
		// No close, change or as-of line before the viewer; the stored series' publisher below it.
		expect(tab.firstElementChild?.classList.contains("chart-viewer-inline")).toBe(true);
		expect(tab.children).toHaveLength(2);
		const source = tab.querySelector('[data-field="stock-chart-source"]');
		expect(source?.textContent).toBe("Source: Massive");
		expect(within(tab).getByRole("link", { name: "Massive" }).getAttribute("href")).toBe(
			"https://massive.com/",
		);
		expect(document.querySelector('[data-field="stock-chart-summary"]')).toBeNull();
		expect(tab.textContent).not.toContain("unfinished session");
		// A US stock has no J-Quants note; with prices stored the profile is not read.
		expect(document.querySelector('[data-field="stock-chart-japanese-delay"]')).toBeNull();
		expect(server.profileReads()).toHaveLength(0);
	});

	it("says under a Japanese stock's chart that J-Quants Free ends about 12 weeks ago (ADR-0058 §6)", async () => {
		const server = pricesServer(
			appleSeries({
				seriesId: "twelve-data:7203:JPX",
				symbol: "7203",
				title: "7203",
				unit: "JPY",
				publisher: "J-Quants",
				sourceUrl: "https://jpx-jquants.com/",
			}),
			{ stock: TOYOTA },
		);
		renderTab(server);
		await chartRegion();
		expect(document.querySelector('[data-field="stock-chart-source"]')?.textContent).toBe(
			"Source: J-Quants",
		);
		expect(document.querySelector('[data-field="stock-chart-japanese-delay"]')?.textContent).toBe(
			"Japanese prices come from J-Quants Free and end about 12 weeks ago.",
		);
	});

	it("says it in Japanese, also while a Japanese stock has no prices yet", async () => {
		const server = pricesServer(null, { stock: TOYOTA });
		const [shown] = createSignal(true);
		const [stock] = createSignal<SelectedStock>(TOYOTA);
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<ChartTab api={server.api} visibility={ALWAYS_VISIBLE} stock={stock} active={shown} />
			</LocaleProvider>
		));
		await waitFor(() =>
			expect(document.querySelector('[data-field="stock-chart-none"]')?.textContent).toBe(
				"7203 の株価はまだ保存されていません。サーバーは上場しているすべての銘柄の日次株価をダウンロードします。保存されるとここに表示されます。",
			),
		);
		expect(document.querySelector('[data-field="stock-chart-japanese-delay"]')?.textContent).toBe(
			"日本株の株価は J-Quants（Free プラン）から取得しており、約12週間前までのものです。",
		);
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

	it("says a stock outside the stored stock lists gets no prices, never asks for a refresh and stops re-reading", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const server = pricesServer(null, { listed: false });
			renderTab(server);
			await vi.advanceTimersByTimeAsync(0);
			const none = document.querySelector('[data-field="stock-chart-none"]');
			expect(none?.textContent).toBe(
				"No prices are stored for AAPL. The server downloads the daily prices of the stocks in the stored US and Japanese stock lists, and AAPL is not in them.",
			);
			expect(none?.getAttribute("data-listed")).toBe("false");
			expect(document.querySelector('section[aria-label="Chart"]')).toBeNull();
			expect(document.querySelector('[data-field="stock-chart-source"]')).toBeNull();
			// The prices and the profile, once each: no refresh, and no sooner re-read for prices that never come.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(server.reads()).toHaveLength(1);
			expect(server.profileReads()).toHaveLength(1);
			expect(server.requests().every((request) => request.method === "GET")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("re-reads a listed stock's missing prices sooner until the server's sync stores them, on the Watchlist or not (ADR-0058 §6)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const server = pricesServer(null);
			renderTab(server);
			await vi.advanceTimersByTimeAsync(0);
			const none = document.querySelector('[data-field="stock-chart-none"]');
			expect(none?.textContent).toBe(
				"No prices are stored for AAPL yet. The server downloads every listed stock's daily prices; they appear here once stored.",
			);
			expect(none?.getAttribute("data-listed")).toBe("true");
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

describe("Chart tab candlesticks (ADR-0056 §6)", () => {
	/** The Apple series with each day's bar, as the server sends Twelve Data's stored bars. */
	function appleWithBars(): MarketSeries {
		const base = appleSeries();
		return {
			...base,
			observations: base.observations.map(([day, close], index) => [
				day,
				close,
				[close - 0.5, close + 1, close - 1, 1_000_000 + index * 1_000],
			]),
		};
	}

	async function mainChart(): Promise<SVGSVGElement> {
		const region = await chartRegion();
		return waitFor(() => {
			const svg = region.querySelector("svg[data-chart-type]");
			if (!(svg instanceof SVGSVGElement)) throw new Error("no main chart yet");
			return svg;
		});
	}

	it("opens the inline viewer in Candlestick with a volume panel when the prices carry bars", async () => {
		renderTab(pricesServer(appleWithBars()));
		const svg = await mainChart();
		expect(svg.getAttribute("data-chart-type")).toBe("candlestick");
		expect(
			Number(svg.querySelector('g[data-chart-part="candles"]')?.getAttribute("data-candles")),
		).toBeGreaterThan(0);
		expect(svg.querySelector('g[data-chart-part="volume"]')).not.toBeNull();
		expect(document.querySelector('sl-select[label="Chart type"]')).not.toBeNull();
	});

	it("opens in Line, with Candlestick disabled and the reason, when the prices have closes only", async () => {
		renderTab(pricesServer(appleSeries()));
		const svg = await mainChart();
		expect(svg.getAttribute("data-chart-type")).toBe("line");
		expect(svg.querySelector('g[data-chart-part="volume"]')).toBeNull();
		const blocked = [...document.querySelectorAll("sl-option")].find(
			(option) => option.textContent === "Candlestick — no open/high/low from this source",
		);
		expect(blocked?.hasAttribute("disabled")).toBe(true);
	});
});
