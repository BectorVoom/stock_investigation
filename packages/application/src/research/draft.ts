import { z } from "zod";

/**
 * Shapes the model is ASKED to return. They are deliberately forgiving about
 * length (over-long text is truncated rather than failing the whole run) and
 * strict about structure. Nothing here is trusted: every id, quote and number
 * is checked against retrieved evidence afterwards.
 */
const text = (max: number) =>
	z
		.string()
		.transform((value) => value.trim().slice(0, max))
		.pipe(z.string().min(1));
const textList = (maxItems: number, maxLength: number) =>
	z.array(text(maxLength)).transform((items) => items.slice(0, maxItems));
const idList = z.array(z.string().max(120)).transform((items) => items.slice(0, 12));
const quote = z.string().transform((value) => value.trim().slice(0, 400));

/** Tool calls one planning reply may request, however they arrive (JSON or tool requests). */
export const MAX_TOOL_CALLS_PER_REPLY = 8;

export const planSchema = z.object({
	toolCalls: z
		.array(z.object({ toolId: z.string().max(80), args: z.unknown() }))
		.transform((calls) => calls.slice(0, MAX_TOOL_CALLS_PER_REPLY))
		.default([]),
	done: z.boolean().default(false),
});
export type Plan = z.infer<typeof planSchema>;

const draftCaseSchema = z.object({
	targetValue: z.number().finite(),
	assumptions: textList(8, 400),
});

export const draftScenarioSchema = z.object({
	productOrService: text(300),
	quantityKind: z.enum(["unit-demand", "revenue", "price"]),
	unit: text(80),
	baseYear: z.number().int(),
	targetYear: z.number().int(),
	baselineValue: z.number().finite().nullable().default(null),
	baselineEvidenceId: z.string().max(120).nullable().default(null),
	/** Verbatim passage of that evidence stating the baseline value. */
	baselineQuote: quote.nullable().default(null),
	bear: draftCaseSchema,
	base: draftCaseSchema,
	bull: draftCaseSchema,
	drivers: textList(8, 400),
	barriers: textList(8, 400).default([]),
	falsifiers: textList(8, 400),
	methodology: text(2000),
	supportingEvidenceIds: idList.default([]),
	contraryEvidenceIds: idList.default([]),
});
export type DraftScenario = z.infer<typeof draftScenarioSchema>;

export const draftSupplierSchema = z.object({
	issuerName: text(300),
	ticker: z.string().trim().toUpperCase(),
	exchange: z.string().trim(),
	country: z.enum(["JP", "US"]),
	productsOrServices: textList(8, 300),
	businessExposure: text(1000),
	/** Index into `scenarios`, or null when the supplier is not tied to one. */
	scenarioIndex: z.number().int().nonnegative().nullable().default(null),
	/** Passages that name the issuer and establish the supplier relationship. */
	evidence: z
		.array(z.object({ evidenceId: z.string().max(120), quote }))
		.transform((links) => links.slice(0, 6)),
});
export type DraftSupplier = z.infer<typeof draftSupplierSchema>;

const pct = z.number().finite().nullable().default(null);

export const draftPricingPowerSchema = z.object({
	ticker: z.string().trim().toUpperCase(),
	exchange: z.string().trim(),
	fiscalYear: z.number().int(),
	fiscalPeriod: z.enum(["FY", "Q1", "Q2", "Q3", "Q4", "TTM"]),
	periodStart: z.iso.date(),
	periodEnd: z.iso.date(),
	revenueGrowthPct: pct,
	priceRealizationPct: pct,
	volumeGrowthPct: pct,
	mixEffectPct: pct,
	fxEffectPct: pct,
	inputCostChangePct: pct,
	grossMarginChangeBps: pct,
	operatingMarginChangeBps: pct,
	managementCommentaryEvidenceIds: idList.default([]),
	evidenceIds: idList,
});
export type DraftPricingPower = z.infer<typeof draftPricingPowerSchema>;

export const analysisDraftSchema = z.object({
	// Required, with no default: a reply that is not an analysis at all (a plan, a refusal
	// wrapped in JSON) must fail validation rather than pass as "an analysis with nothing in it".
	claims: z
		.array(
			z.object({
				text: text(1000),
				claimType: z.enum(["observation", "inference", "hypothesis", "forecast"]),
				evidence: z
					.array(
						z.object({
							evidenceId: z.string().max(120),
							relation: z.enum(["supports", "contradicts", "context"]),
							quote: quote.nullable().default(null),
						}),
					)
					.transform((links) => links.slice(0, 12))
					.default([]),
			}),
		)
		.transform((claims) => claims.slice(0, 40)),
	scenarios: z
		.array(z.unknown())
		.transform((items) => items.slice(0, 8))
		.default([]),
	suppliers: z
		.array(z.unknown())
		.transform((items) => items.slice(0, 20))
		.default([]),
	pricingPower: z
		.array(z.unknown())
		.transform((items) => items.slice(0, 12))
		.default([]),
	/** Optional display instructions; each is validated against the UI protocol later. */
	uiOperations: z
		.array(z.unknown())
		.transform((items) => items.slice(0, 12))
		.default([]),
});
export type AnalysisDraft = z.infer<typeof analysisDraftSchema>;

export const verdictsSchema = z.object({
	verdicts: z
		.array(
			z.object({
				claimIndex: z.number().int().nonnegative(),
				verdict: z.enum(["supported", "unsupported", "contradicted"]),
			}),
		)
		.default([]),
});
