import type { HomeWidget, WatchlistResponse, WatchlistStock } from "@research/contracts";
import {
	type EarningsCalendarEvent,
	googleCalendarUrl,
	outlookCalendarUrl,
	selectUpcomingEarnings,
} from "@research/domain";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import type { ApiClient } from "../../api/client.ts";
import type { ApiFailure } from "../../api/http.ts";
import { BUTTON, DisclosureSummary, Empty, ErrorNotice } from "../../components/ui.tsx";
import { downloadTextFile } from "../../lib/download.ts";
import {
	hasNeverRefreshedStock,
	timingText,
	utcTodayIso,
	withoutUpcomingReason,
} from "../../watchlist/watchlistModel.ts";

/** One watchlist event with its stock's context, for the window selection and links. */
type UpcomingRow = Omit<EarningsCalendarEvent, "retrievedAt"> & {
	readonly retrievedAt: string | null;
};

function rowsOf(watchlist: WatchlistResponse): UpcomingRow[] {
	const rows: UpcomingRow[] = [];
	for (const stock of watchlist.stocks) {
		for (const event of stock.events) {
			rows.push({
				stockId: stock.stockId,
				symbol: stock.symbol,
				name: stock.name,
				announcementDate: event.announcementDate,
				fiscalPeriodLabel: event.fiscalPeriodLabel,
				timing: event.timing,
				periodKey: event.periodKey,
				fiscalPeriodEnd: event.fiscalPeriodEnd,
				publisher: stock.publisher,
				sourceUrl: stock.sourceUrl,
				// Never substitutes the added date: without a retrieved stamp
				// there is no calendar link for the event.
				retrievedAt: stock.retrievedAt,
			});
		}
	}
	return rows;
}

/** A dated event stamped by a successful refresh, or null when there is no link. */
function linkableEvent(row: UpcomingRow): EarningsCalendarEvent | null {
	if (row.retrievedAt === null) return null;
	return { ...row, retrievedAt: row.retrievedAt };
}

function UpcomingRowView(props: { readonly row: UpcomingRow }): JSX.Element {
	// Past dates never get calendar links; neither do unstamped events.
	const google = () => {
		const dated = linkableEvent(props.row);
		return dated === null ? null : googleCalendarUrl(dated);
	};
	const outlook = () => {
		const dated = linkableEvent(props.row);
		return dated === null ? null : outlookCalendarUrl(dated);
	};
	return (
		<tr class="border-b border-slate-200 align-top">
			<td class="py-1 pr-3 whitespace-nowrap">
				<time dateTime={props.row.announcementDate ?? undefined}>{props.row.announcementDate}</time>
			</td>
			<th scope="row" class="py-1 pr-3 font-medium">
				<span class="block font-mono">{props.row.symbol}</span>
				<span class="block text-xs font-normal text-slate-600">
					{props.row.name ?? props.row.symbol}
				</span>
			</th>
			<td class="py-1 pr-3">{props.row.fiscalPeriodLabel}</td>
			<td class="py-1 pr-3">
				{timingText(props.row.timing) ?? <span class="italic">not stated</span>}
			</td>
			<td class="py-1 text-xs">
				<Show when={google()}>
					{(url) => <SafeLink url={url()}>Add to Google Calendar</SafeLink>}
				</Show>{" "}
				<Show when={outlook()}>{(url) => <SafeLink url={url()}>Add to Outlook</SafeLink>}</Show>
			</td>
		</tr>
	);
}

/**
 * The earnings-calendar widget: upcoming dated announcements of the
 * watchlist's stocks within `daysAhead` from the browser's current UTC date.
 * Reads the watchlist through an accessor (never a snapshot) so it stays
 * reactive across reloads like the other widgets.
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
	const [downloadBusy, setDownloadBusy] = createSignal(false);
	const [downloadError, setDownloadError] = createSignal<ApiFailure | null>(null);

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
	const upcoming = createMemo(() => {
		const current = props.watchlist();
		if (current === null) return null;
		const rows = rowsOf(current);
		return selectUpcomingEarnings(rows, today(), daysAhead(), rows.length);
	});
	const withoutUpcoming = createMemo((): readonly WatchlistStock[] => {
		const current = props.watchlist();
		const shown = upcoming();
		if (current === null || shown === null) return [];
		const withDate = new Set(shown.map((row) => row.stockId));
		return current.stocks.filter((stock) => !withDate.has(stock.stockId));
	});
	const provenance = createMemo(() => {
		const shown = upcoming();
		if (shown === null) return [];
		const byPublisher = new Map<string, { sourceUrl: string; retrievedAt: string | null }>();
		for (const row of shown) {
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

	const downloadIcs = async (): Promise<void> => {
		if (downloadBusy()) return;
		setDownloadBusy(true);
		setDownloadError(null);
		const result = await props.api.downloadWatchlistIcs();
		setDownloadBusy(false);
		if (!result.ok) {
			setDownloadError(result.error);
			return;
		}
		downloadTextFile(
			document,
			"earnings-calendar.ics",
			"text/calendar; charset=utf-8",
			result.value,
		);
	};

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
					<Show
						when={(upcoming() ?? []).length > 0}
						fallback={
							<Show
								when={!neverFetched()}
								fallback={
									<p class="text-sm text-slate-700">Earnings dates have not been fetched yet.</p>
								}
							>
								<p class="text-sm text-slate-700">
									No announcement in the next {daysAhead()} days.
								</p>
							</Show>
						}
					>
						<div class="overflow-x-auto">
							<table class="w-full border-collapse text-left text-sm">
								<caption class="caption-top pb-1 text-left text-xs text-slate-600">
									{props.widget.title}: upcoming earnings announcements
								</caption>
								<thead>
									<tr class="whitespace-nowrap border-b border-slate-300 text-xs text-slate-700">
										<th scope="col" class="py-1 pr-3 font-semibold">
											Date
										</th>
										<th scope="col" class="py-1 pr-3 font-semibold">
											Stock
										</th>
										<th scope="col" class="py-1 pr-3 font-semibold">
											Fiscal period
										</th>
										<th scope="col" class="py-1 pr-3 font-semibold">
											Timing
										</th>
										<th scope="col" class="py-1 font-semibold">
											Add to calendar
										</th>
									</tr>
								</thead>
								<tbody>
									<For each={upcoming() ?? []}>{(row) => <UpcomingRowView row={row} />}</For>
								</tbody>
							</table>
						</div>
					</Show>
					<Show when={withoutUpcoming().length > 0}>
						<p class="mt-2 text-xs text-slate-700">
							{withoutUpcoming().length} stock{withoutUpcoming().length === 1 ? "" : "s"} with no
							upcoming date.
						</p>
						<details class="group text-xs">
							<DisclosureSummary>Stocks without an upcoming date</DisclosureSummary>
							<ul class="mt-1 space-y-0.5">
								<For each={withoutUpcoming()}>
									{(stock) => (
										<li>
											<span class="font-mono">{stock.symbol}</span>:{" "}
											{withoutUpcomingReason(stock, daysAhead(), today())}
										</li>
									)}
								</For>
							</ul>
						</details>
					</Show>
					<Show when={activeRefresh()}>
						{(active) => (
							<output class="mt-2 block text-xs text-slate-700">
								Fetching earnings dates… ({active().state}). The local runner fetches them; if it is
								offline this stays queued until it reconnects.
							</output>
						)}
					</Show>
					<div class="mt-2 flex flex-wrap items-center gap-2">
						<button
							type="button"
							class={BUTTON}
							disabled={props.earningsRefreshBusy() || activeRefresh() !== null}
							onClick={() => props.onRefreshEarnings()}
						>
							Refresh earnings dates
						</button>
						<button
							type="button"
							class={BUTTON}
							disabled={downloadBusy()}
							onClick={() => void downloadIcs()}
						>
							{downloadBusy() ? "Preparing file…" : "Download calendar file (.ics)"}
						</button>
						<a
							href="#/watchlist"
							class="inline-flex min-h-6 items-center text-xs text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
						>
							Manage watchlist
						</a>
					</div>
					<Show when={downloadError()}>
						{(error) => (
							<div class="mt-1">
								<ErrorNotice
									failure={error()}
									title="The calendar file was not downloaded."
									onRetry={() => void downloadIcs()}
								/>
							</div>
						)}
					</Show>
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
