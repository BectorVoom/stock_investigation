import type { MarketSeries } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import {
	createEffect,
	createMemo,
	type JSX,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { LazyInlineChartViewer, preloadChartViewer } from "../chartViewer/LazyChartViewer.tsx";
import { ErrorNotice, Loading, Notice } from "../components/ui.tsx";
import { homeModelMessages } from "../home/homeModel.messages.ts";
import { seriesMissingReason, staleFailureReason } from "../home/homeModel.ts";
import { marketWidgetMessages } from "../home/widgets/marketWidgets.messages.ts";
import { commonMessages } from "../i18n/common.messages.ts";
import { stockChartMessages } from "./stockChart.messages.ts";
import { rereadWhileAwaiting, stockPricesEntryFor, stockProfileEntryFor } from "./stockReads.ts";
import type { StockTabProps } from "./stockTabs.ts";

/** The viewer's series when there is nothing to draw (one shared value, never a new array). */
const NO_SERIES: readonly MarketSeries[] = [];

/**
 * The Stocks page's Chart tab (ADR-0049 §4): the stock's stored price
 * series (`GET /stocks/:stockId/prices`, through the shared per-stock read
 * of `stockReads.ts`) in the detailed chart viewer inline, opening at 1Y
 * in candlesticks when the stored prices carry bars (ADR-0056 §6; else in
 * a line), with no heading or summary line of its own: the page heading
 * names the stock (the viewer's region carries it only as its accessible
 * name), and the viewer's readout and statistics give the close, the
 * change and the dates. The read is attached
 * only while the tab is shown (ADR-0049 §3 rule 4): a hidden panel makes no
 * request, and showing it again answers from the kept value at once and
 * re-checks conditionally. Nothing here queues a refresh: the server
 * downloads the daily prices of every stock in the stored stock lists,
 * whether or not it is on the Watchlist (ADR-0058 §2), so while a stock has
 * none stored yet the tab says they are on the way and re-reads sooner (5 s,
 * doubling to the usual re-check) until they arrive. Only then does it read
 * the stock's profile (shared with the Company tab), to tell a stock outside
 * the stored stock lists — whose prices never come — from one still
 * waiting. Below a drawn chart, the stored series' publisher links to its
 * source (Massive, J-Quants); a Japanese stock's chart adds that J-Quants
 * Free ends about 12 weeks ago (ADR-0058 §6).
 *
 * Re-renders: the viewer mounts once per panel and receives the series
 * through a memo keyed by the series object, which the read replaces only
 * when an answer changed — an unchanged 304 and the page's list re-reads
 * (a new `stock()` for the same stock) leave the viewer untouched.
 */
export function ChartTab(props: StockTabProps): JSX.Element {
	const m = useMessages(stockChartMessages);
	const columns = useMessages(marketWidgetMessages);
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);

	// The page disposes the panels when another stock is chosen, but the
	// stock accessor also updates for the same stock: key on the id alone.
	const stockId = createMemo(() => props.stock().stockId);
	const entry = createMemo(() => stockPricesEntryFor(props.api, stockId()));
	createEffect(() => {
		if (!props.active()) return;
		const current = entry();
		onCleanup(current.attach(props.visibility));
	});
	// The viewer's chunk downloads beside the first read, not after it.
	onMount(preloadChartViewer);

	const answer = () => entry().value();
	const noneStored = createMemo(() => answer()?.series === null);
	// The profile says whether the stock is in the stored stock lists; it is
	// read only while no prices are stored (with prices, the answer is moot).
	const profile = createMemo(() => stockProfileEntryFor(props.api, stockId()));
	createEffect(() => {
		if (!props.active() || !noneStored()) return;
		const current = profile();
		onCleanup(current.attach(props.visibility));
	});
	/** Not in the stored stock lists: no price will come. Unknown (not read, failed) counts as listed. */
	const notListed = createMemo(() => profile().value()?.directory === null);
	/** A listed stock whose first prices the server has not downloaded yet. */
	const awaitingPrices = createMemo(() => props.active() && noneStored() && !notListed());
	rereadWhileAwaiting({ entry, visibility: props.visibility, awaiting: awaitingPrices });
	const series = createMemo(() => answer()?.series ?? null);
	const drawable = createMemo(() => (series()?.observations.length ?? 0) >= 2);
	const viewerSeries = createMemo((): readonly MarketSeries[] => {
		const current = series();
		return current !== null && drawable() ? [current] : NO_SERIES;
	});
	/** A stored series with at least one close (an empty one says why it is unavailable). */
	const hasClose = createMemo(() => (series()?.observations.length ?? 0) > 0);
	const stale = () => {
		const current = series();
		return current === null ? null : staleFailureReason(current, modelText());
	};
	const symbol = () => props.stock().symbol;
	const stockLabel = () => {
		const stock = props.stock();
		return stock.name === null ? stock.symbol : `${stock.name} · ${stock.symbol}`;
	};

	return (
		<div class="space-y-3" data-field="stock-chart-tab">
			<Show when={entry().failure()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title={m().pricesFailed}
						onRetry={() => entry().refresh()}
					/>
				)}
			</Show>
			<Switch>
				<Match when={answer() === undefined}>
					<Show when={entry().failure() === null}>
						<Loading label={m().pricesThing} />
					</Show>
				</Match>
				<Match when={noneStored()}>
					<p
						class="text-sm text-slate-700"
						data-field="stock-chart-none"
						data-listed={notListed() ? "false" : "true"}
					>
						{notListed() ? m().noPricesNotListed(symbol()) : m().noPricesYet(symbol())}
					</p>
				</Match>
				<Match when={!hasClose()}>
					<p class="text-sm text-amber-900" data-field="stock-chart-unavailable">
						{common().unavailable(seriesMissingReason(series(), modelText()))}
					</p>
				</Match>
			</Switch>
			<Show when={stale()}>
				{(reason) => <p class="text-xs text-amber-900">{columns().lastRefreshFailed(reason())}</p>}
			</Show>
			<Show when={hasClose() && !drawable()}>
				<Notice tone="info" data-field="stock-chart-one-close">
					{m().oneClose}
				</Notice>
			</Show>
			<Show when={drawable()}>
				<LazyInlineChartViewer
					title={stockLabel()}
					series={viewerSeries}
					initialPreset="1y"
					initialChartType="candlestick"
				/>
			</Show>
			<Show when={hasClose() ? series() : null}>
				{(stored) => (
					<p class="text-2xs text-slate-600" data-field="stock-chart-source">
						{m().source}
						<SafeLink url={stored().sourceUrl}>{stored().publisher}</SafeLink>
					</p>
				)}
			</Show>
			<Show when={props.stock().market === "JP" && answer() !== undefined}>
				<p class="text-2xs text-slate-600" data-field="stock-chart-japanese-delay">
					{m().japaneseDelay}
				</p>
			</Show>
		</div>
	);
}
