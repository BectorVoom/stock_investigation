import type { EquityCompanyView, WatchlistStock, WatchMarket } from "@research/contracts";
import type { Accessor } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { VisibilitySource } from "../lib/polling.ts";

/**
 * The seam between the Stocks page and its tab panels (ADR-0049 §3). The
 * page owns the stock list (watchlist + tracked companies); a tab gets the
 * selected stock and what the page already read about it, so no tab reads
 * the list again.
 */

/** The selected stock as the page knows it. */
export interface SelectedStock {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
	/** The best stored name (watchlist, company, then null until the profile read names it). */
	readonly name: string | null;
	/** Its watchlist entry, or null when it is only tracked for statements. */
	readonly watchlist: WatchlistStock | null;
	/** Its tracked company, or null when its statements are not synced. */
	readonly company: EquityCompanyView | null;
	/** The titles of the Watchlist lists it is in. */
	readonly listTitles: readonly string[];
}

/** What every tab panel receives. */
export interface StockTabProps {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** Reactive: the page's list re-reads update it (a sync finishing, a rename). */
	readonly stock: Accessor<SelectedStock>;
	/**
	 * True while this tab's panel is the shown one. A hidden (kept) panel
	 * stops re-checking its reads (ADR-0049 §3 rule 4).
	 */
	readonly active: Accessor<boolean>;
}
