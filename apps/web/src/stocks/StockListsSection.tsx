import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { For, type JSX, Show } from "solid-js";
import { BUTTON, ErrorNotice, Section } from "../components/ui.tsx";
import type { StockDirectoryState } from "../watchlist/stockDirectory.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { directoryStatusLine } from "../watchlist/watchlistModel.ts";
import { stocksMessages } from "./stocks.messages.ts";

/**
 * "Stock lists" (銘柄一覧) on the Registered stocks page (ADR-0050 §4): each
 * market's stored stock list — the lists the Stocks page's search reads —
 * with its count, date and source, and "Update stock list". The page
 * downloads a missing or old list once per visit (`createStockDirectoryState`);
 * this section shows the state and the failures.
 */
export function StockListsSection(props: { readonly directory: StockDirectoryState }): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);
	const allDirectoryRunsActive = () =>
		props.directory.status()?.markets.every((entry) => entry.activeRunId !== null) ?? false;

	return (
		<Section title={s().stockListsTitle}>
			<p class="text-xs text-slate-700">{s().stockListsHint}</p>
			<div data-field="stock-lists" class="mt-2 flex flex-wrap items-start justify-between gap-2">
				<div
					class="min-w-0 flex-1 space-y-0.5 text-xs text-slate-700"
					data-field="directory-status"
				>
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
					<output class="block">
						{props.directory.queuedByOwner() ? m().directoryQueued : ""}
					</output>
				</div>
				<button
					type="button"
					class={BUTTON}
					disabled={props.directory.queuing() || allDirectoryRunsActive()}
					onClick={() => props.directory.update()}
				>
					{m().updateStockList}
				</button>
			</div>
			<Show when={props.directory.failure()}>
				{(current) => (
					<div class="mt-2">
						<ErrorNotice
							failure={current().error}
							title={current().action === "load" ? m().directoryLoadFailed : m().directoryNotQueued}
							onRetry={current().action === "load" ? () => props.directory.start() : undefined}
						/>
					</div>
				)}
			</Show>
		</Section>
	);
}
