import { type Accessor, createMemo } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { listTitlesByStock } from "../watchlist/listsModel.ts";
import { type StockRow, watchlistRows } from "./stocksModel.ts";
import { createWatchlistPageState, type WatchlistPageState } from "./watchlistState.ts";

/**
 * The registered stocks as the Stocks page reads them (ADR-0049 §2,
 * ADR-0050 §2): the Watchlist and its lists, by stock id — to name the
 * shown stock and to add it to or remove it from the Watchlist and its
 * lists. The companies whose statements the server syncs are not read: it
 * syncs every stock in the stored stock lists (ADR-0058 §3), and a tab
 * reads the shown stock's company from its profile. Create it while a
 * component is being set up.
 */
export interface StockRegistry {
	readonly watch: WatchlistPageState;
	/** The Watchlist's rows (`watchlistRows`), in list order. */
	readonly rows: Accessor<readonly StockRow[]>;
	readonly rowsById: Accessor<ReadonlyMap<string, StockRow>>;
	/** The titles of the lists each stock is in, by stock id. */
	readonly listTitles: Accessor<ReadonlyMap<string, readonly string[]>>;
	/** The Watchlist read answered (or failed): a stock is then known to be registered or not. */
	readonly settled: Accessor<boolean>;
	/** Starts the Watchlist read (call once, on mount). */
	readonly start: () => void;
}

export function createStockRegistry(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): StockRegistry {
	const watch = createWatchlistPageState(options);

	const rows = createMemo(() => watchlistRows(watch.data()?.stocks ?? []));
	const rowsById = createMemo(
		(): ReadonlyMap<string, StockRow> => new Map(rows().map((row) => [row.stockId, row] as const)),
	);
	const listTitles = createMemo(() => listTitlesByStock(watch.data()?.lists ?? []));

	return {
		watch,
		rows,
		rowsById,
		listTitles,
		settled: () => watch.data() !== null || watch.failure() !== null,
		start: () => watch.start(),
	};
}
