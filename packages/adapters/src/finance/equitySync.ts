/**
 * What both financial-statement sources share (ADR-0048 §6): the port the
 * runner calls for a `financial-sync` job, the failure mapping of a
 * provider's answer to `EQUITY_SYNC_FAILURE_CODES`, the canonical order of a
 * filing's facts, the completion caps, and the business description of the
 * report read (ADR-0053 §2).
 *
 * Every function here is pure; the Rust runner ports them and replays the
 * vectors `scripts/vectors/finance/equitySync.ts` exports.
 */
import { type SafeFetchError, upstreamStatusOf } from "@research/application";
import {
	type ClaimedJob,
	EQUITY_FINANCIAL_LIMITS,
	type EquityBusinessDescription,
	type EquityBusinessSource,
	type EquityFilingResult,
	type EquitySyncFailureCode,
} from "@research/contracts";
import {
	annualFactsOfFiling,
	type BusinessParagraphs,
	type EquityExtractedFact,
	type EquityProvider,
	type Result,
} from "@research/domain";

/** Why a downloaded EDINET document could not be read as a report (logged as `financial_sync_document_unreadable`). */
export type EdinetReportProblem = "NOT_A_ZIP" | "NO_REPORT_ENTRY" | "ENCODING" | "MISSING_HEADER";

/** The fields of a claimed `financial-sync` job a source needs (no lease fields). */
export type EquitySyncTarget = Pick<
	Extract<ClaimedJob, { kind: "financial-sync" }>,
	"companyId" | "market" | "symbol" | "concepts" | "source"
>;

export interface EquitySyncIdentity {
	/** CIK (SEC) or EDINET code. */
	readonly sourceCompanyId: string;
	readonly name: string | null;
	readonly fiscalYearEnd: string | null;
}

export interface EquitySyncQuery {
	readonly target: EquitySyncTarget;
	readonly signal: AbortSignal;
	/**
	 * Called immediately before each request is sent (the runner's pacing
	 * gate: `sec`, `edinet`). False means the job stopped while waiting: the
	 * source sends nothing more and fails.
	 */
	readonly beforeRequest: () => Promise<boolean>;
}

/**
 * Why a downloaded document gave no reportable filing: a report problem, or
 * `PERIOD_UNKNOWN` — an amendment whose period neither the list, its
 * original nor its report's DEI states (it is then not reported at all).
 */
export type EquitySyncDocumentProblem = EdinetReportProblem | "PERIOD_UNKNOWN";

/**
 * A downloaded document the source could not read (EDINET: an archive the
 * reader refuses, no `jpcrp` report entry, text that is not UTF-16 LE, no
 * CSV header) or could not date. Its filing is reported `not-available`, or
 * not at all without a period; the runner logs it
 * (`financial_sync_document_unreadable`).
 */
export interface EquitySyncUnreadableDocument {
	readonly sourceDocumentId: string;
	readonly problem: EquitySyncDocumentProblem;
}

/** The `financial-synced` completion fields a source produces, plus its request count. */
export interface EquitySyncData {
	readonly identity: EquitySyncIdentity | null;
	readonly scannedDays: readonly string[];
	readonly filings: readonly EquityFilingResult[];
	readonly more: boolean;
	/** HTTP requests this job sent (cache hits are not requests). */
	readonly requests: number;
	/** Downloaded documents that could not be read, in download order (always empty for SEC). */
	readonly unreadableDocuments: readonly EquitySyncUnreadableDocument[];
	/**
	 * The business section of the newest annual report this job read
	 * (ADR-0053 §2); null when it read none — the stored one is current, or
	 * the read failed (never a job failure: the next sync asks again).
	 */
	readonly description: EquityBusinessDescription | null;
}

export interface EquitySyncFailure {
	readonly code: EquitySyncFailureCode;
	/** The provider's HTTP (or EDINET metadata) status, unchanged (ADR-0037); null when none answered. */
	readonly upstreamStatus: number | null;
	readonly requests: number;
}

export interface EquitySyncSource {
	readonly provider: EquityProvider;
	sync(query: EquitySyncQuery): Promise<Result<EquitySyncData, EquitySyncFailure>>;
}

/** The provider-independent failure of a status (404 is decided by the caller first). */
export function equitySyncCodeOfStatus(status: number): EquitySyncFailureCode {
	if (status === 401 || status === 403) return "FINANCIAL_ACCESS_DENIED";
	if (status === 429) return "FINANCIAL_RATE_LIMITED";
	return "FINANCIAL_SOURCE_FAILED";
}

/**
 * A failed safe fetch as a sync failure: an HTTP status by the table above,
 * an oversized answer as a parse failure (a retry would not shrink it), and
 * everything else (timeout, network, refused redirect) as a source failure.
 */
export function equitySyncFailureOfFetch(
	error: SafeFetchError,
	requests: number,
): EquitySyncFailure {
	const upstreamStatus = upstreamStatusOf(error);
	if (error.code === "HTTP_ERROR") {
		return { code: equitySyncCodeOfStatus(error.status), upstreamStatus, requests };
	}
	if (error.code === "RESPONSE_TOO_LARGE") {
		return { code: "FINANCIAL_PARSE_FAILED", upstreamStatus, requests };
	}
	return { code: "FINANCIAL_SOURCE_FAILED", upstreamStatus, requests };
}

/**
 * A report's business description: "extracted" with its paragraphs, or
 * "not-found" when the report has no section that could be read (no
 * paragraphs) — stored as such, so the same report is not read again.
 */
export function businessDescriptionOf(
	source: EquityBusinessSource,
	business: BusinessParagraphs,
): EquityBusinessDescription {
	return business.paragraphs.length === 0
		? { source, status: "not-found", paragraphs: [], truncated: false }
		: {
				source,
				status: "extracted",
				paragraphs: business.paragraphs.map((paragraph) => ({ ...paragraph })),
				truncated: business.truncated,
			};
}

/**
 * Of two descriptions, the newer report's: greatest (period end, filing
 * date, document id) — the order the API keeps descriptions by (ADR-0053 §2).
 */
export function newerBusinessDescription(
	a: EquityBusinessDescription | null,
	b: EquityBusinessDescription | null,
): EquityBusinessDescription | null {
	if (a === null) return b;
	if (b === null) return a;
	const order =
		compareText(a.source.periodEnd, b.source.periodEnd) ||
		compareText(a.source.filedOn, b.source.filedOn) ||
		compareText(a.source.sourceDocumentId, b.source.sourceDocumentId);
	return order >= 0 ? a : b;
}

/** Rate limits and transient source failures are retried by the API; the rest need the owner. */
export function isRetryableEquitySyncFailure(code: EquitySyncFailureCode): boolean {
	return code === "FINANCIAL_RATE_LIMITED" || code === "FINANCIAL_SOURCE_FAILED";
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Canonical fact order: concept, unit, period type, period start (an
 * instant's null first), period end, value, scope. Facts are ASCII text, so
 * this is plain code-unit order in TypeScript and byte order in Rust.
 */
export function compareFacts(a: EquityExtractedFact, b: EquityExtractedFact): number {
	return (
		compareText(a.concept, b.concept) ||
		compareText(a.unit, b.unit) ||
		compareText(a.periodType, b.periodType) ||
		compareText(a.periodStart ?? "", b.periodStart ?? "") ||
		compareText(a.periodEnd, b.periodEnd) ||
		compareText(a.valueDecimal, b.valueDecimal) ||
		compareText(a.scope, b.scope)
	);
}

/**
 * The facts a filing reports, in canonical order with exact repeats removed
 * (company facts can list one fact twice for one accession), then only the
 * annual ones (ADR-0048 §4, `annualFactsOfFiling`).
 */
export function annualFactsInOrder(
	facts: readonly EquityExtractedFact[],
): readonly EquityExtractedFact[] {
	const sorted = [...facts].sort(compareFacts);
	const unique: EquityExtractedFact[] = [];
	for (const fact of sorted) {
		const last = unique[unique.length - 1];
		if (last === undefined || compareFacts(last, fact) !== 0) unique.push(fact);
	}
	return annualFactsOfFiling(unique).kept;
}

/** Newest first: filing date, then source document id, both descending. */
export function compareFilingsNewestFirst(
	a: { readonly filedOn: string; readonly sourceDocumentId: string },
	b: { readonly filedOn: string; readonly sourceDocumentId: string },
): number {
	return compareText(b.filedOn, a.filedOn) || compareText(b.sourceDocumentId, a.sourceDocumentId);
}

export interface CompletionCaps {
	readonly maxFilings: number;
	readonly maxFacts: number;
}

export const COMPLETION_CAPS: CompletionCaps = {
	maxFilings: EQUITY_FINANCIAL_LIMITS.maxFilingsPerCompletion,
	maxFacts: EQUITY_FINANCIAL_LIMITS.maxFactsPerCompletion,
};

/**
 * The filings one completion carries (ADR-0048 §6): newest first, whole
 * filings only, while within `maxFilings` and `maxFacts`; the first filing
 * that does not fit and every older one are cut (`cut`, newest first), and
 * the completion then says `more`. A single filing whose facts alone exceed
 * `maxFacts` could never be carried: it is reported `not-available` with no
 * facts instead (correct but incomplete beats an endless `more`).
 */
export function fitCompletionCaps(
	filings: readonly EquityFilingResult[],
	caps: CompletionCaps = COMPLETION_CAPS,
): {
	readonly filings: readonly EquityFilingResult[];
	readonly cut: readonly EquityFilingResult[];
} {
	const ordered = filings
		.map(
			(filing): EquityFilingResult =>
				filing.facts.length > caps.maxFacts
					? { ...filing, factsStatus: "not-available", accountingStandard: null, facts: [] }
					: filing,
		)
		.sort(compareFilingsNewestFirst);
	const kept: EquityFilingResult[] = [];
	let facts = 0;
	for (const [index, filing] of ordered.entries()) {
		if (kept.length >= caps.maxFilings || facts + filing.facts.length > caps.maxFacts) {
			return { filings: kept, cut: ordered.slice(index) };
		}
		kept.push(filing);
		facts += filing.facts.length;
	}
	return { filings: kept, cut: [] };
}
