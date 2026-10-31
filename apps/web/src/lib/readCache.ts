import { type Accessor, createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure, ApiResult, Conditional } from "../api/http.ts";
import { createVisibleTicker, type VisibilitySource } from "./polling.ts";

/**
 * A conditional read shared by every view that shows it (ADR-0049 §3): one
 * request in flight, the ETag kept (an unchanged answer is a 304), the last
 * answer kept for the visit so a view that comes back shows it at once, and
 * a re-check only while some view shows it and the page is visible. The
 * pattern of `financialStore` (ADR-0048 §8), made generic.
 */
export interface ReadEntry<T> {
	/** The last answer; undefined before the first one arrived. */
	readonly value: Accessor<T | undefined>;
	/** The last read's failure (not a "missing" answer); cleared by the next success. */
	readonly failure: Accessor<ApiFailure | null>;
	/** True once the read answered with the cache's "missing" failure. */
	readonly missing: Accessor<boolean>;
	/** True while a read is on its way. */
	readonly loading: Accessor<boolean>;
	/**
	 * A view starts showing this read. The first one after none reads at once
	 * (conditionally) and starts the re-check; the last release stops it.
	 * Returns the release (idempotent).
	 */
	readonly attach: (visibility: VisibilitySource) => () => void;
	/** Reads again now (Try again). */
	readonly refresh: () => void;
	/** True while at least one view shows this read. */
	readonly shown: () => boolean;
}

export type ConditionalReader<T> = (etag: string | null) => Promise<ApiResult<Conditional<T>>>;

export interface ReadEntryOptions {
	/** How often a shown read re-checks while the page is visible. */
	readonly recheckMs: number;
	/** The failure that means "this thing is gone" (shown as such, never retried by a button). */
	readonly isMissing?: (failure: ApiFailure) => boolean;
}

export function createReadEntry<T>(
	read: ConditionalReader<T>,
	options: ReadEntryOptions,
): ReadEntry<T> {
	const isMissing = options.isMissing ?? (() => false);
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
		} else if (isMissing(answer.error)) {
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
					intervalMs: options.recheckMs,
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
		shown: () => users > 0,
	};
}

/**
 * Entries per (API client, key), at most `maxEntries` per client: past the
 * bound the least recently used entry no view shows is dropped (a shown one
 * never is), so browsing many stocks in one visit keeps memory bounded.
 */
export function createReadCache<T>(maxEntries: number) {
	const caches = new WeakMap<ApiClient, Map<string, ReadEntry<T>>>();
	return {
		entry: (api: ApiClient, key: string, make: () => ReadEntry<T>): ReadEntry<T> => {
			let cache = caches.get(api);
			if (cache === undefined) {
				cache = new Map();
				caches.set(api, cache);
			}
			const existing = cache.get(key);
			if (existing !== undefined) {
				// Re-insert: a Map iterates in insertion order, so the first is the least recent.
				cache.delete(key);
				cache.set(key, existing);
				return existing;
			}
			const created = make();
			cache.set(key, created);
			if (cache.size > maxEntries) {
				for (const [oldKey, old] of cache) {
					if (cache.size <= maxEntries) break;
					if (!old.shown() && oldKey !== key) cache.delete(oldKey);
				}
			}
			return created;
		},
	};
}
