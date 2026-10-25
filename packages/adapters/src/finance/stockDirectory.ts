/**
 * Rules shared by the two stock-directory sources (ADR-0034): the SEC list
 * (`secDirectory.ts`) and the JPX list (`jpxDirectory.ts`). Both parse a
 * whole market's list into `StockDirectoryEntry` rows and must hand the
 * runner a list the completion contract accepts, or a stable failure code.
 */
import {
	type SafeFetchError,
	type StockDirectoryData,
	type StockDirectoryFailure,
	upstreamStatusOf,
} from "@research/application";
import {
	STOCK_DIRECTORY_LIMITS,
	type StockDirectoryEntry,
	type StockDirectoryFailureCode,
} from "@research/contracts";
import { err, ok, type Result } from "@research/domain";

/** A parsed list plus how many rows were dropped for an over-long name (logged as a count only). */
export interface ParsedStockDirectory {
	readonly data: StockDirectoryData;
	readonly droppedRows: number;
}

/**
 * Whether a provider name can be stored as is: the completion schema trims
 * and bounds names to 1..`maxNameChars` UTF-16 units (zod's `length`), so
 * the caller passes the trimmed text.
 */
export function fitsDirectoryName(name: string): boolean {
	return name.length >= 1 && name.length <= STOCK_DIRECTORY_LIMITS.maxNameChars;
}

/**
 * The finished list, or `DIRECTORY_PARSE_FAILED` when the row count is
 * outside the contract's floor and ceiling: a changed file layout that
 * parses to a handful of rows must never replace a good stored list.
 */
export function finishDirectory(
	asOf: string | null,
	entries: readonly StockDirectoryEntry[],
	droppedRows: number,
): Result<ParsedStockDirectory, StockDirectoryFailureCode> {
	if (
		entries.length < STOCK_DIRECTORY_LIMITS.minEntriesPerMarket ||
		entries.length > STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket
	) {
		return err("DIRECTORY_PARSE_FAILED");
	}
	return ok({ data: { asOf, entries }, droppedRows });
}

/** A failure no external answer caused (parse, not configured, a stopped job). */
export function directoryFailure(code: StockDirectoryFailureCode): StockDirectoryFailure {
	return { code, upstreamStatus: null };
}

/**
 * A failed download: HTTP 429 is a rate limit, anything else a source
 * failure; the source's own status travels unchanged (§4a).
 */
export function directoryFetchFailure(error: SafeFetchError): StockDirectoryFailure {
	const upstreamStatus = upstreamStatusOf(error);
	return {
		code:
			error.code === "HTTP_ERROR" && error.status === 429
				? "DIRECTORY_RATE_LIMITED"
				: "DIRECTORY_SOURCE_FAILED",
		upstreamStatus,
	};
}
