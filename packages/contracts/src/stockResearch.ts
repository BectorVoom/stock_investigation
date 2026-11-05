import { z } from "zod";
import { httpsUrlSchema, isoDateTimeSchema } from "./primitives.ts";
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
export const stockResearchResponseSchema = z.strictObject({
	hits: z.array(stockResearchHitSchema).max(12),
	truncated: z.boolean(),
});
export type StockResearchResponse = z.infer<typeof stockResearchResponseSchema>;
