import { defineMessages } from "@research/i18n";
import type { JSX } from "solid-js";

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

/**
 * The earnings-calendar widget and its month grid
 * (`EarningsCalendarWidget.tsx`, `EarningsMonthCalendar.tsx`). Weekday and
 * month names are UI words; dates as values stay ISO.
 */
export const earningsCalendarMessages = defineMessages({
	en: {
		fetching: (state: string) => `Fetching earnings dates… (${state}).`,
		loading: "Loading earnings dates…",
		notFetched: "Earnings dates have not been fetched yet.",
		lastRefreshed: (when: string) => `Earnings dates last refreshed ${when}.`,
		noRefreshYet: "No earnings-date refresh has completed yet.",
		loadFailed: "Could not load earnings dates.",
		noStocks: (link: SentenceLink): JSX.Element => (
			<>No stocks on the watchlist yet. {link("Add one on the Watchlist page")}.</>
		),
		noAnnouncement: (days: number) => `No announcement in the next ${days} days.`,
		next: "Next",
		withoutUpcoming: (count: number, link: SentenceLink): JSX.Element => (
			<>
				{count === 1 ? "1 stock has no upcoming date." : `${count} stocks have no upcoming date.`}{" "}
				{link("See them on the Watchlist page")}.
			</>
		),
		connectInSettings: (link: SentenceLink): JSX.Element => <>{link("Connect it in Settings")}.</>,
		refresh: "Refresh earnings dates",
		openWatchlist: "Open Watchlist",
		sources: "Sources: ",
		notRetrievedYet: " (not retrieved yet)",
		retrievedOn: (date: JSX.Element): JSX.Element => <> (retrieved {date})</>,
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
			`${date}: ${count} announcement${count === 1 ? "" : "s"}, ${symbols}`,
	},
	ja: {
		fetching: (state) => `決算発表日を取得中…（${state}）。`,
		loading: "決算発表日を読み込み中…",
		notFetched: "決算発表日はまだ取得されていません。",
		lastRefreshed: (when) => `決算発表日の最終更新：${when}。`,
		noRefreshYet: "決算発表日の更新はまだ完了していません。",
		loadFailed: "決算発表日を読み込めませんでした。",
		noStocks: (link) => (
			<>ウォッチリストに銘柄がまだありません。{link("ウォッチリストページで追加してください")}。</>
		),
		noAnnouncement: (days) => `今後${days}日間に発表はありません。`,
		next: "今後の発表",
		withoutUpcoming: (count, link) => (
			<>
				{count}銘柄に今後の発表日がありません。{link("ウォッチリストページで確認")}。
			</>
		),
		connectInSettings: (link) => <>{link("設定で接続してください")}。</>,
		refresh: "決算発表日を更新",
		openWatchlist: "ウォッチリストを開く",
		sources: "出典：",
		notRetrievedYet: "（未取得）",
		retrievedOn: (date) => <>（{date} 取得）</>,
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
		dayName: (date, count, symbols) => `${date}：${count}件の発表、${symbols}`,
	},
});
