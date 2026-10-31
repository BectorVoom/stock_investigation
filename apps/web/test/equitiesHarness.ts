import {
	type EquityCompanyView,
	type EquityFilingListItem,
	type EquityFilingView,
	type EquityMetricCell,
	type EquityMetricSeriesResponse,
	type EquityRevisionsResponse,
	type EquityStatementResponse,
	equityCompanyListSchema,
	equityCompanyViewSchema,
	equityFilingsResponseSchema,
	equityMetricCodeSchema,
	equityMetricSeriesResponseSchema,
	equityRevisionsResponseSchema,
	equityStatementResponseSchema,
} from "@research/contracts";
import {
	EQUITY_STATEMENTS,
	type EquityMetricCode,
	type EquityScope,
	type EquityStatement,
	equityStatementMetrics,
} from "@research/domain";
import { createApiClient } from "../src/api/client.ts";
import {
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
	type RecordedRequest,
} from "./fakeBackend.ts";

/**
 * A fake equities API (ADR-0048 §7) for the widget and page tests: two
 * tracked companies — Apple (SEC, synced, five fiscal years with a revised
 * and a derived value and an unreported metric) and Nintendo (EDINET, its
 * sync failed because EDINET_API_KEY is not set; or, as `nintendoSynced()`,
 * synced with five March-end years in yen) — answered in the contract's
 * shapes (every answer is parsed with its schema first), with ETags and 304s
 * like the real API. A company that is not the owner's is the API's own
 * 404 `EQUITY_COMPANY_NOT_FOUND`.
 */

export const APPLE_ID = "eqc_apple";
export const NINTENDO_ID = "eqc_nintendo";
export const APPLE_YEARS = [2020, 2021, 2022, 2023, 2024] as const;

export function makeCompany(overrides: Partial<EquityCompanyView> = {}): EquityCompanyView {
	return equityCompanyViewSchema.parse({
		companyId: APPLE_ID,
		market: "US",
		symbol: "AAPL",
		name: "Apple Inc.",
		provider: "sec",
		sourceCompanyId: "0000320193",
		fiscalYearEnd: "09-28",
		tracked: true,
		latestFiscalYear: 2024,
		filingCount: 6,
		sync: {
			status: "succeeded",
			phase: null,
			lastCheckedAt: "2026-10-31T08:00:00Z",
			lastSucceededAt: "2026-10-31T08:00:00Z",
			nextDueAt: "2026-11-01T08:00:00Z",
			failure: null,
		},
		...overrides,
	});
}

export const NINTENDO = (): EquityCompanyView =>
	makeCompany({
		companyId: NINTENDO_ID,
		market: "JP",
		symbol: "7974",
		name: "任天堂株式会社",
		provider: "edinet",
		sourceCompanyId: null,
		fiscalYearEnd: null,
		latestFiscalYear: null,
		filingCount: 0,
		sync: {
			status: "failed",
			phase: "discovery",
			lastCheckedAt: "2026-10-31T09:00:00Z",
			lastSucceededAt: null,
			nextDueAt: "2026-10-31T09:30:00Z",
			failure: {
				code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
				upstreamStatus: null,
				at: "2026-10-31T09:00:00Z",
			},
		},
	});

/** Nintendo after a successful EDINET sync: five fiscal years ending 31 March, in yen. */
export const nintendoSynced = (): EquityCompanyView =>
	makeCompany({
		companyId: NINTENDO_ID,
		market: "JP",
		symbol: "7974",
		name: "任天堂株式会社",
		provider: "edinet",
		sourceCompanyId: "E02367",
		fiscalYearEnd: "03-31",
		latestFiscalYear: 2025,
		filingCount: 6,
	});

/** Apple's period end of a fiscal year (the last Saturday of September, as SEC states it). */
const PERIOD_ENDS: Readonly<Record<number, string>> = {
	2020: "2020-09-26",
	2021: "2021-09-25",
	2022: "2022-09-24",
	2023: "2023-09-30",
	2024: "2024-09-28",
};

function filingOf(year: number, amended = false): EquityFilingView {
	const filedOn = `${year}-${amended ? "12-15" : "11-01"}`;
	return {
		filingId: `fil_${year}${amended ? "_a" : ""}`,
		provider: "sec",
		sourceDocumentId: `0000320193-${String(year).slice(2)}-0001${amended ? "99" : "23"}`,
		form: amended ? "10-K/A" : "10-K",
		isAmendment: amended,
		filedOn,
		periodEnd: PERIOD_ENDS[year] ?? `${year}-09-30`,
		accountingStandard: "US-GAAP",
		sourceUrl: `https://www.sec.gov/Archives/edgar/data/320193/000032019${year}${amended ? "a" : ""}/aapl-${year}.htm`,
	};
}

/** Base-unit values per metric and year; null = not reported. */
const VALUES: { readonly [M in EquityMetricCode]?: Readonly<Record<number, string | null>> } = {
	revenue: {
		2020: "274515000000",
		2021: "365817000000",
		2022: "394328000000",
		2023: "383285000000",
		2024: "391035000000",
	},
	"gross-profit": {
		2020: "104956000000",
		2021: "152836000000",
		2022: "170782000000",
		2023: "169148000000",
		2024: "180683000000",
	},
	"operating-income": {
		2020: "66288000000",
		2021: "108949000000",
		2022: "119437000000",
		2023: "114301000000",
		2024: "123216000000",
	},
	"profit-attributable-to-owners": {
		2020: "57411000000",
		2021: "94680000000",
		2022: "99803000000",
		2023: "96995000000",
		2024: "93736000000",
	},
	"total-assets": {
		2020: "323888000000",
		2021: "351002000000",
		2022: "352755000000",
		2023: "352583000000",
		2024: "364980000000",
	},
	"net-cash-from-operating-activities": {
		2020: "80674000000",
		2021: "104038000000",
		2022: "122151000000",
		2023: "110543000000",
		2024: "118254000000",
	},
	"net-cash-from-investing-activities": {
		2020: "-4289000000",
		2021: "-14545000000",
		2022: "-22354000000",
		2023: "3705000000",
		2024: "2935000000",
	},
	"capital-expenditures": {
		2020: "7309000000",
		2021: "11085000000",
		2022: "10708000000",
		2023: "10959000000",
		2024: "9447000000",
	},
	"free-cash-flow": {
		2020: "73365000000",
		2021: "92953000000",
		2022: "111443000000",
		2023: "99584000000",
		2024: "108807000000",
	},
	// Missing in 2021 only: a gap, never 0.
	"cash-and-cash-equivalents": {
		2020: "38016000000",
		2021: null,
		2022: "23646000000",
		2023: "29965000000",
		2024: "29943000000",
	},
};

/** 2023 revenue was restated by a 10-K/A (two values reported). */
function isRevisedCell(metric: EquityMetricCode, year: number): boolean {
	return metric === "revenue" && year === 2023;
}

function cellOf(metric: EquityMetricCode, year: number): EquityMetricCell {
	const value = VALUES[metric]?.[year] ?? null;
	if (value === null) {
		return {
			fiscalYear: year,
			periodEnd: null,
			valueDecimal: null,
			currency: null,
			unavailableReason: "not-reported",
			filingId: null,
			concept: null,
			scope: null,
			derived: false,
			reportedValueCount: 0,
		};
	}
	const revised = isRevisedCell(metric, year);
	return {
		fiscalYear: year,
		periodEnd: PERIOD_ENDS[year] ?? null,
		valueDecimal: value,
		currency: "USD",
		unavailableReason: null,
		filingId: revised ? `fil_${year}_a` : `fil_${year}`,
		concept: metric === "free-cash-flow" ? null : `us-gaap:${metric}`,
		scope: "consolidated",
		derived: metric === "free-cash-flow",
		reportedValueCount: revised ? 2 : 1,
	};
}

function filingsFor(cells: readonly EquityMetricCell[]): EquityFilingView[] {
	const ids = new Set(cells.flatMap((cell) => (cell.filingId === null ? [] : [cell.filingId])));
	const all = [...APPLE_YEARS.map((year) => filingOf(year)), filingOf(2023, true)];
	return all.filter((filing) => ids.has(filing.filingId));
}

function yearsWindow(years: number): readonly number[] {
	return APPLE_YEARS.slice(Math.max(0, APPLE_YEARS.length - years));
}

export function appleStatement(
	statement: EquityStatement,
	years = 5,
	company: EquityCompanyView = makeCompany(),
): EquityStatementResponse {
	const fiscalYears = yearsWindow(years);
	const rows = equityStatementMetrics(statement).map((metric) => ({
		metric,
		cells: fiscalYears.map((year) =>
			metric === "ordinary-income" ? UNREPORTED(year) : cellOf(metric, year),
		),
	}));
	return equityStatementResponseSchema.parse({
		company,
		statement,
		fiscalYears,
		rows,
		filings: filingsFor(rows.flatMap((row) => row.cells)),
		dataUpdatedAt: "2026-10-31T08:00:00Z",
	});
}

/** A US filer has no ordinary income (a JGAAP-only metric): every year "not reported". */
function UNREPORTED(year: number): EquityMetricCell {
	return {
		fiscalYear: year,
		periodEnd: null,
		valueDecimal: null,
		currency: null,
		unavailableReason: "not-reported",
		filingId: null,
		concept: null,
		scope: null,
		derived: false,
		reportedValueCount: 0,
	};
}

export function appleSeries(metric: EquityMetricCode, years = 5): EquityMetricSeriesResponse {
	const cells = yearsWindow(years).map((year) =>
		metric === "ordinary-income" ? UNREPORTED(year) : cellOf(metric, year),
	);
	return equityMetricSeriesResponseSchema.parse({
		company: makeCompany(),
		metric,
		cells,
		filings: filingsFor(cells),
		dataUpdatedAt: "2026-10-31T08:00:00Z",
	});
}

export function appleRevisions(
	metric: EquityMetricCode,
	fiscalYear: number,
): EquityRevisionsResponse {
	const current = cellOf(metric, fiscalYear);
	return equityRevisionsResponseSchema.parse({
		company: makeCompany(),
		metric,
		fiscalYear,
		current,
		reported: [
			{
				filingId: `fil_${fiscalYear}_a`,
				concept: current.concept ?? "us-gaap:Revenues",
				scope: "consolidated",
				unit: "USD",
				valueDecimal: current.valueDecimal ?? "0",
				periodStart: "2022-10-02",
				periodEnd: PERIOD_ENDS[fiscalYear] ?? "2023-09-30",
			},
			{
				filingId: `fil_${fiscalYear}`,
				concept: current.concept ?? "us-gaap:Revenues",
				scope: "consolidated",
				unit: "USD",
				valueDecimal: "383933000000",
				periodStart: "2022-10-02",
				periodEnd: PERIOD_ENDS[fiscalYear] ?? "2023-09-30",
			},
		],
		filings: [filingOf(fiscalYear, true), filingOf(fiscalYear)],
	});
}

/** An empty statement: a tracked company before its first sync stored a value. */
export function emptyStatement(
	statement: EquityStatement,
	company: EquityCompanyView,
): EquityStatementResponse {
	return equityStatementResponseSchema.parse({
		company,
		statement,
		fiscalYears: [],
		rows: equityStatementMetrics(statement).map((metric) => ({ metric, cells: [] })),
		filings: [],
		dataUpdatedAt: null,
	});
}

/* ---------- Nintendo (EDINET, Japanese GAAP, yen) ---------- */

export const NINTENDO_YEARS = [2021, 2022, 2023, 2024, 2025] as const;

/** Nintendo's filings: one securities report per year (filed in June) and one amendment of FY2024's. */
function nintendoFiling(year: number, amended = false): EquityFilingView {
	const docId = `S100N${amended ? "A" : "0"}${String(year).slice(2)}`;
	return {
		filingId: `fil_jp_${year}${amended ? "_a" : ""}`,
		provider: "edinet",
		sourceDocumentId: docId,
		form: amended ? "amended-securities-report" : "securities-report",
		isAmendment: amended,
		filedOn: `${year}-${amended ? "09-10" : "06-27"}`,
		periodEnd: `${year}-03-31`,
		accountingStandard: "JGAAP",
		sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${docId}`,
	};
}

/** Base-unit yen per metric and fiscal year (all reported). */
const JP_VALUES: { readonly [M in EquityMetricCode]?: Readonly<Record<number, string>> } = {
	revenue: {
		2021: "1758910000000",
		2022: "1695344000000",
		2023: "1601677000000",
		2024: "1671865000000",
		2025: "1164922000000",
	},
	"gross-profit": {
		2021: "975396000000",
		2022: "940602000000",
		2023: "891481000000",
		2024: "954022000000",
		2025: "706487000000",
	},
	"operating-income": {
		2021: "640634000000",
		2022: "592760000000",
		2023: "504375000000",
		2024: "528941000000",
		2025: "282492000000",
	},
	"ordinary-income": {
		2021: "678996000000",
		2022: "670813000000",
		2023: "601615000000",
		2024: "680632000000",
		2025: "372315000000",
	},
	"profit-attributable-to-owners": {
		2021: "480376000000",
		2022: "477691000000",
		2023: "432768000000",
		2024: "490602000000",
		2025: "278806000000",
	},
};

/** The FY2024 revenue was restated by the amendment. */
function isRevisedJp(metric: EquityMetricCode, year: number): boolean {
	return metric === "revenue" && year === 2024;
}

function nintendoCell(
	metric: EquityMetricCode,
	year: number,
	scope: EquityScope,
): EquityMetricCell {
	const value = JP_VALUES[metric]?.[year] ?? null;
	if (value === null) return UNREPORTED(year);
	const revised = isRevisedJp(metric, year);
	return {
		fiscalYear: year,
		periodEnd: `${year}-03-31`,
		valueDecimal: value,
		currency: "JPY",
		unavailableReason: null,
		filingId: revised ? `fil_jp_${year}_a` : `fil_jp_${year}`,
		concept:
			metric === "profit-attributable-to-owners" && scope === "separate"
				? "jppfs_cor:ProfitLoss"
				: `jppfs_cor:${metric}`,
		scope,
		derived: false,
		reportedValueCount: revised ? 2 : 1,
	};
}

function nintendoFilingsFor(cells: readonly EquityMetricCell[]): EquityFilingView[] {
	const ids = new Set(cells.flatMap((cell) => (cell.filingId === null ? [] : [cell.filingId])));
	const all = [...NINTENDO_YEARS.map((year) => nintendoFiling(year)), nintendoFiling(2024, true)];
	return all.filter((filing) => ids.has(filing.filingId));
}

function nintendoYearsWindow(years: number): readonly number[] {
	return NINTENDO_YEARS.slice(Math.max(0, NINTENDO_YEARS.length - years));
}

/** Which scope each fiscal year's values are in (consolidated unless a test says otherwise). */
export type ScopeOfYear = (year: number) => EquityScope;
const CONSOLIDATED: ScopeOfYear = () => "consolidated";

export function nintendoStatement(
	statement: EquityStatement,
	years = 5,
	company: EquityCompanyView = nintendoSynced(),
	scopeOf: ScopeOfYear = CONSOLIDATED,
): EquityStatementResponse {
	const fiscalYears = nintendoYearsWindow(years);
	const rows = equityStatementMetrics(statement).map((metric) => ({
		metric,
		cells: fiscalYears.map((year) => nintendoCell(metric, year, scopeOf(year))),
	}));
	return equityStatementResponseSchema.parse({
		company,
		statement,
		fiscalYears,
		rows,
		filings: nintendoFilingsFor(rows.flatMap((row) => row.cells)),
		dataUpdatedAt: "2026-10-31T08:00:00Z",
	});
}

export function nintendoSeries(
	metric: EquityMetricCode,
	years = 5,
	company: EquityCompanyView = nintendoSynced(),
	scopeOf: ScopeOfYear = CONSOLIDATED,
): EquityMetricSeriesResponse {
	const cells = nintendoYearsWindow(years).map((year) => nintendoCell(metric, year, scopeOf(year)));
	return equityMetricSeriesResponseSchema.parse({
		company,
		metric,
		cells,
		filings: nintendoFilingsFor(cells),
		dataUpdatedAt: "2026-10-31T08:00:00Z",
	});
}

/**
 * Nintendo's FY2024 revenue as each filing reported it: the amendment and
 * the original each report it in both scopes (consolidated and separate),
 * so the current value's filing and concept appear twice — only its
 * consolidated row is the current one.
 */
export function nintendoRevisions(
	metric: EquityMetricCode,
	fiscalYear: number,
): EquityRevisionsResponse {
	const current = nintendoCell(metric, fiscalYear, "consolidated");
	const concept = current.concept ?? "jppfs_cor:NetSales";
	const reported = (filingId: string, scope: EquityScope, valueDecimal: string) => ({
		filingId,
		concept,
		scope,
		unit: "JPY",
		valueDecimal,
		periodStart: `${fiscalYear - 1}-04-01`,
		periodEnd: `${fiscalYear}-03-31`,
	});
	return equityRevisionsResponseSchema.parse({
		company: nintendoSynced(),
		metric,
		fiscalYear,
		current,
		reported: [
			reported(`fil_jp_${fiscalYear}_a`, "consolidated", current.valueDecimal ?? "1"),
			reported(`fil_jp_${fiscalYear}_a`, "separate", "1250000000000"),
			reported(`fil_jp_${fiscalYear}`, "consolidated", "1671000000000"),
			reported(`fil_jp_${fiscalYear}`, "separate", "1250000000000"),
		],
		filings: [nintendoFiling(fiscalYear, true), nintendoFiling(fiscalYear)],
	});
}

/** A company's stored filings as the filings read lists them, newest first. */
export function filingsList(company: EquityCompanyView): readonly EquityFilingListItem[] {
	const item = (
		filing: EquityFilingView,
		factsStatus: EquityFilingListItem["factsStatus"],
		factCount: number,
		amendsSourceDocumentId: string | null = null,
	): EquityFilingListItem => ({ ...filing, factsStatus, factCount, amendsSourceDocumentId });
	if (company.companyId === APPLE_ID) {
		// The FY2025 10-K is stored but its facts are not available yet (pending).
		const pending: EquityFilingView = {
			...filingOf(2025),
			periodEnd: "2025-09-27",
			sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/",
		};
		const amended = filingOf(2023, true);
		return [
			item(pending, "pending", 0),
			...[2024, 2023].map((year) => filingOf(year)).map((filing) => item(filing, "extracted", 24)),
			item(amended, "extracted", 3, filingOf(2023).sourceDocumentId),
			...[2022, 2021, 2020].map((year) => item(filingOf(year), "extracted", 24)),
		].sort((left, right) => right.filedOn.localeCompare(left.filedOn));
	}
	if (company.latestFiscalYear === null) return [];
	return [
		item(nintendoFiling(2025), "extracted", 30),
		item(nintendoFiling(2024, true), "extracted", 30, nintendoFiling(2024).sourceDocumentId),
		item(nintendoFiling(2024), "extracted", 30),
		item(nintendoFiling(2023), "extracted", 30),
		item(nintendoFiling(2022), "unavailable", 0),
		item(nintendoFiling(2021), "extracted", 30),
	].sort((left, right) => right.filedOn.localeCompare(left.filedOn));
}

export interface EquitiesServer {
	readonly backend: FakeBackend;
	readonly api: ReturnType<typeof createApiClient>;
	companies: EquityCompanyView[];
	/** Bumped to change every ETag (a sync stored new values). */
	revision: number;
	/** The scope of the synced Nintendo's values per fiscal year (consolidated by default). */
	japaneseScope: ScopeOfYear;
	/** Requests of one kind, for assertions. */
	readonly requests: (method: string, pattern: RegExp) => RecordedRequest[];
}

const BASE = /^\/api\/v1\/equities\/companies/;

/** The API's answer for a company that is not the owner's. */
function notTracked(): Response {
	return errorResponse(404, "EQUITY_COMPANY_NOT_FOUND", "The company is not tracked.");
}

function etagMatches(request: RecordedRequest, etag: string): boolean {
	return request.headers["if-none-match"] === etag;
}

function conditional(request: RecordedRequest, etag: string, body: unknown): Response {
	if (etagMatches(request, etag)) return new Response(null, { status: 304 });
	return jsonResponse(body, { headers: { ETag: etag } });
}

export function createEquitiesServer(
	options: { readonly companies?: EquityCompanyView[]; readonly backend?: FakeBackend } = {},
): EquitiesServer {
	const backend = options.backend ?? createFakeBackend();
	const server: EquitiesServer = {
		backend,
		api: createApiClient({
			fetch: backend.fetch,
			randomUuid: () => "00000000-0000-4000-8000-000000000000",
		}),
		companies: options.companies ?? [makeCompany(), NINTENDO()],
		revision: 1,
		japaneseScope: CONSOLIDATED,
		requests: (method, pattern) => backend.requestsTo(method, pattern),
	};
	const find = (companyId: string): EquityCompanyView | undefined =>
		server.companies.find((company) => company.companyId === companyId);
	const query = (request: RecordedRequest): URLSearchParams =>
		new URLSearchParams(request.path.split("?")[1] ?? "");
	/** Nintendo once synced (it has a latest fiscal year): its yen values; before that, none. */
	const hasJapaneseData = (company: EquityCompanyView): boolean =>
		company.companyId === NINTENDO_ID && company.latestFiscalYear !== null;

	backend.on("GET", /^\/api\/v1\/equities\/companies$/, (request) => {
		const body = equityCompanyListSchema.parse({ companies: server.companies });
		return conditional(request, `"companies-${server.revision}-${server.companies.length}"`, body);
	});
	backend.on(
		"GET",
		/^\/api\/v1\/equities\/companies\/([^/?]+)\/statements\/([a-z-]+)\?/,
		(request, match) => {
			const company = find(match[1] ?? "");
			const statement = EQUITY_STATEMENTS.find((entry) => entry === match[2]);
			if (company === undefined || statement === undefined) {
				return notTracked();
			}
			const years = Number(query(request).get("years") ?? "5");
			const body =
				company.companyId === APPLE_ID
					? appleStatement(statement, years, company)
					: hasJapaneseData(company)
						? nintendoStatement(statement, years, company, server.japaneseScope)
						: emptyStatement(statement, company);
			return conditional(
				request,
				`"st-${company.companyId}-${statement}-${years}-${server.revision}"`,
				body,
			);
		},
	);
	backend.on("GET", /^\/api\/v1\/equities\/companies\/([^/?]+)\/metrics\?/, (request, match) => {
		const company = find(match[1] ?? "");
		const params = query(request);
		const metric = params.get("metric");
		if (company === undefined || metric === null) {
			return notTracked();
		}
		const code = equityMetricCodeSchema.parse(metric);
		const years = Number(params.get("years") ?? "5");
		const series =
			company.companyId === APPLE_ID
				? appleSeries(code, years)
				: hasJapaneseData(company)
					? nintendoSeries(code, years, company, server.japaneseScope)
					: equityMetricSeriesResponseSchema.parse({
							company,
							metric: code,
							cells: [],
							filings: [],
							dataUpdatedAt: null,
						});
		return conditional(request, `"m-${company.companyId}-${metric}-${server.revision}"`, series);
	});
	backend.on("GET", /^\/api\/v1\/equities\/companies\/([^/?]+)\/revisions\?/, (request, match) => {
		const params = query(request);
		const company = find(match[1] ?? "");
		if (company === undefined) return notTracked();
		const metric = equityMetricCodeSchema.parse(params.get("metric"));
		const fiscalYear = Number(params.get("fiscalYear"));
		return jsonResponse(
			hasJapaneseData(company)
				? nintendoRevisions(metric, fiscalYear)
				: appleRevisions(metric, fiscalYear),
		);
	});
	backend.on("GET", /^\/api\/v1\/equities\/companies\/([^/?]+)\/filings$/, (request, match) => {
		const company = find(match[1] ?? "");
		if (company === undefined) return notTracked();
		const body = equityFilingsResponseSchema.parse({ company, filings: filingsList(company) });
		return conditional(request, `"filings-${company.companyId}-${server.revision}"`, body);
	});
	backend.on("POST", /^\/api\/v1\/equities\/companies$/, (request) => {
		const body = request.body;
		const stockId =
			typeof body === "object" && body !== null && "stockId" in body ? String(body.stockId) : "";
		const [market, symbol] = stockId.split(":");
		const company = makeCompany({
			companyId: `eqc_${symbol?.toLowerCase() ?? "x"}`,
			market: market === "jp" ? "JP" : "US",
			symbol: symbol ?? "X",
			name: null,
			provider: market === "jp" ? "edinet" : "sec",
			sourceCompanyId: null,
			fiscalYearEnd: null,
			latestFiscalYear: null,
			filingCount: 0,
			sync: {
				status: "queued",
				phase: null,
				lastCheckedAt: null,
				lastSucceededAt: null,
				nextDueAt: "2026-10-31T10:00:00Z",
				failure: null,
			},
		});
		server.companies = [...server.companies, company];
		return jsonResponse(company, { status: 201 });
	});
	backend.on("DELETE", /^\/api\/v1\/equities\/companies\/([^/?]+)$/, (_request, match) => {
		server.companies = server.companies.filter((company) => company.companyId !== match[1]);
		return new Response(null, { status: 204 });
	});
	backend.on("POST", /^\/api\/v1\/equities\/companies\/([^/?]+)\/sync$/, (_request, match) => {
		const company = find(match[1] ?? "");
		if (company === undefined) return notTracked();
		const queued = equityCompanyViewSchema.parse({
			...company,
			sync: { ...company.sync, status: "queued" },
		});
		server.companies = server.companies.map((entry) =>
			entry.companyId === company.companyId ? queued : entry,
		);
		return jsonResponse(queued, { status: 202 });
	});
	return server;
}

/** True when every request the test made went to our own equities API. */
export function onlyEquitiesRequests(backend: FakeBackend): boolean {
	return backend.requests.every((request) => BASE.test(request.path));
}
