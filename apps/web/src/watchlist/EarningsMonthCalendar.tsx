import {
	buildMonthGrid,
	type EarningsCalendarEvent,
	googleCalendarUrl,
	groupEventsByDate,
	outlookCalendarUrl,
	shiftMonth,
} from "@research/domain";
import { SafeLink } from "@research/ui-registry";
import { createEffect, createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { BUTTON, IconButton } from "../components/ui.tsx";
import { watchlistCalendarHash } from "../router.ts";
import { timingText, utcTodayIso } from "./watchlistModel.ts";

export const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
] as const;

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const WEEKDAY_LONG = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;

/**
 * Today's day number: an outlined pill in bold — a shape, not a colour
 * alone — beside the cell's `aria-current="date"`. Empty for any other day.
 */
function todayMark(isToday: boolean, onSelected = false): string {
	if (!isToday) return "";
	// The outline is white on the selected day's blue fill, slate elsewhere.
	return `inline-block min-w-6 rounded-full px-1 font-bold ring-2 ${onSelected ? "ring-white" : "ring-slate-700"}`;
}

/** One announcement shown on the grid and in the day details. */
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
	/** Null without a retrieved stamp: then there is no calendar link (the `linkableEvent` rule). */
	readonly retrievedAt: string | null;
}

/** "5 November 2026" for the accessible day names (no leading zero). */
export function formatLongDayDate(isoDate: string): string {
	const [yearText, monthText, dayText] = isoDate.split("-");
	const month = Number(monthText);
	const name = MONTH_NAMES[(month >= 1 && month <= 12 ? month : 1) - 1] ?? "January";
	return `${Number(dayText)} ${name} ${yearText}`;
}

/** "2026-11" → { year: 2026, month: 11 }; null when unparsable. */
export function parseYearMonth(
	value: string,
): { readonly year: number; readonly month: number } | null {
	const match = /^(\d{4})-(\d{2})$/.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	if (year < 1970 || year > 9999 || month < 1 || month > 12) return null;
	return { year, month };
}

/** The month a date falls in; null when the date is missing or invalid. */
export function monthOfDate(isoDate: string | null): string | null {
	if (isoDate === null) return null;
	const parsed = parseYearMonth(isoDate.slice(0, 7));
	if (parsed === null) return null;
	const day = Number(isoDate.slice(8, 10));
	if (!Number.isInteger(day) || day < 1 || day > 31) return null;
	return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}`;
}

/** A dated event stamped by a successful refresh, or null when there is no link. */
export function linkableCalendarEvent(row: CalendarDayEvent): EarningsCalendarEvent | null {
	if (row.retrievedAt === null) return null;
	return {
		stockId: row.stockId,
		symbol: row.symbol,
		name: row.name,
		periodKey: row.periodKey,
		announcementDate: row.announcementDate,
		fiscalPeriodLabel: row.fiscalPeriodLabel,
		fiscalPeriodEnd: row.fiscalPeriodEnd,
		timing: row.timing,
		publisher: row.publisher,
		sourceUrl: row.sourceUrl,
		retrievedAt: row.retrievedAt,
	};
}

/**
 * Whether the day's announcements may carry calendar links: never for a
 * past date, never without a retrieved stamp (same `linkableEvent` rule as
 * the stock table).
 */
export function dayLinksAllowed(
	day: string,
	today: string,
	events: readonly CalendarDayEvent[],
): boolean {
	if (day < today) return false;
	return events.some((event) => linkableCalendarEvent(event) !== null);
}

function DayLinks(props: { readonly events: readonly CalendarDayEvent[] }): JSX.Element {
	return (
		<span>
			<For each={props.events}>
				{(event) => {
					const dated = () => linkableCalendarEvent(event);
					const google = () => {
						const current = dated();
						return current === null ? null : googleCalendarUrl(current);
					};
					const outlook = () => {
						const current = dated();
						return current === null ? null : outlookCalendarUrl(current);
					};
					return (
						<span class="mr-2">
							<Show when={google()}>
								{(url) => <SafeLink url={url()}>Add to Google Calendar</SafeLink>}
							</Show>{" "}
							<Show when={outlook()}>
								{(url) => <SafeLink url={url()}>Add to Outlook</SafeLink>}
							</Show>
						</span>
					);
				}}
			</For>
		</span>
	);
}

/**
 * The earnings month calendar (FR-019 section 1): a semantic month grid over
 * the watchlist's dated announcements. The FULL variant (Watchlist page)
 * selects a day into a details panel under the grid; the COMPACT variant
 * (Home widget) links announcement days to the Watchlist calendar instead of
 * showing details in the widget (Apple HIG: a tap opens the app at the right
 * location). Navigation is local state; nothing is fetched.
 */
export function EarningsMonthCalendar(props: {
	readonly events: readonly CalendarDayEvent[];
	readonly variant: "full" | "compact";
	/** Controlled selection (the deep link drives it on the Watchlist page). */
	readonly selectedDate: string | null;
	readonly onSelectDate: (date: string | null) => void;
	/** A month to open on (`YYYY-MM`, a deep link). Without it the grid follows the first upcoming announcement, else today, until the owner navigates. */
	readonly initialMonth?: string | null;
	readonly today?: string;
	/** Caption prefix, e.g. the widget title. The caption always names the month. */
	readonly captionPrefix?: string;
}): JSX.Element {
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
	// The owner's choice (navigation, or a deep link), or null while they
	// have not chosen. While null the grid FOLLOWS the default, so dates
	// that arrive after the grid is on screen (a refresh that finishes
	// later) move it exactly where a reload would have opened it.
	const [chosen, setChosen] = createSignal<string | null>(props.initialMonth ?? null);
	const month = (): string => chosen() ?? defaultMonth();
	// A deep link arriving while mounted (a widget day link navigates
	// without a reload) moves the grid to that month exactly once per link:
	// local navigation otherwise wins (the forced month is remembered, so
	// moving away from it is never snapped back).
	let lastForcedMonth: string | null = props.initialMonth ?? null;
	createEffect(() => {
		const forced = props.initialMonth;
		if (forced === undefined || forced === null || forced === lastForcedMonth) return;
		lastForcedMonth = forced;
		setChosen(forced);
	});
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
		return `${MONTH_NAMES[current.month - 1]} ${current.year}`;
	});
	const caption = () =>
		props.captionPrefix === undefined
			? `${monthLabel()}: earnings announcements`
			: `${props.captionPrefix}: ${monthLabel()}, earnings announcements`;

	const move = (delta: number): void => {
		const current = parsed();
		if (current === null) return;
		const next = shiftMonth(current.year, current.month, delta);
		setChosen(`${String(next.year).padStart(4, "0")}-${String(next.month).padStart(2, "0")}`);
	};
	const goToday = (): void => {
		setChosen(today().slice(0, 7));
	};

	const isSelected = (date: string): boolean => props.selectedDate === date;
	const selectedEvents = createMemo((): readonly CalendarDayEvent[] => {
		const selected = props.selectedDate;
		if (selected === null) return [];
		return byDate().get(selected) ?? [];
	});

	const dayAccessibleName = (date: string, dayEvents: readonly CalendarDayEvent[]): string => {
		const symbols = dayEvents.map((event) => event.symbol).join(", ");
		return `${formatLongDayDate(date)}: ${dayEvents.length} announcement${dayEvents.length === 1 ? "" : "s"}, ${symbols}`;
	};

	return (
		<div>
			<div
				class="flex flex-wrap items-center"
				classList={{ "gap-2": props.variant === "full", "gap-1": props.variant === "compact" }}
			>
				{/* The compact variant lives on Home, where every button is
				    icon-only (guideline section 13): the words are the accessible
				    name and the tooltip. The Watchlist page keeps text buttons. */}
				<Show
					when={props.variant === "full"}
					fallback={
						<>
							<IconButton label="Previous month" icon="arrow-left" onClick={() => move(-1)} />
							<IconButton label="Next month" icon="arrow-right" onClick={() => move(1)} />
						</>
					}
				>
					<button type="button" class={BUTTON} onClick={() => move(-1)}>
						Previous month
					</button>
					<button type="button" class={BUTTON} onClick={goToday}>
						Today
					</button>
					<button type="button" class={BUTTON} onClick={() => move(1)}>
						Next month
					</button>
				</Show>
				<p aria-live="off" class="text-sm font-medium text-slate-900">
					{monthLabel()}
				</p>
			</div>
			<div class="mt-1 overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">{caption()}</caption>
					<thead>
						<tr class="border-b border-slate-300 text-xs text-slate-700">
							<For each={WEEKDAY_SHORT}>
								{(day, index) => (
									<th scope="col" class="min-w-9 px-0.5 py-1 text-center font-semibold">
										<abbr title={WEEKDAY_LONG[index()]} class="no-underline">
											{day}
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
														<Show
															when={props.variant === "full"}
															fallback={
																<a
																	href={watchlistCalendarHash(cell.date)}
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
															}
														>
															<button
																type="button"
																aria-pressed={isSelected(cell.date)}
																aria-label={dayAccessibleName(cell.date, dayEvents())}
																onClick={() =>
																	props.onSelectDate(isSelected(cell.date) ? null : cell.date)
																}
																class="mx-auto flex min-h-6 min-w-6 flex-col items-center justify-center rounded px-1 py-1 text-sm hover:bg-slate-200"
																classList={{
																	"bg-blue-700 text-white hover:bg-blue-800": isSelected(cell.date),
																	"font-medium text-slate-900": !isSelected(cell.date),
																}}
															>
																<span class={todayMark(isToday(), isSelected(cell.date))}>
																	{dayNumber()}
																</span>
																<span
																	aria-hidden="true"
																	class="flex max-w-16 gap-0.5 overflow-hidden text-2xs"
																>
																	<For each={dayEvents().slice(0, 2)}>
																		{(event) => (
																			<span class="max-w-8 truncate rounded bg-slate-200 px-0.5 font-mono">
																				{event.symbol}
																			</span>
																		)}
																	</For>
																	<Show when={dayEvents().length > 2}>
																		<span>+{dayEvents().length - 2}</span>
																	</Show>
																</span>
															</button>
														</Show>
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
			<Show when={props.variant === "full" && props.selectedDate !== null}>
				<section aria-label={`Announcements on ${formatLongDayDate(props.selectedDate ?? "")}`}>
					<div aria-live="polite" class="mt-2 rounded border border-slate-300 bg-white p-2">
						<Show
							when={selectedEvents().length > 0}
							fallback={
								<p class="text-sm text-slate-700">
									No announcement on {formatLongDayDate(props.selectedDate ?? "")}.
								</p>
							}
						>
							<h4 class="text-sm font-semibold text-slate-900">
								{formatLongDayDate(props.selectedDate ?? "")}: {selectedEvents().length}{" "}
								announcement{selectedEvents().length === 1 ? "" : "s"}
							</h4>
							<ul class="mt-1 space-y-2">
								<For each={selectedEvents()}>
									{(event) => (
										<li class="text-sm" data-event={`${event.symbol}-${event.periodKey}`}>
											<span class="font-mono font-medium">{event.symbol}</span>{" "}
											<span class="text-slate-700">{event.name ?? event.symbol}</span>{" "}
											<span class="text-slate-700">
												({event.fiscalPeriodLabel}
												<Show when={timingText(event.timing)}>
													{(timing) => <span>, {timing()}</span>}
												</Show>
												)
											</span>
											<Show
												when={
													props.selectedDate !== null &&
													dayLinksAllowed(props.selectedDate ?? "", today(), [event])
												}
											>
												<div class="mt-0.5 text-xs">
													<DayLinks events={[event]} />
												</div>
											</Show>
										</li>
									)}
								</For>
							</ul>
						</Show>
					</div>
				</section>
			</Show>
		</div>
	);
}
