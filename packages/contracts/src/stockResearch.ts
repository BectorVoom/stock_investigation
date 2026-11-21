import { z } from "zod";
import {
	currencySchema,
	httpsUrlSchema,
	isoDateSchema,
	isoDateTimeSchema,
	shortTextSchema,
} from "./primitives.ts";
import { sourceClassSchema } from "./records.ts";

export const stockResearchKindSchema = z.enum(["company", "financials", "news"]);
export const stockResearchQuerySchema = z.strictObject({
	query: z
		.string()
		.trim()
		.min(1)
		.max(128)
		.refine((text) => text.split(/\s+/u).length <= 8, "Use at most eight search terms."),
	kind: stockResearchKindSchema.optional(),
	limit: z.number().int().min(1).max(12).default(6),
});
export type StockResearchQuery = z.infer<typeof stockResearchQuerySchema>;
export const stockResearchRequestSchema = stockResearchQuerySchema.extend({
	leaseGeneration: z.number().int().nonnegative(),
});
export type StockResearchRequest = z.infer<typeof stockResearchRequestSchema>;

/** Stored passages, never generated answers. A null URL is context, not citeable evidence. */
export const stockResearchHitSchema = z.strictObject({
	kind: stockResearchKindSchema,
	recordId: z.string().min(1).max(300),
	title: z.string().min(1).max(300),
	text: z.string().min(1).max(2400),
	sourceUrl: httpsUrlSchema.nullable(),
	publisher: z.string().min(1).max(300),
	publishedAt: isoDateTimeSchema.nullable(),
	retrievedAt: isoDateTimeSchema,
	effectiveAt: isoDateTimeSchema.nullable(),
	sourceClass: sourceClassSchema,
	retainQuotes: z.boolean(),
	aiGenerated: z.boolean(),
});
export type StockResearchHit = z.infer<typeof stockResearchHitSchema>;

export const stockResearchJpExchangeSchema = z.enum(["TSE", "NSE", "FSE", "SSE"]);
export type StockResearchJpExchange = z.infer<typeof stockResearchJpExchangeSchema>;

/** One authoritative annual figure of a Japanese company from stored J-Quants statements. */
export const stockResearchJpFigureSchema = z.strictObject({
	value: z.number().finite(),
	currency: currencySchema,
	accountingStandard: z.enum(["US-GAAP", "IFRS", "JGAAP", "OTHER"]),
	periodStart: isoDateSchema,
	periodEnd: isoDateSchema,
	sourceUrl: httpsUrlSchema,
	filedOn: isoDateSchema,
	retrievedAt: isoDateTimeSchema,
	concept: z.string().min(1).max(120),
});
export type StockResearchJpFigure = z.infer<typeof stockResearchJpFigureSchema>;

/** Structured annual financials for a matched Japanese company so `stocks.search` emits `FinancialObservation`s. */
export const stockResearchJpFinancialsSchema = z.strictObject({
	symbol: z.string().regex(/^[A-Z0-9.-]{1,12}$/),
	issuerName: shortTextSchema,
	exchange: stockResearchJpExchangeSchema,
	listingVerification: z.enum(["source-verified", "unverified"]),
	fiscalYear: z.number().int().min(1990).max(2100),
	revenue: stockResearchJpFigureSchema.nullable(),
	revenueUnavailableReason: z.string().min(1).max(300).nullable(),
	netIncome: stockResearchJpFigureSchema.nullable(),
	netIncomeUnavailableReason: z.string().min(1).max(300).nullable(),
});
export type StockResearchJpFinancials = z.infer<typeof stockResearchJpFinancialsSchema>;

export const stockResearchResponseSchema = z.strictObject({
	hits: z.array(stockResearchHitSchema).max(12),
	truncated: z.boolean(),
	jpFinancials: z.array(stockResearchJpFinancialsSchema).max(12).default([]),
});
export type StockResearchResponse = z.infer<typeof stockResearchResponseSchema>;
