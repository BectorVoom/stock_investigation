import { BUSINESS_DESCRIPTION_LIMITS, STOCK_MENTION_LIMITS } from "@research/domain";
import { z } from "zod";
import { equityBusinessParagraphSchema, equityBusinessSourceSchema } from "./equityFinancials.ts";
import { MARKET_LIMITS, marketSeriesIdSchema, marketSeriesSchema } from "./market.ts";
import { isoDateTimeSchema } from "./primitives.ts";
import { articleSchema } from "./records.ts";
import { stockListingSchema } from "./stockDirectory.ts";
import {
	EARNINGS_COMPANY_NAME_MAX,
	formatStockId,
	watchlistStockIdSchema,
	watchMarketSchema,
} from "./watchlist.ts";

/**
 * The Stocks page's per-stock reads (ADR-0049): one stock's stored
 * directory entry, its stored price series and the stored articles that
 * mention it. Every read answers from the database only — none makes the
 * runner fetch anything — and each is conditional (ETag).
 */

/** The tabs of a selected stock, in strip order (ADR-0049 §3). */
export const STOCK_TABS = ["chart", "financials", "company", "news"] as const;
export const stockTabSchema = z.enum(STOCK_TABS);
export type StockTab = z.infer<typeof stockTabSchema>;

export const STOCK_LIMITS = {
	/** Articles one News page returns. */
	newsPageSize: 20,
	/** Candidate rows one SQL batch reads before the mention check. */
	newsCandidateBatch: 60,
	/** Batches one News request reads at most (bounded work per request). */
	newsMaxBatches: 5,
	/** Longest cursor accepted. */
	maxCursorChars: 400,
	maxTerms: STOCK_MENTION_LIMITS.maxTerms,
	maxObservations: MARKET_LIMITS.maxObservationsPerResponse,
} as const;

/**
 * The Company tab's business description (ADR-0053 §5), from stored rows only:
 * - "not-tracked": the company's financial statements are not synced and none is stored;
 * - "pending": they are synced, no description is stored yet;
 * - "not-found": the newest annual report had no section the runner could read;
 * - "extracted": the paragraphs of the newest annual report read.
 * A description stays after the company is untracked.
 */
export const stockBusinessSchema = z.discriminatedUnion("status", [
	z.strictObject({ status: z.literal("not-tracked") }),
	z.strictObject({ status: z.literal("pending") }),
	z.strictObject({ status: z.literal("not-found"), source: equityBusinessSourceSchema }),
	z.strictObject({
		status: z.literal("extracted"),
		source: equityBusinessSourceSchema,
		paragraphs: z
			.array(equityBusinessParagraphSchema)
			.min(1)
			.max(BUSINESS_DESCRIPTION_LIMITS.maxParagraphs),
		truncated: z.boolean(),
		/** When the runner read it. */
		fetchedAt: isoDateTimeSchema,
	}),
]);
export type StockBusiness = z.infer<typeof stockBusinessSchema>;

/**
 * `GET /api/v1/stocks/:stockId`: the stock's stored directory entry (null
 * when the list has none) and its business description.
 */
export const stockProfileResponseSchema = z
	.strictObject({
		stockId: watchlistStockIdSchema,
		market: watchMarketSchema,
		symbol: z.string().min(1).max(16),
		/** The market series its daily closes are stored under (`stockPriceSeriesId`). */
		priceSeriesId: marketSeriesIdSchema,
		directory: z
			.strictObject({
				name: z.string().min(1).max(EARNINGS_COMPANY_NAME_MAX),
				localName: z.string().min(1).max(EARNINGS_COMPANY_NAME_MAX).nullable(),
				listing: stockListingSchema,
			})
			.nullable(),
		business: stockBusinessSchema,
	})
	.refine((profile) => profile.stockId === formatStockId(profile.market, profile.symbol), {
		message: "stockId must be the market and symbol",
		path: ["stockId"],
	});
export type StockProfileResponse = z.infer<typeof stockProfileResponseSchema>;

/**
 * `GET /api/v1/stocks/:stockId/prices`: the stored series with its newest
 * observations (the market widgets' shape), or null when none is stored.
 */
export const stockPricesResponseSchema = z
	.strictObject({
		stockId: watchlistStockIdSchema,
		seriesId: marketSeriesIdSchema,
		series: marketSeriesSchema.nullable(),
	})
	.refine((prices) => prices.series === null || prices.series.seriesId === prices.seriesId, {
		message: "series must be the stock's price series",
		path: ["series"],
	});
export type StockPricesResponse = z.infer<typeof stockPricesResponseSchema>;

export const stockMentionTermSchema = z.strictObject({
	text: z.string().min(1).max(STOCK_MENTION_LIMITS.maxTermChars),
	kind: z.enum(["name", "symbol"]),
});

/** A stored article with the term it mentions. */
export const stockNewsArticleSchema = articleSchema.extend({
	mentions: stockMentionTermSchema,
});
export type StockNewsArticle = z.infer<typeof stockNewsArticleSchema>;

/**
 * `GET /api/v1/stocks/:stockId/news?cursor=`: the owner's stored articles
 * that mention the stock, newest first (`retrievedAt`, then `articleId`).
 */
export const stockNewsResponseSchema = z.strictObject({
	stockId: watchlistStockIdSchema,
	/** What was searched for (empty when no name is stored and the stock is Japanese). */
	terms: z.array(stockMentionTermSchema).max(STOCK_MENTION_LIMITS.maxTerms),
	articles: z.array(stockNewsArticleSchema).max(STOCK_LIMITS.newsPageSize),
	/** Opaque; null when every stored article was looked at. */
	nextCursor: z.string().min(1).max(STOCK_LIMITS.maxCursorChars).nullable(),
});
export type StockNewsResponse = z.infer<typeof stockNewsResponseSchema>;

export const stockNewsQuerySchema = z.strictObject({
	cursor: z.string().min(1).max(STOCK_LIMITS.maxCursorChars).optional(),
});
