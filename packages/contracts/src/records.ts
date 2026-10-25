import type {
	ClaimIssue,
	DemandScenarioInput,
	PositionFigures,
	PricingPowerAssessment,
	PricingPowerInputs,
	ReportingPeriod,
} from "@research/domain";
import { z } from "zod";
import {
	currencySchema,
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	longTextSchema,
	marketSchema,
	shortTextSchema,
	upstreamStatusSchema,
} from "./primitives.ts";

/* ---------- News ---------- */

export const licensePolicySchema = z.enum(["headline-and-link-only", "short-excerpt-permitted"]);
export const sourceTypeSchema = z.enum(["rss", "atom", "api", "html"]);
export const trustClassificationSchema = z.enum([
	"official",
	"established-media",
	"trade-press",
	"unclassified",
]);
export const feedStatusSchema = z.enum(["active", "failing", "paused"]);

export const newsSourceSchema = z.strictObject({
	sourceId: idSchema,
	canonicalUrl: httpsUrlSchema,
	sourceType: sourceTypeSchema,
	title: shortTextSchema,
	publisher: shortTextSchema,
	licensePolicy: licensePolicySchema,
	trustClassification: trustClassificationSchema,
	feedStatus: feedStatusSchema,
	lastFetchedAt: isoDateTimeSchema.nullable(),
	lastErrorCode: z.string().max(100).nullable(),
	/** The status the feed host answered the last failed fetch with, unchanged; null otherwise. */
	lastErrorUpstreamStatus: upstreamStatusSchema.nullable(),
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
});
export type NewsSource = z.infer<typeof newsSourceSchema>;

export const articleSchema = z.strictObject({
	articleId: idSchema,
	sourceId: idSchema,
	canonicalUrl: httpsUrlSchema,
	publisher: shortTextSchema,
	title: z.string().min(1).max(300),
	publishedAt: isoDateTimeSchema.nullable(),
	retrievedAt: isoDateTimeSchema,
	contentFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
	/** Present only when the source's license policy permits a short excerpt. */
	excerpt: z.string().max(500).nullable(),
});
export type Article = z.infer<typeof articleSchema>;

/* ---------- Evidence graph ---------- */

export const sourceClassSchema = z.enum([
	"news",
	"regulatory-filing",
	"official-statistics",
	"company-disclosure",
	"market-data",
	"other",
]);

export const evidenceSchema = z.strictObject({
	evidenceId: idSchema,
	sourceUrl: httpsUrlSchema,
	title: z.string().min(1).max(300),
	publisher: shortTextSchema,
	publishedAt: isoDateTimeSchema.nullable(),
	retrievedAt: isoDateTimeSchema,
	/** The date the content describes (as-of), when it differs from publication. */
	effectiveAt: isoDateTimeSchema.nullable(),
	excerpt: z.string().max(500).nullable(),
	/** SHA-256 of the retrieved content, so later re-fetches can detect drift. */
	checksum: z.string().regex(/^[0-9a-f]{64}$/),
	sourceClass: sourceClassSchema,
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const claimTypeSchema = z.enum(["observation", "inference", "hypothesis", "forecast"]);
export const evidenceRelationSchema = z.enum(["supports", "contradicts", "context"]);
export const claimStatusSchema = z.enum(["supported", "unsupported", "conflicting"]);

export const evidenceLinkSchema = z.strictObject({
	evidenceId: idSchema,
	relation: evidenceRelationSchema,
	quote: z.string().max(400).nullable(),
});

export const claimIssueSchema = z.discriminatedUnion("code", [
	z.strictObject({ code: z.literal("UNKNOWN_EVIDENCE"), evidenceId: z.string().max(200) }),
	z.strictObject({ code: z.literal("QUOTE_NOT_FOUND"), evidenceId: z.string().max(200) }),
	z.strictObject({ code: z.literal("QUOTE_TOO_SHORT"), evidenceId: z.string().max(200) }),
	z.strictObject({ code: z.literal("MISSING_QUOTE"), evidenceId: z.string().max(200) }),
	z.strictObject({ code: z.literal("NUMBER_NOT_IN_EVIDENCE"), numberText: z.string().max(40) }),
	z.strictObject({ code: z.literal("NO_SUPPORTING_EVIDENCE") }),
	z.strictObject({ code: z.literal("NOT_INDEPENDENTLY_VERIFIED") }),
]) satisfies z.ZodType<ClaimIssue>;

export const claimSchema = z.strictObject({
	claimId: idSchema,
	text: z.string().min(1).max(1000),
	claimType: claimTypeSchema,
	status: claimStatusSchema,
	links: z.array(evidenceLinkSchema).max(12),
	issues: z.array(claimIssueSchema).max(24),
});
export type Claim = z.infer<typeof claimSchema>;

/* ---------- Demand scenarios ---------- */

const assumptionListSchema = z.array(z.string().min(1).max(400)).max(12);
const scenarioCaseSchema = z.strictObject({
	targetValue: z.number().finite(),
	assumptions: assumptionListSchema,
});

const demandScenarioInputSchema = z.strictObject({
	productOrService: shortTextSchema,
	quantityKind: z.enum(["unit-demand", "revenue", "price"]),
	unit: z.string().min(1).max(80),
	baseYear: z.number().int().min(1990).max(2100),
	targetYear: z.number().int().min(1990).max(2100),
	baselineValue: z.number().finite().nullable(),
	bear: scenarioCaseSchema,
	base: scenarioCaseSchema,
	bull: scenarioCaseSchema,
	drivers: assumptionListSchema,
	barriers: assumptionListSchema,
	falsifiers: assumptionListSchema,
	methodology: longTextSchema,
}) satisfies z.ZodType<DemandScenarioInput>;

export const demandScenarioSchema = demandScenarioInputSchema.extend({
	scenarioId: idSchema,
	/** Derived by the domain from baseline and targets; null when no sourced baseline exists. */
	derivedCagr: z.strictObject({
		bear: z.number().finite().nullable(),
		base: z.number().finite().nullable(),
		bull: z.number().finite().nullable(),
	}),
	baselineEvidenceId: idSchema.nullable(),
	/** The passage stating the baseline, when the source's license permits keeping it. */
	baselineQuote: z.string().max(400).nullable(),
	supportingEvidenceIds: z.array(idSchema).max(24),
	contraryEvidenceIds: z.array(idSchema).max(24),
});
export type DemandScenario = z.infer<typeof demandScenarioSchema>;

/* ---------- Securities and suppliers ---------- */

export const EXCHANGES_BY_COUNTRY = {
	JP: ["TSE", "NSE", "FSE", "SSE"],
	US: ["NYSE", "NASDAQ", "NYSE American", "NYSE Arca", "Cboe BZX"],
} as const;

export const securitySchema = z
	.strictObject({
		securityId: idSchema,
		country: marketSchema,
		ticker: z.string().regex(/^[A-Z0-9.-]{1,12}$/),
		exchange: z.string().min(1).max(20),
		issuerName: shortTextSchema,
		issuerIdentifier: z
			.strictObject({
				scheme: z.enum(["CIK", "EDINET", "LEI", "JCN", "ISIN"]),
				value: z.string().min(1).max(40),
			})
			.nullable(),
		listingCurrency: currencySchema,
		reportingCurrency: currencySchema.nullable(),
		/**
		 * "source-verified": ticker and exchange come from an official directory a tool
		 * retrieved. "unverified": proposed by a model and only format-checked.
		 */
		listingVerification: z.enum(["source-verified", "unverified"]),
		formerTickers: z
			.array(
				z.strictObject({
					ticker: z.string().regex(/^[A-Z0-9.-]{1,12}$/),
					exchange: z.string().min(1).max(20),
					validUntil: isoDateSchema,
				}),
			)
			.max(10),
	})
	.refine(
		(security) =>
			(EXCHANGES_BY_COUNTRY[security.country] as readonly string[]).includes(security.exchange),
		{ message: "exchange is not a known venue for the security's country", path: ["exchange"] },
	);
export type Security = z.infer<typeof securitySchema>;

export const supplierLinkSchema = z.strictObject({
	supplierLinkId: idSchema,
	scenarioId: idSchema.nullable(),
	securityId: idSchema,
	productsOrServices: z.array(shortTextSchema).min(1).max(12),
	businessExposure: z.string().min(1).max(1000),
	/** Evidence for the supplier relationship itself (FR-005); at least one is mandatory. */
	evidenceIds: z.array(idSchema).min(1).max(12),
	/** A cited passage naming the issuer, when the source's license permits keeping it. */
	relationshipQuote: z.string().max(400).nullable(),
});
export type SupplierLink = z.infer<typeof supplierLinkSchema>;

/* ---------- Financial observations ---------- */

export const reportingPeriodSchema = z.strictObject({
	fiscalYear: z.number().int().min(1990).max(2100),
	fiscalPeriod: z.enum(["FY", "Q1", "Q2", "Q3", "Q4", "TTM"]),
	periodStart: isoDateSchema,
	periodEnd: isoDateSchema,
}) satisfies z.ZodType<ReportingPeriod>;

export const financialMetricCodeSchema = z.enum([
	"trailing-per",
	"forward-per",
	"net-profit-margin",
	"revenue",
	"net-income",
	"eps-diluted",
	"share-price",
]);

/**
 * One immutable, dated measurement. `value` and `unavailableReason` are
 * mutually exclusive: an unavailable metric is null plus a reason (DATA-011),
 * and an available one must cite its source (DATA-001).
 */
export const financialObservationSchema = z
	.strictObject({
		observationId: idSchema,
		securityId: idSchema,
		metricCode: financialMetricCodeSchema,
		value: z.number().finite().nullable(),
		unavailableReason: z.string().min(1).max(300).nullable(),
		unit: z.enum(["ratio", "currency", "currency-per-share"]),
		currency: currencySchema.nullable(),
		accountingStandard: z.enum(["US-GAAP", "IFRS", "JGAAP", "OTHER"]).nullable(),
		period: reportingPeriodSchema.nullable(),
		actualOrEstimate: z.enum(["actual", "estimate"]),
		/** Timestamp of the market price used, for price-derived metrics. */
		marketDataAsOf: isoDateTimeSchema.nullable(),
		formula: z.string().max(200).nullable(),
		sourceEvidenceId: idSchema.nullable(),
	})
	.refine((o) => (o.value === null) !== (o.unavailableReason === null), {
		message: "exactly one of value / unavailableReason must be set",
		path: ["unavailableReason"],
	})
	.refine((o) => o.value === null || o.sourceEvidenceId !== null, {
		message: "an available observation must cite source evidence",
		path: ["sourceEvidenceId"],
	})
	.refine((o) => o.value === null || o.unit === "ratio" || o.currency !== null, {
		message: "a currency-denominated observation must state its currency",
		path: ["currency"],
	})
	// Hard gate 6: a displayed number always has an as-of date — its accounting period or its price time.
	.refine((o) => o.value === null || o.period !== null || o.marketDataAsOf !== null, {
		message: "an available observation must carry a reporting period or a market-data timestamp",
		path: ["period"],
	})
	// Section 8.2 / DATA-005: an available metric carries everything its definition needs.
	.superRefine((o, context) => {
		if (o.value === null) return;
		const must = (holds: boolean, path: string, message: string) => {
			if (!holds) context.addIssue({ code: "custom", message, path: [path] });
		};
		const isPer = o.metricCode === "trailing-per" || o.metricCode === "forward-per";
		if (isPer) {
			must(o.value > 0, "value", "PER is only meaningful for positive EPS; otherwise report N/A");
			must(o.unit === "ratio", "unit", "PER is a ratio");
			must(o.period !== null, "period", "PER needs the earnings period");
			must(o.marketDataAsOf !== null, "marketDataAsOf", "PER needs the price timestamp");
			must(o.formula !== null, "formula", "PER needs its formula");
			must(
				o.actualOrEstimate === (o.metricCode === "trailing-per" ? "actual" : "estimate"),
				"actualOrEstimate",
				"trailing PER uses reported EPS; forward PER uses estimated EPS",
			);
		}
		if (o.metricCode === "net-profit-margin") {
			must(o.unit === "ratio", "unit", "net profit margin is a ratio");
			must(o.period !== null, "period", "net profit margin needs its reporting period");
			must(o.accountingStandard !== null, "accountingStandard", "state the accounting basis");
			must(o.formula !== null, "formula", "net profit margin needs its formula");
		}
		if (o.metricCode === "revenue" || o.metricCode === "net-income") {
			must(o.unit === "currency", "unit", "an income figure is a currency amount");
			must(o.period !== null, "period", "an income figure needs its reporting period");
			must(o.accountingStandard !== null, "accountingStandard", "state the accounting basis");
		}
		if (o.metricCode === "eps-diluted") {
			must(o.unit === "currency-per-share", "unit", "EPS is a per-share amount");
			must(o.period !== null, "period", "EPS needs its reporting period");
		}
		if (o.metricCode === "share-price") {
			must(o.unit === "currency-per-share", "unit", "a share price is a per-share amount");
			must(o.marketDataAsOf !== null, "marketDataAsOf", "a share price needs its timestamp");
		}
	});
export type FinancialObservation = z.infer<typeof financialObservationSchema>;

const sharesSchema = z.number().finite().nonnegative();

export const positionFiguresSchema = z.discriminatedUnion("metric", [
	z.strictObject({
		jurisdiction: z.literal("JP"),
		metric: z.literal("jp-margin-balance"),
		marginBuyBalanceShares: sharesSchema,
		marginSellBalanceShares: sharesSchema,
	}),
	z.strictObject({
		jurisdiction: z.literal("US"),
		metric: z.literal("us-short-interest"),
		reportedShortInterestShares: sharesSchema,
		averageDailyVolumeShares: sharesSchema.nullable(),
	}),
]) satisfies z.ZodType<PositionFigures>;

export const positionObservationSchema = z
	.strictObject({
		observationId: idSchema,
		securityId: idSchema,
		jurisdiction: marketSchema,
		metric: z.enum(["jp-margin-balance", "us-short-interest"]),
		figures: positionFiguresSchema.nullable(),
		unavailableReason: z.string().min(1).max(300).nullable(),
		/** The reporting source's own definition of the metric. */
		metricDefinition: z.string().min(1).max(500),
		unit: z.literal("shares"),
		asOfDate: isoDateSchema.nullable(),
		disseminatedAt: isoDateTimeSchema.nullable(),
		sourceEvidenceId: idSchema.nullable(),
	})
	.refine((o) => (o.figures === null) !== (o.unavailableReason === null), {
		message: "exactly one of figures / unavailableReason must be set",
		path: ["unavailableReason"],
	})
	.refine((o) => o.figures === null || (o.sourceEvidenceId !== null && o.asOfDate !== null), {
		message: "available figures must cite source evidence and an as-of date",
		path: ["figures"],
	})
	.refine(
		(o) =>
			(o.jurisdiction === "JP") === (o.metric === "jp-margin-balance") &&
			(o.figures === null || o.figures.metric === o.metric),
		{ message: "metric does not belong to this jurisdiction", path: ["metric"] },
	);
export type PositionObservation = z.infer<typeof positionObservationSchema>;

export const reportedPositionChangeSchema = z.enum([
	"newly-reported-holding",
	"increase-in-reported-position",
	"decrease-in-reported-position",
	"no-longer-reported",
	"unchanged-reported-position",
	"not-reported",
]);

export const investorFilingSchema = z.strictObject({
	filingId: idSchema,
	investorName: shortTextSchema,
	reportingEntityIdentifier: z.strictObject({
		scheme: z.enum(["CIK", "EDINET"]),
		value: z.string().min(1).max(40),
	}),
	form: z.string().min(1).max(20),
	/** Quarter end the filing reports on; holdings are as of this date, not trade dates. */
	reportPeriodEnd: isoDateSchema,
	filedAt: isoDateSchema,
	filingUrl: httpsUrlSchema,
	holdings: z
		.array(
			z.strictObject({
				issuerName: shortTextSchema,
				cusip: z.string().max(12).nullable(),
				securityId: idSchema.nullable(),
				reportedShares: sharesSchema,
				reportedValueUsd: z.number().finite().nonnegative().nullable(),
				/** Versus the same filer's previous quarter; null when no prior filing was compared. */
				changeFromPriorFiling: reportedPositionChangeSchema.nullable(),
			}),
		)
		.max(60),
	sourceEvidenceId: idSchema,
});
export type InvestorFiling = z.infer<typeof investorFilingSchema>;

const pctSchema = z.number().finite().nullable();

const pricingPowerInputsSchema = z.strictObject({
	revenueGrowthPct: pctSchema,
	priceRealizationPct: pctSchema,
	volumeGrowthPct: pctSchema,
	mixEffectPct: pctSchema,
	fxEffectPct: pctSchema,
	inputCostChangePct: pctSchema,
	grossMarginChangeBps: pctSchema,
	operatingMarginChangeBps: pctSchema,
	managementCommentaryEvidenceIds: z.array(idSchema).max(12),
}) satisfies z.ZodType<PricingPowerInputs>;

const pricingPowerAssessmentSchema = z.strictObject({
	classification: z.enum([
		"corroborated-price-realization",
		"price-realization-uncorroborated",
		"price-increase-offset-by-volume-loss",
		"price-increase-absorbed-by-costs",
		"no-price-realization",
		"margin-improvement-without-price-evidence",
		"insufficient-data",
	]),
	missingInputs: z.array(
		z.enum([
			"priceRealizationPct",
			"volumeGrowthPct",
			"grossMarginChangeBps",
			"managementCommentary",
		]),
	),
	unexplainedRevenueResidualPct: z.number().finite().nullable(),
}) satisfies z.ZodType<PricingPowerAssessment>;

export const pricingPowerRecordSchema = z.strictObject({
	pricingPowerId: idSchema,
	securityId: idSchema,
	period: reportingPeriodSchema,
	inputs: pricingPowerInputsSchema,
	/** Computed by the domain from `inputs`; never supplied by a model. */
	assessment: pricingPowerAssessmentSchema,
	evidenceIds: z.array(idSchema).min(1).max(12),
});
export type PricingPowerRecord = z.infer<typeof pricingPowerRecordSchema>;

/* ---------- Datasets ---------- */

/**
 * A table cell. A number either came from a source (`sourceId` + `asOf`) or
 * declares its `basis`; a missing value is null with a `reason` (hard gate 6).
 */
export const datasetCellSchema = z
	.strictObject({
		v: z.union([z.number().finite(), z.string().max(600), z.null()]),
		reason: z.string().min(1).max(300).optional(),
		sourceId: idSchema.optional(),
		// Plain dates are by far the common case; trying the cheap pattern first roughly halves
		// the cost of validating a large table (measured in scripts/bench.ts).
		asOf: z.union([isoDateSchema, isoDateTimeSchema]).optional(),
		/**
		 * For a number that is not a sourced measurement: a scenario "assumption", or a
		 * figure "derived" by the application from other cells. Shown next to the value.
		 */
		basis: z.enum(["assumption", "derived"]).optional(),
	})
	// One pass over both cell rules. Hard gate 6: an empty cell says why it is empty, and a
	// sourced number is displayed with its as-of date.
	.superRefine((cell, context) => {
		if (cell.v === null && cell.reason === undefined) {
			context.addIssue({
				code: "custom",
				message: "an empty cell must state why the value is unavailable",
				path: ["reason"],
			});
		}
		if (typeof cell.v !== "number") return;
		if (cell.sourceId !== undefined && cell.asOf === undefined) {
			context.addIssue({
				code: "custom",
				message: "a sourced number must carry an as-of date",
				path: ["asOf"],
			});
		}
		// No bare numbers: every figure either traces to a source or says what else it is.
		if (cell.sourceId === undefined && cell.basis === undefined) {
			context.addIssue({
				code: "custom",
				message: "a number must cite a source or declare itself an assumption or derived value",
				path: ["basis"],
			});
		}
	});
export type DatasetCell = z.infer<typeof datasetCellSchema>;

/**
 * Bounds of a dataset column, named so code that builds a dataset (the
 * Notebook `chart` widget's rebuild, `chartWidgetDataset.ts`) uses the same
 * numbers the schema below enforces.
 */
export const DATASET_LIMITS = {
	maxColumnLabelChars: 80,
	maxColumnUnitChars: 40,
} as const;

export const datasetColumnSchema = z.strictObject({
	key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
	label: z.string().min(1).max(DATASET_LIMITS.maxColumnLabelChars),
	kind: z.enum(["text", "number", "date"]),
	/** Mandatory for number columns so no financial figure is rendered unit-less (UI-007). */
	unit: z.string().min(1).max(DATASET_LIMITS.maxColumnUnitChars).optional(),
});

export const datasetSchema = z
	.strictObject({
		datasetId: idSchema,
		title: shortTextSchema,
		columns: z.array(datasetColumnSchema).min(1).max(16),
		rows: z.array(z.record(z.string(), datasetCellSchema)).max(300),
		createdAt: isoDateTimeSchema,
	})
	.refine((d) => d.columns.every((c) => c.kind !== "number" || c.unit !== undefined), {
		message: "number columns must declare a unit",
		path: ["columns"],
	})
	.refine(
		(d) => {
			const keys = new Set(d.columns.map((c) => c.key));
			return (
				keys.size === d.columns.length &&
				d.rows.every((r) => Object.keys(r).every((k) => keys.has(k)))
			);
		},
		{ message: "rows may only use declared, unique column keys", path: ["rows"] },
	)
	// A cell's value has the type its column declares. Without this a figure could travel as
	// text in a number column and slip past the rule that sourced numbers carry an as-of date.
	.refine(
		(d) =>
			d.rows.every((row) =>
				d.columns.every((column) => {
					const value = row[column.key]?.v;
					if (value === undefined || value === null) return true;
					return column.kind === "number" ? typeof value === "number" : typeof value === "string";
				}),
			),
		{ message: "cell values must match their column kind", path: ["rows"] },
	);
export type Dataset = z.infer<typeof datasetSchema>;
