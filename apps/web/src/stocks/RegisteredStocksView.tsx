import { type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ErrorNotice, Notice } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { createStockDirectoryState } from "../watchlist/stockDirectory.ts";
import { storedDirectoryMarkets } from "../watchlist/watchlistModel.ts";
import { StockListSection } from "./StockListSection.tsx";
import { createWatchlistPageState } from "./watchlistState.ts";

/**
 * The Registered stocks page (ADR-0049 §2, ADR-0050 §4, ADR-0054): the
 * Watchlist's lists as tabs — each list's stocks with Remove from list,
 * and the list's own actions. The stored market stock lists are read only
 * for the list dialog's search (the 銘柄一覧 area was removed at the
 * owner's request; the server downloads the lists). A stock goes on and leaves the Watchlist from the Stocks page (its search,
 * Add to Watchlist and Remove from Watchlist) or a list's Add stock
 * dialog. A row's name opens the stock on the Stocks page, where its
 * earnings dates and financial statements are shown. The page only reads:
 * the server syncs earnings dates, financial statements, the stock lists
 * and the Google Calendar on its own schedule.
 */
export function RegisteredStocksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const watch = createWatchlistPageState({ api: props.api, visibility: props.visibility });
	const directory = createStockDirectoryState({
		api: props.api,
		visibility: props.visibility,
	});
	onCleanup(() => directory.dispose());
	onMount(() => {
		directory.start();
		watch.start();
	});

	return (
		<div class="space-y-3" data-page="registered">
			<Show when={watch.failure()}>
				{(current) => (
					<ErrorNotice
						failure={current().error}
						title={current().title}
						onRetry={current().retry}
					/>
				)}
			</Show>
			<Show when={watch.notice()}>
				{(current) => <Notice tone="info">{current().text}</Notice>}
			</Show>

			<StockListSection
				api={props.api}
				data={watch.data}
				loading={watch.loading}
				storedMarkets={() => storedDirectoryMarkets(directory.status())}
				onWritten={watch.reloadAfterWrite}
				onStockWatched={watch.afterStockWatched}
			/>
		</div>
	);
}
