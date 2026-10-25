import type { EarningsEvent, WatchlistStock } from "@research/contracts";
import {
	type EarningsCalendarEvent,
	googleCalendarUrl,
	outlookCalendarUrl,
} from "@research/domain";
import { useLocale, useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { For, type JSX, Show } from "solid-js";
import { BUTTON_DANGER, DisclosureSummary } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { formatInstant } from "../lib/format.ts";
import { joinNames } from "./listsModel.ts";
import { watchlistMessages } from "./watchlist.messages.ts";
import { watchlistListsMessages } from "./watchlistLists.messages.ts";
import { watchlistModelMessages } from "./watchlistModel.messages.ts";
import {
	earningsUnavailableText,
	nextDatedEvent,
	storedDatesPassed,
	timingText,
	utcTodayIso,
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

/**
 * What a row's action does: on "All stocks" it removes the stock from the
 * watchlist (after the page's confirmation); on a list's tab it removes the
 * stock from that list only (ADR-0040 §7).
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

function StockRow(props: {
	readonly stock: WatchlistStock;
	/** The titles of the lists the stock is in (ADR-0040 §7). */
	readonly lists: readonly string[];
	readonly busy: boolean;
	readonly action: StockRowAction;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	const model = useMessages(watchlistModelMessages);
	const listText = useMessages(watchlistListsMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const stock = () => props.stock;
	const removeFromWatchlist = () => (props.action.kind === "watchlist" ? props.action : null);
	const removeFromList = () => (props.action.kind === "list" ? props.action : null);
	return (
		<tr class="border-b border-slate-200 align-top" data-stock-id={stock().stockId}>
			<th scope="row" class="py-1 pr-2 font-medium">
				<span class="block font-mono">{stock().symbol}</span>
				<span class="block font-normal text-slate-600">
					{stock().name ?? common().unavailable(m().notRetrievedYet)}
				</span>
				<Show when={props.lists.length > 0}>
					<span class="block text-2xs font-normal text-slate-700" data-field="stock-in-lists">
						{listText().inLists(joinNames(props.lists, locale()))}
					</span>
				</Show>
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
				<Show when={removeFromWatchlist()}>
					{(action) => (
						<button
							type="button"
							class={BUTTON_DANGER}
							aria-label={m().removeNamed(stock().symbol)}
							disabled={props.busy}
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
							aria-label={listText().removeFromListNamed(stock().symbol, action().listTitle)}
							data-remove-stock={stock().stockId}
							disabled={props.busy}
							onClick={() => action().onRemove(stock())}
						>
							{listText().removeFromList}
						</button>
					)}
				</Show>
			</td>
		</tr>
	);
}

/**
 * The stock table (FR-018), on "All stocks" and on each list's tab
 * (ADR-0040 §7): symbol and name with the lists the stock is in, market,
 * next announcement with its calendar links, retrieved date, source, and
 * the row action. A list's tab shows the same columns for its stocks in
 * list order.
 */
export function StockTable(props: {
	readonly stocks: readonly WatchlistStock[];
	readonly caption: string;
	readonly listTitles: ReadonlyMap<string, readonly string[]>;
	readonly busy: boolean;
	readonly action: StockRowAction;
}): JSX.Element {
	const m = useMessages(watchlistMessages);
	return (
		<div class="overflow-x-auto">
			<table class="mt-1 w-full border-collapse text-left text-xs">
				<caption class="caption-top text-left text-slate-600">{props.caption}</caption>
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
					<For each={props.stocks}>
						{(stock) => (
							<StockRow
								stock={stock}
								lists={props.listTitles.get(stock.stockId) ?? []}
								busy={props.busy}
								action={props.action}
							/>
						)}
					</For>
				</tbody>
			</table>
		</div>
	);
}
