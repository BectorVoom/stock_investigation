import {
	type MarketProviderId,
	type MarketUnavailableCode,
	marketUnavailableReason,
} from "@research/contracts";
import { defineMessages } from "@research/i18n";

/** The fixed Japanese wording per unavailable code (the English one is the contract's). */
const JA_UNAVAILABLE_REASONS: { readonly [C in MarketUnavailableCode]: string } = {
	NEVER_REFRESHED: "まだデータが更新されていません。更新を実行してください。",
	SOURCE_NOT_CONFIGURED:
		"データソースが設定されていません。apps/runner/.env にプロバイダーのキーを設定してください。",
	SOURCE_AUTH_FAILED: "データソースが設定済みのキーを拒否しました。",
	SERIES_NOT_FOUND: "現在のプランでは、この銘柄のデータがプロバイダーにありません。",
	PLAN_NOT_ENTITLED: "プロバイダーのプランにこの銘柄が含まれていません。",
	RATE_LIMITED: "プロバイダーのレート制限に達しました。しばらくしてから再試行してください。",
	NO_DATA: "プロバイダーからこの系列のデータが返されませんでした。",
	SOURCE_FAILED: "データソースへのリクエストに失敗しました。",
};

function jaUnavailableReason(code: MarketUnavailableCode, provider: MarketProviderId | undefined) {
	if (code !== "SOURCE_NOT_CONFIGURED" || provider === undefined) {
		return JA_UNAVAILABLE_REASONS[code];
	}
	return provider === "fred"
		? "FRED のデータソースが設定されていません。apps/runner/.env に FRED_API_KEY を設定してください。"
		: "Twelve Data のデータソースが設定されていません。apps/runner/.env に TWELVE_DATA_API_KEY を設定してください。";
}

/**
 * The words of Home's pure view-model (`homeModel.ts`), passed to it by the
 * widgets as a parameter (ADR-0031 decision 2).
 */
export const homeModelMessages = defineMessages({
	en: {
		/** Screen-reader words beside a change line's ▲ ▼ ▬ mark. */
		up: "up",
		down: "down",
		unchanged: "unchanged",
		needsMoreHistory: "needs more history",
		noYearAgoObservation: "no observation near the year-ago mark",
		notANumber: "value is not a number",
		/** The fixed wording per unavailable code, as the contract writes it. */
		unavailableReason: (
			code: MarketUnavailableCode,
			provider: MarketProviderId | undefined,
		): string => marketUnavailableReason(code, provider),
		/**
		 * The reason a stored series carries. English shows the stored text as
		 * it is; another language words its code.
		 */
		storedUnavailableReason: (
			stored: string,
			_code: MarketUnavailableCode,
			_provider: MarketProviderId,
		): string => stored,
	},
	ja: {
		up: "上昇",
		down: "下落",
		unchanged: "変化なし",
		needsMoreHistory: "履歴が不足",
		noYearAgoObservation: "1年前付近の観測値なし",
		notANumber: "値が数値でない",
		unavailableReason: (code, provider) => jaUnavailableReason(code, provider),
		storedUnavailableReason: (_stored, code, provider) => jaUnavailableReason(code, provider),
	},
});

/** The line chart's range names, keyed by range (`HOME_RANGES`). */
export const homeRangeMessages = defineMessages({
	en: {
		"1m": "Past month",
		"3m": "Past 3 months",
		"6m": "Past 6 months",
		"1y": "Past year",
		"3y": "Past 3 years",
		max: "All data",
	},
	ja: {
		"1m": "過去1か月",
		"3m": "過去3か月",
		"6m": "過去6か月",
		"1y": "過去1年",
		"3y": "過去3年",
		max: "全期間",
	},
});
