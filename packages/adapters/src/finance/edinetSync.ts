/**
 * Japanese annual reports from EDINET API v2 (ADR-0048 §6, ADR-0058 §4):
 * the source a `financial-sync` job of a JP company runs.
 *
 * 1. No `EDINET_API_KEY`: fail `FINANCIAL_SOURCE_NOT_CONFIGURED` before any request.
 * 2. The claim names the reports to download: its `pendingFilings` and the
 *    reports the shared `edinet-index` lists for the company's securities
 *    code that are not stored yet (`indexedFilings`), each with its stored
 *    or indexed metadata, which the completion echoes back unchanged. No
 *    date list is read here: each date is listed once, for every company,
 *    by the `edinet-index` job.
 * 3. Plan the downloads (`edinetDownloadPlan`: pending first, then indexed,
 *    at most `maxDocumentsPerJob`, the rest deferred) and fetch each planned
 *    XBRL-to-CSV ZIP (paced by the runner's `edinet` gate at one per
 *    second): 404 → not available yet; an answer that is not a readable
 *    main report (a malformed ZIP, no `jpcrp` CSV, a CSV without the header,
 *    neither a ZIP nor an EDINET error) → that filing is not available and
 *    the document is listed in `unreadableDocuments`; the other documents go
 *    on. Failing the job instead would plan the same document first on
 *    every claim and block the company for good; as `not-available` the API
 *    keeps the filing pending (re-offered) within its grace period, then
 *    records it unavailable. Only an HTTP error status (or a network
 *    failure) still fails the job.
 * 4. Completion caps (`fitCompletionCaps`); a cut filing stays in the index
 *    and is named again, and `more` makes the API schedule the next job at once.
 * 5. The business description (ADR-0053 §2): every annual securities report
 *    (120) read gives its 事業の内容; the claim's `describeFiling`, when this
 *    job does not plan it anyway and the download cap leaves room, is
 *    downloaded for that alone (a failure there only means no description).
 *    The completion carries the newest report's (`newerBusinessDescription`).
 *
 * The subscription key is a query parameter: URLs here are never logged.
 */
import type { SafeBinaryFetcher } from "@research/application";
import {
	EQUITY_FINANCIAL_LIMITS,
	type EquityBusinessDescription,
	type EquityFilingResult,
	type EquityPendingFiling,
} from "@research/contracts";
import { type BusinessParagraphs, err, ok, parseJson, type Result } from "@research/domain";
import { EDINET_ZIP_LIMITS, extractEdinetReport } from "./edinetCsv.ts";
import {
	EDINET_API_HOST,
	edinetDocumentUrl,
	edinetDownloadPlan,
	edinetErrorStatus,
	edinetIdentity,
} from "./edinetDocuments.ts";
import {
	businessDescriptionOf,
	type EquitySyncData,
	type EquitySyncDescriptionUnread,
	type EquitySyncFailure,
	type EquitySyncQuery,
	type EquitySyncSource,
	type EquitySyncUnreadableDocument,
	equitySyncCodeOfStatus,
	equitySyncFailureOfFetch,
	fitCompletionCaps,
	newerBusinessDescription,
} from "./equitySync.ts";

export const EDINET_ZIP_MAX_BYTES = EDINET_ZIP_LIMITS.maxArchiveBytes;
const EDINET_ZIP_TIMEOUT_MS = 60_000;
const EDINET_ALLOWED_HOSTS: ReadonlySet<string> = new Set([EDINET_API_HOST]);
const DOCUMENT_ACCEPT = "application/octet-stream, application/zip, application/json";

/** ZIP local-header signature "PK\x03\x04": anything else is EDINET's error JSON or garbage. */
function looksLikeZip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The description of a securities report (120) read by this job. */
function reportDescription(
	metadata: Pick<EquityPendingFiling, "sourceDocumentId" | "filedOn" | "sourceUrl">,
	periodEnd: string,
	report: { readonly business: BusinessParagraphs },
): EquityBusinessDescription {
	return businessDescriptionOf(
		{
			sourceDocumentId: metadata.sourceDocumentId,
			form: "securities-report",
			filedOn: metadata.filedOn,
			periodEnd,
			sourceUrl: metadata.sourceUrl,
		},
		report.business,
	);
}

export interface EdinetSourceDeps {
	readonly binaryFetcher: SafeBinaryFetcher;
	/** EDINET_API_KEY; null = EDINET is not configured and nothing is requested. */
	readonly apiKey: string | null;
}

export function createEdinetSource(deps: EdinetSourceDeps): EquitySyncSource {
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

			const plan = edinetDownloadPlan({
				pending: request.pendingFilings,
				indexed: request.indexedFilings,
				knownFilings: request.knownFilings,
				maxDownloads: EQUITY_FINANCIAL_LIMITS.maxDocumentsPerJob,
			});
			const filings: EquityFilingResult[] = [];
			const unreadableDocuments: EquitySyncUnreadableDocument[] = [];
			let description: EquityBusinessDescription | null = null;
			let descriptionUnread: EquitySyncDescriptionUnread | null = null;
			const download = (docId: string) =>
				deps.binaryFetcher.fetchBytes(edinetDocumentUrl(docId, apiKey), {
					maxBytes: EDINET_ZIP_MAX_BYTES,
					timeoutMs: EDINET_ZIP_TIMEOUT_MS,
					accept: DOCUMENT_ACCEPT,
					allowedHosts: EDINET_ALLOWED_HOSTS,
					signal: query.signal,
				});
			for (const document of plan) {
				const { metadata } = document;
				const notDownloaded = (factsStatus: "not-available" | "deferred"): void => {
					filings.push({ ...metadata, accountingStandard: null, factsStatus, facts: [] });
				};
				if (document.action === "deferred") {
					notDownloaded("deferred");
					continue;
				}
				if (!(await query.beforeRequest())) return failure("FINANCIAL_SOURCE_FAILED");
				requests += 1;
				const fetched = await download(metadata.sourceDocumentId);
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
					if (status === null || status < 400) {
						// Neither a ZIP nor an error status: this document is unreadable, not the source.
						unreadableDocuments.push({
							sourceDocumentId: metadata.sourceDocumentId,
							problem: "NOT_A_ZIP",
						});
						notDownloaded("not-available");
						continue;
					}
				}
				if (status === 404) {
					// The CSV can lag the filing: not available yet, offered again later.
					notDownloaded("not-available");
					continue;
				}
				if (status !== null) return failure(equitySyncCodeOfStatus(status), status);
				if (!fetched.ok) return failure("FINANCIAL_SOURCE_FAILED");
				const report = extractEdinetReport(fetched.value.bytes, query.target.concepts);
				if (!report.ok) {
					unreadableDocuments.push({
						sourceDocumentId: metadata.sourceDocumentId,
						problem: report.error,
					});
					notDownloaded("not-available");
					continue;
				}
				filings.push({
					...metadata,
					accountingStandard: report.value.accountingStandard,
					factsStatus: "extracted",
					facts: [...report.value.facts],
				});
				// Amendments rarely repeat 事業の内容: only an original report describes.
				if (metadata.form === "securities-report") {
					description = newerBusinessDescription(
						description,
						reportDescription(metadata, metadata.periodEnd, report.value),
					);
				}
			}

			// A stored report newer than the stored description, read for that alone.
			const describe = request.describeFiling;
			const downloads = plan.filter((document) => document.action === "download").length;
			if (
				describe !== null &&
				describe.form === "securities-report" &&
				downloads < EQUITY_FINANCIAL_LIMITS.maxDocumentsPerJob &&
				!plan.some((document) => document.metadata.sourceDocumentId === describe.sourceDocumentId)
			) {
				if (!(await query.beforeRequest())) return failure("FINANCIAL_SOURCE_FAILED");
				requests += 1;
				const fetched = await download(describe.sourceDocumentId);
				// A stopped job fails as on any other request; any other failure only
				// means no description from it (the next sync asks again), logged.
				if (!fetched.ok) {
					const failure = equitySyncFailureOfFetch(fetched.error, requests);
					if (query.signal.aborted) return err(failure);
					descriptionUnread = { code: failure.code, upstreamStatus: failure.upstreamStatus };
				} else if (!looksLikeZip(fetched.value.bytes)) {
					// EDINET answers some errors as JSON with HTTP 200: its own status, else unreadable.
					const json = parseJson(new TextDecoder("utf-8").decode(fetched.value.bytes));
					const status = json.ok ? edinetErrorStatus(json.value) : null;
					descriptionUnread =
						status !== null && status >= 400
							? { code: equitySyncCodeOfStatus(status), upstreamStatus: status }
							: { code: "NOT_A_ZIP", upstreamStatus: null };
				} else {
					const report = extractEdinetReport(fetched.value.bytes, query.target.concepts);
					if (report.ok) {
						description = newerBusinessDescription(
							description,
							reportDescription(describe, describe.periodEnd, report.value),
						);
					} else {
						descriptionUnread = { code: report.error, upstreamStatus: null };
					}
				}
			}

			const capped = fitCompletionCaps(filings);
			return ok({
				identity: edinetIdentity(request.edinetCode, [
					...request.indexedFilings,
					...request.pendingFilings,
				]),
				filings: capped.filings,
				more: capped.cut.length > 0,
				requests,
				unreadableDocuments,
				description,
				descriptionUnread,
			});
		},
	};
}
