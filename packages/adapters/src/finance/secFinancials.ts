/**
 * Latest fiscal-year revenue, net income and diluted EPS for a US ticker, from
 * SEC EDGAR's XBRL "company facts" (FR-006, DATA-005/011/012).
 *
 * Wire format, limits, error mapping and what was verified live:
 * docs/external-apis/apis/sec-edgar.md
 *
 * Selection rules (deterministic, documented because they are judgement calls):
 *  1. A fact is "annual" when it comes from a 10-K or 10-K/A, has `fp: "FY"`,
 *     and its period lasts 350–380 days. The duration test matters: a 10-K also
 *     carries quarterly facts tagged `fp: "FY"`.
 *  2. A figure's reporting period is the fact's OWN start and end date.
 *     SEC's `fy` is the fiscal year of the FILING that carried the fact, so a
 *     comparative column carries the later filing's `fy`; it is therefore kept
 *     only as lineage (`filingFiscalYear`) and never used to match periods.
 *     `period.fiscalYear` is the calendar year in which the period ends, which
 *     for issuers whose year ends early in the calendar year is one more than
 *     the label they use themselves.
 *  3. Per concept and currency unit, the latest annual fact is the one with the
 *     latest period end; if the same period was reported more than once, the
 *     most recently filed statement of it (then the highest accession number)
 *     wins.
 *  4. Currency: the unit holding the latest period end is used, whatever the
 *     currency (USD is not preferred over a more recent period in another
 *     currency). If the same latest period end is reported in two or more
 *     currencies the figure is ambiguous and reported unavailable; no currency
 *     is picked for the owner.
 *  5. Revenue concept: each concept in `REVENUE_CONCEPT_PRECEDENCE` is reduced
 *     as above; the concept with the LATEST period end is used (so a tag the
 *     issuer abandoned years ago never wins), and among concepts reporting that
 *     same period end the EARLIEST in the precedence list wins — including when
 *     that concept is ambiguous, in which case revenue is unavailable rather
 *     than taken from a lower-ranked concept. `Revenues` is first because it is
 *     the total; the contract-revenue tags can be a subset of it for issuers
 *     with lease, interest or other income.
 *  6. Net income is `us-gaap:NetIncomeLoss` (attributable to the parent,
 *     including discontinued operations). No fallback concept is substituted.
 *  7. Net profit margin is computed only by the domain's
 *     `computeNetProfitMargin`, which requires the same period (start and end
 *     date) and the same currency. When revenue and net income do not line up
 *     the figures are still returned and the margin is unavailable with the
 *     reason.
 */
import {
	type AccountingStandard,
	computeNetProfitMargin,
	err,
	type NetMarginError,
	type NetProfitMargin,
	ok,
	type ReportingPeriod,
	type Result,
} from "@research/domain";
import { z } from "zod";
import {
	parseSecJson,
	type SecClient,
	type SecError,
	secCancelledError,
	secError,
} from "./secClient.ts";

export const SEC_TICKER_DIRECTORY_URL = "https://www.sec.gov/files/company_tickers_exchange.json";

export function secCompanyFactsUrl(cik: string): string {
	return `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
}

/** Total-revenue concepts in precedence order; see rule 3 in the file header. */
export const REVENUE_CONCEPT_PRECEDENCE: readonly string[] = [
	"Revenues",
	"RevenueFromContractWithCustomerExcludingAssessedTax",
	"RevenueFromContractWithCustomerIncludingAssessedTax",
	"SalesRevenueNet",
];
export const NET_INCOME_CONCEPT = "NetIncomeLoss";
export const DILUTED_EPS_CONCEPT = "EarningsPerShareDiluted";

const ANNUAL_FORMS: ReadonlySet<string> = new Set(["10-K", "10-K/A"]);
const MIN_ANNUAL_DAYS = 350;
const MAX_ANNUAL_DAYS = 380;
const MS_PER_DAY = 86_400_000;

/** Byte cap of the ticker directory download (~0.5 MB measured 2026-10-24). */
export const TICKER_DIRECTORY_MAX_BYTES = 8_000_000;
/** Company-facts documents of large filers run to tens of megabytes. */
const COMPANY_FACTS_MAX_BYTES = 48_000_000;
const TICKER_DIRECTORY_TTL_MS = 12 * 60 * 60 * 1000;

/* ---------- Vendor-shaped records: only the fields used are validated (DATA-012) ---------- */

const tickerDirectorySchema = z.object({
	fields: z.array(z.string()),
	data: z.array(z.array(z.unknown())),
});

const factEntrySchema = z.object({
	start: z.iso.date().optional(),
	end: z.iso.date(),
	val: z.number().finite(),
	accn: z.string().min(1).max(40),
	fy: z.number().int().nullable().optional(),
	fp: z.string().nullable().optional(),
	form: z.string(),
	filed: z.iso.date(),
});
type FactEntry = z.infer<typeof factEntrySchema>;

const conceptSchema = z.object({
	label: z.string().nullable().optional(),
	units: z.record(z.string(), z.array(z.unknown())),
});

const companyFactsSchema = z.object({
	entityName: z.string().optional(),
	facts: z.record(z.string(), z.unknown()),
});

/* ---------- Normalized output ---------- */

export interface SecIssuer {
	/** Ten-digit zero-padded CIK. */
	readonly cik: string;
	readonly name: string;
	/** Ticker exactly as SEC lists it, e.g. "BRK-B". */
	readonly ticker: string;
	/** Exchange text exactly as SEC states it ("Nasdaq", "NYSE", "OTC", ...); null when SEC states none. */
	readonly secExchange: string | null;
}

export type SecFigureUnit = "currency" | "currency-per-share";

export interface SecAnnualFigure {
	/** Taxonomy-qualified concept, e.g. "us-gaap:Revenues". */
	readonly concept: string;
	readonly amount: number;
	readonly unit: SecFigureUnit;
	readonly currency: string;
	/** From the fact's own start/end dates; `fiscalYear` is the year the period ends. */
	readonly period: ReportingPeriod;
	/**
	 * SEC's `fy` of the filing that reported this fact. Lineage only: for a
	 * comparative figure it is the LATER filing's year, not this period's.
	 */
	readonly filingFiscalYear: number | null;
	readonly accountingStandard: AccountingStandard;
	readonly form: string;
	readonly accessionNumber: string;
	/** YYYY-MM-DD the reporting filing was filed. */
	readonly filedAt: string;
}

export interface Unavailable {
	readonly reason: string;
}

export type FigureResult = Result<SecAnnualFigure, Unavailable>;

export interface SecCompanyFinancials {
	readonly issuer: SecIssuer;
	readonly revenue: FigureResult;
	readonly netIncome: FigureResult;
	readonly epsDiluted: FigureResult;
	readonly netProfitMargin: Result<NetProfitMargin, Unavailable>;
	/** Documents actually retrieved, for evidence lineage. */
	readonly tickerDirectoryUrl: string;
	readonly companyFactsUrl: string;
}

export interface SecFinancialsSource {
	latestAnnualFinancials(
		ticker: string,
		signal?: AbortSignal,
	): Promise<Result<SecCompanyFinancials, SecError>>;
}

/* ---------- Ticker directory ---------- */

/** SEC writes share classes with a hyphen ("BRK-B"); accept the dotted spelling too. */
export function normalizeTickerKey(ticker: string): string {
	return ticker.trim().toUpperCase().replace(/\./g, "-");
}

export function parseTickerDirectory(
	value: unknown,
): Result<ReadonlyMap<string, SecIssuer>, SecError> {
	const parsed = tickerDirectorySchema.safeParse(value);
	if (!parsed.success) {
		return err(secError("UNEXPECTED_RESPONSE", "SEC ticker directory has an unexpected shape"));
	}
	// Columns are located by name, not position, so a reordering upstream cannot swap fields.
	const column = (name: string): number => parsed.data.fields.indexOf(name);
	const [cikAt, nameAt, tickerAt, exchangeAt] = [
		column("cik"),
		column("name"),
		column("ticker"),
		column("exchange"),
	];
	if (cikAt < 0 || nameAt < 0 || tickerAt < 0 || exchangeAt < 0) {
		return err(secError("UNEXPECTED_RESPONSE", "SEC ticker directory is missing expected columns"));
	}
	const issuers = new Map<string, SecIssuer>();
	for (const row of parsed.data.data) {
		const cik = row[cikAt];
		const name = row[nameAt];
		const ticker = row[tickerAt];
		const exchange = row[exchangeAt];
		if (typeof cik !== "number" || !Number.isInteger(cik) || cik <= 0) continue;
		if (typeof name !== "string" || typeof ticker !== "string" || ticker.trim() === "") continue;
		const key = normalizeTickerKey(ticker);
		if (issuers.has(key)) continue;
		issuers.set(key, {
			cik: String(cik).padStart(10, "0"),
			name: name.trim(),
			ticker: ticker.trim().toUpperCase(),
			secExchange: typeof exchange === "string" && exchange.trim() !== "" ? exchange.trim() : null,
		});
	}
	if (issuers.size === 0) {
		return err(secError("UNEXPECTED_RESPONSE", "SEC ticker directory contains no usable rows"));
	}
	return ok(issuers);
}

/* ---------- Fact selection (pure) ---------- */

function periodDays(start: string, end: string): number {
	return Math.round((Date.parse(end) - Date.parse(start)) / MS_PER_DAY) + 1;
}

interface AnnualFact extends FactEntry {
	readonly start: string;
	/** Calendar year in which the fact's own period ends. */
	readonly periodEndYear: number;
}

function toAnnualFact(entry: FactEntry): AnnualFact | null {
	if (!ANNUAL_FORMS.has(entry.form) || entry.fp !== "FY" || entry.start === undefined) return null;
	const days = periodDays(entry.start, entry.end);
	if (days < MIN_ANNUAL_DAYS || days > MAX_ANNUAL_DAYS) return null;
	const periodEndYear = Number(entry.end.slice(0, 4));
	if (periodEndYear < 1990 || periodEndYear > 2100) return null;
	return { ...entry, start: entry.start, periodEndYear };
}

/** Later period end first; then the most recently filed statement of that period. */
function compareRecency(a: AnnualFact, b: AnnualFact): number {
	return (
		b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed) || b.accn.localeCompare(a.accn)
	);
}

function latestAnnualFact(entries: readonly unknown[]): AnnualFact | null {
	const annual: AnnualFact[] = [];
	for (const raw of entries) {
		// A malformed entry is skipped rather than failing the issuer: the rest stay usable.
		const entry = factEntrySchema.safeParse(raw);
		const fact = entry.success ? toAnnualFact(entry.data) : null;
		if (fact !== null) annual.push(fact);
	}
	return annual.sort(compareRecency)[0] ?? null;
}

/** What a concept offers for its latest annual period. */
type ConceptSelection =
	| { readonly kind: "figure"; readonly periodEnd: string; readonly figure: SecAnnualFigure }
	| {
			readonly kind: "ambiguous-currency";
			readonly periodEnd: string;
			readonly currencies: readonly string[];
	  };

/**
 * The latest annual fact of a concept across ALL its currency units. Recency
 * decides first; the currency is whatever that fact is reported in. Two
 * currencies for the same latest period end are not resolved here.
 */
function latestForConcept(
	usGaap: { readonly [concept: string]: unknown },
	concept: string,
	figureUnit: SecFigureUnit,
): ConceptSelection | null {
	if (!Object.hasOwn(usGaap, concept)) return null;
	const parsed = conceptSchema.safeParse(usGaap[concept]);
	if (!parsed.success) return null;
	const unitPattern = figureUnit === "currency" ? /^([A-Z]{3})$/ : /^([A-Z]{3})\/shares$/;
	const perCurrency: { readonly currency: string; readonly fact: AnnualFact }[] = [];
	for (const [unit, entries] of Object.entries(parsed.data.units)) {
		const currency = unitPattern.exec(unit)?.[1];
		const fact = currency === undefined ? null : latestAnnualFact(entries);
		if (currency !== undefined && fact !== null) perCurrency.push({ currency, fact });
	}
	const [first] = perCurrency;
	if (first === undefined) return null;
	const periodEnd = perCurrency.reduce(
		(latest, candidate) => (candidate.fact.end > latest ? candidate.fact.end : latest),
		first.fact.end,
	);
	const latest = perCurrency.filter((candidate) => candidate.fact.end === periodEnd);
	const [only] = latest;
	if (only === undefined || latest.length > 1) {
		return {
			kind: "ambiguous-currency",
			periodEnd,
			currencies: latest.map((candidate) => candidate.currency).sort(),
		};
	}
	const { currency, fact } = only;
	return {
		kind: "figure",
		periodEnd,
		figure: {
			concept: `us-gaap:${concept}`,
			amount: fact.val,
			unit: figureUnit,
			currency,
			period: {
				fiscalYear: fact.periodEndYear,
				fiscalPeriod: "FY",
				periodStart: fact.start,
				periodEnd: fact.end,
			},
			filingFiscalYear: typeof fact.fy === "number" ? fact.fy : null,
			accountingStandard: "US-GAAP",
			form: fact.form,
			accessionNumber: fact.accn,
			filedAt: fact.filed,
		},
	};
}

function selectRevenue(usGaap: { readonly [concept: string]: unknown }): ConceptSelection | null {
	let best: ConceptSelection | null = null;
	// Iterating in precedence order with a strict ">" keeps the earlier concept on a tie.
	for (const concept of REVENUE_CONCEPT_PRECEDENCE) {
		const selection = latestForConcept(usGaap, concept, "currency");
		if (selection === null) continue;
		if (best === null || selection.periodEnd > best.periodEnd) best = selection;
	}
	return best;
}

function figureOrUnavailable(selection: ConceptSelection | null, what: string): FigureResult {
	if (selection === null) {
		return err({
			reason: `SEC company facts contain no annual (10-K, full fiscal year) ${what} for this issuer`,
		});
	}
	if (selection.kind === "ambiguous-currency") {
		return err({
			reason: `SEC company facts report ${what} for the period ending ${selection.periodEnd} in more than one currency (${selection.currencies.join(", ")}); no figure is chosen between them`,
		});
	}
	return ok(selection.figure);
}

function describePeriod(figure: SecAnnualFigure): string {
	return `FY${figure.period.fiscalYear} ${figure.period.periodStart} to ${figure.period.periodEnd}`;
}

const MARGIN_ERROR_REASONS: { readonly [E in NetMarginError]: string } = {
	NON_FINITE: "a reported figure is not a finite number",
	NON_POSITIVE_REVENUE: "reported revenue is zero or negative, so a margin is not meaningful",
	CURRENCY_MISMATCH: "revenue and net income are reported in different currencies",
	PERIOD_MISMATCH: "revenue and net income are not reported for the same fiscal period",
	ACCOUNTING_STANDARD_MISMATCH: "revenue and net income use different accounting standards",
	CONTINUING_OPERATIONS_POLICY_MISMATCH:
		"revenue and net income use different continuing-operations bases",
};

function deriveMargin(
	revenue: FigureResult,
	netIncome: FigureResult,
): Result<NetProfitMargin, Unavailable> {
	if (!revenue.ok || !netIncome.ok) {
		return err({
			reason: "net profit margin needs both revenue and net income; one is unavailable",
		});
	}
	const margin = computeNetProfitMargin(
		{
			amount: { amount: netIncome.value.amount, currency: netIncome.value.currency },
			period: netIncome.value.period,
			accountingStandard: netIncome.value.accountingStandard,
			continuingOperationsPolicy: "total",
		},
		{
			amount: { amount: revenue.value.amount, currency: revenue.value.currency },
			period: revenue.value.period,
			accountingStandard: revenue.value.accountingStandard,
			continuingOperationsPolicy: "total",
		},
	);
	if (margin.ok) return margin;
	const periods =
		margin.error === "PERIOD_MISMATCH"
			? ` (revenue: ${describePeriod(revenue.value)}; net income: ${describePeriod(netIncome.value)})`
			: "";
	return err({ reason: `${MARGIN_ERROR_REASONS[margin.error]}${periods}; margin not computed` });
}

export interface SelectedFinancials {
	readonly revenue: FigureResult;
	readonly netIncome: FigureResult;
	readonly epsDiluted: FigureResult;
	readonly netProfitMargin: Result<NetProfitMargin, Unavailable>;
}

/** Pure selection over a parsed company-facts document. */
export function selectAnnualFinancials(
	companyFacts: unknown,
): Result<SelectedFinancials, SecError> {
	const parsed = companyFactsSchema.safeParse(companyFacts);
	if (!parsed.success) {
		return err(secError("UNEXPECTED_RESPONSE", "SEC company facts have an unexpected shape"));
	}
	const usGaapRaw = parsed.data.facts["us-gaap"];
	const usGaap = z.record(z.string(), z.unknown()).safeParse(usGaapRaw);
	if (!usGaap.success) {
		const reason =
			"SEC company facts contain no us-gaap taxonomy for this issuer (it may report under IFRS)";
		const unavailable: FigureResult = err({ reason });
		return ok({
			revenue: unavailable,
			netIncome: unavailable,
			epsDiluted: unavailable,
			netProfitMargin: err({ reason }),
		});
	}
	const revenue = figureOrUnavailable(selectRevenue(usGaap.data), "revenue");
	const netIncome = figureOrUnavailable(
		latestForConcept(usGaap.data, NET_INCOME_CONCEPT, "currency"),
		"net income (us-gaap:NetIncomeLoss)",
	);
	const epsDiluted = figureOrUnavailable(
		latestForConcept(usGaap.data, DILUTED_EPS_CONCEPT, "currency-per-share"),
		"diluted EPS (us-gaap:EarningsPerShareDiluted)",
	);
	return ok({ revenue, netIncome, epsDiluted, netProfitMargin: deriveMargin(revenue, netIncome) });
}

/* ---------- Source ---------- */

export function createSecFinancialsSource(deps: {
	readonly client: SecClient;
	readonly nowMs: () => number;
}): SecFinancialsSource {
	let cachedDirectory: {
		readonly issuers: ReadonlyMap<string, SecIssuer>;
		readonly url: string;
		readonly expiresAtMs: number;
	} | null = null;
	type DirectoryResult = Result<
		{ readonly issuers: ReadonlyMap<string, SecIssuer>; readonly url: string },
		SecError
	>;
	/**
	 * The download in progress, if any. Every caller that misses the cache
	 * meanwhile waits for it and gets its result, a failure included; the
	 * download has its own signal, aborted only when every waiter has left.
	 */
	let inFlight: {
		readonly result: Promise<DirectoryResult>;
		readonly controller: AbortController;
		waiters: number;
	} | null = null;

	/**
	 * The directory changes rarely; one copy per 12 hours keeps us off SEC's
	 * servers. Single-flight: concurrent misses share one download and its
	 * outcome; the slot is cleared when it settles, so a later call (after a
	 * failure) downloads again. A caller whose signal aborts stops waiting at
	 * once without cancelling the download for the others.
	 */
	async function tickerDirectory(signal: AbortSignal | undefined): Promise<DirectoryResult> {
		if (cachedDirectory !== null && cachedDirectory.expiresAtMs > deps.nowMs()) {
			return ok(cachedDirectory);
		}
		if (signal?.aborted === true) return err(secCancelledError());
		if (inFlight === null) {
			const controller = new AbortController();
			const started = {
				result: downloadDirectory(controller.signal).finally(() => {
					if (inFlight === started) inFlight = null;
				}),
				controller,
				waiters: 0,
			};
			inFlight = started;
		}
		const shared = inFlight;
		shared.waiters += 1;
		try {
			if (signal === undefined) return await shared.result;
			return await new Promise<DirectoryResult>((resolve, reject) => {
				const onAbort = (): void => resolve(err(secCancelledError()));
				signal.addEventListener("abort", onAbort, { once: true });
				shared.result.then(resolve, reject).finally(() => {
					signal.removeEventListener("abort", onAbort);
				});
			});
		} finally {
			shared.waiters -= 1;
			// The last waiter left before the answer: nobody needs the download any more.
			if (shared.waiters === 0 && inFlight === shared) {
				inFlight = null;
				shared.controller.abort();
			}
		}
	}

	async function downloadDirectory(signal: AbortSignal): Promise<DirectoryResult> {
		const document = await deps.client.fetchDocument(SEC_TICKER_DIRECTORY_URL, {
			maxBytes: TICKER_DIRECTORY_MAX_BYTES,
			accept: "application/json",
			signal,
		});
		if (!document.ok) return document;
		const json = parseSecJson(document.value);
		if (!json.ok) return json;
		const issuers = parseTickerDirectory(json.value);
		if (!issuers.ok) return issuers;
		cachedDirectory = {
			issuers: issuers.value,
			url: document.value.url,
			expiresAtMs: deps.nowMs() + TICKER_DIRECTORY_TTL_MS,
		};
		return ok(cachedDirectory);
	}

	return {
		async latestAnnualFinancials(ticker, signal) {
			const directory = await tickerDirectory(signal);
			if (!directory.ok) return directory;
			const issuer = directory.value.issuers.get(normalizeTickerKey(ticker));
			if (issuer === undefined) {
				return err(secError("NOT_FOUND", "ticker is not in SEC's ticker directory"));
			}
			const document = await deps.client.fetchDocument(secCompanyFactsUrl(issuer.cik), {
				maxBytes: COMPANY_FACTS_MAX_BYTES,
				accept: "application/json",
				...(signal === undefined ? {} : { signal }),
			});
			if (!document.ok) return document;
			const json = parseSecJson(document.value);
			if (!json.ok) return json;
			const selected = selectAnnualFinancials(json.value);
			if (!selected.ok) return selected;
			return ok({
				issuer,
				...selected.value,
				tickerDirectoryUrl: directory.value.url,
				companyFactsUrl: document.value.url,
			});
		},
	};
}
