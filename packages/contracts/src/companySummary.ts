import { z } from "zod";
import { agentIdSchema } from "./agent.ts";
import { isoDateTimeSchema } from "./primitives.ts";

/**
 * An AI-written company summary (ADR-0060): a short description of what the
 * company does and the investment themes it belongs to, in English and
 * Japanese. Written by the owner's AI agent (Settings → AI agent) in a
 * `company-summary` job for each Watchlist stock, from the facts the server
 * has stored, stored in `stock_company_summary` and shown on the Stocks
 * page's Company tab, marked as AI-written.
 */
export const COMPANY_SUMMARY_LIMITS = {
	maxDescriptionChars: 1_000,
	minThemes: 1,
	maxThemes: 8,
	maxThemeChars: 40,
	/** A name, listing or sector fact the claim carries. */
	maxFactChars: 200,
	/** The US annual report's business text the claim carries, cut to this many characters. */
	maxBusinessExcerptChars: 4_000,
	/** A stored summary is written again after this many days. */
	refreshAfterDays: 90,
	/** A stock whose summary job was queued is not queued again for this many hours. */
	retryAfterHours: 24,
} as const;

/** One text in both UI languages. */
function localizedText(max: number) {
	return z.strictObject({
		en: z.string().trim().min(1).max(max),
		ja: z.string().trim().min(1).max(max),
	});
}

/** One investment theme ("AI" / "AI", "Semiconductors" / "半導体"). */
export const companySummaryThemeSchema = localizedText(COMPANY_SUMMARY_LIMITS.maxThemeChars);
export type CompanySummaryTheme = z.infer<typeof companySummaryThemeSchema>;

/** What the agent writes: the description and the themes, both languages. */
export const companySummarySchema = z.strictObject({
	description: localizedText(COMPANY_SUMMARY_LIMITS.maxDescriptionChars),
	themes: z
		.array(companySummaryThemeSchema)
		.min(COMPANY_SUMMARY_LIMITS.minThemes)
		.max(COMPANY_SUMMARY_LIMITS.maxThemes),
});
export type CompanySummary = z.infer<typeof companySummarySchema>;

const factSchema = z.string().trim().min(1).max(COMPANY_SUMMARY_LIMITS.maxFactChars);

/**
 * The stored facts a `company-summary` claim gives the agent, so the
 * summary rests on them rather than on the model's memory alone: the
 * directory names and listing, a Japanese stock's J-Quants sectors and the
 * start of a US stock's annual-report business section. Null when not stored.
 */
export const companySummaryFactsSchema = z.strictObject({
	name: factSchema.nullable(),
	localName: factSchema.nullable(),
	listing: factSchema.nullable(),
	sector: factSchema.nullable(),
	businessExcerpt: z
		.string()
		.trim()
		.min(1)
		.max(COMPANY_SUMMARY_LIMITS.maxBusinessExcerptChars)
		.nullable(),
});
export type CompanySummaryFacts = z.infer<typeof companySummaryFactsSchema>;

/** A stored summary as the Stocks API returns it (`summary`): who wrote it and when. */
export const companySummaryViewSchema = companySummarySchema.extend({
	agentId: agentIdSchema,
	/** The model chosen in Settings; null when the backend's default was used. */
	model: z.string().min(1).max(100).nullable(),
	generatedAt: isoDateTimeSchema,
});
export type CompanySummaryView = z.infer<typeof companySummaryViewSchema>;
