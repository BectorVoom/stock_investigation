import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityCompanyView,
	type EquityStatementKind,
} from "@research/contracts";
import { EQUITY_METRICS, EQUITY_STATEMENTS, type EquityMetricCode } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import {
	BUTTON,
	BUTTON_PRIMARY,
	DisclosureSummary,
	Empty,
	ErrorNotice,
	LABEL,
	Loading,
	Select,
} from "../components/ui.tsx";
import { equitiesMessages } from "../equities/equities.messages.ts";
import {
	companyName,
	syncFailureText,
	syncInProgress,
	syncStatusText,
} from "../equities/equitiesModel.ts";
import { companyWidgetTitle, STATEMENT_YEAR_CHOICES } from "../equities/FinancialWidgetDialog.tsx";
import { filingsEntryFor, statementEntryFor } from "../equities/financialStore.ts";
import { financialsMessages } from "../equities/financials.messages.ts";
import { SegmentedControl } from "../equities/SegmentedControl.tsx";
import { StatementTable } from "../equities/StatementTable.tsx";
import {
	type ShowOnHomeOutcome,
	showHistoryOnHome,
	showStatementOnHome,
} from "../equities/showOnHome.ts";
import { homeFullText } from "../watchlist/listsModel.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { FilingsTable } from "./FilingsTable.tsx";
import { type Outcome, OutcomeNotice } from "./Outcome.tsx";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockTabProps } from "./stockTabs.ts";

/**
 * What the Financial statements tab asks the page for: the page owns the
 * companies list, so syncing and tracking go through it (the row's menu
 * does the same) and the tab shows the outcome where it was asked.
 */
export interface FinancialsActions {
	readonly atTrackLimit: Accessor<boolean>;
	/** True while a write of this stock's company (or its track) is on its way. */
	readonly busy: (stockId: string) => boolean;
	readonly nowMs: Accessor<number>;
	readonly syncNow: (company: EquityCompanyView) => Promise<Outcome>;
	readonly track: (stockId: string) => Promise<Outcome>;
	/** A read said the company is not the owner's any more: re-read the list now. */
	readonly companyGone: () => void;
	/** The companies list has answered (else "not synced" is not known, and nothing is offered). */
	readonly companiesKnown: Accessor<boolean>;
}

/**
 * The Financial statements tab (ADR-0049 §5): the Equities page's company
 * detail, moved. The sync status with its failure and Sync now head it; then
 * the statement switch, 5 or 10 years, the statement table with its marks and
 * revisions, "Add this statement to Home", the metric choice and "Add chart
 * to Home", and the filings in a disclosure closed by default whose read
 * starts when it is opened. A stock whose company is not tracked offers
 * "Sync financial statements" (disabled with its reason at the limit).
 * Reads attach only while the tab is shown (rule 4).
 */
export function FinancialsTab(
	props: StockTabProps & { readonly actions: FinancialsActions },
): JSX.Element {
	const s = useMessages(stocksMessages);
	const [outcome, setOutcome] = createSignal<Outcome | null>(null);
	const company = () => props.stock().company;
	const busy = () => props.actions.busy(props.stock().stockId);
	const track = async (): Promise<void> => {
		setOutcome(await props.actions.track(props.stock().stockId));
	};
	const limitId = createUniqueId();
	return (
		<div class="@container space-y-3" data-field="stock-financials-tab">
			<OutcomeNotice outcome={outcome()} field="financials-outcome" />
			<Show
				when={company()}
				fallback={
					<Show
						when={props.actions.companiesKnown()}
						fallback={
							<p class="text-sm text-slate-800" data-field="financials-unknown">
								{s().financialsUnknown}
							</p>
						}
					>
						<div class="space-y-2" data-field="financials-not-tracked">
							<p class="text-sm text-slate-800">{s().notTrackedBody}</p>
							<button
								type="button"
								class={BUTTON_PRIMARY}
								disabled={busy() || props.actions.atTrackLimit()}
								aria-describedby={props.actions.atTrackLimit() ? limitId : undefined}
								onClick={() => void track()}
							>
								{s().trackFinancials}
							</button>
							<Show
								when={props.actions.atTrackLimit()}
								fallback={<p class="text-2xs text-slate-600">{s().alsoSyncHint}</p>}
							>
								<p id={limitId} class="text-xs text-amber-900" data-field="track-limit">
									{s().atLimit(EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies)}
								</p>
							</Show>
						</div>
					</Show>
				}
			>
				{(tracked) => (
					<>
						<SyncLine
							company={tracked()}
							busy={busy()}
							nowMs={props.actions.nowMs()}
							onSync={() => void props.actions.syncNow(tracked()).then(setOutcome)}
						/>
						<Statements {...props} company={tracked()} onOutcome={setOutcome} />
						<Filings {...props} company={tracked()} />
					</>
				)}
			</Show>
		</div>
	);
}

/** The sync status line with its failure and "Sync now" (ADR-0048 §6). */
function SyncLine(props: {
	readonly company: EquityCompanyView;
	readonly busy: boolean;
	readonly nowMs: number;
	readonly onSync: () => void;
}): JSX.Element {
	const e = useMessages(equitiesMessages);
	const s = useMessages(stocksMessages);
	const locale = useLocale();
	return (
		<div
			class="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 pb-2 text-xs"
			data-field="financials-sync"
			data-sync-status={props.company.sync.status}
		>
			<div class="min-w-0 flex-1">
				<p class="text-slate-800" data-field="sync-status">
					<span class="font-medium">{s().syncLabel}: </span>
					{syncInProgress(props.company) ? "◐ " : ""}
					{syncStatusText(props.company, props.nowMs, locale(), e())}
				</p>
				<Show when={syncFailureText(props.company, e())}>
					{(text) => (
						<p class="text-red-900" data-field="sync-failure">
							<span class="font-mono font-semibold">{props.company.sync.failure?.code}</span>
							{": "}
							{text()}
						</p>
					)}
				</Show>
			</div>
			<button
				type="button"
				class={BUTTON}
				aria-label={e().syncNowNamed(companyName(props.company))}
				disabled={props.busy || syncInProgress(props.company)}
				onClick={() => props.onSync()}
			>
				{e().syncNow}
			</button>
		</div>
	);
}

/** The statement switch, the years, the table and the two Add to Home actions. */
function Statements(
	props: StockTabProps & {
		readonly company: EquityCompanyView;
		readonly actions: FinancialsActions;
		readonly onOutcome: (outcome: Outcome) => void;
	},
): JSX.Element {
	const e = useMessages(equitiesMessages);
	const f = useMessages(financialsMessages);
	const listsText = useMessages(watchlistListsMessages);
	const [statement, setStatement] = createSignal<EquityStatementKind>("income-statement");
	const [years, setYears] = createSignal<number>(EQUITY_FINANCIAL_LIMITS.defaultYears);
	const [chartMetric, setChartMetric] = createSignal<EquityMetricCode>("revenue");
	const chartMetricId = createUniqueId();
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});
	const entry = createMemo(() =>
		statementEntryFor(props.api, props.company.companyId, statement(), years()),
	);
	createEffect(() => {
		const current = entry();
		if (props.active()) onCleanup(current.attach(props.visibility));
	});
	// A read that says the company is no longer the owner's (removed in
	// another tab): read the list now, which drops it, rather than waiting up
	// to five minutes for the next poll.
	createEffect(() => {
		if (entry().missing()) props.actions.companyGone();
	});

	const homeOutcome = (shown: ShowOnHomeOutcome, what: string): Outcome => {
		switch (shown.kind) {
			case "added":
				return { kind: "notice", tone: "success", text: e().addedToHome(what) };
			case "already":
				return { kind: "notice", tone: "info", text: e().alreadyOnHome(what) };
			case "full":
				return { kind: "notice", tone: "warning", text: homeFullText(shown.problem, listsText()) };
			case "failed":
				return { kind: "failure", title: e().notAddedToHome, error: shown.failure };
		}
	};
	const addStatement = async (): Promise<void> => {
		const chosen = statement();
		const shown = await showStatementOnHome(props.api, props.company, chosen, years());
		if (disposed) return;
		props.onOutcome(
			homeOutcome(shown, `${f().statement(chosen)} — ${companyWidgetTitle(props.company)}`),
		);
	};
	const addChart = async (): Promise<void> => {
		const chosen = chartMetric();
		const shown = await showHistoryOnHome(props.api, props.company, chosen, 10);
		if (disposed) return;
		props.onOutcome(
			homeOutcome(shown, f().chartTitle(f().metric(chosen), companyName(props.company))),
		);
	};

	return (
		<div class="space-y-3" data-field="company-detail" data-company-id={props.company.companyId}>
			<div class="flex flex-wrap items-center gap-2" aria-busy={entry().loading()}>
				<SegmentedControl
					name="equities-statement"
					label={f().statementSwitch}
					options={EQUITY_STATEMENTS}
					selected={statement()}
					optionLabel={(option) => f().statement(option)}
					onSelect={setStatement}
				/>
				<SegmentedControl
					name="equities-years"
					label={e().yearsLabel}
					options={STATEMENT_YEAR_CHOICES}
					selected={years() === 10 ? 10 : 5}
					optionLabel={(option) => e().yearsOption(option)}
					onSelect={setYears}
				/>
			</div>
			<Show
				when={!entry().missing()}
				fallback={
					<p class="text-sm text-slate-800" data-field="statement-company-gone">
						{e().companyGone}
					</p>
				}
			>
				<Show when={entry().failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={f().statementFailed}
							onRetry={() => entry().refresh()}
						/>
					)}
				</Show>
				<Show
					when={entry().value()}
					fallback={
						<Show when={entry().failure() === null}>
							<Loading label={f().statementThing} />
						</Show>
					}
				>
					{(current) => (
						<Show when={current().fiscalYears.length > 0} fallback={<Empty>{f().noDataYet}</Empty>}>
							<StatementTable api={props.api} response={current()} />
							<div class="flex flex-wrap items-end gap-2">
								<button type="button" class={BUTTON} onClick={() => void addStatement()}>
									{e().addStatementToHome}
								</button>
								<div class="w-64">
									<label for={chartMetricId} class={LABEL}>
										{e().chartMetric}
									</label>
									<Select
										id={chartMetricId}
										onChange={(event) => {
											const value = event.currentTarget.value;
											const found = EQUITY_METRICS.find((definition) => definition.code === value);
											if (found !== undefined) setChartMetric(found.code);
										}}
									>
										<For each={EQUITY_METRICS}>
											{(definition) => (
												<option
													value={definition.code}
													selected={definition.code === chartMetric()}
												>
													{f().metric(definition.code)}
												</option>
											)}
										</For>
									</Select>
								</div>
								<button type="button" class={BUTTON} onClick={() => void addChart()}>
									{e().addChartToHome}
								</button>
							</div>
						</Show>
					)}
				</Show>
			</Show>
		</div>
	);
}

/**
 * "Filings (n)": closed by default; the filings read attaches only while
 * the disclosure is open and the tab is shown, so a visit that never opens
 * it costs no request. `n` is the count the companies list already holds.
 */
function Filings(props: StockTabProps & { readonly company: EquityCompanyView }): JSX.Element {
	const e = useMessages(equitiesMessages);
	const s = useMessages(stocksMessages);
	const [open, setOpen] = createSignal(false);
	const entry = createMemo(() => filingsEntryFor(props.api, props.company.companyId));
	createEffect(() => {
		const current = entry();
		if (open() && props.active()) onCleanup(current.attach(props.visibility));
	});
	return (
		<details
			class="group"
			data-field="company-filings"
			onToggle={(event) => setOpen(event.currentTarget.open)}
		>
			<DisclosureSummary class="text-sm font-semibold text-slate-900">
				{s().filingsDisclosure(props.company.filingCount)}
			</DisclosureSummary>
			<Show when={open()}>
				<div class="mt-1 space-y-2">
					<p class="text-xs text-slate-700">{e().filingsIntro}</p>
					<Show
						when={!entry().missing()}
						fallback={
							<p class="text-sm text-slate-800" data-field="filings-company-gone">
								{e().companyGone}
							</p>
						}
					>
						<Show when={entry().failure()}>
							{(error) => (
								<ErrorNotice
									failure={error()}
									title={e().filingsFailed}
									onRetry={() => entry().refresh()}
								/>
							)}
						</Show>
						<Show
							when={entry().value()}
							fallback={
								<Show when={entry().failure() === null}>
									<Loading label={e().filingsThing} />
								</Show>
							}
						>
							{(answer) => (
								<Show when={answer().filings.length > 0} fallback={<Empty>{e().noFilings}</Empty>}>
									<FilingsTable filings={answer().filings} />
								</Show>
							)}
						</Show>
					</Show>
				</div>
			</Show>
		</details>
	);
}
