import { defineMessages } from "@research/i18n";
import { formatPeriodEnd } from "../equities/financialFormat.ts";
import type { EarningsFailureCode as FailureCode } from "./nextEarnings.ts";

/** Why a stock has no next earnings date, per fetch failure code (provider text is never shown). */
const EN_FAILURES: { readonly [C in FailureCode]: string } = {
	SOURCE_NOT_CONFIGURED: "Not available: the earnings date source is not configured.",
	SOURCE_AUTH_FAILED: "Not available: the earnings date source rejected the configured key.",
	SYMBOL_NOT_FOUND: "Not available: the earnings date source does not list this stock.",
	PLAN_NOT_ENTITLED: "Not available: the provider plan does not include this stock's dates.",
	RATE_LIMITED:
		"Not available yet: the provider's rate limit was reached. The next automatic update tries again.",
	SOURCE_FAILED:
		"Not available yet: the request to the source failed. The next automatic update tries again.",
};

const JA_FAILURES: { readonly [C in FailureCode]: string } = {
	SOURCE_NOT_CONFIGURED: "取得できません。決算発表日のデータソースが設定されていません。",
	SOURCE_AUTH_FAILED: "取得できません。データソースが設定済みのキーを拒否しました。",
	SYMBOL_NOT_FOUND: "取得できません。データソースにこの銘柄がありません。",
	PLAN_NOT_ENTITLED:
		"取得できません。プロバイダーのプランにこの銘柄の決算発表日が含まれていません。",
	RATE_LIMITED:
		"まだ取得できていません。プロバイダーのレート制限に達しました。次回の自動更新で再取得します。",
	SOURCE_FAILED:
		"まだ取得できていません。データソースへのリクエストに失敗しました。次回の自動更新で再取得します。",
};

/** "2027-03-31" -> 「2027年3月期」, the usual name of a Japanese fiscal year. */
function jaFiscalYear(fiscalYearEnd: string): string {
	const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(fiscalYearEnd);
	return match === null ? fiscalYearEnd : `${match[1]}年${Number(match[2])}月期`;
}

/**
 * The Financial statements tab's next earnings announcement line
 * (ADR-0067). The fiscal period label and the publisher are data.
 */
export const nextEarningsMessages = defineMessages({
	en: {
		label: "Next earnings date",
		/** The date with its weekday: "Thu, 5 November 2026". */
		dateWithWeekday: (weekday: string, date: string): string => `${weekday}, ${date}`,
		daysUntil: (days: number): string =>
			days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`,
		undecided: "Not decided yet",
		/**
		 * The fiscal period the announcement reports, with the end of its
		 * fiscal year when the source states it (JPX: 決算期; Finnhub: none).
		 */
		period: (label: string, fiscalYearEnd: string | null): string =>
			fiscalYearEnd === null
				? `For ${label}`
				: `For ${label}, fiscal year ending ${formatPeriodEnd(fiscalYearEnd, "en")}`,
		source: "Source:",
		notWatched:
			"Earnings dates are kept for Watchlist stocks. Add this stock to the Watchlist to see its next one.",
		notFetched: "Not fetched yet; it appears after the next automatic update.",
		none: "The source lists no upcoming announcement yet.",
		failure: (code: FailureCode): string => EN_FAILURES[code],
	},
	ja: {
		label: "次回決算発表日",
		dateWithWeekday: (weekday, date) => `${date}（${weekday}）`,
		daysUntil: (days) => (days === 0 ? "本日" : days === 1 ? "明日" : `あと ${days} 日`),
		undecided: "未定",
		period: (label, fiscalYearEnd) =>
			fiscalYearEnd === null
				? `対象: ${label}`
				: `対象: ${label}（${jaFiscalYear(fiscalYearEnd)}）`,
		source: "出典:",
		notWatched:
			"決算発表日はウォッチリストの銘柄について取得します。この銘柄をウォッチリストに追加すると表示されます。",
		notFetched: "まだ取得していません。次回の自動更新後に表示されます。",
		none: "今後の決算発表の予定はまだ公表されていません。",
		failure: (code) => JA_FAILURES[code],
	},
});
