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
	maxResults: 50,
	/** A theme name's length (`COMPANY_SUMMARY_LIMITS.maxThemeChars`). */
	maxThemeChars: 40,
	/** The most themes one stock shows (a summary's 8; an overview has at most 6). */
	maxThemes: 8,
} as const;

export const themeSearchQuerySchema = z.strictObject({
	q: z.string().trim().min(1).max(THEME_SEARCH_LIMITS.maxQueryChars),
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

export const themeSearchResponseSchema = z.strictObject({
	/** The query as matched (NFKC, single spaces); null when nothing can match. */
	query: z.string().min(1).max(THEME_SEARCH_LIMITS.maxQueryChars).nullable(),
	hits: z.array(themeSearchHitSchema).max(THEME_SEARCH_LIMITS.maxResults),
	/** More stocks matched than `maxResults`. */
	truncated: z.boolean(),
});
export type ThemeSearchResponse = z.infer<typeof themeSearchResponseSchema>;
