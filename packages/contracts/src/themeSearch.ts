import { z } from "zod";
import { formatStockId, watchlistStockIdSchema, watchMarketSchema } from "./watchlist.ts";

/**
 * Theme search (ADR-0066): `GET /api/v1/stocks/theme-search?q=` lists the
 * owner's stocks whose shown themes contain the words — the company
 * overview's 【テーマ】 when one is stored, else the AI-written summary's
 * themes (ADR-0060, ADR-0064). Only stocks that have one have themes.
 */
export const THEME_SEARCH_LIMITS = {
	/** What the box accepts; the server ignores a query longer than any theme name. */
	maxQueryChars: 100,
	/** The stocks on one page of results. */
	pageSize: 50,
	/** The highest page number a request may name (far beyond any owner's stocks). */
	maxPage: 10_000,
	/** A theme name's length (`COMPANY_SUMMARY_LIMITS.maxThemeChars`). */
	maxThemeChars: 40,
	/** The most themes one stock shows (a summary's 8; an overview has at most 6). */
	maxThemes: 8,
} as const;

export const themeSearchQuerySchema = z.strictObject({
	q: z.string().trim().min(1).max(THEME_SEARCH_LIMITS.maxQueryChars),
	/** The 1-based page of results; a page past the last answers the last. */
	page: z.coerce.number().int().min(1).max(THEME_SEARCH_LIMITS.maxPage).default(1),
});
export type ThemeSearchQuery = z.infer<typeof themeSearchQuerySchema>;

export const themeSearchNameSchema = z.strictObject({
	en: z.string().min(1).max(THEME_SEARCH_LIMITS.maxThemeChars),
	ja: z.string().min(1).max(THEME_SEARCH_LIMITS.maxThemeChars),
});

const nameSchema = z.string().min(1).max(200);

export const themeSearchHitSchema = z
	.strictObject({
		stockId: watchlistStockIdSchema,
		market: watchMarketSchema,
		symbol: z.string().min(1).max(16),
		/** The stock list's name; null when the stock is not in the stored lists. */
		name: nameSchema.nullable(),
		localName: nameSchema.nullable(),
		/** The stock's themes that contain the query, in their stored order. */
		themes: z.array(themeSearchNameSchema).min(1).max(THEME_SEARCH_LIMITS.maxThemes),
	})
	.refine((hit) => hit.stockId === formatStockId(hit.market, hit.symbol), {
		message: "stockId must be the market and symbol",
		path: ["stockId"],
	});
export type ThemeSearchHit = z.infer<typeof themeSearchHitSchema>;

export const themeSearchResponseSchema = z
	.strictObject({
		/** The query as matched (NFKC, single spaces); null when nothing can match. */
		query: z.string().min(1).max(THEME_SEARCH_LIMITS.maxQueryChars).nullable(),
		/** This page's stocks: at most `pageSize`, in market and symbol order. */
		hits: z.array(themeSearchHitSchema).max(THEME_SEARCH_LIMITS.pageSize),
		/** The page answered (the asked page, or the last when it asked past it); 1 with no stocks. */
		page: z.number().int().min(1).max(THEME_SEARCH_LIMITS.maxPage),
		/** Always `THEME_SEARCH_LIMITS.pageSize`. */
		pageSize: z.literal(THEME_SEARCH_LIMITS.pageSize),
		/** Every stock that matched, on all pages. */
		total: z.number().int().min(0),
		/** The number of pages; 1 with no stocks. */
		pageCount: z.number().int().min(1).max(THEME_SEARCH_LIMITS.maxPage),
	})
	.refine(
		(answer) =>
			answer.pageCount === Math.max(1, Math.ceil(answer.total / answer.pageSize)) &&
			answer.page <= answer.pageCount &&
			answer.hits.length ===
				Math.max(0, Math.min(answer.pageSize, answer.total - (answer.page - 1) * answer.pageSize)),
		{ message: "page, pageCount and hits must agree with total", path: ["page"] },
	);
export type ThemeSearchResponse = z.infer<typeof themeSearchResponseSchema>;
