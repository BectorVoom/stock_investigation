import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStockResearchRepository } from "../../src/sql/stockResearch.ts";
import {
	applySqlMigrations,
	initializeSqlSchema,
	openNodeSqlite,
	readSqlMigrations,
} from "../../src/sqlite/index.ts";
import {
	seedJapaneseShipbuildingScreening,
	seedStockResearch,
	seedStockScreening,
} from "../sql/stockResearchFixtures.ts";

for (const layout of ["canonical", "migrated"] as const)
	describe(`stored stock retrieval (${layout})`, () => {
		async function setup() {
			const db = openNodeSqlite(":memory:");
			if (layout === "canonical")
				initializeSqlSchema(
					db,
					readFileSync(new URL("../../../../db/schema.sql", import.meta.url), "utf8"),
					[],
				);
			else
				applySqlMigrations(
					db,
					readSqlMigrations(
						fileURLToPath(new URL("../../../../infra/migrations", import.meta.url)),
					),
				);
			await seedStockResearch(db, "owner");
			return { db, repository: createStockResearchRepository(db) };
		}
		it("screens latest annual EPS and P/E from the latest same-currency close", async () => {
			const { db, repository } = await setup();
			try {
				await db
					.prepare(`INSERT INTO equity_metric_value
					(owner_id, company_id, metric_code, fiscal_year, value_decimal, value_real, currency,
					 filing_id, concept, scope, period_start, period_end, reported_value_count, updated_at)
					SELECT owner_id, company_id, 'basic-eps', fiscal_year, '5', 5, currency,
					 filing_id, 'us-gaap:EarningsPerShareBasic', scope, period_start, period_end, 1, updated_at
					FROM equity_metric_value WHERE owner_id = 'owner' AND company_id = 'eqc_retrieval'`)
					.run();
				await db
					.prepare(`INSERT INTO market_series
					(owner_id, series_id, provider, symbol, title, unit, frequency, publisher, source_url)
					VALUES ('owner', 'twelve-data:SYNTH', 'twelve-data', 'SYNTH', 'Synthetic Solar',
					 'USD', 'daily', 'Fixture prices', 'https://prices.example.org/synth')`)
					.run();
				await db
					.prepare(`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
					VALUES ('owner', 'twelve-data:SYNTH', '2026-10-01', 100),
					 ('owner', 'twelve-data:SYNTH', '2026-10-02', 50)`)
					.run();
				const search = (query: string) =>
					repository.search("owner", { query, kind: "financials", limit: 6 });
				const passes = await search("us eps>=5 per<=10 currency=USD");
				expect(passes.hits).toHaveLength(1);
				expect(passes.hits[0]?.text).toContain(
					"Calculated P/E (PER)=10; close=50; closeDate=2026-10-02",
				);
				expect(passes.hits[0]?.text).toContain("priceSource=https://prices.example.org/synth");
				expect((await search("us:SYNTH per<10")).hits).toEqual([]);
				expect((await search("jp eps>=5")).hits).toEqual([]);
				expect((await search("eps>=5 currency=JPY")).hits).toEqual([]);
				await db.prepare("UPDATE market_series SET unit = 'JPY'").run();
				expect((await search("per<=10")).hits).toEqual([]);
				expect((await search("eps>=5")).hits[0]?.text).toContain("unit=currency per share");
			} finally {
				db.close();
			}
		});

		it("retrieves thematic candidates and both annual profit periods for staged agent screening", async () => {
			const { db, repository } = await setup();
			try {
				await seedStockScreening(db, "owner");
				const candidates = await repository.search("owner", {
					query: "ドローン",
					kind: "company",
					limit: 12,
				});
				expect(candidates.hits).toHaveLength(2);
				expect(candidates.hits.every((hit) => !hit.aiGenerated && hit.sourceUrl !== null)).toBe(
					true,
				);
				for (const [symbol, current] of [
					["DRONE25", "1250000"],
					["DRONE10", "1100000"],
				]) {
					const financials = await repository.search("owner", {
						query: `${symbol} 純利益`,
						kind: "financials",
						limit: 12,
					});
					expect(financials.hits).toHaveLength(2);
					expect(financials.hits.map((hit) => hit.text).join(" ")).toContain(`value=${current}`);
					expect(financials.hits.map((hit) => hit.text).join(" ")).toContain("value=1000000");
					expect(financials.hits.map((hit) => hit.text).join(" ")).toContain("fiscalYear=2024");
					expect(financials.hits.map((hit) => hit.text).join(" ")).toContain("fiscalYear=2025");
				}
			} finally {
				db.close();
			}
		});

		it("searches every corpus with exact decimals, lineage and owner isolation", async () => {
			const { db, repository } = await setup();
			try {
				const result = await repository.search("owner", { query: "solar", limit: 6 });
				expect(new Set(result.hits.map((hit) => hit.kind))).toEqual(
					new Set(["company", "financials", "news"]),
				);
				const financial = result.hits.find((hit) => hit.kind === "financials");
				expect(financial?.text).toContain("issuer=US:SYNTH Synthetic Solar;");
				expect(financial?.text).toContain("12345678901234567890.12");
				expect(financial?.text).toContain("currency=USD");
				expect(financial?.text).toContain("scope=consolidated");
				expect(financial?.text).toContain("reportedValueCount=1");
				expect(financial?.sourceUrl).toBe("https://filings.example.org/solar");
				expect(result.hits.find((hit) => hit.aiGenerated)).toMatchObject({
					sourceUrl: null,
					retainQuotes: false,
				});
				expect(await repository.search("other-owner", { query: "solar", limit: 6 })).toEqual({
					hits: [],
					truncated: false,
					jpFinancials: [],
				});
			} finally {
				db.close();
			}
		});
		it("matches all terms literally, Japanese, kinds and limits", async () => {
			const { db, repository } = await setup();
			try {
				expect(
					(
						await repository.search("owner", {
							query: "SYNTH 売上高",
							kind: "financials",
							limit: 6,
						})
					).hits,
				).toHaveLength(1);
				expect(
					(
						await repository.search("owner", {
							query: "SYNTH revenue",
							kind: "financials",
							limit: 6,
						})
					).hits,
				).toHaveLength(1);
				expect(
					(await repository.search("owner", { query: "太陽光 蓄電池", limit: 6 })).hits.length,
				).toBeGreaterThan(0);
				expect(
					(await repository.search("owner", { query: "solar nonexistent", limit: 6 })).hits,
				).toEqual([]);
				expect(
					(await repository.search("owner", { query: "%_' OR 1=1 --", limit: 6 })).hits,
				).toEqual([]);
				const limited = await repository.search("owner", { query: "solar", limit: 3 });
				expect(limited.truncated).toBe(true);
				expect(limited.hits.map((hit) => hit.kind)).toEqual(["company", "financials", "news"]);
			} finally {
				db.close();
			}
		});
		it("never returns a restricted or orphaned article's stored excerpt", async () => {
			const { db, repository } = await setup();
			try {
				await db
					.prepare(
						"UPDATE news_sources SET license_policy = 'headline-and-link-only' WHERE owner_id = ?",
					)
					.bind("owner")
					.run();
				const query = { query: "solar", kind: "news" as const, limit: 6 };
				const news = await repository.search("owner", query);
				expect(news.hits[0]).toMatchObject({
					text: "Synthetic Solar expands\n",
					retainQuotes: false,
				});
				expect((await repository.search("owner", { ...query, query: "production" })).hits).toEqual(
					[],
				);
				await db.prepare("DELETE FROM news_sources WHERE owner_id = ?").bind("owner").run();
				expect((await repository.search("owner", query)).hits[0]?.retainQuotes).toBe(false);
			} finally {
				db.close();
			}
		});
		it("orders company hits by identity then theme, excludes customer-only body mentions, and includes Japanese local names", async () => {
			const { db, repository } = await setup();
			try {
				const result = await repository.search("owner", {
					query: "造船",
					kind: "company",
					limit: 6,
				});
				expect(result.hits.map((hit) => hit.recordId)).toEqual(["JP:7018", "JP:7003"]);
				expect(result.hits[0]?.title).toBe(
					"JP:7018 合成造船 (Synthetic Zosen Corporation) AI-written company overview",
				);
			} finally {
				db.close();
			}
		});
		it("screens Japanese stock_company_summary overviews with fuzzy/related matching while excluding divested, customer-only, historical, and SPAC false positives", async () => {
			const { db, repository } = await setup();
			try {
				await seedJapaneseShipbuildingScreening(db, "owner");

				for (const query of [
					"造船",
					"日本 造船",
					"日本の造船",
					"shipbuilding",
					"shipbuilders",
					"shipbuiding",
					"hsipbuilding",
				]) {
					const result = await repository.search("owner", {
						query,
						kind: "company",
						limit: 12,
					});
					const ids = result.hits.map((hit) => hit.recordId);
					// Identity matches (`7914`, `7918`, `7018`) precede direct theme (`7003`) and related theme (`7912`)
					expect(ids, `query=${query}`).toEqual([
						"JP:7914",
						"JP:7918",
						"JP:7018",
						"JP:7003",
						"JP:7912",
					]);
					for (const excluded of [
						"JP:3168",
						"JP:7922",
						"JP:7921",
						"JP:9907",
						"US:SPAC9",
						"eqc_us_exship:0",
						"US:EXSHIP",
					]) {
						expect(ids, `query=${query} must exclude ${excluded}`).not.toContain(excluded);
					}
				}

				// Unrelated CJK 1-char near-misses must never match shipbuilders
				for (const unrelated of ["造園", "酒造", "鋳造"]) {
					expect(
						(await repository.search("owner", { query: unrelated, kind: "company", limit: 6 }))
							.hits,
					).toEqual([]);
				}

				// Fuzzy metric aliases & full-width digits in financials retrieve J-Quants revenue & net income
				const marginHit = await repository.search("owner", {
					query: "７９１４ 純利益率",
					kind: "financials",
					limit: 6,
				});
				expect(marginHit.hits.map((h) => h.recordId)).toEqual([
					"eqc_jp_7914:2025:profit-attributable-to-owners",
				]);
				expect(marginHit.jpFinancials).toMatchObject([
					{
						symbol: "7914",
						issuerName: "合成名村造船",
						fiscalYear: 2025,
						revenue: { value: 100_000_000_000, currency: "JPY" },
						netIncome: { value: 15_000_000_000, currency: "JPY" },
					},
				]);

				const typoFinancials = await repository.search("owner", {
					query: "SYNTH revene",
					kind: "financials",
					limit: 6,
				});
				expect(typoFinancials.hits).toHaveLength(1);
				expect(typoFinancials.hits[0]?.recordId).toBe("eqc_retrieval:2026:revenue");

				// Hiragana / half-width katakana fuzzy matching on drone candidates
				await seedStockScreening(db, "owner");
				for (const droneVariant of ["どろーん", "ﾄﾞﾛｰﾝ", "drones"]) {
					const drones = await repository.search("owner", {
						query: droneVariant,
						kind: "company",
						limit: 12,
					});
					expect(drones.hits.map((h) => h.recordId)).toEqual([
						"eqc_screen_25:0",
						"eqc_screen_10:0",
					]);
				}

				// Short ASCII tickers (`GD`, `BA`, `DE`) in financials must match exact symbols and never match `currency=SGD`, `unit=base`, or `derived=`
				await db
					.prepare(
						`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name, tracked, tracked_at)
						VALUES ('owner', 'eqc_us_gd', 'US', 'GD', 'sec', 'General Dynamics Corp', 0, '2026-11-01T00:00:00Z'),
						       ('owner', 'eqc_us_tlih', 'US', 'TLIH', 'sec', 'Ten-League International Holdings', 0, '2026-11-06T00:00:00Z')`,
					)
					.run();
				await db
					.prepare(
						`INSERT INTO equity_report_filing (owner_id, filing_id, company_id, provider, source_document_id, form, filed_on, period_end, source_url, facts_status, primary_scope, first_seen_at, recorded_at)
						VALUES ('owner', 'fil_gd', 'eqc_us_gd', 'sec', 'doc_gd', '10-K', '2026-02-01', '2025-12-31', 'https://filings.example.org/gd', 'extracted', 'consolidated', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'),
						       ('owner', 'fil_tlih', 'eqc_us_tlih', 'sec', 'doc_tlih', '20-F', '2026-04-01', '2025-12-31', 'https://filings.example.org/tlih', 'extracted', 'consolidated', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z')`,
					)
					.run();
				await db
					.prepare(
						`INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year, value_decimal, currency, filing_id, concept, scope, period_start, period_end, reported_value_count, updated_at)
						VALUES ('owner', 'eqc_us_gd', 'revenue', 2025, '52550000000', 'USD', 'fil_gd', 'us-gaap:Revenues', 'consolidated', '2025-01-01', '2025-12-31', 1, '2026-11-01T00:00:00Z'),
						       ('owner', 'eqc_us_tlih', 'revenue', 2025, '58496000', 'SGD', 'fil_tlih', 'ifrs-full:Revenue', 'consolidated', '2025-01-01', '2025-12-31', 1, '2026-11-06T00:00:00Z')`,
					)
					.run();

				const gdRev = await repository.search("owner", {
					query: "GD revenue",
					kind: "financials",
					limit: 4,
				});
				expect(gdRev.hits.map((h) => h.recordId)).toEqual(["eqc_us_gd:2025:revenue"]);
				expect(
					(await repository.search("owner", { query: "BA revenue", kind: "financials", limit: 4 }))
						.hits,
				).toEqual([]);
				expect(
					(await repository.search("owner", { query: "DE revenue", kind: "financials", limit: 4 }))
						.hits,
				).toEqual([]);

				// Multi-paragraph 10-K on a thematic company query keeps at most 1 filing paragraph per company, while identity search keeps all paragraphs
				await db
					.prepare(
						`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name, tracked, tracked_at)
						VALUES ('owner', 'eqc_us_hii', 'US', 'HII', 'sec', 'Huntington Ingalls Industries', 0, '2026-11-04T00:00:00Z')`,
					)
					.run();
				await db
					.prepare(
						`INSERT INTO equity_business_description (owner_id, company_id, source_document_id, form, filed_on, period_end, source_url, status, paragraphs_json, truncated, fetched_at)
						VALUES ('owner', 'eqc_us_hii', 'doc_hii', '10-K', '2026-02-10', '2025-12-31', 'https://filings.example.org/hii', 'extracted', ?, 0, '2026-11-04T00:00:00Z')`,
					)
					.bind(
						JSON.stringify([
							{ kind: "text", text: "Shipbuilding segment builds nuclear aircraft carriers." },
							{ kind: "text", text: "Shipbuilding operations also construct submarines." },
							{ kind: "text", text: "Naval shipbuilding backlog reached record levels." },
						]),
					)
					.run();
				const thematicWithHii = await repository.search("owner", {
					query: "造船",
					kind: "company",
					limit: 12,
				});
				expect(
					thematicWithHii.hits.filter((h) => h.recordId.startsWith("eqc_us_hii:")),
				).toHaveLength(1);
				const identityHii = await repository.search("owner", {
					query: "HII shipbuilding",
					kind: "company",
					limit: 12,
				});
				expect(identityHii.hits.filter((h) => h.recordId.startsWith("eqc_us_hii:"))).toHaveLength(
					3,
				);
			} finally {
				db.close();
			}
		});
		it("bounds numeric and ticker terms to whole tokens without breaking fiscal years", async () => {
			const { db, repository } = await setup();
			try {
				const byTicker = await repository.search("owner", {
					query: "7018 純利益",
					kind: "financials",
					limit: 6,
				});
				expect(byTicker.hits.map((hit) => hit.recordId)).toEqual([
					"eqc_jp_7018:2025:profit-attributable-to-owners",
					"eqc_jp_7018:2024:profit-attributable-to-owners",
				]);
				const byTickerAndYear = await repository.search("owner", {
					query: "7018 2025 純利益",
					kind: "financials",
					limit: 6,
				});
				expect(byTickerAndYear.hits.map((hit) => hit.recordId)).toEqual([
					"eqc_jp_7018:2025:profit-attributable-to-owners",
				]);
				const byPrefixedTicker = await repository.search("owner", {
					query: "JP:7018 純利益",
					kind: "financials",
					limit: 6,
				});
				expect(byPrefixedTicker.hits).toHaveLength(2);
				expect(byPrefixedTicker.jpFinancials).toMatchObject([
					{
						symbol: "7018",
						issuerName: "Synthetic Zosen Corporation",
						exchange: "TSE",
						listingVerification: "source-verified",
						fiscalYear: 2025,
						revenue: null,
						revenueUnavailableReason: "not reported",
						netIncome: {
							value: 4_200_000_000,
							currency: "JPY",
							periodStart: "2024-04-01",
							periodEnd: "2025-03-31",
							sourceUrl: "https://api.jquants.com/v2/fins/summary?code=70180",
						},
					},
					{
						symbol: "7018",
						fiscalYear: 2024,
						netIncome: { value: 3_100_000_000, currency: "JPY" },
					},
				]);
			} finally {
				db.close();
			}
		});
	});
