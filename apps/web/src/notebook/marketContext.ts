import type { MarketSeries, WatchlistResponse } from "@research/contracts";
import type { Accessor } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";

/**
 * What the Home widget components need besides the widget itself, when they
 * render notebook market widgets (ADR-0021): the same live accessors HomeView
 * passes (`WidgetRendererProps` in `home/widgetRegistry.tsx`), here loaded
 * for one conversation's notebook. Null fields are never used: a notebook
 * without market widgets loads nothing.
 */
export interface NotebookMarketContext {
	/** Series of this notebook's market widgets, by id (live; reloaded after refreshes). */
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
	/** The watchlist, loaded only when the notebook holds an earnings calendar. */
	readonly watchlist: Accessor<WatchlistResponse | null>;
	readonly watchlistError: Accessor<ApiFailure | null>;
	readonly onRetryWatchlist: () => void;
	readonly onRefreshEarnings: () => void;
	readonly earningsRefreshBusy: Accessor<boolean>;
	readonly api: ApiClient;
}
