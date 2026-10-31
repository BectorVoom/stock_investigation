import {
	API_PREFIX,
	type EquityCompanyList,
	type EquityCompanyView,
	type EquityMetricSeriesResponse,
	type EquityRevisionsResponse,
	type EquityStatementKind,
	type EquityStatementResponse,
	equityCompanyListSchema,
	equityCompanyViewSchema,
	equityMetricCodeSchema,
	equityMetricSeriesResponseSchema,
	equityRevisionsQuerySchema,
	equityRevisionsResponseSchema,
	equityStatementResponseSchema,
	equityStatementSchema,
	equityYearsQuerySchema,
	trackEquityCompanyRequestSchema,
} from "@research/contracts";
import type { EquityMetricCode } from "@research/domain";
import {
	type ApiResult,
	type Conditional,
	type HttpOptions,
	jsonBody,
	ok,
	type Parser,
	request,
	validate,
} from "./http.ts";

/**
 * The equities read API of ADR-0048 §7: tracked companies with their sync
 * status, and the stored annual statements, metric series and revisions.
 * Every request is our own `/api/v1/equities/...`; nothing here (or anywhere
 * in the SPA) reaches SEC or EDINET — only the runner does (ADR-0005).
 * Reads of values are conditional (ETag from the company's
 * `data_updated_at`), so a widget's periodic re-check of unchanged data is a
 * cheap 304.
 */
export function createEquityApi(http: HttpOptions) {
	const base = `${API_PREFIX}/equities/companies`;
	const company = (companyId: string): string => `${base}/${encodeURIComponent(companyId)}`;
	const invalidRequest = { kind: "invalid-request", status: null } as const;

	async function conditionalGet<T>(
		path: string,
		schema: Parser<T>,
		etag: string | null,
	): Promise<ApiResult<Conditional<T>>> {
		const readBody = jsonBody(schema);
		const read = async (response: Response): Promise<ApiResult<Conditional<T>>> => {
			if (response.status === 304) return ok({ changed: false });
			const body = await readBody(response);
			if (!body.ok) return body;
			return ok({ changed: true, value: body.value, etag: response.headers.get("ETag") });
		};
		return request(http, { method: "GET", path, ifNoneMatch: etag }, read);
	}

	/** The `years` (and `metric`) query, checked against the contract before it is sent. */
	function yearsQuery(years: number, metric?: EquityMetricCode): ApiResult<string> {
		const parsed = validate(equityYearsQuerySchema, { years: String(years) }, invalidRequest);
		if (!parsed.ok) return parsed;
		const params = new URLSearchParams({ years: String(parsed.value.years) });
		if (metric !== undefined) {
			const code = validate(equityMetricCodeSchema, metric, invalidRequest);
			if (!code.ok) return code;
			params.set("metric", code.value);
		}
		return ok(params.toString());
	}

	return {
		/** The tracked companies with their sync status (conditional: an unchanged list is a 304). */
		listEquityCompanies: (
			etag: string | null = null,
		): Promise<ApiResult<Conditional<EquityCompanyList>>> =>
			conditionalGet(base, equityCompanyListSchema, etag),
		/** One company, tracked or not (404 `EQUITY_COMPANY_NOT_FOUND` when the owner never tracked it). */
		getEquityCompany: (companyId: string): Promise<ApiResult<EquityCompanyView>> =>
			request(http, { method: "GET", path: company(companyId) }, jsonBody(equityCompanyViewSchema)),
		/**
		 * Tracks a listed stock (`us:AAPL`, `jp:7974`); a company tracked before
		 * is tracked again with its stored data. 409 when already tracked, 422
		 * at the limit.
		 */
		trackEquityCompany: async (stockId: string): Promise<ApiResult<EquityCompanyView>> => {
			const body = validate(trackEquityCompanyRequestSchema, { stockId }, invalidRequest);
			if (!body.ok) return body;
			return request(
				http,
				{ method: "POST", path: base, body: body.value },
				jsonBody(equityCompanyViewSchema),
			);
		},
		/** Stops tracking; the stored filings and values stay (ADR-0048 §7). */
		untrackEquityCompany: (companyId: string): Promise<ApiResult<null>> =>
			request(http, { method: "DELETE", path: company(companyId) }, async () => ok(null)),
		/** Sync soon: the API makes the company due now (202); the runner fetches when it claims. */
		syncEquityCompany: (companyId: string): Promise<ApiResult<EquityCompanyView>> =>
			request(
				http,
				{ method: "POST", path: `${company(companyId)}/sync` },
				jsonBody(equityCompanyViewSchema),
			),
		/** One statement over the newest `years` fiscal years, oldest first. */
		getEquityStatement: async (
			companyId: string,
			statement: EquityStatementKind,
			years: number,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<EquityStatementResponse>>> => {
			const kind = validate(equityStatementSchema, statement, invalidRequest);
			if (!kind.ok) return kind;
			const query = yearsQuery(years);
			if (!query.ok) return query;
			return conditionalGet(
				`${company(companyId)}/statements/${kind.value}?${query.value}`,
				equityStatementResponseSchema,
				etag,
			);
		},
		/** One metric over the newest `years` fiscal years, oldest first. */
		getEquityMetricSeries: async (
			companyId: string,
			metric: EquityMetricCode,
			years: number,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<EquityMetricSeriesResponse>>> => {
			const query = yearsQuery(years, metric);
			if (!query.ok) return query;
			return conditionalGet(
				`${company(companyId)}/metrics?${query.value}`,
				equityMetricSeriesResponseSchema,
				etag,
			);
		},
		/** Every as-filed value of one metric-year beside the current one (the revision history). */
		getEquityRevisions: async (
			companyId: string,
			metric: EquityMetricCode,
			fiscalYear: number,
		): Promise<ApiResult<EquityRevisionsResponse>> => {
			const query = validate(
				equityRevisionsQuerySchema,
				{ metric, fiscalYear: String(fiscalYear) },
				invalidRequest,
			);
			if (!query.ok) return query;
			const params = new URLSearchParams({
				metric: query.value.metric,
				fiscalYear: String(query.value.fiscalYear),
			});
			return request(
				http,
				{ method: "GET", path: `${company(companyId)}/revisions?${params.toString()}` },
				jsonBody(equityRevisionsResponseSchema),
			);
		},
	};
}
