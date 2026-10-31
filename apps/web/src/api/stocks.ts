import {
	API_PREFIX,
	type StockNewsResponse,
	type StockPricesResponse,
	type StockProfileResponse,
	stockNewsQuerySchema,
	stockNewsResponseSchema,
	stockPricesResponseSchema,
	stockProfileResponseSchema,
	watchlistStockIdSchema,
} from "@research/contracts";
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
 * The Stocks page's per-stock reads (ADR-0049 §4, §6, §7): one stock's
 * stored directory entry, stored price series and the stored articles that
 * mention it. Every read is our own `/api/v1/stocks/...`, answered from the
 * database (nothing here makes the runner fetch), and conditional: an
 * unchanged answer is a 304.
 */
export function createStockApi(http: HttpOptions) {
	const invalidRequest = { kind: "invalid-request", status: null } as const;

	/** The stock's path, checked against the contract before it is sent. */
	function stockPath(stockId: string): ApiResult<string> {
		const id = validate(watchlistStockIdSchema, stockId, invalidRequest);
		if (!id.ok) return id;
		return ok(`${API_PREFIX}/stocks/${encodeURIComponent(id.value)}`);
	}

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

	return {
		/** The stock's stored directory entry (names, listing) and its price series id. */
		getStockProfile: async (
			stockId: string,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<StockProfileResponse>>> => {
			const path = stockPath(stockId);
			if (!path.ok) return path;
			return conditionalGet(path.value, stockProfileResponseSchema, etag);
		},
		/** The stock's stored daily closes (null series when none is stored). */
		getStockPrices: async (
			stockId: string,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<StockPricesResponse>>> => {
			const path = stockPath(stockId);
			if (!path.ok) return path;
			return conditionalGet(`${path.value}/prices`, stockPricesResponseSchema, etag);
		},
		/** One page of stored articles that mention the stock; `cursor` from the previous page. */
		getStockNews: async (
			stockId: string,
			cursor: string | null,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<StockNewsResponse>>> => {
			const path = stockPath(stockId);
			if (!path.ok) return path;
			const query = validate(
				stockNewsQuerySchema,
				cursor === null ? {} : { cursor },
				invalidRequest,
			);
			if (!query.ok) return query;
			const suffix =
				query.value.cursor === undefined
					? ""
					: `?${new URLSearchParams({ cursor: query.value.cursor }).toString()}`;
			return conditionalGet(`${path.value}/news${suffix}`, stockNewsResponseSchema, etag);
		},
	};
}
