import {
	type CompanyOverviewView,
	type CompanySummaryView,
	type EquityCompanyView,
	parseStockId,
	type StockBusiness,
	type StockCompanyProfileView,
	type StockEarningsCalendarView,
	type StockProfileResponse,
} from "@research/contracts";
import {
	formatStockId,
	matchingThemes,
	normalizeThemeQuery,
	stockPriceSeriesId,
	type ThemeName,
} from "@research/domain";
import type { Locale } from "@research/i18n";
import { LocaleProvider } from "@research/i18n/solid";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect } from "vitest";
import { type ApiClient, createApiClient } from "../src/api/client.ts";
import type { VisibilitySource } from "../src/lib/polling.ts";
import type { StockRoute } from "../src/router.ts";
import { RegisteredStocksView } from "../src/stocks/RegisteredStocksView.tsx";
import { StocksView } from "../src/stocks/StocksView.tsx";
import { createEquitiesServer, type EquitiesServer, makeCompany } from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE, errorResponse, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import { createWatchlistBackend, type WatchServer } from "./watchlistHarness.ts";

/**
 * The Stocks page's fake API (ADR-0049): the watchlist backend (stocks,
 * lists, earnings-sync state, Google steps, the stock directory) and the
 * equities server (tracked companies, statements, filings) on one fetch,
 * plus the per-stock reads (`/api/v1/stocks/:id`, `/prices`, `/news`)
 * answered from the directory rows, with ETags and 304s like the real API.
 * By default no company is tracked, so a watchlist test sees the Watchlist
 * as it was. A profile's business description (ADR-0053 §5) is
 * `businessOf`'s entry for the stock id, else "not-provided" for a Japanese
 * stock (J-Quants has none, ADR-0059 §3) and "not-tracked" for a US one; a
 * Japanese stock's `companyProfile` is `companyProfileOf`'s entry, else
 * null. The ETag follows the body, so a test that changes either sees the
 * change on a re-read.
 */
export interface StocksServer {
	readonly backend: FakeBackend;
	readonly server: WatchServer;
	readonly equities: EquitiesServer;
	readonly businessOf: Map<string, StockBusiness>;
	readonly companyProfileOf: Map<string, StockCompanyProfileView>;
	/** A stock's stored AI-written summary (ADR-0060); none when absent. */
	readonly summaryOf: Map<string, CompanySummaryView>;
	/** A stock's stored company overview (ADR-0064); none when absent. */
	readonly overviewOf: Map<string, CompanyOverviewView>;
	/** A stock's market earnings calendar rows (ADR-0068); null (never synced) when absent. */
	readonly calendarOf: Map<string, StockEarningsCalendarView>;
}

export function createStocksBackend(
	options: { readonly companies?: EquityCompanyView[] } = {},
): StocksServer {
	const { backend, server } = createWatchlistBackend();
	const equities = createEquitiesServer({ backend, companies: options.companies ?? [] });
	const businessOf = new Map<string, StockBusiness>();
	const companyProfileOf = new Map<string, StockCompanyProfileView>();
	const summaryOf = new Map<string, CompanySummaryView>();
	const overviewOf = new Map<string, CompanyOverviewView>();
	const calendarOf = new Map<string, StockEarningsCalendarView>();
	backend.on("GET", /^\/api\/v1\/stocks\/([^/?]+)$/, (request, match) => {
		const stockId = decodeURIComponent(match[1] ?? "");
		const parsed = parseStockId(stockId);
		if (parsed === null) return errorResponse(400, "VALIDATION_FAILED", "bad id");
		const row = server.directory.rows.find(
			(entry) => entry.market === parsed.market && entry.symbol === parsed.symbol,
		);
		const body: StockProfileResponse = {
			stockId,
			market: parsed.market,
			symbol: parsed.symbol,
			priceSeriesId: stockPriceSeriesId(parsed.market, parsed.symbol),
			directory:
				row === undefined
					? null
					: { name: row.name, localName: row.localName, listing: row.listing },
			business:
				businessOf.get(stockId) ??
				(parsed.market === "JP" ? { status: "not-provided" } : { status: "not-tracked" }),
			companyProfile: parsed.market === "JP" ? (companyProfileOf.get(stockId) ?? null) : null,
			summary: summaryOf.get(stockId) ?? null,
			overview: overviewOf.get(stockId) ?? null,
			// The listing's stored company, tracked or not (ADR-0055).
			company:
				equities.companies.find(
					(company) => company.market === parsed.market && company.symbol === parsed.symbol,
				) ?? null,
			earningsCalendar: calendarOf.get(stockId) ?? null,
		};
		const etag = `"profile-${stockId}-${bodyDigest(JSON.stringify(body))}"`;
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(body, { headers: { ETag: etag } });
	});
	backend.on("GET", /^\/api\/v1\/stocks\/([^/?]+)\/prices$/, (request, match) => {
		const stockId = decodeURIComponent(match[1] ?? "");
		const parsed = parseStockId(stockId);
		if (parsed === null) return errorResponse(400, "VALIDATION_FAILED", "bad id");
		const etag = `"prices-${stockId}"`;
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(
			{ stockId, seriesId: stockPriceSeriesId(parsed.market, parsed.symbol), series: null },
			{ headers: { ETag: etag } },
		);
	});
	backend.on("GET", /^\/api\/v1\/stocks\/([^/?]+)\/news(\?.*)?$/, (request, match) => {
		const stockId = decodeURIComponent(match[1] ?? "");
		const etag = `"news-${stockId}"`;
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(
			{ stockId, terms: [], articles: [], nextCursor: null },
			{ headers: { ETag: etag } },
		);
	});
	// The theme search (ADR-0066) over the shown themes — the overview's,
	// else the summary's — with the real matching rules, in market and symbol order.
	backend.on("GET", /^\/api\/v1\/stocks\/theme-search\?/, (request) => {
		const words = new URL(request.path, "http://fake").searchParams.get("q") ?? "";
		const query = normalizeThemeQuery(words);
		if (query === null) return jsonResponse({ query: null, hits: [], truncated: false });
		const stockIds = [...new Set([...summaryOf.keys(), ...overviewOf.keys()])].sort();
		const hits = stockIds.flatMap((stockId) => {
			const parsed = parseStockId(stockId);
			if (parsed === null) return [];
			const overview = overviewOf.get(stockId);
			const shown: ThemeName[] =
				overview !== undefined
					? overview.entry.themes.map((theme) => theme.label)
					: [...(summaryOf.get(stockId)?.themes ?? [])];
			const themes = matchingThemes(shown, query);
			if (themes.length === 0) return [];
			const row = server.directory.rows.find(
				(entry) => entry.market === parsed.market && entry.symbol === parsed.symbol,
			);
			return [
				{
					stockId: formatStockId(parsed.market, parsed.symbol),
					market: parsed.market,
					symbol: parsed.symbol,
					name: row?.name ?? null,
					localName: row?.localName ?? null,
					themes,
				},
			];
		});
		return jsonResponse({ query, hits, truncated: false });
	});
	return {
		backend,
		server,
		equities,
		businessOf,
		companyProfileOf,
		summaryOf,
		overviewOf,
		calendarOf,
	};
}

/** A short digest of a body for its fake ETag (FNV-1a over UTF-16 units). */
function bodyDigest(text: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < text.length; index += 1) {
		hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
	}
	return hash.toString(16);
}

export interface MountedStocks {
	readonly api: ApiClient;
	/** The route the page shows now (the URL's stock and tab). */
	readonly route: () => StockRoute | null;
	/** Every navigation the page asked for, in order. */
	readonly navigations: { readonly stock: StockRoute | null; readonly replace: boolean }[];
	/** Changes the route as the browser would (Back, a link). */
	readonly setRoute: (stock: StockRoute | null) => void;
	/** The theme search's words in the URL (ADR-0066). */
	readonly theme: () => string | null;
	/** Every theme search the page asked for, in order. */
	readonly themeSearches: string[];
	/** Changes the theme search's words as the browser would (a link, Back). */
	readonly setTheme: (words: string | null) => void;
}

/** Renders the Stocks page over `backend` with a route the test controls (as `App` passes the URL's). */
export function mountStocks(
	backend: FakeBackend,
	options: {
		readonly route?: StockRoute | null;
		readonly theme?: string | null;
		readonly locale?: Locale;
		readonly visibility?: VisibilitySource;
	} = {},
): MountedStocks {
	const api = createApiClient({ fetch: backend.fetch });
	const [route, setRoute] = createSignal<StockRoute | null>(options.route ?? null);
	const navigations: { stock: StockRoute | null; replace: boolean }[] = [];
	const [theme, setTheme] = createSignal<string | null>(options.theme ?? null);
	const themeSearches: string[] = [];
	render(() => (
		<LocaleProvider locale={() => options.locale ?? "en"}>
			<StocksView
				api={api}
				visibility={options.visibility ?? ALWAYS_VISIBLE}
				stock={route()}
				theme={theme()}
				onNavigate={(stock, navigation) => {
					navigations.push({ stock, replace: navigation?.replace === true });
					setTheme(null);
					setRoute(stock);
				}}
				onThemeSearch={(words) => {
					themeSearches.push(words);
					setRoute(null);
					setTheme(words);
				}}
			/>
		</LocaleProvider>
	));
	return { api, route, navigations, setRoute, theme, themeSearches, setTheme };
}

/** Renders the Registered stocks page (the stock list and the Stock lists section) over `backend`. */
export function mountRegistered(
	backend: FakeBackend,
	options: { readonly locale?: Locale; readonly visibility?: VisibilitySource } = {},
): { readonly api: ApiClient } {
	const api = createApiClient({ fetch: backend.fetch });
	render(() => (
		<LocaleProvider locale={() => options.locale ?? "en"}>
			<RegisteredStocksView api={api} visibility={options.visibility ?? ALWAYS_VISIBLE} />
		</LocaleProvider>
	));
	return { api };
}

/**
 * Puts a tracked-only stock on the watchlist the way Registered stocks still
 * can (ADR-0049 §2): its row's "Add to Watchlist" button. (The page's add
 * form is gone, ADR-0050 §4; stocks are otherwise added from the Stocks page.)
 */
export async function addToWatchlistFromRow(symbol: string): Promise<void> {
	const add = await screen.findByRole("button", { name: `Add ${symbol} to the Watchlist` });
	await waitFor(() => expect(add.hasAttribute("disabled")).toBe(false));
	fireEvent.click(add);
}

/** A company whose statements the server stores, for a tracked-only row. */
export function trackedOnly(symbol: string, name: string): EquityCompanyView {
	return makeCompany({
		companyId: `eqc_${symbol.toLowerCase()}`,
		symbol,
		name,
		sourceCompanyId: `00000${symbol.length}0000`,
	});
}
