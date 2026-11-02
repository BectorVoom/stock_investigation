/**
 * Storage ports of the annual financial statement sync (ADR-0048 §2): the
 * tracked companies, their filings, the as-filed facts, the authoritative
 * metric values and the sync schedule (migration 0021). The SQL adapter is
 * `packages/adapters/src/sql/equitySync.ts`; the completion's writes are
 * committed by `ResearchUnitOfWork.commitCompletion` in the job's guarded batch.
 * The business description of the newest annual report (ADR-0053,
 * migration 0022) is read and written beside them. Every directory stock is
 * tracked (ADR-0058 §3, migration 0026); a Japanese company syncs from
 * J-Quants like a US company from SEC (ADR-0059, migration 0027).
 */
import type { EquityBusinessDescription } from "@research/contracts";
import type {
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
	/** CIK (SEC) or the 5-character J-Quants issue code; null until a sync resolved it. */
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
	dataUpdatedAt: null,
};

/** A company with its schedule and the two aggregates its view shows. */
export interface EquityCompanySummary {
	readonly company: EquityCompanyRecord;
	readonly state: EquitySyncStateRecord;
	/** Newest fiscal year with a stored value (not an unavailable row). */
	readonly latestFiscalYear: number | null;
	readonly filingCount: number;
	/** The listing is on the Watchlist: checked every 24 h, else weekly (ADR-0058 §3). */
	readonly onWatchlist: boolean;
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
	/** When a sync first reported the filing (ISO-8601 UTC). */
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
	/** The listing is on the Watchlist (the 24 h cadence, ADR-0058 §3). */
	readonly onWatchlist: boolean;
	/** Every filing of the company, newest filing date first. */
	readonly filings: readonly StoredEquityFiling[];
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

/**
 * A directory stock the reconcile tracks next (ADR-0058 §3): one with no
 * company yet (`companyId` null), or whose company is untracked.
 */
export interface EquityDirectoryCandidate {
	readonly market: EquityMarket;
	readonly symbol: string;
	/** The directory's names (the English name; JP also the local name, when stated). */
	readonly name: string;
	readonly localName: string | null;
	readonly companyId: string | null;
	/** The listing is on the Watchlist (served first, `equityTrackDueAt`). */
	readonly onWatchlist: boolean;
}

/** A listing the reconcile tracks: a new company (its id generated) or an untracked one re-tracked. */
export interface EquityListingToTrack {
	readonly companyId: string;
	readonly market: EquityMarket;
	readonly symbol: string;
	readonly provider: EquityProvider;
	readonly name: string | null;
	/** The company row exists (untracked) and is re-tracked rather than inserted. */
	readonly existing: boolean;
	/**
	 * When the company is due (`equityTrackDueAt`): the batch's order a
	 * millisecond apart, a Watchlist stock a day earlier, so the
	 * never-checked queue (ordered by `next_due_at`) serves them in that
	 * order. Also its `sync_requested_at` (`EquityJobSchedule`).
	 */
	readonly dueAt: string;
}

/** What one tracking batch wrote. */
export interface EquityTrackBatchOutcome {
	readonly inserted: number;
	readonly retracked: number;
}

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
	readonly nextDueAt: string;
	/** Set when a value row changed; null keeps the stored time. */
	readonly dataUpdatedAt: string | null;
}

/**
 * How a job's end writes `next_due_at`: its own next time, unless the
 * company was re-tracked (its listing came back to the directory, ADR-0058
 * §3) after the job was created — `sync_requested_at` newer than
 * `jobCreatedAt` — when
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
	/**
	 * An untracked company whose source id (the same issuer) this company
	 * takes over — a renamed or re-listed ticker (ADR-0058 §3): its
	 * `source_company_id` is cleared, guarded on it being untracked still,
	 * before `identity` is applied. Its stored data stays with it. Null
	 * otherwise.
	 */
	readonly releasedIdentityOf: string | null;
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
	/**
	 * The due company of a claim: a never-checked one (`last_checked_at`
	 * null) before every company being refreshed, then by `next_due_at`
	 * (ADR-0058 §3).
	 */
	probe(ownerId: string, nowIso: string): Promise<EquitySchedulerProbe>;
	/**
	 * Up to `limit` directory stocks of both markets that are not tracked —
	 * no company, or an untracked one — Watchlist stocks first, then US
	 * before JP, then by symbol (ADR-0058 §3).
	 */
	untrackedDirectoryListings(
		ownerId: string,
		limit: number,
	): Promise<readonly EquityDirectoryCandidate[]>;
	/**
	 * Tracks the listings in one batch (`tracked_at` = `at`): inserts the new
	 * companies, re-tracks the untracked ones, and makes each due at its
	 * `dueAt`. A listing a concurrent reconcile tracked first is left alone.
	 */
	trackListings(
		ownerId: string,
		listings: readonly EquityListingToTrack[],
		at: string,
	): Promise<EquityTrackBatchOutcome>;
	/**
	 * Stops tracking up to `limit` tracked companies whose listing left its
	 * market's directory — only in a market whose directory is stored —
	 * and takes them off the schedule. Stored data stays. Answers how many.
	 */
	untrackDelisted(ownerId: string, limit: number): Promise<number>;
	/**
	 * Writes the scheduler's `next_due_at` for a company: held while its job
	 * runs, or delayed after the queue refused its job. Never records a check
	 * (a never-checked company stays never-checked until its job ends).
	 */
	reschedule(ownerId: string, companyId: string, nextDueAt: string): Promise<void>;
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
