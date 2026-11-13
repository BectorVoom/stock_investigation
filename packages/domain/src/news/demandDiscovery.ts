import type { DemandTheme } from "./demandSignals.ts";

/** Query vocabulary retrieves candidates; it does not assert demand or economic significance. */
const TOPICS: Readonly<Record<DemandTheme, readonly [string, string]>> = {
	ai: [
		'("artificial intelligence" OR "data center" OR cloud)',
		"(生成AI OR データセンター OR クラウド)",
	],
	semiconductors: ["(semiconductor OR chips OR wafer)", "(半導体 OR チップ OR ウエハー)"],
	energy: ["(electricity OR battery OR hydrogen OR solar)", "(電力 OR 蓄電池 OR 水素 OR 太陽光)"],
	mobility: ['("electric vehicle" OR logistics OR shipping)', "(自動車 OR 物流 OR 海運)"],
	automation: ['(robotics OR automation OR "industrial robot")', "(ロボット OR 自動化 OR 省人化)"],
	security: ["(cybersecurity OR defense OR aerospace)", "(サイバーセキュリティ OR 防衛 OR 宇宙)"],
	healthcare: [
		'("medical device sales" OR "drug sales" OR "drug shortages" OR "eldercare demand")',
		"(医療機器 OR 医薬品 OR 介護サービス)",
	],
	infrastructure: ['(construction OR "water treatment" OR cooling)', "(建設 OR 水処理 OR 空調)"],
	consumer: ["(retail OR tourism OR travel)", "(小売 OR 観光 OR 旅行)"],
	finance: [
		'("payment volumes" OR "transaction volumes" OR "insurance premiums" OR "cashless payments")',
		"(決済取扱高 OR 決済件数 OR キャッシュレス決済 OR 新契約年換算保険料)",
	],
	materials: [
		'(copper OR lithium OR steel OR "rare earth")',
		"(銅 OR リチウム OR 鉄鋼 OR レアアース)",
	],
	agriculture: [
		'(fertilizer OR "farm machinery" OR irrigation OR "food processing" OR "grain demand")',
		"(農業機械 OR 肥料 OR 食品)",
	],
	telecom: [
		'("telecom services" OR "broadband adoption" OR "optical fiber" OR "satellite services")',
		"(通信サービス OR 光ファイバー OR 衛星通信)",
	],
};
export function demandDiscoveryQuery(
	theme: DemandTheme,
	language: "en" | "ja",
	product: string,
): string {
	const topic = TOPICS[theme][language === "en" ? 0 : 1];
	const demand =
		language === "en"
			? "(demand OR orders OR sales OR spending OR adoption OR shortage)"
			: "(需要 OR 受注 OR 売上 OR 設備投資 OR 市場拡大 OR 不足)";
	// The user's product text is a literal phrase, never provider query syntax.
	const cleaned = product
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}\s-]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const literal = [...cleaned].slice(0, 80).join("");
	return `${topic} ${demand}${literal === "" ? "" : ` "${literal}"`} when:30d`;
}
export function demandDiscoveryUrl(
	theme: DemandTheme,
	language: "en" | "ja",
	product: string,
): string {
	const params = new URLSearchParams({
		q: demandDiscoveryQuery(theme, language, product),
		hl: language === "ja" ? "ja" : "en-US",
		gl: language === "ja" ? "JP" : "US",
		ceid: language === "ja" ? "JP:ja" : "US:en",
	});
	return `https://news.google.com/search?${params}`;
}
