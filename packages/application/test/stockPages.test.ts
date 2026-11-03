import {
	type Article,
	type CompanySummaryView,
	type EquityCompanyView,
	STOCK_LIMITS,
	type StockCompanyProfileView,
	stockNewsResponseSchema,
	stockPricesResponseSchema,
	stockProfileResponseSchema,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	type ArticleKey,
	createStockPageService,
	decodeArticleCursor,
	type EquityCompanyRecord,
	encodeArticleCursor,
	type StockPageDeps,
	type StockRef,
	type StoredEquityBusinessDescription,
	type StoredMarketObservation,
	type StoredMarketSeries,
	type StoredStockDirectoryEntry,
	type StoredWatchlistStock,
	type ThemeSearchRow,
} from "../src/index.ts";
import { inMemoryStockDirectory } from "./support.ts";

const OWNER = "owner_1";
const APPLE: StockRef = { stockId: "us:AAPL", market: "US", symbol: "AAPL" };
const NINTENDO: StockRef = { stockId: "jp:7974", market: "JP", symbol: "7974" };

/** Article `index` of a newest-first store: a larger index is older. */
function article(index: number, title: string, excerpt: string | null = null): Article {
	const hex = index.toString(16).padStart(64, "0");
	return {
		articleId: `art_${hex.slice(-32)}`,
		sourceId: "src_feed",
		canonicalUrl: `https://news.example.org/a/${index}`,
		publisher: "Example News",
		title,
		publishedAt: null,
		retrievedAt: new Date(Date.UTC(2026, 9, 30) - index * 60_000).toISOString(),
		contentFingerprint: hex,
		excerpt,
	};
}

const keyOf = (row: Article): ArticleKey => ({
	retrievedAt: row.retrievedAt,
	articleId: row.articleId,
});

const below = (row: Article, key: ArticleKey | null) =>
	key === null ||
	row.retrievedAt < key.retrievedAt ||
	(row.retrievedAt === key.retrievedAt && row.articleId < key.articleId);

interface Calls {
	candidateBatches: { before: ArticleKey | null; limit: number; patterns: readonly string[] }[];
	observations: number;
	stamps: number;
	companyReads: number;
	profileReads: number;
	themeNeedles: string[];
}

/** The view the equity service answers for a stored company with no sync yet. */
function companyView(company: EquityCompanyRecord): EquityCompanyView {
	return {
		companyId: company.companyId,
		market: company.market,
		symbol: company.symbol,
		name: company.name,
		provider: company.provider,
		sourceCompanyId: company.sourceCompanyId,
		fiscalYearEnd: company.fiscalYearEnd,
		tracked: company.tracked,
		latestFiscalYear: 2025,
		filingCount: 3,
		sync: {
			status: "succeeded",
			lastCheckedAt: "2026-10-30T00:00:00.000Z",
			lastSucceededAt: "2026-10-30T00:00:00.000Z",
			nextDueAt: null,
			failure: null,
		},
	};
}

/**
 * Deps over in-memory rows. The candidate read returns EVERY stored article
 * below the key (a prefilter that keeps everything), so the service's own
 * mention check decides what a page holds.
 */
function depsWith(
	options: {
		readonly articles?: readonly Article[];
		readonly directory?: readonly StoredStockDirectoryEntry[];
		readonly company?: Pick<EquityCompanyRecord, "market" | "symbol" | "name"> &
			Partial<Pick<EquityCompanyRecord, "tracked">>;
		readonly description?: StoredEquityBusinessDescription;
		readonly watched?: Pick<StoredWatchlistStock, "stockId" | "name">;
		readonly series?: readonly StoredMarketSeries[];
		readonly observations?: readonly StoredMarketObservation[];
		readonly profiles?: readonly StockCompanyProfileView[];
		readonly summaries?: readonly (CompanySummaryView & { readonly symbol: string })[];
		readonly themeRows?: readonly ThemeSearchRow[];
	} = {},
): { deps: StockPageDeps; calls: Calls } {
	const calls: Calls = {
		candidateBatches: [],
		observations: 0,
		stamps: 0,
		companyReads: 0,
		profileReads: 0,
		themeNeedles: [],
	};
	const newestFirst = [...(options.articles ?? [])].sort((a, b) =>
		a.retrievedAt === b.retrievedAt
			? b.articleId.localeCompare(a.articleId)
			: b.retrievedAt.localeCompare(a.retrievedAt),
	);
	const company = options.company;
	const watched = options.watched;
	const companyOf = (market: "US" | "JP", symbol: string): EquityCompanyRecord | null =>
		company !== undefined && company.market === market && company.symbol === symbol
			? {
					companyId: "eco_1",
					market,
					symbol,
					provider: market === "US" ? "sec" : "jquants",
					sourceCompanyId: null,
					name: company.name,
					fiscalYearEnd: null,
					tracked: company.tracked ?? false,
					trackedAt: "2026-10-01T00:00:00.000Z",
				}
			: null;
	const deps: StockPageDeps = {
		stockDirectory: inMemoryStockDirectory(
			options.directory ?? [],
			[],
			options.profiles ?? [],
			() => {
				calls.profileReads += 1;
			},
		),
		market: {
			getSeriesMeta: async (_owner, ids) =>
				(options.series ?? []).filter((series) => ids.includes(series.seriesId)),
			getObservations: async (_owner, ids, limit) => {
				calls.observations += 1;
				return (options.observations ?? [])
					.filter((point) => ids.includes(point.seriesId))
					.slice(-limit);
			},
		},
		articles: {
			stamp: async () => {
				calls.stamps += 1;
				const newest = newestFirst[0];
				return {
					articleCount: newestFirst.length,
					newest: newest === undefined ? null : keyOf(newest),
				};
			},
			listMentionCandidates: async (_owner, query) => {
				calls.candidateBatches.push({ ...query });
				return newestFirst.filter((row) => below(row, query.before)).slice(0, query.limit);
			},
		},
		equitySync: {
			findByListing: async (_owner, market, symbol) => companyOf(market, symbol),
			businessByListing: async (_owner, market, symbol) => {
				const found = companyOf(market, symbol);
				return found === null ? null : { company: found, description: options.description ?? null };
			},
		},
		equityCompanies: {
			company: async (_owner, companyId) => {
				calls.companyReads += 1;
				const found = company === undefined ? null : companyOf(company.market, company.symbol);
				if (found === null || found.companyId !== companyId) {
					return { ok: false, error: { code: "EQUITY_COMPANY_NOT_FOUND", message: "gone" } };
				}
				return { ok: true, value: { view: companyView(found), dataUpdatedAt: null } };
			},
		},
		watchlist: {
			getStock: async (_owner, stockId) =>
				watched !== undefined && watched.stockId === stockId
					? {
							stockId,
							market: "US",
							symbol: "AAPL",
							name: watched.name,
							addedAt: "2026-10-01T00:00:00.000Z",
							lastRefreshedAt: null,
							retrievedAt: null,
							unavailableCode: null,
							unavailableUpstreamStatus: null,
						}
					: null,
		},
		companySummaries: {
			get: async (_owner, _market, symbol) => {
				const found = (options.summaries ?? []).find((summary) => summary.symbol === symbol);
				if (found === undefined) return { summary: null, overview: null };
				const { symbol: _symbol, ...view } = found;
				return { summary: view, overview: null };
			},
			searchThemes: async (_owner, needle) => {
				calls.themeNeedles.push(needle);
				return options.themeRows ?? [];
			},
		},
	};
	return { deps, calls };
}

async function newsPage(deps: StockPageDeps, stock: StockRef, cursor: string | null = null) {
	const service = createStockPageService(deps);
	const digest = await service.newsDigest(OWNER, stock, cursor);
	if (!digest.ok) throw new Error(`digest failed: ${digest.error.code}`);
	return stockNewsResponseSchema.parse(await service.news(OWNER, digest.value));
}

const APPLE_DIRECTORY: StoredStockDirectoryEntry = {
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc.",
	localName: null,
	listing: "nasdaq",
};

describe("the news terms (ADR-0049 §7)", () => {
	it("are the stored names in priority order, then the US symbol", async () => {
		const { deps } = depsWith({
			directory: [APPLE_DIRECTORY],
			company: { market: "US", symbol: "AAPL", name: "APPLE INC" },
			watched: { stockId: "us:AAPL", name: "Apple Computer, Inc." },
		});
		const page = await newsPage(deps, APPLE);
		expect(page.terms).toEqual([
			{ text: "Apple", kind: "name" },
			{ text: "Apple Computer", kind: "name" },
			{ text: "AAPL", kind: "symbol" },
		]);
	});

	it("read nothing from the articles when a Japanese stock has no stored name", async () => {
		const { deps, calls } = depsWith({ articles: [article(0, "7974 rose")] });
		const page = await newsPage(deps, NINTENDO);
		expect(page).toEqual({ stockId: "jp:7974", terms: [], articles: [], nextCursor: null });
		expect(calls.candidateBatches).toEqual([]);
	});

	it("search a Japanese stock by its English and Japanese directory names", async () => {
		const { deps, calls } = depsWith({
			directory: [
				{
					market: "JP",
					symbol: "7974",
					name: "NINTENDO CO., LTD.",
					localName: "任天堂株式会社",
					listing: "tse-prime",
				},
			],
			articles: [
				article(0, "任天堂、新型機を発表"),
				article(1, "Nintendo shares climb"),
				article(2, "7974"),
			],
		});
		const page = await newsPage(deps, NINTENDO);
		expect(page.terms).toEqual([
			{ text: "NINTENDO", kind: "name" },
			{ text: "任天堂", kind: "name" },
		]);
		expect(page.articles.map((row) => row.mentions.text)).toEqual(["任天堂", "NINTENDO"]);
		expect(calls.candidateBatches[0]?.patterns).toEqual(["%NINTENDO%", "%任天堂%"]);
	});
});

describe("a News page's batches and cursor", () => {
	const { newsPageSize, newsCandidateBatch, newsMaxBatches } = STOCK_LIMITS;

	it("ends at the last kept article when the page fills mid-batch", async () => {
		// Every other article mentions Apple: 20 kept within the first 40 rows.
		const rows = Array.from({ length: 200 }, (_, index) =>
			article(index, index % 2 === 0 ? `Apple story ${index}` : `Other story ${index}`),
		);
		const { deps, calls } = depsWith({ directory: [APPLE_DIRECTORY], articles: rows });
		const page = await newsPage(deps, APPLE);
		expect(page.articles).toHaveLength(newsPageSize);
		expect(calls.candidateBatches).toHaveLength(1);
		const lastKept = rows[(newsPageSize - 1) * 2];
		if (lastKept === undefined) throw new Error("fixture too small");
		expect(page.articles.at(-1)?.articleId).toBe(lastKept.articleId);
		expect(page.nextCursor === null ? null : decodeArticleCursor(page.nextCursor)).toEqual(
			keyOf(lastKept),
		);

		// The next page starts right after it: nothing skipped, nothing repeated.
		const next = await newsPage(deps, APPLE, page.nextCursor);
		expect(next.articles[0]?.articleId).toBe(rows[newsPageSize * 2]?.articleId);
	});

	it("ends at the last scanned candidate when every batch is read", async () => {
		// One mention in the first row only; the rest never mention Apple.
		const rows = Array.from({ length: newsCandidateBatch * newsMaxBatches + 10 }, (_, index) =>
			article(index, index === 0 ? "Apple results" : `Unrelated story ${index}`),
		);
		const { deps, calls } = depsWith({ directory: [APPLE_DIRECTORY], articles: rows });
		const page = await newsPage(deps, APPLE);
		expect(page.articles.map((row) => row.articleId)).toEqual([rows[0]?.articleId]);
		expect(calls.candidateBatches).toHaveLength(newsMaxBatches);
		expect(calls.candidateBatches.map((call) => call.limit)).toEqual(
			Array(newsMaxBatches).fill(newsCandidateBatch),
		);
		const lastScanned = rows[newsCandidateBatch * newsMaxBatches - 1];
		if (lastScanned === undefined) throw new Error("fixture too small");
		expect(page.nextCursor === null ? null : decodeArticleCursor(page.nextCursor)).toEqual(
			keyOf(lastScanned),
		);
		// Each batch started strictly below the previous batch's last row.
		const firstBatchLast = rows[newsCandidateBatch - 1];
		if (firstBatchLast === undefined) throw new Error("fixture too small");
		expect(calls.candidateBatches[1]?.before).toEqual(keyOf(firstBatchLast));
	});

	it("has no next page when a batch comes back short", async () => {
		const rows = Array.from({ length: newsCandidateBatch + 5 }, (_, index) =>
			article(index, index % 10 === 0 ? `AAPL moves ${index}` : `Story ${index}`),
		);
		const { deps, calls } = depsWith({ articles: rows });
		const page = await newsPage(deps, APPLE);
		expect(page.terms).toEqual([{ text: "AAPL", kind: "symbol" }]);
		expect(page.articles).toHaveLength(7);
		expect(page.nextCursor).toBeNull();
		expect(calls.candidateBatches).toHaveLength(2);
	});

	it("has no next page when the page fills on the last stored candidate", async () => {
		const rows = Array.from({ length: newsPageSize }, (_, index) =>
			article(index, `Apple ${index}`),
		);
		const { deps, calls } = depsWith({ directory: [APPLE_DIRECTORY], articles: rows });
		const page = await newsPage(deps, APPLE);
		expect(page.articles).toHaveLength(newsPageSize);
		expect(page.nextCursor).toBeNull();
		expect(calls.candidateBatches).toHaveLength(1);
	});

	it("keeps a mention found only in the excerpt, and names the first matching term", async () => {
		const rows = [
			article(0, "Quarterly results", "Apple Inc. reported revenue"),
			article(1, "AAPL and Apple both"),
			article(2, "Pineapple prices"),
		];
		const { deps } = depsWith({ directory: [APPLE_DIRECTORY], articles: rows });
		const page = await newsPage(deps, APPLE);
		expect(page.articles.map((row) => [row.articleId, row.mentions])).toEqual([
			[rows[0]?.articleId, { text: "Apple", kind: "name" }],
			[rows[1]?.articleId, { text: "Apple", kind: "name" }],
		]);
	});

	it("refuses a cursor it did not issue, before reading anything", async () => {
		const { deps, calls } = depsWith({ directory: [APPLE_DIRECTORY] });
		const service = createStockPageService(deps);
		for (const cursor of ["not base64!", btoa("[1,2]"), btoa("{}"), btoa('["", "x"]')]) {
			const digest = await service.newsDigest(OWNER, APPLE, cursor);
			expect(digest.ok ? null : digest.error.code).toBe("VALIDATION_FAILED");
		}
		expect(calls.stamps).toBe(0);
	});

	it("round-trips the cursor format the Sources list uses", () => {
		const key = { retrievedAt: "2026-10-30T00:00:00.000Z", articleId: "art_1" };
		expect(decodeArticleCursor(encodeArticleCursor(key))).toEqual(key);
	});
});

describe("the profile and prices reads", () => {
	it("answers the directory entry, or null when the stored list has none", async () => {
		const { deps } = depsWith({ directory: [APPLE_DIRECTORY] });
		const service = createStockPageService(deps);
		expect(stockProfileResponseSchema.parse(await service.profile(OWNER, APPLE))).toEqual({
			stockId: "us:AAPL",
			market: "US",
			symbol: "AAPL",
			priceSeriesId: "twelve-data:AAPL",
			directory: { name: "Apple Inc.", localName: null, listing: "nasdaq" },
			business: { status: "not-tracked" },
			companyProfile: null,
			summary: null,
			overview: null,
			company: null,
		});
		const nintendo = await service.profile(OWNER, NINTENDO);
		expect(nintendo.priceSeriesId).toBe("twelve-data:7974:JPX");
		expect(nintendo.directory).toBeNull();
	});

	it("answers the stored company, tracked or not, and reads it only when one is stored (ADR-0055)", async () => {
		const { deps, calls } = depsWith({
			directory: [APPLE_DIRECTORY],
			company: { market: "US", symbol: "AAPL", name: "Apple Inc.", tracked: false },
		});
		const service = createStockPageService(deps);
		const profile = stockProfileResponseSchema.parse(await service.profile(OWNER, APPLE));
		expect(profile.company).toMatchObject({ companyId: "eco_1", tracked: false, filingCount: 3 });
		expect(calls.companyReads).toBe(1);
		const none = await service.profile(OWNER, NINTENDO);
		expect(none.company).toBeNull();
		expect(calls.companyReads).toBe(1);
	});

	it("answers a null series without reading observations when none is stored", async () => {
		const { deps, calls } = depsWith();
		const service = createStockPageService(deps);
		const digest = await service.pricesDigest(OWNER, APPLE);
		expect(digest.meta).toBeNull();
		expect(digest.stamp.lastRefreshedAt).toBeNull();
		expect(await service.prices(OWNER, digest)).toEqual({
			stockId: "us:AAPL",
			seriesId: "twelve-data:AAPL",
			series: null,
		});
		expect(calls.observations).toBe(0);
	});

	it("answers the stored series in the Home data shape", async () => {
		const meta: StoredMarketSeries = {
			seriesId: "twelve-data:AAPL",
			provider: "twelve-data",
			symbol: "AAPL",
			title: "Apple Inc.",
			unit: "USD",
			frequency: "daily",
			publisher: "Twelve Data",
			sourceUrl: "https://twelvedata.com/",
			lastRefreshedAt: "2026-10-30T00:00:00.000Z",
			retrievedAt: "2026-10-30T00:00:00.000Z",
			unavailableCode: null,
			unavailableUpstreamStatus: null,
		};
		const { deps } = depsWith({
			series: [meta],
			observations: [
				{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-28", value: 230 },
				{ seriesId: "twelve-data:AAPL", observedOn: "2026-10-29", value: 232.5 },
			],
		});
		const service = createStockPageService(deps);
		const digest = await service.pricesDigest(OWNER, APPLE);
		expect(digest.stamp.lastRefreshedAt).toBe("2026-10-30T00:00:00.000Z");
		const prices = stockPricesResponseSchema.parse(await service.prices(OWNER, digest));
		expect(prices.series?.observations).toEqual([
			["2026-10-28", 230],
			["2026-10-29", 232.5],
		]);
		expect(prices.series?.unavailable).toBeNull();
	});
});

describe("the profile's business description (ADR-0053 §5)", () => {
	const SOURCE = {
		sourceDocumentId: "0000320193-25-000079",
		form: "10-K" as const,
		filedOn: "2025-10-31",
		periodEnd: "2025-09-27",
		sourceUrl:
			"https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
	};
	const EXTRACTED: StoredEquityBusinessDescription = {
		source: SOURCE,
		status: "extracted",
		paragraphs: [
			{ kind: "heading", text: "Company Background" },
			{ kind: "text", text: "The Company designs, manufactures and markets smartphones." },
		],
		truncated: true,
		fetchedAt: "2026-11-01T00:00:00.000Z",
	};
	const businessOf = async (options: Parameters<typeof depsWith>[0]) => {
		const service = createStockPageService(depsWith(options).deps);
		return stockProfileResponseSchema.parse(await service.profile(OWNER, APPLE)).business;
	};
	const apple = { market: "US" as const, symbol: "AAPL", name: "Apple Inc." };

	it("is not-tracked without a company and pending for a tracked one without a description", async () => {
		expect(await businessOf({})).toEqual({ status: "not-tracked" });
		expect(await businessOf({ company: apple })).toEqual({ status: "not-tracked" });
		expect(await businessOf({ company: { ...apple, tracked: true } })).toEqual({
			status: "pending",
		});
	});

	it("shows a stored description whether or not the company is still tracked", async () => {
		const expected = {
			status: "extracted",
			source: SOURCE,
			paragraphs: EXTRACTED.paragraphs,
			truncated: true,
			fetchedAt: "2026-11-01T00:00:00.000Z",
		};
		expect(await businessOf({ company: apple, description: EXTRACTED })).toEqual(expected);
		expect(
			await businessOf({ company: { ...apple, tracked: true }, description: EXTRACTED }),
		).toEqual(expected);
	});

	it("names the report read when it had no business section", async () => {
		expect(
			await businessOf({
				company: { ...apple, tracked: true },
				description: { ...EXTRACTED, status: "not-found", paragraphs: [], truncated: false },
			}),
		).toEqual({ status: "not-found", source: SOURCE });
	});
});

describe("a Japanese stock's company profile (ADR-0059 §3)", () => {
	/** Nintendo's profile as J-Quants' Listed Issue Master answered it on 2026-11-02. */
	const PROFILE: StockCompanyProfileView = {
		symbol: "7974",
		nameEn: "Nintendo Co.,Ltd.",
		sector17Code: "10",
		sector17Name: "情報通信・サービスその他",
		sector33Code: "3800",
		sector33Name: "その他製品",
		scaleCategory: "TOPIX Core30",
		marketSegmentCode: "0111",
		marketSegmentName: "プライム",
		asOf: "2026-08-10",
		retrievedAt: "2026-11-02T00:00:00.000Z",
	};
	const nintendo = { market: "JP" as const, symbol: "7974", name: "任天堂", tracked: true };

	it("answers the stored profile and a business that is not provided", async () => {
		const { deps } = depsWith({ company: nintendo, profiles: [PROFILE] });
		const profile = stockProfileResponseSchema.parse(
			await createStockPageService(deps).profile(OWNER, NINTENDO),
		);
		expect(profile.companyProfile).toEqual(PROFILE);
		expect(profile.business).toEqual({ status: "not-provided" });
		expect(profile.company).toMatchObject({ companyId: "eco_1", provider: "jquants" });
	});

	it("answers null before a profile is stored, still not-provided", async () => {
		const { deps } = depsWith({ company: nintendo });
		const profile = await createStockPageService(deps).profile(OWNER, NINTENDO);
		expect(profile.companyProfile).toBeNull();
		expect(profile.business).toEqual({ status: "not-provided" });
	});

	it("never reads a profile for a US stock", async () => {
		const { deps, calls } = depsWith({
			company: { market: "US", symbol: "AAPL", name: "Apple Inc." },
			profiles: [{ ...PROFILE, symbol: "AAPL" }],
		});
		const profile = await createStockPageService(deps).profile(OWNER, APPLE);
		expect(profile.companyProfile).toBeNull();
		expect(profile.business).toEqual({ status: "not-tracked" });
		expect(calls.profileReads).toBe(0);
	});
});

describe("the AI-written company summary (ADR-0060)", () => {
	const SUMMARY: CompanySummaryView = {
		description: {
			en: "Nintendo makes video game consoles and games.",
			ja: "任天堂はゲーム機とゲームソフトを作る会社です。",
		},
		themes: [
			{ en: "Video games", ja: "ゲーム" },
			{ en: "Intellectual property", ja: "IP" },
		],
		agentId: "claude-code",
		model: null,
		generatedAt: "2026-11-02T00:00:00.000Z",
	};

	it("answers the stored summary beside the profile", async () => {
		const { deps } = depsWith({ summaries: [{ ...SUMMARY, symbol: "7974" }] });
		const profile = stockProfileResponseSchema.parse(
			await createStockPageService(deps).profile(OWNER, NINTENDO),
		);
		expect(profile.summary).toEqual(SUMMARY);
	});

	it("answers null before a summary is written", async () => {
		const { deps } = depsWith({});
		const profile = await createStockPageService(deps).profile(OWNER, APPLE);
		expect(profile.summary).toBeNull();
	});
});

describe("theme search (ADR-0066)", () => {
	const row = (
		market: "US" | "JP",
		symbol: string,
		themes: readonly { en: string; ja: string }[],
	): ThemeSearchRow => ({ market, symbol, name: `${symbol} Inc`, localName: null, themes });

	it("asks the database with the folded, JSON-escaped query and keeps only matching themes", async () => {
		const { deps, calls } = depsWith({
			themeRows: [
				row("JP", "1380", [
					{ en: "Organic Vegetables", ja: "無農薬野菜" },
					{ en: "Frozen Chicken", ja: "冷凍鶏加工食品" },
				]),
				row("US", "KO", [{ en: "Soft Drinks", ja: "清涼飲料" }]),
			],
		});
		const answer = await createStockPageService(deps).themeSearch(OWNER, "  ＶＥＧＥＴＡＢＬＥＳ ");
		// NFKC turns the full-width letters into ASCII; the needle folds ASCII case.
		expect(answer.query).toBe("VEGETABLES");
		expect(calls.themeNeedles).toEqual(["vegetables"]);
		expect(answer.hits).toEqual([
			{
				stockId: "jp:1380",
				market: "JP",
				symbol: "1380",
				name: "1380 Inc",
				localName: null,
				themes: [{ en: "Organic Vegetables", ja: "無農薬野菜" }],
			},
		]);
		expect(answer.truncated).toBe(false);
	});

	it("drops a stock whose database match spans two names", async () => {
		// `instr` over `[["Soft Drinks","清涼飲料"]]` finds `drinks","清`; no single name holds it.
		const { deps } = depsWith({
			themeRows: [row("US", "KO", [{ en: "Soft Drinks", ja: "清涼飲料" }])],
		});
		const answer = await createStockPageService(deps).themeSearch(OWNER, 'Drinks","清');
		expect(answer.hits).toEqual([]);
	});

	it("answers no hits without reading when the query is blank or longer than any theme", async () => {
		const { deps, calls } = depsWith({});
		const service = createStockPageService(deps);
		expect(await service.themeSearch(OWNER, " \t ")).toEqual({
			query: null,
			hits: [],
			truncated: false,
		});
		expect(await service.themeSearch(OWNER, "x".repeat(41))).toEqual({
			query: null,
			hits: [],
			truncated: false,
		});
		expect(calls.themeNeedles).toEqual([]);
	});

	it("keeps the first 50 stocks and says more matched", async () => {
		const rows = Array.from({ length: 51 }, (_, index) =>
			row("US", `S${String(index).padStart(2, "0")}`, [
				{ en: "Cloud Software", ja: "クラウドソフト" },
			]),
		);
		const { deps } = depsWith({ themeRows: rows });
		const answer = await createStockPageService(deps).themeSearch(OWNER, "クラウド");
		expect(answer.hits).toHaveLength(50);
		expect(answer.hits[49]?.symbol).toBe("S49");
		expect(answer.truncated).toBe(true);
	});
});
