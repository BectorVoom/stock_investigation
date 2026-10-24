import { STOCK_SEARCH_LIMITS } from "@research/domain";
import { z } from "zod";
import { httpsUrlSchema, idSchema, isoDateSchema, isoDateTimeSchema } from "./primitives.ts";
import {
	EARNINGS_COMPANY_NAME_MAX,
	formatStockId,
	parseStockId,
	type WatchMarket,
	watchlistStockIdSchema,
	watchMarketSchema,
} from "./watchlist.ts";

/**
 * The stock directory (ADR-0033): every exchange-listed US and Japanese stock,
 * downloaded by the runner one market per job and searched from the
 * Watchlist's add-a-stock form.
 */
export const STOCK_DIRECTORY_LIMITS = {
	/** Measured 2026-10-24: US 7,691, JP 3,707. */
	maxEntriesPerMarket: 10_000,
	/**
	 * A completion with fewer rows is refused, so a changed source layout that
	 * parses to a handful of rows can never replace a good stored list.
	 */
	minEntriesPerMarket: 1_000,
	maxNameChars: EARNINGS_COMPANY_NAME_MAX,
	/** Opening the Watchlist queues a refresh when a list is older than this. */
	staleAfterDays: 7,
	maxQueryChars: STOCK_SEARCH_LIMITS.maxQueryChars,
	maxResults: STOCK_SEARCH_LIMITS.maxResults,
	defaultResults: STOCK_SEARCH_LIMITS.defaultResults,
} as const;

/** Where a listing trades. Each market has its own set (`STOCK_LISTINGS_BY_MARKET`). */
export const stockListingSchema = z.enum([
	"nasdaq",
	"nyse",
	"cboe",
	"txse",
	"tse-prime",
	"tse-standard",
	"tse-growth",
]);
export type StockListing = z.infer<typeof stockListingSchema>;

export const STOCK_LISTINGS_BY_MARKET: {
	readonly [M in WatchMarket]: readonly StockListing[];
} = {
	US: ["nasdaq", "nyse", "cboe", "txse"],
	JP: ["tse-prime", "tse-standard", "tse-growth"],
};

export const stockDirectorySourceIdSchema = z.enum(["sec", "jpx"]);
export type StockDirectorySourceId = z.infer<typeof stockDirectorySourceIdSchema>;

/** The source of each market's list, with the fixed publisher and page the UI cites. */
export const STOCK_DIRECTORY_SOURCES: {
	readonly [M in WatchMarket]: {
		readonly sourceId: StockDirectorySourceId;
		readonly publisher: string;
		readonly sourceUrl: string;
	};
} = {
	US: {
		sourceId: "sec",
		publisher: "U.S. Securities and Exchange Commission (SEC)",
		sourceUrl: "https://www.sec.gov/files/company_tickers_exchange.json",
	},
	JP: {
		sourceId: "jpx",
		publisher: "Japan Exchange Group (JPX)",
		sourceUrl: "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html",
	},
};

/**
 * Stable failure codes of a `stock-directory-refresh` job (the `failed`
 * outcome's `failureCode`). Provider text is never carried.
 */
export const STOCK_DIRECTORY_FAILURE_CODES = [
	/** US only: `SEC_USER_AGENT` is not set in apps/runner/.env. */
	"DIRECTORY_NOT_CONFIGURED",
	"DIRECTORY_RATE_LIMITED",
	"DIRECTORY_SOURCE_FAILED",
	/** The file arrived but did not parse, or parsed to fewer than the floor. */
	"DIRECTORY_PARSE_FAILED",
] as const;
export const stockDirectoryFailureCodeSchema = z.enum(STOCK_DIRECTORY_FAILURE_CODES);
export type StockDirectoryFailureCode = z.infer<typeof stockDirectoryFailureCodeSchema>;

const nameSchema = z.string().trim().min(1).max(STOCK_DIRECTORY_LIMITS.maxNameChars);

/**
 * One listed stock as the runner sends it. `name` is the English name (SEC
 * title; JPX English list); `localName` is the Japanese name of a JP listing
 * and is omitted for US rows (keeping the US completion under the body cap).
 */
export const stockDirectoryEntrySchema = z.strictObject({
	symbol: z.string().min(1).max(16),
	name: nameSchema,
	localName: nameSchema.optional(),
	listing: stockListingSchema,
});
export type StockDirectoryEntry = z.infer<typeof stockDirectoryEntrySchema>;

/** The first problem with a market's entries, or null when they are valid. */
export function stockDirectoryEntriesProblem(
	market: WatchMarket,
	entries: readonly StockDirectoryEntry[],
): string | null {
	const listings = STOCK_LISTINGS_BY_MARKET[market];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (parseStockId(formatStockId(market, entry.symbol)) === null) {
			return `symbol ${entry.symbol} does not match the ${market} shape`;
		}
		if (!listings.includes(entry.listing)) {
			return `listing ${entry.listing} is not a ${market} listing`;
		}
		if (market === "US" && entry.localName !== undefined) {
			return "US rows carry no localName";
		}
		if (seen.has(entry.symbol)) return `symbol ${entry.symbol} is listed twice`;
		seen.add(entry.symbol);
	}
	return null;
}

/** Same shape and meaning as `watchlistRefreshSchema`, per market. */
export const stockDirectoryMarketStatusSchema = z.strictObject({
	market: watchMarketSchema,
	sourceId: stockDirectorySourceIdSchema,
	publisher: z.string().min(1).max(200),
	sourceUrl: httpsUrlSchema,
	/** Rows stored now; 0 before the first successful refresh. */
	entryCount: z.number().int().nonnegative(),
	/** The date the source says its list is effective (JPX); null when it states none (SEC). */
	asOf: isoDateSchema.nullable(),
	/** When the stored list was downloaded; null before the first successful refresh. */
	retrievedAt: isoDateTimeSchema.nullable(),
	activeRunId: idSchema.nullable(),
	activeRunState: z.string().nullable(),
	lastFailure: z
		.strictObject({
			state: z.string(),
			code: z.string().min(1).max(80),
			at: isoDateTimeSchema,
		})
		.nullable(),
});
export type StockDirectoryMarketStatus = z.infer<typeof stockDirectoryMarketStatusSchema>;

/** `GET /api/v1/watchlist/directory`: US first, then JP. */
export const stockDirectoryStatusResponseSchema = z.strictObject({
	markets: z
		.array(stockDirectoryMarketStatusSchema)
		.length(2)
		.refine((markets) => markets[0]?.market === "US" && markets[1]?.market === "JP", {
			message: "markets are US then JP",
		}),
});
export type StockDirectoryStatusResponse = z.infer<typeof stockDirectoryStatusResponseSchema>;

/** `GET /api/v1/watchlist/directory/search` query string. */
export const stockDirectorySearchQuerySchema = z.strictObject({
	q: z.string().trim().min(1).max(STOCK_DIRECTORY_LIMITS.maxQueryChars),
	market: watchMarketSchema.optional(),
	limit: z.coerce
		.number()
		.int()
		.min(1)
		.max(STOCK_DIRECTORY_LIMITS.maxResults)
		.default(STOCK_DIRECTORY_LIMITS.defaultResults),
});
export type StockDirectorySearchQuery = z.infer<typeof stockDirectorySearchQuerySchema>;

export const stockDirectoryHitSchema = z
	.strictObject({
		stockId: watchlistStockIdSchema,
		market: watchMarketSchema,
		symbol: z.string().min(1).max(16),
		name: nameSchema,
		localName: nameSchema.nullable(),
		listing: stockListingSchema,
		/** Already on the owner's watchlist: shown as such and not pickable. */
		registered: z.boolean(),
	})
	.refine((hit) => hit.stockId === formatStockId(hit.market, hit.symbol), {
		message: "stockId must be the market and symbol",
		path: ["stockId"],
	});
export type StockDirectoryHit = z.infer<typeof stockDirectoryHitSchema>;

/** Ranked as ADR-0033 section 6 says; empty when nothing matches or no list is stored. */
export const stockDirectorySearchResponseSchema = z.strictObject({
	hits: z.array(stockDirectoryHitSchema).max(STOCK_DIRECTORY_LIMITS.maxResults),
});
export type StockDirectorySearchResponse = z.infer<typeof stockDirectorySearchResponseSchema>;

/** `POST /api/v1/watchlist/directory/refresh` body: the markets to refresh (default both). */
export const stockDirectoryRefreshRequestSchema = z.strictObject({
	markets: z
		.array(watchMarketSchema)
		.min(1)
		.max(2)
		.refine((markets) => new Set(markets).size === markets.length, {
			message: "markets must be distinct",
		})
		.default(["US", "JP"]),
});
export type StockDirectoryRefreshRequest = z.infer<typeof stockDirectoryRefreshRequestSchema>;

/** One queued (or already active) run per requested market. */
export const stockDirectoryRefreshResponseSchema = z.strictObject({
	runs: z
		.array(z.strictObject({ market: watchMarketSchema, runId: idSchema }))
		.min(1)
		.max(2),
});
export type StockDirectoryRefreshResponse = z.infer<typeof stockDirectoryRefreshResponseSchema>;
