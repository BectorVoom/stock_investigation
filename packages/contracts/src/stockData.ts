import { STOCK_DATA_RETRIEVAL_LIMITS } from "@research/domain";
import { z } from "zod";
import { httpsUrlSchema, isoDateTimeSchema } from "./primitives.ts";
import { sourceClassSchema } from "./records.ts";
import { watchlistStockIdSchema } from "./watchlist.ts";

/**
 * Retrieval over the stored stock data (ADR-0071): the runner's
 * `stocks.search_data` research tool asks the API for the stored passages of
 * a few stocks that best answer a query. The API reads only what is stored
 * (directory entry, company profile, AI summary, company overview, annual
 * report business text, financial statements, earnings dates, daily closes),
 * cuts it into passages and ranks them with `rankStockPassages`.
 */

/** The kinds of stored record a passage comes from. */
export const STOCK_DATA_SECTIONS = [
	"listing",
	"company-profile",
	"ai-summary",
	"overview",
	"business",
	"financials",
	"earnings",
	"prices",
] as const;
export const stockDataSectionSchema = z.enum(STOCK_DATA_SECTIONS);
export type StockDataSection = z.infer<typeof stockDataSectionSchema>;

export const STOCK_DATA_LIMITS = {
	maxQueryChars: STOCK_DATA_RETRIEVAL_LIMITS.maxQueryChars,
	/** Stocks one call may name. */
	maxStockIds: 5,
	/** Stocks one call reads at most, named or found from the query. */
	maxSearchedStocks: 5,
	defaultResults: 8,
	maxResults: STOCK_DATA_RETRIEVAL_LIMITS.maxResults,
	maxPassageChars: 1200,
	maxTitleChars: 200,
	/** Fiscal years of each financial statement turned into passages, newest first. */
	financialYears: 3,
	/** Business-section paragraphs turned into passages. */
	maxBusinessParagraphs: 12,
} as const;

/** `POST /api/v1/runner/jobs/:id/stock-data/search`: the lease holder's query. */
export const stockDataSearchRequestSchema = z.strictObject({
	leaseGeneration: z.number().int().positive(),
	query: z.string().trim().min(1).max(STOCK_DATA_LIMITS.maxQueryChars),
	/** The stocks to search; omitted → the stocks the query names (directory, Watchlist and theme matches). */
	stockIds: z.array(watchlistStockIdSchema).min(1).max(STOCK_DATA_LIMITS.maxStockIds).optional(),
	/** Only these kinds of record; omitted → every kind. */
	sections: z.array(stockDataSectionSchema).min(1).max(STOCK_DATA_SECTIONS.length).optional(),
	limit: z.number().int().min(1).max(STOCK_DATA_LIMITS.maxResults).optional(),
});
export type StockDataSearchRequest = z.infer<typeof stockDataSearchRequestSchema>;

export const stockDataPassageSchema = z.strictObject({
	stockId: watchlistStockIdSchema,
	/** The stock's stored name; null when none is stored. */
	name: z.string().min(1).max(200).nullable(),
	section: stockDataSectionSchema,
	title: z.string().min(1).max(STOCK_DATA_LIMITS.maxTitleChars),
	text: z.string().min(1).max(STOCK_DATA_LIMITS.maxPassageChars),
	/** The public page the stored record came from; null when none is stored. */
	sourceUrl: httpsUrlSchema.nullable(),
	publisher: z.string().min(1).max(200),
	sourceClass: sourceClassSchema,
	/** When the record was stored or states its data for; null when unknown. */
	asOf: isoDateTimeSchema.nullable(),
	/** Written by the AI agent (ADR-0060, ADR-0064), not read from a source. */
	aiWritten: z.boolean(),
	/** BM25 relevance; higher is better. */
	score: z.number().nonnegative(),
});
export type StockDataPassage = z.infer<typeof stockDataPassageSchema>;

export const stockDataSearchResponseSchema = z.strictObject({
	/** The stocks whose stored data was searched, in search order. */
	searchedStocks: z.array(watchlistStockIdSchema).max(STOCK_DATA_LIMITS.maxSearchedStocks),
	passages: z.array(stockDataPassageSchema).max(STOCK_DATA_LIMITS.maxResults),
});
export type StockDataSearchResponse = z.infer<typeof stockDataSearchResponseSchema>;
