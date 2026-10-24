import { defineMessages } from "@research/i18n";

/**
 * Starter questions for an empty conversation (ADR-0031). They are sent to
 * the agent exactly as written, so each language asks in its own words.
 */
export const suggestionsMessages = defineMessages({
	en: {
		demandGrowth:
			"Which products will see demand growth over the next five years, and who supplies them?",
		japaneseGridStorage:
			"Which Japanese suppliers could benefit from three-year demand growth in grid storage?",
		usPricingPower: "Which US suppliers mention pricing power in their recent filings?",
		batteryMaterials: "What demand scenarios exist for battery materials over the next four years?",
	},
	ja: {
		demandGrowth: "今後 5 年間で需要が伸びる製品は何で、どの企業が供給していますか？",
		japaneseGridStorage:
			"系統用蓄電池の 3 年間の需要拡大で恩恵を受けそうな日本のサプライヤーはどこですか？",
		usPricingPower: "最近の提出書類で価格決定力に言及している米国のサプライヤーはどこですか？",
		batteryMaterials: "今後 4 年間の電池材料の需要シナリオにはどのようなものがありますか？",
	},
});
