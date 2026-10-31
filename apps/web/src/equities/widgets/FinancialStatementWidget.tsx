import type { EquityStatementKind, WidgetCore } from "@research/contracts";
import { EQUITY_STATEMENTS } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../../api/client.ts";
import { ErrorNotice } from "../../components/ui.tsx";
import { commonMessages } from "../../i18n/common.messages.ts";
import type { VisibilitySource } from "../../lib/polling.ts";
import { EQUITIES_HASH } from "../../router.ts";
import { TASK_LINK } from "../../tasks/TaskParts.tsx";
import { formatPeriodEnd } from "../financialFormat.ts";
import { statementEntryFor } from "../financialStore.ts";
import { financialsMessages } from "../financials.messages.ts";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { FilingSources, StatementTable } from "../StatementTable.tsx";

type StatementWidget = Extract<WidgetCore, { readonly type: "financial-statement" }>;

/**
 * The `financial-statement` widget (ADR-0048 §8) on Home and in the
 * Notebook: one tracked company's annual statement, fiscal years side by
 * side. Glanceable after the Apple widget guidelines — the company and its
 * newest period end on top, a segmented control for the three statements,
 * the table, and the cited filings at the end. The frame shows no title
 * (ADR-0024), so the body names the company.
 *
 * The switch saves the widget's `statement` through the page's own save
 * (Undo restores it) and shows the chosen statement at once; a refused save
 * returns the switch to the stored statement. Values come from the equities
 * API only, through a read shared by every view of the same statement
 * (`statementEntryFor`) with its ETag: read on mount, again when the page
 * becomes visible and every five minutes while it is.
 */
export function FinancialStatementWidget(props: {
	readonly widget: StatementWidget;
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	/** True while the page saves: the switch waits. */
	readonly editingDisabled: boolean;
	/** Saves the widget with a new statement; resolves false when the save was refused. */
	/** Saves the widget with a new choice; resolves false when refused. Absent: the choice is fixed. */
	readonly onSaveWidget?: (widget: WidgetCore) => Promise<boolean>;
}): JSX.Element {
	const m = useMessages(financialsMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	/** The statement the owner just chose, shown while its save is on its way. */
	const [requested, setRequested] = createSignal<EquityStatementKind | null>(null);
	const statement = () => requested() ?? props.widget.statement;
	const entry = createMemo(() =>
		statementEntryFor(props.api, props.widget.companyId, statement(), props.widget.years),
	);
	createEffect(() => {
		const current = entry();
		onCleanup(current.attach(props.visibility));
	});

	const choose = (next: EquityStatementKind): void => {
		const save = props.onSaveWidget;
		if (save === undefined) return;
		setRequested(next);
		void save({ ...props.widget, statement: next }).then(() => {
			// Saved: the stored widget now names `next`. Refused: back to the stored one.
			setRequested(null);
		});
	};

	const response = () => entry().value();
	const company = () => response()?.company ?? null;
	const companyLine = () => {
		const current = company();
		return current === null
			? props.widget.title
			: m().companyLine(current.name ?? current.symbol, current.symbol);
	};

	return (
		<div
			class="@container flex flex-col gap-2"
			data-widget-kind="financial-statement"
			data-company-id={props.widget.companyId}
			aria-busy={entry().loading()}
		>
			<div class="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
				<div class="min-w-0 flex-[1_1_12rem]">
					<p class="truncate text-sm font-semibold text-slate-900" title={companyLine()}>
						{companyLine()}
					</p>
					<Show when={response()?.fiscalYears.length ? response() : null}>
						{(current) => (
							<Show when={newestPeriodEnd(current())}>
								{(periodEnd) => (
									<p class="text-xs text-slate-700" data-field="latest-period">
										{m().latestPeriod(formatPeriodEnd(periodEnd(), locale()))}
									</p>
								)}
							</Show>
						)}
					</Show>
				</div>
				<SegmentedControl
					name="statement"
					label={m().statementSwitch}
					options={EQUITY_STATEMENTS}
					selected={statement()}
					optionLabel={(option) => m().statementShort(option)}
					disabled={
						props.onSaveWidget === undefined || props.editingDisabled || requested() !== null
					}
					onSelect={choose}
				/>
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
							title={m().statementFailed}
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
								{common().loadingThing(m().statementThing)}
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
								when={current().fiscalYears.length > 0}
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
								<StatementTable api={props.api} response={current()} />
								<FilingSources filings={current().filings} />
							</Show>
						</>
					)}
				</Show>
			</Show>
		</div>
	);
}

/** The newest fiscal year's period end as the values state it. */
function newestPeriodEnd(response: {
	readonly fiscalYears: readonly number[];
	readonly rows: readonly {
		readonly cells: readonly { readonly fiscalYear: number; readonly periodEnd: string | null }[];
	}[];
}): string | null {
	const newest = response.fiscalYears.at(-1);
	if (newest === undefined) return null;
	for (const row of response.rows) {
		for (const cell of row.cells) {
			if (cell.fiscalYear === newest && cell.periodEnd !== null) return cell.periodEnd;
		}
	}
	return null;
}
