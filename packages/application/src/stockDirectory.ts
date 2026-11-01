import {
	formatStockId,
	STOCK_DIRECTORY_SOURCES,
	type StockDirectoryEntry,
	type StockDirectoryMarketStatus,
	type StockDirectorySearchQuery,
	type StockDirectorySearchResponse,
	type StockDirectoryStatusResponse,
	type WatchMarket,
} from "@research/contracts";
import {
	ok,
	STOCK_SEARCH_FOLD_VERSION,
	stockSearchHaystack,
	stockSearchKeys,
} from "@research/domain";
import type { UseCaseResult } from "./errors.ts";
import type {
	JobRepository,
	StockDirectoryMeta,
	StockDirectoryRepository,
	StockDirectoryRow,
	StoredStockDirectoryEntry,
	WatchlistRepository,
} from "./ports.ts";

/** The job kind that downloads one market's list (ADR-0034); the server queues it (ADR-0054 §2). */
const KIND = "stock-directory-refresh";

/** Status is reported US first, then JP (`stockDirectoryStatusResponseSchema`). */
const MARKETS: readonly WatchMarket[] = ["US", "JP"];

/**
 * One stored row with its folded search keys, computed here — in
 * TypeScript, with the domain's own fold — so the SQL ranking compares
 * exactly the keys `rankStockSearch` computes (ADR-0034 section 6).
 */
export function keyedStockDirectoryRow(entry: StoredStockDirectoryEntry): StockDirectoryRow {
	const keys = stockSearchKeys(entry);
	return { ...entry, ...keys, searchKey: stockSearchHaystack(keys) };
}

/** The rows a `stock-directory-refreshed` completion stores, keyed. */
export function stockDirectoryRows(
	market: WatchMarket,
	entries: readonly StockDirectoryEntry[],
): StockDirectoryRow[] {
	return entries.map((entry) =>
		keyedStockDirectoryRow({
			market,
			symbol: entry.symbol,
			name: entry.name,
			localName: entry.localName ?? null,
			listing: entry.listing,
		}),
	);
}

export interface StockDirectoryServiceDeps {
	readonly stockDirectory: StockDirectoryRepository;
	readonly watchlist: Pick<WatchlistRepository, "listStocks">;
	/** Each market's download runs, for its status; the schedule queues them (ADR-0054 §2). */
	readonly jobs: Pick<
		JobRepository,
		"findActiveByKind" | "findLatestFailedByKind" | "findLatestSuccessAtByKind"
	>;
}

export function createStockDirectoryService(deps: StockDirectoryServiceDeps) {
	/**
	 * One market's status. The SERVER decides which failure is current,
	 * from its own job times (`updated_at` of the terminal job write, never
	 * the runner's `fetchedAt`): the newest `failed` run of the market is
	 * reported only when no run of that market completed after it. A
	 * cancelled run is the owner's choice, not a failure — it is never
	 * reported and never hides an older failure.
	 */
	async function marketStatus(
		ownerId: string,
		market: WatchMarket,
		meta: StockDirectoryMeta | undefined,
	): Promise<StockDirectoryMarketStatus> {
		const scope = { market };
		const [active, failed, succeededAt] = await Promise.all([
			deps.jobs.findActiveByKind(ownerId, KIND, scope),
			deps.jobs.findLatestFailedByKind(ownerId, KIND, scope),
			deps.jobs.findLatestSuccessAtByKind(ownerId, KIND, scope),
		]);
		// ISO-8601 UTC strings from one clock order lexically; at an equal
		// instant the success wins (the list on disk is the good one).
		const current =
			failed !== null &&
			failed.failureCode !== null &&
			(succeededAt === null || failed.at > succeededAt)
				? {
						state: "failed",
						code: failed.failureCode,
						upstreamStatus: failed.failureUpstreamStatus,
						at: failed.at,
					}
				: null;
		const source = STOCK_DIRECTORY_SOURCES[market];
		return {
			market,
			sourceId: source.sourceId,
			publisher: source.publisher,
			sourceUrl: source.sourceUrl,
			entryCount: meta?.entryCount ?? 0,
			asOf: meta?.asOf ?? null,
			retrievedAt: meta?.retrievedAt ?? null,
			activeRunId: active?.runId ?? null,
			activeRunState: active?.state ?? null,
			lastFailure: current,
		};
	}

	/**
	 * Re-keys one market whose stored keys were computed with another fold
	 * version: reads its rows, recomputes every key with the current fold
	 * and stores them with the new version, before the search reads them.
	 */
	async function rekey(ownerId: string, meta: StockDirectoryMeta): Promise<void> {
		const entries = await deps.stockDirectory.listEntries(ownerId, meta.market);
		await deps.stockDirectory.storeKeys(ownerId, {
			market: meta.market,
			rows: entries.map(keyedStockDirectoryRow),
			fromVersion: meta.foldVersion,
			toVersion: STOCK_SEARCH_FOLD_VERSION,
		});
	}

	return {
		/** Each market's stored list and refresh state, US then JP. */
		async getStatus(ownerId: string): Promise<UseCaseResult<StockDirectoryStatusResponse>> {
			const metas = await deps.stockDirectory.listMeta(ownerId);
			const byMarket = new Map(metas.map((meta) => [meta.market, meta]));
			const markets = await Promise.all(
				MARKETS.map((market) => marketStatus(ownerId, market, byMarket.get(market))),
			);
			return ok({ markets });
		},

		/**
		 * Ranked hits (ADR-0034 section 6) from the stored lists; each hit says
		 * whether the stock is already on the owner's watchlist. A searched
		 * market whose keys were stored under another fold version is
		 * re-keyed first, so a changed fold never searches stale keys.
		 */
		async search(
			ownerId: string,
			query: StockDirectorySearchQuery,
		): Promise<UseCaseResult<StockDirectorySearchResponse>> {
			const metas = await deps.stockDirectory.listMeta(ownerId);
			for (const meta of metas) {
				const searched = query.market === undefined || query.market === meta.market;
				if (searched && meta.foldVersion !== STOCK_SEARCH_FOLD_VERSION) await rekey(ownerId, meta);
			}
			const [entries, stocks] = await Promise.all([
				deps.stockDirectory.search(ownerId, {
					text: query.q,
					market: query.market ?? null,
					limit: query.limit,
				}),
				deps.watchlist.listStocks(ownerId),
			]);
			const registered = new Set(stocks.map((stock) => stock.stockId));
			return ok({
				hits: entries.map((entry) => {
					const stockId = formatStockId(entry.market, entry.symbol);
					return {
						stockId,
						market: entry.market,
						symbol: entry.symbol,
						name: entry.name,
						localName: entry.localName,
						listing: entry.listing,
						registered: registered.has(stockId),
					};
				}),
			});
		},
	};
}

export type StockDirectoryService = ReturnType<typeof createStockDirectoryService>;
