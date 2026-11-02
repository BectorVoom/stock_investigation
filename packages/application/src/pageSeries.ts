/**
 * Which market series a page shows, the runner refreshes and a clean-up
 * keeps (ADR-0040 §4) — the ONE application helper over the domain's
 * `pageSeriesIds`, so Home, the notebooks, the market claim and every
 * series clean-up resolve Watchlist lists the same way.
 *
 * A `watchlist-prices` widget names a list, not series: its list is resolved
 * through `WatchlistListRepository.membersOf` (one statement for every list
 * a request needs) and each member through the domain's
 * `stockPriceSeriesId`. A deleted list resolves to nothing.
 *
 * Every Watchlist stock's price series is kept too (ADR-0058 §9.1), but not
 * tracked: a directory stock's daily bars come from the `stock-prices-sync`
 * job, not from Twelve Data (ADR-0058 §2 — `ownerTrackedSeries` also leaves
 * the pages' directory stocks out of what the market sync fetches).
 */
import { MARKET_LIMITS } from "@research/contracts";
import {
	type DashboardWidget,
	distinctDashboardSeriesIds,
	pageSeriesIds,
	stockPriceSeriesId,
	watchlistListIdsOf,
} from "@research/domain";
import { unionSeriesIds } from "./marketData.ts";
import type { NotebookRepository, WatchlistListRepository, WatchlistRepository } from "./ports.ts";

/** A list's price series in list order, or `undefined` for a list that does not exist. */
export type ListSeriesLookup = (listId: string) => readonly string[] | undefined;

/** The answer for a page without `watchlist-prices` widgets: no list exists. */
const NO_LISTS: ListSeriesLookup = () => undefined;

/**
 * Resolves the named lists to their stocks' price series in ONE query (none
 * at all when no list is named, so pages without list widgets cost nothing
 * extra).
 */
export async function resolveListSeries(
	lists: Pick<WatchlistListRepository, "membersOf">,
	ownerId: string,
	listIds: readonly string[],
): Promise<ListSeriesLookup> {
	if (listIds.length === 0) return NO_LISTS;
	const members = await lists.membersOf(ownerId, [...new Set(listIds)]);
	const series = new Map<string, readonly string[]>();
	for (const [listId, entries] of members) {
		series.set(
			listId,
			entries.map((member) => stockPriceSeriesId(member.market, member.symbol)),
		);
	}
	return (listId) => series.get(listId);
}

/**
 * The series ONE page (Home or one notebook) shows: its named series first,
 * then its lists' series, at most `MARKET_LIMITS.maxSeries`.
 */
export async function pageSeriesFor(
	lists: Pick<WatchlistListRepository, "membersOf">,
	ownerId: string,
	widgets: readonly DashboardWidget[],
): Promise<string[]> {
	const lookup = await resolveListSeries(lists, ownerId, watchlistListIdsOf(widgets));
	return pageSeriesIds(widgets, lookup, MARKET_LIMITS.maxSeries);
}

export interface OwnerSeriesDeps {
	readonly notebooks: Pick<NotebookRepository, "listMarketSeriesIds" | "listWatchlistListIds">;
	readonly watchlistLists: Pick<WatchlistListRepository, "membersOf">;
	readonly watchlist: Pick<WatchlistRepository, "listStocks">;
}

/** Every series the owner's pages track, two ways (see the fields). */
export interface OwnerSeries {
	/**
	 * What the pages track: Home's page series first, then every
	 * notebook's named series and list series, de-duplicated, at most
	 * `MARKET_LIMITS.maxPageTrackedSeries`. ADR-0058 §2 removed the Watchlist
	 * part ADR-0055 had added: a Watchlist stock's bars come from `stock-prices-sync`.
	 * What a market-refresh claim fetches is this list without the
	 * directory stocks' price series (`ownerTrackedSeries`).
	 */
	readonly tracked: readonly string[];
	/**
	 * What a series clean-up keeps: every series Home or any notebook names
	 * or lists, and every Watchlist stock's, uncapped — a clean-up never
	 * deletes a series a page shows or a Watchlist stock's prices.
	 */
	readonly keep: readonly string[];
}

/**
 * The owner's tracked and kept series, given Home's widgets (the stored
 * dashboard, or the one a save is about to store). Two notebook scans and
 * at most ONE list resolution, whatever the number of pages and lists.
 */
export async function ownerSeries(
	deps: OwnerSeriesDeps,
	ownerId: string,
	homeWidgets: readonly DashboardWidget[],
): Promise<OwnerSeries> {
	const [notebookNamed, notebookListIds, watched] = await Promise.all([
		deps.notebooks.listMarketSeriesIds(ownerId),
		deps.notebooks.listWatchlistListIds(ownerId),
		deps.watchlist.listStocks(ownerId),
	]);
	const homeListIds = watchlistListIdsOf(homeWidgets);
	const lookup = await resolveListSeries(deps.watchlistLists, ownerId, [
		...homeListIds,
		...notebookListIds,
	]);
	const notebookListed = notebookListIds.flatMap((listId) => lookup(listId) ?? []);
	const notebookSeries = [...notebookNamed, ...notebookListed];
	const watchlistSeries = watched.map((stock) => stockPriceSeriesId(stock.market, stock.symbol));
	const tracked = unionSeriesIds(
		pageSeriesIds(homeWidgets, lookup, MARKET_LIMITS.maxSeries),
		notebookSeries,
		MARKET_LIMITS.maxPageTrackedSeries,
	);
	const keep = new Set([
		...distinctDashboardSeriesIds(homeWidgets),
		...homeListIds.flatMap((listId) => lookup(listId) ?? []),
		...notebookSeries,
		...watchlistSeries,
	]);
	return { tracked, keep: [...keep] };
}
