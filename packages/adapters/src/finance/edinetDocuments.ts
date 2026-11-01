/**
 * EDINET API v2 document lists and the download plan (ADR-0048 §6,
 * ADR-0058 §4), pure.
 *
 * EDINET has no per-company search: `GET /api/v2/documents.json?date=…&type=2`
 * lists every document submitted on one date. The shared `edinet-index` job
 * (`edinetIndex.ts`) lists each date once for every company and keeps the
 * annual reports — docTypeCode 120 (有価証券報告書) and 130 (訂正有価証券報告書)
 * — that are not withdrawn; a company's `financial-sync` then downloads the
 * reports the index names for its securities code (`edinetDownloadPlan`).
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
import type { EdinetKnownFiling, EquityPendingFiling } from "@research/contracts";
import { edinetCodeSchema, edinetDocIdSchema } from "@research/contracts";
import { err, isoDayNumber, ok, type Result } from "@research/domain";
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

/** The annual-report document types: 120 有価証券報告書, 130 訂正有価証券報告書. */
export type EdinetAnnualDocType = "120" | "130";

/** One not-withdrawn annual-report row of a date's list, with the fields the index uses. */
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
	/** `csvFlag` "1": the XBRL-to-CSV download exists (the index keeps only those). */
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
 *
 * A body without the list's shape that states an error status of 400 or
 * more (`edinetErrorStatus`) is that status: the gateway answers an invalid
 * key or too many requests with HTTP 200 and `{"StatusCode":401|429,…}`
 * without `metadata` (spec §3-3), and that must read as access denied /
 * rate limited with EDINET's status, not as a malformed list.
 */
export function parseEdinetDocumentList(
	value: unknown,
): Result<readonly EdinetAnnualRow[], EdinetListProblem> {
	const list = listSchema.safeParse(value);
	if (!list.success) {
		const status = edinetErrorStatus(value);
		return status !== null && status >= 400
			? err({ kind: "status", status })
			: err({ kind: "parse" });
	}
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

/**
 * The company as this job knows it (ADR-0058 §4): the claim's filer code
 * (the API takes it from the index), no name (the index stores the filer's
 * name; null keeps the stored one), and the month-day of the period end of
 * the first original report (120) the claim names — indexed, then pending —
 * as the fiscal year end; null without a filer code.
 */
export function edinetIdentity(
	claimEdinetCode: string | null,
	filings: readonly EquityPendingFiling[],
): EquitySyncIdentity | null {
	if (claimEdinetCode === null) return null;
	const original = filings.find((filing) => filing.form === "securities-report");
	return {
		sourceCompanyId: claimEdinetCode,
		name: null,
		fiscalYearEnd: original?.periodEnd.slice(5) ?? null,
	};
}

/** What the job does with one document. */
export type EdinetDocumentAction = "download" | "deferred";

export interface EdinetPlannedDocument {
	/** The claim's metadata, echoed back unchanged. */
	readonly metadata: EquityPendingFiling;
	readonly action: EdinetDocumentAction;
}

/**
 * Which documents a job fetches (ADR-0058 §4): the pending filings first in
 * claim order, then the reports the index names (`indexedFilings`, oldest
 * first as the API sends them), each document once; a document the claim
 * already stores (`knownFilings`) is left out. The first `maxDownloads` are
 * downloaded, the rest deferred to the next job. Every document has its
 * period: an amendment's (130) was taken from its original by the API.
 */
export function edinetDownloadPlan(input: {
	readonly pending: readonly EquityPendingFiling[];
	readonly indexed: readonly EquityPendingFiling[];
	readonly knownFilings: readonly EdinetKnownFiling[];
	readonly maxDownloads: number;
}): readonly EdinetPlannedDocument[] {
	const known = new Set(input.knownFilings.map((filing) => filing.docId));
	const seen = new Set<string>();
	const planned: EdinetPlannedDocument[] = [];
	const plan = (metadata: EquityPendingFiling, skipKnown: boolean): void => {
		const docId = metadata.sourceDocumentId;
		if (seen.has(docId) || (skipKnown && known.has(docId))) return;
		seen.add(docId);
		planned.push({
			metadata,
			action: planned.length < input.maxDownloads ? "download" : "deferred",
		});
	};
	for (const pending of input.pending) plan(pending, false);
	for (const indexed of input.indexed) plan(indexed, true);
	return planned;
}
