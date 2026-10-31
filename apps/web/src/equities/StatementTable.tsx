import type {
	EquityFilingView,
	EquityMetricCell,
	EquityStatementResponse,
} from "@research/contracts";
import type { EquityMetricCode, EquityUnavailableReason } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { DisclosureSummary } from "../components/ui.tsx";
import { formatMillions, formatPeriodEnd } from "./financialFormat.ts";
import { financialsMessages } from "./financials.messages.ts";
import {
	isMarkedSeparate,
	isRevised,
	type StatementRow,
	statementTableModel,
	yearColumnClass,
} from "./statementModel.ts";
import { type ValueDetails, ValueDetailsDialog } from "./ValueDetailsDialog.tsx";

/** A missing value in the shared unavailable style: never blank, never 0 (DATA-011). */
export function UnavailableValue(props: {
	readonly reason: EquityUnavailableReason | null;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	return (
		<span
			data-unavailable="true"
			data-reason={props.reason ?? "not-reported"}
			class="text-xs italic text-slate-600"
		>
			{m().reason(props.reason ?? "not-reported")}
		</span>
	);
}

/** The unit caption: "USD millions" / 「百万円」, or the mixed-currency wording. */
export function unitCaption(
	currency: string | null,
	text: { readonly millionsOf: (currency: string) => string; readonly millionsMixed: string },
): string {
	return currency === null || currency === "" ? text.millionsMixed : text.millionsOf(currency);
}

/**
 * The filings the shown values cite, as links to SEC or EDINET (ADR-0048
 * §8: each value's filing is reachable). A disclosure, so a ten-year table
 * does not end in a ten-line footer.
 */
export function FilingSources(props: {
	readonly filings: readonly EquityFilingView[];
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const newestFirst = createMemo(() =>
		[...props.filings].sort((left, right) => right.filedOn.localeCompare(left.filedOn)),
	);
	return (
		<Show when={props.filings.length > 0}>
			<details
				class="group mt-1 border-t border-slate-200 pt-1 text-2xs text-slate-600"
				data-field="widget-footer"
			>
				<DisclosureSummary>
					{m().sources} {m().filingCount(props.filings.length)}
				</DisclosureSummary>
				<ul class="mt-0.5 space-y-0.5">
					<For each={newestFirst()}>
						{(filing) => (
							<li data-filing-id={filing.filingId}>
								<SafeLink
									url={filing.sourceUrl}
									label={m().openFiling(m().form(filing.form), filing.filedOn)}
								>
									{m().filingLine(m().form(filing.form), filing.filedOn)}
								</SafeLink>
							</li>
						)}
					</For>
				</ul>
			</details>
		</Show>
	);
}

/**
 * One statement as a table (ADR-0048 §8), shared by the Financial statement
 * widget and the Equities page: metric rows, fiscal-year columns oldest →
 * newest with the period end under each year, amounts in whole millions of
 * the unit the caption names. A missing value says why; a derived value
 * (free cash flow) and a revised one are marked in words. Every value is a
 * button opening its details — the exact amount, the filing it comes from
 * and, when revised, every value filings reported. The columns follow the
 * width of the nearest `@container` (the newest years stay).
 */
export function StatementTable(props: {
	readonly api: ApiClient;
	readonly response: EquityStatementResponse;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const locale = useLocale();
	const model = createMemo(() => statementTableModel(props.response));
	const [details, setDetails] = createSignal<ValueDetails | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	const unit = () => unitCaption(model().currency, m());
	const columnClass = (index: number): string => yearColumnClass(index, model().columns.length);

	const open = (metric: EquityMetricCode, cell: EquityMetricCell, button: HTMLElement): void => {
		setOpener(button);
		setDetails({
			companyId: props.response.company.companyId,
			metric,
			cell,
			filing: cell.filingId === null ? null : (model().filingsById.get(cell.filingId) ?? null),
		});
	};

	const valueText = (cell: EquityMetricCell): string => {
		const value = cell.valueDecimal === null ? null : formatMillions(cell.valueDecimal);
		if (value === null) return "";
		// With mixed currencies the caption cannot name one: each value does.
		return model().currency === null && cell.currency !== null
			? `${value} ${cell.currency}`
			: value;
	};

	/** The row's name: a separate-only row's profit is net income, not "attributable to owners". */
	const rowLabel = (row: StatementRow): string =>
		row.scope === "separate" ? m().metricInScope(row.metric, "separate") : m().metric(row.metric);

	const cellLabel = (row: StatementRow, cell: EquityMetricCell): string => {
		const marks = [
			cell.derived ? m().derivedMark : null,
			isRevised(cell) ? m().revisedMark : null,
			isMarkedSeparate(cell, row.scope) ? m().separateMark : null,
		].filter((mark): mark is string => mark !== null);
		const label = m().valueLabel(
			rowLabel(row),
			m().fiscalYear(cell.fiscalYear),
			valueText(cell),
			unit(),
		);
		return marks.length === 0 ? label : `${label} (${marks.join(", ")})`;
	};

	return (
		<div class="overflow-x-auto" data-field="statement-table">
			<table
				class="w-full border-collapse text-left text-sm"
				data-statement={props.response.statement}
			>
				<caption class="caption-top pb-1 text-left text-xs text-slate-700">
					{m().tableCaption(m().statement(props.response.statement), unit())}
				</caption>
				<thead>
					<tr class="border-b border-slate-200 align-bottom">
						<th scope="col" class="py-1 pr-2 text-xs font-medium text-slate-700">
							{m().metricColumn}
						</th>
						<For each={model().columns}>
							{(column, index) => (
								<th
									scope="col"
									class={`py-1 pl-2 text-right text-xs font-semibold whitespace-nowrap text-slate-900 ${columnClass(index())}`}
									data-fiscal-year={column.fiscalYear}
								>
									{m().fiscalYear(column.fiscalYear)}
									<Show when={column.periodEnd}>
										{(periodEnd) => (
											<span class="block text-2xs font-normal text-slate-600">
												<span class="sr-only">
													{m().periodEnded(formatPeriodEnd(periodEnd(), locale()))}
												</span>
												<span aria-hidden="true">{formatPeriodEnd(periodEnd(), locale())}</span>
											</span>
										)}
									</Show>
								</th>
							)}
						</For>
					</tr>
				</thead>
				<tbody>
					<For each={model().rows}>
						{(row) => (
							<tr class="border-b border-slate-200 align-top" data-metric={row.metric}>
								<th scope="row" class="py-1 pr-2 text-sm font-normal text-slate-900">
									{rowLabel(row)}
								</th>
								<For each={row.cells}>
									{(cell, index) => (
										<td
											class={`py-0.5 pl-2 text-right whitespace-nowrap ${columnClass(index())}`}
											data-fiscal-year={model().columns[index()]?.fiscalYear}
										>
											<Show
												when={cell !== null && cell.valueDecimal !== null ? cell : null}
												fallback={<UnavailableValue reason={cell?.unavailableReason ?? null} />}
											>
												{(value) => (
													<button
														type="button"
														class="inline-flex min-h-6 items-baseline gap-1 rounded px-1 text-sm text-slate-900 tabular-nums hover:bg-slate-100"
														aria-label={cellLabel(row, value())}
														data-value-button=""
														onClick={(event) => open(row.metric, value(), event.currentTarget)}
													>
														<span>{valueText(value())}</span>
														<Show when={value().derived}>
															<span class="text-2xs text-slate-600" data-mark="derived">
																{m().derivedMark}
															</span>
														</Show>
														<Show when={isRevised(value())}>
															<span
																class="rounded border border-slate-500 px-0.5 text-2xs text-slate-800"
																data-mark="revised"
															>
																{m().revisedMark}
															</span>
														</Show>
														<Show when={isMarkedSeparate(value(), row.scope)}>
															<span class="text-2xs text-slate-600" data-mark="separate">
																{m().separateMark}
															</span>
														</Show>
													</button>
												)}
											</Show>
										</td>
									)}
								</For>
							</tr>
						)}
					</For>
				</tbody>
			</table>
			<Show when={model().anyDerived}>
				<p class="mt-1 text-2xs text-slate-600">{m().derivedNote}</p>
			</Show>
			<Show when={model().anyRevised}>
				<p class="mt-0.5 text-2xs text-slate-600">{m().revisedNote}</p>
			</Show>
			<Show when={model().anySeparateMarked}>
				<p class="mt-0.5 text-2xs text-slate-600">{m().separateNote}</p>
			</Show>
			<Show when={model().anyUnderOne}>
				<p class="mt-0.5 text-2xs text-slate-600">{m().underOneNote}</p>
			</Show>
			<Show when={details()}>
				{(current) => (
					<ValueDetailsDialog
						api={props.api}
						details={current()}
						opener={opener()}
						onClose={() => setDetails(null)}
					/>
				)}
			</Show>
		</div>
	);
}
