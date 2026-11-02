/**
 * Annual financial statements synchronised from SEC EDGAR (US) and J-Quants
 * (JP, ADR-0059) (ADR-0048). The pure core: which source concepts feed which
 * normalized metric, which reported periods are annual, how a fiscal year is
 * labelled, which as-filed fact is the current authoritative value and how
 * free cash flow is derived.
 *
 * Every function here is total, deterministic and free of effects; the API
 * (persistence) and both runners (extraction) call them, and the Lean model
 * `formal/ResearchFormal/FinancialStatements.lean` proves the selection and
 * scan-plan properties the incremental sync relies on.
 */

/* ---------- Vocabulary ---------- */

export const EQUITY_MARKETS = ["US", "JP"] as const;
export type EquityMarket = (typeof EQUITY_MARKETS)[number];

export const EQUITY_PROVIDERS = ["sec", "jquants"] as const;
export type EquityProvider = (typeof EQUITY_PROVIDERS)[number];

/** The provider each market's annual figures come from (ADR-0059: J-Quants for JP). */
export const EQUITY_PROVIDER_OF_MARKET: { readonly [M in EquityMarket]: EquityProvider } = {
	US: "sec",
	JP: "jquants",
};

/** Externally standardized identifiers (docs/database/naming.md). */
export const EQUITY_ACCOUNTING_STANDARDS = ["US-GAAP", "JGAAP", "IFRS"] as const;
export type EquityAccountingStandard = (typeof EQUITY_ACCOUNTING_STANDARDS)[number];

/** `separate` is the non-consolidated (個別) statement of the reporting entity alone. */
export const EQUITY_SCOPES = ["consolidated", "separate"] as const;
export type EquityScope = (typeof EQUITY_SCOPES)[number];

export const EQUITY_PERIOD_TYPES = ["duration", "instant"] as const;
export type EquityPeriodType = (typeof EQUITY_PERIOD_TYPES)[number];

export const EQUITY_STATEMENTS = ["income-statement", "balance-sheet", "cash-flow"] as const;
export type EquityStatement = (typeof EQUITY_STATEMENTS)[number];

/**
 * The annual report forms the sync reads. SEC form types keep their own
 * spelling: 10-K (domestic filers), 20-F and 40-F (foreign private issuers,
 * ADR-0058 §5) and their amendments. J-Quants' full-year earnings summary
 * (決算短信, `FYFinancialStatements_…`) is an `earnings-report`; a later
 * full-year record of the same fiscal year (a correction) is an
 * `amended-earnings-report` (ADR-0059 §2).
 */
export const EQUITY_REPORT_FORMS = [
	"10-K",
	"10-K/A",
	"20-F",
	"20-F/A",
	"40-F",
	"40-F/A",
	"earnings-report",
	"amended-earnings-report",
] as const;
export type EquityReportForm = (typeof EQUITY_REPORT_FORMS)[number];

/** The annual report forms SEC publishes (every other form is J-Quants'). */
export const SEC_REPORT_FORMS = [
	"10-K",
	"10-K/A",
	"20-F",
	"20-F/A",
	"40-F",
	"40-F/A",
] as const satisfies readonly EquityReportForm[];
export type SecReportForm = (typeof SEC_REPORT_FORMS)[number];

const SEC_FORM_SET: ReadonlySet<string> = new Set(SEC_REPORT_FORMS);

export function isSecReportForm(form: string): form is SecReportForm {
	return SEC_FORM_SET.has(form);
}

export function isAmendmentForm(form: EquityReportForm): boolean {
	return form.endsWith("/A") || form === "amended-earnings-report";
}

/**
 * The original annual reports a business description comes from (ADR-0053
 * §2, ADR-0058 §5): a 10-K's Item 1, a 20-F's Item 4.B (or Item 4). A 40-F
 * is recorded as not found without a download: its description is in the
 * Annual Information Form exhibit, not in the primary document. US only:
 * J-Quants has no business text; a Japanese stock shows its company
 * profile instead (ADR-0059 §3).
 */
export const EQUITY_BUSINESS_FORMS = [
	"10-K",
	"20-F",
	"40-F",
] as const satisfies readonly EquityReportForm[];
export type EquityBusinessForm = (typeof EQUITY_BUSINESS_FORMS)[number];

/* ---------- Metrics and concept mappings ---------- */

/**
 * Normalized annual metrics, named for their exact definition. Every value
 * is a currency amount in the filing's reporting currency, in base units.
 */
export const EQUITY_METRIC_CODES = [
	"revenue",
	"gross-profit",
	"operating-income",
	"ordinary-income",
	"profit-attributable-to-owners",
	"total-assets",
	"total-liabilities",
	"total-equity",
	"cash-and-cash-equivalents",
	"net-cash-from-operating-activities",
	"net-cash-from-investing-activities",
	"net-cash-from-financing-activities",
	"capital-expenditures",
	"free-cash-flow",
] as const;
export type EquityMetricCode = (typeof EQUITY_METRIC_CODES)[number];

export interface EquityMetricDefinition {
	readonly code: EquityMetricCode;
	readonly statement: EquityStatement;
	readonly periodType: EquityPeriodType;
	/** Computed from other metrics (never read from a filing). */
	readonly derived: boolean;
	/** A normalized value below zero means the mapping does not fit this filing. */
	readonly nonNegative: boolean;
}

type MetricShape = Omit<EquityMetricDefinition, "code">;

function shape(
	statement: EquityStatement,
	periodType: EquityPeriodType,
	options: { readonly derived?: boolean; readonly nonNegative?: boolean } = {},
): MetricShape {
	return {
		statement,
		periodType,
		derived: options.derived ?? false,
		nonNegative: options.nonNegative ?? false,
	};
}

const METRIC_TABLE: { readonly [C in EquityMetricCode]: MetricShape } = {
	revenue: shape("income-statement", "duration"),
	"gross-profit": shape("income-statement", "duration"),
	"operating-income": shape("income-statement", "duration"),
	"ordinary-income": shape("income-statement", "duration"),
	"profit-attributable-to-owners": shape("income-statement", "duration"),
	"total-assets": shape("balance-sheet", "instant", { nonNegative: true }),
	"total-liabilities": shape("balance-sheet", "instant", { nonNegative: true }),
	"total-equity": shape("balance-sheet", "instant"),
	"cash-and-cash-equivalents": shape("balance-sheet", "instant", { nonNegative: true }),
	"net-cash-from-operating-activities": shape("cash-flow", "duration"),
	"net-cash-from-investing-activities": shape("cash-flow", "duration"),
	"net-cash-from-financing-activities": shape("cash-flow", "duration"),
	"capital-expenditures": shape("cash-flow", "duration", { nonNegative: true }),
	"free-cash-flow": shape("cash-flow", "duration", { derived: true }),
};

export function equityMetricDefinition(code: EquityMetricCode): EquityMetricDefinition {
	return { code, ...METRIC_TABLE[code] };
}

/** In statement row order (the order of `EQUITY_METRIC_CODES`). */
export const EQUITY_METRICS: readonly EquityMetricDefinition[] =
	EQUITY_METRIC_CODES.map(equityMetricDefinition);

export function equityStatementMetrics(statement: EquityStatement): readonly EquityMetricCode[] {
	return EQUITY_METRICS.filter((definition) => definition.statement === statement).map(
		(definition) => definition.code,
	);
}

/**
 * One reviewed source concept that measures a metric under one accounting
 * standard in one provider's filings. `rank` orders a metric's candidates
 * (0 first) when one filing reports several; `sign` turns the as-reported
 * value into the metric's convention (a provider that reports cash payments
 * as negative amounts needs -1; SEC reports them as positive ones); `scope`
 * limits a concept that means the metric only in one scope. `provider` is
 * the provider whose runner extracts the concept: a standard is mapped per
 * provider, since each provider's filings use their own vocabulary (SEC's
 * IFRS filers `ifrs-full:`, J-Quants' normalised items `jquants:`).
 */
export interface EquityConceptMapping {
	readonly metric: EquityMetricCode;
	readonly provider: EquityProvider;
	readonly standard: EquityAccountingStandard;
	readonly concept: string;
	readonly rank: number;
	readonly sign: 1 | -1;
	readonly scope: EquityScope | "any";
}

/** The standards J-Quants' normalised summary items are reviewed for (ADR-0059 §2). */
const JQUANTS_STANDARDS: readonly EquityAccountingStandard[] = ["JGAAP", "IFRS", "US-GAAP"];

function candidates(
	provider: EquityProvider,
	metricCode: EquityMetricCode,
	standard: EquityAccountingStandard,
	concepts: readonly string[],
	options: { readonly sign?: 1 | -1; readonly scope?: EquityScope | "any" } = {},
): EquityConceptMapping[] {
	return concepts.map((concept, rank) => ({
		metric: metricCode,
		provider,
		standard,
		concept,
		rank,
		sign: options.sign ?? 1,
		scope: options.scope ?? "any",
	}));
}

/**
 * The reviewed mappings (ADR-0048 §3, ADR-0058 §5, ADR-0059 §2). Only
 * concepts whose definition is the metric's definition are listed; a label
 * that merely looks similar is not a mapping. A filing under a standard a
 * provider has no reviewed mapping for (a J-Quants `_JMIS` summary) is
 * stored and its metrics are reported as `no-mapping-for-standard`, never
 * estimated.
 */
export const EQUITY_CONCEPT_MAPPINGS: readonly EquityConceptMapping[] = [
	// US GAAP (SEC company facts, taxonomy prefix `us-gaap:`).
	...candidates("sec", "revenue", "US-GAAP", [
		"us-gaap:Revenues",
		"us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
		"us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax",
		"us-gaap:SalesRevenueNet",
	]),
	...candidates("sec", "gross-profit", "US-GAAP", ["us-gaap:GrossProfit"]),
	...candidates("sec", "operating-income", "US-GAAP", ["us-gaap:OperatingIncomeLoss"]),
	...candidates("sec", "profit-attributable-to-owners", "US-GAAP", ["us-gaap:NetIncomeLoss"]),
	...candidates("sec", "total-assets", "US-GAAP", ["us-gaap:Assets"]),
	...candidates("sec", "total-liabilities", "US-GAAP", ["us-gaap:Liabilities"]),
	...candidates("sec", "total-equity", "US-GAAP", [
		"us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
		"us-gaap:StockholdersEquity",
	]),
	...candidates("sec", "cash-and-cash-equivalents", "US-GAAP", [
		"us-gaap:CashAndCashEquivalentsAtCarryingValue",
	]),
	...candidates("sec", "net-cash-from-operating-activities", "US-GAAP", [
		"us-gaap:NetCashProvidedByUsedInOperatingActivities",
	]),
	...candidates("sec", "net-cash-from-investing-activities", "US-GAAP", [
		"us-gaap:NetCashProvidedByUsedInInvestingActivities",
	]),
	...candidates("sec", "net-cash-from-financing-activities", "US-GAAP", [
		"us-gaap:NetCashProvidedByUsedInFinancingActivities",
	]),
	...candidates("sec", "capital-expenditures", "US-GAAP", [
		"us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
	]),
	// IFRS as SEC's foreign private issuers file it (20-F / 40-F, company
	// facts taxonomy prefix `ifrs-full:`), element names of the IFRS
	// Accounting Taxonomy. Each mirrors the US-GAAP row above: `Revenue` is
	// total revenue (IAS 1.82(a)), the IFRS 15 contract revenue a subset of
	// it; profit is the parent's share; total equity includes non-controlling
	// interests, the parent's share only when no total is tagged; the cash
	// payment for property, plant and equipment is a positive amount, as in
	// US GAAP. IFRS has no ordinary income (JGAAP's 経常利益).
	...candidates("sec", "revenue", "IFRS", [
		"ifrs-full:Revenue",
		"ifrs-full:RevenueFromContractsWithCustomers",
	]),
	...candidates("sec", "gross-profit", "IFRS", ["ifrs-full:GrossProfit"]),
	...candidates("sec", "operating-income", "IFRS", ["ifrs-full:ProfitLossFromOperatingActivities"]),
	...candidates("sec", "profit-attributable-to-owners", "IFRS", [
		"ifrs-full:ProfitLossAttributableToOwnersOfParent",
	]),
	...candidates("sec", "total-assets", "IFRS", ["ifrs-full:Assets"]),
	...candidates("sec", "total-liabilities", "IFRS", ["ifrs-full:Liabilities"]),
	...candidates("sec", "total-equity", "IFRS", [
		"ifrs-full:Equity",
		"ifrs-full:EquityAttributableToOwnersOfParent",
	]),
	...candidates("sec", "cash-and-cash-equivalents", "IFRS", ["ifrs-full:CashAndCashEquivalents"]),
	...candidates("sec", "net-cash-from-operating-activities", "IFRS", [
		"ifrs-full:CashFlowsFromUsedInOperatingActivities",
	]),
	...candidates("sec", "net-cash-from-investing-activities", "IFRS", [
		"ifrs-full:CashFlowsFromUsedInInvestingActivities",
	]),
	...candidates("sec", "net-cash-from-financing-activities", "IFRS", [
		"ifrs-full:CashFlowsFromUsedInFinancingActivities",
	]),
	...candidates("sec", "capital-expenditures", "IFRS", [
		"ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
	]),
	// J-Quants earnings summaries (決算短信, `GET /v2/fins/summary`, ADR-0059
	// §2): J-Quants normalises the summary items across JGAAP, IFRS and US
	// GAAP filers, so each item maps under all three. `Sales` is net sales
	// (売上高 / 売上収益 / 営業収益); `NP` is profit attributable to owners
	// of the parent (the reporting entity's profit in a non-consolidated
	// summary); `Eq` is the summary's equity (純資産 / 資本合計); cash
	// outflows are negative, as SEC's. Ordinary profit (`OdP`, 経常利益)
	// exists only under JGAAP. The summary has no gross profit, liabilities
	// or capital expenditure. The `NC…` items of a consolidated summary are
	// its non-consolidated figures, extracted as scope `separate` under the
	// same concept as the plain item (ADR-0059 §2 "Facts").
	...JQUANTS_STANDARDS.flatMap((standard) => [
		...candidates("jquants", "revenue", standard, ["jquants:Sales"]),
		...candidates("jquants", "operating-income", standard, ["jquants:OP"]),
		...candidates("jquants", "profit-attributable-to-owners", standard, ["jquants:NP"]),
		...candidates("jquants", "total-assets", standard, ["jquants:TA"]),
		...candidates("jquants", "total-equity", standard, ["jquants:Eq"]),
		...candidates("jquants", "cash-and-cash-equivalents", standard, ["jquants:CashEq"]),
		...candidates("jquants", "net-cash-from-operating-activities", standard, ["jquants:CFO"]),
		...candidates("jquants", "net-cash-from-investing-activities", standard, ["jquants:CFI"]),
		...candidates("jquants", "net-cash-from-financing-activities", standard, ["jquants:CFF"]),
	]),
	...candidates("jquants", "ordinary-income", "JGAAP", ["jquants:OdP"]),
];

/** The concepts a runner extracts for a provider, sorted (the claim sends them). */
export function equityConceptsOfProvider(provider: EquityProvider): readonly string[] {
	return [
		...new Set(
			EQUITY_CONCEPT_MAPPINGS.filter((m) => m.provider === provider).map((m) => m.concept),
		),
	].sort();
}

/**
 * The mappings of one concept under one standard for one provider's filings
 * (several metrics never share one today). Filtering by provider keeps a
 * provider's selection to its own reviewed rows, as the Lean model does
 * (`FinancialStatements.lean`, one metric table per provider).
 */
export function equityMappingsOfConcept(
	provider: EquityProvider,
	standard: EquityAccountingStandard,
	concept: string,
): readonly EquityConceptMapping[] {
	return EQUITY_CONCEPT_MAPPINGS.filter(
		(m) => m.provider === provider && m.standard === standard && m.concept === concept,
	);
}

/** The standards each provider's filings have reviewed mappings for, built once. */
const MAPPED_STANDARDS: { readonly [P in EquityProvider]: ReadonlySet<EquityAccountingStandard> } =
	(() => {
		const of = (provider: EquityProvider): ReadonlySet<EquityAccountingStandard> =>
			new Set(
				EQUITY_CONCEPT_MAPPINGS.filter((m) => m.provider === provider).map((m) => m.standard),
			);
		return { sec: of("sec"), jquants: of("jquants") };
	})();

/**
 * Whether a provider's filing under `standard` has reviewed mappings
 * (ADR-0048 §3, ADR-0058 §5, ADR-0059 §2): SEC maps US GAAP and IFRS,
 * J-Quants maps JGAAP, IFRS and US GAAP; any other standard reads
 * `no-mapping-for-standard`, not `not-reported`. The Lean model's
 * `hasReviewedMappings`.
 */
export function providerStandardHasMappings(
	provider: EquityProvider,
	standard: EquityAccountingStandard,
): boolean {
	return MAPPED_STANDARDS[provider].has(standard);
}

/* ---------- Calendar dates (proleptic Gregorian, UTC day numbers) ---------- */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01 of a valid ISO date, or null. */
export function isoDayNumber(isoDate: string): number | null {
	const match = ISO_DATE.exec(isoDate);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const ms = Date.UTC(year, month - 1, day);
	const back = new Date(ms);
	if (
		back.getUTCFullYear() !== year ||
		back.getUTCMonth() !== month - 1 ||
		back.getUTCDate() !== day
	) {
		return null;
	}
	return ms / MS_PER_DAY;
}

export function isoDateOfDayNumber(dayNumber: number): string {
	return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

/** The same month and day `years` earlier; 29 February becomes 28 February. */
export function shiftIsoDateYears(isoDate: string, years: number): string | null {
	const match = ISO_DATE.exec(isoDate);
	if (match === null || isoDayNumber(isoDate) === null) return null;
	const year = Number(match[1]) + years;
	const month = match[2] ?? "01";
	let day = match[3] ?? "01";
	if (month === "02" && day === "29" && isoDayNumber(`${year}-02-29`) === null) day = "28";
	const shifted = `${String(year).padStart(4, "0")}-${month}-${day}`;
	return isoDayNumber(shifted) === null ? null : shifted;
}

/* ---------- Annual periods and fiscal years ---------- */

/**
 * Inclusive day-count bounds of an annual duration: a calendar year is 365
 * or 366 days, a 52/53-week year 364 or 371. Anything shorter is an interim
 * or transition period and never becomes an annual value.
 */
export const ANNUAL_DURATION_DAYS = { min: 350, max: 380 } as const;

export function isAnnualDuration(periodStart: string, periodEnd: string): boolean {
	const start = isoDayNumber(periodStart);
	const end = isoDayNumber(periodEnd);
	if (start === null || end === null) return false;
	const days = end - start + 1;
	return days >= ANNUAL_DURATION_DAYS.min && days <= ANNUAL_DURATION_DAYS.max;
}

/**
 * The fiscal year label of a period ending on `periodEnd`: the calendar year
 * it ends in, except that a 52/53-week year ending in the first seven days
 * of January belongs to the year before (it is the December year). This is
 * the Japanese convention (2025年3月期 → 2025) and fits most US filers; a
 * company's own label can differ (e.g. a retailer ending 1 February 2025 may
 * call it fiscal 2024), which is why every value also carries its period end.
 * A 52/53-week year whose end drifts across 7/8 January would give two period
 * ends one label: that year's values then read `ambiguous` (fail safe).
 */
export function fiscalYearOfPeriodEnd(periodEnd: string): number | null {
	const match = ISO_DATE.exec(periodEnd);
	if (match === null || isoDayNumber(periodEnd) === null) return null;
	const year = Number(match[1]);
	return match[2] === "01" && Number(match[3]) <= 7 ? year - 1 : year;
}

/** One as-reported fact as a runner extracted it from a filing. */
export interface EquityExtractedFact {
	readonly concept: string;
	readonly unit: string;
	readonly valueDecimal: string;
	readonly periodType: EquityPeriodType;
	readonly periodStart: string | null;
	readonly periodEnd: string;
	readonly scope: EquityScope;
}

export type EquityFactProblem =
	| "INVALID_PERIOD"
	| "NOT_ANNUAL_DURATION"
	| "INSTANT_NOT_AT_YEAR_END"
	| "INVALID_DECIMAL";

/** Canonical exact decimal text: no leading zeros, no trailing fractional zeros, no "-0". */
export function isCanonicalDecimal(value: string): boolean {
	return /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(value) && value !== "-0" && value.length <= 64;
}

/**
 * Keeps only the annual facts of one filing (ADR-0048 §4): a duration must
 * span an annual period; an instant must fall on the end of an annual
 * duration reported in the same filing (a balance at a fiscal year end, not
 * at an interim date or the opening date of the oldest comparative year).
 * Returns the kept facts in input order and the first problem per dropped fact.
 */
export function annualFactsOfFiling(facts: readonly EquityExtractedFact[]): {
	readonly kept: readonly EquityExtractedFact[];
	readonly dropped: readonly {
		readonly fact: EquityExtractedFact;
		readonly problem: EquityFactProblem;
	}[];
} {
	const yearEnds = new Set<string>();
	for (const fact of facts) {
		if (
			fact.periodType === "duration" &&
			fact.periodStart !== null &&
			isAnnualDuration(fact.periodStart, fact.periodEnd)
		) {
			yearEnds.add(fact.periodEnd);
		}
	}
	const kept: EquityExtractedFact[] = [];
	const dropped: { fact: EquityExtractedFact; problem: EquityFactProblem }[] = [];
	for (const fact of facts) {
		const problem = annualFactProblem(fact, yearEnds);
		if (problem === null) kept.push(fact);
		else dropped.push({ fact, problem });
	}
	return { kept, dropped };
}

function annualFactProblem(
	fact: EquityExtractedFact,
	yearEnds: ReadonlySet<string>,
): EquityFactProblem | null {
	if (!isCanonicalDecimal(fact.valueDecimal)) return "INVALID_DECIMAL";
	if (isoDayNumber(fact.periodEnd) === null) return "INVALID_PERIOD";
	if (fact.periodType === "instant") {
		if (fact.periodStart !== null) return "INVALID_PERIOD";
		return yearEnds.has(fact.periodEnd) ? null : "INSTANT_NOT_AT_YEAR_END";
	}
	if (fact.periodStart === null || isoDayNumber(fact.periodStart) === null) return "INVALID_PERIOD";
	return isAnnualDuration(fact.periodStart, fact.periodEnd) ? null : "NOT_ANNUAL_DURATION";
}

/* ---------- Exact decimals ---------- */

function scaleOf(value: string): number {
	const dot = value.indexOf(".");
	return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaled(value: string, scale: number): bigint {
	return BigInt(value.replace(".", "")) * 10n ** BigInt(scale - scaleOf(value));
}

function fromScaled(scaled: bigint, scale: number): string {
	const negative = scaled < 0n;
	const digits = (negative ? -scaled : scaled).toString().padStart(scale + 1, "0");
	const whole = digits.slice(0, digits.length - scale);
	const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
	const text = fraction === "" ? whole : `${whole}.${fraction}`;
	return negative && text !== "0" ? `-${text}` : text;
}

/** Exact `left - right` of canonical decimals, canonical. */
export function subtractDecimals(left: string, right: string): string {
	const scale = Math.max(scaleOf(left), scaleOf(right));
	return fromScaled(toScaled(left, scale) - toScaled(right, scale), scale);
}

/** Exact `-value`, canonical. */
export function negateDecimal(value: string): string {
	if (value === "0") return value;
	return value.startsWith("-") ? value.slice(1) : `-${value}`;
}

export function decimalIsNegative(value: string): boolean {
	return value.startsWith("-");
}

/* ---------- The authoritative value of a metric in a fiscal year ---------- */

/** A stored as-filed fact with the filing facts the selection needs. */
export interface EquityReportedFact {
	readonly filingId: string;
	/** Filing date (ISO); a later filing supersedes an earlier one for the same period. */
	readonly filedOn: string;
	readonly standard: EquityAccountingStandard;
	readonly concept: string;
	readonly scope: EquityScope;
	readonly unit: string;
	readonly valueDecimal: string;
	readonly periodStart: string | null;
	readonly periodEnd: string;
}

export const EQUITY_UNAVAILABLE_REASONS = [
	/** No filing reported a mapped concept for this year. */
	"not-reported",
	/** Filings exist only under a standard without reviewed mappings (e.g. a J-Quants JMIS summary). */
	"no-mapping-for-standard",
	/** The latest filing reports two different values for the best concept. */
	"ambiguous",
	/** The normalized value has a sign the metric's definition excludes. */
	"unexpected-sign",
	/** The value is not in an ISO 4217 currency unit. */
	"unsupported-unit",
	/** A derived metric whose inputs are missing or come from different filings. */
	"not-derivable",
] as const;
export type EquityUnavailableReason = (typeof EQUITY_UNAVAILABLE_REASONS)[number];

export type EquityMetricSelection =
	| {
			readonly kind: "value";
			/** Normalized (sign applied), canonical exact decimal. */
			readonly valueDecimal: string;
			readonly currency: string;
			readonly filingId: string;
			readonly filedOn: string;
			readonly concept: string;
			readonly scope: EquityScope;
			readonly standard: EquityAccountingStandard;
			readonly periodStart: string | null;
			readonly periodEnd: string;
			/** How many different normalized values the filings reported (1 = never revised). */
			readonly reportedValueCount: number;
	  }
	| { readonly kind: "unavailable"; readonly reason: EquityUnavailableReason };

interface Candidate {
	readonly fact: EquityReportedFact;
	readonly mapping: EquityConceptMapping;
}

const CURRENCY_UNIT = /^[A-Z]{3}$/;

function laterFiling(a: EquityReportedFact, b: EquityReportedFact): boolean {
	return a.filedOn > b.filedOn || (a.filedOn === b.filedOn && a.filingId > b.filingId);
}

/** The one fact a filing reports for the metric, or "ambiguous" / null. */
function bestOfFiling(candidatesOfFiling: readonly Candidate[]): Candidate | "ambiguous" | null {
	let best: Candidate[] = [];
	for (const candidate of candidatesOfFiling) {
		const rank = best[0]?.mapping.rank;
		if (rank === undefined || candidate.mapping.rank < rank) best = [candidate];
		else if (candidate.mapping.rank === rank) best.push(candidate);
	}
	const first = best[0];
	if (first === undefined) return null;
	for (const other of best) {
		if (
			other.fact.unit !== first.fact.unit ||
			other.fact.valueDecimal !== first.fact.valueDecimal ||
			other.fact.periodEnd !== first.fact.periodEnd ||
			other.fact.periodStart !== first.fact.periodStart
		) {
			return "ambiguous";
		}
	}
	return first;
}

function normalized(candidate: Candidate): string {
	return candidate.mapping.sign === -1
		? negateDecimal(candidate.fact.valueDecimal)
		: candidate.fact.valueDecimal;
}

/**
 * The current authoritative value of one non-derived metric in one fiscal
 * year (ADR-0048 §5), from every stored fact of that company and year:
 *
 * 1. keep facts whose (standard, concept, scope) maps to the metric;
 * 2. prefer consolidated facts when any exist, else separate ones;
 * 3. take the latest filing among them (filing date, then filing id) — an
 *    amendment or a later report that restates the year supersedes earlier
 *    filings, whose facts stay stored as the as-filed history;
 * 4. within that filing take the best-ranked concept; two different values
 *    for it are "ambiguous" rather than a guess;
 * 5. apply the mapping's sign; check unit and sign.
 *
 * The result depends only on the set of facts (not their order), and facts
 * of filings older than the selected one never change the selected value
 * (only `reportedValueCount`) — so a sync recomputes exactly the
 * (metric, year) keys its new facts touch. Precondition: one filing id has
 * one filing date and one standard (the caller joins each fact with its
 * stored filing row), and every fact is one company's — so of one
 * `provider`, whose reviewed mappings decide which standards are mapped.
 */
export function selectMetricValue(
	metricCode: EquityMetricCode,
	facts: readonly EquityReportedFact[],
	provider: EquityProvider,
): EquityMetricSelection {
	const definition = equityMetricDefinition(metricCode);
	if (definition.derived) return { kind: "unavailable", reason: "not-derivable" };
	const mapped: Candidate[] = [];
	let unmappedStandard = false;
	for (const fact of facts) {
		if (!providerStandardHasMappings(provider, fact.standard)) {
			unmappedStandard = true;
			continue;
		}
		for (const mapping of equityMappingsOfConcept(provider, fact.standard, fact.concept)) {
			if (mapping.metric !== metricCode) continue;
			if (mapping.scope !== "any" && mapping.scope !== fact.scope) continue;
			mapped.push({ fact, mapping });
		}
	}
	if (mapped.length === 0) {
		return {
			kind: "unavailable",
			reason: unmappedStandard ? "no-mapping-for-standard" : "not-reported",
		};
	}
	const scope: EquityScope = mapped.some((c) => c.fact.scope === "consolidated")
		? "consolidated"
		: "separate";
	const inScope = mapped.filter((c) => c.fact.scope === scope);
	const byFiling = new Map<string, Candidate[]>();
	for (const candidate of inScope) {
		const list = byFiling.get(candidate.fact.filingId);
		if (list === undefined) byFiling.set(candidate.fact.filingId, [candidate]);
		else list.push(candidate);
	}
	let latest: EquityReportedFact | null = null;
	for (const candidate of inScope) {
		if (latest === null || laterFiling(candidate.fact, latest)) latest = candidate.fact;
	}
	if (latest === null) return { kind: "unavailable", reason: "not-reported" };
	const chosen = bestOfFiling(byFiling.get(latest.filingId) ?? []);
	if (chosen === null) return { kind: "unavailable", reason: "not-reported" };
	if (chosen === "ambiguous") return { kind: "unavailable", reason: "ambiguous" };
	if (!CURRENCY_UNIT.test(chosen.fact.unit))
		return { kind: "unavailable", reason: "unsupported-unit" };
	const valueDecimal = normalized(chosen);
	if (definition.nonNegative && decimalIsNegative(valueDecimal)) {
		return { kind: "unavailable", reason: "unexpected-sign" };
	}
	const reported = new Set<string>();
	for (const list of byFiling.values()) {
		const best = bestOfFiling(list);
		if (best !== null && best !== "ambiguous" && best.fact.unit === chosen.fact.unit) {
			reported.add(normalized(best));
		}
	}
	return {
		kind: "value",
		valueDecimal,
		currency: chosen.fact.unit,
		filingId: chosen.fact.filingId,
		filedOn: chosen.fact.filedOn,
		concept: chosen.fact.concept,
		scope: chosen.fact.scope,
		standard: chosen.fact.standard,
		periodStart: chosen.fact.periodStart,
		periodEnd: chosen.fact.periodEnd,
		reportedValueCount: reported.size,
	};
}

/**
 * Free cash flow = net cash from operating activities − capital
 * expenditures, only when both come from the same filing in the same
 * currency (a pair from different filings could mix a restated and an
 * original figure). Marked derived wherever it is shown.
 */
export function deriveFreeCashFlow(
	operating: EquityMetricSelection,
	capitalExpenditures: EquityMetricSelection,
): EquityMetricSelection {
	if (
		operating.kind !== "value" ||
		capitalExpenditures.kind !== "value" ||
		operating.filingId !== capitalExpenditures.filingId ||
		operating.currency !== capitalExpenditures.currency
	) {
		return { kind: "unavailable", reason: "not-derivable" };
	}
	return {
		...operating,
		valueDecimal: subtractDecimals(operating.valueDecimal, capitalExpenditures.valueDecimal),
		concept: "derived:free-cash-flow",
		reportedValueCount: 1,
	};
}

/** Every metric of one company-year: the non-derived selections, then the derived ones. */
export function selectFiscalYearMetrics(
	facts: readonly EquityReportedFact[],
	provider: EquityProvider,
): ReadonlyMap<EquityMetricCode, EquityMetricSelection> {
	const result = new Map<EquityMetricCode, EquityMetricSelection>();
	for (const definition of EQUITY_METRICS) {
		if (!definition.derived) {
			result.set(definition.code, selectMetricValue(definition.code, facts, provider));
		}
	}
	const unavailable: EquityMetricSelection = { kind: "unavailable", reason: "not-reported" };
	result.set(
		"free-cash-flow",
		deriveFreeCashFlow(
			result.get("net-cash-from-operating-activities") ?? unavailable,
			result.get("capital-expenditures") ?? unavailable,
		),
	);
	return result;
}

/* ---------- Filings without facts ---------- */

/**
 * Days a filing whose facts are not available yet stays "pending" and is
 * offered to the runner again: SEC company facts can lag the filing itself
 * (a J-Quants summary carries its figures, so it is never pending). After this many days it is recorded as having
 * no facts (an amendment of the text only, a filing without XBRL), so it is
 * not downloaded again every day.
 */
export const EQUITY_PENDING_FILING_GRACE_DAYS = 7;

export function filingStaysPending(filedOn: string, today: string): boolean {
	const filed = isoDayNumber(filedOn);
	const now = isoDayNumber(today);
	if (filed === null || now === null) return false;
	return now - filed < EQUITY_PENDING_FILING_GRACE_DAYS;
}

/* ---------- J-Quants ---------- */

/** J-Quants' five-character issue code of a JPX local code ("7974" → "79740", "130A" → "130A0"). */
export function jquantsIssueCode(symbol: string): string {
	return `${symbol}0`;
}
