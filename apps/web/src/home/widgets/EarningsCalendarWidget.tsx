import type { HomeWidget, WatchlistResponse, WatchlistStock } from "@research/contracts";
import { DISCONNECTED_GOOGLE_CALENDAR_STATE } from "@research/contracts";
import { selectUpcomingEarnings } from "@research/domain";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../../api/client.ts";
import type { ApiFailure } from "../../api/http.ts";
import { Empty, ErrorNotice, IconButton } from "../../components/ui.tsx";
import { formatInstant } from "../../lib/format.ts";
import { SETTINGS_CALENDAR_HASH } from "../../router.ts";
import {
	googleWidgetStatus,
	hasNeverRefreshedStock,
	utcTodayIso,
} from "../../watchlist/watchlistModel.ts";
import { type CalendarDayEvent, EarningsMonthCalendar } from "./EarningsMonthCalendar.tsx";

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
 * details), a "Next" list of at most 3 upcoming announcements, one status
 * line, and at most two actions ("Refresh earnings dates", "Open Watchlist").
 * Per-date calendar links live in the Watchlist table; Google Calendar, the
 * `.ics` download and the subscription feed in Settings → Calendar
 * (ADR-0022). Reads the watchlist through an accessor (never a snapshot) so
 * it stays reactive across reloads like the other widgets.
 */
export function EarningsCalendarWidget(props: {
	readonly widget: Extract<HomeWidget, { readonly type: "earnings-calendar" }>;
	readonly watchlist: Accessor<WatchlistResponse | null>;
	readonly watchlistError: Accessor<ApiFailure | null>;
	readonly onRetryWatchlist: () => void;
	readonly onRefreshEarnings: () => void;
	readonly earningsRefreshBusy: Accessor<boolean>;
	readonly api: ApiClient;
}): JSX.Element {
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
	/** At most 3 upcoming announcements inside `daysAhead`: the "Next" list. */
	const nextThree = createMemo(() => {
		const rows = datedRows();
		if (rows === null) return null;
		return selectUpcomingEarnings(rows, today(), daysAhead(), 3);
	});
	const withoutUpcoming = createMemo((): readonly WatchlistStock[] => {
		const current = props.watchlist();
		const rows = datedRows();
		if (current === null || rows === null) return [];
		const shown = new Set(
			selectUpcomingEarnings(rows, today(), daysAhead(), rows.length).map((row) => row.stockId),
		);
		return current.stocks.filter((stock) => !shown.has(stock.stockId));
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
		if (active !== null) return `Fetching earnings dates… (${active.state}).`;
		if (current === null) return "Loading earnings dates…";
		if (neverFetched()) return "Earnings dates have not been fetched yet.";
		if (current.refresh.lastSucceededAt !== null) {
			return `Earnings dates last refreshed ${formatInstant(current.refresh.lastSucceededAt)}.`;
		}
		return "No earnings-date refresh has completed yet.";
	});
	const googleStatus = createMemo((): string => {
		const current = props.watchlist();
		if (current === null) return googleWidgetStatus(DISCONNECTED_GOOGLE_CALENDAR_STATE);
		return googleWidgetStatus(current.googleCalendar);
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
							title="Could not load earnings dates."
							onRetry={() => props.onRetryWatchlist()}
						/>
					)}
				</Show>
			}
		>
			<Show
				when={props.watchlist() !== null}
				fallback={<output class="block text-sm text-slate-600">Loading earnings dates…</output>}
			>
				<Show
					when={(props.watchlist()?.stocks.length ?? 0) > 0}
					fallback={
						<Empty>
							No stocks on the watchlist yet.{" "}
							<a
								href="#/watchlist"
								class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
							>
								Add one on the Watchlist page
							</a>
							.
						</Empty>
					}
				>
					<EarningsMonthCalendar events={datedRows() ?? []} />
					<Show
						when={(nextThree() ?? []).length > 0}
						fallback={
							<Show
								when={!neverFetched()}
								fallback={
									<p class="mt-2 text-sm text-slate-700">
										Earnings dates have not been fetched yet.
									</p>
								}
							>
								<p class="mt-2 text-sm text-slate-700">
									No announcement in the next {daysAhead()} days.
								</p>
							</Show>
						}
					>
						<h4 class="mt-2 text-xs font-semibold text-slate-900">Next</h4>
						<ul class="mt-0.5 space-y-1">
							<For each={nextThree() ?? []}>
								{(row) => (
									<li class="text-sm text-slate-800">
										<time dateTime={row.announcementDate} class="whitespace-nowrap">
											{row.announcementDate}
										</time>{" "}
										<span class="font-mono font-medium">{row.symbol}</span>{" "}
										<span class="text-slate-600">{row.name ?? row.symbol}</span>{" "}
										<span class="text-xs text-slate-600">({row.fiscalPeriodLabel})</span>
									</li>
								)}
							</For>
						</ul>
					</Show>
					<Show when={withoutUpcoming().length > 0}>
						<p class="mt-2 text-xs text-slate-700">
							{withoutUpcoming().length === 1
								? "1 stock has no upcoming date."
								: `${withoutUpcoming().length} stocks have no upcoming date.`}{" "}
							<a
								href="#/watchlist"
								class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
							>
								See them on the Watchlist page
							</a>
							.
						</p>
					</Show>
					<output class="mt-2 block text-xs text-slate-700">
						{earningsStatus()} {googleStatus()}{" "}
						<Show when={googleDisconnected()}>
							<a
								href={SETTINGS_CALENDAR_HASH}
								class="text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
							>
								Connect it in Settings
							</a>
							.
						</Show>
					</output>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						{/* Icon-only like every Home button (guideline section 13): the
						    former text is the accessible name and the tooltip. */}
						<IconButton
							label="Refresh earnings dates"
							icon="arrow-clockwise"
							disabled={props.earningsRefreshBusy() || activeRefresh() !== null}
							onClick={() => props.onRefreshEarnings()}
						/>
						<a
							href="#/watchlist"
							class="pointer-coarse:min-h-11 inline-flex min-h-6 items-center text-xs text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
						>
							Open Watchlist
						</a>
					</div>
					<Show when={provenance().length > 0}>
						<p class="mt-2 border-t border-slate-200 pt-1 text-2xs text-slate-600">
							Sources:{" "}
							<For each={provenance()}>
								{(entry, index) => (
									<span>
										<Show when={index() > 0}>; </Show>
										<SafeLink url={entry.sourceUrl}>{entry.publisher}</SafeLink>
										{entry.retrievedAt === null ? (
											<span> (not retrieved yet)</span>
										) : (
											<span>
												{" "}
												(retrieved{" "}
												<time dateTime={entry.retrievedAt}>{entry.retrievedAt.slice(0, 10)}</time>)
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
