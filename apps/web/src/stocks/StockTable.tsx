import type { EarningsEvent, EquityCompanyView, WatchlistStock } from "@research/contracts";
import {
	type EarningsCalendarEvent,
	googleCalendarUrl,
	outlookCalendarUrl,
} from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createMemo, For, type JSX, Show } from "solid-js";
import {
	ActionMenu,
	type ActionMenuItem,
	BUTTON,
	BUTTON_DANGER,
	DisclosureSummary,
} from "../components/ui.tsx";
import { equitiesMessages } from "../equities/equities.messages.ts";
import { syncFailureText, syncInProgress, syncStatusText } from "../equities/equitiesModel.ts";
import { commonMessages } from "../i18n/common.messages.ts";
import { formatInstant } from "../lib/format.ts";
import { stockHash } from "../router.ts";
import { joinNames } from "../watchlist/listsModel.ts";
import { watchlistMessages } from "../watchlist/watchlist.messages.ts";
import { watchlistListsMessages } from "../watchlist/watchlistLists.messages.ts";
import { watchlistModelMessages } from "../watchlist/watchlistModel.messages.ts";
import {
	earningsUnavailableText,
	nextDatedEvent,
	storedDatesPassed,
	timingText,
	utcTodayIso,
} from "../watchlist/watchlistModel.ts";
import { stocksMessages } from "./stocks.messages.ts";
import type { StockRow } from "./stocksModel.ts";

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

/**
 * The next announcement with its calendar links, further dates in a
 * disclosure, and where the dates come from (source and retrieved time) —
 * the Watchlist table's announcement, retrieved and source columns in one
 * cell, so the merged table stays readable beside the Financials column.
 */
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
			<p class="mt-1 text-2xs text-slate-600" data-field="earnings-provenance">
				{m().sourceColumn}: <SafeLink url={stock().sourceUrl}>{stock().publisher}</SafeLink>
				{" · "}
				{m().retrievedColumn}:{" "}
				<Show
					when={stock().retrievedAt}
					fallback={<span class="italic">{m().notRetrievedYet}</span>}
				>
					{(at) => <time dateTime={at()}>{formatInstant(at())}</time>}
				</Show>
			</p>
		</div>
	);
}

/**
 * The Financials cell: the sync status as the Equities table said it, its
 * failure, or "Not synced" — or "Not loaded" while the companies list never
 * answered (the page states that failure once, above).
 */
function FinancialsCell(props: {
	readonly company: EquityCompanyView | null;
	readonly known: boolean;
	readonly nowMs: number;
}): JSX.Element {
	const e = useMessages(equitiesMessages);
	const s = useMessages(stocksMessages);
	const locale = useLocale();
	return (
		<Show
			when={props.company}
			fallback={
				<span class="italic text-slate-600">{props.known ? s().notSynced : s().notLoaded}</span>
			}
		>
			{(company) => (
				<>
					<span class="block text-slate-800" data-field="sync-status">
						{syncInProgress(company()) ? "◐ " : ""}
						{syncStatusText(company(), props.nowMs, locale(), e())}
					</span>
					<Show when={syncFailureText(company(), e())}>
						{(text) => (
							<span class="block text-red-900" data-field="sync-failure">
								<span class="font-mono font-semibold">{company().sync.failure?.code}</span>
								{": "}
								{text()}
							</span>
						)}
					</Show>
				</>
			)}
		</Show>
	);
}

/**
 * What a row's main action does: on "All stocks" a watchlist stock is
 * removed from the watchlist (after the page's confirmation); on a list's
 * tab it is removed from that list only (ADR-0040 §7).
 */
export type StockRowAction =
	| {
			readonly kind: "watchlist";
			readonly onRemove: (stock: WatchlistStock, opener: HTMLElement) => void;
	  }
	| {
			readonly kind: "list";
			readonly listTitle: string;
			readonly onRemove: (stock: WatchlistStock) => void;
	  };

/** The page's handlers every row shares (ADR-0049 §2). */
export interface StockRowHandlers {
	/** True while a watchlist or list write of the page is on its way. */
	readonly busy: boolean;
	/** True while a write of this row's company is on its way. */
	readonly companyBusy: (row: StockRow) => boolean;
	readonly atTrackLimit: boolean;
	/**
	 * The clock for "Last synced 2 hours ago", as an accessor: only that
	 * text follows it, never the rows or their menus (an open menu keeps
	 * its focus while the clock ticks).
	 */
	readonly nowMs: () => number;
	/** The companies list has answered: a row without a company is not synced (not just unknown). */
	readonly companiesKnown: boolean;
	/** The watchlist has answered: a row without a watchlist entry is not on it (not just unknown). */
	readonly watchlistKnown: boolean;
	readonly onAddToWatchlist: (row: StockRow) => void;
	readonly onSyncNow: (company: EquityCompanyView) => void;
	readonly onTrack: (row: StockRow) => void;
	readonly onUntrack: (company: EquityCompanyView, opener: HTMLElement | null) => void;
}

function RowMenu(props: {
	readonly row: StockRow;
	readonly handlers: StockRowHandlers;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	const busy = () => props.handlers.companyBusy(props.row);
	/** The menu's button: where focus returns after the dialog the menu opened. */
	const menuButton = (): HTMLElement | null => {
		const active = document.activeElement;
		return active instanceof HTMLElement ? active : null;
	};
	const items = (): ActionMenuItem[] => {
		const company = props.row.company;
		// Unknown whether it is synced: offer nothing rather than the wrong action.
		if (!props.handlers.companiesKnown) return [];
		if (company === null) {
			return [
				{
					value: "track",
					label: s().trackFinancials,
					disabled: busy() || props.handlers.atTrackLimit,
					onSelect: () => props.handlers.onTrack(props.row),
				},
			];
		}
		return [
			{
				value: "sync-now",
				label: s().syncFinancialsNow,
				disabled: busy() || syncInProgress(company),
				onSelect: () => props.handlers.onSyncNow(company),
			},
			{
				value: "untrack",
				label: s().untrackFinancials,
				disabled: busy(),
				onSelect: () => props.handlers.onUntrack(company, menuButton()),
			},
		];
	};
	return (
		<Show when={props.handlers.companiesKnown}>
			<ActionMenu
				buttonLabel={s().stockActions(props.row.symbol)}
				menuLabel={s().stockMenu(props.row.symbol)}
				iconTrigger={{ icon: "three-dots" }}
				items={items()}
			/>
		</Show>
	);
}

function Row(props: {
	readonly row: () => StockRow;
	/** The titles of the lists the stock is in (ADR-0040 §7). */
	readonly lists: readonly string[];
	readonly action: StockRowAction;
	readonly handlers: StockRowHandlers;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	const model = useMessages(watchlistModelMessages);
	const listText = useMessages(watchlistListsMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const row = (): StockRow => props.row();
	const removeFromWatchlist = () => (props.action.kind === "watchlist" ? props.action : null);
	const removeFromList = () => (props.action.kind === "list" ? props.action : null);
	return (
		<tr class="border-b border-slate-200 align-top" data-stock-id={row().stockId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<span class="block font-mono">{row().symbol}</span>
				{/* The stock's chart, statements, company and news are on the Stocks page. */}
				<a
					href={stockHash(row().stockId)}
					class="block min-h-6 font-normal text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
					data-show-stock={row().stockId}
				>
					{row().name ?? s().showUnnamed(row().symbol)}
				</a>
				<Show when={props.lists.length > 0}>
					<span class="block text-2xs font-normal text-slate-700" data-field="stock-in-lists">
						{listText().inLists(joinNames(props.lists, locale()))}
					</span>
				</Show>
			</th>
			<td class="py-1 pr-2">{model().marketName(row().market)}</td>
			<td class="py-1 pr-2">
				<Show
					when={row().watchlist}
					fallback={
						<span class="italic text-slate-600">
							{props.handlers.watchlistKnown ? s().notOnWatchlist : s().notLoaded}
						</span>
					}
				>
					{(stock) => <NextAnnouncementCell stock={stock()} />}
				</Show>
			</td>
			<td class="py-1 pr-2" data-field="financials">
				<FinancialsCell
					company={row().company}
					known={props.handlers.companiesKnown}
					nowMs={props.handlers.nowMs()}
				/>
			</td>
			<td class="py-1">
				<div class="flex flex-wrap items-center gap-1">
					<Show
						when={row().watchlist}
						fallback={
							<Show when={props.handlers.watchlistKnown}>
								<button
									type="button"
									class={`${BUTTON} whitespace-nowrap`}
									aria-label={s().addToWatchlistNamed(row().symbol)}
									data-add-to-watchlist={row().stockId}
									disabled={props.handlers.busy}
									onClick={() => props.handlers.onAddToWatchlist(row())}
								>
									{s().addToWatchlist}
								</button>
							</Show>
						}
					>
						{(stock) => (
							<>
								<Show when={removeFromWatchlist()}>
									{(action) => (
										<button
											type="button"
											class={BUTTON_DANGER}
											aria-label={m().removeNamed(stock().symbol)}
											disabled={props.handlers.busy}
											onClick={(event) => action().onRemove(stock(), event.currentTarget)}
										>
											{common().remove}
										</button>
									)}
								</Show>
								<Show when={removeFromList()}>
									{(action) => (
										<button
											type="button"
											class={`${BUTTON_DANGER} whitespace-nowrap`}
											aria-label={listText().removeFromListNamed(
												stock().symbol,
												action().listTitle,
											)}
											data-remove-stock={stock().stockId}
											disabled={props.handlers.busy}
											onClick={() => action().onRemove(stock())}
										>
											{listText().removeFromList}
										</button>
									)}
								</Show>
							</>
						)}
					</Show>
					<RowMenu row={row()} handlers={props.handlers} />
				</div>
			</td>
		</tr>
	);
}

/**
 * The Registered stocks table (ADR-0049 §2), on "All stocks" and on each
 * list's tab (ADR-0040 §7): symbol and name — the name links to the stock on
 * the Stocks page — with the lists the stock is in, market, next
 * announcement with its calendar links and provenance ("Not on Watchlist"
 * for a tracked-only stock), Financials, and the row's actions.
 */
export function StockTable(props: {
	readonly rows: readonly StockRow[];
	readonly caption: string;
	readonly listTitles: ReadonlyMap<string, readonly string[]>;
	readonly action: StockRowAction;
	readonly handlers: StockRowHandlers;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const s = useMessages(stocksMessages);
	// Keyed by stock id (a string), so a re-read that rebuilds the row
	// objects — a companies poll every 2.5 s while a sync runs — keeps every
	// row's elements and only updates the cells whose values changed.
	const ids = createMemo(() => props.rows.map((row) => row.stockId));
	const byId = createMemo(() => new Map(props.rows.map((row) => [row.stockId, row] as const)));
	return (
		<div class="overflow-x-auto">
			<table class="mt-1 w-full border-collapse text-left text-xs" data-field="stocks">
				{/* The table's name for screen readers only (ADR-0050 §5): the section heading and tabs already say what it lists. */}
				<caption class="sr-only">{props.caption}</caption>
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
							{s().financialsColumn}
						</th>
						<th scope="col">{m().actionsColumn}</th>
					</tr>
				</thead>
				<tbody>
					<For each={ids()}>
						{(stockId) => (
							<Show when={byId().get(stockId)}>
								{(row) => (
									<Row
										row={row}
										lists={props.listTitles.get(stockId) ?? []}
										action={props.action}
										handlers={props.handlers}
									/>
								)}
							</Show>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}
