import {
	EDINET_SCAN,
	EQUITY_ACCOUNTING_STANDARDS,
	EQUITY_MARKETS,
	EQUITY_METRIC_CODES,
	EQUITY_PENDING_FILING_GRACE_DAYS,
	EQUITY_PERIOD_TYPES,
	EQUITY_PROVIDERS,
	EQUITY_REPORT_FORMS,
	EQUITY_SCOPES,
	EQUITY_STATEMENTS,
	EQUITY_UNAVAILABLE_REASONS,
	isCanonicalDecimal,
	isoDayNumber,
} from "@research/domain";
import { z } from "zod";
import {
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	upstreamStatusSchema,
} from "./primitives.ts";
import { watchlistStockIdSchema } from "./watchlist.ts";

/**
 * Annual financial statements synchronised automatically from SEC EDGAR (US)
 * and EDINET (JP) into the database, read by the Equities page and the
 * financial statement widgets (ADR-0045). The runner fetches; the API stores
 * and serves; a page or widget never reaches SEC or EDINET.
 */
export const EQUITY_FINANCIAL_LIMITS = {
	/** Companies one owner can track (a proof-of-concept bound, ADR-0045 §8). */
	maxTrackedCompanies: 20,
	/** Concepts a claim asks the runner to extract. */
	maxConcepts: 64,
	/** Filings a claim lists as already stored, per company. */
	maxKnownFilings: 400,
	/** Filings whose facts were not available yet, offered again. */
	maxPendingFilings: 20,
	/** EDINET dates one job scans (one request each, about one second apart). */
	maxScanDays: 40,
	/** EDINET documents one job downloads. */
	maxDocumentsPerJob: 8,
	/** Filings and facts one completion carries (keeps it under the 1,000,000-byte body cap). */
	maxFilingsPerCompletion: 60,
	maxFactsPerCompletion: 3_000,
	maxConceptChars: 160,
	/** Fiscal years of annual reports the first sync fetches. */
	backfillYears: 6,
	/** How often a tracked company is checked for new filings. */
	syncIntervalHours: 24,
	/** Statement and chart reads. */
	defaultYears: 5,
	maxYears: 15,
	maxNameChars: 200,
	pendingFilingGraceDays: EQUITY_PENDING_FILING_GRACE_DAYS,
	edinetDiscoveryDays: EDINET_SCAN.discoveryDays,
} as const;

/**
 * The companies tracked for an owner the first time the scheduler runs
 * (ADR-0045 §8, chosen by the owner 2026-10-31): Apple, Microsoft,
 * Coca-Cola; Nintendo, Tokyo Electron, Daikin (Japanese GAAP, March year
 * end). Added once per owner (`equity_sync_meta`), so removing one sticks.
 */
export const EQUITY_DEFAULT_STOCK_IDS = [
	"us:AAPL",
	"us:MSFT",
	"us:KO",
	"jp:7974",
	"jp:8035",
	"jp:6367",
] as const;

export const equityMarketSchema = z.enum(EQUITY_MARKETS);
export const equityProviderSchema = z.enum(EQUITY_PROVIDERS);
export const equityAccountingStandardSchema = z.enum(EQUITY_ACCOUNTING_STANDARDS);
export const equityScopeSchema = z.enum(EQUITY_SCOPES);
export const equityPeriodTypeSchema = z.enum(EQUITY_PERIOD_TYPES);
export const equityStatementSchema = z.enum(EQUITY_STATEMENTS);
export type EquityStatementKind = z.infer<typeof equityStatementSchema>;
export const equityReportFormSchema = z.enum(EQUITY_REPORT_FORMS);
export const equityMetricCodeSchema = z.enum(EQUITY_METRIC_CODES);
export const equityUnavailableReasonSchema = z.enum(EQUITY_UNAVAILABLE_REASONS);

/** Canonical exact decimal text in base units (no exponent, no leading/trailing zeros, no "-0"). */
export const equityValueDecimalSchema = z
	.string()
	.max(64)
	.refine(isCanonicalDecimal, "canonical decimal text expected");

/** A valid calendar date (zod's `iso.date` alone accepts 2024-02-30). */
export const equityCalendarDateSchema = isoDateSchema.refine(
	(value) => isoDayNumber(value) !== null,
	"calendar date expected",
);

/** SEC Central Index Key, ten digits with leading zeros. */
export const secCikSchema = z.string().regex(/^\d{10}$/);
/** EDINET filer code. */
export const edinetCodeSchema = z.string().regex(/^E\d{5}$/);
/** EDINET's five-character securities code: the JPX local code plus a check "0". */
export const edinetSecuritiesCodeSchema = z.string().regex(/^[0-9A-Z]{4}0$/);
/** SEC accession number. */
export const secAccessionSchema = z.string().regex(/^\d{10}-\d{2}-\d{6}$/);
/** EDINET document id. */
export const edinetDocIdSchema = z.string().regex(/^S[0-9A-Z]{7}$/);
/** Fiscal year end month and day, "MM-DD". */
export const fiscalYearEndSchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
/** A taxonomy-qualified concept name, e.g. `us-gaap:Revenues`, `jppfs_cor:NetSales`. */
export const equityConceptSchema = z
	.string()
	.max(EQUITY_FINANCIAL_LIMITS.maxConceptChars)
	.regex(/^[a-z][a-z0-9_-]*:[A-Za-z][A-Za-z0-9_]*$/);
/** Opaque company id; the stock id names the listing, the source id the issuer. */
export const equityCompanyIdSchema = idSchema;
const companyNameSchema = z.string().trim().min(1).max(EQUITY_FINANCIAL_LIMITS.maxNameChars);

/**
 * Stable failure codes of a `financial-sync` job (the `failed` outcome's
 * `failureCode`); provider text is never carried. `failureUpstreamStatus`
 * keeps the provider's HTTP status unchanged (ADR-0037).
 */
export const EQUITY_SYNC_FAILURE_CODES = [
	/** `SEC_USER_AGENT` (US) or `EDINET_API_KEY` (JP) is not set in apps/runner/.env. */
	"FINANCIAL_SOURCE_NOT_CONFIGURED",
	/** The ticker is not in SEC's ticker list. */
	"FINANCIAL_COMPANY_NOT_FOUND",
	"FINANCIAL_RATE_LIMITED",
	/** The provider refused the key or the User-Agent (401/403). */
	"FINANCIAL_ACCESS_DENIED",
	"FINANCIAL_SOURCE_FAILED",
	/** A document arrived but did not have the expected shape. */
	"FINANCIAL_PARSE_FAILED",
] as const;
export const equitySyncFailureCodeSchema = z.enum(EQUITY_SYNC_FAILURE_CODES);
export type EquitySyncFailureCode = z.infer<typeof equitySyncFailureCodeSchema>;

/* ---------- Claim: what the runner is asked to fetch ---------- */

/** A filing's metadata as the source states it (ADR-0045 §4). */
export const equityFilingMetadataShape = {
	sourceDocumentId: z.string().min(1).max(40),
	form: equityReportFormSchema,
	filedOn: equityCalendarDateSchema,
	/** SEC acceptance instant / EDINET submission instant, when the source states it. */
	submittedAt: isoDateTimeSchema.nullable(),
	/** The report's own fiscal period. */
	periodStart: equityCalendarDateSchema.nullable(),
	periodEnd: equityCalendarDateSchema,
	/** The filing it amends, when the source names it (EDINET parentDocID). */
	amendsSourceDocumentId: z.string().min(1).max(40).nullable(),
	/** The filing's public page (SEC archive document or folder; EDINET document viewer). */
	sourceUrl: httpsUrlSchema,
};

/**
 * A stored filing whose facts were not fetched yet (deferred by a job's
 * download cap) or not available yet (the source's machine-readable facts
 * lag the filing). The claim offers it again with its stored metadata,
 * which the runner echoes back unchanged (the API never rewrites a stored
 * filing's metadata).
 */
export const equityPendingFilingSchema = z.strictObject(equityFilingMetadataShape);
export type EquityPendingFiling = z.infer<typeof equityPendingFilingSchema>;

/**
 * SEC: one submissions request; the company facts (one request) only when
 * an annual filing is new or pending. `cik` is null until resolved from
 * SEC's ticker list. Facts are extracted only for the new and pending
 * accessions, from annual (10-K, 10-K/A) filings filed on or after `filedSince`.
 */
export const secSyncRequestSchema = z.strictObject({
	provider: z.literal("sec"),
	cik: secCikSchema.nullable(),
	knownAccessions: z.array(secAccessionSchema).max(EQUITY_FINANCIAL_LIMITS.maxKnownFilings),
	pendingFilings: z.array(equityPendingFilingSchema).max(EQUITY_FINANCIAL_LIMITS.maxPendingFilings),
	filedSince: equityCalendarDateSchema,
	/**
	 * Read the company facts even when the submissions list shows nothing
	 * new: the first sync, and after a completion that said `more` (its
	 * filings were cut by the completion caps, so older annual filings that
	 * only the company facts list remain unread).
	 */
	fullCheck: z.boolean(),
});
export type SecSyncRequest = z.infer<typeof secSyncRequestSchema>;

/**
 * EDINET: list the documents of each `scanDays` date (planned by the API,
 * `edinetScanPlan`), keep the annual reports (docTypeCode 120/130) whose
 * securities code is `secCode`, and download the XBRL-to-CSV of those not
 * in `knownDocIds`, plus the `pendingFilings`.
 */
export const edinetSyncRequestSchema = z.strictObject({
	provider: z.literal("edinet"),
	secCode: edinetSecuritiesCodeSchema,
	edinetCode: edinetCodeSchema.nullable(),
	knownDocIds: z.array(edinetDocIdSchema).max(EQUITY_FINANCIAL_LIMITS.maxKnownFilings),
	pendingFilings: z.array(equityPendingFilingSchema).max(EQUITY_FINANCIAL_LIMITS.maxPendingFilings),
	scanDays: z.array(equityCalendarDateSchema).max(EQUITY_FINANCIAL_LIMITS.maxScanDays),
});
export type EdinetSyncRequest = z.infer<typeof edinetSyncRequestSchema>;

/** The provider-specific part of a `financial-sync` claim. */
export const equitySyncRequestSchema = z.discriminatedUnion("provider", [
	secSyncRequestSchema,
	edinetSyncRequestSchema,
]);
export type EquitySyncRequest = z.infer<typeof equitySyncRequestSchema>;

/**
 * The fields of a `financial-sync` claimed job besides the lease shape:
 * the company, the concepts to extract (`equityConceptsOfProvider`) and the
 * provider request.
 */
export const equitySyncClaimShape = {
	companyId: equityCompanyIdSchema,
	market: equityMarketSchema,
	symbol: z.string().min(1).max(16),
	concepts: z.array(equityConceptSchema).min(1).max(EQUITY_FINANCIAL_LIMITS.maxConcepts),
	source: equitySyncRequestSchema,
};

/* ---------- Completion: what the runner found ---------- */

/** One as-reported annual fact (ADR-0045 §4). Values are exact text as the source reported them. */
export const equityExtractedFactSchema = z
	.strictObject({
		concept: equityConceptSchema,
		/** ISO 4217 currency for amounts; the source's unit id otherwise. */
		unit: z.string().min(1).max(40),
		valueDecimal: equityValueDecimalSchema,
		periodType: equityPeriodTypeSchema,
		periodStart: equityCalendarDateSchema.nullable(),
		periodEnd: equityCalendarDateSchema,
		scope: equityScopeSchema,
	})
	.refine(
		(fact) =>
			fact.periodType === "instant"
				? fact.periodStart === null
				: fact.periodStart !== null && fact.periodStart <= fact.periodEnd,
		{ message: "period dates must match the period type", path: ["periodStart"] },
	);
export type EquityExtractedFactInput = z.infer<typeof equityExtractedFactSchema>;

/**
 * One annual filing. `factsStatus`:
 * - "extracted": its annual facts were read (possibly none of the mapped concepts);
 * - "not-available": the source has no machine-readable facts for it (SEC
 *   company facts or EDINET's CSV can lag the filing; a text-only amendment
 *   has none) — the API keeps it pending for `pendingFilingGraceDays` after
 *   its filing date, then records it as having none;
 * - "deferred": found but not downloaded in this job (download cap) — the
 *   API keeps it pending and offers it again at once, with no grace count.
 */
export const equityFilingResultSchema = z
	.strictObject({
		...equityFilingMetadataShape,
		accountingStandard: equityAccountingStandardSchema.nullable(),
		factsStatus: z.enum(["extracted", "not-available", "deferred"]),
		facts: z.array(equityExtractedFactSchema).max(EQUITY_FINANCIAL_LIMITS.maxFactsPerCompletion),
	})
	.refine((filing) => filing.factsStatus === "extracted" || filing.facts.length === 0, {
		message: "a filing without extracted facts carries none",
		path: ["facts"],
	});
export type EquityFilingResult = z.infer<typeof equityFilingResultSchema>;

/**
 * A `financial-synced` completion's fields besides the outcome and the
 * completion base. `identity` is what the source says about the company
 * (null when this job learned nothing, e.g. an EDINET scan that found no
 * report yet). `scannedDays` are the EDINET dates fully listed (always []
 * for SEC). Filings never repeat a `sourceDocumentId`; the facts of all
 * filings together stay within `maxFactsPerCompletion`.
 */
export const equitySyncCompletionShape = {
	companyId: equityCompanyIdSchema,
	provider: equityProviderSchema,
	fetchedAt: isoDateTimeSchema,
	identity: z
		.strictObject({
			/** CIK (SEC) or EDINET code. */
			sourceCompanyId: z.union([secCikSchema, edinetCodeSchema]),
			name: companyNameSchema.nullable(),
			fiscalYearEnd: fiscalYearEndSchema.nullable(),
		})
		.nullable(),
	scannedDays: z.array(equityCalendarDateSchema).max(EQUITY_FINANCIAL_LIMITS.maxScanDays),
	filings: z.array(equityFilingResultSchema).max(EQUITY_FINANCIAL_LIMITS.maxFilingsPerCompletion),
	/**
	 * True when the job left work for the next one (filings cut by the
	 * completion caps): the API schedules the company again at once and the
	 * next SEC claim sets `fullCheck`.
	 */
	more: z.boolean(),
};

/** The first problem of a completion's cross-field rules, or null. */
export function equitySyncCompletionProblem(completion: {
	readonly provider: "sec" | "edinet";
	readonly identity: { readonly sourceCompanyId: string } | null;
	readonly scannedDays: readonly string[];
	readonly filings: readonly z.infer<typeof equityFilingResultSchema>[];
}): string | null {
	if (completion.provider === "sec" && completion.scannedDays.length > 0) {
		return "an SEC sync scans no EDINET dates";
	}
	if (completion.identity !== null) {
		const ok =
			completion.provider === "sec"
				? secCikSchema.safeParse(completion.identity.sourceCompanyId).success
				: edinetCodeSchema.safeParse(completion.identity.sourceCompanyId).success;
		if (!ok) return "identity does not match the provider";
	}
	const ids = new Set<string>();
	let facts = 0;
	for (const filing of completion.filings) {
		if (ids.has(filing.sourceDocumentId)) return "a filing appears twice";
		ids.add(filing.sourceDocumentId);
		const idOk =
			completion.provider === "sec"
				? secAccessionSchema.safeParse(filing.sourceDocumentId).success
				: edinetDocIdSchema.safeParse(filing.sourceDocumentId).success;
		if (!idOk) return "a filing id does not match the provider";
		const secForm = filing.form === "10-K" || filing.form === "10-K/A";
		if (secForm !== (completion.provider === "sec"))
			return "a filing form does not match the provider";
		facts += filing.facts.length;
	}
	if (facts > EQUITY_FINANCIAL_LIMITS.maxFactsPerCompletion) return "too many facts";
	return null;
}

/* ---------- API: tracked companies and sync status ---------- */

export const EQUITY_SYNC_STATUSES = ["never", "queued", "running", "succeeded", "failed"] as const;
export const equitySyncStatusSchema = z.enum(EQUITY_SYNC_STATUSES);

/** Where the company's sync stands (ADR-0045 §6); EDINET adds the scan phase. */
export const equitySyncViewSchema = z.strictObject({
	status: equitySyncStatusSchema,
	phase: z.enum(["discovery", "backfill", "forward", "idle", "not-found"]).nullable(),
	lastCheckedAt: isoDateTimeSchema.nullable(),
	lastSucceededAt: isoDateTimeSchema.nullable(),
	nextDueAt: isoDateTimeSchema.nullable(),
	failure: z
		.strictObject({
			code: z.string().min(1).max(80),
			upstreamStatus: upstreamStatusSchema.nullable(),
			at: isoDateTimeSchema,
		})
		.nullable(),
});
export type EquitySyncView = z.infer<typeof equitySyncViewSchema>;

export const equityCompanyViewSchema = z.strictObject({
	companyId: equityCompanyIdSchema,
	market: equityMarketSchema,
	symbol: z.string().min(1).max(16),
	/** From the provider (SEC entity name; EDINET filer name) or the stock list; null until known. */
	name: companyNameSchema.nullable(),
	provider: equityProviderSchema,
	/** CIK or EDINET code; null until the first sync resolves it. */
	sourceCompanyId: z.string().min(1).max(20).nullable(),
	fiscalYearEnd: fiscalYearEndSchema.nullable(),
	tracked: z.boolean(),
	/** Newest fiscal year with any stored value; null before the first facts. */
	latestFiscalYear: z.number().int().nullable(),
	filingCount: z.number().int().nonnegative(),
	sync: equitySyncViewSchema,
});
export type EquityCompanyView = z.infer<typeof equityCompanyViewSchema>;

export const equityCompanyListSchema = z.strictObject({
	companies: z.array(equityCompanyViewSchema).max(200),
});
export type EquityCompanyList = z.infer<typeof equityCompanyListSchema>;

/** Track a listed stock (`us:AAPL`, `jp:7974`). */
export const trackEquityCompanyRequestSchema = z.strictObject({
	stockId: watchlistStockIdSchema,
});
export type TrackEquityCompanyRequest = z.infer<typeof trackEquityCompanyRequestSchema>;

/* ---------- API: statements, metric series, revisions ---------- */

export const equityFilingViewSchema = z.strictObject({
	filingId: idSchema,
	provider: equityProviderSchema,
	sourceDocumentId: z.string().min(1).max(40),
	form: equityReportFormSchema,
	isAmendment: z.boolean(),
	filedOn: isoDateSchema,
	periodEnd: isoDateSchema,
	accountingStandard: equityAccountingStandardSchema.nullable(),
	sourceUrl: httpsUrlSchema,
});
export type EquityFilingView = z.infer<typeof equityFilingViewSchema>;

/**
 * One metric in one fiscal year. `valueDecimal` null means not available —
 * never zero — with `unavailableReason` saying why. A value carries the
 * filing it comes from, the source concept, and how many different values
 * the filings reported for it (more than 1 = revised; see the revisions read).
 */
export const equityMetricCellSchema = z
	.strictObject({
		fiscalYear: z.number().int(),
		periodEnd: isoDateSchema.nullable(),
		valueDecimal: equityValueDecimalSchema.nullable(),
		currency: z
			.string()
			.regex(/^[A-Z]{3}$/)
			.nullable(),
		unavailableReason: equityUnavailableReasonSchema.nullable(),
		filingId: idSchema.nullable(),
		concept: z.string().min(1).max(EQUITY_FINANCIAL_LIMITS.maxConceptChars).nullable(),
		scope: equityScopeSchema.nullable(),
		derived: z.boolean(),
		reportedValueCount: z.number().int().nonnegative(),
	})
	.refine(
		(cell) =>
			cell.valueDecimal === null
				? cell.unavailableReason !== null && cell.currency === null && cell.filingId === null
				: cell.unavailableReason === null && cell.currency !== null && cell.filingId !== null,
		{ message: "a cell is either a sourced value or unavailable with a reason" },
	);
export type EquityMetricCell = z.infer<typeof equityMetricCellSchema>;

export const equityYearsQuerySchema = z.strictObject({
	years: z.coerce
		.number()
		.int()
		.min(1)
		.max(EQUITY_FINANCIAL_LIMITS.maxYears)
		.default(EQUITY_FINANCIAL_LIMITS.defaultYears),
	period: z.literal("annual").default("annual"),
});

export const equityMetricQuerySchema = equityYearsQuerySchema.extend({
	metric: equityMetricCodeSchema,
});

/**
 * One statement for the newest `years` fiscal years that have any value,
 * oldest first (columns read left to right in time). Rows are the
 * statement's metrics in `EQUITY_METRICS` order, each with one cell per year.
 * `filings` lists every filing a cell cites.
 */
export const equityStatementResponseSchema = z.strictObject({
	company: equityCompanyViewSchema,
	statement: equityStatementSchema,
	fiscalYears: z.array(z.number().int()).max(EQUITY_FINANCIAL_LIMITS.maxYears),
	rows: z.array(
		z.strictObject({
			metric: equityMetricCodeSchema,
			cells: z.array(equityMetricCellSchema).max(EQUITY_FINANCIAL_LIMITS.maxYears),
		}),
	),
	filings: z.array(equityFilingViewSchema).max(200),
	/** Last change of this company's stored values (also the ETag basis). */
	dataUpdatedAt: isoDateTimeSchema.nullable(),
});
export type EquityStatementResponse = z.infer<typeof equityStatementResponseSchema>;

/** One metric over the newest `years` fiscal years, oldest first. */
export const equityMetricSeriesResponseSchema = z.strictObject({
	company: equityCompanyViewSchema,
	metric: equityMetricCodeSchema,
	cells: z.array(equityMetricCellSchema).max(EQUITY_FINANCIAL_LIMITS.maxYears),
	filings: z.array(equityFilingViewSchema).max(200),
	dataUpdatedAt: isoDateTimeSchema.nullable(),
});
export type EquityMetricSeriesResponse = z.infer<typeof equityMetricSeriesResponseSchema>;

export const equityRevisionsQuerySchema = z.strictObject({
	metric: equityMetricCodeSchema,
	fiscalYear: z.coerce.number().int().min(1900).max(2200),
});

/**
 * Every as-filed value of one metric-year (newest filing first) beside the
 * current one: the revision history the sync keeps (ADR-0045 §5).
 */
export const equityRevisionsResponseSchema = z.strictObject({
	company: equityCompanyViewSchema,
	metric: equityMetricCodeSchema,
	fiscalYear: z.number().int(),
	current: equityMetricCellSchema,
	reported: z
		.array(
			z.strictObject({
				filingId: idSchema,
				concept: z.string().min(1).max(EQUITY_FINANCIAL_LIMITS.maxConceptChars),
				scope: equityScopeSchema,
				unit: z.string().min(1).max(40),
				/** As reported (sign not applied). */
				valueDecimal: equityValueDecimalSchema,
				periodStart: isoDateSchema.nullable(),
				periodEnd: isoDateSchema,
			}),
		)
		.max(500),
	filings: z.array(equityFilingViewSchema).max(200),
});
export type EquityRevisionsResponse = z.infer<typeof equityRevisionsResponseSchema>;
