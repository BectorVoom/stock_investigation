import {
	type MarketSourceId,
	type MarketUnavailableCode,
	marketSourceKey,
	marketUnavailableReason,
} from "@research/contracts";
import { defineMessages } from "@research/i18n";
import { commonMessages } from "../i18n/common.messages.ts";
import { reasonWithUpstreamStatus } from "../i18n/upstreamStatus.ts";

/** The fixed Japanese wording per unavailable code (the English one is the contract's). */
const JA_UNAVAILABLE_REASONS: { readonly [C in MarketUnavailableCode]: string } = {
	NEVER_REFRESHED: "まだデータがありません。次回の自動更新後に表示されます。",
	SOURCE_NOT_CONFIGURED:
		"データソースが設定されていません。apps/runner/.env にプロバイダーのキーを設定してください。",
	SOURCE_AUTH_FAILED: "データソースが設定済みのキーを拒否しました。",
	SERIES_NOT_FOUND: "現在のプランでは、この銘柄のデータがプロバイダーにありません。",
	PLAN_NOT_ENTITLED: "プロバイダーのプランにこの銘柄が含まれていません。",
	RATE_LIMITED: "プロバイダーのレート制限に達しました。しばらくしてから再試行してください。",
	NO_DATA: "プロバイダーからこの系列のデータが返されませんでした。",
	SOURCE_FAILED: "データソースへのリクエストに失敗しました。",
};

/**
 * A series never fetched says when its data comes — the server fetches it
 * by itself — in place of the stored sentence, which asked for a refresh.
 */
const EN_NEVER_REFRESHED = "No data yet; it appears after the next automatic refresh.";

function enUnavailableReason(code: MarketUnavailableCode, provider: MarketSourceId | undefined) {
	return code === "NEVER_REFRESHED" ? EN_NEVER_REFRESHED : marketUnavailableReason(code, provider);
}

/** `provider` is the series' source (`marketSourceOf`): Massive or J-Quants for a directory stock (ADR-0058 §2). */
function jaUnavailableReason(code: MarketUnavailableCode, provider: MarketSourceId | undefined) {
	if (code !== "SOURCE_NOT_CONFIGURED" || provider === undefined || provider === "materials") {
		return JA_UNAVAILABLE_REASONS[code];
	}
	const { name, key } = marketSourceKey(provider);
	return `${name} のデータソースが設定されていません。apps/runner/.env に ${key} を設定してください。`;
}

/**
 * The words of Home's pure view-model (`homeModel.ts`), passed to it by the
 * widgets as a parameter (ADR-0032 decision 2).
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
			provider: MarketSourceId | undefined,
		): string => enUnavailableReason(code, provider),
		/**
		 * The reason a stored series carries. English shows the stored text as
		 * it is (a never-fetched series excepted); another language words its code.
		 */
		storedUnavailableReason: (
			stored: string,
			code: MarketUnavailableCode,
			_provider: MarketSourceId,
		): string => (code === "NEVER_REFRESHED" ? EN_NEVER_REFRESHED : stored),
		/** A stored reason with the provider's own answer status after it (ADR-0037). */
		withUpstreamStatus: (reason: string, upstreamStatus: number | null): string =>
			reasonWithUpstreamStatus(reason, upstreamStatus, commonMessages.en),
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
		withUpstreamStatus: (reason, upstreamStatus) =>
			reasonWithUpstreamStatus(reason, upstreamStatus, commonMessages.ja),
	},
});
