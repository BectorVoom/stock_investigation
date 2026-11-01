import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityCompanyView,
	type EquityStatementKind,
} from "@research/contracts";
import { EQUITY_STATEMENTS } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import {
	type Accessor,
	createEffect,
	createMemo,
	createSignal,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";
import { DisclosureSummary, Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { STATEMENT_YEAR_CHOICES } from "../equities/FinancialWidgetDialog.tsx";
import { filingsEntryFor, statementEntryFor } from "../equities/financialStore.ts";
import { financialsMessages } from "../equities/financials.messages.ts";
import { SegmentedControl } from "../equities/SegmentedControl.tsx";
import { StatementTable } from "../equities/StatementTable.tsx";
import { FilingsTable } from "./FilingsTable.tsx";
import { stockProfileEntryFor } from "./stockReads.ts";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockTabProps } from "./stockTabs.ts";

/**
 * What the Financial statements tab asks the page for: the page owns the
 * companies list. The tab offers no sync and shows no sync status: the
 * server syncs the statements of every Watchlist stock (ADR-0054, ADR-0055).
 */
export interface FinancialsActions {
	/** A read said the company is not the owner's any more: re-read the list now. */
	readonly companyGone: () => void;
	/** The companies list has answered (else "not synced" is not known, and nothing is offered). */
	readonly companiesKnown: Accessor<boolean>;
}

/**
 * The Financial statements tab (ADR-0049 §5): the Equities page's company
 * detail, moved, without its sync status (ADR-0055 §4) and without its
 * Add to Home actions (removed 2026-11-01; Home's add menu places the
 * Financial statement and Financial history widgets): the statement
 * switch, 5 or 10 years, the statement table with its marks and revisions,
 * and the filings in a disclosure closed by default whose read starts when
 * it is opened. The server syncs the statements of every
 * Watchlist stock (ADR-0054): a stock without a synced company shows the
 * statements stored for it earlier, if any (ADR-0055), else says when its
 * statements will come — after its first sync if it is on the Watchlist,
 * once it is added otherwise. Reads attach only while the tab is shown
 * (rule 4).
 */
export function FinancialsTab(
	props: StockTabProps & { readonly actions: FinancialsActions },
): JSX.Element {
	const s = useMessages(stocksMessages);
	const company = () => props.stock().company;
	return (
		<div class="@container space-y-3" data-field="stock-financials-tab">
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
						<NotSynced {...props} />
					</Show>
				}
			>
				{(tracked) => (
					<>
						<Statements {...props} company={tracked()} />
						<Filings {...props} company={tracked()} />
					</>
				)}
			</Show>
		</div>
	);
}

/** Stored statements are worth showing: the company has a fiscal year or a filing on record. */
function hasStoredStatements(company: EquityCompanyView): boolean {
	return company.latestFiscalYear !== null || company.filingCount > 0;
}

/**
 * A stock whose statements the server does not sync (not on the Watchlist,
 * or added and not reconciled yet). The statements stored while it was on
 * the Watchlist stay readable (ADR-0055): the profile read names its stored
 * company, tracked or not, and the tab shows them with a line saying they
 * are not kept up to date. Without stored statements it says when they
 * will come.
 */
function NotSynced(props: StockTabProps & { readonly actions: FinancialsActions }): JSX.Element {
	const s = useMessages(stocksMessages);
	const profile = createMemo(() => stockProfileEntryFor(props.api, props.stock().stockId));
	createEffect(() => {
		if (!props.active()) return;
		const current = profile();
		onCleanup(current.attach(props.visibility));
	});
	const stored = createMemo(() => {
		const company = profile().value()?.company ?? null;
		return company !== null && !company.tracked && hasStoredStatements(company) ? company : null;
	});
	const watched = () => props.stock().watchlist !== null;
	const notTracked = (
		<div class="space-y-1" data-field="financials-not-tracked">
			<p class="text-sm text-slate-800">
				{watched() ? s().notStoredYetBody : s().notOnWatchlistBody}
			</p>
			<p class="text-2xs text-slate-600">{s().sourceHint}</p>
		</div>
	);
	return (
		<>
			<Show when={profile().failure()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title={s().profileFailed}
						onRetry={() => profile().refresh()}
					/>
				)}
			</Show>
			<Show
				when={stored()}
				fallback={
					<Show
						when={profile().value() !== undefined || profile().failure() !== null}
						fallback={<Loading label={s().profileThing} />}
					>
						{notTracked}
					</Show>
				}
			>
				{(company) => (
					<>
						<p
							class="border-b border-slate-200 pb-2 text-xs text-slate-800"
							data-field="financials-stored"
						>
							{watched() ? s().storedUpdatingBody : s().storedNotUpdatedBody}
						</p>
						<Statements {...props} company={company()} />
						<Filings {...props} company={company()} />
					</>
				)}
			</Show>
		</>
	);
}

/** The statement switch, the years and the table. */
function Statements(
	props: StockTabProps & {
		readonly company: EquityCompanyView;
		readonly actions: FinancialsActions;
	},
): JSX.Element {
	const e = useMessages(equitiesMessages);
	const f = useMessages(financialsMessages);
	const [statement, setStatement] = createSignal<EquityStatementKind>("income-statement");
	const [years, setYears] = createSignal<number>(EQUITY_FINANCIAL_LIMITS.defaultYears);
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
