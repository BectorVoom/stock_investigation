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
import { TwelveDataSessionNote } from "../home/HomeFrame.tsx";
import { homeModelMessages } from "../home/homeModel.messages.ts";
import {
	formatValue,
	seriesMissingReason,
	staleFailureReason,
	summarizeSeries,
} from "../home/homeModel.ts";
import { marketWidgetMessages } from "../home/widgets/marketWidgets.messages.ts";
import { ChangeCell } from "../home/widgets/StockTableWidget.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { formatHash } from "../router.ts";
import { stockChartMessages } from "./stockChart.messages.ts";
import { stockPricesEntryFor } from "./stockReads.ts";
import type { StockTabProps } from "./stockTabs.ts";

/** Where "Open Home" leads: Home's widgets are what download a stock's prices. */
const HOME_HASH = formatHash({ view: "home", workspaceId: null, section: null, stock: null });

const LINK = "inline-flex min-h-6 items-center text-blue-800 underline pointer-coarse:min-h-11";

/** The viewer's series when there is nothing to draw (one shared value, never a new array). */
const NO_SERIES: readonly MarketSeries[] = [];

/**
 * The Stocks page's Chart tab (ADR-0049 §4): the stock's stored price
 * series (`GET /stocks/:stockId/prices`, through the shared per-stock read
 * of `stockReads.ts`), a summary line with the Stock table's numbers, and
 * the detailed chart viewer inline, opening at 1Y. The read is attached
 * only while the tab is shown (ADR-0049 §3 rule 4): a hidden panel makes no
 * request, and showing it again answers from the kept value at once and
 * re-checks conditionally. Nothing here queues a refresh.
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
	const series = createMemo(() => answer()?.series ?? null);
	const drawable = createMemo(() => (series()?.observations.length ?? 0) >= 2);
	const viewerSeries = createMemo((): readonly MarketSeries[] => {
		const current = series();
		return current !== null && drawable() ? [current] : NO_SERIES;
	});
	const summary = createMemo(() => {
		const current = series();
		if (current === null) return null;
		const summarized = summarizeSeries(current);
		return summarized.latest === null
			? null
			: { series: current, latest: summarized.latest, change: summarized.change };
	});
	const stale = () => {
		const current = series();
		return current === null ? null : staleFailureReason(current, modelText());
	};
	const symbol = () => props.stock().symbol;
	const stockLabel = () => {
		const stock = props.stock();
		return stock.name === null ? stock.symbol : `${stock.name} · ${stock.symbol}`;
	};
	const seriesById = createMemo((): ReadonlyMap<string, MarketSeries> => {
		const current = series();
		return current === null ? new Map() : new Map([[current.seriesId, current]]);
	});
	const seriesIds = createMemo(() => {
		const current = series();
		return current === null ? [] : [current.seriesId];
	});

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
				<Match when={answer()?.series === null}>
					<p class="text-sm text-slate-700" data-field="stock-chart-none">
						{m().noPrices(symbol())}{" "}
						<a href={HOME_HASH} class={LINK}>
							{m().openHome}
						</a>
					</p>
				</Match>
				<Match when={summary() === null}>
					<p class="text-sm text-amber-900" data-field="stock-chart-unavailable">
						{common().unavailable(seriesMissingReason(series(), modelText()))}
					</p>
				</Match>
			</Switch>
			<Show when={summary()}>
				{(current) => (
					<dl
						aria-label={m().summaryLabel}
						data-field="stock-chart-summary"
						class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm"
					>
						<div class="flex items-baseline gap-1">
							<dt class="text-xs text-slate-600">{columns().lastClose}</dt>
							<dd class="font-semibold tabular-nums">
								{formatValue(current().latest.value)}{" "}
								<span class="text-xs font-normal text-slate-600">{current().series.unit}</span>
							</dd>
						</div>
						<div class="flex items-baseline gap-1">
							<dt class="text-xs text-slate-600">{columns().change}</dt>
							<dd class="tabular-nums">
								<ChangeCell change={current().change} unit={current().series.unit} kind="abs" />
								{/* A missing change says its reason once, not once per cell. */}
								<Show when={current().change.ok}>
									{" "}
									(
									<ChangeCell change={current().change} unit={current().series.unit} kind="pct" />)
								</Show>
							</dd>
						</div>
						<div class="flex items-baseline gap-1">
							<dt class="text-xs text-slate-600">{columns().asOf}</dt>
							<dd class="text-xs">
								<time dateTime={current().latest.observedOn}>{current().latest.observedOn}</time>
							</dd>
						</div>
						<div class="flex items-baseline gap-1">
							<dt class="text-xs text-slate-600">{columns().source}</dt>
							<dd class="text-xs">
								<SafeLink url={current().series.sourceUrl}>{current().series.publisher}</SafeLink>
							</dd>
						</div>
					</dl>
				)}
			</Show>
			<Show when={stale()}>
				{(reason) => <p class="text-xs text-amber-900">{columns().lastRefreshFailed(reason())}</p>}
			</Show>
			<TwelveDataSessionNote seriesIds={seriesIds()} byId={seriesById} />
			<Show when={summary() !== null && !drawable()}>
				<Notice tone="info" data-field="stock-chart-one-close">
					{m().oneClose}
				</Notice>
			</Show>
			<Show when={drawable()}>
				<LazyInlineChartViewer
					title={m().chartTitle(stockLabel())}
					series={viewerSeries}
					initialPreset="1y"
					headingLevel={4}
				/>
			</Show>
		</div>
	);
}
