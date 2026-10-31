import {
	EQUITY_SYNC_API_FAILURE_CODES,
	EQUITY_SYNC_FAILURE_CODES,
	type EquitySyncApiFailureCode,
	type EquitySyncFailureCode,
} from "@research/contracts";

// Its own module (not equitiesModel.ts) because equities.messages.ts needs it
// and equitiesModel.ts imports the catalog's type: one module would be a cycle.

/**
 * Every failure code a company's sync can carry and that has its own words.
 * `FINANCIAL_SOURCE_NOT_CONFIGURED` is worded separately (`notConfigured`
 * names the variable to set). A mapped type, so a code added to either
 * contracts list fails the typecheck here until it has words in both
 * languages — it never falls back silently to "The sync failed.".
 */
export type WordedSyncFailureCode = Exclude<
	EquitySyncFailureCode | EquitySyncApiFailureCode,
	"FINANCIAL_SOURCE_NOT_CONFIGURED"
>;

const WORDED_FAILURE_CODES: ReadonlySet<string> = new Set<string>(
	[...EQUITY_SYNC_FAILURE_CODES, ...EQUITY_SYNC_API_FAILURE_CODES].filter(
		(code) => code !== "FINANCIAL_SOURCE_NOT_CONFIGURED",
	),
);

/** True for a stored code (free text on the wire) that has its own words. */
export function isWordedSyncFailure(code: string): code is WordedSyncFailureCode {
	return WORDED_FAILURE_CODES.has(code);
}
