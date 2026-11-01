import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { For, type JSX, Show } from "solid-js";
import { ErrorNotice, Section } from "../components/ui.tsx";
import type { StockDirectoryState } from "../watchlist/stockDirectory.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { directoryStatusLine } from "../watchlist/watchlistModel.ts";
import { stocksMessages } from "./stocks.messages.ts";

/**
 * "Stock lists" (銘柄一覧) on the Registered stocks page (ADR-0050 §4): each
 * market's stored stock list — the lists the Stocks page's search reads —
 * with its count, date and source, a running download and the last
 * failure. The server downloads the lists on its own schedule (ADR-0053):
 * this section only shows their state.
 */
export function StockListsSection(props: { readonly directory: StockDirectoryState }): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);

	return (
		<Section title={s().stockListsTitle}>
			<p class="text-xs text-slate-700">{s().stockListsHint}</p>
			<div data-field="stock-lists" class="mt-2">
				<div class="min-w-0 space-y-0.5 text-xs text-slate-700" data-field="directory-status">
					<Show when={props.directory.status()}>
						{(current) => (
							<For each={current().markets}>
								{(entry) => (
									<p data-market={entry.market}>
										{directoryStatusLine(entry, model())}{" "}
										<span>
											{m().sourceColumn}:{" "}
											<SafeLink url={entry.sourceUrl}>{entry.publisher}</SafeLink>
										</span>
									</p>
								)}
							</For>
						)}
					</Show>
				</div>
			</div>
			<Show when={props.directory.failure()}>
				{(error) => (
					<div class="mt-2">
						<ErrorNotice
							failure={error()}
							title={m().directoryLoadFailed}
							onRetry={() => props.directory.start()}
						/>
					</div>
				)}
			</Show>
		</Section>
	);
}
