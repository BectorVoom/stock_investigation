import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityCompanyView,
	type EquityStatementKind,
	type StockProfileResponse,
} from "@research/contracts";
import { EQUITY_STATEMENTS } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { DisclosureSummary, Empty, ErrorNotice, Loading } from "../components/ui.tsx";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { STATEMENT_YEAR_CHOICES } from "../equities/FinancialWidgetDialog.tsx";
import {
	filingsEntryFor,
	refreshCompanyReads,
	statementEntryFor,
} from "../equities/financialStore.ts";
import { financialsMessages } from "../equities/financials.messages.ts";
import { SegmentedControl } from "../equities/SegmentedControl.tsx";
import { StatementTable } from "../equities/StatementTable.tsx";
import { FilingsTable } from "./FilingsTable.tsx";
import { NextEarnings } from "./NextEarnings.tsx";
import { rereadWhileAwaiting, stockProfileEntryFor } from "./stockReads.ts";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockTabProps } from "./stockTabs.ts";

/**
 * The Financial statements tab (ADR-0049 §5): the Equities page's company
 * detail, moved, without its sync status (ADR-0055 §4) and without its
 * Add to Home actions (removed 2026-11-01; Home's add menu places the
 * Financial statement and Financial history widgets): the statement
 * switch, 5 or 10 years, the statement table with its marks and revisions,
 * and the filings in a disclosure closed by default whose read starts when
 * it is opened. Reads attach only while the tab is shown (rule 4). Above
 * them, the next earnings announcement from the stock's Watchlist entry
 * (ADR-0067), which reads nothing.
 *
 * The server syncs the statements of every stock in the stored stock
 * lists, on the Watchlist or not (ADR-0058 §3), so the tab takes the
 * stock's company from its profile read (shared with the Company tab and
 * the heading), never from the list of tracked companies — that list holds
 * thousands. A company with stored statements shows them, tracked or not
 * (ADR-0055); one that is no longer tracked says whether they are still
 * updated. Without stored statements the tab says they are on the way and
 * re-reads sooner until they arrive — or, for a stock outside the stored
 * stock lists, that none will come.
 */
export function FinancialsTab(props: StockTabProps): JSX.Element {
	const s = useMessages(stocksMessages);
	const stockId = createMemo(() => props.stock().stockId);
	const profile = createMemo(() => stockProfileEntryFor(props.api, stockId()));
	createEffect(() => {
		if (!props.active()) return;
		const current = profile();
		onCleanup(current.attach(props.visibility));
	});
	const answer = () => profile().value();
	const stored = createMemo(() => {
		const company = answer()?.company ?? null;
		return company !== null && hasStoredStatements(company) ? company : null;
	});
	/** The profile answered and the stock has no stored statements. */
	const noneStored = createMemo(() => answer() !== undefined && stored() === null);
	const listed = createMemo(() => {
		const current = answer();
		return current === undefined || isListed(current);
	});
	rereadWhileAwaiting({
		entry: profile,
		visibility: props.visibility,
		awaiting: createMemo(() => props.active() && noneStored() && listed()),
	});
	followFinishedSyncs(props, () => answer()?.company ?? null);

	return (
		<div class="@container space-y-3" data-field="stock-financials-tab">
			<NextEarnings stock={props.stock().watchlist} />
			<Show when={profile().failure()}>
				{(failure) => (
					<ErrorNotice
						failure={failure()}
						title={s().profileFailed}
						onRetry={() => profile().refresh()}
					/>
				)}
			</Show>
			<Show when={answer() === undefined && profile().failure() === null}>
				<Loading label={s().profileThing} />
			</Show>
			<Show when={noneStored()}>
				<div class="space-y-1" data-field="financials-none" data-listed={String(listed())}>
					<p class="text-sm text-slate-800">
						{listed() ? s().notStoredYetBody : s().notListedBody}
					</p>
					<p class="text-2xs text-slate-600">{s().sourceHint}</p>
				</div>
			</Show>
			<Show when={stored()}>
				{(company) => (
					<>
						<Show when={!company().tracked}>
							<p
								class="border-b border-slate-200 pb-2 text-xs text-slate-800"
								data-field="financials-stored"
							>
								{listed() ? s().storedUpdatingBody : s().storedNotUpdatedBody}
							</p>
						</Show>
						<Statements {...props} company={company()} onGone={() => profile().refresh()} />
						<Filings {...props} company={company()} />
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
 * The server syncs the stock's statements: it is in the stored stock lists,
 * or its company is still tracked (a list not stored yet, ADR-0058 §3 —
 * a company is untracked only once its listing left a stored list).
 */
function isListed(profile: StockProfileResponse): boolean {
	return profile.directory !== null || profile.company?.tracked === true;
}

/**
 * A finished sync of the shown company (its last success moved on a
 * profile re-read) may have changed values: its shown statement and filings
 * reads re-read now, the others re-check when next shown.
 */
function followFinishedSyncs(props: StockTabProps, company: () => EquityCompanyView | null): void {
	let last: { readonly companyId: string; readonly succeededAt: string | null } | null = null;
	createEffect(() => {
		const current = company();
		if (current === null) return;
		const succeededAt = current.sync.lastSucceededAt;
		if (last !== null && last.companyId === current.companyId && last.succeededAt !== succeededAt) {
			refreshCompanyReads(props.api, current.companyId);
		}
		last = { companyId: current.companyId, succeededAt };
	});
}

/** The statement switch, the years and the table. */
function Statements(
	props: StockTabProps & {
		readonly company: EquityCompanyView;
		/** A read said the company is not the owner's any more: re-read the profile now. */
		readonly onGone: () => void;
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
	// A read that says the company is no longer the owner's: read the
	// profile now, which drops it, rather than waiting up to five minutes for
	// its next re-check.
	createEffect(() => {
		if (entry().missing()) props.onGone();
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
 * it costs no request. `n` is the count the profile's company already holds.
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
