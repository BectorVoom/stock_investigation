import {
	BUSINESS_DESCRIPTION_LIMITS,
	BUSINESS_PARAGRAPH_KINDS,
	EQUITY_ACCOUNTING_STANDARDS,
	EQUITY_BUSINESS_FORMS,
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
	isSecReportForm,
} from "@research/domain";
import { z } from "zod";
import {
	httpsUrlSchema,
	idSchema,
	isoDateSchema,
	isoDateTimeSchema,
	upstreamStatusSchema,
} from "./primitives.ts";
import { STOCK_DIRECTORY_LIMITS } from "./stockDirectory.ts";

/**
 * Annual financial statements synchronised automatically from SEC EDGAR (US)
 * and J-Quants (JP, ADR-0059) into the database, read by the Stocks page and
 * the financial statement widgets (ADR-0048). The runner fetches; the API
 * stores and serves; a page or widget never reaches SEC or J-Quants.
 */
export const EQUITY_FINANCIAL_LIMITS = {
	/**
	 * Companies one owner can track: every stock of the stock directory
	 * (ADR-0058 §3), so the bound is the directory's — both markets at their
	 * largest.
	 */
	maxTrackedCompanies: 2 * STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket,
	/**
	 * Directory stocks one claim-time reconcile tracks at most (ADR-0058 §3):
	 * one `INSERT … SELECT` per check, Watchlist stocks first.
	 */
	trackBatch: 500,
	/** Concepts a claim asks the runner to extract. */
	maxConcepts: 64,
	/** Filings a claim lists as already stored, per company. */
	maxKnownFilings: 400,
	/** Filings whose facts were not available yet, offered again. */
	maxPendingFilings: 20,
	/** Filings and facts one completion carries (keeps it under the 1,000,000-byte body cap). */
	maxFilingsPerCompletion: 60,
	maxFactsPerCompletion: 3_000,
	maxConceptChars: 160,
	/** Fiscal years of annual reports the first sync fetches. */
	backfillYears: 6,
	/** How often a Watchlist company is checked for new filings. */
	syncIntervalHours: 24,
	/**
	 * How often every other directory company is checked (ADR-0058 §3):
	 * annual statements change once a year, and a quiet SEC check is one
	 * submissions request.
	 */
	directorySyncIntervalHours: 168,
	/**
	 * When an answer that will not change soon is checked again (ADR-0058 §3):
	 * an identity conflict (a second listing of one issuer), a company SEC
	 * does not know or that has no annual report (funds, SPACs), and a
	 * Japanese issue J-Quants has no earnings summary for (ETFs, REITs
	 * without XBRL, ADR-0059 §2).
	 */
	notFoundRetryDays: 30,
	/** Statement and chart reads. */
	defaultYears: 5,
	maxYears: 15,
	maxNameChars: 200,
	pendingFilingGraceDays: EQUITY_PENDING_FILING_GRACE_DAYS,
} as const;

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
/** J-Quants' five-character issue code of a common stock: the JPX local code plus "0" (`jquantsIssueCode`). */
export const jquantsIssueCodeSchema = z.string().regex(/^[0-9][0-9A-Z]{3}0$/);
/** SEC accession number. */
export const secAccessionSchema = z.string().regex(/^\d{10}-\d{2}-\d{6}$/);
/** J-Quants disclosure number (`DiscNo`, 14 digits): one earnings summary. */
export const jquantsDisclosureNumberSchema = z.string().regex(/^\d{14}$/);
/** Fiscal year end month and day, "MM-DD". */
export const fiscalYearEndSchema = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
/** A taxonomy-qualified concept name, e.g. `us-gaap:Revenues`, `jquants:Sales`. */
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
	/** `SEC_USER_AGENT` (US) or `JQUANTS_API_KEY` (JP) is not set in apps/runner/.env. */
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

/**
 * The issuer a sync reported is already another tracked company's (two
 * listings of one issuer, such as GOOGL and GOOG, or a ticker that now
 * names a different issuer), or differs from the issuer this company
 * resolved to. The API stores nothing of that sync — merging two companies'
 * figures would be worse than none — and the owner resolves it by
 * untracking one of the two companies (ADR-0048 §6).
 */
export const EQUITY_IDENTITY_CONFLICT_CODE = "FINANCIAL_IDENTITY_CONFLICT";

/**
 * Failure codes the API itself records on a company's sync (the company
 * view's `sync.failure.code`, beside the runner's `EQUITY_SYNC_FAILURE_CODES`).
 */
export const EQUITY_SYNC_API_FAILURE_CODES = [
	EQUITY_IDENTITY_CONFLICT_CODE,
	/** Every attempt's lease expired (the runner stopped mid-sync); backed off like any failure. */
	"RETRY_CEILING_REACHED",
	/** The stored rows could not form a valid claim, so the job failed before it ran. */
	"INTERNAL",
] as const;
export type EquitySyncApiFailureCode = (typeof EQUITY_SYNC_API_FAILURE_CODES)[number];

/* ---------- Claim: what the runner is asked to fetch ---------- */

/** A filing's metadata as the source states it (ADR-0048 §4). */
export const equityFilingMetadataShape = {
	sourceDocumentId: z.string().min(1).max(40),
	form: equityReportFormSchema,
	filedOn: equityCalendarDateSchema,
	/** SEC acceptance instant / J-Quants disclosure instant (TDnet), when the source states it. */
	submittedAt: isoDateTimeSchema.nullable(),
	/** The report's own fiscal period. */
	periodStart: equityCalendarDateSchema.nullable(),
	periodEnd: equityCalendarDateSchema,
	/** The filing it amends: a J-Quants correction names the summary before it (ADR-0059 §2). */
	amendsSourceDocumentId: z.string().min(1).max(40).nullable(),
	/** The filing's page: SEC archive document or folder; the J-Quants query that answers the summary. */
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
 * accessions, from annual (10-K, 20-F, 40-F and their amendments) filings
 * filed on or after `filedSince`.
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
	/**
	 * The annual report (10-K, 20-F or 40-F) whose business description is
	 * stored (or recorded as not found), null when none is (ADR-0053 §2,
	 * ADR-0058 §5). The runner reads the newest original annual report's
	 * primary document only when its accession differs.
	 */
	describedDocumentId: secAccessionSchema.nullable(),
});
export type SecSyncRequest = z.infer<typeof secSyncRequestSchema>;

/**
 * J-Quants (ADR-0059 §2): one `GET /v2/fins/summary?code=` query answers
 * every earnings summary of the company in the plan's window with its
 * figures. The runner returns the full-year summaries whose disclosure
 * number is not in `knownDisclosures` (every stored filing's), so a
 * completion carries only what is new.
 */
export const jquantsSyncRequestSchema = z.strictObject({
	provider: z.literal("jquants"),
	code: jquantsIssueCodeSchema,
	knownDisclosures: z
		.array(jquantsDisclosureNumberSchema)
		.max(EQUITY_FINANCIAL_LIMITS.maxKnownFilings),
});
export type JquantsSyncRequest = z.infer<typeof jquantsSyncRequestSchema>;

/** The provider-specific part of a `financial-sync` claim. */
export const equitySyncRequestSchema = z.discriminatedUnion("provider", [
	secSyncRequestSchema,
	jquantsSyncRequestSchema,
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

/** One as-reported annual fact (ADR-0048 §4). Values are exact text as the source reported them. */
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
 *   company facts can lag the filing; a text-only amendment has none) — the
 *   API keeps it pending for `pendingFilingGraceDays` after its filing
 *   date, then records it as having none;
 * - "deferred": found but not read in this job (a cap) — the API keeps it
 *   pending and offers it again at once, with no grace count.
 * A J-Quants summary is always "extracted" (its figures are in the answer).
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

export const equityBusinessParagraphSchema = z.strictObject({
	kind: z.enum(BUSINESS_PARAGRAPH_KINDS),
	text: z.string().min(1).max(BUSINESS_DESCRIPTION_LIMITS.maxStoredChars),
});
export type EquityBusinessParagraph = z.infer<typeof equityBusinessParagraphSchema>;

/** The filing a business description was read from (ADR-0053 §2). */
export const equityBusinessSourceSchema = z.strictObject({
	sourceDocumentId: z.string().min(1).max(40),
	/** Only an original annual report: "10-K", "20-F", "40-F" or "securities-report". */
	form: z.enum(EQUITY_BUSINESS_FORMS),
	filedOn: equityCalendarDateSchema,
	periodEnd: equityCalendarDateSchema,
	sourceUrl: httpsUrlSchema,
});
export type EquityBusinessSource = z.infer<typeof equityBusinessSourceSchema>;

/**
 * The business section of one annual report (ADR-0053 §2–§4): "extracted"
 * with its paragraphs (`businessParagraphs`), or "not-found" when the
 * report has no section the runner could read — recorded so the same
 * report is not read again. Paragraph text together stays within
 * `BUSINESS_DESCRIPTION_LIMITS.maxStoredChars`.
 */
export const equityBusinessDescriptionSchema = z
	.strictObject({
		source: equityBusinessSourceSchema,
		status: z.enum(["extracted", "not-found"]),
		paragraphs: z
			.array(equityBusinessParagraphSchema)
			.max(BUSINESS_DESCRIPTION_LIMITS.maxParagraphs),
		/** Paragraphs were left out to fit the limits (the filing has the rest). */
		truncated: z.boolean(),
	})
	.refine(
		(description) =>
			description.status === "extracted"
				? description.paragraphs.some((paragraph) => paragraph.kind === "text")
				: description.paragraphs.length === 0 && !description.truncated,
		{
			message: "an extracted description has text; a not-found one has none",
			path: ["paragraphs"],
		},
	)
	.refine(
		(description) =>
			description.paragraphs.reduce((total, paragraph) => total + paragraph.text.length, 0) <=
			BUSINESS_DESCRIPTION_LIMITS.maxStoredChars,
		{ message: "paragraphs exceed the stored-text limit", path: ["paragraphs"] },
	);
export type EquityBusinessDescription = z.infer<typeof equityBusinessDescriptionSchema>;

/**
 * A `financial-synced` completion's fields besides the outcome and the
 * completion base. `identity` is what the source says about the company
 * (null when this job learned nothing). Filings never repeat a
 * `sourceDocumentId`; the facts of all filings together stay within
 * `maxFactsPerCompletion`. A J-Quants completion carries no business
 * description (J-Quants has no business text, ADR-0059 §3).
 */
export const equitySyncCompletionShape = {
	companyId: equityCompanyIdSchema,
	provider: equityProviderSchema,
	fetchedAt: isoDateTimeSchema,
	identity: z
		.strictObject({
			/** CIK (SEC) or the J-Quants issue code. */
			sourceCompanyId: z.union([secCikSchema, jquantsIssueCodeSchema]),
			name: companyNameSchema.nullable(),
			fiscalYearEnd: fiscalYearEndSchema.nullable(),
		})
		.nullable(),
	filings: z.array(equityFilingResultSchema).max(EQUITY_FINANCIAL_LIMITS.maxFilingsPerCompletion),
	/**
	 * True when the job left work for the next one (filings cut by the
	 * completion caps): the API schedules the company again at once and the
	 * next SEC claim sets `fullCheck`.
	 */
	more: z.boolean(),
	/**
	 * The business description this job read (ADR-0053), null when it read
	 * none (the stored one is current, or the read failed — the next sync
	 * asks again). The API keeps the description of the newest report.
	 */
	description: equityBusinessDescriptionSchema.nullable(),
};

/** The first problem of a completion's cross-field rules, or null. */
export function equitySyncCompletionProblem(completion: {
	readonly provider: "sec" | "jquants";
	readonly identity: { readonly sourceCompanyId: string } | null;
	readonly filings: readonly z.infer<typeof equityFilingResultSchema>[];
	readonly description: EquityBusinessDescription | null;
}): string | null {
	if (completion.identity !== null) {
		const ok =
			completion.provider === "sec"
				? secCikSchema.safeParse(completion.identity.sourceCompanyId).success
				: jquantsIssueCodeSchema.safeParse(completion.identity.sourceCompanyId).success;
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
				: jquantsDisclosureNumberSchema.safeParse(filing.sourceDocumentId).success;
		if (!idOk) return "a filing id does not match the provider";
		if (isSecReportForm(filing.form) !== (completion.provider === "sec"))
			return "a filing form does not match the provider";
		facts += filing.facts.length;
	}
	if (facts > EQUITY_FINANCIAL_LIMITS.maxFactsPerCompletion) return "too many facts";
	if (completion.description !== null) {
		if (completion.provider !== "sec") return "only an SEC sync reads a business description";
		const source = completion.description.source;
		if (!secAccessionSchema.safeParse(source.sourceDocumentId).success) {
			return "the business description's filing does not match the provider";
		}
	}
	return null;
}

/* ---------- API: tracked companies and sync status ---------- */

export const EQUITY_SYNC_STATUSES = ["never", "queued", "running", "succeeded", "failed"] as const;
export const equitySyncStatusSchema = z.enum(EQUITY_SYNC_STATUSES);

/** Where the company's sync stands (ADR-0048 §6). */
export const equitySyncViewSchema = z.strictObject({
	status: equitySyncStatusSchema,
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
	/** From the provider (SEC entity name) or the stock list; null until known. */
	name: companyNameSchema.nullable(),
	provider: equityProviderSchema,
	/** CIK or J-Quants issue code; null until the first sync resolves it. */
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
 * current one: the revision history the sync keeps (ADR-0048 §5).
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

/** Most filings one filings read lists (six fiscal years of reports and amendments fit many times over). */
export const EQUITY_FILINGS_READ_MAX = 500;

/**
 * One stored filing in the company's filings list: the filing view plus its
 * extraction status (`pending` = offered again by the next sync; `unavailable`
 * = the source had no machine-readable facts), the number of facts stored
 * from it, and the original it amends.
 */
export const equityFilingListItemSchema = equityFilingViewSchema.extend({
	factsStatus: z.enum(["pending", "extracted", "unavailable"]),
	factCount: z.number().int().nonnegative(),
	amendsSourceDocumentId: z.string().min(1).max(40).nullable(),
});
export type EquityFilingListItem = z.infer<typeof equityFilingListItemSchema>;

/**
 * Every stored filing of a company, newest first (filing date, then filing id,
 * both descending), including superseded originals and filings without facts:
 * `GET /api/v1/equities/companies/:companyId/filings` (ADR-0048 §7).
 */
export const equityFilingsResponseSchema = z.strictObject({
	company: equityCompanyViewSchema,
	filings: z.array(equityFilingListItemSchema).max(EQUITY_FILINGS_READ_MAX),
});
export type EquityFilingsResponse = z.infer<typeof equityFilingsResponseSchema>;
