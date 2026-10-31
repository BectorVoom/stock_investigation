import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityCompanyView,
	type EquityFilingListItem,
	type EquityStatementKind,
	type StockDirectoryHit,
	type WatchMarket,
	watchlistStockIdSchema,
} from "@research/contracts";
import { EQUITY_METRICS, EQUITY_STATEMENTS, type EquityMetricCode } from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	ConfirmDialog,
	DisclosureSummary,
	Empty,
	ErrorNotice,
	INPUT,
	LABEL,
	Loading,
	Notice,
	Section,
	Select,
} from "../components/ui.tsx";
import {
	createPoller,
	type PollSchedule,
	type PollSignal,
	type VisibilitySource,
} from "../lib/polling.ts";
import { createClock } from "../tasks/clock.ts";
import { homeFullText } from "../watchlist/listsModel.ts";
import { StockSearchBox } from "../watchlist/StockSearchBox.tsx";
import { createStockSearch } from "../watchlist/stockSearch.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import {
	type StockSearchState,
	selectedStockText,
	storedDirectoryMarkets,
} from "../watchlist/watchlistModel.ts";
import { equitiesMessages } from "./equities.messages.ts";
import {
	companiesPollSignal,
	companyName,
	companyStockId,
	formatFiscalYearEnd,
	syncFailureText,
	syncInProgress,
	syncStatusText,
} from "./equitiesModel.ts";
import { companyWidgetTitle, STATEMENT_YEAR_CHOICES } from "./FinancialWidgetDialog.tsx";
import { formatPeriodEnd } from "./financialFormat.ts";
import { filingsEntryFor, refreshCompanyReads, statementEntryFor } from "./financialStore.ts";
import { financialsMessages } from "./financials.messages.ts";
import { SegmentedControl } from "./SegmentedControl.tsx";
import { StatementTable } from "./StatementTable.tsx";
import { type ShowOnHomeOutcome, showHistoryOnHome, showStatementOnHome } from "./showOnHome.ts";

/**
 * The page's list poll: every 2.5 s while a sync runs, every 15 s while one
 * waits for a runner, and otherwise every five minutes while the page is
 * visible (with a catch-up read on return) — an unchanged list is a 304.
 */
const COMPANIES_POLL: PollSchedule = {
	activeMs: 2_500,
	idleBaseMs: 300_000,
	idleMaxMs: 300_000,
	queuedMaxMs: 15_000,
	backoffFactor: 2,
};

/** What the page says after an action: a sentence, or a failure with its stable code. */
type PageOutcome =
	| {
			readonly kind: "notice";
			readonly tone: "success" | "info" | "warning";
			readonly text: string;
	  }
	| { readonly kind: "failure"; readonly title: string; readonly error: ApiFailure };

/** The search hits with "Added" meaning "already tracked here" (not "on the watchlist"). */
function withTracked(state: StockSearchState, tracked: ReadonlySet<string>): StockSearchState {
	if (state.kind !== "results" && state.kind !== "searching") return state;
	return {
		...state,
		hits: state.hits.map((hit) => ({ ...hit, registered: tracked.has(hit.stockId) })),
	};
}

/**
 * The Equities page (ADR-0048 §8): the companies tracked for the financial
 * statement widgets with their sync status (Sync now, Remove — the data is
 * kept), tracking a company through the stock directory search (ADR-0034)
 * or an exact stock id, and one company's three statements with their
 * revisions and filings, each placeable on Home. Everything is read from
 * our API; the page never reaches SEC or EDINET.
 */
export function EquitiesView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const m = useMessages(equitiesMessages);
	const f = useMessages(financialsMessages);
	const listsText = useMessages(watchlistListsMessages);
	const model = useMessages(watchlistModelMessages);
	const locale = useLocale();
	const now = createClock();

	const [companies, setCompanies] = createSignal<readonly EquityCompanyView[] | null>(null);
	const [listFailure, setListFailure] = createSignal<ApiFailure | null>(null);
	const [selectedId, setSelectedId] = createSignal<string | null>(null);
	const [outcome, setOutcome] = createSignal<PageOutcome | null>(null);
	const [busy, setBusy] = createSignal<ReadonlySet<string>>(new Set());
	const [removing, setRemoving] = createSignal<EquityCompanyView | null>(null);
	const [removeOpener, setRemoveOpener] = createSignal<HTMLElement | null>(null);
	let etag: string | null = null;
	let disposed = false;
	onCleanup(() => {
		disposed = true;
	});

	const trackedIds = createMemo(
		() => new Set((companies() ?? []).filter((c) => c.tracked).map(companyStockId)),
	);
	const selected = createMemo(
		() => companies()?.find((company) => company.companyId === selectedId()) ?? null,
	);

	/** Re-reads a company's statements when its last successful sync moved (values may have changed). */
	const noteFinishedSyncs = (
		before: readonly EquityCompanyView[] | null,
		after: readonly EquityCompanyView[],
	): void => {
		if (before === null) return;
		const previous = new Map(before.map((company) => [company.companyId, company] as const));
		for (const company of after) {
			const old = previous.get(company.companyId);
			if (old !== undefined && old.sync.lastSucceededAt !== company.sync.lastSucceededAt) {
				refreshCompanyReads(props.api, company.companyId);
			}
		}
	};

	const load = async (): Promise<PollSignal> => {
		const answer = await props.api.listEquityCompanies(etag);
		if (disposed) return "unchanged";
		if (!answer.ok) {
			setListFailure(answer.error);
			return "failed";
		}
		setListFailure(null);
		if (answer.value.changed) {
			etag = answer.value.etag;
			const next = answer.value.value.companies.filter((company) => company.tracked);
			noteFinishedSyncs(companies(), next);
			setCompanies(next);
			const current = selectedId();
			if (current === null || !next.some((company) => company.companyId === current)) {
				setSelectedId(next[0]?.companyId ?? null);
			}
		}
		return (
			companiesPollSignal(companies() ?? []) ?? (answer.value.changed ? "changed" : "unchanged")
		);
	};
	const poller = createPoller({
		poll: load,
		visibility: props.visibility,
		schedule: COMPANIES_POLL,
	});
	onMount(() => poller.start());
	onCleanup(() => poller.stop());

	const setBusyFor = (companyId: string, on: boolean): void => {
		setBusy((current) => {
			const next = new Set(current);
			if (on) next.add(companyId);
			else next.delete(companyId);
			return next;
		});
	};

	/** Puts a company the API answered for into the list in place (its new sync status). */
	const replaceCompany = (company: EquityCompanyView): void => {
		setCompanies((current) =>
			current === null
				? current
				: current.map((entry) => (entry.companyId === company.companyId ? company : entry)),
		);
	};

	const syncNow = async (company: EquityCompanyView): Promise<void> => {
		setBusyFor(company.companyId, true);
		const answer = await props.api.syncEquityCompany(company.companyId);
		if (disposed) return;
		setBusyFor(company.companyId, false);
		if (!answer.ok) {
			setOutcome({ kind: "failure", title: m().syncFailed, error: answer.error });
			return;
		}
		replaceCompany(answer.value);
		setOutcome({ kind: "notice", tone: "info", text: m().syncQueued(companyName(company)) });
		poller.pollNow();
	};

	const confirmRemove = async (): Promise<void> => {
		const company = removing();
		if (company === null || busy().has(company.companyId)) return;
		setBusyFor(company.companyId, true);
		const answer = await props.api.untrackEquityCompany(company.companyId);
		if (disposed) return;
		setBusyFor(company.companyId, false);
		setRemoving(null);
		removeOpener()?.focus();
		if (!answer.ok) {
			setOutcome({ kind: "failure", title: m().removeFailed, error: answer.error });
			return;
		}
		setCompanies((current) =>
			current === null ? current : current.filter((entry) => entry.companyId !== company.companyId),
		);
		if (selectedId() === company.companyId) setSelectedId(companies()?.[0]?.companyId ?? null);
		setOutcome({ kind: "notice", tone: "success", text: m().removed(companyName(company)) });
		poller.pollNow();
	};

	/* ---------- Track a company ---------- */

	const searchId = createUniqueId();
	const idInputId = createUniqueId();
	const targetId = createUniqueId();
	const [query, setQuery] = createSignal("");
	const [searchState, setSearchState] = createSignal<StockSearchState>({ kind: "idle" });
	const [found, setFound] = createSignal<StockDirectoryHit | null>(null);
	const [typedId, setTypedId] = createSignal("");
	const [tracking, setTracking] = createSignal(false);
	const [storedMarkets, setStoredMarkets] = createSignal<readonly WatchMarket[] | null>(null);
	const search = createStockSearch({
		search: (text, signal) => props.api.searchStockDirectory({ q: text }, signal),
		onState: setSearchState,
	});
	onCleanup(() => search.dispose());
	onMount(() => {
		// Explains a search answer that covers one market only; a failure just leaves it unexplained.
		void props.api.getStockDirectory().then((answer) => {
			if (!disposed && answer.ok) setStoredMarkets(storedDirectoryMarkets(answer.value));
		});
	});
	const onQueryInput = (text: string): void => {
		setQuery(text);
		setFound(null);
		search.input(text);
	};
	/** The stock to track: the picked hit, else the typed id when it is one. */
	const target = (): string | null => {
		const hit = found();
		if (hit !== null) return hit.stockId;
		const typed = typedId().trim();
		return typed === "" ? null : typed;
	};
	const typedInvalid = (): boolean =>
		found() === null &&
		typedId().trim() !== "" &&
		!watchlistStockIdSchema.safeParse(typedId().trim()).success;
	const atLimit = (): boolean =>
		(companies()?.length ?? 0) >= EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies;

	const track = async (): Promise<void> => {
		const stockId = target();
		if (stockId === null || typedInvalid() || tracking() || atLimit()) return;
		setTracking(true);
		const answer = await props.api.trackEquityCompany(stockId);
		if (disposed) return;
		setTracking(false);
		if (!answer.ok) {
			setOutcome({ kind: "failure", title: m().trackFailed, error: answer.error });
			return;
		}
		const company = answer.value;
		setCompanies((current) => {
			const rest = (current ?? []).filter((entry) => entry.companyId !== company.companyId);
			return [...rest, company];
		});
		setSelectedId(company.companyId);
		setOutcome({ kind: "notice", tone: "success", text: m().tracked(companyName(company)) });
		onQueryInput("");
		setTypedId("");
		poller.pollNow();
	};

	/* ---------- One company ---------- */

	const [statement, setStatement] = createSignal<EquityStatementKind>("income-statement");
	const [years, setYears] = createSignal<number>(EQUITY_FINANCIAL_LIMITS.defaultYears);
	const [chartMetric, setChartMetric] = createSignal<EquityMetricCode>("revenue");
	const chartMetricId = createUniqueId();
	const entry = createMemo(() => {
		const id = selectedId();
		return id === null ? null : statementEntryFor(props.api, id, statement(), years());
	});
	createEffect(() => {
		const current = entry();
		if (current !== null) onCleanup(current.attach(props.visibility));
	});
	const response = () => entry()?.value();
	/** The company's filings: every stored one, whichever statement is shown. */
	const filingsEntry = createMemo(() => {
		const id = selectedId();
		return id === null ? null : filingsEntryFor(props.api, id);
	});
	createEffect(() => {
		const current = filingsEntry();
		if (current !== null) onCleanup(current.attach(props.visibility));
	});

	const homeOutcomeText = (shown: ShowOnHomeOutcome, what: string): PageOutcome => {
		switch (shown.kind) {
			case "added":
				return { kind: "notice", tone: "success", text: m().addedToHome(what) };
			case "already":
				return { kind: "notice", tone: "info", text: m().alreadyOnHome(what) };
			case "full":
				return { kind: "notice", tone: "warning", text: homeFullText(shown.problem, listsText()) };
			case "failed":
				return { kind: "failure", title: m().notAddedToHome, error: shown.failure };
		}
	};
	const addStatement = async (company: EquityCompanyView): Promise<void> => {
		const chosen = statement();
		const shown = await showStatementOnHome(props.api, company, chosen, years());
		if (disposed) return;
		setOutcome(homeOutcomeText(shown, `${f().statement(chosen)} — ${companyWidgetTitle(company)}`));
	};
	const addChart = async (company: EquityCompanyView): Promise<void> => {
		const chosen = chartMetric();
		const shown = await showHistoryOnHome(props.api, company, chosen, 10);
		if (disposed) return;
		setOutcome(homeOutcomeText(shown, f().chartTitle(f().metric(chosen), companyName(company))));
	};

	return (
		<div class="space-y-3" data-page="equities">
			{/* Keyed: each outcome replaces the last one whole (a notice or a failure). */}
			<Show when={outcome()} keyed>
				{(value) => {
					return value.kind === "failure" ? (
						<ErrorNotice failure={value.error} title={value.title} />
					) : (
						<Notice tone={value.tone} data-field="equities-outcome">
							{value.text}
						</Notice>
					);
				}}
			</Show>

			<Section
				title={m().trackedHeading}
				busy={companies() === null && listFailure() === null}
				actions={
					<Show when={companies()}>
						{(list) => (
							<span class="text-xs text-slate-700" data-field="tracked-count">
								{m().trackedCount(list().length, EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies)}
							</span>
						)}
					</Show>
				}
			>
				<div class="mt-2 space-y-2">
					<Show when={listFailure()}>
						{(error) => (
							<ErrorNotice
								failure={error()}
								title={m().companiesFailed}
								onRetry={() => poller.pollNow()}
							/>
						)}
					</Show>
					<Show
						when={companies()}
						fallback={
							<Show when={listFailure() === null}>
								<Loading label={m().companiesThing} />
							</Show>
						}
					>
						{(list) => (
							<Show when={list().length > 0} fallback={<Empty>{m().noCompanies}</Empty>}>
								<div class="overflow-x-auto">
									<table class="w-full border-collapse text-left text-sm" data-field="companies">
										<caption class="sr-only">{m().tableCaption}</caption>
										<thead>
											<tr class="border-b border-slate-200 text-xs text-slate-700">
												<th scope="col" class="py-1 pr-2 font-medium">
													{m().company}
												</th>
												<th scope="col" class="py-1 pr-2 font-medium">
													{m().market}
												</th>
												<th scope="col" class="py-1 pr-2 font-medium">
													{m().sourceId}
												</th>
												<th scope="col" class="py-1 pr-2 font-medium">
													{m().fiscalYearEnd}
												</th>
												<th scope="col" class="py-1 pr-2 text-right font-medium">
													{m().latestFiscalYear}
												</th>
												<th scope="col" class="py-1 pr-2 text-right font-medium">
													{m().filings}
												</th>
												<th scope="col" class="py-1 pr-2 font-medium">
													{m().sync}
												</th>
												<th scope="col" class="py-1 font-medium">
													{m().actions}
												</th>
											</tr>
										</thead>
										<tbody>
											<For each={list()}>
												{(company) => (
													<CompanyRow
														company={company}
														selected={company.companyId === selectedId()}
														busy={busy().has(company.companyId)}
														nowMs={now()}
														onShow={() => setSelectedId(company.companyId)}
														onSync={() => void syncNow(company)}
														onRemove={(button) => {
															setRemoveOpener(button);
															setRemoving(company);
														}}
													/>
												)}
											</For>
										</tbody>
									</table>
								</div>
							</Show>
						)}
					</Show>
				</div>
			</Section>

			<Section title={m().trackHeading}>
				<form
					class="mt-2 space-y-2"
					data-field="track-company"
					onSubmit={(event) => {
						event.preventDefault();
						void track();
					}}
				>
					<p class="text-xs text-slate-700">{m().trackHint}</p>
					<div class="max-w-xl">
						<StockSearchBox
							id={searchId}
							query={query()}
							state={withTracked(searchState(), trackedIds())}
							storedMarkets={storedMarkets()}
							canSubmit={found() !== null}
							onQueryInput={onQueryInput}
							onPick={(hit) => setFound(hit)}
							onClear={() => onQueryInput("")}
						/>
						<output
							data-field="selected-stock"
							class="block text-sm font-medium text-slate-900 empty:hidden"
						>
							{(() => {
								const hit = found();
								return hit === null ? "" : selectedStockText(hit, locale(), model());
							})()}
						</output>
					</div>
					<details class="group max-w-xl">
						<DisclosureSummary class="text-xs text-slate-700">{m().idDisclosure}</DisclosureSummary>
						<div class="mt-1">
							<label for={idInputId} class={LABEL}>
								{m().idLabel}
							</label>
							<input
								id={idInputId}
								type="text"
								class={`${INPUT} font-mono`}
								value={typedId()}
								placeholder={m().idPlaceholder}
								autocomplete="off"
								spellcheck={false}
								aria-describedby={`${idInputId}-hint`}
								aria-invalid={typedInvalid()}
								onInput={(event) => {
									setTypedId(event.currentTarget.value);
									setFound(null);
								}}
							/>
							<p id={`${idInputId}-hint`} class="text-2xs text-slate-600">
								{m().idHint}
							</p>
							<Show when={typedInvalid()}>
								<p class="text-xs text-red-900" data-field="stock-id-invalid">
									{m().idInvalid}
								</p>
							</Show>
						</div>
					</details>
					<Show when={atLimit()}>
						<p class="text-xs text-amber-900" data-field="track-limit">
							{m().atLimit(EQUITY_FINANCIAL_LIMITS.maxTrackedCompanies)}
						</p>
					</Show>
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="submit"
							class={BUTTON_PRIMARY}
							aria-describedby={target() === null ? undefined : targetId}
							disabled={target() === null || typedInvalid() || tracking() || atLimit()}
						>
							{m().trackButton}
						</button>
						<Show when={target()}>
							{(stockId) => (
								<output id={targetId} class="text-xs text-slate-700" data-field="track-target">
									{m().toTrack(stockId())}
								</output>
							)}
						</Show>
					</div>
				</form>
			</Section>

			<Show
				when={selected()}
				fallback={
					<Show when={(companies()?.length ?? 0) > 0}>
						<p class="text-sm text-slate-700">{m().chooseCompany}</p>
					</Show>
				}
			>
				{(company) => (
					<Section
						title={m().detailHeading(companyWidgetTitle(company()))}
						busy={entry()?.loading() === true}
						actions={
							<div class="flex flex-wrap items-center gap-2">
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
									label={m().yearsLabel}
									options={STATEMENT_YEAR_CHOICES}
									selected={years() === 10 ? 10 : 5}
									optionLabel={(option) => m().yearsOption(option)}
									onSelect={setYears}
								/>
							</div>
						}
					>
						<div
							class="@container mt-2 space-y-3"
							data-field="company-detail"
							data-company-id={company().companyId}
						>
							<Show when={entry()?.failure()}>
								{(error) => (
									<ErrorNotice
										failure={error()}
										title={f().statementFailed}
										onRetry={() => entry()?.refresh()}
									/>
								)}
							</Show>
							<Show
								when={response()}
								fallback={
									<Show when={entry()?.failure() === null}>
										<Loading label={f().statementThing} />
									</Show>
								}
							>
								{(current) => (
									<Show
										when={current().fiscalYears.length > 0}
										fallback={<Empty>{f().noDataYet}</Empty>}
									>
										<StatementTable api={props.api} response={current()} />
										<div class="flex flex-wrap items-end gap-2">
											<button
												type="button"
												class={BUTTON}
												onClick={() => void addStatement(company())}
											>
												{m().addStatementToHome}
											</button>
											<div class="w-64">
												<label for={chartMetricId} class={LABEL}>
													{m().chartMetric}
												</label>
												<Select
													id={chartMetricId}
													onChange={(event) => {
														const value = event.currentTarget.value;
														const found = EQUITY_METRICS.find(
															(definition) => definition.code === value,
														);
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
											<button type="button" class={BUTTON} onClick={() => void addChart(company())}>
												{m().addChartToHome}
											</button>
										</div>
									</Show>
								)}
							</Show>
							<CompanyFilings />
						</div>
					</Section>
				)}
			</Show>

			<Show when={removing()}>
				{(company) => (
					<ConfirmDialog
						title={m().removeHeading(companyName(company()))}
						opener={removeOpener()}
						confirmLabel={m().removeConfirm}
						pending={busy().has(company().companyId)}
						failure={null}
						onConfirm={() => void confirmRemove()}
						onCancel={() => setRemoving(null)}
					>
						<p>{m().removeBody}</p>
					</ConfirmDialog>
				)}
			</Show>
		</div>
	);

	/** One tracked company: identity, sync status with its failure, and its actions. */
	function CompanyRow(row: {
		readonly company: EquityCompanyView;
		readonly selected: boolean;
		readonly busy: boolean;
		readonly nowMs: number;
		readonly onShow: () => void;
		readonly onSync: () => void;
		readonly onRemove: (button: HTMLElement) => void;
	}): JSX.Element {
		const name = () => companyName(row.company);
		const failure = () => syncFailureText(row.company, m());
		return (
			<tr
				class="border-b border-slate-200 align-top"
				classList={{ "bg-blue-50": row.selected }}
				aria-current={row.selected ? "true" : undefined}
				data-company-id={row.company.companyId}
				data-sync-status={row.company.sync.status}
			>
				<th scope="row" class="py-1 pr-2 font-normal">
					<button
						type="button"
						class="min-h-6 text-left text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
						aria-label={m().showNamed(name())}
						aria-pressed={row.selected}
						onClick={() => row.onShow()}
					>
						<span class="block font-medium">{row.company.name ?? m().nameUnknown}</span>
					</button>
					<span class="block font-mono text-xs text-slate-700">{row.company.symbol}</span>
				</th>
				<td class="py-1 pr-2">{m().marketName(row.company.market)}</td>
				<td class="py-1 pr-2">
					<span class="block text-xs text-slate-700">{m().sourceIdKind(row.company.provider)}</span>
					<Show
						when={row.company.sourceCompanyId}
						fallback={<span class="text-xs italic text-slate-600">{m().notResolved}</span>}
					>
						{(id) => <span class="font-mono text-xs">{id()}</span>}
					</Show>
				</td>
				<td class="py-1 pr-2 whitespace-nowrap">
					<Show
						when={row.company.fiscalYearEnd}
						fallback={<span class="text-xs italic text-slate-600">{m().unknown}</span>}
					>
						{(end) => formatFiscalYearEnd(end(), locale())}
					</Show>
				</td>
				<td class="py-1 pr-2 text-right tabular-nums">
					<Show
						when={row.company.latestFiscalYear}
						fallback={<span class="text-xs italic text-slate-600">{m().unknown}</span>}
					>
						{(year) => f().fiscalYear(year())}
					</Show>
				</td>
				<td class="py-1 pr-2 text-right tabular-nums">{row.company.filingCount}</td>
				<td class="py-1 pr-2 text-xs">
					<span class="block text-slate-800" data-field="sync-status">
						{syncInProgress(row.company) ? "◐ " : ""}
						{syncStatusText(row.company, row.nowMs, locale(), m())}
					</span>
					<Show when={failure()}>
						{(text) => (
							<span class="block text-red-900" data-field="sync-failure">
								<span class="font-mono font-semibold">{row.company.sync.failure?.code}</span>
								{": "}
								{text()}
							</span>
						)}
					</Show>
				</td>
				<td class="py-1">
					<div class="flex flex-wrap gap-1">
						<button
							type="button"
							class={BUTTON}
							aria-label={m().syncNowNamed(name())}
							disabled={row.busy || syncInProgress(row.company)}
							onClick={() => row.onSync()}
						>
							{m().syncNow}
						</button>
						<button
							type="button"
							class={BUTTON_DANGER}
							aria-label={m().removeNamed(name())}
							disabled={row.busy}
							onClick={(event) => row.onRemove(event.currentTarget)}
						>
							{m().remove}
						</button>
					</div>
				</td>
			</tr>
		);
	}

	/**
	 * Every stored filing of the selected company (the filings read), newest
	 * first: form, dates, standard, the original an amendment replaces, what
	 * the sync read from it (pending, read with its value count, or no
	 * machine-readable values) and a link to the source document. Independent
	 * of the statement switch: it lists superseded originals and filings
	 * without values too.
	 */
	function CompanyFilings(): JSX.Element {
		const headingId = createUniqueId();
		const read = () => filingsEntry();
		return (
			<section aria-labelledby={headingId} data-field="company-filings">
				<h4 id={headingId} class="text-sm font-semibold text-slate-900">
					{m().filingsHeading}
				</h4>
				<p class="text-xs text-slate-700">{m().filingsIntro}</p>
				<Show when={read()?.failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().filingsFailed}
							onRetry={() => read()?.refresh()}
						/>
					)}
				</Show>
				<Show
					when={read()?.value()}
					fallback={
						<Show when={read()?.failure() === null}>
							<Loading label={m().filingsThing} />
						</Show>
					}
				>
					{(answer) => (
						<Show when={answer().filings.length > 0} fallback={<Empty>{m().noFilings}</Empty>}>
							<FilingsTable filings={answer().filings} />
						</Show>
					)}
				</Show>
			</section>
		);
	}

	function FilingsTable(table: { readonly filings: readonly EquityFilingListItem[] }): JSX.Element {
		return (
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm" data-field="filings">
					<caption class="sr-only">{m().filingsCaption}</caption>
					<thead>
						<tr class="border-b border-slate-200 text-xs text-slate-700">
							<th scope="col" class="py-1 pr-2 font-medium">
								{m().form}
							</th>
							<th scope="col" class="py-1 pr-2 font-medium">
								{m().filed}
							</th>
							<th scope="col" class="py-1 pr-2 font-medium">
								{m().periodEnd}
							</th>
							<th scope="col" class="py-1 pr-2 font-medium">
								{m().standard}
							</th>
							<th scope="col" class="py-1 pr-2 font-medium">
								{m().amendment}
							</th>
							<th scope="col" class="py-1 pr-2 font-medium">
								{m().factsColumn}
							</th>
							<th scope="col" class="py-1 font-medium">
								{m().link}
							</th>
						</tr>
					</thead>
					<tbody>
						<For each={table.filings}>
							{(filing) => (
								<tr
									class="border-b border-slate-200 align-top"
									data-filing-id={filing.filingId}
									data-facts-status={filing.factsStatus}
								>
									<th scope="row" class="py-1 pr-2 font-normal">
										{f().form(filing.form)}
									</th>
									<td class="py-1 pr-2 whitespace-nowrap">{filing.filedOn}</td>
									<td class="py-1 pr-2 whitespace-nowrap">
										{formatPeriodEnd(filing.periodEnd, locale())}
									</td>
									<td class="py-1 pr-2">
										<Show
											when={filing.accountingStandard}
											fallback={
												<span class="text-xs italic text-slate-600">{m().standardUnknown}</span>
											}
										>
											{(standard) => f().standard(standard())}
										</Show>
									</td>
									<td class="py-1 pr-2" data-field="filing-amendment">
										<Show when={filing.isAmendment} fallback={m().original}>
											<Show when={filing.amendsSourceDocumentId} fallback={m().isAmendment}>
												{(original) => (
													<span class="font-mono text-xs">{m().amendsDocument(original())}</span>
												)}
											</Show>
										</Show>
									</td>
									<td class="py-1 pr-2 text-xs" data-field="filing-facts">
										<span
											classList={{
												"text-slate-800": filing.factsStatus === "extracted",
												"italic text-slate-600": filing.factsStatus !== "extracted",
											}}
										>
											{m().factsStatus(filing.factsStatus)}
										</span>
										<Show when={filing.factsStatus === "extracted"}>
											<span class="block text-2xs text-slate-600">
												{m().factCount(filing.factCount)}
											</span>
										</Show>
									</td>
									<td class="py-1">
										<SafeLink
											url={filing.sourceUrl}
											label={f().openFiling(f().form(filing.form), filing.filedOn)}
										>
											{m().openFiling}
										</SafeLink>
									</td>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
		);
	}
}
