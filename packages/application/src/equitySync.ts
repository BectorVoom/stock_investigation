/**
 * Annual financial statements synchronised from SEC EDGAR and EDINET
 * (ADR-0048): the claim-time scheduler, the `financial-sync` claim payload,
 * the `financial-synced` completion's writes, and the owner's reads behind
 * `/api/v1/equities/*`. Every stock of the owner's stock directory is
 * tracked (ADR-0058 §3): the claim-time reconcile tracks the directory in
 * batches, Watchlist stocks first, and stops tracking a company whose
 * listing left it; never-checked companies are synced before the rest. A
 * Japanese company downloads only the reports the shared EDINET index names
 * (ADR-0058 §4, `edinetIndex.ts`). No page tracks, untracks or syncs a
 * company.
 *
 * Correctness rules this module holds (ADR-0048 §5, §6):
 * - stored filings are never rewritten (only `facts_status` pending → final);
 * - facts are insert-only, and only for a filing whose facts were not recorded yet;
 * - the authoritative value of a (metric, fiscal year) is recomputed only for
 *   the keys new facts touch, from every stored fact of that key, and a row is
 *   written only when its content changed — so a sync that brings nothing new
 *   writes only the sync state;
 * - a value is never estimated: a missing or doubtful figure is a null cell
 *   with a reason;
 * - the stored business description (ADR-0053) is replaced only by one read
 *   from a report at least as new (`descriptionReplaces`).
 */
import type {
	CompleteJobRequest,
	EquityCompanyView,
	EquityFilingListItem,
	EquityFilingsResponse,
	EquityFilingView,
	EquityMetricCell,
	EquityMetricSeriesResponse,
	EquityPendingFiling,
	EquityRevisionsResponse,
	EquityStatementKind,
	EquityStatementResponse,
	EquitySyncRequest,
} from "@research/contracts";
import {
	EQUITY_FILINGS_READ_MAX,
	EQUITY_FINANCIAL_LIMITS,
	EQUITY_IDENTITY_CONFLICT_CODE,
	edinetCodeSchema,
	equitySyncClaimShape,
	secAccessionSchema,
	secCikSchema,
} from "@research/contracts";
import {
	annualFactsOfFiling,
	EMPTY_USAGE,
	EQUITY_ACCOUNTING_STANDARDS,
	EQUITY_CONCEPT_MAPPINGS,
	EQUITY_METRICS,
	EQUITY_PROVIDER_OF_MARKET,
	type EquityAccountingStandard,
	type EquityMarket,
	type EquityMetricCode,
	type EquityMetricSelection,
	type EquityProvider,
	type EquityReportedFact,
	type EquityScope,
	edinetSecuritiesCode,
	equityConceptsOfProvider,
	equityMetricDefinition,
	equityStatementMetrics,
	err,
	filingStaysPending,
	fiscalYearOfPeriodEnd,
	isAmendmentForm,
	isLeasedJobState,
	type JobState,
	ok,
	providerStandardHasMappings,
	type Result,
	selectFiscalYearMetrics,
	shiftIsoDateYears,
} from "@research/domain";
import { z } from "zod";
import type { SyncCheckGate } from "./dataSync.ts";
import type {
	EdinetIndexedReport,
	EquityClaimContext,
	EquityCompanySummary,
	EquityDescriptionKey,
	EquityEdinetPhase,
	EquityListingToTrack,
	EquityMetricValueContent,
	EquitySyncCompletionEffects,
	EquitySyncEffects,
	EquitySyncFailureEffects,
	EquitySyncRepository,
	EquitySyncStateRecord,
	FinalizedEquityFiling,
	NewEquityFactRow,
	NewEquityFilingRow,
	StoredEquityBusinessDescription,
	StoredEquityFact,
	StoredEquityFiling,
	StoredEquityMetricValue,
} from "./equitySyncPorts.ts";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	IdGenerator,
	JobRecord,
	JobRepository,
	StockDirectoryRepository,
} from "./ports.ts";
import { JOB_ADMISSION, MAX_JOB_ATTEMPTS } from "./researchRuns.ts";

/* ---------- Time ---------- */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** EDINET dates are Japan Standard Time (UTC+9, no daylight saving). */
const JST_OFFSET_MS = 9 * HOUR_MS;
/**
 * An answer that will not change soon is checked again after this long
 * (ADR-0058 §3): an identity conflict, a company SEC does not know or that
 * has no annual report, a Japanese company the EDINET index holds no report
 * for (the index makes it due as soon as one is listed).
 */
export const EQUITY_NOT_FOUND_RETRY_MS = EQUITY_FINANCIAL_LIMITS.notFoundRetryDays * DAY_MS;
/** A Watchlist company's cadence. */
const SYNC_INTERVAL_MS = EQUITY_FINANCIAL_LIMITS.syncIntervalHours * HOUR_MS;
/** Every other directory company's cadence (ADR-0058 §3). */
const DIRECTORY_SYNC_INTERVAL_MS = EQUITY_FINANCIAL_LIMITS.directorySyncIntervalHours * HOUR_MS;

/** How often a company is checked when nothing asks for it sooner: daily on the Watchlist, else weekly. */
export function equitySyncIntervalMs(onWatchlist: boolean): number {
	return onWatchlist ? SYNC_INTERVAL_MS : DIRECTORY_SYNC_INTERVAL_MS;
}

/**
 * Failure codes whose answer will not change on the next attempt: the issuer
 * is another tracked company's (GOOG / GOOGL, BRK-A / BRK-B), or SEC does not
 * know the ticker. Backed off `EQUITY_NOT_FOUND_RETRY_MS`, not 30 min × 2^n.
 */
const LONG_BACKOFF_FAILURE_CODES: ReadonlySet<string> = new Set([
	EQUITY_IDENTITY_CONFLICT_CODE,
	"FINANCIAL_COMPANY_NOT_FOUND",
]);
/**
 * A due company whose job the queue refused (the owner's unfinished-run cap,
 * or a sync queued by a concurrent claim) is looked at again after this
 * long: the cap frees only as other jobs finish, and retrying at every
 * runner poll (seconds apart) would re-read the company's filings each time
 * for nothing.
 */
export const EQUITY_REFUSED_JOB_RETRY_MS = 5 * MINUTE_MS;
/** Rows the revisions read returns at most (the response schema's bound). */
const MAX_REVISION_ROWS = 500;

function isoOfMs(ms: number): string {
	return new Date(ms).toISOString();
}

/**
 * The `next_due_at` the scheduler holds a company at while its job runs: a
 * day after the job was queued, so a job that ends without writing the
 * company's state (an owner's cancel) does not start again at once. Only a
 * safety net: the job's end writes the real next time, and a re-track
 * meanwhile is recognised by `sync_requested_at` (`EquityJobSchedule`).
 */
export function equitySyncHeldNextDueAt(jobCreatedAt: string): string {
	return isoOfMs(Date.parse(jobCreatedAt) + SYNC_INTERVAL_MS);
}

/** The UTC calendar date of an instant. */
export function utcDateOf(nowMs: number): string {
	return isoOfMs(nowMs).slice(0, 10);
}

/** The Japanese calendar date of an instant (EDINET lists documents by JST date). */
export function jstDateOf(nowMs: number): string {
	return isoOfMs(nowMs + JST_OFFSET_MS).slice(0, 10);
}

/**
 * Delay before a company is tried again after its `n`-th consecutive
 * terminal failure (ADR-0048 §6): 30 min × 2^(n−1), at most 24 h.
 */
export function equitySyncRetryDelayMs(consecutiveFailures: number): number {
	const n = Math.max(1, Math.floor(consecutiveFailures));
	// 2^6 × 30 min already exceeds 24 h; capping the exponent keeps the number exact.
	return Math.min(DAY_MS, 30 * MINUTE_MS * 2 ** Math.min(n - 1, 6));
}

/**
 * Delay before a company is tried again after a terminal failure with
 * `failureCode`: `EQUITY_NOT_FOUND_RETRY_MS` for an answer that will not
 * change (ADR-0058 §3), else `equitySyncRetryDelayMs`.
 */
export function equityFailureRetryDelayMs(
	failureCode: string,
	consecutiveFailures: number,
): number {
	return LONG_BACKOFF_FAILURE_CODES.has(failureCode)
		? EQUITY_NOT_FOUND_RETRY_MS
		: equitySyncRetryDelayMs(consecutiveFailures);
}

/* ---------- Views ---------- */

/** Where the company's sync stands (ADR-0048 §7). `activeJob` is its pending or leased job's state. */
export function equitySyncStatus(
	state: EquitySyncStateRecord,
	activeJob: JobState | null,
): EquityCompanyView["sync"]["status"] {
	if (activeJob !== null) return isLeasedJobState(activeJob) ? "running" : "queued";
	if (
		state.failureAt !== null &&
		(state.lastSucceededAt === null || state.failureAt > state.lastSucceededAt)
	) {
		return "failed";
	}
	return state.lastSucceededAt === null ? "never" : "succeeded";
}

export function equityCompanyView(
	summary: EquityCompanySummary,
	activeJob: JobState | null,
): EquityCompanyView {
	const { company, state } = summary;
	return {
		companyId: company.companyId,
		market: company.market,
		symbol: company.symbol,
		name: company.name,
		provider: company.provider,
		sourceCompanyId: company.sourceCompanyId,
		fiscalYearEnd: company.fiscalYearEnd,
		tracked: company.tracked,
		latestFiscalYear: summary.latestFiscalYear,
		filingCount: summary.filingCount,
		sync: {
			status: equitySyncStatus(state, activeJob),
			phase: state.edinetPhase,
			lastCheckedAt: state.lastCheckedAt,
			lastSucceededAt: state.lastSucceededAt,
			nextDueAt: state.nextDueAt,
			failure:
				state.failureCode === null || state.failureAt === null
					? null
					: {
							code: state.failureCode,
							upstreamStatus: state.failureUpstreamStatus,
							at: state.failureAt,
						},
		},
	};
}

export function equityFilingView(filing: StoredEquityFiling): EquityFilingView {
	return {
		filingId: filing.filingId,
		provider: filing.provider,
		sourceDocumentId: filing.sourceDocumentId,
		form: filing.form,
		isAmendment: isAmendmentForm(filing.form),
		filedOn: filing.filedOn,
		periodEnd: filing.periodEnd,
		accountingStandard: filing.accountingStandard,
		sourceUrl: filing.sourceUrl,
	};
}

export function equityFilingListItem(filing: StoredEquityFiling): EquityFilingListItem {
	return {
		...equityFilingView(filing),
		factsStatus: filing.factsStatus,
		factCount: filing.factCount,
		amendsSourceDocumentId: filing.amendsSourceDocumentId,
	};
}

/**
 * One cell from its stored row; no row reads as not reported (a derived
 * metric as not derivable, as `deriveFreeCashFlow` says of missing inputs) —
 * never as zero.
 */
export function equityMetricCell(
	metric: EquityMetricCode,
	fiscalYear: number,
	row: EquityMetricValueContent | undefined,
): EquityMetricCell {
	if (row === undefined) {
		const derived = equityMetricDefinition(metric).derived;
		return {
			fiscalYear,
			periodEnd: null,
			valueDecimal: null,
			currency: null,
			unavailableReason: derived ? "not-derivable" : "not-reported",
			filingId: null,
			concept: null,
			scope: null,
			derived,
			reportedValueCount: 0,
		};
	}
	return {
		fiscalYear,
		periodEnd: row.periodEnd,
		valueDecimal: row.valueDecimal,
		currency: row.valueDecimal === null ? null : row.currency,
		unavailableReason: row.valueDecimal === null ? row.unavailableReason : null,
		filingId: row.valueDecimal === null ? null : row.filingId,
		concept: row.concept,
		scope: row.scope,
		derived: row.derived,
		reportedValueCount: row.reportedValueCount,
	};
}

const valueKey = (metric: EquityMetricCode, fiscalYear: number) => `${metric}|${fiscalYear}`;

/**
 * Shapes a statement or series read: one row per metric with one cell per
 * fiscal year (oldest first), and every filing a cell cites, newest first.
 * Pure (benchmarked in `scripts/bench.ts`).
 */
export function shapeEquityRows(
	metrics: readonly EquityMetricCode[],
	fiscalYears: readonly number[],
	stored: readonly {
		readonly value: StoredEquityMetricValue;
		readonly filing: StoredEquityFiling | null;
	}[],
): {
	readonly rows: { readonly metric: EquityMetricCode; readonly cells: EquityMetricCell[] }[];
	readonly filings: EquityFilingView[];
} {
	const byKey = new Map<string, StoredEquityMetricValue>();
	const cited = new Map<string, StoredEquityFiling>();
	for (const entry of stored) {
		byKey.set(valueKey(entry.value.metricCode, entry.value.fiscalYear), entry.value);
	}
	const rows = metrics.map((metric) => ({
		metric,
		cells: fiscalYears.map((year) => {
			const cell = equityMetricCell(metric, year, byKey.get(valueKey(metric, year)));
			return cell;
		}),
	}));
	for (const entry of stored) {
		if (
			entry.filing !== null &&
			entry.value.valueDecimal !== null &&
			fiscalYears.includes(entry.value.fiscalYear) &&
			metrics.includes(entry.value.metricCode)
		) {
			cited.set(entry.filing.filingId, entry.filing);
		}
	}
	const filings = [...cited.values()]
		.sort((a, b) =>
			a.filedOn === b.filedOn
				? b.filingId.localeCompare(a.filingId)
				: b.filedOn.localeCompare(a.filedOn),
		)
		.map(equityFilingView);
	return { rows, filings };
}

/* ---------- The completion: filings, facts and the touched values ---------- */

/**
 * A stored filing's id: unique per company, not per document — SEC
 * co-registrants file one accession for several issuers, and each tracked
 * company keeps its own copy of what it filed. Within `idSchema`'s 96
 * characters: a generated company id (≤ 28), the provider and a document id
 * (≤ 20 for an accession, 8 for a docID).
 */
export function equityFilingId(
	companyId: string,
	provider: "sec" | "edinet",
	sourceDocumentId: string,
): string {
	return `${companyId}:${provider}:${sourceDocumentId}`;
}

type FinancialSyncedRequest = Extract<CompleteJobRequest, { outcome: "financial-synced" }>;
type CompletionFiling = FinancialSyncedRequest["filings"][number];

/** A fact row about to be inserted, with its filing's date, standard and primary scope (for the recompute). */
export interface PlannedEquityFact extends NewEquityFactRow {
	readonly filedOn: string;
	readonly accountingStandard: EquityAccountingStandard | null;
	readonly primaryScope: EquityScope;
}

export interface CompletionFilingPlan {
	readonly newFilings: readonly NewEquityFilingRow[];
	readonly finalizedFilings: readonly FinalizedEquityFiling[];
	readonly facts: readonly PlannedEquityFact[];
	/** (metric, fiscal year) keys whose authoritative value may change. */
	readonly touchedKeys: readonly (readonly [EquityMetricCode, number])[];
	/** Fiscal years an extracted filing under a standard without mappings covers (stored or new). */
	readonly unmappedYears: ReadonlySet<number>;
	/** A filing the runner deferred waits for the next job. */
	readonly deferredWaiting: boolean;
	/** Facts dropped as not annual or invalid, and exact repeats within one filing. */
	readonly droppedFacts: number;
	/** Filings already stored under another company (never re-assigned; defensive). */
	readonly foreignFilings: number;
}

const FREE_CASH_FLOW_INPUTS: readonly EquityMetricCode[] = [
	"net-cash-from-operating-activities",
	"capital-expenditures",
];

/**
 * Whether a provider's filing under `standard` has no reviewed mappings
 * (`providerStandardHasMappings`, per provider since ADR-0058 §5: SEC maps
 * US GAAP and IFRS, EDINET JGAAP only).
 */
function isUnmappedStandard(
	provider: EquityProvider,
	standard: EquityAccountingStandard | null,
): boolean {
	return standard !== null && !providerStandardHasMappings(provider, standard);
}

/**
 * The metric each (provider, standard, concept, scope) measures, built once from the
 * registry: a completion maps up to 3,000 facts, and scanning the mapping
 * list for each was the planner's largest cost.
 */
const METRIC_OF_CONCEPT: ReadonlyMap<string, EquityMetricCode> = (() => {
	const index = new Map<string, EquityMetricCode>();
	for (const mapping of EQUITY_CONCEPT_MAPPINGS) {
		for (const scope of ["consolidated", "separate"] as const) {
			if (mapping.scope !== "any" && mapping.scope !== scope) continue;
			const key = `${mapping.provider}|${mapping.standard}|${mapping.concept}|${scope}`;
			// The first mapping in registry order wins, as `equityMappingsOfConcept` lists them.
			if (!index.has(key)) index.set(key, mapping.metric);
		}
	}
	return index;
})();

/** The metric a provider's concept measures under a standard and scope, if a reviewed mapping says so. */
function metricOfConcept(
	provider: EquityProvider,
	standard: EquityAccountingStandard | null,
	concept: string,
	scope: EquityScope,
): EquityMetricCode | null {
	if (standard === null || !providerStandardHasMappings(provider, standard)) return null;
	return METRIC_OF_CONCEPT.get(`${provider}|${standard}|${concept}|${scope}`) ?? null;
}

const factKey = (fact: {
	readonly filingId: string;
	readonly concept: string;
	readonly scope: string;
	readonly periodType: string;
	readonly periodStart: string | null;
	readonly periodEnd: string;
	readonly unit: string;
	readonly valueDecimal: string;
}) =>
	`${fact.filingId}|${fact.concept}|${fact.scope}|${fact.periodType}|${fact.periodStart ?? ""}|${fact.periodEnd}|${fact.unit}|${fact.valueDecimal}`;

/**
 * The annual facts of one extracted filing as rows (ADR-0048 §4), and the
 * filing's primary scope. The API re-applies `annualFactsOfFiling` (the
 * runner is not trusted to have). An exact repeat of a fact collapses; a key
 * the filing reports with two different values keeps both rows (the value
 * is part of the stored key), so the selection sees the conflict and
 * answers `ambiguous` — dropping both would let an older filing or a
 * lower-ranked concept stand in for a figure this filing superseded.
 * The primary scope is consolidated when the filing reports any
 * consolidated fact, else separate (a filer without subsidiaries).
 */
export function equityFactRows(
	filingId: string,
	provider: EquityProvider,
	facts: CompletionFiling["facts"],
	standard: EquityAccountingStandard | null,
	filing: { readonly filedOn: string },
): {
	readonly rows: readonly PlannedEquityFact[];
	readonly dropped: number;
	readonly primaryScope: EquityScope;
} {
	const kept = annualFactsOfFiling(facts).kept;
	const byKey = new Map<string, Omit<PlannedEquityFact, "primaryScope">>();
	let consolidated = false;
	// A filing repeats a handful of period ends across its facts.
	const fiscalYears = new Map<string, number | null>();
	for (const fact of kept) {
		let fiscalYear = fiscalYears.get(fact.periodEnd);
		if (fiscalYear === undefined) {
			fiscalYear = fiscalYearOfPeriodEnd(fact.periodEnd);
			fiscalYears.set(fact.periodEnd, fiscalYear);
		}
		if (fiscalYear === null) continue;
		const row = {
			filingId,
			concept: fact.concept,
			scope: fact.scope,
			periodType: fact.periodType,
			periodStart: fact.periodType === "instant" ? null : fact.periodStart,
			periodEnd: fact.periodEnd,
			unit: fact.unit,
			fiscalYear,
			metricCode: metricOfConcept(provider, standard, fact.concept, fact.scope),
			valueDecimal: fact.valueDecimal,
			filedOn: filing.filedOn,
			accountingStandard: standard,
		};
		const key = factKey(row);
		if (byKey.has(key)) continue;
		byKey.set(key, row);
		if (row.scope === "consolidated") consolidated = true;
	}
	const primaryScope: EquityScope = consolidated ? "consolidated" : "separate";
	const rows: PlannedEquityFact[] = [];
	for (const row of byKey.values()) rows.push({ ...row, primaryScope });
	return { rows, dropped: facts.length - rows.length, primaryScope };
}

/**
 * Decides what a completion's filings write (ADR-0048 §6), from the stored
 * filings of the company (and any stored filing with one of the ids):
 * - a filing stored with a final status is left alone (its facts too);
 * - a new filing is inserted: extracted, or pending when deferred or when it
 *   is not available yet but within `pendingFilingGraceDays` (SEC: of its
 *   filing date; EDINET: of when a sync first saw it), else unavailable;
 * - a stored pending filing moves to extracted / unavailable, never back;
 * - facts come only from filings whose facts are recorded now.
 */
export function planCompletionFilings(input: {
	readonly companyId: string;
	readonly provider: "sec" | "edinet";
	readonly stored: ReadonlyMap<string, StoredEquityFiling>;
	readonly filings: readonly CompletionFiling[];
	readonly todayUtc: string;
	readonly at: string;
}): CompletionFilingPlan {
	const newFilings: NewEquityFilingRow[] = [];
	const finalizedFilings: FinalizedEquityFiling[] = [];
	const facts: PlannedEquityFact[] = [];
	const touched = new Map<string, readonly [EquityMetricCode, number]>();
	const touch = (metric: EquityMetricCode, year: number) => {
		touched.set(valueKey(metric, year), [metric, year]);
	};
	const unmappedYears = new Set<number>();
	let deferredWaiting = false;
	let droppedFacts = 0;
	let foreignFilings = 0;

	for (const stored of input.stored.values()) {
		if (stored.companyId !== input.companyId) continue;
		if (
			stored.factsStatus === "extracted" &&
			isUnmappedStandard(stored.provider, stored.accountingStandard)
		) {
			const year = fiscalYearOfPeriodEnd(stored.periodEnd);
			if (year !== null) unmappedYears.add(year);
		}
	}

	for (const filing of input.filings) {
		const filingId = equityFilingId(input.companyId, input.provider, filing.sourceDocumentId);
		const stored = input.stored.get(filingId);
		if (stored !== undefined && stored.companyId !== input.companyId) {
			foreignFilings += 1;
			continue;
		}
		if (stored !== undefined && stored.factsStatus !== "pending") continue;
		const newRow = (
			factsStatus: NewEquityFilingRow["factsStatus"],
			factCount: number,
			primaryScope: EquityScope | null,
		): NewEquityFilingRow => ({
			filingId,
			provider: input.provider,
			sourceDocumentId: filing.sourceDocumentId,
			form: filing.form,
			filedOn: filing.filedOn,
			submittedAt: filing.submittedAt,
			periodStart: filing.periodStart,
			periodEnd: filing.periodEnd,
			accountingStandard: filing.accountingStandard,
			amendsSourceDocumentId: filing.amendsSourceDocumentId,
			sourceUrl: filing.sourceUrl,
			factsStatus,
			factCount,
			primaryScope,
			firstSeenAt: input.at,
			recordedAt: input.at,
		});
		if (filing.factsStatus === "deferred") {
			deferredWaiting = true;
			if (stored === undefined) newFilings.push(newRow("pending", 0, null));
			continue;
		}
		if (filing.factsStatus === "not-available") {
			// How long it stays pending (offered again) before it is final:
			// - SEC: 7 days from the stored filing date. Company facts lag a
			//   new filing; an old 10-K without facts stays without them, and
			//   offering it again would download the company facts every day.
			// - EDINET: 7 days from when a sync first saw it. Not available
			//   there also means a download that could not be read (a broken
			//   ZIP, an HTML page), which can be transient — an old report
			//   found by a backfill must get its retries too.
			const graceFrom =
				input.provider === "edinet"
					? (stored?.firstSeenAt.slice(0, 10) ?? input.todayUtc)
					: (stored?.filedOn ?? filing.filedOn);
			const final = !filingStaysPending(graceFrom, input.todayUtc);
			if (stored === undefined) {
				newFilings.push(newRow(final ? "unavailable" : "pending", 0, null));
			} else if (final) {
				finalizedFilings.push({
					filingId,
					factsStatus: "unavailable",
					factCount: 0,
					accountingStandard: null,
					primaryScope: null,
				});
			}
			continue;
		}
		const standard = stored?.accountingStandard ?? filing.accountingStandard;
		const extracted = equityFactRows(filingId, input.provider, filing.facts, standard, {
			filedOn: stored?.filedOn ?? filing.filedOn,
		});
		droppedFacts += extracted.dropped;
		if (stored === undefined) {
			newFilings.push(newRow("extracted", extracted.rows.length, extracted.primaryScope));
		} else {
			finalizedFilings.push({
				filingId,
				factsStatus: "extracted",
				factCount: extracted.rows.length,
				accountingStandard: filing.accountingStandard,
				primaryScope: extracted.primaryScope,
			});
		}
		for (const row of extracted.rows) {
			facts.push(row);
			if (row.metricCode !== null) touch(row.metricCode, row.fiscalYear);
		}
		if (isUnmappedStandard(input.provider, standard)) {
			// Filings under a standard without reviewed mappings say so for
			// every metric of their year (ADR-0048 §3): never a guessed value.
			const year = fiscalYearOfPeriodEnd(stored?.periodEnd ?? filing.periodEnd);
			if (year !== null) {
				unmappedYears.add(year);
				for (const definition of EQUITY_METRICS) {
					if (!definition.derived) touch(definition.code, year);
				}
			}
		}
	}
	for (const [metric, year] of [...touched.values()]) {
		if (FREE_CASH_FLOW_INPUTS.includes(metric)) touch("free-cash-flow", year);
	}
	return {
		newFilings,
		finalizedFilings,
		facts,
		touchedKeys: [...touched.values()],
		unmappedYears,
		deferredWaiting,
		droppedFacts,
		foreignFilings,
	};
}

/** The (metric, year) keys whose stored facts a recompute of `touchedKeys` reads. */
export function equityReadKeys(
	touchedKeys: readonly (readonly [EquityMetricCode, number])[],
): (readonly [EquityMetricCode, number])[] {
	const keys = new Map<string, readonly [EquityMetricCode, number]>();
	for (const [metric, year] of touchedKeys) {
		const inputs = equityMetricDefinition(metric).derived ? FREE_CASH_FLOW_INPUTS : [metric];
		for (const input of inputs) keys.set(valueKey(input, year), [input, year]);
	}
	return [...keys.values()];
}

/** The row content of a selection. */
export function metricValueContent(
	metric: EquityMetricCode,
	fiscalYear: number,
	selection: EquityMetricSelection,
): EquityMetricValueContent {
	const derived = equityMetricDefinition(metric).derived;
	if (selection.kind === "unavailable") {
		return {
			metricCode: metric,
			fiscalYear,
			valueDecimal: null,
			currency: null,
			unavailableReason: selection.reason,
			filingId: null,
			concept: null,
			scope: null,
			periodStart: null,
			periodEnd: null,
			derived,
			reportedValueCount: 0,
		};
	}
	return {
		metricCode: metric,
		fiscalYear,
		valueDecimal: selection.valueDecimal,
		currency: selection.currency,
		unavailableReason: null,
		filingId: selection.filingId,
		concept: selection.concept,
		scope: selection.scope,
		periodStart: selection.periodStart,
		periodEnd: selection.periodEnd,
		derived,
		reportedValueCount: selection.reportedValueCount,
	};
}

export function sameMetricValueContent(
	a: EquityMetricValueContent,
	b: EquityMetricValueContent,
): boolean {
	return (
		a.metricCode === b.metricCode &&
		a.fiscalYear === b.fiscalYear &&
		a.valueDecimal === b.valueDecimal &&
		a.currency === b.currency &&
		a.unavailableReason === b.unavailableReason &&
		a.filingId === b.filingId &&
		a.concept === b.concept &&
		a.scope === b.scope &&
		a.periodStart === b.periodStart &&
		a.periodEnd === b.periodEnd &&
		a.derived === b.derived &&
		a.reportedValueCount === b.reportedValueCount
	);
}

/**
 * Per provider, a standard that stands for "an extracted filing under a
 * standard without mappings covers this year" (EDINET: US-GAAP). Mapping
 * availability is per provider, so one global unmapped standard would vanish
 * once any provider maps it (SEC maps IFRS) and EDINET's IFRS filers would
 * read `not-reported`. A provider whose filings are all mapped has none — and
 * then no unmapped year either (`isUnmappedStandard`).
 */
const UNMAPPED_STANDARD: { readonly [P in EquityProvider]: EquityAccountingStandard | undefined } =
	{
		sec: EQUITY_ACCOUNTING_STANDARDS.find(
			(standard) => !providerStandardHasMappings("sec", standard),
		),
		edinet: EQUITY_ACCOUNTING_STANDARDS.find(
			(standard) => !providerStandardHasMappings("edinet", standard),
		),
	};

/**
 * The value rows a sync writes (ADR-0048 §5): for each touched key, the
 * selection over every stored fact of that key plus the new ones; only rows
 * whose content differs from the stored row. A key with no stored row and
 * nothing to say (no mapped fact, no unmapped filing; for free cash flow,
 * neither input a value) stays absent — absent reads as not reported, so
 * writing it would change nothing visible.
 */
export function recomputeEquityValues(input: {
	/** The company's provider: its reviewed mappings decide which standards are mapped. */
	readonly provider: EquityProvider;
	readonly touchedKeys: readonly (readonly [EquityMetricCode, number])[];
	readonly unmappedYears: ReadonlySet<number>;
	readonly storedFacts: readonly StoredEquityFact[];
	readonly newFacts: readonly PlannedEquityFact[];
	readonly storedValues: readonly EquityMetricValueContent[];
}): EquityMetricValueContent[] {
	const byYear = new Map<number, Map<string, EquityReportedFact>>();
	const mappedMetrics = new Set<string>();
	const add = (fact: StoredEquityFact | PlannedEquityFact) => {
		if (fact.metricCode === null || fact.accountingStandard === null) return;
		// Only the filing's primary scope feeds the selection: a consolidated
		// filing's separate (parent-only) facts stay as-filed history, so a
		// metric its consolidated statements lack reads not reported rather
		// than a parent-only figure beside consolidated ones.
		if (fact.scope !== fact.primaryScope) return;
		let facts = byYear.get(fact.fiscalYear);
		if (facts === undefined) {
			facts = new Map();
			byYear.set(fact.fiscalYear, facts);
		}
		const key = factKey(fact);
		// A stored fact wins over a new one with the same key (insert does nothing).
		if (facts.has(key)) return;
		facts.set(key, {
			filingId: fact.filingId,
			filedOn: fact.filedOn,
			standard: fact.accountingStandard,
			concept: fact.concept,
			scope: fact.scope,
			unit: fact.unit,
			valueDecimal: fact.valueDecimal,
			periodStart: fact.periodStart,
			periodEnd: fact.periodEnd,
		});
		mappedMetrics.add(valueKey(fact.metricCode, fact.fiscalYear));
	};
	for (const fact of input.storedFacts) add(fact);
	for (const fact of input.newFacts) add(fact);

	const stored = new Map<string, EquityMetricValueContent>();
	for (const row of input.storedValues) stored.set(valueKey(row.metricCode, row.fiscalYear), row);

	const selectionsByYear = new Map<number, ReadonlyMap<EquityMetricCode, EquityMetricSelection>>();
	const selectionsOf = (year: number) => {
		const cached = selectionsByYear.get(year);
		if (cached !== undefined) return cached;
		const facts = [...(byYear.get(year)?.values() ?? [])];
		const unmapped = UNMAPPED_STANDARD[input.provider];
		if (input.unmappedYears.has(year) && unmapped !== undefined) {
			// `selectMetricValue` only notes that such a filing exists.
			facts.push({
				filingId: "",
				filedOn: "",
				standard: unmapped,
				concept: "",
				scope: "consolidated",
				unit: "",
				valueDecimal: "0",
				periodStart: null,
				periodEnd: "",
			});
		}
		const selections = selectFiscalYearMetrics(facts, input.provider);
		selectionsByYear.set(year, selections);
		return selections;
	};

	const changed: EquityMetricValueContent[] = [];
	const sorted = [...input.touchedKeys].sort((a, b) =>
		a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1],
	);
	for (const [metric, year] of sorted) {
		const selections = selectionsOf(year);
		const selection = selections.get(metric);
		if (selection === undefined) continue;
		const content = metricValueContent(metric, year, selection);
		const previous = stored.get(valueKey(metric, year));
		if (previous === undefined) {
			const evidence = equityMetricDefinition(metric).derived
				? FREE_CASH_FLOW_INPUTS.some((input) => selections.get(input)?.kind === "value")
				: mappedMetrics.has(valueKey(metric, year)) || input.unmappedYears.has(year);
			if (!evidence) continue;
		} else if (sameMetricValueContent(previous, content)) continue;
		changed.push(content);
	}
	return changed;
}

/* ---------- The claim ---------- */

const claimFieldsSchema = z.strictObject(equitySyncClaimShape);
export type EquitySyncClaimFields = z.infer<typeof claimFieldsSchema>;

/** Why a queued `financial-sync` job is ended at claim time instead of leased. */
export interface EquityClaimRefusal {
	readonly state: "failed" | "cancelled";
	/** Audit reason (fixed text). */
	readonly reason: string;
}

function pendingFilingOf(filing: StoredEquityFiling): EquityPendingFiling {
	return {
		sourceDocumentId: filing.sourceDocumentId,
		form: filing.form,
		filedOn: filing.filedOn,
		submittedAt: filing.submittedAt,
		periodStart: filing.periodStart,
		periodEnd: filing.periodEnd,
		amendsSourceDocumentId: filing.amendsSourceDocumentId,
		sourceUrl: filing.sourceUrl,
	};
}

/* ---------- The shared EDINET index (ADR-0058 §4) ---------- */

/**
 * A filing's public page in the EDINET viewer — the same URL the runners
 * build for a listed document (`edinetViewerUrl` in
 * `packages/adapters/src/finance/edinetDocuments.ts`, and the Rust runner's
 * mirror); a link only, never fetched.
 */
export function edinetViewerUrlOf(docId: string): string {
	return `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${docId}`;
}

/** What the shared EDINET index holds for a Japanese company that is not stored yet. */
export interface EdinetIndexedPlan {
	/**
	 * Indexed reports of the company's securities code that are not stored,
	 * oldest submission first, as the claim's `indexedFilings` (at most
	 * `maxPendingFilings`).
	 */
	readonly filings: readonly EquityPendingFiling[];
	/** More unstored reports than one claim names: the next job follows at once. */
	readonly more: boolean;
	/** "not-found": neither the index nor the store holds a report of the company. */
	readonly phase: Extract<EquityEdinetPhase, "idle" | "not-found">;
	/** The filer code the index states for the company (its newest report), or null. */
	readonly edinetCode: string | null;
}

/**
 * The index's unstored reports of one company (ADR-0058 §4). An original
 * report (120) carries its own period; an amendment (130), whose EDINET row
 * states none, takes its original's — the stored filing, else the original's
 * index row. An amendment whose original neither holds is left out (it
 * would be named and never downloadable). The filing date is the
 * submission's date in Japan, as the runners take it from the day list.
 */
export function edinetIndexedPlan(context: EquityClaimContext): EdinetIndexedPlan {
	const stored = new Map<string, StoredEquityFiling>();
	for (const filing of context.filings) stored.set(filing.sourceDocumentId, filing);
	const indexed = new Map<string, EdinetIndexedReport>();
	for (const report of context.indexedReports) indexed.set(report.docId, report);
	const unstored: EquityPendingFiling[] = [];
	for (const report of context.indexedReports) {
		if (stored.has(report.docId)) continue;
		let period: { readonly periodStart: string | null; readonly periodEnd: string } | null = null;
		if (report.periodEnd !== null) {
			period = { periodStart: report.periodStart, periodEnd: report.periodEnd };
		} else if (report.parentDocId !== null) {
			const original = stored.get(report.parentDocId) ?? indexed.get(report.parentDocId);
			if (original !== undefined && original.periodEnd !== null) {
				period = { periodStart: original.periodStart, periodEnd: original.periodEnd };
			}
		}
		const submittedMs = Date.parse(report.submittedAt);
		if (period === null || !Number.isFinite(submittedMs)) continue;
		unstored.push({
			sourceDocumentId: report.docId,
			form: report.docTypeCode === "120" ? "securities-report" : "amended-securities-report",
			filedOn: jstDateOf(submittedMs),
			submittedAt: report.submittedAt,
			...period,
			amendsSourceDocumentId: report.parentDocId,
			sourceUrl: edinetViewerUrlOf(report.docId),
		});
	}
	const max = EQUITY_FINANCIAL_LIMITS.maxPendingFilings;
	return {
		filings: unstored.slice(0, max),
		more: unstored.length > max,
		phase:
			context.indexedReports.length === 0 && context.filings.length === 0 ? "not-found" : "idle",
		edinetCode: context.indexedReports.at(-1)?.edinetCode ?? null,
	};
}

/**
 * How long after a successful `financial-synced` completion the company is
 * due again (ADR-0058 §3), from the rows before it (`context`) and what it
 * writes (`plan`):
 * - at once when work is left: the runner said `more`, deferred a filing,
 *   or the index holds more unstored reports than the claim named;
 * - `notFoundRetryDays` when the company has no annual report at all (SEC:
 *   none stored or found — funds, SPACs; EDINET: the index holds none);
 * - 24 h while a filing waits as pending (its facts may come within the
 *   grace) or the company is on the Watchlist, else weekly.
 */
export function equityCompletionDelayMs(
	context: EquityClaimContext,
	plan: Pick<CompletionFilingPlan, "newFilings" | "finalizedFilings" | "deferredWaiting">,
	more: boolean,
): number {
	const indexedMore = context.company.provider === "edinet" && edinetIndexedPlan(context).more;
	if (more || plan.deferredWaiting || indexedMore) return 0;
	const noReport =
		context.filings.length === 0 &&
		plan.newFilings.length === 0 &&
		(context.company.provider === "sec" || context.indexedReports.length === 0);
	if (noReport) return EQUITY_NOT_FOUND_RETRY_MS;
	const finalized = new Set(plan.finalizedFilings.map((filing) => filing.filingId));
	const pendingAfter =
		plan.newFilings.some((filing) => filing.factsStatus === "pending") ||
		context.filings.some(
			(filing) => filing.factsStatus === "pending" && !finalized.has(filing.filingId),
		);
	return pendingAfter ? SYNC_INTERVAL_MS : equitySyncIntervalMs(context.onWatchlist);
}

/* ---------- The business description (ADR-0053 §2) ---------- */

/** Orders two reports by period end, then filing date, then document id (as text, like the SQL). */
export function compareDescriptionKeys(a: EquityDescriptionKey, b: EquityDescriptionKey): number {
	const pairs: readonly (readonly [string, string])[] = [
		[a.periodEnd, b.periodEnd],
		[a.filedOn, b.filedOn],
		[a.sourceDocumentId, b.sourceDocumentId],
	];
	for (const [left, right] of pairs) {
		if (left !== right) return left < right ? -1 : 1;
	}
	return 0;
}

/**
 * A description read from `incoming` is stored when none is, or when its
 * report is at least as new as the stored one's: an EDINET backfill of older
 * reports never replaces the newest description.
 */
export function descriptionReplaces(
	stored: EquityDescriptionKey | null,
	incoming: EquityDescriptionKey,
): boolean {
	return stored === null || compareDescriptionKeys(incoming, stored) >= 0;
}

/**
 * The EDINET report whose 事業の内容 the runner should read: the newest
 * stored annual securities report, when no description is stored or that
 * report is newer than the described one; else null.
 */
export function describeFilingOf(
	filings: readonly StoredEquityFiling[],
	described: EquityDescriptionKey | null,
): EquityPendingFiling | null {
	let newest: StoredEquityFiling | null = null;
	for (const filing of filings) {
		if (filing.form !== "securities-report") continue;
		if (newest === null || compareDescriptionKeys(filing, newest) > 0) newest = filing;
	}
	if (newest === null) return null;
	if (
		described !== null &&
		(newest.sourceDocumentId === described.sourceDocumentId ||
			compareDescriptionKeys(newest, described) <= 0)
	) {
		return null;
	}
	return pendingFilingOf(newest);
}

/** The provider part of a claim, from the stored rows (ADR-0048 §6). */
export function equitySyncRequestOf(context: EquityClaimContext, nowMs: number): EquitySyncRequest {
	const { company, filings } = context;
	// Filings are read newest first, so the caps keep the newest.
	const settled = filings
		.filter((filing) => filing.factsStatus !== "pending")
		.slice(0, EQUITY_FINANCIAL_LIMITS.maxKnownFilings);
	const pending = filings
		.filter((filing) => filing.factsStatus === "pending")
		.slice(0, EQUITY_FINANCIAL_LIMITS.maxPendingFilings)
		.map(pendingFilingOf);
	if (company.provider === "sec") {
		const today = utcDateOf(nowMs);
		const cik = secCikSchema.safeParse(company.sourceCompanyId);
		// A stored id that is not an accession (never written so) asks again.
		const described = secAccessionSchema.safeParse(context.describedReport?.sourceDocumentId);
		return {
			provider: "sec",
			cik: cik.success ? cik.data : null,
			knownAccessions: settled.map((filing) => filing.sourceDocumentId),
			pendingFilings: pending,
			filedSince: shiftIsoDateYears(today, -EQUITY_FINANCIAL_LIMITS.backfillYears) ?? today,
			fullCheck: filings.length === 0 || context.state.morePending,
			describedDocumentId: described.success ? described.data : null,
		};
	}
	const indexed = edinetIndexedPlan(context);
	// The resolved filer code; else the index's, so the first sync resolves the company.
	const edinetCode = edinetCodeSchema.safeParse(company.sourceCompanyId ?? indexed.edinetCode);
	return {
		provider: "edinet",
		secCode: edinetSecuritiesCode(company.symbol),
		edinetCode: edinetCode.success ? edinetCode.data : null,
		// With their stored periods: an amendment's list row has none, it takes its original's.
		knownFilings: settled.map((filing) => ({
			docId: filing.sourceDocumentId,
			periodStart: filing.periodStart,
			periodEnd: filing.periodEnd,
		})),
		pendingFilings: pending,
		indexedFilings: [...indexed.filings],
		describeFiling: describeFilingOf(filings, context.describedReport),
	};
}

/* ---------- The service ---------- */

export interface EquitySyncServiceDeps {
	readonly equitySync: EquitySyncRepository;
	readonly jobs: Pick<JobRepository, "insert" | "findActiveByKind">;
	/** Which markets' directories are stored, and when (the reconcile's change signal). */
	readonly stockDirectory: Pick<StockDirectoryRepository, "listMeta">;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly audit: AuditLog;
	/**
	 * Track every directory stock at claim time (ADR-0058 §3); off with
	 * `SERVER_DATA_SYNC=off` and in the API tests unless a test opts in.
	 */
	readonly trackDirectory: boolean;
	/** How often one owner's reconcile is considered at most (claims in between skip it). */
	readonly gate: SyncCheckGate;
	/**
	 * The directory signature an owner's last complete reconcile saw: while
	 * the stored directories are unchanged nothing can need tracking, so the
	 * directory is not scanned again. Lives for an isolate; losing it costs
	 * one extra reconcile.
	 */
	readonly reconciled: OwnerMemo;
	/** A scheduler decision worth an operator's attention (codes and ids only). */
	readonly log: (event: string, fields: Readonly<Record<string, string | number>>) => void;
}

/** A small per-owner memo that lives for an isolate (a Worker) or a process. */
export interface OwnerMemo {
	get(ownerId: string): string | null;
	set(ownerId: string, value: string): void;
}

/** Bound on remembered owners; the app has one owner, tests a few. */
const MEMO_MAX_OWNERS = 1_000;

export function createOwnerMemo(): OwnerMemo {
	const values = new Map<string, string>();
	return {
		get: (ownerId) => values.get(ownerId) ?? null,
		set(ownerId, value) {
			if (!values.has(ownerId) && values.size >= MEMO_MAX_OWNERS) values.clear();
			values.set(ownerId, value);
		},
	};
}

/** What one reconcile changed; null when it did not run (no stored directory, or none changed). */
export interface EquityReconcileOutcome {
	readonly tracked: number;
	readonly retracked: number;
	readonly untracked: number;
	/** Every untracked directory stock was tracked and every delisted company untracked. */
	readonly complete: boolean;
}

/** What one claim-time pass did. */
export type EquityMaterializeOutcome =
	| { readonly kind: "idle" }
	| { readonly kind: "queued"; readonly companyId: string; readonly runId: string }
	| { readonly kind: "rescheduled"; readonly companyId: string; readonly phase: EquityEdinetPhase }
	| { readonly kind: "refused"; readonly companyId: string; readonly reason: string };

function notFound(): UseCaseResult<never> {
	return fail("EQUITY_COMPANY_NOT_FOUND", "The company is not tracked.");
}

function companyIdOf(job: JobRecord): string | null {
	return job.request !== null && "companyId" in job.request ? job.request.companyId : null;
}

/** How much earlier than the rest a newly tracked Watchlist stock is due. */
const WATCHLIST_HEAD_START_MS = DAY_MS;

/**
 * When a company the reconcile tracks is due (ADR-0058 §3): the batch's
 * order one millisecond apart, so the never-checked queue — ordered by
 * `next_due_at` — serves a batch Watchlist first, then US before JP, then
 * by symbol; a Watchlist stock a day earlier still, so it goes before every
 * directory stock of an earlier batch that is still waiting.
 */
export function equityTrackDueAt(atMs: number, index: number, onWatchlist: boolean): string {
	return isoOfMs(atMs + index - (onWatchlist ? WATCHLIST_HEAD_START_MS : 0));
}

/** A directory stock's company name (JP: the local name when stated), trimmed and bounded, or null. */
export function equityNameOfEntry(
	market: EquityMarket,
	entry: { readonly name: string; readonly localName: string | null },
): string | null {
	const name = (market === "JP" ? (entry.localName ?? entry.name) : entry.name).trim();
	return name === "" ? null : name.slice(0, EQUITY_FINANCIAL_LIMITS.maxNameChars);
}

/** The stored directories' identity: a market's list changes only with a new download. */
function directorySignature(
	metas: readonly {
		readonly market: string;
		readonly entryCount: number;
		readonly retrievedAt: string;
	}[],
): string {
	return metas
		.filter((meta) => meta.entryCount > 0)
		.map((meta) => `${meta.market}:${meta.retrievedAt}:${meta.entryCount}`)
		.sort()
		.join("|");
}

export function createEquitySyncService(deps: EquitySyncServiceDeps) {
	const repo = deps.equitySync;

	function newJob(ownerId: string, companyId: string, nowIso: string): JobRecord {
		return {
			runId: deps.ids.newId("run"),
			ownerId,
			kind: "financial-sync",
			state: "pending",
			request: { companyId },
			workspaceId: null,
			usage: EMPTY_USAGE,
			attempt: 0,
			maxAttempts: MAX_JOB_ATTEMPTS,
			leaseGeneration: 0,
			leaseOwnerId: null,
			leaseExpiresAt: null,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			failureUpstreamStatus: null,
			approvalRequest: null,
			retryOfRunId: null,
			contextAnchorSeq: null,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 0,
			createdAt: nowIso,
			updatedAt: nowIso,
		};
	}

	/**
	 * ADR-0058 §3: tracks up to `trackBatch` directory stocks that are not
	 * tracked (Watchlist stocks first, then US before JP, then by symbol) —
	 * a new listing inserted, an untracked one re-tracked, each due now — and
	 * stops tracking companies whose listing left a stored directory (their
	 * stored data stays). One audit row per batch. Runs only while the stored
	 * directories differ from the ones the last complete pass saw, so a
	 * settled owner costs one meta read per check. A concurrent claim doing
	 * the same is harmless: a listing tracked meanwhile is left alone.
	 */
	async function reconcile(ownerId: string): Promise<EquityReconcileOutcome | null> {
		const signature = directorySignature(await deps.stockDirectory.listMeta(ownerId));
		if (signature === "" || deps.reconciled.get(ownerId) === signature) return null;
		const at = deps.clock.nowIso();
		const limit = EQUITY_FINANCIAL_LIMITS.trackBatch;
		const candidates = await repo.untrackedDirectoryListings(ownerId, limit);
		const atMs = Date.parse(at);
		const listings = candidates.map(
			(candidate, index): EquityListingToTrack => ({
				companyId: candidate.companyId ?? deps.ids.newId("eqc"),
				market: candidate.market,
				symbol: candidate.symbol,
				provider: EQUITY_PROVIDER_OF_MARKET[candidate.market],
				name: equityNameOfEntry(candidate.market, candidate),
				existing: candidate.companyId !== null,
				dueAt: equityTrackDueAt(atMs, index, candidate.onWatchlist),
			}),
		);
		const written =
			listings.length === 0
				? { inserted: 0, retracked: 0 }
				: await repo.trackListings(ownerId, listings, at);
		const untracked = await repo.untrackDelisted(ownerId, limit);
		const audits: { readonly action: string; readonly count: number }[] = [
			{ action: "equity.track", count: written.inserted },
			{ action: "equity.retrack", count: written.retracked },
			{ action: "equity.untrack", count: untracked },
		];
		for (const entry of audits) {
			if (entry.count === 0) continue;
			await deps.audit.record({
				ownerId,
				actor: "scheduler",
				action: entry.action,
				resource: "equity_company",
				detail: `count=${entry.count}`,
				at,
			});
		}
		const complete = candidates.length < limit && untracked < limit;
		if (complete) deps.reconciled.set(ownerId, signature);
		return {
			tracked: written.inserted,
			retracked: written.retracked,
			untracked,
			complete,
		};
	}

	async function activeJob(ownerId: string): Promise<JobRecord | null> {
		return deps.jobs.findActiveByKind(ownerId, "financial-sync");
	}

	const activeStateFor = (job: JobRecord | null, companyId: string): JobState | null =>
		job !== null && companyIdOf(job) === companyId ? job.state : null;

	async function summaryOf(
		ownerId: string,
		companyId: string,
	): Promise<EquityCompanySummary | null> {
		return (await repo.listSummaries(ownerId, { companyId }))[0] ?? null;
	}

	/** The failure effects for one company's job that ended failed, from its stored state. */
	function failureEffectsOf(
		companyId: string,
		job: JobRecord,
		state: EquitySyncStateRecord,
		failureCode: string,
		upstreamStatus: number | null,
		nowMs: number,
	): EquitySyncFailureEffects {
		const consecutiveFailures = state.consecutiveFailures + 1;
		return {
			kind: "failed",
			companyId,
			failureCode,
			failureUpstreamStatus: upstreamStatus,
			consecutiveFailures,
			nextDueAt: isoOfMs(nowMs + equityFailureRetryDelayMs(failureCode, consecutiveFailures)),
			schedule: { jobCreatedAt: job.createdAt },
			at: isoOfMs(nowMs),
		};
	}

	/** The sync-state effects of a `financial-sync` job that ends failed (ADR-0048 §6). */
	async function jobFailureEffects(
		ownerId: string,
		job: JobRecord,
		failureCode: string,
		upstreamStatus: number | null,
	): Promise<EquitySyncFailureEffects | null> {
		const companyId = companyIdOf(job);
		if (companyId === null) return null;
		const summary = await summaryOf(ownerId, companyId);
		if (summary === null) return null;
		return failureEffectsOf(
			companyId,
			job,
			summary.state,
			failureCode,
			upstreamStatus,
			deps.clock.nowMs(),
		);
	}

	async function companyRead(
		ownerId: string,
		companyId: string,
	): Promise<
		UseCaseResult<{ readonly view: EquityCompanyView; readonly dataUpdatedAt: string | null }>
	> {
		const [summary, job] = await Promise.all([summaryOf(ownerId, companyId), activeJob(ownerId)]);
		if (summary === null) return notFound();
		return ok({
			view: equityCompanyView(summary, activeStateFor(job, companyId)),
			dataUpdatedAt: summary.state.dataUpdatedAt,
		});
	}

	return {
		/**
		 * Claim-time scheduling (ADR-0048 §6, ADR-0058 §3), run next to the
		 * scheduled tasks before the candidate scan: reconciles the tracked
		 * companies with the stock directory (considered at most every
		 * `SYNC_CHECK_PERIOD_MS` per owner, run only when a directory
		 * changed), then — while no `financial-sync` job is pending or leased
		 * — queues one job for the due company: a never-checked one first. A
		 * Japanese company with nothing to download (no unstored indexed
		 * report, no pending filing, no description to read) gets no job: it
		 * is recorded as checked and waits for the EDINET index. The job is
		 * outside the owner's `job-create` allowance; a refusal (unfinished-run
		 * cap) is a skip, logged, and the company is looked at again after
		 * `EQUITY_REFUSED_JOB_RETRY_MS`.
		 */
		async materializeDue(ownerId: string): Promise<EquityMaterializeOutcome> {
			const nowMs = deps.clock.nowMs();
			const nowIso = isoOfMs(nowMs);
			if (deps.trackDirectory && deps.gate.take(ownerId, nowMs)) await reconcile(ownerId);
			const probe = await repo.probe(ownerId, nowIso);
			if (probe.activeJob || probe.dueCompanyId === null) return { kind: "idle" };
			const companyId = probe.dueCompanyId;
			const context = await repo.claimContext(ownerId, companyId);
			if (context === null) return { kind: "idle" };
			let phase: EquityEdinetPhase | null = null;
			if (context.company.provider === "edinet") {
				const indexed = edinetIndexedPlan(context);
				phase = indexed.phase;
				const pending = context.filings.some((filing) => filing.factsStatus === "pending");
				// A stored report whose 事業の内容 is not read yet (ADR-0053 §2) is
				// a download too: without it an idle company would never get one.
				const describe = describeFilingOf(context.filings, context.describedReport) !== null;
				if (indexed.filings.length === 0 && !pending && !describe) {
					// Nothing to download: no job. The index makes the company due
					// as soon as it lists a report of it; until then a quiet check
					// on the company's cadence (long when it holds none).
					await repo.reschedule(ownerId, companyId, {
						nextDueAt: isoOfMs(
							nowMs +
								(indexed.phase === "not-found"
									? EQUITY_NOT_FOUND_RETRY_MS
									: equitySyncIntervalMs(context.onWatchlist)),
						),
						edinetPhase: indexed.phase,
						checkedAt: nowIso,
					});
					return { kind: "rescheduled", companyId, phase: indexed.phase };
				}
			}
			const job = newJob(ownerId, companyId, nowIso);
			const outcome = await deps.jobs.insert(
				job,
				`fsync_${job.runId}`.slice(0, 64),
				"financial-sync",
				JOB_ADMISSION.maxUnfinishedJobs,
			);
			if (outcome.kind !== "inserted") {
				deps.log("equity_sync_skipped", { companyId, reason: outcome.kind });
				// Only a refusal that leaves no job delays the company. On
				// `kind-active` (a concurrent claim queued one first) or a
				// replayed key the other job's schedule stands: writing here
				// would overwrite what its creator just wrote.
				if (outcome.kind === "at-capacity" || outcome.kind === "no-workspace") {
					await repo.reschedule(ownerId, companyId, {
						nextDueAt: isoOfMs(nowMs + EQUITY_REFUSED_JOB_RETRY_MS),
						edinetPhase: phase ?? context.state.edinetPhase,
						checkedAt: null,
					});
				}
				return { kind: "refused", companyId, reason: outcome.kind };
			}
			// Held a day ahead while the job runs (`equitySyncHeldNextDueAt`):
			// its end sets the next time precisely, keeping a re-track or an
			// index find meanwhile (`EquityJobSchedule`).
			await repo.reschedule(ownerId, companyId, {
				nextDueAt: equitySyncHeldNextDueAt(job.createdAt),
				edinetPhase: phase ?? context.state.edinetPhase,
				checkedAt: null,
			});
			return { kind: "queued", companyId, runId: job.runId };
		},

		/**
		 * The company-specific fields of a claimed `financial-sync` job, read
		 * before the lease is granted; or why the job cannot run.
		 */
		async prepareClaim(
			ownerId: string,
			job: JobRecord,
		): Promise<Result<EquitySyncClaimFields, EquityClaimRefusal>> {
			const companyId = companyIdOf(job);
			if (companyId === null) {
				return err({ state: "failed", reason: "financial sync job names no company" });
			}
			const context = await repo.claimContext(ownerId, companyId);
			if (context === null) {
				return err({ state: "failed", reason: "financial sync company not found" });
			}
			if (!context.company.tracked) {
				return err({ state: "cancelled", reason: "company no longer tracked" });
			}
			const parsed = claimFieldsSchema.safeParse({
				companyId,
				market: context.company.market,
				symbol: context.company.symbol,
				concepts: [...equityConceptsOfProvider(context.company.provider)],
				source: equitySyncRequestOf(context, deps.clock.nowMs()),
			});
			if (!parsed.success) {
				return err({ state: "failed", reason: "financial sync claim payload invalid" });
			}
			return ok(parsed.data);
		},

		/**
		 * The writes of a `financial-synced` completion (ADR-0048 §6), or —
		 * when the reported issuer is another tracked company's or differs
		 * from the resolved one — the failure effects of
		 * `FINANCIAL_IDENTITY_CONFLICT` (storing another issuer's filings
		 * under this company would mix two companies' figures).
		 */
		async completionEffects(
			ownerId: string,
			job: JobRecord,
			request: FinancialSyncedRequest,
		): Promise<UseCaseResult<EquitySyncEffects>> {
			if (companyIdOf(job) !== request.companyId) {
				return fail("VALIDATION_FAILED", "The result is not for the company this run syncs.");
			}
			const nowMs = deps.clock.nowMs();
			const at = isoOfMs(nowMs);
			const context = await repo.claimContext(ownerId, request.companyId);
			if (context === null) return notFound();
			const { company } = context;
			if (company.provider !== request.provider) {
				return fail("VALIDATION_FAILED", "The result is not from this company's provider.");
			}
			// The untracked company whose issuer identity this listing takes
			// over (a renamed or re-listed ticker: FB → META, ADR-0058 §3).
			let releasedIdentityOf: string | null = null;
			if (request.identity !== null) {
				const reported = request.identity.sourceCompanyId;
				const other =
					company.sourceCompanyId === null
						? await repo.findBySourceId(ownerId, company.provider, reported)
						: null;
				const otherCompany = other !== null && other.companyId !== company.companyId ? other : null;
				// The issuer of an untracked company — its listing left the
				// directory — moves to this listing: the old company keeps its
				// stored data under its old listing and gives up the identity.
				// Two tracked listings of one issuer (GOOG / GOOGL) still conflict.
				if (otherCompany !== null && !otherCompany.tracked) {
					releasedIdentityOf = otherCompany.companyId;
				} else if (
					(company.sourceCompanyId !== null && company.sourceCompanyId !== reported) ||
					otherCompany !== null
				) {
					return ok(
						failureEffectsOf(
							company.companyId,
							job,
							context.state,
							EQUITY_IDENTITY_CONFLICT_CODE,
							null,
							nowMs,
						),
					);
				}
			}

			// Filing ids are per company, so the company's own filings are all
			// a completion can meet.
			const stored = new Map<string, StoredEquityFiling>();
			for (const filing of context.filings) stored.set(filing.filingId, filing);
			const plan = planCompletionFilings({
				companyId: company.companyId,
				provider: company.provider,
				stored,
				filings: request.filings,
				todayUtc: utcDateOf(nowMs),
				at,
			});

			let metricValues: EquityMetricValueContent[] = [];
			if (plan.touchedKeys.length > 0) {
				const years = [...new Set(plan.touchedKeys.map(([, year]) => year))];
				const [storedFacts, storedValues] = await Promise.all([
					repo.factsOfKeys(ownerId, company.companyId, equityReadKeys(plan.touchedKeys)),
					repo.valuesOfYears(ownerId, company.companyId, years),
				]);
				metricValues = recomputeEquityValues({
					provider: company.provider,
					touchedKeys: plan.touchedKeys,
					unmappedYears: plan.unmappedYears,
					storedFacts,
					newFacts: plan.facts,
					storedValues,
				});
			}

			const nextDueAt = isoOfMs(nowMs + equityCompletionDelayMs(context, plan, request.more));
			const edinetPhase: EquityEdinetPhase | null =
				company.provider === "edinet"
					? context.indexedReports.length === 0 &&
						context.filings.length === 0 &&
						plan.newFilings.length === 0
						? "not-found"
						: "idle"
					: null;
			const read = request.description;
			const description: StoredEquityBusinessDescription | null =
				read !== null && descriptionReplaces(context.describedReport, read.source)
					? { ...read, fetchedAt: request.fetchedAt }
					: null;
			const effects: EquitySyncCompletionEffects = {
				kind: "synced",
				companyId: company.companyId,
				identity: request.identity,
				releasedIdentityOf,
				newFilings: plan.newFilings,
				finalizedFilings: plan.finalizedFilings,
				facts: plan.facts.map(
					({
						filedOn: _filedOn,
						accountingStandard: _standard,
						primaryScope: _primaryScope,
						...row
					}) => row,
				),
				metricValues,
				description,
				state: {
					checkedAt: at,
					morePending: request.more,
					edinetPhase,
					nextDueAt,
					dataUpdatedAt: metricValues.length > 0 ? at : null,
				},
				schedule: { jobCreatedAt: job.createdAt },
				at,
			};
			return ok(effects);
		},

		failureEffects: jobFailureEffects,

		/** Records a failure written outside a completion batch (claim-time retry ceiling or refusal). */
		async recordFailure(
			ownerId: string,
			job: JobRecord,
			failureCode: string,
			upstreamStatus: number | null,
		): Promise<void> {
			const effects = await jobFailureEffects(ownerId, job, failureCode, upstreamStatus);
			if (effects !== null) await repo.recordFailure(ownerId, effects);
		},

		/* ---------- Owner API ---------- */

		async list(ownerId: string): Promise<UseCaseResult<{ companies: EquityCompanyView[] }>> {
			const [summaries, job] = await Promise.all([
				repo.listSummaries(ownerId, { companyId: null }),
				activeJob(ownerId),
			]);
			return ok({
				companies: summaries.map((summary) =>
					equityCompanyView(summary, activeStateFor(job, summary.company.companyId)),
				),
			});
		},

		/** One company (tracked or not) and the time its values last changed (the ETag basis). */
		company: companyRead,

		/**
		 * One statement over the newest `years` fiscal years having any value
		 * (oldest first), every metric row, the cited filings (ADR-0048 §7).
		 */
		async statement(
			ownerId: string,
			company: { readonly view: EquityCompanyView; readonly dataUpdatedAt: string | null },
			statement: EquityStatementKind,
			years: number,
		): Promise<EquityStatementResponse> {
			const companyId = company.view.companyId;
			const fiscalYears = [...(await repo.valueYears(ownerId, companyId, years))].sort(
				(a, b) => a - b,
			);
			const metrics = equityStatementMetrics(statement);
			const stored =
				fiscalYears.length === 0
					? []
					: await repo.valuesWithFilings(ownerId, companyId, metrics, fiscalYears);
			const shaped = shapeEquityRows(metrics, fiscalYears, stored);
			return {
				company: company.view,
				statement,
				fiscalYears,
				rows: shaped.rows,
				filings: shaped.filings,
				dataUpdatedAt: company.dataUpdatedAt,
			};
		},

		async metricSeries(
			ownerId: string,
			company: { readonly view: EquityCompanyView; readonly dataUpdatedAt: string | null },
			metric: EquityMetricCode,
			years: number,
		): Promise<EquityMetricSeriesResponse> {
			const companyId = company.view.companyId;
			const fiscalYears = [...(await repo.valueYears(ownerId, companyId, years))].sort(
				(a, b) => a - b,
			);
			const stored =
				fiscalYears.length === 0
					? []
					: await repo.valuesWithFilings(ownerId, companyId, [metric], fiscalYears);
			const shaped = shapeEquityRows([metric], fiscalYears, stored);
			return {
				company: company.view,
				metric,
				cells: shaped.rows[0]?.cells ?? [],
				filings: shaped.filings,
				dataUpdatedAt: company.dataUpdatedAt,
			};
		},

		/**
		 * Every stored filing of the company, newest first — pending and
		 * unavailable ones and superseded originals included (ADR-0048 §7).
		 */
		async filings(
			ownerId: string,
			company: { readonly view: EquityCompanyView },
		): Promise<EquityFilingsResponse> {
			const stored = await repo.listFilings(
				ownerId,
				company.view.companyId,
				EQUITY_FILINGS_READ_MAX,
			);
			return { company: company.view, filings: stored.map(equityFilingListItem) };
		},

		/** Every as-filed value of one metric-year beside the current one (ADR-0048 §5). */
		async revisions(
			ownerId: string,
			company: { readonly view: EquityCompanyView },
			metric: EquityMetricCode,
			fiscalYear: number,
		): Promise<EquityRevisionsResponse> {
			const companyId = company.view.companyId;
			const [current, reported] = await Promise.all([
				repo.valuesWithFilings(ownerId, companyId, [metric], [fiscalYear]),
				repo.revisions(ownerId, companyId, metric, fiscalYear, MAX_REVISION_ROWS),
			]);
			const currentRow = current[0];
			const filings = new Map<string, StoredEquityFiling>();
			if (currentRow?.filing !== null && currentRow?.filing !== undefined) {
				filings.set(currentRow.filing.filingId, currentRow.filing);
			}
			for (const entry of reported) filings.set(entry.filing.filingId, entry.filing);
			return {
				company: company.view,
				metric,
				fiscalYear,
				current: equityMetricCell(metric, fiscalYear, currentRow?.value),
				reported: reported.map(({ fact }) => ({
					filingId: fact.filingId,
					concept: fact.concept,
					scope: fact.scope,
					unit: fact.unit,
					valueDecimal: fact.valueDecimal,
					periodStart: fact.periodStart,
					periodEnd: fact.periodEnd,
				})),
				filings: [...filings.values()]
					.sort((a, b) =>
						a.filedOn === b.filedOn
							? b.filingId.localeCompare(a.filingId)
							: b.filedOn.localeCompare(a.filedOn),
					)
					.map(equityFilingView),
			};
		},
	};
}

export type EquitySyncService = ReturnType<typeof createEquitySyncService>;
