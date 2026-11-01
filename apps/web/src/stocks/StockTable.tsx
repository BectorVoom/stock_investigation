import type { WatchlistStock } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createMemo, For, type JSX, Show } from "solid-js";
import { BUTTON_DANGER } from "../components/ui.tsx";
import { stockHash } from "../router.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { stocksMessages } from "./stocks.messages.ts";

/** What the table's rows need from the list they show (ADR-0040 §7). */
export interface StockTableList {
	readonly title: string;
	/** True while a write of the page is on its way: the row buttons wait. */
	readonly busy: boolean;
	/** Remove from list: the stock leaves this list only (it stays on the Watchlist). */
	readonly onRemove: (stock: WatchlistStock) => void;
}

function Row(props: {
	readonly stock: () => WatchlistStock;
	readonly list: StockTableList;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);
	const listText = useMessages(watchlistListsMessages);
	const stock = (): WatchlistStock => props.stock();
	return (
		<tr class="border-b border-slate-200 align-top" data-stock-id={stock().stockId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<span class="block font-mono">{stock().symbol}</span>
				{/* The stock's chart, statements, company and news are on the Stocks page. */}
				<a
					href={stockHash(stock().stockId)}
					class="block min-h-6 font-normal text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
					data-show-stock={stock().stockId}
				>
					{stock().name ?? s().showUnnamed(stock().symbol)}
				</a>
			</th>
			<td class="py-1 pr-2">{model().marketName(stock().market)}</td>
			<td class="py-1">
				<button
					type="button"
					class={`${BUTTON_DANGER} whitespace-nowrap`}
					aria-label={listText().removeFromListNamed(stock().symbol, props.list.title)}
					data-remove-stock={stock().stockId}
					disabled={props.list.busy}
					onClick={() => props.list.onRemove(stock())}
				>
					{listText().removeFromList}
				</button>
			</td>
		</tr>
	);
}

/**
 * One list's table on Registered stocks (ADR-0040 §7, ADR-0054): symbol and
 * name — the name links to the stock on the Stocks page — its market, and
 * Remove from list (the tab already names the list). Earnings dates and
 * financial statements are on the Stocks page and its widgets; the
 * server syncs both, so no row offers a sync.
 */
export function StockTable(props: {
	readonly stocks: readonly WatchlistStock[];
	readonly caption: string;
	readonly list: StockTableList;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	// Keyed by stock id (a string), so a re-read that rebuilds the stock
	// objects keeps every row's elements and only updates what changed.
	const ids = createMemo(() => props.stocks.map((stock) => stock.stockId));
	const byId = createMemo(
		() => new Map(props.stocks.map((stock) => [stock.stockId, stock] as const)),
	);
	return (
		<div class="overflow-x-auto">
			<table class="mt-1 w-full border-collapse text-left text-xs" data-field="stocks">
				{/* The table's name for screen readers only (ADR-0050 §5): the section heading and tabs already say what it lists. */}
				<caption class="sr-only">{props.caption}</caption>
				<thead>
					<tr class="border-b border-slate-300">
						<th scope="col" class="pr-2">
							{m().symbol}
						</th>
						<th scope="col" class="pr-2">
							{m().market}
						</th>
						<th scope="col">{m().actionsColumn}</th>
					</tr>
				</thead>
				<tbody>
					<For each={ids()}>
						{(stockId) => (
							<Show when={byId().get(stockId)}>
								{(stock) => <Row stock={stock} list={props.list} />}
							</Show>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}
