/**
 * 13F filings report end-of-quarter holdings, not trades (FR-008 / DATA-007).
 * Changes are therefore "reported position" changes with no execution date.
 */
export type ReportedPositionChange =
	| "newly-reported-holding"
	| "increase-in-reported-position"
	| "decrease-in-reported-position"
	| "no-longer-reported"
	| "unchanged-reported-position"
	| "not-reported";

/** null means the security was absent from that quarter's filing. */
export function classifyReportedPositionChange(
	previousReportedShares: number | null,
	currentReportedShares: number | null,
): ReportedPositionChange {
	// Absent, non-positive and non-finite share counts all mean "no reported position".
	const reported = (shares: number | null): number =>
		shares !== null && Number.isFinite(shares) && shares > 0 ? shares : 0;
	const previous = reported(previousReportedShares);
	const current = reported(currentReportedShares);
	if (previous <= 0 && current <= 0) return "not-reported";
	if (previous <= 0) return "newly-reported-holding";
	if (current <= 0) return "no-longer-reported";
	if (current > previous) return "increase-in-reported-position";
	if (current < previous) return "decrease-in-reported-position";
	return "unchanged-reported-position";
}

const CHANGE_PHRASES: { readonly [C in ReportedPositionChange]: string } = {
	"newly-reported-holding": "newly reported holding",
	"increase-in-reported-position": "increase in reported position",
	"decrease-in-reported-position": "decrease in reported position",
	"no-longer-reported": "position no longer reported",
	"unchanged-reported-position": "unchanged reported position",
	"not-reported": "no reported position",
};

/** Short wording for a reported-position change; never implies a dated transaction. */
export function reportedPositionChangePhrase(change: ReportedPositionChange): string {
	return CHANGE_PHRASES[change];
}

export interface ReportedPositionContext {
	readonly investorName: string;
	readonly issuerName: string;
	/** Quarter end the filing reports on (YYYY-MM-DD). */
	readonly reportPeriodEnd: string;
	readonly filedAt: string;
	readonly form: string;
}

/** Wording that never implies a verified, dated transaction. */
export function describeReportedPositionChange(
	change: ReportedPositionChange,
	context: ReportedPositionContext,
): string {
	return `${context.investorName}: ${CHANGE_PHRASES[change]} in ${context.issuerName} as of ${context.reportPeriodEnd} (${context.form} filed ${context.filedAt}; quarter-end holdings, not a dated transaction).`;
}
