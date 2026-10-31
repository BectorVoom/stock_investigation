/**
 * The US stock directory (ADR-0034): SEC's `company_tickers_exchange.json`,
 * the same ticker directory the SEC financials tool reads, downloaded through
 * the same fair-access client (declared User-Agent, request spacing, no
 * automatic retries).
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/sec-edgar.md
 *
 * Rows on Nasdaq, NYSE, Cboe or Texas SE are kept; OTC rows and rows without
 * an exchange are dropped. Rows are kept in file order, the first row of a
 * ticker wins (the directory reader's rule), and a ticker that fails the US
 * symbol shape is dropped. A name longer than the stored maximum drops its row (US names
 * have no second language to fall back to); only the count is reported.
 */
import type { StockDirectorySource } from "@research/application";
import {
	EXCHANGES_BY_COUNTRY,
	parseStockId,
	type StockDirectoryEntry,
	type StockDirectoryFailureCode,
	type StockListing,
} from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import { parseSecJson, type SecClient, type SecErrorCode } from "./secClient.ts";
import {
	parseTickerDirectory,
	SEC_TICKER_DIRECTORY_URL,
	TICKER_DIRECTORY_MAX_BYTES,
} from "./secFinancials.ts";
import {
	directoryFailure,
	finishDirectory,
	fitsDirectoryName,
	type ParsedStockDirectory,
} from "./stockDirectory.ts";

/** A US venue name of the contract's `Security.exchange`. */
export type UsSecurityVenue = (typeof EXCHANGES_BY_COUNTRY.US)[number];

/**
 * Every SEC exchange text the directory keeps: the listing it stores and the
 * contract venue a security record names. One table for both, so the
 * financials tool identifies every stock the owner can add from the
 * directory.
 */
export const SEC_EXCHANGES: readonly {
	readonly secText: string;
	readonly listing: StockListing;
	readonly venue: UsSecurityVenue;
}[] = [
	{ secText: "Nasdaq", listing: "nasdaq", venue: "NASDAQ" },
	{ secText: "NYSE", listing: "nyse", venue: "NYSE" },
	// SEC's `CBOE` is a Cboe listing, which trades on Cboe BZX (Cboe's listing exchange).
	{ secText: "CBOE", listing: "cboe", venue: "Cboe BZX" },
	{ secText: "TXSE", listing: "txse", venue: "TXSE" },
];

/** SEC's exchange text (exact) → the listing kept; every other exchange is dropped. */
export const SEC_DIRECTORY_LISTINGS: ReadonlyMap<string, StockListing> = new Map(
	SEC_EXCHANGES.map((exchange) => [exchange.secText, exchange.listing]),
);

/**
 * SEC's exchange text as the contract venue of a security record, or null.
 * A directory text maps through `SEC_EXCHANGES`; any other text must name a
 * contract venue itself. Both compare trimmed and case-insensitively.
 */
export function secContractVenue(secExchange: string | null): UsSecurityVenue | null {
	if (secExchange === null) return null;
	const wanted = secExchange.trim().toLowerCase();
	const known = SEC_EXCHANGES.find((exchange) => exchange.secText.toLowerCase() === wanted);
	if (known !== undefined) return known.venue;
	return EXCHANGES_BY_COUNTRY.US.find((venue) => venue.toLowerCase() === wanted) ?? null;
}

/**
 * The US list of a decoded ticker directory, before the row-count floor.
 * Pure: the conformance vectors run it on the same inputs in TypeScript and
 * Rust. An unreadable directory (wrong shape, missing columns, no usable
 * row) is `DIRECTORY_PARSE_FAILED`.
 */
export function secDirectoryEntries(value: unknown): Result<
	{
		readonly entries: StockDirectoryEntry[];
		readonly droppedRows: number;
	},
	StockDirectoryFailureCode
> {
	const issuers = parseTickerDirectory(value);
	if (!issuers.ok) return err("DIRECTORY_PARSE_FAILED");
	const entries: StockDirectoryEntry[] = [];
	const seen = new Set<string>();
	let droppedRows = 0;
	for (const issuer of issuers.value.values()) {
		const listing =
			issuer.secExchange === null ? undefined : SEC_DIRECTORY_LISTINGS.get(issuer.secExchange);
		if (listing === undefined) continue;
		const symbol = issuer.ticker;
		if (parseStockId(`us:${symbol}`) === null || seen.has(symbol)) continue;
		if (!fitsDirectoryName(issuer.name)) {
			droppedRows += 1;
			continue;
		}
		seen.add(symbol);
		entries.push({ symbol, name: issuer.name, listing });
	}
	return ok({ entries, droppedRows });
}

/** `secDirectoryEntries` plus the contract's row-count floor and ceiling; SEC states no date. */
export function parseSecDirectory(
	value: unknown,
): Result<ParsedStockDirectory, StockDirectoryFailureCode> {
	const parsed = secDirectoryEntries(value);
	if (!parsed.ok) return parsed;
	return finishDirectory(null, parsed.value.entries, parsed.value.droppedRows);
}

function failureOf(code: SecErrorCode): StockDirectoryFailureCode {
	switch (code) {
		case "NOT_CONFIGURED":
			return "DIRECTORY_NOT_CONFIGURED";
		case "RATE_LIMITED":
			return "DIRECTORY_RATE_LIMITED";
		case "UNEXPECTED_RESPONSE":
			return "DIRECTORY_PARSE_FAILED";
		default:
			return "DIRECTORY_SOURCE_FAILED";
	}
}

export interface SecDirectoryDeps {
	/** The SEC fair-access client (its User-Agent is the owner's `SEC_USER_AGENT`). */
	readonly client: SecClient;
	/** Told how many rows were dropped for an over-long name, when any were (never the names). */
	readonly onDroppedRows?: (count: number) => void;
}

export function createSecDirectorySource(deps: SecDirectoryDeps): StockDirectorySource {
	return {
		market: "US",
		async fetchDirectory(query) {
			// One grant per request start, taken immediately before it is sent;
			// a false hook (the job stopped while waiting) sends nothing.
			if (!(await query.beforeRequest())) return err(directoryFailure("DIRECTORY_SOURCE_FAILED"));
			const document = await deps.client.fetchDocument(SEC_TICKER_DIRECTORY_URL, {
				maxBytes: TICKER_DIRECTORY_MAX_BYTES,
				accept: "application/json",
				signal: query.signal,
			});
			if (!document.ok) {
				// SEC's own status travels unchanged beside our code (§4a).
				return err({
					code: failureOf(document.error.code),
					upstreamStatus: document.error.upstreamStatus,
				});
			}
			const json = parseSecJson(document.value);
			if (!json.ok) return err(directoryFailure("DIRECTORY_PARSE_FAILED"));
			const parsed = parseSecDirectory(json.value);
			if (!parsed.ok) return err(directoryFailure(parsed.error));
			if (parsed.value.droppedRows > 0) deps.onDroppedRows?.(parsed.value.droppedRows);
			return ok(parsed.value.data);
		},
	};
}
