import { z } from "zod";
import { EQUITY_VENUE_MARKETS } from "./equityVenues.ts";
import {
	currencySchema,
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	marketSchema,
} from "./primitives.ts";

export const EQUITY_LIMITS = {
	maxRecords: 2_000,
	maxImportBytes: 750_000,
	maxPageSize: 200,
} as const;
export const equityInstantSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	.pipe(z.iso.datetime());
/** Canonical base-unit decimals: 100 significant digits, at most 30 fractional digits. */
export const equityDecimalSchema = z
	.string()
	.max(132)
	.regex(/^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/)
	.refine(
		(value) =>
			value !== "-0" &&
			(value.split(".")[1]?.length ?? 0) <= 30 &&
			value.replace(/[-.]/g, "").replace(/^0+/, "").length <= 100,
	);
const text = z.string().trim().min(1).max(300);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const country = z.string().regex(/^[A-Z]{2}$/);
export const equityStandardSchema = z.enum(["US-GAAP", "IFRS", "JGAAP", "OTHER"]);
export const equityScopeSchema = z.enum(["consolidated", "separate"]);
export const equityUnitSchema = z.enum(["currency", "currency-per-share", "shares", "ratio"]);
export const equityPeriodSchema = z
	.object({
		periodKind: z.enum(["annual", "half-year", "quarter", "year-to-date", "transition", "instant"]),
		periodStart: isoDateSchema.nullable(),
		periodEnd: isoDateSchema,
	})
	.refine(
		(p) =>
			p.periodKind === "instant"
				? p.periodStart === null
				: p.periodStart !== null && p.periodStart <= p.periodEnd,
		{ message: "period dates must match the period kind" },
	);

export const equityIssuerSchema = z.strictObject({
	issuerId: idSchema,
	legalName: text,
	localName: text.nullable(),
	domicileCountry: country,
});
export const equityIdentifierSchema = z.strictObject({
	identifierId: idSchema,
	issuerId: idSchema,
	scheme: z.enum(["cik", "edinet", "lei", "jp-corporate-number"]),
	value: z.string().min(1).max(64),
	sourceDocumentId: idSchema,
});
export const equitySecuritySchema = z.strictObject({
	securityId: idSchema,
	issuerId: idSchema,
	instrumentType: z.enum(["common", "ordinary", "adr", "preferred", "reit"]),
	shareClass: text,
	isin: z
		.string()
		.regex(/^[A-Z]{2}[A-Z0-9]{9}\d$/)
		.nullable(),
});
export const equityListingSchema = z
	.strictObject({
		listingId: idSchema,
		securityId: idSchema,
		market: marketSchema,
		venueMic: z.string().regex(/^[A-Z0-9]{4}$/),
		tradingCurrency: currencySchema,
		exchangeTimezone: z.string().min(1).max(80),
		symbol: z.string().min(1).max(32),
		listedOn: isoDateSchema.nullable(),
		delistedOn: isoDateSchema.nullable(),
		sourceDocumentId: idSchema,
	})
	.refine((listing) => EQUITY_VENUE_MARKETS[listing.venueMic] === listing.market, {
		message: "venue is unsupported or belongs to a different market",
	})
	.refine((l) => l.listedOn === null || l.delistedOn === null || l.listedOn <= l.delistedOn, {
		message: "delisting precedes listing",
	});
export const equitySourceSchema = z.strictObject({
	sourceId: idSchema,
	publisher: text,
	sourceKind: z.enum(["sec", "edinet", "tdnet", "issuer-ir", "market-data", "other"]),
	termsUrl: httpsUrlSchema,
	rights: z.enum(["private-research", "redistributable"]),
	rightsPolicyVersion: text,
});
/** Source-supplied update instant, canonical UTC milliseconds; absent in older imports. */
export const materialsSourceUpdatedAtSchema = z
	.string()
	.length(24)
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	.pipe(z.iso.datetime());
export const equityDocumentSchema = z
	.strictObject({
		sourceDocumentId: idSchema,
		sourceId: idSchema,
		externalId: z.string().min(1).max(200),
		url: httpsUrlSchema.refine(
			(url) => {
				const parsed = new URL(url);
				return (
					parsed.username === "" &&
					parsed.password === "" &&
					parsed.search === "" &&
					parsed.hash === ""
				);
			},
			{ message: "source URL must not contain credentials, query parameters or fragments" },
		),
		title: text,
		publishedAt: equityInstantSchema.nullable(),
		materialsSourceUpdatedAt: materialsSourceUpdatedAtSchema
			.nullable()
			.optional()
			.transform((value) => value ?? undefined),
		retrievedAt: equityInstantSchema,
		contentSha256: sha256.nullable(),
	})
	.refine(
		(document) =>
			document.materialsSourceUpdatedAt === undefined ||
			document.materialsSourceUpdatedAt <= document.retrievedAt,
		{ message: "source update timestamp must not follow retrieval" },
	);
export const equityFilingSchema = z
	.strictObject({
		filingId: idSchema,
		issuerId: idSchema,
		sourceDocumentId: idSchema,
		externalFilingId: z.string().min(1).max(100),
		formCode: z.string().min(1).max(40),
		disclosureKind: z.enum(["statutory", "earnings-release", "guidance", "other"]),
		periodEnd: isoDateSchema,
		publicAvailableAt: equityInstantSchema.nullable(),
		availabilityPrecision: z.enum(["instant", "conservative-date-bound", "unknown"]),
		amendmentOfFilingId: idSchema.nullable(),
	})
	.refine((f) => (f.publicAvailableAt === null) === (f.availabilityPrecision === "unknown"), {
		message: "availability must state its precision",
	});
export const equityStatementSchema = z
	.strictObject({
		statementId: idSchema,
		filingId: idSchema,
		statementKind: z.enum(["income", "balance-sheet", "cash-flow", "equity", "notes"]),
		accountingStandard: equityStandardSchema,
		scope: equityScopeSchema,
		reportingCurrency: currencySchema,
		fiscalYearLabel: z.string().min(1).max(40),
		...equityPeriodSchema.shape,
	})
	.refine((p) => equityPeriodSchema.safeParse(p).success);
export const equityMetricSchema = z.strictObject({
	metricDefinitionId: idSchema,
	metricCode: z
		.string()
		.regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
		.max(80),
	version: z.number().int().min(1),
	label: text,
	unit: equityUnitSchema,
	definition: z.string().min(1).max(2000),
});
export const equityDimensionsSchema = z
	.record(z.string().min(1).max(300), z.string().max(2000))
	.refine((value) => Object.keys(value).length <= 32)
	.transform((value) =>
		Object.fromEntries(
			Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		),
	);
export const equityFactSchema = z
	.strictObject({
		factId: idSchema,
		statementId: idSchema,
		metricDefinitionId: idSchema,
		sourceConcept: z.string().min(1).max(500),
		sourceLocator: z.string().min(1).max(500),
		dimensions: equityDimensionsSchema,
		valueDecimal: equityDecimalSchema.nullable(),
		unavailableReason: z.string().min(1).max(300).nullable(),
		reportedDecimals: z.number().int().min(-100).max(100).nullable(),
		shareBasis: z.string().min(1).max(300).nullable(),
		actualOrEstimate: z.enum(["actual", "estimate"]),
	})
	.refine((f) => (f.valueDecimal === null) !== (f.unavailableReason === null), {
		message: "exactly one of value and unavailable reason is required",
	});
export const equityPriceSchema = z
	.strictObject({
		priceBarId: idSchema,
		listingId: idSchema,
		sourceDocumentId: idSchema,
		tradingOn: isoDateSchema,
		currency: currencySchema,
		openDecimal: equityDecimalSchema,
		highDecimal: equityDecimalSchema,
		lowDecimal: equityDecimalSchema,
		closeDecimal: equityDecimalSchema,
		volumeDecimal: equityDecimalSchema.nullable(),
		priceBasis: z.enum(["unadjusted", "provider-split-adjusted", "provider-total-return"]),
		adjustmentDescription: text.nullable(),
		supersedesPriceBarId: idSchema.nullable(),
	})
	.refine((p) => p.priceBasis === "unadjusted" || p.adjustmentDescription !== null);
export const equityActionSchema = z.strictObject({
	actionId: idSchema,
	securityId: idSchema,
	sourceDocumentId: idSchema,
	actionType: z.enum([
		"split",
		"reverse-split",
		"cash-dividend",
		"stock-dividend",
		"spinoff",
		"merger",
		"rights-issue",
		"cancellation",
	]),
	effectiveOn: isoDateSchema,
	exOn: isoDateSchema.nullable(),
	payableOn: isoDateSchema.nullable(),
	cashDecimal: equityDecimalSchema.nullable(),
	currency: currencySchema.nullable(),
	ratioNumerator: equityDecimalSchema.nullable(),
	ratioDenominator: equityDecimalSchema.nullable(),
	description: text,
	supersedesActionId: idSchema.nullable(),
});
export const equityFxSchema = z.strictObject({
	fxId: idSchema,
	sourceDocumentId: idSchema,
	baseCurrency: currencySchema,
	quoteCurrency: currencySchema,
	rateDecimal: equityDecimalSchema,
	observedAt: equityInstantSchema,
	fixingKind: text,
});
export const equityGuidanceSchema = z
	.strictObject({
		guidanceId: idSchema,
		issuerId: idSchema,
		sourceDocumentId: idSchema,
		metricDefinitionId: idSchema,
		targetStart: isoDateSchema,
		targetEnd: isoDateSchema,
		scope: equityScopeSchema,
		accountingStandard: equityStandardSchema,
		currency: currencySchema.nullable(),
		lowDecimal: equityDecimalSchema.nullable(),
		baseDecimal: equityDecimalSchema.nullable(),
		highDecimal: equityDecimalSchema.nullable(),
		status: z.enum(["forecast", "revision", "withdrawal"]),
		supersedesGuidanceId: idSchema.nullable(),
	})
	.refine(
		(g) =>
			g.targetStart <= g.targetEnd &&
			(g.status === "withdrawal"
				? g.lowDecimal === null && g.baseDecimal === null && g.highDecimal === null
				: g.lowDecimal !== null || g.baseDecimal !== null || g.highDecimal !== null),
	);

export const equityImportSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		coverageNote: z.string().min(1).max(1000),
		issuers: z.array(equityIssuerSchema).max(100).default([]),
		identifiers: z.array(equityIdentifierSchema).max(100).default([]),
		securities: z.array(equitySecuritySchema).max(100).default([]),
		listings: z.array(equityListingSchema).max(100).default([]),
		sources: z.array(equitySourceSchema).max(50).default([]),
		documents: z.array(equityDocumentSchema).max(100).default([]),
		filings: z.array(equityFilingSchema).max(100).default([]),
		statements: z.array(equityStatementSchema).max(200).default([]),
		metrics: z.array(equityMetricSchema).max(100).default([]),
		facts: z.array(equityFactSchema).max(1000).default([]),
		prices: z.array(equityPriceSchema).max(1000).default([]),
		actions: z.array(equityActionSchema).max(200).default([]),
		fx: z.array(equityFxSchema).max(500).default([]),
		guidance: z.array(equityGuidanceSchema).max(200).default([]),
	})
	.refine(
		(bundle) => {
			const count = Object.values(bundle).reduce<number>(
				(total, value) => total + (Array.isArray(value) ? value.length : 0),
				0,
			);
			return count > 0 && count <= EQUITY_LIMITS.maxRecords;
		},
		{ message: "import record count is outside the limit" },
	);
export type EquityImport = z.infer<typeof equityImportSchema>;
export type EquityIssuer = z.infer<typeof equityIssuerSchema>;
export type EquityFact = z.infer<typeof equityFactSchema>;

export const equityPageQuerySchema = z.strictObject({
	q: z.string().trim().max(100).default(""),
	after: idSchema.optional(),
	limit: z.coerce.number().int().min(1).max(EQUITY_LIMITS.maxPageSize).default(50),
});
export const equityCursorQuerySchema = equityPageQuerySchema.omit({ q: true });
export const equityFactQuerySchema = z.strictObject({
	informationCutoff: equityInstantSchema.optional(),
	ingestionCutoff: equityInstantSchema.optional(),
	ingestionVersion: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
	after: idSchema.optional(),
	limit: z.coerce.number().int().min(1).max(EQUITY_LIMITS.maxPageSize).default(100),
});
export type EquityFactQuery = z.infer<typeof equityFactQuerySchema>;
export const equityIssuerSummarySchema = equityIssuerSchema.extend({
	symbols: z.array(z.string()),
	factCount: z.number().int().nonnegative(),
});
export const equityIssuerListSchema = z.strictObject({
	issuers: z.array(equityIssuerSummarySchema),
	nextCursor: idSchema.nullable(),
});
export const equityFactViewSchema = equityFactSchema.extend({
	issuerId: idSchema,
	statement: equityStatementSchema,
	metric: equityMetricSchema,
	filing: equityFilingSchema,
	document: equityDocumentSchema,
	committedAt: equityInstantSchema,
});
export const equityFactsResponseSchema = z.strictObject({
	facts: z.array(equityFactViewSchema),
	ingestionVersion: z.number().int().nonnegative().default(0),
	nextCursor: idSchema.nullable(),
});
export const equityImportResultSchema = z.strictObject({
	importId: idSchema,
	committedAt: equityInstantSchema,
	commitSequence: z.number().int().positive(),
	recordCount: z.number().int().positive(),
	replayed: z.boolean(),
});
export type EquityImportResult = z.infer<typeof equityImportResultSchema>;
export type EquityIssuerList = z.infer<typeof equityIssuerListSchema>;
export type EquityFactsResponse = z.infer<typeof equityFactsResponseSchema>;
export const equityImportCursorSchema = z
	.string()
	.max(121)
	.refine(
		(value) =>
			value[24] === "_" &&
			equityInstantSchema.safeParse(value.slice(0, 24)).success &&
			idSchema.safeParse(value.slice(25)).success,
	);
export const equityImportPageQuerySchema = equityCursorQuerySchema.extend({
	after: equityImportCursorSchema.optional(),
});
export const equityImportHistorySchema = z.strictObject({
	imports: z.array(
		z.strictObject({
			importId: idSchema,
			committedAt: equityInstantSchema,
			recordCount: z.number().int().positive(),
			coverageNote: z.string(),
			contentSha256: sha256,
		}),
	),
	nextCursor: equityImportCursorSchema.nullable(),
});
export type EquityImportHistory = z.infer<typeof equityImportHistorySchema>;

function catalogRecord<K extends string, S extends z.ZodType>(recordType: K, body: S) {
	return z.strictObject({ recordType: z.literal(recordType), recordId: idSchema, body });
}
export const equityRecordSchema = z.discriminatedUnion("recordType", [
	catalogRecord("issuer", equityIssuerSchema),
	catalogRecord("identifier", equityIdentifierSchema),
	catalogRecord("security", equitySecuritySchema),
	catalogRecord("listing", equityListingSchema),
	catalogRecord("source", equitySourceSchema),
	catalogRecord("document", equityDocumentSchema),
	catalogRecord("filing", equityFilingSchema),
	catalogRecord("statement", equityStatementSchema),
	catalogRecord("metric", equityMetricSchema),
	catalogRecord("fact", equityFactSchema),
	catalogRecord("price", equityPriceSchema),
	catalogRecord("action", equityActionSchema),
	catalogRecord("fx", equityFxSchema),
	catalogRecord("guidance", equityGuidanceSchema),
]);
export type EquityCatalogRecord = z.infer<typeof equityRecordSchema>;
export const equityRecordQuerySchema = equityCursorQuerySchema.extend({
	recordType: z
		.enum([
			"issuer",
			"identifier",
			"security",
			"listing",
			"source",
			"document",
			"filing",
			"statement",
			"metric",
			"fact",
			"price",
			"action",
			"fx",
			"guidance",
		])
		.optional(),
});
export type EquityRecordQuery = z.infer<typeof equityRecordQuerySchema>;
export const equityRecordsResponseSchema = z.strictObject({
	records: z.array(equityRecordSchema),
	nextCursor: idSchema.nullable(),
});
export type EquityRecordsResponse = z.infer<typeof equityRecordsResponseSchema>;
