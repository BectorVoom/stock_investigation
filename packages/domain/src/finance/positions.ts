import { err, ok, type Result } from "../result.ts";

/**
 * Position statistics are jurisdiction-specific (FR-007 / DATA-006). The two
 * shapes share no interchangeable fields on purpose: there is no US
 * security-level margin-buy balance, and US short interest is not Japan's
 * margin-sale balance.
 */
export interface JpMarginBalanceFigures {
	readonly jurisdiction: "JP";
	readonly metric: "jp-margin-balance";
	readonly marginBuyBalanceShares: number;
	readonly marginSellBalanceShares: number;
}

export interface UsShortInterestFigures {
	readonly jurisdiction: "US";
	readonly metric: "us-short-interest";
	readonly reportedShortInterestShares: number;
	readonly averageDailyVolumeShares: number | null;
}

export type PositionFigures = JpMarginBalanceFigures | UsShortInterestFigures;

export type PositionRatioError = "NON_FINITE" | "NEGATIVE_INPUT" | "ZERO_DENOMINATOR";

function ratio(numerator: number, denominator: number): Result<number, PositionRatioError> {
	if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return err("NON_FINITE");
	if (numerator < 0 || denominator < 0) return err("NEGATIVE_INPUT");
	if (denominator === 0) return err("ZERO_DENOMINATOR");
	const value = numerator / denominator;
	return Number.isFinite(value) ? ok(value) : err("NON_FINITE");
}

/** Japan margin ratio (信用倍率): margin buy balance / margin sell balance. */
export function jpMarginBuySellRatio(
	figures: JpMarginBalanceFigures,
): Result<number, PositionRatioError> {
	return ratio(figures.marginBuyBalanceShares, figures.marginSellBalanceShares);
}

/** US days-to-cover: reported short interest / average daily share volume. */
export function usDaysToCover(
	figures: UsShortInterestFigures,
): Result<number, PositionRatioError | "VOLUME_UNAVAILABLE"> {
	if (figures.averageDailyVolumeShares === null) return err("VOLUME_UNAVAILABLE");
	return ratio(figures.reportedShortInterestShares, figures.averageDailyVolumeShares);
}

export interface PositionLabels {
	readonly heading: string;
	readonly caveat: string;
}

const POSITION_LABELS: { readonly [M in PositionFigures["metric"]]: PositionLabels } = {
	"jp-margin-balance": {
		heading: "Japan margin trading balances (信用取引残高)",
		caveat:
			"Margin purchase and margin sale balances as defined by the reporting exchange/source. Not comparable to US short interest.",
	},
	"us-short-interest": {
		heading: "US short interest",
		caveat:
			"Security-level short interest as of the settlement date. Not equivalent to Japan's margin-sale balance; no security-level US margin-buy balance exists.",
	},
};

export function positionLabels(metric: PositionFigures["metric"]): PositionLabels {
	return POSITION_LABELS[metric];
}
