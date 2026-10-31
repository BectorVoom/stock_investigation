import {
	API_PREFIX,
	type EquityFactQuery,
	equityCursorQuerySchema,
	equityFactQuerySchema,
	equityFactsResponseSchema,
	equityImportHistorySchema,
	equityImportPageQuerySchema,
	equityImportResultSchema,
	equityImportSchema,
	equityIssuerListSchema,
	equityPageQuerySchema,
	equityRecordsResponseSchema,
	idempotencyKeySchema,
} from "@research/contracts";
import { type HttpOptions, jsonBody, request, validate } from "./http.ts";

export function createEquityApi(http: HttpOptions) {
	const base = `${API_PREFIX}/equities`;
	const path = (endpoint: string, query: object): string => {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query))
			if (value !== undefined) params.set(key, String(value));
		return `${base}${endpoint}?${params}`;
	};
	return {
		async listEquityIssuers(
			query: { readonly q?: string; readonly after?: string; readonly limit?: number } = {},
		) {
			const parsed = validate(equityPageQuerySchema, query, {
				kind: "invalid-request",
				status: null,
			});
			return parsed.ok
				? request(
						http,
						{ method: "GET", path: path("/issuers", parsed.value) },
						jsonBody(equityIssuerListSchema),
					)
				: parsed;
		},
		async getEquityFacts(issuerId: string, query: Partial<EquityFactQuery> = {}) {
			const parsed = validate(equityFactQuerySchema, query, {
				kind: "invalid-request",
				status: null,
			});
			return parsed.ok
				? request(
						http,
						{
							method: "GET",
							path: path(`/issuers/${encodeURIComponent(issuerId)}/facts`, parsed.value),
						},
						jsonBody(equityFactsResponseSchema),
					)
				: parsed;
		},
		async getEquityIssuerRecords(
			issuerId: string,
			query: { readonly after?: string; readonly limit?: number } = {},
		) {
			const parsed = validate(equityCursorQuerySchema, query, {
				kind: "invalid-request",
				status: null,
			});
			return parsed.ok
				? request(
						http,
						{
							method: "GET",
							path: path(`/issuers/${encodeURIComponent(issuerId)}/records`, parsed.value),
						},
						jsonBody(equityRecordsResponseSchema),
					)
				: parsed;
		},
		async importEquities(payload: unknown, idempotencyKey: string) {
			const parsed = validate(equityImportSchema, payload, {
				kind: "invalid-request",
				status: null,
			});
			if (!parsed.ok) return parsed;
			const key = validate(idempotencyKeySchema, idempotencyKey, {
				kind: "invalid-request",
				status: null,
			});
			if (!key.ok) return key;
			return request(
				http,
				{ method: "POST", path: `${base}/imports`, body: parsed.value, idempotencyKey: key.value },
				jsonBody(equityImportResultSchema),
			);
		},
		async listEquityImports(query: { readonly after?: string; readonly limit?: number } = {}) {
			const parsed = validate(equityImportPageQuerySchema, query, {
				kind: "invalid-request",
				status: null,
			});
			return parsed.ok
				? request(
						http,
						{ method: "GET", path: path("/imports", parsed.value) },
						jsonBody(equityImportHistorySchema),
					)
				: parsed;
		},
		getEquityImport: (importId: string) =>
			request(
				http,
				{ method: "GET", path: `${base}/imports/${encodeURIComponent(importId)}` },
				jsonBody(equityImportSchema),
			),
	};
}
