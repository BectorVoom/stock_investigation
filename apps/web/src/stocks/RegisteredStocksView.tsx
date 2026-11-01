import { type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ErrorNotice, Notice } from "../components/ui.tsx";
import type { VisibilitySource } from "../lib/polling.ts";
import { createStockDirectoryState } from "../watchlist/stockDirectory.ts";
import { storedDirectoryMarkets } from "../watchlist/watchlistModel.ts";
import { StockListSection } from "./StockListSection.tsx";
import { StockListsSection } from "./StockListsSection.tsx";
import { createWatchlistPageState } from "./watchlistState.ts";

/**
 * The Registered stocks page (ADR-0049 §2, ADR-0050 §4, ADR-0053): the
 * Watchlist's lists as tabs — each list's stocks with Remove from list,
 * and the list's own actions — then the stored stock lists' state. A
 * stock goes on and leaves the Watchlist from the Stocks page (its search,
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

			<StockListsSection directory={directory} />
		</div>
	);
}
