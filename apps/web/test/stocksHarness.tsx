import {
	type EquityCompanyView,
	parseStockId,
	type StockProfileResponse,
} from "@research/contracts";
import { stockPriceSeriesId } from "@research/domain";
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
 * lists, earnings refresh, Google steps, the stock directory) and the
 * equities server (tracked companies, statements, filings) on one fetch,
 * plus the per-stock reads (`/api/v1/stocks/:id`, `/prices`, `/news`)
 * answered from the directory rows, with ETags and 304s like the real API.
 * By default no company is tracked, so a watchlist test sees the Watchlist
 * as it was.
 */
export interface StocksServer {
	readonly backend: FakeBackend;
	readonly server: WatchServer;
	readonly equities: EquitiesServer;
}

export function createStocksBackend(
	options: { readonly companies?: EquityCompanyView[] } = {},
): StocksServer {
	const { backend, server } = createWatchlistBackend();
	const equities = createEquitiesServer({ backend, companies: options.companies ?? [] });
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
		};
		const etag = `"profile-${stockId}-${row === undefined ? "none" : "row"}"`;
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
	return { backend, server, equities };
}

export interface MountedStocks {
	readonly api: ApiClient;
	/** The route the page shows now (the URL's stock and tab). */
	readonly route: () => StockRoute | null;
	/** Every navigation the page asked for, in order. */
	readonly navigations: { readonly stock: StockRoute | null; readonly replace: boolean }[];
	/** Changes the route as the browser would (Back, a link). */
	readonly setRoute: (stock: StockRoute | null) => void;
}

/** Renders the Stocks page over `backend` with a route the test controls (as `App` passes the URL's). */
export function mountStocks(
	backend: FakeBackend,
	options: {
		readonly route?: StockRoute | null;
		readonly locale?: Locale;
		readonly visibility?: VisibilitySource;
	} = {},
): MountedStocks {
	const api = createApiClient({ fetch: backend.fetch });
	const [route, setRoute] = createSignal<StockRoute | null>(options.route ?? null);
	const navigations: { stock: StockRoute | null; replace: boolean }[] = [];
	render(() => (
		<LocaleProvider locale={() => options.locale ?? "en"}>
			<StocksView
				api={api}
				visibility={options.visibility ?? ALWAYS_VISIBLE}
				stock={route()}
				onNavigate={(stock, navigation) => {
					navigations.push({ stock, replace: navigation?.replace === true });
					setRoute(stock);
				}}
			/>
		</LocaleProvider>
	));
	return { api, route, navigations, setRoute };
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

/** The merged table's accessible name (its caption). */
export const STOCKS_TABLE =
	"Your stocks: the watchlist, then the companies whose statements are synced";

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

/** A company whose statements are synced, for a tracked-only row. */
export function trackedOnly(symbol: string, name: string): EquityCompanyView {
	return makeCompany({
		companyId: `eqc_${symbol.toLowerCase()}`,
		symbol,
		name,
		sourceCompanyId: `00000${symbol.length}0000`,
	});
}
