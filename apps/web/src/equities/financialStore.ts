import type {
	EquityMetricSeriesResponse,
	EquityStatementKind,
	EquityStatementResponse,
} from "@research/contracts";
import type { EquityMetricCode } from "@research/domain";
import { type Accessor, createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure, ApiResult, Conditional } from "../api/http.ts";
import { createVisibleTicker, type VisibilitySource } from "../lib/polling.ts";

/**
 * How often a shown statement or chart re-checks its values while the page
 * is visible (ADR-0045 §8). A sync changes a company's values at most a few
 * times a day, and an unchanged answer is a 304, so this costs one tiny
 * request per shown read every five minutes — and none while hidden.
 */
export const FINANCIAL_RECHECK_MS = 5 * 60_000;

/** What one read of the equities API holds, as every widget showing it reads it. */
export interface FinancialEntry<T> {
	/** The last answer; undefined before the first one arrived. */
	readonly value: Accessor<T | undefined>;
	/** The last read's failure (not a missing company); cleared by the next success. */
	readonly failure: Accessor<ApiFailure | null>;
	/** True once the server said the company is not the owner's (404). */
	readonly missing: Accessor<boolean>;
	/** True while a read is on its way. */
	readonly loading: Accessor<boolean>;
	/**
	 * A view starts showing this read. The first one after none reads at once
	 * (with the ETag, so an unchanged answer is a 304) and starts the
	 * re-check; the last release stops it. Returns the release.
	 */
	readonly attach: (visibility: VisibilitySource) => () => void;
	/** Reads again now (Try again; after "Sync now"). */
	readonly refresh: () => void;
}

/** The answer for a company that is not the owner's (or no longer exists): 404. */
export function isMissingCompany(failure: ApiFailure): boolean {
	const code: string = failure.code;
	return failure.status === 404 && (code === "EQUITY_COMPANY_NOT_FOUND" || code === "NOT_FOUND");
}

type Reader<T> = (etag: string | null) => Promise<ApiResult<Conditional<T>>>;

function createEntry<T>(read: Reader<T>): FinancialEntry<T> {
	const [value, setValue] = createSignal<T | undefined>(undefined);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const [missing, setMissing] = createSignal(false);
	const [loading, setLoading] = createSignal(false);
	let etag: string | null = null;
	let users = 0;
	let inFlight = false;
	let again = false;
	let ticker: { readonly stop: () => void } | null = null;

	const load = async (): Promise<void> => {
		// One read at a time; a request while one runs reads once more after it.
		if (inFlight) {
			again = true;
			return;
		}
		inFlight = true;
		setLoading(true);
		const answer = await read(etag);
		inFlight = false;
		setLoading(false);
		if (answer.ok) {
			setFailure(null);
			setMissing(false);
			if (answer.value.changed) {
				etag = answer.value.etag;
				const next = answer.value.value;
				setValue(() => next);
			}
		} else if (isMissingCompany(answer.error)) {
			etag = null;
			setFailure(null);
			setMissing(true);
		} else {
			setFailure(answer.error);
		}
		if (again) {
			again = false;
			void load();
		}
	};

	return {
		value,
		failure,
		missing,
		loading,
		attach: (visibility) => {
			users += 1;
			if (users === 1) {
				void load();
				const started = createVisibleTicker({
					visibility,
					intervalMs: FINANCIAL_RECHECK_MS,
					tick: () => void load(),
				});
				started.start();
				ticker = started;
			}
			let released = false;
			return () => {
				if (released) return;
				released = true;
				users -= 1;
				if (users === 0) {
					ticker?.stop();
					ticker = null;
				}
			};
		},
		refresh: () => void load(),
	};
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
		/** Every entry of one company, for a re-read after its sync. */
		ofCompany: (api: ApiClient, companyId: string): readonly FinancialEntry<T>[] => {
			const cache = caches.get(api);
			if (cache === undefined) return [];
			const prefix = `${companyId}|`;
			return [...cache].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => entry);
		},
	};
}

const statements = createCache<EquityStatementResponse>();
const metrics = createCache<EquityMetricSeriesResponse>();

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

/** Re-reads every read of one company now (the page's "Sync now" finished; a value may have changed). */
export function refreshCompanyReads(api: ApiClient, companyId: string): void {
	for (const entry of statements.ofCompany(api, companyId)) entry.refresh();
	for (const entry of metrics.ofCompany(api, companyId)) entry.refresh();
}
