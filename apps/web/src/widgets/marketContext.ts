import type { MarketSeries, WatchlistResponse } from "@research/contracts";
import type { Accessor } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";

/**
 * What the market widget components (`home/widgetRegistry.tsx`) need besides
 * the widget itself (ADR-0021, ADR-0024): live accessors for the page's
 * series and the watchlist. Home builds it from its own loaders; a notebook
 * from `createNotebookMarketContext`. A page without market widgets loads
 * nothing.
 */
export interface WidgetMarketContext {
	/** Series of the page's market widgets, by id (live; reloaded after refreshes). */
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
	/**
	 * The series the page is served (`pageSeriesIds`, ADR-0040 §4): named
	 * series first, then the Watchlist prices widgets' lists, at most 30.
	 */
	readonly pageSeries: Accessor<ReadonlySet<string>>;
	/** The watchlist, loaded only when the page holds an earnings calendar or a Watchlist prices widget. */
	readonly watchlist: Accessor<WatchlistResponse | null>;
	readonly watchlistError: Accessor<ApiFailure | null>;
	readonly onRetryWatchlist: () => void;
	readonly onRefreshEarnings: () => void;
	readonly earningsRefreshBusy: Accessor<boolean>;
	readonly api: ApiClient;
}
