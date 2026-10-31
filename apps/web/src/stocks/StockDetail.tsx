import { STOCK_TABS, type StockTab } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	ErrorBoundary,
	For,
	type JSX,
	lazy,
	onCleanup,
	Show,
	Suspense,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { focusTab, Tabs, tabElementId } from "../components/Tabs.tsx";
import { BUTTON, HEADING, Loading, PANEL } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import type { FinancialsActions } from "./FinancialsTab.tsx";
import { stockProfileEntryFor } from "./stockReads.ts";
import { stocksMessages } from "./stocks.messages.ts";
import { detailName } from "./stocksModel.ts";
import type { SelectedStock, StockTabProps } from "./stockTabs.ts";

/**
 * Each tab is its own chunk (ADR-0049 §3 rule 1), downloaded on its first
 * showing; pointer-enter or focus on its tab preloads it. Solid's `lazy`
 * keeps one download per chunk and forgets a failed one, so the panel's
 * Try again imports it afresh.
 */
const CHART_TAB = lazy(() =>
	import("./ChartTab.tsx").then((module) => ({ default: module.ChartTab })),
);
const FINANCIALS_TAB = lazy(() =>
	import("./FinancialsTab.tsx").then((module) => ({ default: module.FinancialsTab })),
);
const COMPANY_TAB = lazy(() =>
	import("./CompanyTab.tsx").then((module) => ({ default: module.CompanyTab })),
);
const NEWS_TAB = lazy(() =>
	import("./NewsTab.tsx").then((module) => ({ default: module.NewsTab })),
);

/** Starts downloading a tab's chunk (idempotent; a failure is shown when the tab is shown). */
export function preloadStockTab(tab: StockTab): void {
	const chunk =
		tab === "chart"
			? CHART_TAB
			: tab === "financials"
				? FINANCIALS_TAB
				: tab === "company"
					? COMPANY_TAB
					: NEWS_TAB;
	chunk.preload().then(
		() => undefined,
		() => undefined,
	);
}

/** The DOM ids of the stock tab strip (`stock-tab-chart`) and its panels (`stock-panel-chart`). */
export const STOCK_TAB_PREFIX = "stock-tab";
export function stockPanelId(tab: StockTab): string {
	return `stock-panel-${tab}`;
}

/** The detail heading's DOM id: the page moves focus here when a stock is chosen. */
export const STOCK_DETAIL_HEADING_ID = "stock-detail-heading";

/**
 * The selected stock (ADR-0049 §3): a section headed with its name and
 * symbol, the tab strip, and one panel per tab. A panel mounts on its first
 * showing and stays mounted (hidden) while this stock stays selected, so
 * switching back keeps its state; the page keys this component by stock id,
 * so choosing another stock disposes every panel. A hidden panel's
 * `active()` is false, which stops its re-checks (rule 4). The heading
 * reads the stored directory entry only when the page knows no name.
 */
export function StockDetail(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	readonly stock: Accessor<SelectedStock>;
	readonly tab: Accessor<StockTab>;
	readonly onSelectTab: (tab: StockTab) => void;
	readonly financials: FinancialsActions;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const locale = useLocale();
	const profile = stockProfileEntryFor(props.api, props.stock().stockId);
	// The profile names a stock neither list does (a URL to a stock the owner
	// does not follow); with a stored name nothing is read for the heading.
	// A memo, so a list re-read (a new stock object, the same answer) does not
	// release and re-attach the read — which would read it again.
	const needsProfile = createMemo(() => props.stock().name === null);
	createEffect(() => {
		if (needsProfile()) onCleanup(profile.attach(props.visibility));
	});
	/** The stored name, or null: the heading then shows the symbol alone (never "ZZZZ · ZZZZ"). */
	const name = createMemo(() =>
		detailName(props.stock().name, profile.value()?.directory ?? null, locale()),
	);
	const headingText = (): string => {
		const known = name();
		return known === null ? props.stock().symbol : s().detailHeading(known, props.stock().symbol);
	};
	/**
	 * A panel's own "open that tab" (Company's "Open Financial statements"):
	 * the tab is selected and takes the focus, which would otherwise stay on
	 * a button in the panel now hidden (and fall to the page).
	 */
	const selectTabFromPanel = (tab: StockTab): void => {
		props.onSelectTab(tab);
		queueMicrotask(() => focusTab(STOCK_TAB_PREFIX, tab));
	};
	const [mounted, setMounted] = createSignal<ReadonlySet<StockTab>>(new Set([props.tab()]));
	createEffect(() => {
		const tab = props.tab();
		if (!mounted().has(tab)) setMounted((current) => new Set([...current, tab]));
	});
	const tabs = createMemo(() => STOCK_TABS.map((tab) => ({ key: tab, label: s().tab(tab) })));

	return (
		<section
			aria-labelledby={STOCK_DETAIL_HEADING_ID}
			class={PANEL}
			data-field="stock-detail"
			data-stock-id={props.stock().stockId}
		>
			<h3
				id={STOCK_DETAIL_HEADING_ID}
				tabIndex={-1}
				class={`${HEADING} scroll-mt-4 outline-none`}
				data-field="stock-detail-heading"
			>
				{headingText()}
			</h3>
			<div class="mt-2">
				<Tabs
					label={s().tabsLabel(name() ?? props.stock().symbol)}
					idPrefix={STOCK_TAB_PREFIX}
					tabs={tabs()}
					selected={props.tab()}
					panelId={stockPanelId}
					onSelect={(tab) => props.onSelectTab(tab)}
					onPreload={preloadStockTab}
				/>
			</div>
			<For each={STOCK_TABS}>
				{(tab) => {
					const active = () => props.tab() === tab;
					return (
						<div
							id={stockPanelId(tab)}
							role="tabpanel"
							aria-labelledby={tabElementId(STOCK_TAB_PREFIX, tab)}
							// biome-ignore lint/a11y/noNoninteractiveTabindex: the WAI-ARIA tabs pattern puts a panel in the tab order (ADR-0049 §3)
							tabIndex={0}
							hidden={!active()}
							class="pt-3"
							data-tab-panel={tab}
						>
							<Show when={mounted().has(tab)}>
								<TabPanel
									tab={tab}
									props={{
										api: props.api,
										visibility: props.visibility,
										stock: props.stock,
										active,
										onSelectTab: selectTabFromPanel,
									}}
									financials={props.financials}
								/>
							</Show>
						</div>
					);
				}}
			</For>
		</section>
	);
}

/** One tab's chunk with its loading line and, when the download fails, Try again. */
function TabPanel(props: {
	readonly tab: StockTab;
	readonly props: StockTabProps;
	readonly financials: FinancialsActions;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const common = useMessages(commonMessages);
	return (
		<ErrorBoundary
			fallback={(_error: unknown, reset) => (
				<div
					role="alert"
					class="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900"
				>
					<p>{s().tabFailed}</p>
					<button type="button" class={`${BUTTON} mt-1`} onClick={() => reset()}>
						{common().tryAgain}
					</button>
				</div>
			)}
		>
			<Suspense fallback={<Loading label={s().tabThing(props.tab)} />}>
				{(() => {
					switch (props.tab) {
						case "chart":
							return <CHART_TAB {...props.props} />;
						case "financials":
							return <FINANCIALS_TAB {...props.props} actions={props.financials} />;
						case "company":
							return <COMPANY_TAB {...props.props} actions={props.financials} />;
						case "news":
							return <NEWS_TAB {...props.props} />;
					}
				})()}
			</Suspense>
		</ErrorBoundary>
	);
}
