/**
 * US annual filings and their facts from SEC EDGAR (ADR-0048 §6, SEC).
 *
 * One `financial-sync` job reads:
 *  1. SEC's ticker list, only while the company's CIK is unknown (cached 12 h);
 *  2. the submissions JSON (`data.sec.gov/submissions/CIK##########.json`):
 *     identity and the recent filings as parallel arrays;
 *  3. the company facts JSON (`data.sec.gov/api/xbrl/companyfacts/…`), only
 *     when an annual report (10-K, 20-F, 40-F or an amendment, ADR-0058 §5)
 *     filed since `filedSince` is new or pending, or the claim asks for a
 *     full check. Company facts list every fact once per filing that
 *     reported it (`accn`), so one document gives every filing's as-filed
 *     facts — and the older annual filings the submissions page no longer
 *     lists. Facts are read from the `us-gaap` and the `ifrs-full` taxonomy;
 *     a filing's accounting standard is the taxonomy its facts came from
 *     (`indexSecCompanyFacts`);
 *  4. the newest original annual report's primary document, only when its
 *     accession is not the claim's `describedDocumentId` (ADR-0053 §2): a
 *     10-K's "Item 1. Business" or a 20-F's Item 4.B "Business Overview"
 *     becomes the completion's description (`secBusiness.ts`); a 40-F is
 *     recorded as not found without a request (its description is in an
 *     exhibit).
 *
 * Extraction is pure (`parseSecSubmissions`, `indexSecCompanyFacts`,
 * `secSyncResult`, `secNewestAnnualReport`, `secBusinessParagraphs`) and replayed
 * by the Rust runner from vectors. Correctness
 * beats coverage: an entry that does not parse, a value that is not exact
 * decimal text, a period that is not annual — each is left out, never
 * repaired or estimated.
 */
import type { Clock, SafeFetcher } from "@research/application";
import {
	type EquityBusinessDescription,
	type EquityBusinessSource,
	type EquityFilingResult,
	type EquitySyncFailureCode,
	isoDateTimeSchema,
	type SecSyncRequest,
	secAccessionSchema,
} from "@research/contracts";
import {
	type EquityBusinessForm,
	type EquityExtractedFact,
	err,
	isAmendmentForm,
	isCanonicalDecimal,
	isoDayNumber,
	isSecReportForm,
	ok,
	type Result,
	type SecReportForm,
} from "@research/domain";
import { z } from "zod";
import { htmlToMarkdown } from "../tools/htmlToMarkdown.ts";
import {
	annualFactsInOrder,
	businessDescriptionOf,
	COMPLETION_CAPS,
	type CompletionCaps,
	type EquitySyncData,
	type EquitySyncDescriptionUnread,
	type EquitySyncFailure,
	type EquitySyncIdentity,
	type EquitySyncQuery,
	type EquitySyncSource,
	equitySyncCodeOfStatus,
	fitCompletionCaps,
} from "./equitySync.ts";
import { secSubmissionsUrl } from "./sec13f.ts";
import {
	SEC_TEN_K_MAX_BYTES,
	SEC_TEN_K_MAX_MARKDOWN_CHARS,
	secBusinessParagraphs,
} from "./secBusiness.ts";
import {
	createSecClient,
	isUsableSecUserAgent,
	parseSecJson,
	type SecClient,
	type SecError,
} from "./secClient.ts";
import {
	COMPANY_FACTS_MAX_BYTES,
	createSecTickerDirectory,
	type SecTickerDirectory,
	secCompanyFactsUrl,
} from "./secFinancials.ts";

/** Submissions of a filer with a long history run to a few megabytes. */
export const SEC_SUBMISSIONS_MAX_BYTES = 8_000_000;
export const SEC_COMPANY_FACTS_MAX_BYTES = COMPANY_FACTS_MAX_BYTES;

/**
 * The company-facts taxonomies the sync reads, with the accounting standard
 * a filing tagged in each reports under (ADR-0058 §5). A concept names its
 * taxonomy as its prefix (`ifrs-full:Revenue` is `Revenue` under
 * `facts["ifrs-full"]`).
 */
export const SEC_TAXONOMIES = [
	{ taxonomy: "us-gaap", standard: "US-GAAP" },
	{ taxonomy: "ifrs-full", standard: "IFRS" },
] as const;
export type SecTaxonomy = (typeof SEC_TAXONOMIES)[number]["taxonomy"];
export type SecAccountingStandard = (typeof SEC_TAXONOMIES)[number]["standard"];
const MAX_NAME_CHARS = 200;
const MAX_UNIT_CHARS = 40;
/** SEC primary documents are plain file names ("aapl-20240928.htm"); anything else links the folder. */
const PRIMARY_DOCUMENT = /^[A-Za-z0-9._-]{1,200}$/;

function annualForm(form: string): SecReportForm | null {
	return isSecReportForm(form) ? form : null;
}

function validDate(text: string): boolean {
	return isoDayNumber(text) !== null;
}

/* ---------- Values ---------- */

/**
 * SEC's JSON number as exact decimal text: JavaScript's shortest round-trip
 * text (`Number#toString`, digits for every integer below 1e21), kept only
 * when it is canonical decimal text — an exponent form ("1e-7", "1e+21") is
 * skipped rather than expanded, since the number already lost the filing's
 * exact digits.
 */
export function secValueDecimal(val: number): string | null {
	if (!Number.isFinite(val)) return null;
	const text = String(val);
	return isCanonicalDecimal(text) ? text : null;
}

/* ---------- Submissions ---------- */

const submissionsSchema = z.object({
	name: z.string().nullable().optional(),
	fiscalYearEnd: z.string().nullable().optional(),
	filings: z.object({
		recent: z.object({
			accessionNumber: z.array(z.string()),
			filingDate: z.array(z.string()),
			reportDate: z.array(z.string()),
			acceptanceDateTime: z.array(z.string()),
			form: z.array(z.string()),
			primaryDocument: z.array(z.string()),
		}),
	}),
});

/** One annual report row (10-K, 20-F, 40-F or an amendment) of the submissions page, as SEC states it. */
export interface SecSubmissionRow {
	readonly accession: string;
	readonly form: SecReportForm;
	readonly filingDate: string;
	readonly reportDate: string;
	readonly acceptanceDateTime: string;
	readonly primaryDocument: string;
}

export interface SecSubmissions {
	/** Trimmed entity name; null when missing, blank or over 200 characters. */
	readonly name: string | null;
	/** "MM-DD" from SEC's "MMDD"; null when missing or not a month and day. */
	readonly fiscalYearEnd: string | null;
	/** The annual rows in SEC's order (newest first); other forms are dropped. */
	readonly annualRows: readonly SecSubmissionRow[];
}

const FISCAL_YEAR_END = /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

export function parseSecSubmissions(value: unknown): Result<SecSubmissions, "PARSE_FAILED"> {
	const parsed = submissionsSchema.safeParse(value);
	if (!parsed.success) return err("PARSE_FAILED");
	const recent = parsed.data.filings.recent;
	const count = recent.accessionNumber.length;
	// Parallel arrays of different lengths cannot be paired row by row.
	if (
		recent.filingDate.length !== count ||
		recent.reportDate.length !== count ||
		recent.acceptanceDateTime.length !== count ||
		recent.form.length !== count ||
		recent.primaryDocument.length !== count
	) {
		return err("PARSE_FAILED");
	}
	const annualRows: SecSubmissionRow[] = [];
	for (let index = 0; index < count; index += 1) {
		const form = annualForm(recent.form[index] ?? "");
		const accession = recent.accessionNumber[index] ?? "";
		if (form === null || !secAccessionSchema.safeParse(accession).success) continue;
		annualRows.push({
			accession,
			form,
			filingDate: recent.filingDate[index] ?? "",
			reportDate: recent.reportDate[index] ?? "",
			acceptanceDateTime: recent.acceptanceDateTime[index] ?? "",
			primaryDocument: recent.primaryDocument[index] ?? "",
		});
	}
	const name = (parsed.data.name ?? "").trim();
	const yearEnd = FISCAL_YEAR_END.exec(parsed.data.fiscalYearEnd ?? "");
	return ok({
		name: name.length >= 1 && name.length <= MAX_NAME_CHARS ? name : null,
		fiscalYearEnd: yearEnd === null ? null : `${yearEnd[1]}-${yearEnd[2]}`,
		annualRows,
	});
}

/* ---------- Company facts ---------- */

const factEntrySchema = z.object({
	start: z.string().optional(),
	end: z.string(),
	val: z.number(),
	accn: z.string(),
	form: z.string(),
	filed: z.string(),
});

const conceptSchema = z.object({ units: z.record(z.string(), z.array(z.unknown())) });

/** What company facts say about one annual accession, for the claimed concepts. */
export interface SecFactsOfAccession {
	/**
	 * The form of its first entry, or the last amendment form an entry states
	 * ("10-K/A" over "10-K").
	 */
	readonly form: SecReportForm;
	/** The earliest `filed` date its entries state. */
	readonly filed: string;
	/**
	 * The standard of the taxonomy its entries come from: the one with more
	 * entries for claimed concepts, US-GAAP on a tie. SEC's IFRS filers tag
	 * with `ifrs-full` only, so one filing does not mix them; an issuer that
	 * moved from US GAAP to IFRS (or back) has filings of each.
	 */
	readonly standard: SecAccountingStandard;
	/** Entries of that taxonomy for claimed concepts, including those whose value is not exact text. */
	readonly entryCount: number;
	/** Those entries as facts (value exact), before the annual filter. */
	readonly facts: readonly EquityExtractedFact[];
}

export type SecFactsIndex = ReadonlyMap<string, SecFactsOfAccession>;

interface TaxonomyEntries {
	entryCount: number;
	readonly facts: EquityExtractedFact[];
}

interface AccessionRecord {
	form: SecReportForm;
	filed: string;
	readonly byTaxonomy: { readonly [T in SecTaxonomy]: TaxonomyEntries };
}

function taxonomyOfConcept(
	concept: string,
): { readonly taxonomy: SecTaxonomy; readonly name: string } | null {
	for (const { taxonomy } of SEC_TAXONOMIES) {
		const prefix = `${taxonomy}:`;
		if (concept.startsWith(prefix)) return { taxonomy, name: concept.slice(prefix.length) };
	}
	return null;
}

/** An accession's standard and its entries of that taxonomy (`SecFactsOfAccession`). */
function factsOfAccession(record: AccessionRecord): SecFactsOfAccession {
	const usGaap = record.byTaxonomy["us-gaap"];
	const ifrs = record.byTaxonomy["ifrs-full"];
	const [standard, chosen]: readonly [SecAccountingStandard, TaxonomyEntries] =
		ifrs.entryCount > usGaap.entryCount ? ["IFRS", ifrs] : ["US-GAAP", usGaap];
	return {
		form: record.form,
		filed: record.filed,
		standard,
		entryCount: chosen.entryCount,
		facts: chosen.facts,
	};
}

/**
 * Indexes the company-facts document by accession in one pass over the
 * claimed concepts only (`us-gaap:Revenues` is looked up as `Revenues`
 * under `facts["us-gaap"]`, `ifrs-full:Revenue` as `Revenue` under
 * `facts["ifrs-full"]`), keeping entries of annual report filings (10-K,
 * 20-F, 40-F and their amendments). A malformed entry is skipped; a document
 * without the expected shape fails. Every fact is consolidated: company
 * facts carry no dimensional contexts.
 */
export function indexSecCompanyFacts(
	value: unknown,
	concepts: readonly string[],
): Result<SecFactsIndex, "PARSE_FAILED"> {
	const document = z.object({ facts: z.record(z.string(), z.unknown()) }).safeParse(value);
	if (!document.success) return err("PARSE_FAILED");
	const records = new Map<string, AccessionRecord>();
	const taxonomies = new Map<SecTaxonomy, { readonly [name: string]: unknown } | null>();
	const taxonomyData = (taxonomy: SecTaxonomy) => {
		let data = taxonomies.get(taxonomy);
		if (data === undefined) {
			const parsed = z.record(z.string(), z.unknown()).safeParse(document.data.facts[taxonomy]);
			// A filer without facts of a taxonomy has no entries for its concepts.
			data = parsed.success ? parsed.data : null;
			taxonomies.set(taxonomy, data);
		}
		return data;
	};
	for (const concept of new Set(concepts)) {
		const qualified = taxonomyOfConcept(concept);
		if (qualified === null) continue;
		const { taxonomy, name } = qualified;
		const data = taxonomyData(taxonomy);
		if (data === null || !Object.hasOwn(data, name)) continue;
		const parsedConcept = conceptSchema.safeParse(data[name]);
		if (!parsedConcept.success) continue;
		for (const [unit, entries] of Object.entries(parsedConcept.data.units)) {
			if (unit.length < 1 || unit.length > MAX_UNIT_CHARS) continue;
			for (const raw of entries) {
				const entry = factEntrySchema.safeParse(raw);
				if (!entry.success) continue;
				const { start, end, val, accn, form, filed } = entry.data;
				const annual = annualForm(form);
				if (annual === null || !secAccessionSchema.safeParse(accn).success) continue;
				if (!validDate(end) || !validDate(filed) || (start !== undefined && !validDate(start))) {
					continue;
				}
				let record = records.get(accn);
				if (record === undefined) {
					record = {
						form: annual,
						filed,
						byTaxonomy: {
							"us-gaap": { entryCount: 0, facts: [] },
							"ifrs-full": { entryCount: 0, facts: [] },
						},
					};
					records.set(accn, record);
				}
				if (isAmendmentForm(annual)) record.form = annual;
				if (filed < record.filed) record.filed = filed;
				const entries = record.byTaxonomy[taxonomy];
				entries.entryCount += 1;
				const valueDecimal = secValueDecimal(val);
				if (valueDecimal === null) continue;
				entries.facts.push({
					concept,
					unit,
					valueDecimal,
					periodType: start === undefined ? "instant" : "duration",
					periodStart: start ?? null,
					periodEnd: end,
					scope: "consolidated",
				});
			}
		}
	}
	const index = new Map<string, SecFactsOfAccession>();
	for (const [accession, record] of records) index.set(accession, factsOfAccession(record));
	return ok(index);
}

/* ---------- The sync result ---------- */

/** The archive folder of an accession, or its primary document when SEC names a plain file. */
export function secFilingUrl(
	cik: string,
	accession: string,
	primaryDocument: string | null,
): string {
	const folder = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${accession.replaceAll("-", "")}/`;
	return primaryDocument !== null && PRIMARY_DOCUMENT.test(primaryDocument)
		? `${folder}${primaryDocument}`
		: folder;
}

/** An original annual report: the forms a business description is read from. */
export interface SecOriginalReportRow extends SecSubmissionRow {
	readonly form: Exclude<EquityBusinessForm, "securities-report">;
}

function isOriginalReportRow(row: SecSubmissionRow): row is SecOriginalReportRow {
	return row.form === "10-K" || row.form === "20-F" || row.form === "40-F";
}

/**
 * The annual report whose business section describes the company (ADR-0053
 * §2, ADR-0058 §5): the newest original 10-K, 20-F or 40-F of the
 * submissions page — greatest filing date, then accession — with a valid
 * filing and report date and a plain primary document name. Amendments
 * rarely repeat the section and are never read; an issuer that changed form
 * is described by its newest report.
 */
export function secNewestAnnualReport(submissions: SecSubmissions): SecOriginalReportRow | null {
	let newest: SecOriginalReportRow | null = null;
	for (const row of submissions.annualRows) {
		if (!isOriginalReportRow(row) || !validDate(row.filingDate) || !validDate(row.reportDate)) {
			continue;
		}
		if (!PRIMARY_DOCUMENT.test(row.primaryDocument)) continue;
		if (
			newest === null ||
			row.filingDate > newest.filingDate ||
			(row.filingDate === newest.filingDate && row.accession > newest.accession)
		) {
			newest = row;
		}
	}
	return newest;
}

/** The filing an annual report's description is read from: its primary document. */
export function secAnnualReportSource(
	cik: string,
	row: SecOriginalReportRow,
): EquityBusinessSource {
	return {
		sourceDocumentId: row.accession,
		form: row.form,
		filedOn: row.filingDate,
		periodEnd: row.reportDate,
		sourceUrl: secFilingUrl(cik, row.accession, row.primaryDocument),
	};
}

/**
 * The description of a 10-K or 20-F from its primary document's HTML:
 * converted to Markdown (cut at 4,000,000 characters; the section sits in
 * the first part), then the section's paragraphs, "not-found" when there
 * are none. Any other form (a 40-F) is "not-found": the runner does not
 * download it.
 */
export function secAnnualReportDescription(
	source: EquityBusinessSource,
	html: string,
): EquityBusinessDescription {
	if (source.form !== "10-K" && source.form !== "20-F") {
		return businessDescriptionOf(source, { paragraphs: [], truncated: false });
	}
	const page = htmlToMarkdown(html, {
		baseUrl: source.sourceUrl,
		maxChars: SEC_TEN_K_MAX_MARKDOWN_CHARS,
	});
	return businessDescriptionOf(source, secBusinessParagraphs(page.markdown, source.form));
}

/** Accessions the claim already stores (and does not offer again as pending). */
function settledAccessions(request: SecSyncRequest): ReadonlySet<string> {
	const pending = new Set(request.pendingFilings.map((filing) => filing.sourceDocumentId));
	return new Set(request.knownAccessions.filter((accession) => !pending.has(accession)));
}

/**
 * Whether the company facts must be read (ADR-0048 §6): a full check, a
 * pending filing, or an annual report row filed since `filedSince` whose
 * accession the claim does not store yet and that has a valid report date.
 *
 * A row without a valid report date (seen on 10-K/A) is stored only when
 * company facts list its accession — its period end then comes from its
 * facts. Without facts it has no period end that is not a guess (SEC does
 * not say which 10-K an amendment amends), so it is never stored, stays
 * "new", and would download up to 48 MB of company facts on every daily
 * sync for six years. It therefore does not trigger the request by itself:
 * the next read for another reason (a new filing, a full check) still
 * stores it if facts list it.
 */
export function secNeedsCompanyFacts(
	request: SecSyncRequest,
	submissions: SecSubmissions,
): boolean {
	if (request.fullCheck || request.pendingFilings.length > 0) return true;
	const known = new Set(request.knownAccessions);
	return submissions.annualRows.some(
		(row) =>
			validDate(row.filingDate) &&
			row.filingDate >= request.filedSince &&
			validDate(row.reportDate) &&
			!known.has(row.accession),
	);
}

/**
 * The facts an annual report contributes (ADR-0048 §4, SEC): its annual
 * facts (`annualFactsInOrder`), with instants only at the filing's own
 * fiscal-year end and the one before it — the latest two ends of the annual
 * durations it reports, i.e. the two balance-sheet columns. Durations are
 * kept for every annual year (three income-statement years are as filed).
 *
 * Why: a 10-K's statement of stockholders' equity states opening balances
 * two and three years back as instants at earlier fiscal-year ends. Kept,
 * they would make the latest 10-K the "latest filing" of those old years and
 * replace the balance sheet value of the 10-K that reported that year (with
 * a different concept, e.g. parent-only `StockholdersEquity` for
 * `StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest`),
 * so the metric's definition would change between years and the cell would
 * read as revised when nothing was restated.
 */
export function secFilingFacts(
	facts: readonly EquityExtractedFact[],
): readonly EquityExtractedFact[] {
	const annual = annualFactsInOrder(facts);
	let latest: string | null = null;
	let previous: string | null = null;
	for (const fact of annual) {
		if (fact.periodType !== "duration") continue;
		const end = fact.periodEnd;
		if (end === latest || end === previous) continue;
		if (latest === null || end > latest) {
			previous = latest;
			latest = end;
		} else if (previous === null || end > previous) {
			previous = end;
		}
	}
	return annual.filter(
		(fact) =>
			fact.periodType === "duration" || fact.periodEnd === latest || fact.periodEnd === previous,
	);
}

/** The latest end of an annual duration among a filing's facts, else the latest end at all. */
function latestPeriodEnd(record: SecFactsOfAccession): string | null {
	let annualEnd: string | null = null;
	for (const fact of annualFactsInOrder(record.facts)) {
		if (fact.periodType === "duration" && (annualEnd === null || fact.periodEnd > annualEnd)) {
			annualEnd = fact.periodEnd;
		}
	}
	if (annualEnd !== null) return annualEnd;
	let anyEnd: string | null = null;
	for (const fact of record.facts) {
		if (anyEnd === null || fact.periodEnd > anyEnd) anyEnd = fact.periodEnd;
	}
	return anyEnd;
}

export interface SecSyncInput {
	readonly request: SecSyncRequest;
	/** Ten digits: the claim's, or the one resolved from SEC's ticker list. */
	readonly cik: string;
	readonly submissions: SecSubmissions;
	/** Null when the company facts were not read (nothing new) or SEC has none (404). */
	readonly facts: SecFactsIndex | null;
}

/**
 * The completion fields of an SEC sync (ADR-0048 §6), pure:
 *
 * - pending filings come back with the claim's stored metadata;
 * - new annual report rows of the submissions page filed since
 *   `filedSince` take their metadata from it (filing and report date,
 *   acceptance instant, primary document);
 * - new annual accessions that only company facts list (older filings),
 *   filed since `filedSince`, take theirs from the facts: `filed`, the
 *   latest annual period end, the archive folder;
 * - a filing is `extracted` with its facts (`secFilingFacts`) and the
 *   standard of their taxonomy when company facts hold an entry of it for
 *   any claimed concept, else `not-available`;
 * - then the completion caps (`fitCompletionCaps`).
 */
export function secSyncResult(
	input: SecSyncInput,
	caps: CompletionCaps = COMPLETION_CAPS,
): {
	readonly identity: EquitySyncIdentity;
	readonly filings: readonly EquityFilingResult[];
	readonly more: boolean;
} {
	const { request, cik, submissions, facts } = input;
	const settled = settledAccessions(request);
	const seen = new Set<string>();
	const filings: EquityFilingResult[] = [];

	const withFacts = (
		metadata: Omit<EquityFilingResult, "accountingStandard" | "factsStatus" | "facts">,
	): EquityFilingResult => {
		const record = facts?.get(metadata.sourceDocumentId);
		if (record === undefined || record.entryCount === 0) {
			return { ...metadata, accountingStandard: null, factsStatus: "not-available", facts: [] };
		}
		return {
			...metadata,
			accountingStandard: record.standard,
			factsStatus: "extracted",
			facts: [...secFilingFacts(record.facts)],
		};
	};

	for (const pending of request.pendingFilings) {
		if (seen.has(pending.sourceDocumentId)) continue;
		seen.add(pending.sourceDocumentId);
		filings.push(withFacts({ ...pending }));
	}

	for (const row of submissions.annualRows) {
		if (seen.has(row.accession) || settled.has(row.accession)) continue;
		if (!validDate(row.filingDate) || row.filingDate < request.filedSince) continue;
		const record = facts?.get(row.accession);
		const periodEnd = validDate(row.reportDate)
			? row.reportDate
			: record === undefined
				? null
				: latestPeriodEnd(record);
		if (periodEnd === null) continue;
		seen.add(row.accession);
		filings.push(
			withFacts({
				sourceDocumentId: row.accession,
				form: row.form,
				filedOn: row.filingDate,
				submittedAt: isoDateTimeSchema.safeParse(row.acceptanceDateTime).success
					? row.acceptanceDateTime
					: null,
				periodStart: null,
				periodEnd,
				amendsSourceDocumentId: null,
				sourceUrl: secFilingUrl(cik, row.accession, row.primaryDocument),
			}),
		);
	}

	if (facts !== null) {
		for (const [accession, record] of facts) {
			if (seen.has(accession) || settled.has(accession)) continue;
			if (record.filed < request.filedSince) continue;
			const periodEnd = latestPeriodEnd(record);
			if (periodEnd === null) continue;
			seen.add(accession);
			filings.push(
				withFacts({
					sourceDocumentId: accession,
					form: record.form,
					filedOn: record.filed,
					submittedAt: null,
					periodStart: null,
					periodEnd,
					amendsSourceDocumentId: null,
					sourceUrl: secFilingUrl(cik, accession, null),
				}),
			);
		}
	}

	const capped = fitCompletionCaps(filings, caps);
	return {
		identity: {
			sourceCompanyId: cik,
			name: submissions.name,
			fiscalYearEnd: submissions.fiscalYearEnd,
		},
		filings: capped.filings,
		more: capped.cut.length > 0,
	};
}

/* ---------- Failures ---------- */

/**
 * An SEC client error as a sync failure. SEC's status decides when it
 * answered with one (401/403 denied, 429 rate limited, anything else a
 * source failure — 404 included: a CIK whose submissions are missing is
 * SEC's problem, not proof the company does not exist); without a status,
 * an oversized or malformed answer is a parse failure and a timeout or
 * network error a source failure.
 */
export function equitySyncFailureOfSec(error: SecError, requests: number): EquitySyncFailure {
	if (error.code === "NOT_CONFIGURED") {
		return { code: "FINANCIAL_SOURCE_NOT_CONFIGURED", upstreamStatus: null, requests };
	}
	if (error.upstreamStatus !== null) {
		return {
			code: equitySyncCodeOfStatus(error.upstreamStatus),
			upstreamStatus: error.upstreamStatus,
			requests,
		};
	}
	const code: EquitySyncFailureCode =
		error.code === "RESPONSE_TOO_LARGE" || error.code === "UNEXPECTED_RESPONSE"
			? "FINANCIAL_PARSE_FAILED"
			: error.code === "ACCESS_DENIED"
				? "FINANCIAL_ACCESS_DENIED"
				: error.code === "RATE_LIMITED"
					? "FINANCIAL_RATE_LIMITED"
					: "FINANCIAL_SOURCE_FAILED";
	return { code, upstreamStatus: null, requests };
}

/* ---------- Source ---------- */

export interface SecAnnualFilingsDeps {
	readonly fetcher: SafeFetcher;
	readonly clock: Clock;
	/** SEC_USER_AGENT; null (or unusable) = SEC is not configured and nothing is requested. */
	readonly userAgent: string | null;
	/** Injected in tests; the SEC client's own spacing sleep. */
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export function createSecAnnualFilingsSource(deps: SecAnnualFilingsDeps): EquitySyncSource {
	const client: SecClient = createSecClient({
		fetcher: deps.fetcher,
		clock: deps.clock,
		userAgent: deps.userAgent,
		...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
	});
	const directory: SecTickerDirectory = createSecTickerDirectory({
		client,
		nowMs: () => deps.clock.nowMs(),
	});

	return {
		provider: "sec",
		async sync(query: EquitySyncQuery): Promise<Result<EquitySyncData, EquitySyncFailure>> {
			const request = query.target.source;
			if (request.provider !== "sec") {
				return err({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests: 0 });
			}
			let requests = 0;
			const fail = (error: SecError): Result<never, EquitySyncFailure> =>
				err(equitySyncFailureOfSec(error, requests));
			const stopped = (): Result<never, EquitySyncFailure> =>
				err({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests });
			/** One paced SEC request; null when the job stopped while waiting. */
			const fetchJson = async (
				url: string,
				maxBytes: number,
			): Promise<Result<unknown, SecError> | null> => {
				if (!(await query.beforeRequest())) return null;
				requests += 1;
				const document = await client.fetchDocument(url, {
					maxBytes,
					accept: "application/json",
					signal: query.signal,
				});
				return document.ok ? parseSecJson(document.value) : document;
			};

			// Without a usable User-Agent nothing is requested at all.
			if (!isUsableSecUserAgent(deps.userAgent)) {
				return err({ code: "FINANCIAL_SOURCE_NOT_CONFIGURED", upstreamStatus: null, requests });
			}

			let cik = request.cik;
			if (cik === null) {
				const found = await directory.lookup(query.target.symbol, {
					signal: query.signal,
					beforeRequest: async () => {
						if (!(await query.beforeRequest())) return false;
						requests += 1;
						return true;
					},
				});
				if (!found.ok) {
					// The ticker list itself missing (404) means SEC cannot name the company.
					return found.error.code === "NOT_FOUND"
						? err({
								code: "FINANCIAL_COMPANY_NOT_FOUND",
								upstreamStatus: found.error.upstreamStatus,
								requests,
							})
						: fail(found.error);
				}
				if (found.value.issuer === null) {
					return err({ code: "FINANCIAL_COMPANY_NOT_FOUND", upstreamStatus: null, requests });
				}
				cik = found.value.issuer.cik;
			}

			const submissionsJson = await fetchJson(secSubmissionsUrl(cik), SEC_SUBMISSIONS_MAX_BYTES);
			if (submissionsJson === null) return stopped();
			if (!submissionsJson.ok) return fail(submissionsJson.error);
			const submissions = parseSecSubmissions(submissionsJson.value);
			if (!submissions.ok) {
				return err({ code: "FINANCIAL_PARSE_FAILED", upstreamStatus: null, requests });
			}

			let facts: SecFactsIndex | null = null;
			if (secNeedsCompanyFacts(request, submissions.value)) {
				const factsJson = await fetchJson(secCompanyFactsUrl(cik), SEC_COMPANY_FACTS_MAX_BYTES);
				if (factsJson === null) return stopped();
				if (!factsJson.ok) {
					// SEC has no company facts for a filer without XBRL data: every
					// filing is then not available (yet), which is not a failure.
					if (factsJson.error.code !== "NOT_FOUND") return fail(factsJson.error);
					facts = new Map();
				} else {
					const indexed = indexSecCompanyFacts(factsJson.value, query.target.concepts);
					if (!indexed.ok) {
						return err({ code: "FINANCIAL_PARSE_FAILED", upstreamStatus: null, requests });
					}
					facts = indexed.value;
				}
			}

			const result = secSyncResult({ request, cik, submissions: submissions.value, facts });

			// The business description: one more request only for a 10-K or 20-F
			// not read yet; a 40-F is recorded as not found without one.
			let description: EquityBusinessDescription | null = null;
			let descriptionUnread: EquitySyncDescriptionUnread | null = null;
			const report = secNewestAnnualReport(submissions.value);
			const source =
				report !== null && report.accession !== request.describedDocumentId
					? secAnnualReportSource(cik, report)
					: null;
			if (source !== null && source.form === "40-F") {
				description = businessDescriptionOf(source, { paragraphs: [], truncated: false });
			} else if (source !== null) {
				if (!(await query.beforeRequest())) return stopped();
				requests += 1;
				const document = await client.fetchDocument(source.sourceUrl, {
					maxBytes: SEC_TEN_K_MAX_BYTES,
					accept: "text/html",
					signal: query.signal,
				});
				if (document.ok) {
					description = secAnnualReportDescription(source, document.value.text);
				} else if (query.signal.aborted) {
					// A stopped job fails as it does on any other request.
					return fail(document.error);
				} else if (document.error.code === "RESPONSE_TOO_LARGE") {
					// A retry would not shrink it: recorded as not found, not downloaded daily.
					description = businessDescriptionOf(source, { paragraphs: [], truncated: false });
				} else {
					// No description this time (the next daily sync asks again), but logged.
					const failure = equitySyncFailureOfSec(document.error, requests);
					descriptionUnread = { code: failure.code, upstreamStatus: failure.upstreamStatus };
				}
			}
			return ok({
				...result,
				requests,
				unreadableDocuments: [],
				description,
				descriptionUnread,
			});
		},
	};
}
