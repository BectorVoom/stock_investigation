import type {
	Dataset,
	DatasetCell,
	EquityFilingView,
	EquityMetricSeriesResponse,
	WidgetCore,
} from "@research/contracts";
import { EQUITY_METRICS, EQUITY_STATEMENTS, type EquityMetricCode } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	BarPlot,
	buildBarModel,
	ChartNotices,
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
import { formatMillions, formatPeriodEnd, millionsForChart } from "../financialFormat.ts";
import { metricEntryFor } from "../financialStore.ts";
import { financialsMessages } from "../financials.messages.ts";
import { FilingSources, UnavailableValue, unitCaption } from "../StatementTable.tsx";
import { sharedCurrency } from "../statementModel.ts";

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
 * whole millions (exact: rounded from the decimal text), a missing year a
 * null with its reason — drawn as a gap, never as 0.
 */
function historyDataset(
	response: EquityMetricSeriesResponse,
	words: {
		readonly axis: string;
		readonly metric: string;
		readonly unit: string;
		readonly year: (year: number) => string;
		readonly reason: (cell: EquityMetricSeriesResponse["cells"][number]) => string;
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
			const millions = cell.valueDecimal === null ? null : millionsForChart(cell.valueDecimal);
			const value: DatasetCell =
				millions === null ? { v: null, reason: words.reason(cell) } : { v: millions };
			return { year: { v: words.year(cell.fiscalYear) }, value };
		}),
	};
}

/**
 * The `financial-history` widget (ADR-0048 §8): one tracked company's
 * annual values of one metric as bars over fiscal years, drawn by the
 * registry's shared `BarPlot` (the same plot, ticks, colours and readout as
 * a Chat chart) inside its `ChartNotices`. A year without a value is a gap
 * and is named as not reported, never drawn as 0. The data-table twin lists
 * every year with its period end, exact rounded value and filing link; the
 * cited filings close the widget.
 *
 * The registry's `ChartShell` is not used: its Sources list and citation
 * chips need evidence records (retrieval time, checksum) that a filing does
 * not have, and inventing them would show provenance that was never
 * recorded. The filings are linked directly instead.
 *
 * The metric picker saves the widget's `metric` (Undo restores it); values
 * come from the equities API only, through a read shared by every view of
 * the same metric (`metricEntryFor`) with its ETag.
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

	const choose = (event: Event & { readonly currentTarget: HTMLSelectElement }): void => {
		const value = event.currentTarget.value;
		const save = props.onSaveWidget;
		if (save === undefined || !isMetricCode(value) || value === metric()) return;
		setRequested(value);
		void save({ ...props.widget, metric: value }).then(() => setRequested(null));
	};

	const response = () => entry().value();
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
	const unit = () => unitCaption(sharedCurrency(response()?.cells ?? []), m());
	const metricName = () => m().metric(metric());
	const title = () => m().chartTitle(metricName(), companyName());
	const filingsById = createMemo(
		() =>
			new Map<string, EquityFilingView>(
				(response()?.filings ?? []).map((filing) => [filing.filingId, filing] as const),
			),
	);
	const dataset = createMemo(() => {
		const current = response();
		if (current === undefined) return null;
		return guardDataset(
			historyDataset(current, {
				axis: m().fiscalYearAxis,
				metric: metricName(),
				unit: unit(),
				year: (year) => m().fiscalYear(year),
				reason: (cell) => m().reason(cell.unavailableReason ?? "not-reported"),
			}),
		);
	});
	const model = createMemo(() => {
		const data = dataset();
		return data === null
			? null
			: buildBarModel(data, {
					categoryKey: "year",
					series: [{ key: "value", label: metricName() }],
					yUnit: unit(),
				});
	});
	const missingYears = () =>
		(response()?.cells ?? [])
			.filter((cell) => cell.valueDecimal === null)
			.map((cell) => m().fiscalYear(cell.fiscalYear));

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
						disabled={
							props.onSaveWidget === undefined || props.editingDisabled || requested() !== null
						}
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
								when={current().cells.length > 0 ? model() : null}
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
												yUnit={unit()}
												title={title()}
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
											<div class="overflow-x-auto">
												<table
													class="w-full border-collapse text-left text-sm"
													data-field="history-table"
												>
													<caption class="sr-only">
														{m().dataTableCaption(metricName(), unit())}
													</caption>
													<thead>
														<tr class="border-b border-slate-200 text-xs text-slate-700">
															<th scope="col" class="py-1 pr-2 font-medium">
																{m().fiscalYearAxis}
															</th>
															<th scope="col" class="py-1 pr-2 font-medium">
																{m().periodEndColumn}
															</th>
															<th scope="col" class="py-1 pr-2 text-right font-medium">
																{m().valueColumn(unit())}
															</th>
															<th scope="col" class="py-1 font-medium">
																{m().filingColumn}
															</th>
														</tr>
													</thead>
													<tbody>
														<For each={current().cells}>
															{(cell) => {
																const filing = () =>
																	cell.filingId === null
																		? null
																		: (filingsById().get(cell.filingId) ?? null);
																return (
																	<tr
																		class="border-b border-slate-200"
																		data-fiscal-year={cell.fiscalYear}
																	>
																		<th scope="row" class="py-1 pr-2 font-normal">
																			{m().fiscalYear(cell.fiscalYear)}
																		</th>
																		<td class="py-1 pr-2 whitespace-nowrap">
																			{cell.periodEnd === null
																				? NONE
																				: formatPeriodEnd(cell.periodEnd, locale())}
																		</td>
																		<td class="py-1 pr-2 text-right whitespace-nowrap tabular-nums">
																			<Show
																				when={
																					cell.valueDecimal === null
																						? null
																						: formatMillions(cell.valueDecimal)
																				}
																				fallback={
																					<UnavailableValue reason={cell.unavailableReason} />
																				}
																			>
																				{(text) => (
																					<>
																						{text()}
																						<Show when={cell.derived}>
																							<span class="ml-1 text-2xs text-slate-600">
																								{m().derivedMark}
																							</span>
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
																						label={m().openFiling(
																							m().form(found().form),
																							found().filedOn,
																						)}
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
										</details>
									</figure>
								)}
							</Show>
							<FilingSources filings={current().filings} />
						</>
					)}
				</Show>
			</Show>
		</div>
	);
}
