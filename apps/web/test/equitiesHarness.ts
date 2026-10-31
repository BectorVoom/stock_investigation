import {
	type EquityCompanyView,
	type EquityFilingView,
	type EquityMetricCell,
	type EquityMetricSeriesResponse,
	type EquityRevisionsResponse,
	type EquityStatementResponse,
	equityCompanyListSchema,
	equityCompanyViewSchema,
	equityMetricCodeSchema,
	equityMetricSeriesResponseSchema,
	equityRevisionsResponseSchema,
	equityStatementResponseSchema,
} from "@research/contracts";
import {
	EQUITY_STATEMENTS,
	type EquityMetricCode,
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
 * A fake equities API (ADR-0045 §7) for the widget and page tests: two
 * tracked companies — Apple (SEC, synced, five fiscal years with a revised
 * and a derived value and an unreported metric) and Nintendo (EDINET, its
 * sync failed because EDINET_API_KEY is not set) — answered in the
 * contract's shapes (every answer is parsed with its schema first), with
 * ETags and 304s like the real API.
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

export interface EquitiesServer {
	readonly backend: FakeBackend;
	readonly api: ReturnType<typeof createApiClient>;
	companies: EquityCompanyView[];
	/** Bumped to change every ETag (a sync stored new values). */
	revision: number;
	/** Requests of one kind, for assertions. */
	readonly requests: (method: string, pattern: RegExp) => RecordedRequest[];
}

const BASE = /^\/api\/v1\/equities\/companies/;

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
		requests: (method, pattern) => backend.requestsTo(method, pattern),
	};
	const find = (companyId: string): EquityCompanyView | undefined =>
		server.companies.find((company) => company.companyId === companyId);
	const query = (request: RecordedRequest): URLSearchParams =>
		new URLSearchParams(request.path.split("?")[1] ?? "");

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
				return errorResponse(404, "NOT_FOUND", "company not tracked");
			}
			const years = Number(query(request).get("years") ?? "5");
			const body =
				company.companyId === APPLE_ID
					? appleStatement(statement, years, company)
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
			return errorResponse(404, "NOT_FOUND", "company not tracked");
		}
		const series = appleSeries(
			equityMetricCodeSchema.parse(metric),
			Number(params.get("years") ?? "5"),
		);
		return conditional(request, `"m-${company.companyId}-${metric}-${server.revision}"`, series);
	});
	backend.on("GET", /^\/api\/v1\/equities\/companies\/([^/?]+)\/revisions\?/, (request, match) => {
		const params = query(request);
		if (find(match[1] ?? "") === undefined)
			return errorResponse(404, "NOT_FOUND", "company not tracked");
		return jsonResponse(
			appleRevisions(
				equityMetricCodeSchema.parse(params.get("metric")),
				Number(params.get("fiscalYear")),
			),
		);
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
		if (company === undefined) return errorResponse(404, "NOT_FOUND", "company not tracked");
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
