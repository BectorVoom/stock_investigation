/**
 * Japanese annual reports from EDINET API v2 (ADR-0048 §6, EDINET): the
 * source a `financial-sync` job of a JP company runs.
 *
 * 1. No `EDINET_API_KEY`: fail `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request.
 * 2. List each `scanDays` date in claim order (one request each, paced by
 *    the runner's `edinet` gate at one per second); a date listed in the last
 *    24 hours answers from the cache. A failing date fails the job — the
 *    cache makes the retry cheap.
 * 3. Keep the annual rows whose securities code is the company's, plan the
 *    downloads (`edinetDownloadPlan`) and fetch each planned XBRL-to-CSV ZIP:
 *    404 → not available yet; an archive without a readable main report →
 *    `FINANCIAL_PARSE_FAILED`.
 * 4. Completion caps; a found filing that is cut takes its scan date out of
 *    `scannedDays`, so the next job lists that date again and finds it.
 *
 * The subscription key is a query parameter: URLs here are never logged.
 */
import type { Clock, SafeBinaryFetcher, SafeFetcher } from "@research/application";
import { EQUITY_FINANCIAL_LIMITS, type EquityFilingResult } from "@research/contracts";
import { err, ok, parseJson, type Result } from "@research/domain";
import { createBoundedCache } from "./boundedCache.ts";
import { EDINET_ZIP_LIMITS, extractEdinetReport } from "./edinetCsv.ts";
import {
	EDINET_API_HOST,
	type EdinetAnnualRow,
	type EdinetListedRow,
	edinetDocumentListUrl,
	edinetDocumentUrl,
	edinetDownloadPlan,
	edinetErrorStatus,
	edinetIdentity,
	parseEdinetDocumentList,
} from "./edinetDocuments.ts";
import {
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncQuery,
	type EquitySyncSource,
	equitySyncCodeOfStatus,
	equitySyncFailureOfFetch,
	fitCompletionCaps,
} from "./equitySync.ts";

/** A date's list is a few hundred kilobytes even at the late-June peak. */
export const EDINET_LIST_MAX_BYTES = 8_000_000;
export const EDINET_ZIP_MAX_BYTES = EDINET_ZIP_LIMITS.maxArchiveBytes;
const EDINET_LIST_TIMEOUT_MS = 30_000;
const EDINET_ZIP_TIMEOUT_MS = 60_000;
/** A date's annual rows are reused for a day: companies synced in turn share the listings. */
export const EDINET_DAY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Ten companies' discovery and backfill windows fit; a date's rows are small. */
export const EDINET_DAY_CACHE_CAPACITY = 1_000;
const EDINET_ALLOWED_HOSTS: ReadonlySet<string> = new Set([EDINET_API_HOST]);
const LIST_ACCEPT = "application/json";
const DOCUMENT_ACCEPT = "application/octet-stream, application/zip, application/json";

/** ZIP local-header signature "PK\x03\x04": anything else is EDINET's error JSON or garbage. */
function looksLikeZip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export interface EdinetSourceDeps {
	readonly fetcher: SafeFetcher;
	readonly binaryFetcher: SafeBinaryFetcher;
	/** EDINET_API_KEY; null = EDINET is not configured and nothing is requested. */
	readonly apiKey: string | null;
	/** Ages the per-date cache (injected, so tests are deterministic). */
	readonly clock: Clock;
}

export function createEdinetSource(deps: EdinetSourceDeps): EquitySyncSource {
	const dayCache = createBoundedCache<string, readonly EdinetAnnualRow[]>(
		EDINET_DAY_CACHE_CAPACITY,
		EDINET_DAY_CACHE_TTL_MS,
	);

	return {
		provider: "edinet",
		async sync(query: EquitySyncQuery): Promise<Result<EquitySyncData, EquitySyncFailure>> {
			const request = query.target.source;
			let requests = 0;
			const failure = (
				code: EquitySyncFailure["code"],
				upstreamStatus: number | null = null,
			): Result<never, EquitySyncFailure> => err({ code, upstreamStatus, requests });
			if (request.provider !== "edinet") return failure("FINANCIAL_SOURCE_FAILED");
			const apiKey = deps.apiKey;
			if (apiKey === null) return failure("FINANCIAL_SOURCE_NOT_CONFIGURED");

			const days = [...new Set(request.scanDays)];
			const found: EdinetListedRow[] = [];
			for (const day of days) {
				let rows = dayCache.get(day, deps.clock.nowMs());
				if (rows === undefined) {
					if (!(await query.beforeRequest())) return failure("FINANCIAL_SOURCE_FAILED");
					requests += 1;
					const listed = await deps.fetcher.fetchText(edinetDocumentListUrl(day, apiKey), {
						maxBytes: EDINET_LIST_MAX_BYTES,
						timeoutMs: EDINET_LIST_TIMEOUT_MS,
						accept: LIST_ACCEPT,
						allowedHosts: EDINET_ALLOWED_HOSTS,
						signal: query.signal,
					});
					if (!listed.ok) return err(equitySyncFailureOfFetch(listed.error, requests));
					const json = parseJson(listed.value.text);
					if (!json.ok) return failure("FINANCIAL_PARSE_FAILED");
					const parsed = parseEdinetDocumentList(json.value);
					if (!parsed.ok) {
						return parsed.error.kind === "parse"
							? failure("FINANCIAL_PARSE_FAILED")
							: failure(
									parsed.error.status === null
										? "FINANCIAL_SOURCE_FAILED"
										: equitySyncCodeOfStatus(parsed.error.status),
									parsed.error.status,
								);
					}
					rows = parsed.value;
					dayCache.set(day, rows, deps.clock.nowMs());
				}
				for (const row of rows) {
					if (row.secCode === request.secCode) found.push({ row, listedOn: day });
				}
			}

			const plan = edinetDownloadPlan({
				pending: request.pendingFilings,
				found,
				knownDocIds: request.knownDocIds,
				maxDownloads: EQUITY_FINANCIAL_LIMITS.maxDocumentsPerJob,
			});
			const filings: EquityFilingResult[] = [];
			const listedOn = new Map<string, string>();
			for (const document of plan) {
				const { metadata } = document;
				if (document.listedOn !== null) listedOn.set(metadata.sourceDocumentId, document.listedOn);
				if (document.action !== "download") {
					filings.push({
						...metadata,
						accountingStandard: null,
						factsStatus: document.action,
						facts: [],
					});
					continue;
				}
				if (!(await query.beforeRequest())) return failure("FINANCIAL_SOURCE_FAILED");
				requests += 1;
				const fetched = await deps.binaryFetcher.fetchBytes(
					edinetDocumentUrl(metadata.sourceDocumentId, apiKey),
					{
						maxBytes: EDINET_ZIP_MAX_BYTES,
						timeoutMs: EDINET_ZIP_TIMEOUT_MS,
						accept: DOCUMENT_ACCEPT,
						allowedHosts: EDINET_ALLOWED_HOSTS,
						signal: query.signal,
					},
				);
				let status: number | null = null;
				if (!fetched.ok) {
					if (fetched.error.code !== "HTTP_ERROR") {
						return err(equitySyncFailureOfFetch(fetched.error, requests));
					}
					status = fetched.error.status;
				} else if (!looksLikeZip(fetched.value.bytes)) {
					// EDINET answers some errors as JSON with HTTP 200: its own status decides.
					const json = parseJson(new TextDecoder("utf-8").decode(fetched.value.bytes));
					status = json.ok ? edinetErrorStatus(json.value) : null;
					// Neither a ZIP nor an error status: not the document EDINET documents.
					if (status === null || status < 400) return failure("FINANCIAL_PARSE_FAILED");
				}
				if (status === 404) {
					// The CSV can lag the filing: not available yet, offered again later.
					filings.push({
						...metadata,
						accountingStandard: null,
						factsStatus: "not-available",
						facts: [],
					});
					continue;
				}
				if (status !== null) return failure(equitySyncCodeOfStatus(status), status);
				if (!fetched.ok) return failure("FINANCIAL_SOURCE_FAILED");
				const report = extractEdinetReport(fetched.value.bytes, query.target.concepts);
				if (!report.ok) return failure("FINANCIAL_PARSE_FAILED");
				filings.push({
					...metadata,
					accountingStandard: report.value.accountingStandard,
					factsStatus: "extracted",
					facts: [...report.value.facts],
				});
			}

			const capped = fitCompletionCaps(filings);
			// A cut filing found by this scan must be found again: its date is not reported scanned.
			const unfinished = new Set<string>();
			for (const filing of capped.cut) {
				const day = listedOn.get(filing.sourceDocumentId);
				if (day !== undefined) unfinished.add(day);
			}
			return ok({
				identity: edinetIdentity(
					found.map((listed) => listed.row),
					request.edinetCode,
				),
				scannedDays: days.filter((day) => !unfinished.has(day)),
				filings: capped.filings,
				more: capped.cut.length > 0,
				requests,
			});
		},
	};
}
