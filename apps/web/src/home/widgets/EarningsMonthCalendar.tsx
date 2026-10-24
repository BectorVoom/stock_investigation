import {
	buildMonthGrid,
	type EarningsCalendarEvent,
	groupEventsByDate,
	shiftMonth,
} from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { IconButton } from "../../components/ui.tsx";
import { utcTodayIso } from "../../watchlist/watchlistModel.ts";
import { earningsCalendarMessages } from "./earnings.messages.tsx";

/** The weekday columns, 0 = Sunday (the grid starts its weeks on Sunday). */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * Today's day number: an outlined pill in bold — a shape, not a colour
 * alone — beside the cell's `aria-current="date"`. Empty for any other day.
 */
function todayMark(isToday: boolean): string {
	if (!isToday) return "";
	return "inline-block min-w-6 rounded-full px-1 font-bold ring-2 ring-slate-700";
}

/** One announcement shown on the grid. */
export interface CalendarDayEvent {
	readonly stockId: string;
	readonly announcementDate: string;
	readonly symbol: string;
	readonly name: string | null;
	readonly fiscalPeriodLabel: string;
	readonly timing: EarningsCalendarEvent["timing"];
	readonly periodKey: string;
	readonly fiscalPeriodEnd: string | null;
	readonly publisher: string;
	readonly sourceUrl: string;
	/** Null until a refresh retrieved the stock's dates. */
	readonly retrievedAt: string | null;
}

/** "5 November 2026" (in English) for the accessible day names (no leading zero). */
export function formatLongDayDate(
	isoDate: string,
	text: MessagesOf<typeof earningsCalendarMessages>,
): string {
	const [yearText, monthText, dayText] = isoDate.split("-");
	return text.longDate(yearText ?? "", Number(monthText), Number(dayText));
}

/** "2026-11" → { year: 2026, month: 11 }; null when unparsable. */
function parseYearMonth(value: string): { readonly year: number; readonly month: number } | null {
	const match = /^(\d{4})-(\d{2})$/.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	if (year < 1970 || year > 9999 || month < 1 || month > 12) return null;
	return { year, month };
}

/** The month a date falls in; null when the date is missing or invalid. */
function monthOfDate(isoDate: string | null): string | null {
	if (isoDate === null) return null;
	const parsed = parseYearMonth(isoDate.slice(0, 7));
	if (parsed === null) return null;
	const day = Number(isoDate.slice(8, 10));
	if (!Number.isInteger(day) || day < 1 || day > 31) return null;
	return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}`;
}

/**
 * The earnings month calendar of the Home and Notebook `earnings-calendar`
 * widget (FR-019, Apple HIG): a semantic month grid over the watchlist's
 * dated announcements. An announcement day links to the Watchlist page,
 * whose table lists each stock's dates with their calendar links (a tap
 * opens the app where the details are; there is no in-widget panel). The
 * month navigation is local state; nothing is fetched.
 */
export function EarningsMonthCalendar(props: {
	readonly events: readonly CalendarDayEvent[];
	readonly today?: string;
	/** Caption prefix, e.g. the widget title. The caption always names the month. */
	readonly captionPrefix?: string;
}): JSX.Element {
	const m = useMessages(earningsCalendarMessages);
	const today = () => props.today ?? utcTodayIso(Date.now());
	const upcomingMonths = createMemo(() => {
		const months = new Set<string>();
		for (const event of props.events) {
			const month = monthOfDate(event.announcementDate);
			if (month !== null && event.announcementDate >= today()) months.add(month);
		}
		return [...months].sort();
	});
	/** The month shown until the owner navigates: the first upcoming announcement, else today. */
	const defaultMonth = (): string => upcomingMonths()[0] ?? today().slice(0, 7);
	// The owner's choice, or null while they have not navigated. While null
	// the grid FOLLOWS the default, so dates that arrive after the grid is on
	// screen (a refresh that finishes later) move it exactly where a reload
	// would have opened it.
	const [chosen, setChosen] = createSignal<string | null>(null);
	const month = (): string => chosen() ?? defaultMonth();
	const parsed = createMemo(() => parseYearMonth(month()) ?? parseYearMonth(today().slice(0, 7)));
	const grid = createMemo(() => {
		const current = parsed();
		if (current === null) return null;
		const built = buildMonthGrid(current.year, current.month, 0);
		return built.ok ? built.value : null;
	});
	const byDate = createMemo(() => {
		const map = new Map<string, CalendarDayEvent[]>();
		for (const entry of groupEventsByDate(props.events)) {
			map.set(entry.date, [...entry.events]);
		}
		return map;
	});
	const monthLabel = createMemo(() => {
		const current = parsed();
		if (current === null) return month();
		return m().monthTitle(current.year, current.month);
	});
	const caption = () =>
		props.captionPrefix === undefined
			? m().caption(monthLabel())
			: m().captionWithPrefix(props.captionPrefix, monthLabel());

	const move = (delta: number): void => {
		const current = parsed();
		if (current === null) return;
		const next = shiftMonth(current.year, current.month, delta);
		setChosen(`${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}`);
	};

	const dayAccessibleName = (date: string, dayEvents: readonly CalendarDayEvent[]): string => {
		const symbols = dayEvents.map((event) => event.symbol).join(", ");
		return m().dayName(formatLongDayDate(date, m()), dayEvents.length, symbols);
	};

	return (
		<div>
			<div class="flex flex-wrap items-center gap-1">
				{/* Icon-only like every Home button (guideline section 13): the words
				    are the accessible name and the tooltip. */}
				<IconButton label={m().previousMonth} icon="arrow-left" onClick={() => move(-1)} />
				<IconButton label={m().nextMonth} icon="arrow-right" onClick={() => move(1)} />
				<p aria-live="off" class="text-sm font-medium text-slate-900">
					{monthLabel()}
				</p>
			</div>
			<div class="mt-1 overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">{caption()}</caption>
					<thead>
						<tr class="border-b border-slate-300 text-xs text-slate-700">
							<For each={WEEKDAYS}>
								{(day) => (
									<th scope="col" class="min-w-9 px-0.5 py-1 text-center font-semibold">
										<abbr title={m().weekdayLong(day)} class="no-underline">
											{m().weekdayShort(day)}
										</abbr>
									</th>
								)}
							</For>
						</tr>
					</thead>
					<tbody>
						<For each={grid()?.weeks ?? []}>
							{(week) => (
								<tr class="border-b border-slate-200">
									<For each={week}>
										{(cell) => {
											const dayEvents = () => byDate().get(cell.date) ?? [];
											const dayNumber = () => Number(cell.date.slice(8, 10));
											const isToday = () => cell.date === today();
											return (
												<td
													class="min-w-9 px-0.5 py-0.5 text-center align-top"
													classList={{ "opacity-50": !cell.inMonth }}
													aria-current={isToday() ? ("date" as const) : undefined}
												>
													<Show
														when={dayEvents().length > 0}
														fallback={
															<span class="block px-1 py-1 text-sm text-slate-700">
																<span class={todayMark(isToday())}>{dayNumber()}</span>
															</span>
														}
													>
														<a
															href="#/watchlist"
															aria-label={dayAccessibleName(cell.date, dayEvents())}
															class="pointer-coarse:min-h-11 pointer-coarse:min-w-11 mx-auto flex min-h-6 min-w-6 flex-col items-center justify-center rounded px-1 py-1 text-sm font-medium text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800"
														>
															<span class={todayMark(isToday())}>{dayNumber()}</span>
															<span aria-hidden="true" class="leading-none text-blue-800">
																{"●"}
																<Show when={dayEvents().length > 1}>
																	<span class="text-2xs">{dayEvents().length}</span>
																</Show>
															</span>
														</a>
													</Show>
												</td>
											);
										}}
									</For>
								</tr>
							)}
						</For>
					</tbody>
				</table>
			</div>
		</div>
	);
}
