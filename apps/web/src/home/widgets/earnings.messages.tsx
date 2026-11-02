import type { EarningsTiming } from "@research/contracts";
import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";
import { runStateMessages } from "../../i18n/runState.messages.ts";

const EN_MONTHS = [
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

const EN_WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const EN_WEEKDAYS_LONG = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
] as const;
const JA_WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

/** A month number outside 1..12 reads as January, as the calendar always did. */
function enMonth(month: number): string {
	return EN_MONTHS[(month >= 1 && month <= 12 ? month : 1) - 1] ?? "January";
}

/** A link inside a sentence: the message gives its words, the view the element. */
type SentenceLink = (label: string) => JSX.Element;

/** When in the trading day an announcement is expected — the words of the `.ics` export. */
type KnownTiming = Exclude<EarningsTiming, "unknown">;

const EN_TIMINGS: { readonly [T in KnownTiming]: string } = {
	"before-open": "before market open",
	"after-close": "after market close",
	"during-session": "during the trading session",
};

const JA_TIMINGS: { readonly [T in KnownTiming]: string } = {
	"before-open": "寄り付き前",
	"after-close": "大引け後",
	"during-session": "取引時間中",
};

/**
 * The earnings-calendar widget and its month grid
 * (`EarningsCalendarWidget.tsx`, `EarningsMonthCalendar.tsx`).
 *
 * One vocabulary throughout: an *earnings date* is the stored date, an
 * *earnings announcement* the event on it, and the server's scheduled job
 * *refreshes* the dates (読み込み is only the page reading what is stored).
 * The footer's status sentences take the form "<subject>: <state>", like the
 * Google Calendar line beside them. Formats follow ADR-0032: an announcement
 * date is an ISO date (`2026-11-05`), an instant is `YYYY-MM-DD HH:MM UTC`
 * (`formatInstant`); weekday and month names are UI words, used only by the
 * month grid and its accessible names.
 */
export const earningsCalendarMessages = defineMessages({
	en: {
		/** `state`: the refresh job's state as the server reports it. */
		refreshing: (state: string) => `Earnings dates: refreshing… (${state}).`,
		loading: "Loading earnings dates…",
		notRefreshed: "No earnings dates yet; they appear after the next automatic refresh.",
		lastRefreshed: (when: string) => `Earnings dates: refreshed ${when}.`,
		noRefreshYet: "Earnings dates: not refreshed yet.",
		loadFailed: "Could not load earnings dates.",
		noStocks: (link: SentenceLink): JSX.Element => (
			<>No stocks on the watchlist yet. {link("Find one on the Stocks page")} and add it.</>
		),
		noAnnouncement: (days: number) => `No earnings announcements in the next ${days} days.`,
		upcoming: "Upcoming announcements",
		/** The expected time of day; "" when the source does not say. */
		timing: (timing: EarningsTiming): string => (timing === "unknown" ? "" : EN_TIMINGS[timing]),
		connectInSettings: (link: SentenceLink): JSX.Element => <>{link("Connect it in Settings")}.</>,
		openWatchlist: "Open Registered stocks",
		sources: "Sources: ",
		notRetrievedYet: " (not retrieved yet)",
		/** `when`: a `formatInstant` instant in a `<time>` element. */
		retrievedOn: (when: JSX.Element): JSX.Element => <> (retrieved {when})</>,
		// The month grid.
		previousMonth: "Previous month",
		nextMonth: "Next month",
		/** The month title, e.g. "November 2026". */
		monthTitle: (year: number, month: number) => `${enMonth(month)} ${year}`,
		/** A day for the accessible names, e.g. "5 November 2026" (no leading zero). */
		longDate: (year: string, month: number, day: number) => `${day} ${enMonth(month)} ${year}`,
		/** Column header of a weekday, 0 = Sunday. */
		weekdayShort: (weekday: number): string => EN_WEEKDAYS_SHORT[weekday] ?? "",
		weekdayLong: (weekday: number): string => EN_WEEKDAYS_LONG[weekday] ?? "",
		caption: (month: string) => `${month}: earnings announcements`,
		captionWithPrefix: (prefix: string, month: string) =>
			`${prefix}: ${month}, earnings announcements`,
		dayName: (date: string, count: number, symbols: string) =>
			`${date}: ${count} earnings announcement${count === 1 ? "" : "s"}, ${symbols}`,
		/** A wide day cell's tail past its first symbols, e.g. "+2". */
		moreSymbols: (count: number) => `+${count}`,
	},
	ja: {
		refreshing: (state) => `決算発表日: 更新中…（${runStateMessages.ja.name(state)}）。`,
		loading: "決算発表日を読み込み中…",
		notRefreshed: "決算発表日はまだありません。次回の自動更新後に表示されます。",
		lastRefreshed: (when) => `決算発表日: ${when} に更新しました。`,
		noRefreshYet: "決算発表日: まだ更新されていません。",
		loadFailed: "決算発表日を読み込めませんでした。",
		noStocks: (link) => (
			<>
				ウォッチリストに銘柄がまだありません。{link("株式データのページで銘柄を探して")}
				追加してください。
			</>
		),
		noAnnouncement: (days) => `今後 ${days} 日間に決算発表はありません。`,
		upcoming: "今後の決算発表",
		timing: (timing) => (timing === "unknown" ? "" : JA_TIMINGS[timing]),
		connectInSettings: (link) => <>{link("設定で接続してください")}。</>,
		openWatchlist: "登録済みの銘柄を開く",
		sources: "出典：",
		notRetrievedYet: "（未取得）",
		retrievedOn: (when) => <>（取得日時 {when}）</>,
		previousMonth: "前の月",
		nextMonth: "次の月",
		monthTitle: (year, month) => `${year}年${month}月`,
		longDate: (year, month, day) => `${year}年${month}月${day}日`,
		weekdayShort: (weekday) => JA_WEEKDAYS[weekday] ?? "",
		weekdayLong: (weekday) => {
			const day = JA_WEEKDAYS[weekday];
			return day === undefined ? "" : `${day}曜日`;
		},
		caption: (month) => `${month}：決算発表`,
		captionWithPrefix: (prefix, month) => `${prefix}：${month}、決算発表`,
		dayName: (date, count, symbols) => `${date}：決算発表 ${count} 件、${symbols}`,
		moreSymbols: (count) => `ほか ${count} 件`,
	},
});
