import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityCompanyView,
	type EquityMetricCell,
	type EquityStatementResponse,
	type StockProfileResponse,
	type WatchlistStock,
} from "@research/contracts";
import type { EquityMetricCode, EquityStatement } from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createEffect, createMemo, For, type JSX, onCleanup, Show } from "solid-js";
import { BUTTON, ErrorNotice, HEADING, Loading } from "../components/ui.tsx";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { formatFiscalYearEnd, syncStatusText } from "../equities/equitiesModel.ts";
import { formatMillions } from "../equities/financialFormat.ts";
import { type FinancialEntry, statementEntryFor } from "../equities/financialStore.ts";
import { financialsMessages } from "../equities/financials.messages.ts";
import { UnavailableValue, unitCaption } from "../equities/StatementTable.tsx";
import { isRevised } from "../equities/statementModel.ts";
import { createClock } from "../tasks/clock.ts";
import { joinNames } from "../watchlist/listsModel.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import { nextDatedEvent, timingText, utcTodayIso } from "../watchlist/watchlistModel.ts";
import { KEY_FIGURE_STATEMENTS, keyFigures, newestFiscalYear } from "./keyFigures.ts";
import { stockProfileEntryFor } from "./stockReads.ts";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockTabProps } from "./stockTabs.ts";

/** A filer's page on SEC EDGAR; EDINET has no link builder per filer here (codes are shown as text). */
export function secFilerUrl(cik: string): string {
	return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik)}`;
}

/** One term and its description in a description list. */
function Item(props: { readonly term: string; readonly children: JSX.Element }): JSX.Element {
	return (
		<div class="grid grid-cols-[minmax(8rem,14rem)_1fr] gap-x-3 border-b border-slate-100 py-1">
			<dt class="text-xs font-medium text-slate-700">{props.term}</dt>
			<dd class="min-w-0 break-words text-sm text-slate-900">{props.children}</dd>
		</div>
	);
}

/** A value that is missing says why, in the shared unavailable style (never blank, never 0). */
function Missing(props: { readonly children: string }): JSX.Element {
	return (
		<span class="text-xs italic text-slate-600" data-unavailable="true">
			{props.children}
		</span>
	);
}

/** One group of the tab: a heading and its description list. */
function Group(props: {
	readonly heading: string;
	readonly field: string;
	readonly children: JSX.Element;
}): JSX.Element {
	return (
		<section aria-label={props.heading} data-field={props.field}>
			<h4 class={HEADING}>{props.heading}</h4>
			{props.children}
		</section>
	);
}

/**
 * The Company tab (ADR-0049 §6): what is stored about the stock, as
 * description lists — Listing (the stored directory entry), Filer (the
 * tracked company's identity at SEC or EDINET), Key figures (the newest
 * fiscal year's main values, from the statement reads the Financial
 * statements tab shares) and On this workspace (watchlist, lists, next
 * earnings date). Reads attach only while the tab is shown (rule 4).
 */
export function CompanyTab(props: StockTabProps): JSX.Element {
	const s = useMessages(stocksMessages);
	const profile = stockProfileEntryFor(props.api, props.stock().stockId);
	createEffect(() => {
		if (props.active()) onCleanup(profile.attach(props.visibility));
	});
	return (
		<div class="space-y-4" data-field="stock-company-tab">
			<ListingGroup {...props} profile={profile.value()} failed={profile.failure() !== null} />
			<Show when={profile.failure()}>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title={s().profileFailed}
						onRetry={() => profile.refresh()}
					/>
				)}
			</Show>
			<Show
				when={props.stock().company}
				fallback={
					<Group heading={s().filerHeading} field="company-filer">
						<p class="mt-1 text-sm text-slate-800">{s().filerNotTracked}</p>
						<button
							type="button"
							class={`${BUTTON} mt-1`}
							onClick={() => props.onSelectTab("financials")}
						>
							{s().openFinancials}
						</button>
					</Group>
				}
			>
				{(company) => (
					<>
						<FilerGroup company={company()} />
						<KeyFiguresGroup {...props} company={company()} />
					</>
				)}
			</Show>
			<WorkspaceGroup watchlist={props.stock().watchlist} listTitles={props.stock().listTitles} />
		</div>
	);
}

function ListingGroup(
	props: StockTabProps & {
		readonly profile: StockProfileResponse | undefined;
		/** The profile read failed (the tab states the failure below). */
		readonly failed: boolean;
	},
): JSX.Element {
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);
	const locale = useLocale();
	const directory = () => props.profile?.directory ?? null;
	/** The UI language's name first; a Japanese name only for a Japanese listing. */
	const names = (): readonly { readonly term: string; readonly value: string | null }[] => {
		const entry = directory();
		const english = { term: s().nameEnglish, value: entry?.name ?? null };
		if (props.stock().market !== "JP") return [english];
		const japanese = { term: s().nameJapanese, value: entry?.localName ?? null };
		return locale() === "ja" ? [japanese, english] : [english, japanese];
	};
	return (
		<Group heading={s().listingHeading} field="company-listing">
			<Show
				when={props.profile !== undefined}
				fallback={
					<Show when={!props.failed}>
						<Loading label={s().profileThing} />
					</Show>
				}
			>
				<Show when={directory() === null}>
					<p class="mt-1 text-sm text-slate-800" data-field="not-in-directory">
						{s().notInDirectory}
					</p>
				</Show>
			</Show>
			<dl class="mt-1">
				<Show when={directory() !== null}>
					<For each={names()}>
						{(name) => (
							<Item term={name.term}>
								<Show when={name.value} fallback={<Missing>{s().notKnownYet}</Missing>}>
									{(value) => value()}
								</Show>
							</Item>
						)}
					</For>
				</Show>
				<Item term={s().symbol}>
					<span class="font-mono">{props.stock().symbol}</span>
				</Item>
				<Item term={s().market}>{model().marketName(props.stock().market)}</Item>
				<Item term={s().listing}>
					<Show
						when={directory()}
						fallback={
							<Missing>
								{props.profile === undefined ? s().notKnownYet : s().notInDirectory}
							</Missing>
						}
					>
						{(entry) => model().listingName(entry().listing)}
					</Show>
				</Item>
				<Item term={s().stockId}>
					<span class="font-mono">{props.stock().stockId}</span>
				</Item>
			</dl>
		</Group>
	);
}

function FilerGroup(props: { readonly company: EquityCompanyView }): JSX.Element {
	const s = useMessages(stocksMessages);
	const e = useMessages(equitiesMessages);
	const f = useMessages(financialsMessages);
	const locale = useLocale();
	const now = createClock();
	return (
		<Group heading={s().filerHeading} field="company-filer">
			<dl class="mt-1">
				<Item term={e().sourceIdKind(props.company.provider)}>
					<Show
						when={props.company.sourceCompanyId}
						fallback={<Missing>{s().notResolved}</Missing>}
					>
						{(id) => (
							<Show
								when={props.company.provider === "sec"}
								fallback={
									<>
										<span class="font-mono" data-field="filer-id">
											{id()}
										</span>
										<span class="block text-2xs text-slate-600">{s().edinetNoLink}</span>
									</>
								}
							>
								<SafeLink url={secFilerUrl(id())} label={s().filerSite(props.company.provider)}>
									<span class="font-mono" data-field="filer-id">
										{id()}
									</span>
								</SafeLink>
							</Show>
						)}
					</Show>
				</Item>
				<Item term={s().fiscalYearEnd}>
					<Show when={props.company.fiscalYearEnd} fallback={<Missing>{s().notKnownYet}</Missing>}>
						{(end) => formatFiscalYearEnd(end(), locale())}
					</Show>
				</Item>
				<Item term={s().latestFiscalYear}>
					<Show
						when={props.company.latestFiscalYear}
						fallback={<Missing>{s().notKnownYet}</Missing>}
					>
						{(year) => f().fiscalYear(year())}
					</Show>
				</Item>
				<Item term={s().filingsStored}>
					<span class="tabular-nums">{props.company.filingCount}</span>
				</Item>
				<Item term={s().lastSync}>{syncStatusText(props.company, now(), locale(), e())}</Item>
			</dl>
		</Group>
	);
}

/**
 * The newest fiscal year's key figures. The three statement entries are the
 * Financial statements tab's own (same company, statement and 5 years), so
 * their answers — and ETags — are shared: a stock whose statements were
 * shown answers here at once, and the conditional re-check is a 304.
 */
function KeyFiguresGroup(
	props: StockTabProps & { readonly company: EquityCompanyView },
): JSX.Element {
	const s = useMessages(stocksMessages);
	const f = useMessages(financialsMessages);
	const companyId = createMemo(() => props.company.companyId);
	const entries = createMemo(
		(): readonly (readonly [EquityStatement, FinancialEntry<EquityStatementResponse>])[] => {
			const id = companyId();
			return KEY_FIGURE_STATEMENTS.map(
				(statement) =>
					[
						statement,
						statementEntryFor(props.api, id, statement, EQUITY_FINANCIAL_LIMITS.defaultYears),
					] as const,
			);
		},
	);
	createEffect(() => {
		const list = entries();
		if (!props.active()) return;
		for (const [, entry] of list) onCleanup(entry.attach(props.visibility));
	});
	const answers = createMemo(
		() => new Map(entries().map(([statement, entry]) => [statement, entry.value()] as const)),
	);
	const year = createMemo(
		() => props.company.latestFiscalYear ?? newestFiscalYear(answers().values()),
	);
	const allLoaded = () => entries().every(([, entry]) => entry.value() !== undefined);
	const failed = () => entries().find(([, entry]) => entry.failure() !== null)?.[1] ?? null;
	return (
		<Group heading={s().keyFiguresHeading} field="company-key-figures">
			<Show when={failed()}>
				{(entry) => (
					<Show when={entry().failure()}>
						{(error) => (
							<div class="mt-1">
								<ErrorNotice
									failure={error()}
									title={s().keyFiguresFailed}
									onRetry={() => entry().refresh()}
								/>
							</div>
						)}
					</Show>
				)}
			</Show>
			<Show
				when={year()}
				fallback={
					<Show
						when={allLoaded()}
						fallback={
							<Show when={failed() === null}>
								<Loading label={s().keyFiguresThing} />
							</Show>
						}
					>
						<p class="mt-1 text-sm text-slate-800">{s().keyFiguresNone}</p>
					</Show>
				}
			>
				{(fiscalYear) => (
					<>
						<p class="mt-1 text-xs text-slate-700">
							{s().keyFiguresIntro(f().fiscalYear(fiscalYear()))}
						</p>
						<dl class="mt-1">
							<For each={keyFigures(answers(), fiscalYear())}>
								{(figure) => (
									<Item term={figureLabel(figure.metric, figure.cell, f())}>
										<Show when={figure.loaded} fallback={<Missing>{s().notKnownYet}</Missing>}>
											<FigureValue cell={figure.cell} />
										</Show>
									</Item>
								)}
							</For>
						</dl>
					</>
				)}
			</Show>
		</Group>
	);
}

type FinancialsText = MessagesOf<typeof financialsMessages>;

/** A separate-only profit is net income, not "attributable to owners" (as the statement table says). */
function figureLabel(
	metric: EquityMetricCode,
	cell: EquityMetricCell | null,
	f: FinancialsText,
): string {
	return cell?.scope === "separate" ? f.metricInScope(metric, "separate") : f.metric(metric);
}

/** A value in whole millions with its unit and marks, as the statement table shows it; else why not. */
function FigureValue(props: { readonly cell: EquityMetricCell | null }): JSX.Element {
	const f = useMessages(financialsMessages);
	const s = useMessages(stocksMessages);
	const amount = () => {
		const cell = props.cell;
		if (cell === null || cell.valueDecimal === null) return null;
		const value = formatMillions(cell.valueDecimal);
		return value === null ? null : { cell, value };
	};
	return (
		<Show
			when={amount()}
			fallback={<UnavailableValue reason={props.cell?.unavailableReason ?? null} />}
		>
			{(current) => (
				<span class="inline-flex flex-wrap items-baseline gap-1">
					<span class="tabular-nums">
						{s().keyFigureValue(current().value, unitCaption(current().cell.currency, f()))}
					</span>
					<Show when={current().cell.derived}>
						<span class="text-2xs text-slate-600" data-mark="derived">
							{f().derivedMark}
						</span>
					</Show>
					<Show when={isRevised(current().cell)}>
						<span
							class="rounded border border-slate-500 px-0.5 text-2xs text-slate-800"
							data-mark="revised"
						>
							{f().revisedMark}
						</span>
					</Show>
				</span>
			)}
		</Show>
	);
}

function WorkspaceGroup(props: {
	readonly watchlist: WatchlistStock | null;
	readonly listTitles: readonly string[];
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);
	const locale = useLocale();
	const next = () => {
		const stock = props.watchlist;
		return stock === null ? null : nextDatedEvent(stock, utcTodayIso(Date.now()));
	};
	return (
		<Group heading={s().workspaceHeading} field="company-workspace">
			<dl class="mt-1">
				<Item term={s().onWatchlistSince}>
					<Show when={props.watchlist} fallback={<Missing>{s().notOnWatchlistLong}</Missing>}>
						{(stock) => <time dateTime={stock().addedAt}>{stock().addedAt.slice(0, 10)}</time>}
					</Show>
				</Item>
				<Item term={s().lists}>
					<Show when={props.listTitles.length > 0} fallback={<Missing>{s().noLists}</Missing>}>
						{joinNames(props.listTitles, locale())}
					</Show>
				</Item>
				<Item term={s().nextEarnings}>
					<Show
						when={props.watchlist !== null}
						fallback={<Missing>{s().notOnWatchlistLong}</Missing>}
					>
						<Show when={next()} fallback={<Missing>{s().noUpcomingEarnings}</Missing>}>
							{(event) => (
								<span>
									<time dateTime={event().announcementDate ?? undefined} class="font-medium">
										{event().announcementDate}
									</time>{" "}
									({event().fiscalPeriodLabel}
									<Show when={timingText(event().timing, model())}>
										{(timing) => <span>, {timing()}</span>}
									</Show>
									)
								</span>
							)}
						</Show>
					</Show>
				</Item>
			</dl>
		</Group>
	);
}
