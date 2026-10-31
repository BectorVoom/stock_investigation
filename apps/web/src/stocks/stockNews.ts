import type { StockNewsArticle, StockNewsResponse } from "@research/contracts";
import { type Accessor, createMemo, createRoot, createSignal } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { createReadEntry, type ReadEntry } from "../lib/readCache.ts";
import { STOCK_RECHECK_MS } from "./stockReads.ts";

/**
 * The News tab's reads (ADR-0049 §7): one paged store per (API client,
 * stock).
 *
 * - The **first page** is a shared conditional read (`createReadEntry`):
 *   its ETag is kept, it re-checks every five minutes while shown (an
 *   unchanged answer is a 304) and its last answer stays for the visit, so
 *   returning to the stock shows it at once.
 * - **Show more** reads the page after the last one (`nextCursor`) and
 *   appends it. The appended pages are kept while the stock stays selected
 *   and dropped when its News panel goes (`dropMore`, called when the panel
 *   is disposed: another stock was chosen), so only first pages outlive a
 *   selection.
 * - A first page that **changed** (a new article mentions the stock)
 *   restarts the list from it: the appended pages continued the old first
 *   page, and keeping them could leave a gap between the two.
 * - Memory is bounded: at most `MAX_KEPT_STOCKS` stores per client — past
 *   the bound the least recently used store no view shows is dropped — and
 *   at most `MAX_MORE_PAGES` appended pages per store (Show more is then
 *   gone, with its reason).
 */

/** Stocks whose News first page one visit keeps (beyond the shown ones). */
const MAX_KEPT_STOCKS = 16;

/** Pages Show more appends at most to one stock's list (20 articles each). */
export const MAX_MORE_PAGES = 24;

export interface StockNewsStore {
	/** The first page's read (value, failure, loading, attach, refresh). */
	readonly first: ReadEntry<StockNewsResponse>;
	/** Every loaded article, first page then appended pages, without repeats. */
	readonly articles: Accessor<readonly StockNewsArticle[]>;
	/** The cursor Show more reads from; null when every stored article was looked at. */
	readonly nextCursor: Accessor<string | null>;
	/** True once `MAX_MORE_PAGES` pages were appended (Show more stops). */
	readonly moreLimitReached: Accessor<boolean>;
	readonly moreLoading: Accessor<boolean>;
	/** The last Show more failure; the loaded pages stay. Cleared by the next attempt. */
	readonly moreFailure: Accessor<ApiFailure | null>;
	/** Articles the last Show more added (null before the first one). */
	readonly lastAdded: Accessor<number | null>;
	/** Reads and appends the next page (ignored while one is on its way or none is left). */
	readonly loadMore: () => void;
	/** Drops the appended pages (the stock is no longer selected). */
	readonly dropMore: () => void;
	readonly attach: (visibility: VisibilitySource) => () => void;
}

interface MorePage {
	readonly articles: readonly StockNewsArticle[];
	readonly nextCursor: string | null;
}

/** The appended pages and the first page they continue. */
interface MoreState {
	readonly basis: StockNewsResponse;
	readonly pages: readonly MorePage[];
	readonly loading: boolean;
	readonly failure: ApiFailure | null;
	readonly lastAdded: number | null;
}

/** One store; its memos live in their own root, disposed when the cache drops the store. */
function createStockNewsStore(
	api: ApiClient,
	stockId: string,
): { readonly store: StockNewsStore; readonly dispose: () => void } {
	return createRoot((dispose) => {
		const first = createReadEntry((etag) => api.getStockNews(stockId, null, etag), {
			recheckMs: STOCK_RECHECK_MS,
		});
		const [state, setState] = createSignal<MoreState | null>(null);
		// Bumped whenever the appended pages are dropped, so a Show more
		// answer that arrives afterwards (for the old list) is discarded.
		let generation = 0;

		// The appended pages count only while the first page they continued
		// is still the current one: a changed first page restarts the list.
		const current = createMemo((): MoreState | null => {
			const more = state();
			const page = first.value();
			return more !== null && page !== undefined && more.basis === page ? more : null;
		});

		const articles = createMemo((): readonly StockNewsArticle[] => {
			const page = first.value();
			if (page === undefined) return [];
			const pages = current()?.pages ?? [];
			if (pages.length === 0) return page.articles;
			// A cursor marks the last scanned candidate, so pages never overlap;
			// the id check keeps the list right should a server ever repeat one.
			const seen = new Set<string>();
			const list: StockNewsArticle[] = [];
			for (const group of [page.articles, ...pages.map((entry) => entry.articles)]) {
				for (const article of group) {
					if (seen.has(article.articleId)) continue;
					seen.add(article.articleId);
					list.push(article);
				}
			}
			return list;
		});

		const nextCursor = createMemo((): string | null => {
			const pages = current()?.pages ?? [];
			const last = pages[pages.length - 1];
			if (last !== undefined) return last.nextCursor;
			return first.value()?.nextCursor ?? null;
		});

		const moreLoading = () => current()?.loading === true;
		const moreLimitReached = () => (current()?.pages.length ?? 0) >= MAX_MORE_PAGES;

		const loadMore = (): void => {
			const basis = first.value();
			const cursor = nextCursor();
			if (basis === undefined || cursor === null || moreLoading() || moreLimitReached()) return;
			const started = generation;
			const pages = current()?.pages ?? [];
			setState({ basis, pages, loading: true, failure: null, lastAdded: null });
			void api.getStockNews(stockId, cursor).then((answer) => {
				// Dropped, or the first page changed meanwhile: the answer continues an old list.
				if (started !== generation || first.value() !== basis) return;
				if (!answer.ok) {
					setState({ basis, pages, loading: false, failure: answer.error, lastAdded: null });
					return;
				}
				// An unconditional read always answers with a body; a 304 adds nothing.
				const page = answer.value.changed ? answer.value.value : null;
				setState({
					basis,
					pages:
						page === null
							? pages
							: [...pages, { articles: page.articles, nextCursor: page.nextCursor }],
					loading: false,
					failure: null,
					lastAdded: page?.articles.length ?? 0,
				});
			});
		};

		const store: StockNewsStore = {
			first,
			articles,
			nextCursor,
			moreLimitReached,
			moreLoading,
			moreFailure: () => current()?.failure ?? null,
			lastAdded: () => current()?.lastAdded ?? null,
			loadMore,
			dropMore: () => {
				generation += 1;
				setState(null);
			},
			attach: (visibility) => first.attach(visibility),
		};
		return { store, dispose };
	});
}

/**
 * The stores per client, at most `MAX_KEPT_STOCKS` each: past the bound the
 * least recently used store no view shows is disposed (a shown one never
 * is), and the stock's next showing builds and reads it again.
 */
const stores = new WeakMap<
	ApiClient,
	Map<string, { readonly store: StockNewsStore; readonly dispose: () => void }>
>();

/** The stock's News store (one per client and stock). */
export function stockNewsFor(api: ApiClient, stockId: string): StockNewsStore {
	let byStock = stores.get(api);
	if (byStock === undefined) {
		byStock = new Map();
		stores.set(api, byStock);
	}
	const existing = byStock.get(stockId);
	if (existing !== undefined) {
		// Re-insert: a Map iterates in insertion order, so the first is the least recent.
		byStock.delete(stockId);
		byStock.set(stockId, existing);
		return existing.store;
	}
	const created = createStockNewsStore(api, stockId);
	byStock.set(stockId, created);
	if (byStock.size > MAX_KEPT_STOCKS) {
		for (const [key, old] of byStock) {
			if (byStock.size <= MAX_KEPT_STOCKS) break;
			if (key === stockId || old.store.first.shown()) continue;
			old.dispose();
			byStock.delete(key);
		}
	}
	return created.store;
}
