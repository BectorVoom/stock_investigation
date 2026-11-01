/**
 * The shared EDINET index of annual securities reports (ADR-0058 §4): the
 * source an `edinet-index` job runs. EDINET has no per-company search, so
 * each claimed date's list is read once for every company.
 *
 * 1. No `EDINET_API_KEY`: fail `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request.
 * 2. List each claimed date in claim order (newest first), one
 *    `documents.json?type=2` request each, paced by the runner's `edinet`
 *    gate at one per second. EDINET answers a date's whole list at once (no
 *    paging; `metadata.resultset.count` is the row count).
 * 3. Keep the not-withdrawn 120/130 rows with a listed securities code and
 *    an XBRL-to-CSV (`csvFlag` "1") (`edinetIndexDocument`) and report the
 *    date with them. A report without CSV has no facts and no 事業の内容 to
 *    read: indexing it would cost a download that answers 404 on every
 *    company sync until its grace period ends.
 * 4. A date whose list failed (an HTTP error, a list that is not one, a list
 *    over `EDINET_INDEX_LIMITS.maxDocumentsPerDay`) is left out — the API
 *    plans it again — and the job goes on, except after a refused key or a
 *    rate limit: the dates after it would fail the same, so the job stops
 *    listing. When no date was listed the job fails with the first date's
 *    failure (its code and EDINET's status, ADR-0037).
 *
 * The subscription key is a query parameter: URLs here are never logged.
 */
import type { SafeFetcher } from "@research/application";
import {
	EDINET_INDEX_LIMITS,
	type EdinetIndexDayResult,
	type EdinetIndexDocument,
	type EquitySyncFailureCode,
	edinetSecuritiesCodeSchema,
} from "@research/contracts";
import { err, ok, parseJson, type Result } from "@research/domain";
import {
	EDINET_API_HOST,
	type EdinetAnnualRow,
	type EdinetListProblem,
	edinetDocumentListUrl,
	parseEdinetDocumentList,
} from "./edinetDocuments.ts";
import {
	type EquitySyncFailure,
	equitySyncCodeOfStatus,
	equitySyncFailureOfFetch,
} from "./equitySync.ts";

/** A date's list is a few hundred kilobytes even at the late-June peak. */
export const EDINET_LIST_MAX_BYTES = 8_000_000;
const EDINET_LIST_TIMEOUT_MS = 30_000;
const EDINET_ALLOWED_HOSTS: ReadonlySet<string> = new Set([EDINET_API_HOST]);
const LIST_ACCEPT = "application/json";
const SUBMIT_DATE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/;

/** The longest prefix of whole characters within `max` UTF-16 code units (never a lone surrogate). */
function cutCodePoints(text: string, max: number): string {
	if (text.length <= max) return text;
	let cut = "";
	for (const character of text) {
		if (cut.length + character.length > max) break;
		cut += character;
	}
	return cut;
}

/**
 * One annual row as an index document, or null when the index cannot keep
 * it: no securities code of EDINET's five-character form (the filer is not
 * listed), no XBRL-to-CSV (`csvFlag` not "1": nothing the sync could read),
 * no filer name, or an annual securities report (120) without a
 * period end (the contract refuses one; an amendment's row states no period,
 * spec §3-1-2-2 *3, and takes its original's on the API side). A name over
 * `maxFilerNameChars` is cut at a character boundary rather than losing the
 * report. `submitDateTime` (Japan time) becomes an instant with `+09:00`.
 */
export function edinetIndexDocument(row: EdinetAnnualRow): EdinetIndexDocument | null {
	const secCode = row.secCode;
	if (secCode === null || !edinetSecuritiesCodeSchema.safeParse(secCode).success) return null;
	if (!row.csvAvailable) return null;
	if (row.filerName === null) return null;
	if (row.docTypeCode === "120" && row.periodEnd === null) return null;
	const submit = SUBMIT_DATE_TIME.exec(row.submitDateTime);
	if (submit === null) return null;
	return {
		docId: row.docId,
		secCode,
		edinetCode: row.edinetCode,
		filerName: cutCodePoints(row.filerName, EDINET_INDEX_LIMITS.maxFilerNameChars),
		docTypeCode: row.docTypeCode,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		submittedAt: `${submit[1]}T${submit[2]}:${submit[3]}:00+09:00`,
		parentDocId: row.parentDocId,
	};
}

/** Why a date's list gives no index day: EDINET's status, or not the documented list. */
export type EdinetIndexDayProblem = EdinetListProblem | { readonly kind: "too-many" };

/** A date's documents (`edinetIndexDocument`, each document id once, list order) and the rows dropped. */
export interface EdinetIndexDay {
	readonly documents: readonly EdinetIndexDocument[];
	/** Annual rows the index could not keep (no securities code, CSV, name or period end). */
	readonly dropped: number;
}

/** A date's list (parsed JSON) as its index documents. */
export function edinetIndexDay(value: unknown): Result<EdinetIndexDay, EdinetIndexDayProblem> {
	const parsed = parseEdinetDocumentList(value);
	if (!parsed.ok) return parsed;
	const documents: EdinetIndexDocument[] = [];
	const seen = new Set<string>();
	let dropped = 0;
	for (const row of parsed.value) {
		const document = edinetIndexDocument(row);
		if (document === null) {
			dropped += 1;
		} else if (!seen.has(document.docId)) {
			seen.add(document.docId);
			documents.push(document);
		}
	}
	// The completion could not carry the whole date: it stays unlisted rather than cut.
	if (documents.length > EDINET_INDEX_LIMITS.maxDocumentsPerDay) return err({ kind: "too-many" });
	return ok({ documents, dropped });
}

/** A date the job could not list, with the failure code and EDINET's status. */
export interface EdinetIndexDayFailure {
	readonly date: string;
	readonly code: EquitySyncFailureCode;
	readonly upstreamStatus: number | null;
}

export interface EdinetIndexData {
	/** The dates listed in full, in claim order. */
	readonly days: readonly EdinetIndexDayResult[];
	/** The dates that failed, in claim order (left out of the completion). */
	readonly failedDays: readonly EdinetIndexDayFailure[];
	/** Claimed dates not tried after a refused key or a rate limit. */
	readonly skippedDays: number;
	/** Annual rows of the listed dates the index could not keep. */
	readonly droppedRows: number;
	/** HTTP requests this job sent. */
	readonly requests: number;
}

export interface EdinetIndexQuery {
	/** The claim's dates, newest first. */
	readonly days: readonly string[];
	readonly signal: AbortSignal;
	/** Takes one `edinet` pacing grant; false = the job was stopped. */
	readonly beforeRequest: () => Promise<boolean>;
}

export interface EdinetIndexSource {
	list(query: EdinetIndexQuery): Promise<Result<EdinetIndexData, EquitySyncFailure>>;
}

export interface EdinetIndexSourceDeps {
	readonly fetcher: SafeFetcher;
	/** EDINET_API_KEY; null = EDINET is not configured and nothing is requested. */
	readonly apiKey: string | null;
}

/** The failure of a date's list that is not a fetch failure. */
function dayProblemFailure(problem: EdinetIndexDayProblem): {
	code: EquitySyncFailureCode;
	upstreamStatus: number | null;
} {
	if (problem.kind !== "status") return { code: "FINANCIAL_PARSE_FAILED", upstreamStatus: null };
	return {
		code:
			problem.status === null ? "FINANCIAL_SOURCE_FAILED" : equitySyncCodeOfStatus(problem.status),
		upstreamStatus: problem.status,
	};
}

/** After these, every later date would fail the same way: the job stops listing. */
function stopsListing(code: EquitySyncFailureCode): boolean {
	return code === "FINANCIAL_ACCESS_DENIED" || code === "FINANCIAL_RATE_LIMITED";
}

export function createEdinetIndexSource(deps: EdinetIndexSourceDeps): EdinetIndexSource {
	return {
		async list(query: EdinetIndexQuery): Promise<Result<EdinetIndexData, EquitySyncFailure>> {
			let requests = 0;
			const apiKey = deps.apiKey;
			if (apiKey === null) {
				return err({ code: "FINANCIAL_SOURCE_NOT_CONFIGURED", upstreamStatus: null, requests });
			}
			const dates = [...new Set(query.days)];
			const days: EdinetIndexDayResult[] = [];
			const failedDays: EdinetIndexDayFailure[] = [];
			let droppedRows = 0;
			let tried = 0;
			for (const date of dates) {
				if (!(await query.beforeRequest())) {
					return err({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests });
				}
				tried += 1;
				requests += 1;
				const listed = await deps.fetcher.fetchText(edinetDocumentListUrl(date, apiKey), {
					maxBytes: EDINET_LIST_MAX_BYTES,
					timeoutMs: EDINET_LIST_TIMEOUT_MS,
					accept: LIST_ACCEPT,
					allowedHosts: EDINET_ALLOWED_HOSTS,
					signal: query.signal,
				});
				let failure: { code: EquitySyncFailureCode; upstreamStatus: number | null } | null = null;
				if (!listed.ok) {
					failure = equitySyncFailureOfFetch(listed.error, requests);
				} else {
					const json = parseJson(listed.value.text);
					const day = json.ok
						? edinetIndexDay(json.value)
						: err<EdinetIndexDayProblem>({ kind: "parse" });
					if (day.ok) {
						days.push({ date, documents: [...day.value.documents] });
						droppedRows += day.value.dropped;
					} else {
						failure = dayProblemFailure(day.error);
					}
				}
				if (failure !== null) {
					failedDays.push({ date, code: failure.code, upstreamStatus: failure.upstreamStatus });
					if (stopsListing(failure.code)) break;
				}
			}
			const first = failedDays[0];
			if (days.length === 0 && first !== undefined) {
				return err({ code: first.code, upstreamStatus: first.upstreamStatus, requests });
			}
			return ok({ days, failedDays, skippedDays: dates.length - tried, droppedRows, requests });
		},
	};
}
