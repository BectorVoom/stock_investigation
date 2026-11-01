import { type Accessor, createMemo } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { listTitlesByStock } from "../watchlist/listsModel.ts";
import { type CompaniesState, createCompaniesState } from "./companiesState.ts";
import { mergeStockRows, type StockRow } from "./stocksModel.ts";
import { createWatchlistPageState, type WatchlistPageState } from "./watchlistState.ts";

/**
 * The registered stocks as the Stocks page reads them (ADR-0049 §2,
 * ADR-0050 §2): the watchlist and the companies whose statements the server
 * syncs (ADR-0054), merged by stock id — to name the shown stock, to show
 * its statements' sync and to add it to or remove it from the Watchlist
 * and its lists. Create it while a component is being set up.
 */
export interface StockRegistry {
	readonly watch: WatchlistPageState;
	readonly companies: CompaniesState;
	/** The merged rows (`mergeStockRows`), in list order. */
	readonly rows: Accessor<readonly StockRow[]>;
	readonly rowsById: Accessor<ReadonlyMap<string, StockRow>>;
	/** The titles of the lists each stock is in, by stock id. */
	readonly listTitles: Accessor<ReadonlyMap<string, readonly string[]>>;
	/** Both list reads answered (or failed): a stock is then known to be registered or not. */
	readonly settled: Accessor<boolean>;
	/** Starts both reads (call once, on mount). */
	readonly start: () => void;
}

export function createStockRegistry(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): StockRegistry {
	const watch = createWatchlistPageState(options);
	const companies = createCompaniesState(options);

	const rows = createMemo(() =>
		mergeStockRows(watch.data()?.stocks ?? [], companies.companies() ?? []),
	);
	const rowsById = createMemo(
		(): ReadonlyMap<string, StockRow> => new Map(rows().map((row) => [row.stockId, row] as const)),
	);
	const listTitles = createMemo(() => listTitlesByStock(watch.data()?.lists ?? []));

	return {
		watch,
		companies,
		rows,
		rowsById,
		listTitles,
		settled: () =>
			(watch.data() !== null || watch.failure() !== null) &&
			(companies.companies() !== null || companies.failure() !== null),
		start: () => {
			watch.start();
			companies.start();
		},
	};
}
