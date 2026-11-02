/**
 * Japanese annual statements and company profiles from J-Quants (ADR-0059),
 * fetched by the local runner with the owner's `JQUANTS_API_KEY` through the
 * same pinned host, fetch options and `x-api-key` header as the prices
 * (`jquants.ts`).
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/jquants.md
 *
 *  - Statements (`financial-sync`, provider `jquants`, §2): one query
 *    `GET /v2/fins/summary?code=<5-char>`, every page (`pagination_key`, at
 *    most `JQUANTS_MAX_PAGES`), each page admitted by the runner's
 *    `jquants-fins` gate. `jquantsSummariesToSync` turns the answer into
 *    the completion's identity and filings (pure; the Rust runner mirrors
 *    it and replays `vectors/finance/jquants_financials.json`).
 *  - Profiles (the JP `stock-directory-refresh`, §3): `GET
 *    /v2/equities/master` with no parameters, every page, paced under
 *    `jquants`; `jquantsMasterToProfiles` (pure, vectors
 *    `vectors/finance/jquants_profiles.json`).
 *
 * Status mapping of the statements query: 400 → FINANCIAL_PARSE_FAILED (the
 * API never builds a malformed code); 401/403 → FINANCIAL_ACCESS_DENIED;
 * 429 → FINANCIAL_RATE_LIMITED (the runner holds `jquants-fins`); any other
 * status or a transport failure → FINANCIAL_SOURCE_FAILED — the status kept
 * unchanged (ADR-0037). The error body is never logged or stored.
 */
import type { SafeFetchError, SafeFetcher, SafeFetchOptions } from "@research/application";
import {
	type EquityFilingResult,
	type StockCompanyProfile,
	stockCompanyProfileSchema,
} from "@research/contracts";
import {
	type EquityAccountingStandard,
	type EquityExtractedFact,
	type EquityScope,
	err,
	isCanonicalDecimal,
	isoDayNumber,
	ok,
	type Result,
} from "@research/domain";
import {
	compareFacts,
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncIdentity,
	type EquitySyncQuery,
	type EquitySyncSource,
	equitySyncFailureOfFetch,
	fitCompletionCaps,
} from "./equitySync.ts";
import {
	JQUANTS_HOST,
	JQUANTS_MAX_PAGES,
	JQUANTS_PAGE_MAX_BYTES,
	JQUANTS_TIMEOUT_MS,
	parseJquantsPage,
} from "./jquants.ts";
import { fetchJsonDocument } from "./marketFetch.ts";

const JQUANTS_ALLOWED_HOSTS: ReadonlySet<string> = new Set([JQUANTS_HOST]);
/** The earnings summaries query (ADR-0059 §2). */
export const JQUANTS_FINS_SUMMARY_PATH = "/v2/fins/summary";
/** The Listed Issue Master query (ADR-0059 §3). */
export const JQUANTS_MASTER_PATH = "/v2/equities/master";
/** A full-year earnings summary's `DocType` prefix; every other kind carries no annual actuals. */
export const JQUANTS_FULL_YEAR_DOC_TYPE_PREFIX = "FYFinancialStatements_";

/** J-Quants states every amount in yen. */
const JQUANTS_UNIT = "JPY";

/**
 * The summary items kept as facts (ADR-0059 §2): the period they cover, and
 * the non-consolidated (`NC…`) item of a consolidated filer stored under the
 * same concept with scope `separate`.
 */
const JQUANTS_ITEMS: readonly {
	readonly item: string;
	readonly period: "duration" | "instant";
	readonly separateItem: string | null;
}[] = [
	{ item: "Sales", period: "duration", separateItem: "NCSales" },
	{ item: "OP", period: "duration", separateItem: "NCOP" },
	{ item: "OdP", period: "duration", separateItem: "NCOdP" },
	{ item: "NP", period: "duration", separateItem: "NCNP" },
	{ item: "CFO", period: "duration", separateItem: null },
	{ item: "CFI", period: "duration", separateItem: null },
	{ item: "CFF", period: "duration", separateItem: null },
	{ item: "TA", period: "instant", separateItem: "NCTA" },
	{ item: "Eq", period: "instant", separateItem: "NCEq" },
	{ item: "CashEq", period: "instant", separateItem: null },
];

const STANDARD_OF_SUFFIX: ReadonlyMap<string, EquityAccountingStandard> = new Map([
	["JP", "JGAAP"],
	["IFRS", "IFRS"],
	["US", "US-GAAP"],
]);

const DISCLOSURE_NUMBER = /^\d{14}$/;
const DISCLOSURE_TIME = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;
const PLAIN_DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

/**
 * A J-Quants amount as canonical decimal text (ADR-0059 §2): a leading `+`
 * and leading zeros removed, trailing fractional zeros removed, `-0` as `0`.
 * Null when it is not a plain decimal (`""`, an exponent, `.5`, `5.`, text)
 * — the item then gives no fact.
 */
export function canonicalJquantsDecimal(text: string): string | null {
	const match = PLAIN_DECIMAL.exec(text);
	if (match === null) return null;
	const whole = (match[2] ?? "").replace(/^0+(?=\d)/, "");
	const fraction = (match[3] ?? "").replace(/0+$/, "");
	const magnitude = fraction === "" ? whole : `${whole}.${fraction}`;
	const value = match[1] === "-" && magnitude !== "0" ? `-${magnitude}` : magnitude;
	return isCanonicalDecimal(value) ? value : null;
}

/** `DiscDate` + `DiscTime` in Asia/Tokyo (UTC+9, no daylight saving) as UTC ISO-8601; null when the time is not `HH:MM:SS`. */
export function jquantsDisclosureInstant(date: string, time: string): string | null {
	const day = isoDayNumber(date);
	const clock = DISCLOSURE_TIME.exec(time);
	if (day === null || clock === null) return null;
	const seconds = Number(clock[1]) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
	return new Date(day * 86_400_000 + (seconds - 9 * 3_600) * 1_000).toISOString();
}

/** The accounting standard a `DocType` names by its suffix (`_JP`, `_IFRS`, `_US`); null for any other. */
export function jquantsAccountingStandard(docType: string): EquityAccountingStandard | null {
	const suffix = docType.slice(docType.lastIndexOf("_") + 1);
	return STANDARD_OF_SUFFIX.get(suffix) ?? null;
}

/** The record's source: the query that answers it (J-Quants keeps no public document page). */
export function jquantsSummaryUrl(code: string, discDate: string): string {
	const query = new URLSearchParams({ code, date: discDate });
	return `https://${JQUANTS_HOST}${JQUANTS_FINS_SUMMARY_PATH}?${query.toString()}`;
}

/** One full-year summary as read from the answer: its dates and its items as text. */
interface FullYearSummary {
	readonly discNo: string;
	readonly discDate: string;
	readonly discTime: string;
	readonly docType: string;
	readonly fiscalYearStart: string;
	readonly fiscalYearEnd: string;
	readonly periodStart: string;
	readonly periodEnd: string;
	readonly record: Readonly<Record<string, unknown>>;
}

function textField(record: Readonly<Record<string, unknown>>, name: string): string | null {
	const value = record[name];
	return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A full-year summary, or null: not an object, a `DocType` that does not
 * start with `FYFinancialStatements_`, a `DiscNo` that is not 14 digits,
 * a `DiscDate`, `CurFYSt`, `CurFYEn`, `CurPerSt` or `CurPerEn` that is not a
 * calendar date, `CurPerSt` after `CurPerEn` or `CurFYSt` after `CurFYEn`,
 * or a `DiscTime` that is not text.
 */
function readFullYearSummary(row: unknown): FullYearSummary | null {
	if (!isRecord(row)) return null;
	const docType = textField(row, "DocType");
	const discNo = textField(row, "DiscNo");
	const discDate = textField(row, "DiscDate");
	const discTime = textField(row, "DiscTime");
	const fiscalYearStart = textField(row, "CurFYSt");
	const fiscalYearEnd = textField(row, "CurFYEn");
	const periodStart = textField(row, "CurPerSt");
	const periodEnd = textField(row, "CurPerEn");
	if (
		docType === null ||
		!docType.startsWith(JQUANTS_FULL_YEAR_DOC_TYPE_PREFIX) ||
		discNo === null ||
		!DISCLOSURE_NUMBER.test(discNo) ||
		discDate === null ||
		discTime === null ||
		fiscalYearStart === null ||
		fiscalYearEnd === null ||
		periodStart === null ||
		periodEnd === null
	) {
		return null;
	}
	for (const date of [discDate, fiscalYearStart, fiscalYearEnd, periodStart, periodEnd]) {
		if (isoDayNumber(date) === null) return null;
	}
	if (periodStart > periodEnd || fiscalYearStart > fiscalYearEnd) return null;
	return {
		discNo,
		discDate,
		discTime,
		docType,
		fiscalYearStart,
		fiscalYearEnd,
		periodStart,
		periodEnd,
		record: row,
	};
}

function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Disclosure order: `DiscDate`, `DiscTime`, `DiscNo`. */
function compareDisclosures(a: FullYearSummary, b: FullYearSummary): number {
	return (
		compareText(a.discDate, b.discDate) ||
		compareText(a.discTime, b.discTime) ||
		compareText(a.discNo, b.discNo)
	);
}

/**
 * A summary's facts in canonical order (`compareFacts`): one per stated
 * item, unit JPY. A `_Consolidated_` summary's items are `consolidated` and
 * its `NC…` items `separate` under the same concept; a `_NonConsolidated_`
 * summary's items are `separate` and its `NC…` items are not read.
 */
function summaryFacts(summary: FullYearSummary): EquityExtractedFact[] {
	const nonConsolidated = summary.docType.includes("_NonConsolidated_");
	const facts: EquityExtractedFact[] = [];
	const add = (
		name: string,
		concept: string,
		period: "duration" | "instant",
		scope: EquityScope,
	) => {
		const text = textField(summary.record, name);
		const valueDecimal = text === null ? null : canonicalJquantsDecimal(text);
		if (valueDecimal === null) return;
		facts.push({
			concept,
			unit: JQUANTS_UNIT,
			valueDecimal,
			periodType: period,
			periodStart: period === "duration" ? summary.periodStart : null,
			periodEnd: summary.periodEnd,
			scope,
		});
	};
	for (const { item, period, separateItem } of JQUANTS_ITEMS) {
		const concept = `jquants:${item}`;
		add(item, concept, period, nonConsolidated ? "separate" : "consolidated");
		if (!nonConsolidated && separateItem !== null) add(separateItem, concept, period, "separate");
	}
	return facts.sort(compareFacts);
}

/** The completion fields `jquantsSummariesToSync` decides. */
export interface JquantsSyncData {
	readonly identity: EquitySyncIdentity | null;
	readonly filings: readonly EquityFilingResult[];
	readonly more: boolean;
}

/**
 * The `financial-synced` fields of one company's summaries (ADR-0059 §2):
 *
 * 1. Keep the full-year summaries (`readFullYearSummary`), in disclosure
 *    order (`DiscDate`, `DiscTime`, `DiscNo`).
 * 2. The first summary of a fiscal year (`CurFYSt`, `CurFYEn`) is an
 *    `earnings-report`; each later one an `amended-earnings-report`
 *    amending the summary before it — decided over every full-year
 *    summary, known ones included.
 * 3. Each summary whose `DiscNo` is not in `knownDisclosures` is one
 *    `extracted` filing (a `DiscNo` listed twice is reported once, the
 *    first time); the completion caps keep the newest (`fitCompletionCaps`)
 *    and `more` says whether any was cut.
 * 4. Identity: the code, no name, the `MM-DD` of the newest `CurFYEn`;
 *    null when the answer holds no full-year summary.
 */
export function jquantsSummariesToSync(
	code: string,
	knownDisclosures: readonly string[],
	records: readonly unknown[],
): JquantsSyncData {
	const summaries = records
		.map(readFullYearSummary)
		.filter((summary): summary is FullYearSummary => summary !== null)
		.sort(compareDisclosures);
	const known = new Set(knownDisclosures);
	const previousOfYear = new Map<string, string>();
	const reported = new Set<string>();
	const filings: EquityFilingResult[] = [];
	let newestYearEnd: string | null = null;
	for (const summary of summaries) {
		const year = `${summary.fiscalYearStart}/${summary.fiscalYearEnd}`;
		const amends = previousOfYear.get(year) ?? null;
		previousOfYear.set(year, summary.discNo);
		if (newestYearEnd === null || summary.fiscalYearEnd > newestYearEnd) {
			newestYearEnd = summary.fiscalYearEnd;
		}
		if (known.has(summary.discNo) || reported.has(summary.discNo)) continue;
		reported.add(summary.discNo);
		filings.push({
			sourceDocumentId: summary.discNo,
			form: amends === null ? "earnings-report" : "amended-earnings-report",
			filedOn: summary.discDate,
			submittedAt: jquantsDisclosureInstant(summary.discDate, summary.discTime),
			periodStart: summary.fiscalYearStart,
			periodEnd: summary.fiscalYearEnd,
			amendsSourceDocumentId: amends,
			sourceUrl: jquantsSummaryUrl(code, summary.discDate),
			accountingStandard: jquantsAccountingStandard(summary.docType),
			factsStatus: "extracted",
			facts: summaryFacts(summary),
		});
	}
	const capped = fitCompletionCaps(filings);
	return {
		identity:
			newestYearEnd === null
				? null
				: { sourceCompanyId: code, name: null, fiscalYearEnd: newestYearEnd.slice(5) },
		filings: capped.filings,
		more: capped.cut.length > 0,
	};
}

/**
 * The company profiles of the Listed Issue Master (ADR-0059 §3): one per
 * record whose 5-character `Code` ends in `0` (a common stock; the symbol
 * is its first four characters), `CoNameEn` null when empty, `ScaleCat`
 * null for `-`. A record that is not an object, misses a field or whose
 * profile does not pass `stockCompanyProfileSchema` (an empty required
 * field, a malformed code or date) is skipped; a symbol seen before keeps
 * the first record's profile. Values are copied as J-Quants states them.
 */
export function jquantsMasterToProfiles(records: readonly unknown[]): StockCompanyProfile[] {
	const profiles: StockCompanyProfile[] = [];
	const seen = new Set<string>();
	for (const row of records) {
		if (!isRecord(row)) continue;
		const code = textField(row, "Code");
		const nameEn = textField(row, "CoNameEn");
		const sector17Code = textField(row, "S17");
		const sector17Name = textField(row, "S17Nm");
		const sector33Code = textField(row, "S33");
		const sector33Name = textField(row, "S33Nm");
		const scaleCategory = textField(row, "ScaleCat");
		const marketSegmentCode = textField(row, "Mkt");
		const marketSegmentName = textField(row, "MktNm");
		const asOf = textField(row, "Date");
		if (
			code === null ||
			code.length !== 5 ||
			!code.endsWith("0") ||
			nameEn === null ||
			sector17Code === null ||
			sector17Name === null ||
			sector33Code === null ||
			sector33Name === null ||
			scaleCategory === null ||
			marketSegmentCode === null ||
			marketSegmentName === null ||
			asOf === null
		) {
			continue;
		}
		const profile: StockCompanyProfile = {
			symbol: code.slice(0, 4),
			nameEn: nameEn === "" ? null : nameEn,
			sector17Code,
			sector17Name,
			sector33Code,
			sector33Name,
			scaleCategory: scaleCategory === "-" ? null : scaleCategory,
			marketSegmentCode,
			marketSegmentName,
			asOf,
		};
		if (
			seen.has(profile.symbol) ||
			isoDayNumber(asOf) === null ||
			!stockCompanyProfileSchema.safeParse(profile).success
		) {
			continue;
		}
		seen.add(profile.symbol);
		profiles.push(profile);
	}
	return profiles;
}

export interface JquantsFinancialsDeps {
	/** `JQUANTS_API_KEY`; null = J-Quants is not configured and nothing is requested. */
	readonly apiKey: string | null;
	readonly fetcher: SafeFetcher;
}

function jquantsOptions(apiKey: string, signal: AbortSignal): SafeFetchOptions {
	return {
		maxBytes: JQUANTS_PAGE_MAX_BYTES,
		timeoutMs: JQUANTS_TIMEOUT_MS,
		accept: "application/json",
		signal,
		allowedHosts: JQUANTS_ALLOWED_HOSTS,
		xApiKey: apiKey,
	};
}

/** A J-Quants page query's failure: a status (unchanged) or a transport failure, or an answer of the wrong shape. */
type JquantsPagesFailure =
	| { readonly kind: "fetch"; readonly error: SafeFetchError }
	| { readonly kind: "shape" }
	| { readonly kind: "stopped" };

/** Every page of one J-Quants query, each admitted by `beforeRequest`, and the requests sent. */
async function jquantsPages(
	fetcher: SafeFetcher,
	apiKey: string,
	path: string,
	query: URLSearchParams,
	signal: AbortSignal,
	beforeRequest: () => Promise<boolean>,
	onRequest: () => void,
): Promise<Result<unknown[], JquantsPagesFailure>> {
	const all: unknown[] = [];
	let key: string | null = null;
	for (let page = 0; page === 0 || key !== null; page += 1) {
		if (page >= JQUANTS_MAX_PAGES) return err({ kind: "shape" });
		const params = new URLSearchParams(query);
		if (key !== null) params.set("pagination_key", key);
		if (!(await beforeRequest())) return err({ kind: "stopped" });
		onRequest();
		const search = params.toString();
		const url = `https://${JQUANTS_HOST}${path}${search === "" ? "" : `?${search}`}`;
		const fetched = await fetchJsonDocument(fetcher, url, jquantsOptions(apiKey, signal));
		if (!fetched.ok) return err({ kind: "fetch", error: fetched.error });
		const parsed = parseJquantsPage(fetched.value.json);
		if (parsed === null) return err({ kind: "shape" });
		all.push(...parsed.records);
		key = parsed.next;
	}
	return ok(all);
}

/** A failed summaries fetch as a sync failure: 400 is a parse failure, the rest by `equitySyncFailureOfFetch`. */
function jquantsSyncFailureOfFetch(error: SafeFetchError, requests: number): EquitySyncFailure {
	if (error.code === "HTTP_ERROR" && error.status === 400) {
		return { code: "FINANCIAL_PARSE_FAILED", upstreamStatus: 400, requests };
	}
	return equitySyncFailureOfFetch(error, requests);
}

/** The `financial-sync` source of provider `jquants` (ADR-0059 §2). */
export function createJquantsFinancialsSource(deps: JquantsFinancialsDeps): EquitySyncSource {
	return {
		provider: "jquants",
		async sync(query: EquitySyncQuery): Promise<Result<EquitySyncData, EquitySyncFailure>> {
			const request = query.target.source;
			let requests = 0;
			if (request.provider !== "jquants") {
				return err({ code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: null, requests });
			}
			const apiKey = deps.apiKey;
			if (apiKey === null) {
				return err({ code: "FINANCIAL_SOURCE_NOT_CONFIGURED", upstreamStatus: null, requests });
			}
			const records = await jquantsPages(
				deps.fetcher,
				apiKey,
				JQUANTS_FINS_SUMMARY_PATH,
				new URLSearchParams({ code: request.code }),
				query.signal,
				query.beforeRequest,
				() => {
					requests += 1;
				},
			);
			if (!records.ok) {
				const failure = records.error;
				if (failure.kind === "fetch")
					return err(jquantsSyncFailureOfFetch(failure.error, requests));
				const code =
					failure.kind === "shape" ? "FINANCIAL_PARSE_FAILED" : "FINANCIAL_SOURCE_FAILED";
				return err({ code, upstreamStatus: null, requests });
			}
			const data = jquantsSummariesToSync(request.code, request.knownDisclosures, records.value);
			return ok({
				identity: data.identity,
				filings: data.filings,
				more: data.more,
				requests,
				description: null,
				descriptionUnread: null,
			});
		},
	};
}

/** What one master fetch gave: the profiles and the requests sent. */
export interface JquantsProfilesData {
	readonly profiles: readonly StockCompanyProfile[];
	readonly requests: number;
}

/**
 * Why the master could not be read (logged as `company_profiles_failed`):
 * 401/403 → `ACCESS_DENIED`, 429 → `RATE_LIMITED`, an answer of the wrong
 * shape, too large or over `JQUANTS_MAX_PAGES` pages → `PARSE_FAILED`, any
 * other status, a transport failure or a stopped job → `SOURCE_FAILED`.
 */
export type JquantsProfilesFailureCode =
	| "ACCESS_DENIED"
	| "RATE_LIMITED"
	| "PARSE_FAILED"
	| "SOURCE_FAILED";

/** A failed master read: its code and J-Quants' status (unchanged), null when none answered. */
export interface JquantsProfilesFailure {
	readonly code: JquantsProfilesFailureCode;
	readonly upstreamStatus: number | null;
	readonly requests: number;
}

export interface JquantsProfilesQuery {
	readonly signal: AbortSignal;
	/** The runner's `jquants` gate; false = the job stopped while waiting. */
	readonly beforeRequest: () => Promise<boolean>;
}

function jquantsProfilesFailure(
	failure: JquantsPagesFailure,
	requests: number,
): JquantsProfilesFailure {
	if (failure.kind === "shape") return { code: "PARSE_FAILED", upstreamStatus: null, requests };
	if (failure.kind === "stopped") return { code: "SOURCE_FAILED", upstreamStatus: null, requests };
	const { code } = equitySyncFailureOfFetch(failure.error, requests);
	const upstreamStatus = failure.error.status ?? null;
	const profileCode: JquantsProfilesFailureCode =
		code === "FINANCIAL_ACCESS_DENIED"
			? "ACCESS_DENIED"
			: code === "FINANCIAL_RATE_LIMITED"
				? "RATE_LIMITED"
				: code === "FINANCIAL_PARSE_FAILED"
					? "PARSE_FAILED"
					: "SOURCE_FAILED";
	return { code: profileCode, upstreamStatus, requests };
}

/** The JP directory refresh's company-profile fetch (ADR-0059 §3). */
export interface CompanyProfileSource {
	fetchProfiles(
		query: JquantsProfilesQuery,
	): Promise<Result<JquantsProfilesData, JquantsProfilesFailure>>;
}

/** The Listed Issue Master over J-Quants, with the owner's key (the runner builds none without it). */
export function createJquantsProfileSource(deps: {
	readonly apiKey: string;
	readonly fetcher: SafeFetcher;
}): CompanyProfileSource {
	return {
		async fetchProfiles(query) {
			let requests = 0;
			const records = await jquantsPages(
				deps.fetcher,
				deps.apiKey,
				JQUANTS_MASTER_PATH,
				new URLSearchParams(),
				query.signal,
				query.beforeRequest,
				() => {
					requests += 1;
				},
			);
			if (!records.ok) return err(jquantsProfilesFailure(records.error, requests));
			return ok({ profiles: jquantsMasterToProfiles(records.value), requests });
		},
	};
}
