import { type PositionFigures, type PositionLabels, positionLabels } from "@research/domain";
import { cellReasonMessages } from "./cellReasons.messages.ts";

/**
 * Jurisdiction-specific headings and caveats for position statistics (FR-007 /
 * DATA-006) come from the domain, so every surface words them identically.
 */
export type PositionMetric = PositionFigures["metric"];
export { type PositionLabels, positionLabels };

const US_MARKER = /(^|[^a-z])(u\.?s\.?a?|united states|nyse|nasdaq|finra)([^a-z]|$)/i;
const MARGIN_BUY_MARKER = /margin[\s_-]*(buy|buying|purchase|long)|信用買/i;
const MARGIN_MARKER =
	/margin[\s_-]*(buy|buying|purchase|sell|selling|sale|balance|long|short)|信用/i;
const SHORT_INTEREST_MARKER = /short[\s_-]*interest|days[\s_-]*to[\s_-]*cover/i;

/** Stored in English in the withheld cells; the view words it (`cellReasonText`). */
export const US_MARGIN_BUY_WITHHELD_REASON = cellReasonMessages.en.usMarginBuyWithheld;

/**
 * Defence in depth for FR-007: a column that labels itself as a US margin-buy
 * figure describes a statistic that does not exist, so its cells are withheld
 * rather than displayed. The authoritative guard is the server-side schema;
 * this catches a mislabelled free-form dataset column at the last boundary.
 */
export function isUsMarginBuyLabel(label: string): boolean {
	return US_MARKER.test(label) && MARGIN_BUY_MARKER.test(label);
}

/** Which position caveats a table must display, judged from its column labels. */
export function positionMetricsMentioned(labels: readonly string[]): readonly PositionMetric[] {
	const metrics: PositionMetric[] = [];
	if (labels.some((label) => MARGIN_MARKER.test(label))) metrics.push("jp-margin-balance");
	if (labels.some((label) => SHORT_INTEREST_MARKER.test(label))) metrics.push("us-short-interest");
	return metrics;
}
