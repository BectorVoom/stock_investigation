import { env } from "cloudflare:test";
import {
	MARKET_LIMITS,
	STOCK_LIMITS,
	stockNewsResponseSchema,
	stockPricesResponseSchema,
	stockProfileResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	body,
	createHarness,
	errorCode,
	type Harness,
	trackCompany,
	untrackCompany,
} from "./helpers.ts";

/**
 * The Stocks page's per-stock reads (ADR-0049 §4, §6, §7) on a real local
 * D1 (and on `node:sqlite` through the api-sqlite project): 200 with the
 * stored rows, 304 from the digest, 404 for a path that is not a stock id,
 * 400 for an invalid cursor, null
 * directory / series when nothing is stored, the business description's four
 * statuses (ADR-0053 §5), and News pagination that never skips or repeats
 * an article.
 */

/* ---------- seeding (stored rows, as the runner's completions leave them) ---------- */

async function seedDirectory(
	harness: Harness,
	row: { market: "US" | "JP"; symbol: string; name: string; localName?: string; listing: string },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
			symbol_key, name_key, local_name_key, search_key)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
	)
		.bind(
			harness.ownerId,
			row.market,
			row.symbol,
			row.name,
			row.localName ?? null,
			row.listing,
			row.symbol.toLowerCase(),
			row.name.toLowerCase(),
			`${row.symbol} ${row.name}`.toLowerCase(),
		)
		.run();
}

async function seedSeries(
	harness: Harness,
	seriesId: string,
	symbol: string,
	observationCount: number,
): Promise<void> {
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
				publisher, source_url, last_refreshed_at, retrieved_at)
			VALUES (?, ?, 'twelve-data', ?, ?, 'USD', 'daily', 'Twelve Data', 'https://twelvedata.com/',
				'2026-10-30T00:00:00.000Z', '2026-10-30T00:00:00.000Z')`,
		).bind(harness.ownerId, seriesId, symbol, symbol),
		// Consecutive days from 2024-01-01; value = 100 + day number.
		env.DB.prepare(
			`WITH RECURSIVE day(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM day WHERE n + 1 < ?3)
			INSERT INTO market_observations (owner_id, series_id, observed_on, value)
			SELECT ?1, ?2, date('2024-01-01', '+' || day.n || ' days'), 100 + day.n FROM day`,
		).bind(harness.ownerId, seriesId, observationCount),
	]);
}

interface SeedArticle {
	readonly articleId: string;
	readonly title: string;
	readonly excerpt?: string;
	readonly retrievedAt: string;
}

let fingerprintCounter = 0;

async function seedArticles(harness: Harness, rows: readonly SeedArticle[]): Promise<void> {
	const stored = rows.map((row) => {
		fingerprintCounter += 1;
		return {
			...row,
			excerpt: row.excerpt ?? null,
			fingerprint: `${fingerprintCounter.toString(16).padStart(24, "0")}${crypto.randomUUID().replaceAll("-", "").padEnd(40, "0")}`,
		};
	});
	await env.DB.prepare(
		`INSERT INTO articles (owner_id, article_id, source_id, canonical_url, publisher, title,
			published_at, retrieved_at, content_fingerprint, excerpt)
		SELECT ?, json_extract(value, '$.articleId'), 'src_feed',
			'https://news.example.org/' || json_extract(value, '$.articleId'), 'Example News',
			json_extract(value, '$.title'), NULL, json_extract(value, '$.retrievedAt'),
			json_extract(value, '$.fingerprint'), json_extract(value, '$.excerpt')
		FROM json_each(?)`,
	)
		.bind(harness.ownerId, JSON.stringify(stored))
		.run();
}

/** A stored business description, as a `financial-synced` completion leaves it (ADR-0053). */
async function seedDescription(
	harness: Harness,
	companyId: string,
	row: { status: "extracted" | "not-found"; paragraphsJson: string; truncated?: boolean },
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form,
			filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
		VALUES (?, ?, '0000320193-25-000079', '10-K', '2025-10-31', '2025-09-27',
			'https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm',
			?, ?, ?, '2026-11-01T00:00:00.000Z')`,
	)
		.bind(
			harness.ownerId,
			companyId,
			row.status,
			row.paragraphsJson,
			row.truncated === true ? 1 : 0,
		)
		.run();
}

const DESCRIPTION_SOURCE = {
	sourceDocumentId: "0000320193-25-000079",
	form: "10-K",
	filedOn: "2025-10-31",
	periodEnd: "2025-09-27",
	sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
};

/** Article `index` of a newest-first sequence (a larger index is older). */
function at(index: number): string {
	return new Date(Date.UTC(2026, 9, 30) - index * 60_000).toISOString();
}

const articleId = (index: number) => `art_${index.toString().padStart(5, "0")}`;

async function get(harness: Harness, path: string, etag?: string | null) {
	return harness.call("GET", path, undefined, etag ? { "If-None-Match": etag } : {});
}

/* ---------- GET /stocks/:stockId ---------- */

describe("GET /stocks/:stockId", () => {
	it("answers the stored directory entry, 304 while it is unchanged, a new ETag when it changes", async () => {
		const harness = createHarness();
		await seedDirectory(harness, {
			market: "JP",
			symbol: "7974",
			name: "NINTENDO CO., LTD.",
			localName: "任天堂株式会社",
			listing: "tse-prime",
		});
		const first = await get(harness, "/stocks/jp%3A7974");
		expect(first.status).toBe(200);
		const etag = first.headers.get("ETag");
		expect(etag).toMatch(/^"stock\.profile\.jp:7974\./);
		expect(await body(first, stockProfileResponseSchema)).toEqual({
			stockId: "jp:7974",
			market: "JP",
			symbol: "7974",
			priceSeriesId: "twelve-data:7974:JPX",
			directory: { name: "NINTENDO CO., LTD.", localName: "任天堂株式会社", listing: "tse-prime" },
			business: { status: "not-tracked" },
		});

		const again = await get(harness, "/stocks/jp:7974", etag);
		expect(again.status).toBe(304);
		expect(again.headers.get("ETag")).toBe(etag);

		await env.DB.prepare(
			"UPDATE stock_directory SET listing = 'tse-standard' WHERE owner_id = ? AND symbol = '7974'",
		)
			.bind(harness.ownerId)
			.run();
		const changed = await get(harness, "/stocks/jp:7974", etag);
		expect(changed.status).toBe(200);
		expect(changed.headers.get("ETag")).not.toBe(etag);
		expect((await body(changed, stockProfileResponseSchema)).directory?.listing).toBe(
			"tse-standard",
		);
	});

	it("answers a null directory when the stored list does not hold the stock", async () => {
		const harness = createHarness();
		// Another owner's row is not this owner's directory.
		const other = createHarness();
		await seedDirectory(other, {
			market: "US",
			symbol: "AAPL",
			name: "Apple Inc.",
			listing: "nasdaq",
		});
		const response = await get(harness, "/stocks/us:AAPL");
		expect(response.status).toBe(200);
		expect(await body(response, stockProfileResponseSchema)).toEqual({
			stockId: "us:AAPL",
			market: "US",
			symbol: "AAPL",
			priceSeriesId: "twelve-data:AAPL",
			directory: null,
			business: { status: "not-tracked" },
		});
	});

	it("answers the business description's status from the stored rows (ADR-0053 §5)", async () => {
		const harness = createHarness();
		const business = async (etag?: string | null) => {
			const response = await get(harness, "/stocks/us:AAPL", etag);
			expect(response.status).toBe(200);
			return {
				etag: response.headers.get("ETag"),
				business: (await body(response, stockProfileResponseSchema)).business,
			};
		};
		expect((await business()).business).toEqual({ status: "not-tracked" });

		const companyId = await trackCompany(harness, "us:AAPL");
		const pending = await business();
		expect(pending.business).toEqual({ status: "pending" });

		const paragraphs = [
			{ kind: "heading", text: "Company Background" },
			{ kind: "text", text: "The Company designs, manufactures and markets smartphones." },
		];
		await seedDescription(harness, companyId, {
			status: "extracted",
			paragraphsJson: JSON.stringify(paragraphs),
			truncated: true,
		});
		// The body is its own digest: a stored description is a new version.
		const extracted = await business(pending.etag);
		expect(extracted.etag).not.toBe(pending.etag);
		expect(extracted.business).toEqual({
			status: "extracted",
			source: DESCRIPTION_SOURCE,
			paragraphs,
			truncated: true,
			fetchedAt: "2026-11-01T00:00:00.000Z",
		});

		// Untracking keeps the description shown.
		await untrackCompany(harness, companyId);
		expect((await business()).business).toEqual(extracted.business);
	});

	it("names the report read when it had no business section", async () => {
		const harness = createHarness();
		const companyId = await trackCompany(harness, "us:AAPL");
		await seedDescription(harness, companyId, { status: "not-found", paragraphsJson: "[]" });
		const response = await get(harness, "/stocks/us:AAPL");
		expect((await body(response, stockProfileResponseSchema)).business).toEqual({
			status: "not-found",
			source: DESCRIPTION_SOURCE,
		});
	});

	it("answers INTERNAL for stored paragraphs that fail the contract", async () => {
		const harness = createHarness();
		const companyId = await trackCompany(harness, "us:AAPL");
		await seedDescription(harness, companyId, {
			status: "extracted",
			paragraphsJson: JSON.stringify([{ kind: "caption", text: "x" }]),
		});
		const response = await get(harness, "/stocks/us:AAPL");
		expect(response.status).toBe(500);
		expect(await errorCode(response)).toBe("INTERNAL");
	});

	it("answers NOT_FOUND for a path that is not a stock id, on every read", async () => {
		const harness = createHarness();
		for (const path of ["/stocks/AAPL", "/stocks/xx:AAPL", "/stocks/jp:ABC", "/stocks/us:aapl"]) {
			for (const read of ["", "/prices", "/news"]) {
				const response = await get(harness, `${path}${read}`);
				expect(response.status, `${path}${read}`).toBe(404);
				expect(await errorCode(response)).toBe("NOT_FOUND");
			}
		}
	});
});

/* ---------- GET /stocks/:stockId/prices ---------- */

describe("GET /stocks/:stockId/prices", () => {
	it("answers a null series when none is stored, and 304 for it", async () => {
		const harness = createHarness();
		const response = await get(harness, "/stocks/us:MSFT/prices");
		expect(response.status).toBe(200);
		expect(await body(response, stockPricesResponseSchema)).toEqual({
			stockId: "us:MSFT",
			seriesId: "twelve-data:MSFT",
			series: null,
		});
		const again = await get(harness, "/stocks/us:MSFT/prices", response.headers.get("ETag"));
		expect(again.status).toBe(304);
	});

	it("answers the stored series' newest observations ascending, as the Home data read does", async () => {
		const harness = createHarness();
		const count = MARKET_LIMITS.maxObservationsPerResponse + 25;
		await seedSeries(harness, "twelve-data:7974:JPX", "7974:JPX", count);
		const response = await get(harness, "/stocks/jp:7974/prices");
		expect(response.status).toBe(200);
		const prices = await body(response, stockPricesResponseSchema);
		expect(prices.seriesId).toBe("twelve-data:7974:JPX");
		const observations = prices.series?.observations ?? [];
		expect(observations).toHaveLength(MARKET_LIMITS.maxObservationsPerResponse);
		expect(observations.at(-1)?.[1]).toBe(100 + count - 1);
		expect(observations[0]?.[1]).toBe(100 + count - MARKET_LIMITS.maxObservationsPerResponse);
		expect(prices.series?.unavailable).toBeNull();

		const etag = response.headers.get("ETag");
		expect((await get(harness, "/stocks/jp:7974/prices", etag)).status).toBe(304);
		// A completion moves the series' stamp: the next read is a full answer.
		await env.DB.prepare(
			"UPDATE market_series SET last_refreshed_at = '2026-10-31T00:00:00.000Z' WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.run();
		const refreshed = await get(harness, "/stocks/jp:7974/prices", etag);
		expect(refreshed.status).toBe(200);
		expect(refreshed.headers.get("ETag")).not.toBe(etag);
	});
});

/* ---------- GET /stocks/:stockId/news ---------- */

async function allPages(harness: Harness, stockId: string) {
	const pages = [];
	let cursor: string | null = null;
	for (let page = 0; page < 20; page += 1) {
		const query: string = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
		const response = await get(harness, `/stocks/${stockId}/news${query}`);
		expect(response.status).toBe(200);
		const parsed = await body(response, stockNewsResponseSchema);
		pages.push(parsed);
		cursor = parsed.nextCursor;
		if (cursor === null) return pages;
	}
	throw new Error("the news pages never ended");
}

describe("GET /stocks/:stockId/news", () => {
	it("pages through every stored mention newest first, skipping none and repeating none", async () => {
		const harness = createHarness();
		await seedDirectory(harness, {
			market: "US",
			symbol: "AAPL",
			name: "Apple Inc.",
			listing: "nasdaq",
		});
		// Every third article mentions Apple; every third is a LIKE candidate
		// that is no mention ("Pineapple"); the rest are not candidates.
		const rows: SeedArticle[] = Array.from({ length: 150 }, (_, index) => ({
			articleId: articleId(index),
			title:
				index % 3 === 0
					? `Apple story ${index}`
					: index % 3 === 1
						? `Pineapple harvest ${index}`
						: `Oil prices ${index}`,
			retrievedAt: at(index),
		}));
		// One mention in the excerpt only, and one by the symbol.
		rows.push({
			articleId: articleId(150),
			title: "Results",
			excerpt: "Apple beat",
			retrievedAt: at(150),
		});
		rows.push({ articleId: articleId(151), title: "AAPL rallies", retrievedAt: at(151) });
		await seedArticles(harness, rows);

		const pages = await allPages(harness, "us:AAPL");
		expect(pages[0]?.terms).toEqual([
			{ text: "Apple", kind: "name" },
			{ text: "AAPL", kind: "symbol" },
		]);
		expect(pages[0]?.articles).toHaveLength(STOCK_LIMITS.newsPageSize);
		const seen = pages.flatMap((page) => page.articles.map((row) => row.articleId));
		const expected = rows
			.filter((_, index) => index % 3 === 0 || index >= 150)
			.map((row) => row.articleId);
		expect(seen).toEqual(expected);
		expect(pages.at(-1)?.articles.at(-1)?.mentions).toEqual({ text: "AAPL", kind: "symbol" });
	});

	it("finds a mention of a long Japanese name (its LIKE pattern is cut to D1's 50-byte limit)", async () => {
		const harness = createHarness();
		await seedDirectory(harness, {
			market: "JP",
			symbol: "7532",
			name: "Pan Pacific International Holdings Corporation",
			localName: "パン・パシフィック・インターナショナルホールディングス株式会社",
			listing: "tse-prime",
		});
		await seedArticles(harness, [
			{
				articleId: articleId(0),
				title: "パン・パシフィック・インターナショナルホールディングスが新店",
				retrievedAt: at(0),
			},
			// Passes the cut prefilter but is not the whole name: no mention.
			{ articleId: articleId(1), title: "パン・パシフィック・インターナシ", retrievedAt: at(1) },
		]);
		const response = await get(harness, "/stocks/jp:7532/news");
		expect(response.status).toBe(200);
		const page = stockNewsResponseSchema.parse(await response.json());
		expect(page.articles.map((row) => row.articleId)).toEqual([articleId(0)]);
		expect(page.articles[0]?.mentions.text).toBe(
			"パン・パシフィック・インターナショナルホールディングス",
		);
	});

	it("answers an empty page with a cursor when every batch held only false candidates", async () => {
		const harness = createHarness();
		await seedDirectory(harness, {
			market: "US",
			symbol: "AAPL",
			name: "Apple Inc.",
			listing: "nasdaq",
		});
		const falseCandidates = STOCK_LIMITS.newsCandidateBatch * STOCK_LIMITS.newsMaxBatches + 10;
		const rows: SeedArticle[] = Array.from({ length: falseCandidates }, (_, index) => ({
			articleId: articleId(index),
			title: `Pineapple ${index}`,
			retrievedAt: at(index),
		}));
		rows.push({
			articleId: articleId(falseCandidates),
			title: "Apple at last",
			retrievedAt: at(falseCandidates),
		});
		await seedArticles(harness, rows);
		const pages = await allPages(harness, "us:AAPL");
		expect(pages).toHaveLength(2);
		expect(pages[0]?.articles).toEqual([]);
		expect(pages[0]?.nextCursor).not.toBeNull();
		expect(pages[1]?.articles.map((row) => row.articleId)).toEqual([articleId(falseCandidates)]);
	});

	it("answers 304 from the article stamp, and a new page after an article is stored", async () => {
		const harness = createHarness();
		await seedDirectory(harness, {
			market: "US",
			symbol: "AAPL",
			name: "Apple Inc.",
			listing: "nasdaq",
		});
		await seedArticles(harness, [
			{ articleId: articleId(5), title: "Apple one", retrievedAt: at(5) },
		]);
		const first = await get(harness, "/stocks/us:AAPL/news");
		const etag = first.headers.get("ETag");
		expect(first.status).toBe(200);
		expect((await get(harness, "/stocks/us:AAPL/news", etag)).status).toBe(304);
		// Older than the newest (a late completion): only the count moves.
		await seedArticles(harness, [
			{ articleId: articleId(9), title: "Apple two", retrievedAt: at(9) },
		]);
		const changed = await get(harness, "/stocks/us:AAPL/news", etag);
		expect(changed.status).toBe(200);
		expect((await body(changed, stockNewsResponseSchema)).articles).toHaveLength(2);
		// A changed name changes the terms, and with them the ETag.
		const etag2 = changed.headers.get("ETag");
		await env.DB.prepare(
			"UPDATE stock_directory SET name = 'Apple Computer Inc.' WHERE owner_id = ?",
		)
			.bind(harness.ownerId)
			.run();
		const renamed = await get(harness, "/stocks/us:AAPL/news", etag2);
		expect(renamed.status).toBe(200);
		expect((await body(renamed, stockNewsResponseSchema)).terms[0]?.text).toBe("Apple Computer");
	});

	it("searches by the tracked company's and the watchlist's names too", async () => {
		const harness = createHarness();
		await env.DB.batch([
			env.DB.prepare(
				`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name, tracked, tracked_at)
				VALUES (?, 'eco_1', 'JP', '7974', 'edinet', '任天堂株式会社', 1, '2026-10-01T00:00:00.000Z')`,
			).bind(harness.ownerId),
			env.DB.prepare(
				`INSERT INTO watchlist_stocks (owner_id, stock_id, market, symbol, name, added_at)
				VALUES (?, 'jp:7974', 'JP', '7974', 'Nintendo', '2026-10-01T00:00:00.000Z')`,
			).bind(harness.ownerId),
		]);
		await seedArticles(harness, [
			{ articleId: articleId(1), title: "任天堂の決算", retrievedAt: at(1) },
			{ articleId: articleId(2), title: "Nintendo Switch sales", retrievedAt: at(2) },
			{ articleId: articleId(3), title: "7974 trades flat", retrievedAt: at(3) },
		]);
		const response = await get(harness, "/stocks/jp:7974/news");
		const news = await body(response, stockNewsResponseSchema);
		expect(news.terms).toEqual([
			{ text: "任天堂", kind: "name" },
			{ text: "Nintendo", kind: "name" },
		]);
		expect(news.articles.map((row) => row.articleId)).toEqual([articleId(1), articleId(2)]);
		expect(news.nextCursor).toBeNull();
	});

	it("answers no terms and no articles for a Japanese stock without a stored name", async () => {
		const harness = createHarness();
		await seedArticles(harness, [
			{ articleId: articleId(1), title: "7974 rose", retrievedAt: at(1) },
		]);
		const response = await get(harness, "/stocks/jp:7974/news");
		expect(await body(response, stockNewsResponseSchema)).toEqual({
			stockId: "jp:7974",
			terms: [],
			articles: [],
			nextCursor: null,
		});
	});

	it("refuses a cursor it did not issue and an unknown query parameter", async () => {
		const harness = createHarness();
		for (const query of [
			"?cursor=not-a-cursor",
			`?cursor=${btoa("[1,2]")}`,
			"?page=2",
			`?cursor=${"A".repeat(401)}`,
		]) {
			const response = await get(harness, `/stocks/us:AAPL/news${query}`);
			expect(response.status, query).toBe(400);
			expect(await errorCode(response)).toBe("VALIDATION_FAILED");
		}
	});
});
