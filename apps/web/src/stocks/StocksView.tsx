import type { JSX } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import type { StockRoute } from "../router.ts";
import { WatchlistView } from "../watchlist/WatchlistView.tsx";

/**
 * SEAM STUB — the Stocks page (ADR-0049): the Watchlist and Equities pages
 * merged, with the selected stock's tabs. Replaced by the page worker; until
 * then it shows the Watchlist so the app keeps working.
 */
export function StocksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** The selected stock and tab from the URL; null for the bare list. */
	readonly stock: StockRoute | null;
	/** Changes the selection: a new stock pushes history, a tab switch replaces it. */
	readonly onNavigate: (stock: StockRoute | null, options?: { readonly replace?: boolean }) => void;
}): JSX.Element {
	return <WatchlistView api={props.api} visibility={props.visibility} />;
}
