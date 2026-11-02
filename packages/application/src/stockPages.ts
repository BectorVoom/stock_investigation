import {
	MARKET_LIMITS,
	STOCK_LIMITS,
	type StockBusiness,
	type StockNewsArticle,
	type StockNewsResponse,
	type StockPricesResponse,
	type StockProfileResponse,
	type WatchMarket,
} from "@research/contracts";
import {
	articleMention,
	mentionLikePattern,
	ok,
	type StockMentionTerm,
	stockMentionTerms,
	stockPriceSeriesId,
} from "@research/domain";
import { decodeArticleCursor, encodeArticleCursor } from "./articleCursor.ts";
import type { EquitySyncService } from "./equitySync.ts";
import type { EquityCompanyBusiness, EquitySyncRepository } from "./equitySyncPorts.ts";
import { fail, type UseCaseResult } from "./errors.ts";
import { assembleMarketSeries, type MarketSeriesStamp, seriesStampsFor } from "./marketData.ts";
import type {
	ArticleKey,
	ArticleRepository,
	ArticleStamp,
	MarketRepository,
	StockDirectoryRepository,
	StoredMarketSeries,
	WatchlistRepository,
} from "./ports.ts";

/**
 * The Stocks page's per-stock reads (ADR-0049 §4, §6, §7), answered from
 * stored rows only: one directory entry with the company's business
 * description (ADR-0053 §5), one stored price series, and the stored
 * articles that mention the stock. Each read has a cheap digest the
 * API turns into an ETag BEFORE the expensive rows are read, so an unchanged
 * answer is a 304 that touched no observation or article row.
 */
export interface StockPageDeps {
	readonly stockDirectory: Pick<StockDirectoryRepository, "getEntry">;
	readonly market: Pick<MarketRepository, "getSeriesMeta" | "getObservations">;
	readonly articles: Pick<ArticleRepository, "stamp" | "listMentionCandidates">;
	readonly equitySync: Pick<EquitySyncRepository, "findByListing" | "businessByListing">;
	/** The company's view with its sync state, tracked or not (ADR-0058 §9.3). */
	readonly equityCompanies: Pick<EquitySyncService, "company">;
	readonly watchlist: Pick<WatchlistRepository, "getStock">;
}

/** A validated stock id with its parts. */
export interface StockRef {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
}

/** What the prices ETag covers: the series' Home-digest stamp (no observations). */
export interface StockPricesDigest {
	readonly stock: StockRef;
	readonly seriesId: string;
	readonly meta: StoredMarketSeries | null;
	readonly stamp: MarketSeriesStamp;
}

/** What the news ETag covers: the owner's article stamp, the terms and the cursor. */
export interface StockNewsDigest {
	readonly stock: StockRef;
	readonly terms: readonly StockMentionTerm[];
	/** The request's cursor as sent (null on the first page). */
	readonly cursor: string | null;
	/** The key the cursor names: candidates strictly older than it. */
	readonly before: ArticleKey | null;
	readonly articles: ArticleStamp;
}

/** One News page: the kept articles and where the next page starts (ADR-0049 §7). */
export interface MentionPage {
	readonly articles: readonly StockNewsArticle[];
	readonly nextCursor: string | null;
}

/**
 * Reads `newsCandidateBatch` candidates at a time until `newsPageSize`
 * mentions are kept, at most `newsMaxBatches` batches. The cursor never
 * skips an article: a page that fills mid-batch ends at its last kept
 * article; batches that run out end at the last scanned candidate; a short
 * batch means nothing older is left (null).
 */
export async function readMentionPage(
	readBatch: (before: ArticleKey | null, limit: number) => Promise<readonly StockNewsArticleRow[]>,
	terms: readonly StockMentionTerm[],
	start: ArticleKey | null,
	limits: Pick<
		typeof STOCK_LIMITS,
		"newsPageSize" | "newsCandidateBatch" | "newsMaxBatches"
	> = STOCK_LIMITS,
): Promise<MentionPage> {
	const kept: StockNewsArticle[] = [];
	let before = start;
	for (let batch = 0; batch < limits.newsMaxBatches; batch += 1) {
		const rows = await readBatch(before, limits.newsCandidateBatch);
		const short = rows.length < limits.newsCandidateBatch;
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			if (row === undefined) continue;
			const mentions = articleMention([row.title, row.excerpt], terms);
			if (mentions === null) continue;
			kept.push({ ...row, mentions: { text: mentions.text, kind: mentions.kind } });
			if (kept.length === limits.newsPageSize) {
				// The page's last row was also the last stored candidate: nothing is left.
				const exhausted = short && index === rows.length - 1;
				return { articles: kept, nextCursor: exhausted ? null : encodeArticleCursor(row) };
			}
		}
		const last = rows.at(-1);
		if (short || last === undefined) return { articles: kept, nextCursor: null };
		before = { retrievedAt: last.retrievedAt, articleId: last.articleId };
	}
	return { articles: kept, nextCursor: before === null ? null : encodeArticleCursor(before) };
}

/**
 * The Company tab's business status (ADR-0053 §5): a stored description is
 * shown whether or not the company is still tracked; without one, a
 * tracked company's arrives with its next sync.
 */
export function stockBusinessOf(found: EquityCompanyBusiness | null): StockBusiness {
	const description = found?.description ?? null;
	if (description !== null) {
		if (description.status === "not-found") {
			return { status: "not-found", source: description.source };
		}
		return {
			status: "extracted",
			source: description.source,
			paragraphs: description.paragraphs,
			truncated: description.truncated,
			fetchedAt: description.fetchedAt,
		};
	}
	return found?.company.tracked === true ? { status: "pending" } : { status: "not-tracked" };
}

/** The article fields the mention check and the page read (an `Article`). */
type StockNewsArticleRow = Omit<StockNewsArticle, "mentions">;

export function createStockPageService(deps: StockPageDeps) {
	/** Every stored name of the stock, in the term priority order of ADR-0049 §7. */
	async function termsOf(ownerId: string, stock: StockRef): Promise<StockMentionTerm[]> {
		const [entry, company, watched] = await Promise.all([
			deps.stockDirectory.getEntry(ownerId, stock.market, stock.symbol),
			deps.equitySync.findByListing(ownerId, stock.market, stock.symbol),
			deps.watchlist.getStock(ownerId, stock.stockId),
		]);
		return stockMentionTerms({
			market: stock.market,
			symbol: stock.symbol,
			names: [
				entry?.name ?? null,
				entry?.localName ?? null,
				company?.name ?? null,
				watched?.name ?? null,
			],
		});
	}

	return {
		/**
		 * `GET /stocks/:stockId`: the directory entry and the company with its
		 * description (two concurrent key reads), then the company's view when
		 * one is stored, tracked or not (ADR-0058 §9.3); the body is its own digest.
		 */
		async profile(ownerId: string, stock: StockRef): Promise<StockProfileResponse> {
			const [entry, business] = await Promise.all([
				deps.stockDirectory.getEntry(ownerId, stock.market, stock.symbol),
				deps.equitySync.businessByListing(ownerId, stock.market, stock.symbol),
			]);
			const company =
				business === null
					? null
					: await deps.equityCompanies.company(ownerId, business.company.companyId);
			return {
				stockId: stock.stockId,
				market: stock.market,
				symbol: stock.symbol,
				priceSeriesId: stockPriceSeriesId(stock.market, stock.symbol),
				directory:
					entry === null
						? null
						: { name: entry.name, localName: entry.localName, listing: entry.listing },
				business: stockBusinessOf(business),
				// Deleted between the two reads: as if never stored.
				company: company?.ok === true ? company.value.view : null,
			};
		},

		/** The prices digest: the series' metadata row only (the stamp the Home digest uses). */
		async pricesDigest(ownerId: string, stock: StockRef): Promise<StockPricesDigest> {
			const seriesId = stockPriceSeriesId(stock.market, stock.symbol);
			const metas = await deps.market.getSeriesMeta(ownerId, [seriesId]);
			const [stamp] = seriesStampsFor([seriesId], metas);
			if (stamp === undefined) throw new Error("seriesStampsFor dropped the requested series");
			return {
				stock,
				seriesId,
				meta: metas.find((meta) => meta.seriesId === seriesId) ?? null,
				stamp,
			};
		},

		/**
		 * The stored series with its newest observations, in the shape and
		 * order the Home data read returns (`assembleMarketSeries`); null when
		 * no row is stored (no observation is read then).
		 */
		async prices(ownerId: string, digest: StockPricesDigest): Promise<StockPricesResponse> {
			const base = { stockId: digest.stock.stockId, seriesId: digest.seriesId };
			if (digest.meta === null) return { ...base, series: null };
			const observations = await deps.market.getObservations(
				ownerId,
				[digest.seriesId],
				MARKET_LIMITS.maxObservationsPerResponse,
			);
			const [series] = assembleMarketSeries([digest.seriesId], [digest.meta], observations);
			return { ...base, series: series ?? null };
		},

		/**
		 * The news digest: the terms (three primary-key reads) and the owner's
		 * article stamp (one indexed statement); no article row. A cursor this
		 * service did not issue is VALIDATION_FAILED.
		 */
		async newsDigest(
			ownerId: string,
			stock: StockRef,
			cursor: string | null,
		): Promise<UseCaseResult<StockNewsDigest>> {
			const before = cursor === null ? null : decodeArticleCursor(cursor);
			if (cursor !== null && before === null) {
				return fail("VALIDATION_FAILED", "Query string failed validation.", "cursor");
			}
			const [terms, articles] = await Promise.all([
				termsOf(ownerId, stock),
				deps.articles.stamp(ownerId),
			]);
			return ok({ stock, terms, cursor, before, articles });
		},

		/** One News page; no terms means no article query at all. */
		async news(ownerId: string, digest: StockNewsDigest): Promise<StockNewsResponse> {
			const terms = digest.terms.map((term) => ({ text: term.text, kind: term.kind }));
			const base = { stockId: digest.stock.stockId, terms };
			if (terms.length === 0) return { ...base, articles: [], nextCursor: null };
			const patterns = terms.map(mentionLikePattern);
			const page = await readMentionPage(
				(before, limit) =>
					deps.articles.listMentionCandidates(ownerId, { patterns, before, limit }),
				terms,
				digest.before,
			);
			return { ...base, articles: [...page.articles], nextCursor: page.nextCursor };
		},
	};
}

export type StockPageService = ReturnType<typeof createStockPageService>;
