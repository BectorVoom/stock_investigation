import type {
	EquityFilingsResponse,
	EquityMetricSeriesResponse,
	EquityStatementKind,
	EquityStatementResponse,
} from "@research/contracts";
import type { EquityMetricCode } from "@research/domain";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { type ConditionalReader, createReadEntry, type ReadEntry } from "../lib/readCache.ts";

/**
 * How often a shown statement or chart re-checks its values while the page
 * is visible (ADR-0048 §8). A sync changes a company's values at most a few
 * times a day, and an unchanged answer is a 304, so this costs one tiny
 * request per shown read every five minutes — and none while hidden.
 */
export const FINANCIAL_RECHECK_MS = 5 * 60_000;

/**
 * A read answered this recently is shown again without a request when a
 * view starts showing it (the Stocks page's tab switched back to, ADR-0049 §3).
 */
export const FINANCIAL_FRESH_MS = 60_000;

/** What one read of the equities API holds, as every widget showing it reads it (see `ReadEntry`). */
export type FinancialEntry<T> = ReadEntry<T>;

/**
 * The answer for a company that is not the owner's (or no longer exists):
 * the equities API's own 404 code. Only that code says "remove this
 * widget"; any other 404 (a missing route behind an old SPA or a proxy) is
 * an ordinary failure with Try again, never a reason to tell the owner the
 * company is gone.
 */
export function isMissingCompany(failure: ApiFailure): boolean {
	return failure.status === 404 && failure.code === "EQUITY_COMPANY_NOT_FOUND";
}

function createEntry<T>(read: ConditionalReader<T>): FinancialEntry<T> {
	return createReadEntry(read, {
		recheckMs: FINANCIAL_RECHECK_MS,
		freshMs: FINANCIAL_FRESH_MS,
		isMissing: isMissingCompany,
	});
}

/**
 * One entry per (client, read): every widget and the Equities page showing
 * the same statement of the same company over the same years share one read
 * and one ETag, like the Task result widgets share a task's answer. Bounded
 * by what the owner places (companies × statements or metrics × year
 * choices), each entry a few kilobytes.
 */
function createCache<T>() {
	const caches = new WeakMap<ApiClient, Map<string, FinancialEntry<T>>>();
	return {
		entry: (api: ApiClient, key: string, make: () => FinancialEntry<T>): FinancialEntry<T> => {
			let cache = caches.get(api);
			if (cache === undefined) {
				cache = new Map();
				caches.set(api, cache);
			}
			const existing = cache.get(key);
			if (existing !== undefined) return existing;
			const created = make();
			cache.set(key, created);
			return created;
		},
		/** Every kept entry of one company (shown or not). */
		ofCompany: (api: ApiClient, companyId: string): readonly FinancialEntry<T>[] => {
			const cache = caches.get(api);
			if (cache === undefined) return [];
			const prefix = `${companyId}|`;
			const found: FinancialEntry<T>[] = [];
			for (const [key, entry] of cache) {
				if (key.startsWith(prefix)) found.push(entry);
			}
			return found;
		},
	};
}

const statements = createCache<EquityStatementResponse>();
const metrics = createCache<EquityMetricSeriesResponse>();
const filings = createCache<EquityFilingsResponse>();

export function statementEntryFor(
	api: ApiClient,
	companyId: string,
	statement: EquityStatementKind,
	years: number,
): FinancialEntry<EquityStatementResponse> {
	return statements.entry(api, `${companyId}|${statement}|${years}`, () =>
		createEntry((etag) => api.getEquityStatement(companyId, statement, years, etag)),
	);
}

export function metricEntryFor(
	api: ApiClient,
	companyId: string,
	metric: EquityMetricCode,
	years: number,
): FinancialEntry<EquityMetricSeriesResponse> {
	return metrics.entry(api, `${companyId}|${metric}|${years}`, () =>
		createEntry((etag) => api.getEquityMetricSeries(companyId, metric, years, etag)),
	);
}

/** Every stored filing of one company (the Equities page's filings list), shared like the others. */
export function filingsEntryFor(
	api: ApiClient,
	companyId: string,
): FinancialEntry<EquityFilingsResponse> {
	return filings.entry(api, `${companyId}|filings`, () =>
		createEntry((etag) => api.getEquityFilings(companyId, etag)),
	);
}

/**
 * A company's sync finished (a value may have changed): its shown reads
 * re-read now; the others are marked stale, so the view that shows one
 * next re-checks it at once — a past statement or year choice costs no
 * request per sync, and the freshness window never hides a finished sync.
 */
export function refreshCompanyReads(api: ApiClient, companyId: string): void {
	const entries = [
		...statements.ofCompany(api, companyId),
		...metrics.ofCompany(api, companyId),
		...filings.ofCompany(api, companyId),
	];
	for (const entry of entries) {
		if (entry.shown()) entry.refresh();
		else entry.invalidate();
	}
}
