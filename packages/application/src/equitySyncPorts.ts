/**
 * Storage ports of the annual financial statement sync (ADR-0048 §2): the
 * tracked companies, their filings, the as-filed facts, the authoritative
 * metric values and the sync schedule (migration 0021). The SQL adapter is
 * `packages/adapters/src/sql/equitySync.ts`; the completion's writes are
 * committed by `ResearchUnitOfWork.commitCompletion` in the job's guarded batch.
 * The business description of the newest annual report (ADR-0053,
 * migration 0022) is read and written beside them.
 */
import type { EquityBusinessDescription } from "@research/contracts";
import type {
	EdinetScanPhase,
	EquityAccountingStandard,
	EquityMarket,
	EquityMetricCode,
	EquityPeriodType,
	EquityProvider,
	EquityReportForm,
	EquityScope,
	EquityUnavailableReason,
} from "@research/domain";

export type EquityFactsStatus = "pending" | "extracted" | "unavailable";

/** One `equity_company` row. */
export interface EquityCompanyRecord {
	readonly companyId: string;
	readonly market: EquityMarket;
	readonly symbol: string;
	readonly provider: EquityProvider;
	/** CIK or EDINET code; null until a sync resolved it. */
	readonly sourceCompanyId: string | null;
	readonly name: string | null;
	/** "MM-DD". */
	readonly fiscalYearEnd: string | null;
	readonly tracked: boolean;
	readonly trackedAt: string;
}

/** One `equity_sync_state` row (a company without one reads as never synced). */
export interface EquitySyncStateRecord {
	readonly nextDueAt: string | null;
	readonly lastCheckedAt: string | null;
	readonly lastSucceededAt: string | null;
	readonly failureCode: string | null;
	readonly failureUpstreamStatus: number | null;
	readonly failureAt: string | null;
	readonly consecutiveFailures: number;
	readonly morePending: boolean;
	readonly edinetPhase: EdinetScanPhase | null;
	readonly dataUpdatedAt: string | null;
}

export const EMPTY_EQUITY_SYNC_STATE: EquitySyncStateRecord = {
	nextDueAt: null,
	lastCheckedAt: null,
	lastSucceededAt: null,
	failureCode: null,
	failureUpstreamStatus: null,
	failureAt: null,
	consecutiveFailures: 0,
	morePending: false,
	edinetPhase: null,
	dataUpdatedAt: null,
};

/** A company with its schedule and the two aggregates its view shows. */
export interface EquityCompanySummary {
	readonly company: EquityCompanyRecord;
	readonly state: EquitySyncStateRecord;
	/** Newest fiscal year with a stored value (not an unavailable row). */
	readonly latestFiscalYear: number | null;
	readonly filingCount: number;
}

/** One `equity_report_filing` row. */
export interface StoredEquityFiling {
	readonly filingId: string;
	readonly companyId: string;
	readonly provider: EquityProvider;
	readonly sourceDocumentId: string;
	readonly form: EquityReportForm;
	readonly filedOn: string;
	readonly submittedAt: string | null;
	readonly periodStart: string | null;
	readonly periodEnd: string;
	readonly accountingStandard: EquityAccountingStandard | null;
	readonly amendsSourceDocumentId: string | null;
	readonly sourceUrl: string;
	readonly factsStatus: EquityFactsStatus;
	readonly factCount: number;
	/**
	 * The scope the filing's values come from — consolidated when it reports
	 * any consolidated fact, else separate; null until its facts are
	 * recorded (`facts_status` extracted). The projection reads only facts of
	 * this scope, so a consolidated filer never shows a parent-only figure.
	 */
	readonly primaryScope: EquityScope | null;
	/**
	 * When a sync first reported the filing (ISO-8601 UTC): an EDINET filing
	 * whose download keeps failing is retried until 7 days after this.
	 */
	readonly firstSeenAt: string;
}

/**
 * What orders business descriptions (ADR-0053 §2): period end, then filing
 * date, then document id, each compared as text (ISO dates and the ASCII
 * ids compare correctly so, in SQL as in TypeScript).
 */
export interface EquityDescriptionKey {
	readonly periodEnd: string;
	readonly filedOn: string;
	readonly sourceDocumentId: string;
}

/** One `equity_business_description` row (ADR-0053). */
export interface StoredEquityBusinessDescription extends EquityBusinessDescription {
	/** When the runner read the report (the completion's `fetchedAt`). */
	readonly fetchedAt: string;
}

/** What a claim and the scheduler read about one company. */
export interface EquityClaimContext {
	readonly company: EquityCompanyRecord;
	readonly state: EquitySyncStateRecord;
	/** Every filing of the company, newest filing date first. */
	readonly filings: readonly StoredEquityFiling[];
	/** EDINET dates already listed (always empty for SEC). */
	readonly scannedDays: readonly string[];
	/**
	 * The report of the stored business description, null when none is
	 * stored; its paragraphs are not read (the claim and the completion
	 * compare reports only).
	 */
	readonly describedReport: EquityDescriptionKey | null;
}

/** A company found by its listing, with its stored business description (the profile read). */
export interface EquityCompanyBusiness {
	readonly company: EquityCompanyRecord;
	readonly description: StoredEquityBusinessDescription | null;
}

/** One stored fact as the projection recompute and the revisions read use it. */
export interface StoredEquityFact {
	readonly filingId: string;
	readonly concept: string;
	readonly scope: EquityScope;
	readonly periodType: EquityPeriodType;
	/** Null for an instant (stored as ''). */
	readonly periodStart: string | null;
	readonly periodEnd: string;
	readonly unit: string;
	readonly fiscalYear: number;
	readonly metricCode: EquityMetricCode | null;
	readonly valueDecimal: string;
	/** The fact's filing's date, standard and primary scope (joined). */
	readonly filedOn: string;
	readonly accountingStandard: EquityAccountingStandard | null;
	readonly primaryScope: EquityScope | null;
}

/**
 * One `equity_metric_value` row's content (everything but `updated_at`):
 * a value with its source, or null with an unavailable reason.
 */
export interface EquityMetricValueContent {
	readonly metricCode: EquityMetricCode;
	readonly fiscalYear: number;
	readonly valueDecimal: string | null;
	readonly currency: string | null;
	readonly unavailableReason: EquityUnavailableReason | null;
	readonly filingId: string | null;
	readonly concept: string | null;
	readonly scope: EquityScope | null;
	readonly periodStart: string | null;
	readonly periodEnd: string | null;
	readonly derived: boolean;
	readonly reportedValueCount: number;
}

export interface StoredEquityMetricValue extends EquityMetricValueContent {
	readonly updatedAt: string;
}

/** A stored value with the filing it cites (null for an unavailable row). */
export interface EquityMetricValueWithFiling {
	readonly value: StoredEquityMetricValue;
	readonly filing: StoredEquityFiling | null;
}

/** A stored as-filed fact with its filing (the revisions read). */
export interface EquityFactWithFiling {
	readonly fact: StoredEquityFact;
	readonly filing: StoredEquityFiling;
}

/** What the claim-time scheduler learns in one query. */
export interface EquitySchedulerProbe {
	/** A `financial-sync` job is pending or leased. */
	readonly activeJob: boolean;
	/** The tracked company with the earliest `next_due_at <= now`, if any. */
	readonly dueCompanyId: string | null;
}

/** A tracked company's listing, without its sync state (one cheap read). */
export interface EquityTrackedListing {
	readonly companyId: string;
	readonly market: EquityMarket;
	readonly symbol: string;
}

export interface NewEquityCompany {
	readonly companyId: string;
	readonly market: EquityMarket;
	readonly symbol: string;
	readonly provider: EquityProvider;
	readonly name: string | null;
}

export type EquityTrackOutcome =
	| { readonly kind: "inserted" }
	| { readonly kind: "retracked"; readonly companyId: string }
	| { readonly kind: "already-tracked"; readonly companyId: string }
	| { readonly kind: "limit-reached" };

/** A filing row a completion inserts (`facts_status` decided by the service). */
export interface NewEquityFilingRow extends Omit<StoredEquityFiling, "companyId"> {
	readonly recordedAt: string;
}

/** A stored pending filing a completion moves to its final status. */
export interface FinalizedEquityFiling {
	readonly filingId: string;
	readonly factsStatus: "extracted" | "unavailable";
	readonly factCount: number;
	/** Set only where the stored standard is still null (a pending filing's standard is learnt with its facts). */
	readonly accountingStandard: EquityAccountingStandard | null;
	/** Non-null exactly when extracted (see `StoredEquityFiling.primaryScope`). */
	readonly primaryScope: EquityScope | null;
}

/** A fact row a completion inserts. */
export interface NewEquityFactRow {
	readonly filingId: string;
	readonly concept: string;
	readonly scope: EquityScope;
	readonly periodType: EquityPeriodType;
	readonly periodStart: string | null;
	readonly periodEnd: string;
	readonly unit: string;
	readonly fiscalYear: number;
	readonly metricCode: EquityMetricCode | null;
	readonly valueDecimal: string;
}

/** The sync state a successful completion writes. */
export interface EquitySyncSuccessState {
	readonly checkedAt: string;
	readonly morePending: boolean;
	readonly edinetPhase: EdinetScanPhase | null;
	readonly nextDueAt: string;
	/** Set when a value row changed; null keeps the stored time. */
	readonly dataUpdatedAt: string | null;
}

/**
 * How a job's end writes `next_due_at`: its own next time, unless the
 * company was re-tracked (it went back on the Watchlist, ADR-0054 §1) after
 * the job was created — `sync_requested_at` newer than `jobCreatedAt` — when
 * that time is kept if it is earlier. The re-track is thus not lost to the
 * job's later time, and the comparison needs nothing the job's creator
 * wrote (a scheduler job and an owner's retry are treated alike).
 */
export interface EquityJobSchedule {
	readonly jobCreatedAt: string;
}

/**
 * Everything a `financial-synced` completion writes besides the job row,
 * computed by the service from the stored rows (ADR-0048 §6) so the SQL is
 * a set of guarded inserts and upserts. Committed all or nothing with the job.
 */
export interface EquitySyncCompletionEffects {
	readonly kind: "synced";
	readonly companyId: string;
	/** Applied only where the stored source id is null (a resolved identity is never rewritten). */
	readonly identity: {
		readonly sourceCompanyId: string;
		readonly name: string | null;
		readonly fiscalYearEnd: string | null;
	} | null;
	readonly newFilings: readonly NewEquityFilingRow[];
	readonly finalizedFilings: readonly FinalizedEquityFiling[];
	readonly facts: readonly NewEquityFactRow[];
	/** Only rows whose content differs from the stored one. */
	readonly metricValues: readonly EquityMetricValueContent[];
	readonly scannedDays: readonly string[];
	/**
	 * The business description to store, null when the job read none or
	 * read a report older than the stored one (`descriptionReplaces`); the
	 * SQL upsert re-checks the order, so a concurrent write cannot regress it.
	 */
	readonly description: StoredEquityBusinessDescription | null;
	readonly state: EquitySyncSuccessState;
	readonly schedule: EquityJobSchedule;
	readonly at: string;
}

/** The sync state a job of the company ending in failure writes (ADR-0048 §6). */
export interface EquitySyncFailureEffects {
	readonly kind: "failed";
	readonly companyId: string;
	readonly failureCode: string;
	readonly failureUpstreamStatus: number | null;
	readonly consecutiveFailures: number;
	readonly nextDueAt: string;
	readonly schedule: EquityJobSchedule;
	readonly at: string;
}

export type EquitySyncEffects = EquitySyncCompletionEffects | EquitySyncFailureEffects;

export interface EquitySyncRepository {
	probe(ownerId: string, nowIso: string): Promise<EquitySchedulerProbe>;
	/** The listings of every tracked company (the Watchlist reconcile, ADR-0054 §1). */
	listTrackedListings(ownerId: string): Promise<readonly EquityTrackedListing[]>;
	/** Tracks a new listing, or re-tracks an untracked one (due at `at`), within `maxTracked`. */
	track(
		ownerId: string,
		company: NewEquityCompany,
		maxTracked: number,
		at: string,
	): Promise<EquityTrackOutcome>;
	/**
	 * Stops tracking: `untracked` when this call flipped `tracked`,
	 * `already-untracked` when it was not tracked (nothing written), or
	 * `not-found`.
	 */
	untrack(
		ownerId: string,
		companyId: string,
	): Promise<"untracked" | "already-untracked" | "not-found">;
	/** Writes the scheduler's decision for a company it did not queue (EDINET idle / not found). */
	reschedule(
		ownerId: string,
		companyId: string,
		patch: { readonly nextDueAt: string; readonly edinetPhase: EdinetScanPhase | null },
	): Promise<void>;
	/** One company or every tracked one (`companyId` null), oldest tracked first. */
	listSummaries(
		ownerId: string,
		filter: { readonly companyId: string | null },
	): Promise<readonly EquityCompanySummary[]>;
	findByListing(
		ownerId: string,
		market: EquityMarket,
		symbol: string,
	): Promise<EquityCompanyRecord | null>;
	/**
	 * The company of a listing with its stored business description, in one
	 * statement (the listing's unique index, then the description's primary
	 * key); null when the owner has no company for the listing.
	 */
	businessByListing(
		ownerId: string,
		market: EquityMarket,
		symbol: string,
	): Promise<EquityCompanyBusiness | null>;
	/** Another company of the owner holding this source id, if any. */
	findBySourceId(
		ownerId: string,
		provider: EquityProvider,
		sourceCompanyId: string,
	): Promise<EquityCompanyRecord | null>;
	claimContext(ownerId: string, companyId: string): Promise<EquityClaimContext | null>;
	/** The company's stored filings, newest filing date first (then filing id), at most `limit`. */
	listFilings(
		ownerId: string,
		companyId: string,
		limit: number,
	): Promise<readonly StoredEquityFiling[]>;
	/** Stored facts (with a metric code) of the given (metric, fiscal year) keys of one company. */
	factsOfKeys(
		ownerId: string,
		companyId: string,
		keys: readonly (readonly [EquityMetricCode, number])[],
	): Promise<readonly StoredEquityFact[]>;
	/** Stored metric rows of one company in the given fiscal years. */
	valuesOfYears(
		ownerId: string,
		companyId: string,
		fiscalYears: readonly number[],
	): Promise<readonly StoredEquityMetricValue[]>;
	/** The newest `limit` fiscal years having any stored (non-null) value, newest first. */
	valueYears(ownerId: string, companyId: string, limit: number): Promise<readonly number[]>;
	/** Stored rows of the metrics in the fiscal years, each with its cited filing. */
	valuesWithFilings(
		ownerId: string,
		companyId: string,
		metrics: readonly EquityMetricCode[],
		fiscalYears: readonly number[],
	): Promise<readonly EquityMetricValueWithFiling[]>;
	/** Every as-filed fact of one metric-year, newest filing first. */
	revisions(
		ownerId: string,
		companyId: string,
		metric: EquityMetricCode,
		fiscalYear: number,
		limit: number,
	): Promise<readonly EquityFactWithFiling[]>;
	/** Writes the sync state of a job that ended without a completion batch (claim-time retry ceiling or refusal). */
	recordFailure(ownerId: string, failure: EquitySyncFailureEffects): Promise<void>;
}
