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
import { seedStockResearch } from "../sql/stockResearchFixtures.ts";

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
		it("searches every corpus with exact decimals, lineage and owner isolation", async () => {
			const { db, repository } = await setup();
			try {
				const result = await repository.search("owner", { query: "solar", limit: 6 });
				expect(new Set(result.hits.map((hit) => hit.kind))).toEqual(
					new Set(["company", "financials", "news"]),
				);
				const financial = result.hits.find((hit) => hit.kind === "financials");
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
	});
