import type { StockEarningsCalendarView, WatchlistStock } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import { createMemo, type JSX, Match, Show, Switch } from "solid-js";
import { earningsCalendarMessages } from "../home/widgets/earnings.messages.tsx";
import { utcTodayIso } from "../watchlist/watchlistModel.ts";
import { nextEarningsMessages } from "./nextEarnings.messages.ts";
import { isoWeekday, nextEarnings } from "./nextEarnings.ts";

/**
 * "Next earnings date" at the top of the Financial statements tab
 * (ADR-0067, ADR-0068): the stock's next announcement — from its Watchlist
 * entry, else its market's stored calendar (every listed stock) — with date
 * and weekday, the time of day the source states, how many days away, the
 * fiscal period it reports (with its fiscal year when stated), and the
 * source; or why there is none. Reads nothing of its own: the page already
 * read the Watchlist, and the tab the profile. "Today" is the UTC date, as
 * on the Home earnings calendar.
 */
export function NextEarnings(props: {
	readonly stock: WatchlistStock | null;
	/** The profile's market calendar: undefined while it is read, null when never stored. */
	readonly calendar: StockEarningsCalendarView | null | undefined;
}): JSX.Element {
	const t = useMessages(nextEarningsMessages);
	const calendar = useMessages(earningsCalendarMessages);
	const next = createMemo(() => nextEarnings(props.stock, props.calendar, utcTodayIso(Date.now())));
	const source = createMemo(() => {
		const current = next();
		return current.kind === "scheduled" || current.kind === "undecided" || current.kind === "none"
			? current.source
			: null;
	});
	const scheduled = createMemo(() => {
		const current = next();
		return current.kind === "scheduled" ? current : null;
	});
	const undecided = createMemo(() => {
		const current = next();
		return current.kind === "undecided" ? current : null;
	});
	const failure = createMemo(() => {
		const current = next();
		return current.kind === "unavailable" ? current.code : null;
	});
	const longDate = (date: string): string => {
		const [year = "", month = "1", day = "1"] = date.split("-");
		return t().dateWithWeekday(
			calendar().weekdayShort(isoWeekday(date)),
			calendar().longDate(year, Number(month), Number(day)),
		);
	};
	return (
		<dl
			class="border-b border-slate-200 pb-2 text-sm"
			data-field="next-earnings"
			data-kind={next().kind}
		>
			<dt class="text-xs font-semibold text-slate-700">{t().label}</dt>
			<dd class="mt-0.5 text-slate-900">
				<Switch>
					<Match when={scheduled()}>
						{(current) => (
							<>
								<span class="font-semibold">
									<time dateTime={current().date}>{longDate(current().date)}</time>
								</span>
								<Show when={calendar().timing(current().event.timing)}>
									{(timing) => <span> {timing()}</span>}
								</Show>
								<span class="text-slate-700"> · {t().daysUntil(current().daysUntil)}</span>
								<span class="block text-xs text-slate-700">
									{t().period(current().event.fiscalPeriodLabel, current().event.fiscalPeriodEnd)}
								</span>
							</>
						)}
					</Match>
					<Match when={undecided()}>
						{(current) => (
							<>
								<span class="font-semibold">{t().undecided}</span>
								<span class="block text-xs text-slate-700">
									{t().period(current().event.fiscalPeriodLabel, current().event.fiscalPeriodEnd)}
								</span>
							</>
						)}
					</Match>
					<Match when={failure()}>
						{(code) => <span class="text-xs text-slate-700">{t().failure(code())}</span>}
					</Match>
					<Match when={next().kind === "loading"}>
						<span class="text-xs text-slate-700">{t().loading}</span>
					</Match>
					<Match when={next().kind === "not-fetched"}>
						<span class="text-xs text-slate-700">{t().notFetched}</span>
					</Match>
					<Match when={next().kind === "none"}>
						<span class="text-xs text-slate-700">{t().none}</span>
					</Match>
				</Switch>
				<Show when={source()}>
					{(link) => (
						<span class="block text-2xs text-slate-600">
							{t().source} <SafeLink url={link().sourceUrl}>{link().publisher}</SafeLink>
						</span>
					)}
				</Show>
			</dd>
		</dl>
	);
}
