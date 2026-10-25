import type {
	EarningsEvent,
	StockDirectoryHit,
	WatchlistResponse,
	WatchlistStock,
	WatchMarket,
} from "@research/contracts";
import {
	type EarningsCalendarEvent,
	googleCalendarUrl,
	outlookCalendarUrl,
} from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { failureMessageIn } from "../api/errorText.ts";
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
	Loading,
	Notice,
	Section,
	Select,
} from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import { createEarningsRefreshQueue } from "./earningsRefreshQueue.ts";
import { createGoogleSyncQueue } from "./googleSyncQueue.ts";
import { StockSearchBox } from "./StockSearchBox.tsx";
import { createStockDirectoryState } from "./stockDirectory.ts";
import { createStockSearch } from "./stockSearch.ts";
import { watchlistMessages } from "./watchlist.messages.ts";
import { watchlistModelMessages } from "./watchlistModel.messages.ts";
import {
	addTargetText,
	directoryStatusLine,
	earningsAutoRefreshReason,
	earningsUnavailableText,
	googleAutoSyncWanted,
	hasNeverRefreshedStock,
	isWatchlistRefreshActive,
	nextDatedEvent,
	pickedStockFor,
	type StockSearchState,
	selectedStockText,
	storedDatesPassed,
	storedDirectoryMarkets,
	timingText,
	utcTodayIso,
	validateNewStock,
	WATCH_MARKETS,
	watchlistRefreshSignal,
	watchlistStatusText,
} from "./watchlistModel.ts";

/**
 * A notice above the page. One that names a queued run goes stale when the
 * run ends (the status line then tells the outcome), so it is marked to be
 * cleared then; the decision is recorded with the text instead of being read
 * back from the words, which differ per language.
 */
interface PageNotice {
	readonly text: string;
	readonly clearsWhenRunEnds: boolean;
}

/** One dated event with its stock's context for the calendar links, or null. */
function toCalendarEvent(
	stock: WatchlistStock,
	event: EarningsEvent,
): EarningsCalendarEvent | null {
	// Never substitutes the added date: without a retrieved stamp there is no
	// calendar link for the event (the ICS writer and link builders need it).
	if (stock.retrievedAt === null) return null;
	return {
		stockId: stock.stockId,
		symbol: stock.symbol,
		name: stock.name,
		periodKey: event.periodKey,
		announcementDate: event.announcementDate,
		fiscalPeriodLabel: event.fiscalPeriodLabel,
		fiscalPeriodEnd: event.fiscalPeriodEnd,
		timing: event.timing,
		publisher: stock.publisher,
		sourceUrl: stock.sourceUrl,
		retrievedAt: stock.retrievedAt,
	};
}

/** "Add to Google Calendar" / "Add to Outlook" anchors for one dated event. */
function CalendarLinks(props: {
	readonly stock: WatchlistStock;
	readonly event: EarningsEvent;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const calendarEvent = () => toCalendarEvent(props.stock, props.event);
	const google = () => {
		const dated = calendarEvent();
		return dated === null ? null : googleCalendarUrl(dated);
	};
	const outlook = () => {
		const dated = calendarEvent();
		return dated === null ? null : outlookCalendarUrl(dated);
	};
	// Inline flow like every other data link in the app (Sources, Chat):
	// as flex items the anchors would blockify and fall below the 24 px
	// target floor the audit checks.
	return (
		<span>
			<Show when={google()}>
				{(url) => <SafeLink url={url()}>{m().addToGoogleCalendar}</SafeLink>}
			</Show>{" "}
			<Show when={outlook()}>{(url) => <SafeLink url={url()}>{m().addToOutlook}</SafeLink>}</Show>
		</span>
	);
}

function NextAnnouncementCell(props: { readonly stock: WatchlistStock }): JSX.Element {
	const m = useMessages(watchlistMessages);
	const model = useMessages(watchlistModelMessages);
	const common = useMessages(commonMessages);
	const stock = () => props.stock;
	const today = () => utcTodayIso(Date.now());
	const next = () => nextDatedEvent(stock(), today());
	const passed = () => next() === null && storedDatesPassed(stock(), today());
	// Further dated events after the one shown: past dates are never listed
	// and never get calendar links.
	const further = () =>
		stock()
			.events.filter(
				(event) => event.announcementDate !== null && event.announcementDate >= today(),
			)
			.slice(1);
	const undecided = () => stock().events.some((event) => event.announcementDate === null);
	return (
		<div>
			<Show
				when={next()}
				fallback={
					<span class="text-amber-900">
						<Show
							when={passed()}
							fallback={
								<Show when={stock().unavailable} fallback={<span>{m().dateUndecided}</span>}>
									{(unavailable) => (
										<span>
											{common().unavailable(earningsUnavailableText(unavailable(), model()))}
										</span>
									)}
								</Show>
							}
						>
							<span>{model().storedDatesPassed}</span>
						</Show>
					</span>
				}
			>
				{(event) => (
					<div>
						<time dateTime={event().announcementDate ?? undefined} class="font-medium">
							{event().announcementDate}
						</time>{" "}
						<span>
							({event().fiscalPeriodLabel}
							<Show when={timingText(event().timing, model())}>
								{(timing) => <span>, {timing()}</span>}
							</Show>
							)
						</span>
						<div class="mt-0.5">
							<CalendarLinks stock={stock()} event={event()} />
						</div>
					</div>
				)}
			</Show>
			<Show when={further().length > 0}>
				<details class="group mt-1 text-xs">
					<DisclosureSummary>{m().furtherDates(further().length)}</DisclosureSummary>
					<ul class="mt-1 space-y-1">
						<For each={further()}>
							{(event) => (
								<li>
									<time dateTime={event.announcementDate ?? undefined}>
										{event.announcementDate}
									</time>{" "}
									({event.fiscalPeriodLabel}
									<Show when={timingText(event.timing, model())}>
										{(timing) => <span>, {timing()}</span>}
									</Show>
									)
									<div class="mt-0.5">
										<CalendarLinks stock={stock()} event={event} />
									</div>
								</li>
							)}
						</For>
					</ul>
				</details>
			</Show>
			<Show when={next() !== null && undecided()}>
				<p class="mt-1 text-xs text-slate-700">{m().oneFurtherUndecided}</p>
			</Show>
		</div>
	);
}

function StockRow(props: {
	readonly stock: WatchlistStock;
	readonly busy: boolean;
	readonly onRemove: (stock: WatchlistStock, opener: HTMLElement) => void;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const model = useMessages(watchlistModelMessages);
	const common = useMessages(commonMessages);
	const stock = () => props.stock;
	return (
		<tr class="border-b border-slate-200 align-top" data-stock-id={stock().stockId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<span class="block font-mono">{stock().symbol}</span>
				<span class="block font-normal text-slate-600">
					{stock().name ?? common().unavailable(m().notRetrievedYet)}
				</span>
			</th>
			<td class="py-1 pr-2">{model().marketName(stock().market)}</td>
			<td class="py-1 pr-2">
				<NextAnnouncementCell stock={stock()} />
			</td>
			<td class="py-1 pr-2 text-slate-700">
				<Show
					when={stock().retrievedAt}
					fallback={<span class="italic">{m().notRetrievedYet}</span>}
				>
					{(at) => <time dateTime={at()}>{formatInstant(at())}</time>}
				</Show>
			</td>
			<td class="py-1 pr-2">
				<SafeLink url={stock().sourceUrl}>{stock().publisher}</SafeLink>
			</td>
			<td class="py-1">
				<button
					type="button"
					class={BUTTON_DANGER}
					aria-label={m().removeNamed(stock().symbol)}
					disabled={props.busy}
					onClick={(event) => props.onRemove(stock(), event.currentTarget)}
				>
					{common().remove}
				</button>
			</td>
		</tr>
	);
}

/**
 * Watchlist: the stocks the owner follows and their earnings announcement
 * dates (FR-018). Uses the shared parts like Sources/Settings — no Shoelace.
 * The calendar settings (Google Calendar, `.ics` download, subscription
 * link) live in Settings → Calendar (ADR-0022); this page still queues the
 * automatic Google sync after its own changes, like Home.
 */
export function WatchlistView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const locale = useLocale();
	const model = useMessages(watchlistModelMessages);
	const [data, setData] = createSignal<WatchlistResponse | null>(null);
	const [etag, setEtag] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [failure, setFailure] = createSignal<{ title: string; error: ApiFailure } | null>(null);
	const [notice, setNotice] = createSignal<PageNotice | null>(null);
	const say = (text: string): void => {
		setNotice({ text, clearsWhenRunEnds: false });
	};
	const [busy, setBusy] = createSignal(false);
	const [market, setMarket] = createSignal<WatchMarket>("US");
	const [symbol, setSymbol] = createSignal("");
	const [query, setQuery] = createSignal("");
	const [searchState, setSearchState] = createSignal<StockSearchState>({ kind: "idle" });
	const [picked, setPicked] = createSignal<StockDirectoryHit | null>(null);
	const [removing, setRemoving] = createSignal<WatchlistStock | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	let disposed = false;
	const refreshQueue = createEarningsRefreshQueue(props.api);
	const googleQueue = createGoogleSyncQueue(props.api);
	let autoRefreshTried = false;
	let followUpArmed = false;
	/** The watchlist ETag an automatic Google sync was already attempted for (at most one per ETag). */
	let googleSyncAttemptedEtag: string | null = null;
	const search = createStockSearch({
		search: (text, signal) => props.api.searchStockDirectory({ q: text }, signal),
		onState: setSearchState,
	});
	const directory = createStockDirectoryState({
		api: props.api,
		visibility: props.visibility,
		// A list that just arrived may answer the query the owner is looking at.
		onListsChanged: () => search.refresh(),
	});
	onCleanup(() => {
		disposed = true;
		poller.stop();
		search.dispose();
		directory.dispose();
	});

	/**
	 * A notice that names a queued run ("…queued for the local runner.",
	 * "…are being fetched…", "…so one refresh was queued.") goes stale when
	 * the run ends — the status line then tells the outcome — so the poller
	 * clears it. Any other notice (added/removed, plain failures, the
	 * follow-up announcement) is kept.
	 */
	const clearQueuedNotice = (): void => {
		if (notice()?.clearsWhenRunEnds === true) setNotice(null);
	};

	const loadWatchlist = async (): Promise<PollSignal> => {
		const result = await props.api.getWatchlist(etag());
		if (disposed) return "unchanged";
		if (!result.ok) {
			if (data() === null) {
				setFailure({ title: m().loadFailed, error: result.error });
			} else {
				say(m().didNotRefresh);
			}
			setLoading(false);
			return "failed";
		}
		if (!result.value.changed) {
			setLoading(false);
			return watchlistRefreshSignal(data());
		}
		setData(result.value.value);
		setEtag(result.value.etag);
		setFailure(null);
		setLoading(false);
		const current = result.value.value;
		return isPollActiveFor(current) ? watchlistRefreshSignal(current) : "changed";
	};

	/** A poll-worthy run: an earnings refresh or a Google Calendar step. */
	function isPollActiveFor(current: WatchlistResponse): boolean {
		return current.refresh.activeRunId !== null || current.googleCalendar.activeRunId !== null;
	}

	const isPollActive = (): boolean => {
		const current = data();
		return current !== null && isPollActiveFor(current);
	};

	const poller = createPoller({
		poll: async () => {
			const signal = await loadWatchlist();
			if (disposed) return "unchanged";
			if (signal === "changed" || signal === "unchanged") {
				// The poller only runs for a queued or active run, so stopping
				// here means that run has ended.
				poller.stop();
				clearQueuedNotice();
				// When the first load found an active run the load rule below
				// never ran: evaluate it now, unless a follow-up was just
				// queued (a no-op once the rule has fired).
				if (!(await maybeFollowUpRefresh())) {
					maybeAutoRefresh();
					maybeAutoGoogleSync();
				}
			}
			return signal;
		},
		visibility: props.visibility,
	});

	/**
	 * Once per mount, after the first successful load: queue one refresh when
	 * the list is non-empty, no run is active, and dates were never fetched
	 * or are more than a day old. A failed queue is reported, never retried.
	 */
	const maybeAutoRefresh = (): void => {
		if (autoRefreshTried || disposed) return;
		const current = data();
		if (current === null || current.refresh.activeRunId !== null) return;
		const reason = earningsAutoRefreshReason(current, Date.now());
		if (reason === null) return;
		autoRefreshTried = true;
		void queueRefresh({ text: model().autoRefreshNotice(reason), clearsWhenRunEnds: true });
	};

	/**
	 * After a load: queue one Google Calendar sync when the pure
	 * `googleAutoSyncWanted` rule says so (connected, out of sync, no failure
	 * on record, no run of either kind active, not already attempted for
	 * this ETag). The ETag is recorded before the request, so a queue
	 * request that fails is reported and not repeated.
	 */
	const maybeAutoGoogleSync = (): void => {
		if (disposed) return;
		const current = data();
		const tag = etag();
		if (current === null || tag === null) return;
		if (!googleAutoSyncWanted(current, tag, googleSyncAttemptedEtag)) return;
		googleSyncAttemptedEtag = tag;
		void googleQueue.queue("sync").then((result) => {
			if (disposed) return;
			if (result.kind === "failed") {
				say(m().googleSyncNotQueued(failureMessageIn(result.error, locale())));
				return;
			}
			if (result.kind === "queued") {
				poller.start();
				void loadWatchlist();
			}
		});
	};
	/**
	 * One follow-up per ended run that a stock was added during, when that
	 * run left a stock never refreshed. A run that was still pending at the
	 * add claims the current watchlist — the new stock included — so when it
	 * covered the new stock nothing more is queued. Bounded by the adds: the
	 * flag is armed only by an add and consumed here.
	 */
	const maybeFollowUpRefresh = async (): Promise<boolean> => {
		if (!followUpArmed || disposed) return false;
		const current = data();
		if (current === null) return false;
		followUpArmed = false;
		if (!hasNeverRefreshedStock(current)) return false;
		await queueRefresh({ text: m().followUpQueued, clearsWhenRunEnds: false });
		return true;
	};

	onMount(() => {
		directory.start();
		void loadWatchlist().then(() => {
			if (disposed) return;
			if (isPollActive()) poller.start();
			else {
				maybeAutoRefresh();
				maybeAutoGoogleSync();
			}
		});
	});

	const reloadAfterWrite = async (): Promise<void> => {
		await loadWatchlist();
		if (disposed) return;
		if (isPollActive()) poller.start();
		else maybeAutoGoogleSync();
	};

	const queueRefresh = async (announce?: PageNotice): Promise<void> => {
		if (refreshQueue.busy() || busy()) {
			say(m().alreadyQueuing);
			return;
		}
		setBusy(true);
		setFailure(null);
		const result = await refreshQueue.queue();
		if (disposed) return;
		setBusy(false);
		if (result.kind === "busy") {
			say(m().alreadyQueuing);
			return;
		}
		if (result.kind === "failed") {
			setFailure({ title: m().refreshNotQueued, error: result.error });
			return;
		}
		setNotice(announce ?? { text: m().refreshQueued, clearsWhenRunEnds: true });
		poller.start();
		void loadWatchlist();
	};

	const addStock = async (): Promise<void> => {
		const problems = validateNewStock(market(), symbol(), model());
		if (problems.length > 0 || busy()) return;
		setBusy(true);
		setFailure(null);
		setNotice(null);
		const result = await props.api.addWatchlistStock({ market: market(), symbol: symbol() });
		if (disposed) return;
		setBusy(false);
		if (!result.ok) {
			setFailure({ title: m().notAdded, error: result.error });
			return;
		}
		const added = symbol().trim().toUpperCase();
		setSymbol("");
		setPicked(null);
		setQuery("");
		search.input("");
		await reloadAfterWrite();
		if (disposed) return;
		if (isPollActive()) {
			// A run is already underway: remember that a follow-up may be
			// needed, and say the dates are being fetched.
			followUpArmed = true;
			setNotice({ text: m().added(added), clearsWhenRunEnds: true });
			return;
		}
		await queueRefresh({ text: m().added(added), clearsWhenRunEnds: true });
	};

	const confirmRemove = async (): Promise<void> => {
		const target = removing();
		if (target === null || busy()) return;
		setBusy(true);
		setFailure(null);
		const result = await props.api.removeWatchlistStock(target.stockId);
		if (disposed) return;
		setBusy(false);
		setRemoving(null);
		if (!result.ok) {
			setFailure({ title: m().notRemoved, error: result.error });
			return;
		}
		say(m().removed(target.symbol));
		await reloadAfterWrite();
	};

	const problems = () => validateNewStock(market(), symbol(), model());
	/** The picked search hit while the form still holds it ("Selected: …"). */
	const selected = () => pickedStockFor(picked(), market(), symbol());
	const selectedText = (): string => {
		const hit = selected();
		return hit === null ? "" : selectedStockText(hit, locale(), model());
	};
	/**
	 * Editing the search text starts a new choice: the pick and any symbol
	 * (picked, or typed by hand under a possibly collapsed "Enter a symbol
	 * instead") are cleared, so "Add stock" never adds a stock other than
	 * the one the form shows. A symbol typed after a search stays, and the
	 * line beside the button names it.
	 */
	const dropPick = (): void => {
		setSymbol("");
		setPicked(null);
	};
	const onQueryInput = (text: string): void => {
		setQuery(text);
		dropPick();
		search.input(text);
	};
	const pickStock = (hit: StockDirectoryHit): void => {
		setMarket(hit.market);
		setSymbol(hit.symbol);
		setPicked(hit);
	};
	const clearSearch = (): void => onQueryInput("");
	const allDirectoryRunsActive = () =>
		directory.status()?.markets.every((entry) => entry.activeRunId !== null) ?? false;
	const problemsId = "watchlist-add-problems";
	const addTargetId = "watchlist-add-target";
	const stocks = () => data()?.stocks ?? [];
	const openRemove = (stock: WatchlistStock, opener: HTMLElement) => {
		setOpener(opener);
		setRemoving(stock);
	};
	const closeDialogs = () => {
		setRemoving(null);
		opener()?.focus();
	};

	return (
		<div class="space-y-3">
			<Show when={failure()}>
				{(current) => (
					<ErrorNotice
						failure={current().error}
						title={current().title}
						onRetry={() => {
							setFailure(null);
							setLoading(true);
							void loadWatchlist();
						}}
					/>
				)}
			</Show>
			<Show when={notice()}>{(current) => <Notice tone="info">{current().text}</Notice>}</Show>

			<Section title={m().addStockTitle} label={m().addStockTitle}>
				<p class="text-xs text-slate-700">{m().addStockHint}</p>
				<Show when={problems().length > 0}>
					<div class="mt-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800">
						<p class="font-medium">{m().toAddThisStock}</p>
						<ul aria-label={m().beforeYouCanAdd} id={problemsId} class="list-disc space-y-0.5 pl-5">
							<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
						</ul>
					</div>
				</Show>
				<form
					aria-label={m().addStockTitle}
					class="mt-2 max-w-xl space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						void addStock();
					}}
				>
					<StockSearchBox
						id="watchlist-search"
						query={query()}
						state={searchState()}
						storedMarkets={storedDirectoryMarkets(directory.status())}
						canSubmit={selected() !== null}
						onQueryInput={onQueryInput}
						onPick={pickStock}
						onClear={clearSearch}
					/>
					<output
						data-field="selected-stock"
						class="block text-sm font-medium text-slate-900 empty:hidden"
					>
						{selectedText()}
					</output>
					<details class="group text-xs">
						<DisclosureSummary class="text-slate-700">{m().enterSymbolInstead}</DisclosureSummary>
						<div class="mt-1 flex flex-wrap items-end gap-2">
							<div class="w-40">
								<label for="watchlist-market" class="block text-xs font-medium text-slate-700">
									{m().market}
								</label>
								<Select
									id="watchlist-market"
									onChange={(event) => {
										const next = event.currentTarget.value;
										if (next === "US" || next === "JP") setMarket(next);
									}}
								>
									<For each={WATCH_MARKETS}>
										{(entry) => (
											<option value={entry} selected={market() === entry}>
												{model().marketName(entry)}
											</option>
										)}
									</For>
								</Select>
							</div>
							<div class="min-w-40 flex-1">
								<label for="watchlist-symbol" class="block text-xs font-medium text-slate-700">
									{m().symbol}
								</label>
								<input
									id="watchlist-symbol"
									type="text"
									class={`${INPUT} font-mono`}
									// i18n-exempt: example tickers, the same in every language
									placeholder={market() === "US" ? "AAPL" : "7203"}
									maxLength={16}
									autocomplete="off"
									spellcheck={false}
									value={symbol()}
									aria-describedby={problems().length > 0 ? problemsId : undefined}
									onInput={(event) => setSymbol(event.currentTarget.value)}
								/>
							</div>
						</div>
					</details>
					<div class="flex flex-wrap items-center gap-2">
						<button
							type="submit"
							class={BUTTON_PRIMARY}
							disabled={busy() || problems().length > 0}
							aria-describedby={
								problems().length > 0 ? `${problemsId} ${addTargetId}` : addTargetId
							}
						>
							{m().addStock}
						</button>
						<output id={addTargetId} data-field="add-target" class="text-sm text-slate-700">
							{addTargetText(market(), symbol(), model())}
						</output>
					</div>
				</form>
				<div
					data-field="stock-lists"
					class="mt-3 flex flex-wrap items-start justify-between gap-2 border-t border-slate-200 pt-2"
				>
					<div
						class="min-w-0 flex-1 space-y-0.5 text-xs text-slate-700"
						data-field="directory-status"
					>
						<Show when={directory.status()}>
							{(current) => (
								<For each={current().markets}>
									{(entry) => (
										<p data-market={entry.market}>
											{directoryStatusLine(entry, model())}{" "}
											<span>
												{m().sourceColumn}:{" "}
												<SafeLink url={entry.sourceUrl}>{entry.publisher}</SafeLink>
											</span>
										</p>
									)}
								</For>
							)}
						</Show>
						<output class="block">{directory.queuedByOwner() ? m().directoryQueued : ""}</output>
					</div>
					<button
						type="button"
						class={BUTTON}
						disabled={directory.queuing() || allDirectoryRunsActive()}
						onClick={() => directory.update()}
					>
						{m().updateStockList}
					</button>
				</div>
				<Show when={directory.failure()}>
					{(current) => (
						<div class="mt-2">
							<ErrorNotice
								failure={current().error}
								title={
									current().action === "load" ? m().directoryLoadFailed : m().directoryNotQueued
								}
								onRetry={current().action === "load" ? () => directory.start() : undefined}
							/>
						</div>
					)}
				</Show>
			</Section>

			<Section
				title={m().registeredStocks}
				actions={
					<button
						type="button"
						class={BUTTON}
						disabled={busy() || isWatchlistRefreshActive(data())}
						onClick={() => void queueRefresh()}
					>
						{m().refreshEarningsDates}
					</button>
				}
			>
				<Show when={data()}>
					{(current) => (
						<output class="mt-1 block text-xs text-slate-700" data-field="watchlist-status">
							{watchlistStatusText(current(), model())}
						</output>
					)}
				</Show>
				<Show when={loading()} fallback={null}>
					<Loading label={m().watchlistThing} />
				</Show>
				<Show when={!loading() && data() !== null}>
					<Show when={stocks().length > 0} fallback={<Empty>{m().noStocks}</Empty>}>
						<div class="overflow-x-auto">
							<table class="mt-1 w-full border-collapse text-left text-xs">
								<caption class="caption-top text-left text-slate-600">{m().stocksCaption}</caption>
								<thead>
									<tr class="border-b border-slate-300">
										<th scope="col" class="pr-2">
											{m().symbol}
										</th>
										<th scope="col" class="pr-2">
											{m().market}
										</th>
										<th scope="col" class="pr-2">
											{m().nextAnnouncementColumn}
										</th>
										<th scope="col" class="pr-2">
											{m().retrievedColumn}
										</th>
										<th scope="col" class="pr-2">
											{m().sourceColumn}
										</th>
										<th scope="col">{m().actionsColumn}</th>
									</tr>
								</thead>
								<tbody>
									<For each={stocks()}>
										{(stock) => <StockRow stock={stock} busy={busy()} onRemove={openRemove} />}
									</For>
								</tbody>
							</table>
						</div>
					</Show>
				</Show>
			</Section>

			<Show when={removing()}>
				{(stock) => (
					<ConfirmDialog
						title={m().removeTitle(stock().symbol)}
						opener={opener()}
						confirmLabel={m().removeStock}
						pending={busy()}
						failure={null}
						onConfirm={() => void confirmRemove()}
						onCancel={closeDialogs}
					>
						{m().removeBody(stock().symbol)}
					</ConfirmDialog>
				)}
			</Show>
		</div>
	);
}
