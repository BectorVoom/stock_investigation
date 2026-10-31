import type {
	Dataset,
	DatasetCell,
	EquityFilingView,
	EquityMetricCell,
	EquityMetricSeriesResponse,
	WidgetCore,
} from "@research/contracts";
import { EQUITY_METRICS, EQUITY_STATEMENTS, type EquityMetricCode } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	BarPlot,
	buildBarModel,
	ChartNotices,
	formatNumber,
	guardDataset,
	SafeLink,
} from "@research/ui-registry";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import type { ApiClient } from "../../api/client.ts";
import { DisclosureSummary, ErrorNotice, LABEL, Select } from "../../components/ui.tsx";
import { commonMessages } from "../../i18n/common.messages.ts";
import type { VisibilitySource } from "../../lib/polling.ts";
import { EQUITIES_HASH } from "../../router.ts";
import { TASK_LINK } from "../../tasks/TaskParts.tsx";
import {
	chartScaleExponent,
	formatMillions,
	formatPeriodEnd,
	scaledForChart,
} from "../financialFormat.ts";
import { metricEntryFor } from "../financialStore.ts";
import { financialsMessages } from "../financials.messages.ts";
import { FilingSources, UnavailableValue, unitCaption } from "../StatementTable.tsx";
import { sharedCurrency, valuesScope } from "../statementModel.ts";

type HistoryWidget = Extract<WidgetCore, { readonly type: "financial-history" }>;

/** A table cell with nothing to name (a missing value's period end or filing): a dash, never blank. */
const NONE = "—";

/** The picker's metrics grouped by statement, in registry order. */
const METRIC_GROUPS = EQUITY_STATEMENTS.map((statement) => ({
	statement,
	metrics: EQUITY_METRICS.filter((definition) => definition.statement === statement).map(
		(definition) => definition.code,
	),
}));

function isMetricCode(value: string): value is EquityMetricCode {
	return EQUITY_METRICS.some((definition) => definition.code === value);
}

/**
 * The bars' dataset: one row per fiscal year (oldest first), the value in
 * units of 10^exponent of the one currency (moved on the exact decimal
 * text), a missing year a null with its reason — drawn as a gap, never as 0.
 */
function historyDataset(
	response: EquityMetricSeriesResponse,
	exponent: number,
	words: {
		readonly axis: string;
		readonly metric: string;
		readonly unit: string;
		readonly year: (year: number) => string;
		readonly reason: (cell: EquityMetricCell) => string;
	},
): Dataset {
	return {
		datasetId: `financial-history-${response.company.companyId}`,
		title: words.metric,
		createdAt: response.dataUpdatedAt ?? "1970-01-01T00:00:00Z",
		columns: [
			{ key: "year", label: words.axis, kind: "text" },
			{ key: "value", label: words.metric, kind: "number", unit: words.unit },
		],
		rows: response.cells.map((cell) => {
			const scaled =
				cell.valueDecimal === null ? null : scaledForChart(cell.valueDecimal, exponent);
			const value: DatasetCell =
				scaled === null ? { v: null, reason: words.reason(cell) } : { v: scaled };
			return { year: { v: words.year(cell.fiscalYear) }, value };
		}),
	};
}

/**
 * The `financial-history` widget (ADR-0048 §8): one tracked company's
 * annual values of one metric as bars over fiscal years, drawn by the
 * registry's shared `BarPlot` (the same plot, colours and readout as a Chat
 * chart) inside its `ChartNotices`. A year without a value is a gap and is
 * named as not reported, never drawn as 0. The data-table twin lists every
 * year with its period end, exact rounded value and filing link; the cited
 * filings close the widget.
 *
 * One scale per chart: the axis counts in the unit `chartScaleExponent`
 * picks for the series (USD billions, 億円 …), named in the axis title, and
 * the ticks are plain grouped digits — the registry's compact ticks (400K,
 * 1.2M) would scale a second time. The data table stays in millions, like
 * the statement tables. Values in more than one currency are not charted:
 * one axis cannot measure two currencies, so the table is shown instead,
 * each value naming its currency.
 *
 * The registry's `ChartShell` is not used: its Sources list and citation
 * chips need evidence records (retrieval time, checksum) that a filing does
 * not have, and inventing them would show provenance that was never
 * recorded. The filings are linked directly instead.
 *
 * The metric picker saves the widget's `metric` (Undo restores it); while a
 * save is on its way it stays focusable and ignores changes. Values come
 * from the equities API only, through a read shared by every view of the
 * same metric (`metricEntryFor`) with its ETag.
 */
export function FinancialHistoryWidget(props: {
	readonly widget: HistoryWidget;
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	readonly editingDisabled: boolean;
	/** Saves the widget with a new choice; resolves false when refused. Absent: the choice is fixed. */
	readonly onSaveWidget?: (widget: WidgetCore) => Promise<boolean>;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const pickerId = createUniqueId();
	const [requested, setRequested] = createSignal<EquityMetricCode | null>(null);
	const metric = () => requested() ?? props.widget.metric;
	const entry = createMemo(() =>
		metricEntryFor(props.api, props.widget.companyId, metric(), props.widget.years),
	);
	createEffect(() => {
		const current = entry();
		onCleanup(current.attach(props.visibility));
	});

	/** A save of this widget or of the page is on its way: the picker waits. */
	const pending = (): boolean => props.editingDisabled || requested() !== null;
	const choose = (event: Event & { readonly currentTarget: HTMLSelectElement }): void => {
		const value = event.currentTarget.value;
		const save = props.onSaveWidget;
		if (save === undefined || !isMetricCode(value) || value === metric()) return;
		if (pending()) {
			// Still focusable while saving: undo the change rather than lose it silently mid-save.
			event.currentTarget.value = metric();
			return;
		}
		setRequested(value);
		void save({ ...props.widget, metric: value }).then(() => setRequested(null));
	};

	const response = () => entry().value();
	const cells = (): readonly EquityMetricCell[] => response()?.cells ?? [];
	const companyName = () => {
		const company = response()?.company;
		return company === undefined ? props.widget.title : (company.name ?? company.symbol);
	};
	const companyLine = () => {
		const company = response()?.company;
		return company === undefined
			? props.widget.title
			: m().companyLine(company.name ?? company.symbol, company.symbol);
	};
	/** The one currency of the values; null when they differ, "" when none has a value. */
	const currency = createMemo(() => sharedCurrency(cells()));
	/** The data table's unit: millions, like the statement tables. */
	const tableUnit = () => unitCaption(currency(), m());
	const exponent = createMemo(() =>
		chartScaleExponent(
			cells().flatMap((cell) => (cell.valueDecimal === null ? [] : [cell.valueDecimal])),
			locale(),
		),
	);
	/** The chart axis's unit, in the scale the values are drawn in. */
	const chartUnit = () => {
		const shared = currency();
		return shared === null || shared === "" ? tableUnit() : m().scaledUnitOf(shared, exponent());
	};
	/** A separate-only series of the profit metric is net income, not "attributable to owners". */
	const metricName = () =>
		valuesScope(cells()) === "separate"
			? m().metricInScope(metric(), "separate")
			: m().metric(metric());
	const title = () => m().chartTitle(metricName(), companyName());
	const filingsById = createMemo(
		() =>
			new Map<string, EquityFilingView>(
				(response()?.filings ?? []).map((filing) => [filing.filingId, filing] as const),
			),
	);
	const model = createMemo(() => {
		const current = response();
		if (current === undefined || currency() === null) return null;
		const data = guardDataset(
			historyDataset(current, exponent(), {
				axis: m().fiscalYearAxis,
				metric: metricName(),
				unit: chartUnit(),
				year: (year) => m().fiscalYear(year),
				reason: (cell) => m().reason(cell.unavailableReason ?? "not-reported"),
			}),
		);
		return buildBarModel(data, {
			categoryKey: "year",
			series: [{ key: "value", label: metricName() }],
			yUnit: chartUnit(),
		});
	});
	const missingYears = () =>
		cells()
			.filter((cell) => cell.valueDecimal === null)
			.map((cell) => m().fiscalYear(cell.fiscalYear));

	/** The data-table twin: every year with its period end, value in millions and filing. */
	const HistoryTable = (): JSX.Element => (
		<div class="overflow-x-auto">
			<table class="w-full border-collapse text-left text-sm" data-field="history-table">
				<caption class="sr-only">{m().dataTableCaption(metricName(), tableUnit())}</caption>
				<thead>
					<tr class="border-b border-slate-200 text-xs text-slate-700">
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().fiscalYearAxis}
						</th>
						<th scope="col" class="py-1 pr-2 font-medium">
							{m().periodEndColumn}
						</th>
						<th scope="col" class="py-1 pr-2 text-right font-medium">
							{m().valueColumn(tableUnit())}
						</th>
						<th scope="col" class="py-1 font-medium">
							{m().filingColumn}
						</th>
					</tr>
				</thead>
				<tbody>
					<For each={cells()}>
						{(cell) => {
							const filing = () =>
								cell.filingId === null ? null : (filingsById().get(cell.filingId) ?? null);
							return (
								<tr class="border-b border-slate-200" data-fiscal-year={cell.fiscalYear}>
									<th scope="row" class="py-1 pr-2 font-normal">
										{m().fiscalYear(cell.fiscalYear)}
									</th>
									<td class="py-1 pr-2 whitespace-nowrap">
										{cell.periodEnd === null ? NONE : formatPeriodEnd(cell.periodEnd, locale())}
									</td>
									<td class="py-1 pr-2 text-right whitespace-nowrap tabular-nums">
										<Show
											when={cell.valueDecimal === null ? null : formatMillions(cell.valueDecimal)}
											fallback={<UnavailableValue reason={cell.unavailableReason} />}
										>
											{(text) => (
												<>
													{text()}
													{/* With mixed currencies the caption cannot name one: each value does. */}
													<Show when={currency() === null ? cell.currency : null}>
														{(code) => ` ${code()}`}
													</Show>
													<Show when={cell.derived}>
														<span class="ml-1 text-2xs text-slate-600">{m().derivedMark}</span>
													</Show>
													<Show when={cell.reportedValueCount > 1}>
														<span class="ml-1 rounded border border-slate-500 px-0.5 text-2xs text-slate-800">
															{m().revisedMark}
														</span>
													</Show>
												</>
											)}
										</Show>
									</td>
									<td class="py-1">
										<Show when={filing()} fallback={NONE}>
											{(found) => (
												<SafeLink
													url={found().sourceUrl}
													label={m().openFiling(m().form(found().form), found().filedOn)}
												>
													{m().form(found().form)}
												</SafeLink>
											)}
										</Show>
									</td>
								</tr>
							);
						}}
					</For>
				</tbody>
			</table>
		</div>
	);

	return (
		<div
			class="flex flex-col gap-2"
			data-widget-kind="financial-history"
			data-company-id={props.widget.companyId}
			aria-busy={entry().loading()}
		>
			<div class="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
				<p
					class="min-w-0 flex-[1_1_10rem] truncate text-sm font-semibold text-slate-900"
					title={companyLine()}
				>
					{companyLine()}
				</p>
				<div class="w-full max-w-xs flex-[1_1_12rem]">
					<label for={pickerId} class={LABEL}>
						{m().metricPicker}
					</label>
					<Select
						id={pickerId}
						disabled={props.onSaveWidget === undefined}
						ariaDisabled={pending()}
						onChange={choose}
					>
						<For each={METRIC_GROUPS}>
							{(group) => (
								<optgroup label={m().statement(group.statement)}>
									<For each={group.metrics}>
										{(code) => (
											<option value={code} selected={code === metric()}>
												{m().metric(code)}
											</option>
										)}
									</For>
								</optgroup>
							)}
						</For>
					</Select>
				</div>
			</div>
			<Show
				when={!entry().missing()}
				fallback={
					<p class="text-sm text-slate-800" data-field="financial-not-found">
						{m().notFound}
					</p>
				}
			>
				<Show when={entry().failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().historyFailed}
							iconRetry
							onRetry={() => entry().refresh()}
						/>
					)}
				</Show>
				<Show
					when={response()}
					fallback={
						<Show when={entry().failure() === null}>
							<output aria-busy="true" class="block text-sm text-slate-600">
								{common().loadingThing(m().historyThing)}
							</output>
						</Show>
					}
				>
					{(current) => (
						<>
							<Show when={!current().company.tracked}>
								<p class="text-xs text-amber-900" data-field="financial-not-tracked">
									{m().notTracked}
								</p>
							</Show>
							<Show
								when={current().cells.length > 0}
								fallback={
									<div
										class="space-y-1 rounded border border-dashed border-slate-300 px-3 py-2"
										data-field="financial-no-data"
									>
										<p class="text-sm text-slate-800">{m().noDataYet}</p>
										<a href={EQUITIES_HASH} class={`${TASK_LINK} text-sm`}>
											{m().openEquities}
										</a>
									</div>
								}
							>
								<Show
									when={model()}
									fallback={
										<div data-field="financial-chart-withheld">
											<p class="text-xs text-slate-800" data-field="mixed-currency">
												{m().mixedCurrencyChart}
											</p>
											<HistoryTable />
										</div>
									}
								>
									{(bars) => (
										<figure class="m-0" data-field="financial-chart">
											<ChartNotices
												withheldSeries={bars().withheldSeries}
												missingColumns={bars().missingColumns}
												plottedCount={bars().plottedCount}
												unavailableCount={0}
												emptyMessage={m().notReportedYears(missingYears().join(", "))}
											>
												<BarPlot
													model={bars()}
													xLabel={m().fiscalYearAxis}
													yLabel={metricName()}
													yUnit={chartUnit()}
													title={title()}
													formatYTick={formatNumber}
												/>
											</ChartNotices>
											<Show when={missingYears().length > 0 && bars().plottedCount > 0}>
												<p class="mt-1 text-xs text-slate-700" data-field="not-reported-years">
													{m().notReportedYears(missingYears().join(", "))}
												</p>
											</Show>
											<details class="group mt-1 text-xs">
												<DisclosureSummary class="py-1 text-slate-700">
													{m().dataTableSummary}
												</DisclosureSummary>
												<HistoryTable />
											</details>
										</figure>
									)}
								</Show>
							</Show>
							<FilingSources filings={current().filings} />
						</>
					)}
				</Show>
			</Show>
		</div>
	);
}
