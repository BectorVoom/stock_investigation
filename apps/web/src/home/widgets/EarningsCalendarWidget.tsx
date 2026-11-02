import type { MarketWidgetCore, WatchlistResponse } from "@research/contracts";
import { DISCONNECTED_GOOGLE_CALENDAR_STATE } from "@research/contracts";
import { selectUpcomingEarnings } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../../api/client.ts";
import type { ApiFailure } from "../../api/http.ts";
import { Empty, ErrorNotice } from "../../components/ui.tsx";
import { formatInstant } from "../../lib/format.ts";
import { REGISTERED_STOCKS_HASH, SETTINGS_CALENDAR_HASH, STOCKS_HASH } from "../../router.ts";
import { watchlistModelMessages } from "../../watchlist/watchlistModel.messages.ts";
import {
	googleWidgetStatus,
	hasNeverRefreshedStock,
	utcTodayIso,
} from "../../watchlist/watchlistModel.ts";
import { type CalendarDayEvent, EarningsMonthCalendar } from "./EarningsMonthCalendar.tsx";
import { earningsCalendarMessages } from "./earnings.messages.tsx";

const LINK_CLASS =
	"text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800";

/** A link inside one of the widget's sentences. */
function sentenceLink(href: string): (label: string) => JSX.Element {
	return (label) => (
		<a href={href} class={LINK_CLASS}>
			{label}
		</a>
	);
}

/** One watchlist event with its stock's context, for the window selection. */
type UpcomingRow = CalendarDayEvent;

function rowsOf(watchlist: WatchlistResponse): UpcomingRow[] {
	const rows: UpcomingRow[] = [];
	for (const stock of watchlist.stocks) {
		for (const event of stock.events) {
			if (event.announcementDate === null) continue;
			rows.push({
				stockId: stock.stockId,
				announcementDate: event.announcementDate,
				symbol: stock.symbol,
				name: stock.name,
				fiscalPeriodLabel: event.fiscalPeriodLabel,
				timing: event.timing,
				periodKey: event.periodKey,
				fiscalPeriodEnd: event.fiscalPeriodEnd,
				publisher: stock.publisher,
				sourceUrl: stock.sourceUrl,
				retrievedAt: stock.retrievedAt,
			});
		}
	}
	return rows;
}

/**
 * The earnings-calendar widget, glanceable (FR-019, Apple HIG): the month
 * grid (announcement days link to the Watchlist page — no in-widget
 * details), an "Upcoming announcements" list of at most 3 (date, symbol,
 * name, fiscal period, time of day when the source states it), one status
 * line, and one action ("Open Registered stocks"). The server fetches the
 * dates on its own schedule, so the widget only reads them.
 * Per-date calendar links live in the Watchlist table; Google Calendar, the
 * `.ics` download and the subscription feed in Settings → Calendar
 * (ADR-0022). Reads the watchlist through an accessor (never a snapshot) so
 * it stays reactive across reloads like the other widgets.
 */
export function EarningsCalendarWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "earnings-calendar" }>;
	readonly watchlist: Accessor<WatchlistResponse | null>;
	readonly watchlistError: Accessor<ApiFailure | null>;
	readonly onRetryWatchlist: () => void;
	readonly api: ApiClient;
}): JSX.Element {
	const m = useMessages(earningsCalendarMessages);
	const watchlistText = useMessages(watchlistModelMessages);
	const today = () => utcTodayIso(Date.now());
	const daysAhead = () => props.widget.daysAhead;
	/** The active earnings run, if any: the status line below names it. */
	const activeRefresh = () => {
		const current = props.watchlist();
		if (current === null || current.refresh.activeRunId === null) return null;
		return {
			runId: current.refresh.activeRunId,
			state: current.refresh.activeRunState ?? "queued",
		};
	};
	/** True when at least one stock was never looked up — never claim "no announcement" then. */
	const neverFetched = () => {
		const current = props.watchlist();
		return current !== null && hasNeverRefreshedStock(current);
	};
	const datedRows = createMemo(() => {
		const current = props.watchlist();
		if (current === null) return null;
		return rowsOf(current);
	});
	/** At most 3 upcoming announcements inside `daysAhead`: the "Upcoming announcements" list. */
	const nextThree = createMemo(() => {
		const rows = datedRows();
		if (rows === null) return null;
		return selectUpcomingEarnings(rows, today(), daysAhead(), 3);
	});
	const provenance = createMemo(() => {
		const rows = nextThree();
		if (rows === null) return [];
		const byPublisher = new Map<string, { sourceUrl: string; retrievedAt: string | null }>();
		for (const row of rows) {
			const existing = byPublisher.get(row.publisher);
			if (existing === undefined) {
				byPublisher.set(row.publisher, { sourceUrl: row.sourceUrl, retrievedAt: row.retrievedAt });
			} else if (
				existing.retrievedAt === null ||
				(row.retrievedAt !== null && row.retrievedAt > existing.retrievedAt)
			) {
				byPublisher.set(row.publisher, { sourceUrl: row.sourceUrl, retrievedAt: row.retrievedAt });
			}
		}
		return [...byPublisher.entries()].map(([publisher, info]) => ({ publisher, ...info }));
	});
	const earningsStatus = createMemo((): string => {
		const current = props.watchlist();
		const active = activeRefresh();
		if (active !== null) return m().refreshing(active.state);
		if (current === null) return m().loading;
		if (neverFetched()) return m().noRefreshYet;
		if (current.refresh.lastSucceededAt !== null) {
			return m().lastRefreshed(formatInstant(current.refresh.lastSucceededAt));
		}
		return m().noRefreshYet;
	});
	const googleStatus = createMemo((): string => {
		const current = props.watchlist();
		if (current === null) {
			return googleWidgetStatus(DISCONNECTED_GOOGLE_CALENDAR_STATE, watchlistText());
		}
		return googleWidgetStatus(current.googleCalendar, watchlistText());
	});
	const googleDisconnected = () => props.watchlist()?.googleCalendar.status === "disconnected";

	return (
		<Show
			when={props.watchlist() !== null || props.watchlistError() === null}
			fallback={
				<Show when={props.watchlistError()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().loadFailed}
							onRetry={() => props.onRetryWatchlist()}
						/>
					)}
				</Show>
			}
		>
			<Show
				when={props.watchlist() !== null}
				fallback={<output class="block text-sm text-slate-600">{m().loading}</output>}
			>
				<Show
					when={(props.watchlist()?.stocks.length ?? 0) > 0}
					fallback={<Empty>{m().noStocks(sentenceLink(STOCKS_HASH))}</Empty>}
				>
					<EarningsMonthCalendar events={datedRows() ?? []} />
					<Show
						when={(nextThree() ?? []).length > 0}
						fallback={
							<Show
								when={!neverFetched()}
								fallback={<p class="mt-2 text-sm text-slate-700">{m().notRefreshed}</p>}
							>
								<p class="mt-2 text-sm text-slate-700">{m().noAnnouncement(daysAhead())}</p>
							</Show>
						}
					>
						<div class="mt-3">
							<h4 class="text-xs font-semibold text-slate-600">{m().upcoming}</h4>
							{/* One grid for the rows (subgrid), so dates, symbols, periods and
							    times of day line up in columns and a long name gives way first. */}
							<ul class="mt-1 grid grid-cols-[auto_auto_minmax(0,max-content)_auto_auto] justify-start gap-x-3 text-sm">
								<For each={nextThree() ?? []}>
									{(row) => (
										<li class="col-span-full grid grid-cols-subgrid items-baseline border-t border-slate-100 py-1 first:border-t-0">
											<time
												dateTime={row.announcementDate}
												class="whitespace-nowrap tabular-nums text-slate-900"
											>
												{row.announcementDate}
											</time>
											<span class="font-mono font-semibold text-slate-900">{row.symbol}</span>
											<span class="min-w-0 truncate text-slate-600" title={row.name ?? row.symbol}>
												{row.name ?? row.symbol}
											</span>
											<span class="whitespace-nowrap text-xs text-slate-600">
												{row.fiscalPeriodLabel}
											</span>
											<span class="whitespace-nowrap text-xs text-slate-600" data-field="timing">
												{m().timing(row.timing)}
											</span>
										</li>
									)}
								</For>
							</ul>
						</div>
					</Show>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<a
							href={REGISTERED_STOCKS_HASH}
							class="pointer-coarse:min-h-11 inline-flex min-h-6 items-center text-xs text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
						>
							{m().openWatchlist}
						</a>
					</div>
					{/* The footer under one hairline: how fresh the dates are, then
					    where they came from. */}
					<output class="mt-2 block border-t border-slate-200 pt-1.5 text-xs text-slate-600">
						{earningsStatus()} {googleStatus()}{" "}
						<Show when={googleDisconnected()}>
							{m().connectInSettings(sentenceLink(SETTINGS_CALENDAR_HASH))}
						</Show>
					</output>
					<Show when={provenance().length > 0}>
						<p class="mt-0.5 text-2xs text-slate-600">
							{m().sources}
							<For each={provenance()}>
								{(entry, index) => (
									<span>
										<Show when={index() > 0}>; </Show>
										<SafeLink url={entry.sourceUrl}>{entry.publisher}</SafeLink>
										{entry.retrievedAt === null ? (
											<span>{m().notRetrievedYet}</span>
										) : (
											<span>
												{m().retrievedOn(
													<time dateTime={entry.retrievedAt}>
														{formatInstant(entry.retrievedAt)}
													</time>,
												)}
											</span>
										)}
									</span>
								)}
							</For>
						</p>
					</Show>
				</Show>
			</Show>
		</Show>
	);
}
