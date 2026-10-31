/**
 * EDINET API v2 document lists (ADR-0048 §6, EDINET), pure.
 *
 * EDINET has no per-company search: `GET /api/v2/documents.json?date=…&type=2`
 * lists every document submitted on one date. A sync keeps the annual
 * reports — docTypeCode 120 (有価証券報告書) and 130 (訂正有価証券報告書) — that
 * are not withdrawn, then the rows whose securities code is the company's.
 * The annual rows of a date are what the runner caches for 24 hours, so the
 * companies synced one after another share the listing requests.
 *
 * Documented format (fields used; `secCode`, `periodStart`, `periodEnd`,
 * `parentDocID` may be null):
 *   {"metadata":{"status":"200",…},"results":[{"docID":"S100TR7I",
 *    "edinetCode":"E02367","secCode":"79740","filerName":"任天堂株式会社",
 *    "docTypeCode":"120","periodStart":"2024-04-01","periodEnd":"2025-03-31",
 *    "submitDateTime":"2025-06-27 15:00","parentDocID":null,
 *    "withdrawalStatus":"0","csvFlag":"1",…}]}
 * A `metadata.status` other than "200" is an error carrying that status.
 */
import type { EquityPendingFiling } from "@research/contracts";
import { edinetCodeSchema, edinetDocIdSchema } from "@research/contracts";
import { type EquityReportForm, err, isoDayNumber, ok, type Result } from "@research/domain";
import { z } from "zod";
import type { EquitySyncIdentity } from "./equitySync.ts";

export const EDINET_API_HOST = "api.edinet-fsa.go.jp";
export const EDINET_VIEWER_HOST = "disclosure2.edinet-fsa.go.jp";
export const EDINET_PUBLISHER = "Financial Services Agency (EDINET)";

/**
 * The subscription key travels as a query parameter (EDINET API v2 has no
 * header form), so these URLs are secrets: never logged, stored or shown.
 */
export function edinetDocumentListUrl(date: string, apiKey: string): string {
	return `https://${EDINET_API_HOST}/api/v2/documents.json?date=${date}&type=2&Subscription-Key=${encodeURIComponent(apiKey)}`;
}

export function edinetDocumentUrl(docId: string, apiKey: string): string {
	return `https://${EDINET_API_HOST}/api/v2/documents/${docId}?type=5&Subscription-Key=${encodeURIComponent(apiKey)}`;
}

/** The filing's public page in the EDINET viewer (a link only; the runner never fetches it). */
export function edinetViewerUrl(docId: string): string {
	return `https://${EDINET_VIEWER_HOST}/WZEK0040.aspx?${docId}`;
}

const EDINET_ANNUAL_FORMS = {
	"120": "securities-report",
	"130": "amended-securities-report",
} as const;
type EdinetAnnualDocType = keyof typeof EDINET_ANNUAL_FORMS;

/** One not-withdrawn annual-report row of a date's list, with the fields a sync uses. */
export interface EdinetAnnualRow {
	readonly docId: string;
	readonly edinetCode: string;
	readonly secCode: string | null;
	readonly filerName: string | null;
	readonly docTypeCode: EdinetAnnualDocType;
	readonly periodStart: string | null;
	readonly periodEnd: string | null;
	/** "YYYY-MM-DD HH:MM", Japan time. */
	readonly submitDateTime: string;
	readonly parentDocId: string | null;
	/** `csvFlag` "1": the XBRL-to-CSV download exists. */
	readonly csvAvailable: boolean;
}

const nullableText = z.string().nullable().optional();
const rowSchema = z.object({
	docID: nullableText,
	edinetCode: nullableText,
	secCode: nullableText,
	filerName: nullableText,
	docTypeCode: nullableText,
	periodStart: nullableText,
	periodEnd: nullableText,
	submitDateTime: nullableText,
	parentDocID: nullableText,
	withdrawalStatus: nullableText,
	csvFlag: nullableText,
});
const listSchema = z.object({
	metadata: z.object({ status: z.string() }),
	results: z.array(z.unknown()).optional(),
});

const SUBMIT_DATE_TIME = /^(\d{4}-\d{2}-\d{2}) ([01]\d|2[0-3]):([0-5]\d)$/;
const STATUS_TEXT = /^[1-5]\d{2}$/;

export type EdinetListProblem =
	| { readonly kind: "status"; readonly status: number | null }
	| { readonly kind: "parse" };

function validDateOrNull(text: string | null | undefined): string | null {
	return typeof text === "string" && isoDayNumber(text) !== null ? text : null;
}

/** EDINET's metadata status text as a number, when it is an HTTP-style status. */
function statusOfText(text: string): number | null {
	return STATUS_TEXT.test(text) ? Number(text) : null;
}

/**
 * The status an EDINET error body states: `metadata.status` (API v2 error
 * JSON) or `StatusCode` / `statusCode` (the gateway's 401 answer); null when
 * the body states none.
 */
export function edinetErrorStatus(value: unknown): number | null {
	const parsed = z
		.object({
			metadata: z.object({ status: z.string() }).optional(),
			StatusCode: z.number().int().optional(),
			statusCode: z.number().int().optional(),
		})
		.safeParse(value);
	if (!parsed.success) return null;
	const fromMetadata =
		parsed.data.metadata === undefined ? null : statusOfText(parsed.data.metadata.status);
	if (fromMetadata !== null) return fromMetadata;
	const code = parsed.data.StatusCode ?? parsed.data.statusCode;
	return code !== undefined && code >= 100 && code <= 599 ? code : null;
}

/**
 * A date's list as its annual rows (120/130, not withdrawn, with a valid
 * document id, filer code and submission time), in EDINET's order. Other
 * rows — other document types, withdrawn ones, malformed ones — are dropped.
 */
export function parseEdinetDocumentList(
	value: unknown,
): Result<readonly EdinetAnnualRow[], EdinetListProblem> {
	const list = listSchema.safeParse(value);
	if (!list.success) return err({ kind: "parse" });
	if (list.data.metadata.status !== "200") {
		return err({ kind: "status", status: statusOfText(list.data.metadata.status) });
	}
	if (list.data.results === undefined) return err({ kind: "parse" });
	const rows: EdinetAnnualRow[] = [];
	for (const raw of list.data.results) {
		const parsed = rowSchema.safeParse(raw);
		if (!parsed.success) continue;
		const row = parsed.data;
		const docType = row.docTypeCode;
		if (docType !== "120" && docType !== "130") continue;
		if (row.withdrawalStatus !== "0") continue;
		const docId = row.docID ?? "";
		const edinetCode = row.edinetCode ?? "";
		const submit = SUBMIT_DATE_TIME.exec(row.submitDateTime ?? "");
		if (
			!edinetDocIdSchema.safeParse(docId).success ||
			!edinetCodeSchema.safeParse(edinetCode).success ||
			submit === null ||
			isoDayNumber(submit[1] ?? "") === null
		) {
			continue;
		}
		const parent = row.parentDocID ?? null;
		const filerName = (row.filerName ?? "").trim();
		rows.push({
			docId,
			edinetCode,
			secCode: row.secCode ?? null,
			filerName: filerName === "" ? null : filerName,
			docTypeCode: docType,
			periodStart: validDateOrNull(row.periodStart),
			periodEnd: validDateOrNull(row.periodEnd),
			submitDateTime: row.submitDateTime ?? "",
			parentDocId: parent !== null && edinetDocIdSchema.safeParse(parent).success ? parent : null,
			csvAvailable: row.csvFlag === "1",
		});
	}
	return ok(rows);
}

/** The filing metadata of a row (ADR-0048 §6), or null without a period end. */
export function edinetFilingMetadata(row: EdinetAnnualRow): EquityPendingFiling | null {
	if (row.periodEnd === null) return null;
	const submit = SUBMIT_DATE_TIME.exec(row.submitDateTime);
	if (submit === null) return null;
	const form: EquityReportForm = EDINET_ANNUAL_FORMS[row.docTypeCode];
	return {
		sourceDocumentId: row.docId,
		form,
		filedOn: submit[1] ?? "",
		submittedAt: `${submit[1]}T${submit[2]}:${submit[3]}:00+09:00`,
		periodStart: row.periodStart,
		periodEnd: row.periodEnd,
		amendsSourceDocumentId: row.parentDocId,
		sourceUrl: edinetViewerUrl(row.docId),
	};
}

const MAX_NAME_CHARS = 200;

/**
 * The company as EDINET names it: the first matching row's filer code and
 * name, and the month-day of the first original report's period end (the
 * fiscal year end); else the claim's filer code with nothing else known;
 * else null (no report found yet).
 */
export function edinetIdentity(
	matched: readonly EdinetAnnualRow[],
	claimEdinetCode: string | null,
): EquitySyncIdentity | null {
	const first = matched[0];
	if (first === undefined) {
		return claimEdinetCode === null
			? null
			: { sourceCompanyId: claimEdinetCode, name: null, fiscalYearEnd: null };
	}
	const original = matched.find((row) => row.docTypeCode === "120" && row.periodEnd !== null);
	const name = first.filerName;
	return {
		sourceCompanyId: first.edinetCode,
		name: name !== null && name.length <= MAX_NAME_CHARS ? name : null,
		fiscalYearEnd: original?.periodEnd?.slice(5) ?? null,
	};
}

/** What the job does with one document. */
export type EdinetDocumentAction = "download" | "not-available" | "deferred";

export interface EdinetPlannedDocument {
	readonly metadata: EquityPendingFiling;
	readonly action: EdinetDocumentAction;
	/** The scan date that listed it; null for a pending filing this scan did not list. */
	readonly listedOn: string | null;
}

/** A matching row with the date whose list carried it. */
export interface EdinetListedRow {
	readonly row: EdinetAnnualRow;
	readonly listedOn: string;
}

/**
 * Which documents a job fetches (ADR-0048 §6): pending filings first in
 * claim order (with their stored metadata), then the new documents found by
 * the scan, oldest submission first. A document without CSV (`csvFlag` "0")
 * is not available without a request; the others are downloaded up to
 * `maxDownloads` and the rest deferred to the next job. Documents the claim
 * already stores, and new rows without a period end, are left out.
 */
export function edinetDownloadPlan(input: {
	readonly pending: readonly EquityPendingFiling[];
	readonly found: readonly EdinetListedRow[];
	readonly knownDocIds: readonly string[];
	readonly maxDownloads: number;
}): readonly EdinetPlannedDocument[] {
	const byDocId = new Map<string, EdinetListedRow>();
	for (const listed of input.found) {
		if (!byDocId.has(listed.row.docId)) byDocId.set(listed.row.docId, listed);
	}
	const known = new Set(input.knownDocIds);
	const planned: EdinetPlannedDocument[] = [];
	const seen = new Set<string>();
	let downloads = 0;
	const decide = (csvAvailable: boolean): EdinetDocumentAction => {
		if (!csvAvailable) return "not-available";
		if (downloads >= input.maxDownloads) return "deferred";
		downloads += 1;
		return "download";
	};
	for (const pending of input.pending) {
		if (seen.has(pending.sourceDocumentId)) continue;
		seen.add(pending.sourceDocumentId);
		const listed = byDocId.get(pending.sourceDocumentId);
		planned.push({
			metadata: pending,
			// Unknown CSV status (not listed in this scan): try the download.
			action: decide(listed?.row.csvAvailable ?? true),
			listedOn: listed?.listedOn ?? null,
		});
	}
	const fresh = [...byDocId.values()]
		.filter((listed) => !seen.has(listed.row.docId) && !known.has(listed.row.docId))
		.sort(
			(a, b) =>
				compareText(a.row.submitDateTime, b.row.submitDateTime) ||
				compareText(a.row.docId, b.row.docId),
		);
	for (const listed of fresh) {
		const metadata = edinetFilingMetadata(listed.row);
		if (metadata === null) continue;
		seen.add(listed.row.docId);
		planned.push({ metadata, action: decide(listed.row.csvAvailable), listedOn: listed.listedOn });
	}
	return planned;
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}
