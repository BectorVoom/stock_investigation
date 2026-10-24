import { positionLabels } from "@research/domain";
import { defineMessages } from "@research/i18n";
import type { PositionMetric } from "./positionLabels.ts";

const JA_POSITION_LABELS: {
	readonly [M in PositionMetric]: { readonly heading: string; readonly caveat: string };
} = {
	"jp-margin-balance": {
		heading: "信用取引残高（日本）",
		caveat:
			"報告元の取引所・情報源が定義する信用買い残と信用売り残です。米国の空売り残高とは比較できません。",
	},
	"us-short-interest": {
		heading: "米国の空売り残高",
		caveat:
			"決済日時点の銘柄別の空売り残高です。日本の信用売り残とは同等ではなく、米国には銘柄別の信用買い残がありません。",
	},
};

/**
 * Headings and caveats for position statistics (FR-007 / DATA-006). The
 * English wording stays in the domain, so every surface words it identically;
 * other languages translate it here.
 */
export const positionLabelMessages = defineMessages({
	en: {
		heading: (metric: PositionMetric): string => positionLabels(metric).heading,
		/** The heading as a run-in label before the caveat. */
		headingLabel: (metric: PositionMetric): string => `${positionLabels(metric).heading}: `,
		caveat: (metric: PositionMetric): string => positionLabels(metric).caveat,
	},
	ja: {
		heading: (metric) => JA_POSITION_LABELS[metric].heading,
		headingLabel: (metric) => `${JA_POSITION_LABELS[metric].heading}：`,
		caveat: (metric) => JA_POSITION_LABELS[metric].caveat,
	},
});
