import { type EquityCompanyView, formatStockId } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { type Accessor, createMemo } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { companyName } from "../equities/equitiesModel.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { listTitlesByStock } from "../watchlist/listsModel.ts";
import { type CompaniesState, createCompaniesState } from "./companiesState.ts";
import type { Outcome } from "./Outcome.tsx";
import { stocksMessages } from "./stocks.messages.ts";
import { mergeStockRows, type StockRow } from "./stocksModel.ts";
import { createWatchlistPageState, type WatchlistPageState } from "./watchlistState.ts";

/**
 * The registered stocks (ADR-0049 §2): the watchlist and the companies whose
 * statements are synced, merged into one list, with the companies' writes
 * worded as outcomes. The Registered stocks page manages them; the Stocks
 * page reads them to name the shown stock and to offer its Financial
 * statements actions. Each page creates its own (only one is mounted).
 * Create it while a component is being set up: it reads the message
 * catalogs.
 */
export interface StockRegistry {
	readonly watch: WatchlistPageState;
	readonly companies: CompaniesState;
	/** The merged rows (`mergeStockRows`), in list order. */
	readonly rows: Accessor<readonly StockRow[]>;
	readonly rowsById: Accessor<ReadonlyMap<string, StockRow>>;
	/** The titles of the lists each stock is in, by stock id. */
	readonly listTitles: Accessor<ReadonlyMap<string, readonly string[]>>;
	/** The stock ids whose statements are synced. */
	readonly trackedIds: Accessor<ReadonlySet<string>>;
	/** Both list reads answered (or failed): a stock is then known to be registered or not. */
	readonly settled: Accessor<boolean>;
	/** True while a write of the stock's company is on its way. */
	readonly stockBusy: (stockId: string) => boolean;
	/** "Sync now" for a company, as the outcome to show. */
	readonly syncOutcome: (company: EquityCompanyView) => Promise<Outcome>;
	/** Starts syncing a stock's statements, as the outcome to show. */
	readonly trackOutcome: (stockId: string) => Promise<Outcome>;
	/** Starts both reads (call once, on mount). */
	readonly start: () => void;
}

export function createStockRegistry(options: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/**
	 * The Registered stocks page queues the automatic earnings refresh and
	 * Google sync once per visit; the Stocks page passes false: showing a
	 * stock never makes the runner fetch anything (ADR-0049 §3).
	 */
	readonly automaticRuns: boolean;
}): StockRegistry {
	const s = useMessages(stocksMessages);
	const e = useMessages(equitiesMessages);
	const watch = createWatchlistPageState(options);
	const companies = createCompaniesState(options);

	const rows = createMemo(() =>
		mergeStockRows(watch.data()?.stocks ?? [], companies.companies() ?? []),
	);
	const rowsById = createMemo(
		(): ReadonlyMap<string, StockRow> => new Map(rows().map((row) => [row.stockId, row] as const)),
	);
	const listTitles = createMemo(() => listTitlesByStock(watch.data()?.lists ?? []));
	const trackedIds = createMemo(
		(): ReadonlySet<string> =>
			new Set((companies.companies() ?? []).map((c) => formatStockId(c.market, c.symbol))),
	);

	return {
		watch,
		companies,
		rows,
		rowsById,
		listTitles,
		trackedIds,
		settled: () =>
			(watch.data() !== null || watch.failure() !== null) &&
			(companies.companies() !== null || companies.failure() !== null),
		stockBusy: (stockId) => {
			const company = rowsById().get(stockId)?.company ?? null;
			return (
				companies.tracking().has(stockId) ||
				(company !== null && companies.busy().has(company.companyId))
			);
		},
		syncOutcome: async (company) => {
			const answer = await companies.syncNow(company);
			return answer.ok
				? { kind: "notice", tone: "info", text: e().syncQueued(companyName(company)) }
				: { kind: "failure", title: e().syncFailed, error: answer.error };
		},
		trackOutcome: async (stockId) => {
			const answer = await companies.track(stockId);
			return answer.ok
				? { kind: "notice", tone: "success", text: s().tracked(companyName(answer.value)) }
				: { kind: "failure", title: s().trackFailed, error: answer.error };
		},
		start: () => {
			watch.start();
			companies.start();
		},
	};
}
