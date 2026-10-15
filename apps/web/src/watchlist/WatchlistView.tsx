import type {
	EarningsEvent,
	WatchlistResponse,
	WatchlistStock,
	WatchMarket,
} from "@research/contracts";
import {
	type EarningsCalendarEvent,
	googleCalendarUrl,
	outlookCalendarUrl,
} from "@research/domain";
import { SafeLink } from "@research/ui-registry";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
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
	Loading,
	Notice,
	Section,
	Select,
} from "../components/ui.tsx";
import { formatInstant } from "../lib/format.ts";
import { createPoller, type PollSignal, type VisibilitySource } from "../lib/polling.ts";
import { createEarningsRefreshQueue } from "./earningsRefreshQueue.ts";
import { createGoogleSyncQueue } from "./googleSyncQueue.ts";
import {
	EARNINGS_AUTO_REFRESH_NOTICE,
	earningsAutoRefreshReason,
	googleAutoSyncWanted,
	hasNeverRefreshedStock,
	isWatchlistRefreshActive,
	MARKET_LABELS,
	nextDatedEvent,
	STORED_DATES_PASSED_NOTICE,
	storedDatesPassed,
	timingText,
	utcTodayIso,
	validateNewStock,
	WATCH_MARKETS,
	watchlistRefreshSignal,
	watchlistStatusText,
} from "./watchlistModel.ts";

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
				{(url) => <SafeLink url={url()}>Add to Google Calendar</SafeLink>}
			</Show>{" "}
			<Show when={outlook()}>{(url) => <SafeLink url={url()}>Add to Outlook</SafeLink>}</Show>
		</span>
	);
}

function NextAnnouncementCell(props: { readonly stock: WatchlistStock }): JSX.Element {
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
								<Show when={stock().unavailable} fallback={<span>date undecided</span>}>
									{(unavailable) => <span>unavailable ({unavailable().reason})</span>}
								</Show>
							}
						>
							<span>{STORED_DATES_PASSED_NOTICE}</span>
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
							<Show when={timingText(event().timing)}>{(timing) => <span>, {timing()}</span>}</Show>
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
					<DisclosureSummary>
						{further().length} further date{further().length === 1 ? "" : "s"}
					</DisclosureSummary>
					<ul class="mt-1 space-y-1">
						<For each={further()}>
							{(event) => (
								<li>
									<time dateTime={event.announcementDate ?? undefined}>
										{event.announcementDate}
									</time>{" "}
									({event.fiscalPeriodLabel}
									<Show when={timingText(event.timing)}>
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
				<p class="mt-1 text-xs text-slate-700">One further announcement has its date undecided.</p>
			</Show>
		</div>
	);
}

function StockRow(props: {
	readonly stock: WatchlistStock;
	readonly busy: boolean;
	readonly onRemove: (stock: WatchlistStock, opener: HTMLElement) => void;
}): JSX.Element {
	const stock = () => props.stock;
	return (
		<tr class="border-b border-slate-200 align-top" data-stock-id={stock().stockId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<span class="block font-mono">{stock().symbol}</span>
				<span class="block font-normal text-slate-600">
					{stock().name ?? "unavailable (not retrieved yet)"}
				</span>
			</th>
			<td class="py-1 pr-2">{MARKET_LABELS[stock().market]}</td>
			<td class="py-1 pr-2">
				<NextAnnouncementCell stock={stock()} />
			</td>
			<td class="py-1 pr-2 text-slate-700">
				<Show when={stock().retrievedAt} fallback={<span class="italic">not retrieved yet</span>}>
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
					aria-label={`Remove ${stock().symbol}`}
					disabled={props.busy}
					onClick={(event) => props.onRemove(stock(), event.currentTarget)}
				>
					Remove
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
	const [data, setData] = createSignal<WatchlistResponse | null>(null);
	const [etag, setEtag] = createSignal<string | null>(null);
	const [loading, setLoading] = createSignal(true);
	const [failure, setFailure] = createSignal<{ title: string; error: ApiFailure } | null>(null);
	const [notice, setNotice] = createSignal<string | null>(null);
	const [busy, setBusy] = createSignal(false);
	const [market, setMarket] = createSignal<WatchMarket>("US");
	const [symbol, setSymbol] = createSignal("");
	const [removing, setRemoving] = createSignal<WatchlistStock | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	let disposed = false;
	const refreshQueue = createEarningsRefreshQueue(props.api);
	const googleQueue = createGoogleSyncQueue(props.api);
	let autoRefreshTried = false;
	let followUpArmed = false;
	/** The watchlist ETag an automatic Google sync was already attempted for (at most one per ETag). */
	let googleSyncAttemptedEtag: string | null = null;
	onCleanup(() => {
		disposed = true;
		poller.stop();
	});

	/**
	 * A notice that names a queued run ("…queued for the local runner.",
	 * "…are being fetched…", "…so one refresh was queued.") goes stale when
	 * the run ends — the status line then tells the outcome — so the poller
	 * clears it. Any other notice (added/removed, plain failures) is kept.
	 */
	const clearQueuedNotice = (): void => {
		const text = notice();
		if (
			text !== null &&
			(text.includes("queued for the local runner") ||
				text.includes("being fetched") ||
				text.includes("so one refresh was queued"))
		) {
			setNotice(null);
		}
	};

	const loadWatchlist = async (): Promise<PollSignal> => {
		const result = await props.api.getWatchlist(etag());
		if (disposed) return "unchanged";
		if (!result.ok) {
			if (data() === null) {
				setFailure({ title: "Could not load the watchlist.", error: result.error });
			} else {
				setNotice("The watchlist did not refresh.");
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
		void queueRefresh(EARNINGS_AUTO_REFRESH_NOTICE[reason]);
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
				setNotice(`The Google Calendar sync was not queued: ${result.error.message}`);
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
		await queueRefresh(
			"A stock was added while the refresh ran, so one follow-up refresh was queued.",
		);
		return true;
	};

	onMount(() => {
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

	const queueRefresh = async (announce?: string): Promise<void> => {
		if (refreshQueue.busy() || busy()) {
			setNotice("An earnings-date refresh is already being queued.");
			return;
		}
		setBusy(true);
		setFailure(null);
		const result = await refreshQueue.queue();
		if (disposed) return;
		setBusy(false);
		if (result.kind === "busy") {
			setNotice("An earnings-date refresh is already being queued.");
			return;
		}
		if (result.kind === "failed") {
			setFailure({ title: "The earnings-date refresh was not queued.", error: result.error });
			return;
		}
		setNotice(announce ?? "Earnings-date refresh queued for the local runner.");
		poller.start();
		void loadWatchlist();
	};

	const addStock = async (): Promise<void> => {
		const problems = validateNewStock(market(), symbol());
		if (problems.length > 0 || busy()) return;
		setBusy(true);
		setFailure(null);
		setNotice(null);
		const result = await props.api.addWatchlistStock({ market: market(), symbol: symbol() });
		if (disposed) return;
		setBusy(false);
		if (!result.ok) {
			setFailure({ title: "The stock was not added.", error: result.error });
			return;
		}
		const added = symbol().trim().toUpperCase();
		setSymbol("");
		await reloadAfterWrite();
		if (disposed) return;
		if (isPollActive()) {
			// A run is already underway: remember that a follow-up may be
			// needed, and say the dates are being fetched.
			followUpArmed = true;
			setNotice(`Added ${added}. Its earnings dates are being fetched by the local runner.`);
			return;
		}
		await queueRefresh(`Added ${added}. Its earnings dates are being fetched by the local runner.`);
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
			setFailure({ title: "The stock was not removed.", error: result.error });
			return;
		}
		setNotice(`Removed ${target.symbol}.`);
		await reloadAfterWrite();
	};

	const problems = () => validateNewStock(market(), symbol());
	const problemsId = "watchlist-add-problems";
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
			<Show when={notice()}>{(text) => <Notice tone="info">{text()}</Notice>}</Show>

			<Section title="Add a stock" label="Add a stock">
				<p class="text-xs text-slate-700">
					Register a US listing or a Japanese listing. Its earnings announcement dates appear below
					after the next refresh.
				</p>
				<Show when={problems().length > 0}>
					<div class="mt-2 rounded border border-slate-300 bg-slate-50 px-3 py-2 text-xs text-slate-800">
						<p class="font-medium">To add this stock:</p>
						<ul
							aria-label="Before you can add this stock"
							id={problemsId}
							class="list-disc space-y-0.5 pl-5"
						>
							<For each={problems()}>{(problem) => <li>{problem}</li>}</For>
						</ul>
					</div>
				</Show>
				<form
					aria-label="Add a stock"
					class="mt-2 flex flex-wrap items-end gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void addStock();
					}}
				>
					<div class="w-40">
						<label for="watchlist-market" class="block text-xs font-medium text-slate-700">
							Market
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
										{entry === "US" ? "US" : "Japan"}
									</option>
								)}
							</For>
						</Select>
					</div>
					<div class="min-w-40 flex-1">
						<label for="watchlist-symbol" class="block text-xs font-medium text-slate-700">
							Symbol
						</label>
						<input
							id="watchlist-symbol"
							type="text"
							class={`${INPUT} font-mono`}
							placeholder={market() === "US" ? "AAPL" : "7203"}
							maxLength={16}
							autocomplete="off"
							spellcheck={false}
							value={symbol()}
							aria-describedby={problems().length > 0 ? problemsId : undefined}
							onInput={(event) => setSymbol(event.currentTarget.value)}
						/>
					</div>
					<button
						type="submit"
						class={BUTTON_PRIMARY}
						disabled={busy() || problems().length > 0}
						aria-describedby={problems().length > 0 ? problemsId : undefined}
					>
						Add stock
					</button>
				</form>
			</Section>

			<Section
				title="Registered stocks"
				actions={
					<button
						type="button"
						class={BUTTON}
						disabled={busy() || isWatchlistRefreshActive(data())}
						onClick={() => void queueRefresh()}
					>
						Refresh earnings dates
					</button>
				}
			>
				<Show when={data()}>
					{(current) => (
						<output class="mt-1 block text-xs text-slate-700" data-field="watchlist-status">
							{watchlistStatusText(current())}
						</output>
					)}
				</Show>
				<Show when={loading()} fallback={null}>
					<Loading label="watchlist" />
				</Show>
				<Show when={!loading() && data() !== null}>
					<Show
						when={stocks().length > 0}
						fallback={
							<Empty>
								No stocks registered yet. Add a US or Japanese stock above to track its earnings
								dates.
							</Empty>
						}
					>
						<div class="overflow-x-auto">
							<table class="mt-1 w-full border-collapse text-left text-xs">
								<caption class="caption-top text-left text-slate-600">
									Stocks you follow, with their next earnings announcement date
								</caption>
								<thead>
									<tr class="border-b border-slate-300">
										<th scope="col" class="pr-2">
											Symbol
										</th>
										<th scope="col" class="pr-2">
											Market
										</th>
										<th scope="col" class="pr-2">
											Next announcement
										</th>
										<th scope="col" class="pr-2">
											Retrieved
										</th>
										<th scope="col" class="pr-2">
											Source
										</th>
										<th scope="col">Actions</th>
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
						title={`Remove ${stock().symbol}?`}
						opener={opener()}
						confirmLabel="Remove stock"
						pending={busy()}
						failure={null}
						onConfirm={() => void confirmRemove()}
						onCancel={closeDialogs}
					>
						{stock().symbol} and its earnings dates are removed from the watchlist. This cannot be
						undone.
					</ConfirmDialog>
				)}
			</Show>
		</div>
	);
}
