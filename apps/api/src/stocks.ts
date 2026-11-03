import type { StockNewsDigest, StockPricesDigest, StockRef } from "@research/application";
import {
	parseStockId,
	stockNewsQuerySchema,
	stockNewsResponseSchema,
	stockPricesResponseSchema,
	stockProfileResponseSchema,
	themeSearchQuerySchema,
	themeSearchResponseSchema,
	watchlistStockIdSchema,
} from "@research/contracts";
import { attempt, type EventLogger } from "@research/effects";
import { Effect } from "effect";
import type { Hono } from "hono";
import {
	type AppContext,
	type AppEnv,
	conditionalJson,
	fingerprint,
	HttpFailure,
	readQuery,
	respond,
	useCase,
} from "./http.ts";

/**
 * The Stocks page's per-stock reads (ADR-0049 §4, §6, §7): one stock's
 * stored directory entry, its stored price series and the stored articles
 * that mention it. Nothing here makes the runner fetch anything. Each read
 * answers a 304 from a cheap digest before its expensive rows are read.
 * Owner authentication is inherited from the API router.
 */
export function registerStockRoutes(api: Hono<AppEnv>, logger: EventLogger): void {
	const owner = (c: AppContext) => c.var.owner.ownerId;

	/**
	 * The path's stock id (`us:AAPL`, `jp:7974`). A path that is not one names
	 * no resource: NOT_FOUND, as the watchlist's stock routes answer it.
	 */
	const stockOf = (c: AppContext): Effect.Effect<StockRef, HttpFailure> => {
		const parsed = watchlistStockIdSchema.safeParse(c.req.param("stockId"));
		const parts = parsed.success ? parseStockId(parsed.data) : null;
		if (!parsed.success || parts === null) {
			return Effect.fail(
				new HttpFailure({
					error: {
						code: "NOT_FOUND",
						message: "Resource not found.",
					},
				}),
			);
		}
		return Effect.succeed({ stockId: parsed.data, ...parts });
	};

	/** 304 before the rows are read when the client holds this version. */
	const notModified = (c: AppContext, version: string): Response | null => {
		const etag = `"${version}"`;
		if (c.req.header("If-None-Match") !== etag) return null;
		c.header("ETag", etag);
		c.header("Cache-Control", "private, no-cache");
		return c.body(null, 304);
	};

	/** The series' Home-digest stamp (ASCII ids and ISO times only). */
	const pricesVersion = (digest: StockPricesDigest): string => {
		const { stamp } = digest;
		return `stock.prices.${digest.stock.stockId}.${stamp.lastRefreshedAt ?? "never"}.${stamp.retrievedAt ?? "never"}.${stamp.unavailableCode ?? "ok"}.${stamp.unavailableUpstreamStatus ?? "-"}`;
	};

	/**
	 * The owner's article stamp, then the terms and cursor as a fingerprint
	 * (a term may be Japanese, and a header value must stay ASCII).
	 */
	const newsVersion = (digest: StockNewsDigest): string => {
		const newest = digest.articles.newest;
		const searched = fingerprint(JSON.stringify([digest.terms, digest.cursor]));
		return `stock.news.${digest.stock.stockId}.${digest.articles.articleCount}.${newest?.retrievedAt ?? "none"}.${newest?.articleId ?? "none"}.${searched}`;
	};

	/**
	 * The theme search (ADR-0066): the owner's stocks whose shown themes
	 * contain `q`. "theme-search" is never a stock id (`us:AAPL`), so it
	 * cannot shadow a stock; it is registered first all the same.
	 */
	api.get("/stocks/theme-search", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const query = yield* readQuery(c, themeSearchQuerySchema);
				const result = yield* attempt("stocks.theme_search", () =>
					c.var.services.stockPages.themeSearch(owner(c), query.q),
				);
				const parsed = themeSearchResponseSchema.parse(result);
				return conditionalJson(c, `stock.themes.${fingerprint(JSON.stringify(parsed))}`, parsed);
			}),
		),
	);

	api.get("/stocks/:stockId", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const stock = yield* stockOf(c);
				// Two key reads: the body is its own digest.
				const profile = yield* attempt("stocks.profile", () =>
					c.var.services.stockPages.profile(owner(c), stock),
				);
				const parsed = stockProfileResponseSchema.parse(profile);
				return conditionalJson(
					c,
					`stock.profile.${stock.stockId}.${fingerprint(JSON.stringify(parsed))}`,
					parsed,
				);
			}),
		),
	);

	api.get("/stocks/:stockId/prices", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const stock = yield* stockOf(c);
				const digest = yield* attempt("stocks.prices_digest", () =>
					c.var.services.stockPages.pricesDigest(owner(c), stock),
				);
				const version = pricesVersion(digest);
				const unchanged = notModified(c, version);
				if (unchanged !== null) return unchanged;
				const prices = yield* attempt("stocks.prices", () =>
					c.var.services.stockPages.prices(owner(c), digest),
				);
				return conditionalJson(c, version, stockPricesResponseSchema.parse(prices));
			}),
		),
	);

	api.get("/stocks/:stockId/news", (c) =>
		respond(
			c,
			logger,
			Effect.gen(function* () {
				const stock = yield* stockOf(c);
				const query = yield* readQuery(c, stockNewsQuerySchema);
				const digest = yield* useCase("stocks.news_digest", () =>
					c.var.services.stockPages.newsDigest(owner(c), stock, query.cursor ?? null),
				);
				const version = newsVersion(digest);
				const unchanged = notModified(c, version);
				if (unchanged !== null) return unchanged;
				const news = yield* attempt("stocks.news", () =>
					c.var.services.stockPages.news(owner(c), digest),
				);
				return conditionalJson(c, version, stockNewsResponseSchema.parse(news));
			}),
		),
	);
}
