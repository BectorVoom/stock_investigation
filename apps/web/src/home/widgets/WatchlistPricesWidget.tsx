import type {
	MarketSeries,
	MarketWidgetCore,
	WatchlistResponse,
	WatchlistStock,
	WidgetSize,
} from "@research/contracts";
import { DASHBOARD_LIMITS, stockPriceSeriesId } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import type { ApiFailure } from "../../api/http.ts";
import { ErrorNotice } from "../../components/ui.tsx";
import { commonMessages } from "../../i18n/common.messages.ts";
import { WATCHLIST_HASH } from "../../router.ts";
import { TASK_LINK } from "../../tasks/TaskParts.tsx";
import { listStocks, stocksById } from "../../widgets/pageSeries.ts";
import { TwelveDataSessionNote } from "../HomeFrame.tsx";
import { marketWidgetMessages } from "./marketWidgets.messages.ts";
import {
	createSeriesViewer,
	type PriceColumns,
	PriceRow,
	PriceTableHead,
} from "./StockTableWidget.tsx";
import { watchlistPricesMessages } from "./watchlistPrices.messages.ts";

/**
 * The columns each size shows (ADR-0040 §5): Small is a glance (symbol and
 * percentage); Medium adds the last close, the change and the as-of date;
 * Large adds the source. A column that does not fit a narrow frame (a phone)
 * is hidden by a container query instead of scrolling sideways. Whole class
 * names, so the stylesheet build finds them.
 */
const SIZE_COLUMNS: { readonly [S in WidgetSize]: PriceColumns } = {
	small: { lastClose: null, change: null, changePercent: "", asOf: null, source: null },
	medium: {
		lastClose: "",
		change: "",
		changePercent: "",
		asOf: "hidden @md:table-cell",
		source: null,
	},
	large: {
		lastClose: "",
		change: "",
		changePercent: "",
		asOf: "hidden @md:table-cell",
		source: "hidden @2xl:table-cell",
	},
};

/** Rows a Small widget shows before the first measure (and outside a frame, as in tests). */
const SMALL_ROWS_FLOOR = 4;

/** The row a stock shows: its stock and its price series id. */
interface PriceRowEntry {
	readonly stock: WatchlistStock;
	readonly seriesId: string;
}

/**
 * Counts the rows of a Small widget that fit its frame's body: the body's
 * bottom less the first row's top and the room the lines after the table
 * keep, divided by one row's height. Re-measured when the frame resizes or
 * the lines after the table change.
 * Leaves the floor in place where nothing can be measured (no layout).
 */
function measureSmallRows(table: HTMLElement, onFit: (rows: number) => void): () => void {
	const body = table.closest(".wg-body");
	const root = table.closest('[data-widget-kind="watchlist-prices"]');
	if (!(body instanceof HTMLElement) || !(root instanceof HTMLElement)) return () => {};
	const fit = (): void => {
		const row = table.querySelector("tbody tr");
		if (!(row instanceof HTMLElement)) return;
		const rowHeight = row.getBoundingClientRect().height;
		if (!Number.isFinite(rowHeight) || rowHeight <= 0) return;
		// The "N more" line, the session note and the sources keep their room.
		const below = root.getBoundingClientRect().bottom - table.getBoundingClientRect().bottom;
		const available =
			body.getBoundingClientRect().bottom - row.getBoundingClientRect().top - Math.max(0, below);
		onFit(Math.max(1, Math.floor(available / rowHeight)));
	};
	fit();
	if (typeof ResizeObserver !== "function") return () => {};
	const observer = new ResizeObserver(fit);
	observer.observe(body);
	// The lines after the table (the sources, the session note, "N more")
	// change the room left: the root's size follows them.
	observer.observe(root);
	return () => observer.disconnect();
}

/**
 * One Watchlist list's stocks with their last close and the change from the
 * previous close (ADR-0040 §5), on Home and in the Notebook. The body always
 * shows the list's current title and its stock count, then one row per
 * stock in list order through the Stock table's row (`PriceRow`): each row
 * with data opens the detailed chart viewer; a row without data says
 * "unavailable (reason)", and a row past the page's series limit says
 * "Not shown: …" — computed by the page with the domain's `pageSeriesIds`,
 * the rule the API serves the page by. Loading, a failed watchlist load
 * (Try again), a deleted list and an empty list each have their own state.
 */
export function WatchlistPricesWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "watchlist-prices" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
	readonly watchlist: Accessor<WatchlistResponse | null>;
	readonly watchlistError: Accessor<ApiFailure | null>;
	readonly onRetryWatchlist: () => void;
	/** The series the page is served (`pageSeriesIds`); a row outside it is "Not shown". */
	readonly pageSeries: Accessor<ReadonlySet<string>>;
}): JSX.Element {
	const m = useMessages(watchlistPricesMessages);
	const tableText = useMessages(marketWidgetMessages);
	const common = useMessages(commonMessages);
	const viewer = createSeriesViewer(props.seriesById);
	const list = createMemo(
		() => props.watchlist()?.lists.find((entry) => entry.listId === props.widget.listId) ?? null,
	);
	/** The list's rows in list order, by series id (a string key keeps each row mounted across reloads). */
	const entries = createMemo((): ReadonlyMap<string, PriceRowEntry> => {
		const watchlist = props.watchlist();
		const current = list();
		if (watchlist === null || current === null) return new Map();
		return new Map(
			listStocks(current, stocksById(watchlist)).map((stock) => {
				const seriesId = stockPriceSeriesId(stock.market, stock.symbol);
				return [seriesId, { stock, seriesId }];
			}),
		);
	});
	const seriesIds = createMemo(() => [...entries().keys()]);
	const [smallFit, setSmallFit] = createSignal(SMALL_ROWS_FLOOR);
	const shownIds = createMemo(() =>
		props.widget.size === "small" ? seriesIds().slice(0, smallFit()) : seriesIds(),
	);
	const [table, setTable] = createSignal<HTMLTableElement | null>(null);
	// A Small widget shows the rows that fit its frame; a size change re-measures.
	createEffect(() => {
		const element = table();
		if (element === null || props.widget.size !== "small") return;
		onCleanup(measureSmallRows(element, setSmallFit));
	});
	const hiddenCount = () => seriesIds().length - shownIds().length;
	const columns = () => SIZE_COLUMNS[props.widget.size];
	const publishers = createMemo(() => {
		const seen = new Map<string, string>();
		for (const id of shownIds()) {
			const series = props.seriesById().get(id);
			// The source of the numbers shown: a series with observations.
			if (
				series !== undefined &&
				series.observations.length > 0 &&
				props.pageSeries().has(id) &&
				!seen.has(series.publisher)
			) {
				seen.set(series.publisher, series.sourceUrl);
			}
		}
		return [...seen.entries()].map(([publisher, url]) => ({ publisher, url }));
	});

	return (
		<div
			class="@container flex flex-col gap-1"
			data-widget-kind="watchlist-prices"
			data-list-id={props.widget.listId}
		>
			<Switch>
				<Match when={props.watchlist() === null && props.watchlistError()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().loadFailed}
							onRetry={() => props.onRetryWatchlist()}
						/>
					)}
				</Match>
				<Match when={props.watchlist() === null}>
					<output aria-busy="true" class="block text-sm text-slate-600">
						{common().loadingThing(m().watchlistThing)}
					</output>
				</Match>
				<Match when={list() === null}>
					<div class="space-y-1" data-field="watchlist-prices-deleted">
						<p class="text-sm text-slate-800">{m().deleted}</p>
						<p class="text-xs text-slate-700">{m().deletedHint}</p>
					</div>
				</Match>
				<Match when={list()}>
					{(current) => (
						<>
							<div class="flex items-baseline gap-2">
								<p class="min-w-0 flex-1 truncate text-sm font-semibold text-slate-900">
									{current().title}
								</p>
								<p class="shrink-0 text-xs text-slate-700" data-field="watchlist-prices-count">
									{m().stockCount(current().stockIds.length)}
								</p>
							</div>
							<Show
								when={seriesIds().length > 0}
								fallback={
									<div
										class="space-y-1 rounded border border-dashed border-slate-300 px-3 py-2"
										data-field="watchlist-prices-empty"
									>
										<p class="text-sm text-slate-800">{m().empty}</p>
										<a href={WATCHLIST_HASH} class={`${TASK_LINK} text-sm`}>
											{m().openWatchlist}
										</a>
									</div>
								}
							>
								<table
									ref={setTable}
									aria-label={m().tableLabel(current().title)}
									class="w-full border-collapse text-left text-sm"
								>
									<PriceTableHead columns={columns()} first={m().stock} />
									<tbody>
										<For each={shownIds()}>
											{(seriesId) => (
												<Show when={entries().get(seriesId)}>
													{(entry) => (
														<PriceRow
															series={props.seriesById().get(seriesId) ?? null}
															columns={columns()}
															label={{
																name: entry().stock.name,
																symbol: entry().stock.symbol,
															}}
															symbolOnly={props.widget.size === "small"}
															reasonClamp={
																props.widget.size === "small" ? "line-clamp-1" : "line-clamp-2"
															}
															notShown={
																props.pageSeries().has(seriesId)
																	? null
																	: m().notShown(DASHBOARD_LIMITS.maxSeries)
															}
															onOpen={(button) => viewer.open(seriesId, button)}
														/>
													)}
												</Show>
											)}
										</For>
									</tbody>
								</table>
								<Show when={hiddenCount() > 0}>
									<p class="text-xs text-slate-700" data-field="watchlist-prices-more">
										{m().moreRows(hiddenCount())}
									</p>
								</Show>
								<viewer.View />
								<TwelveDataSessionNote seriesIds={shownIds()} byId={props.seriesById} />
								<Show when={publishers().length > 0}>
									<p
										data-field="widget-footer"
										class="mt-1 border-t border-slate-200 pt-1 text-2xs text-slate-600"
									>
										{tableText().sources}
										<For each={publishers()}>
											{(entry, index) => (
												<>
													{index() > 0 ? ", " : ""}
													<SafeLink url={entry.url}>{entry.publisher}</SafeLink>
												</>
											)}
										</For>
									</p>
								</Show>
							</Show>
						</>
					)}
				</Match>
			</Switch>
		</div>
	);
}
