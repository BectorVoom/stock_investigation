import { fileURLToPath } from "node:url";
import { type CompanyOverviewView, companyOverviewViewSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import {
	companyOverviewStatement,
	companySummaryStatements,
	createCompanySummaryRepository,
} from "../../src/sql/companySummary.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * The company overview (事業概要, ADR-0064) in `stock_company_summary` on a
 * migrated database: stored whole and read back by the Stocks read's one
 * key seek, beside — never over — the ADR-0060 summary, and refused when
 * it fails its contract or the table's all-or-nothing CHECK.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

const OWNER = "owner_1";

const OVERVIEW: CompanyOverviewView = companyOverviewViewSchema.parse({
	entry: {
		feature: {
			en: "Designs and sells iPhone, Mac and iPad, and related services.",
			ja: "iPhone・Mac・iPadなどを設計・販売。関連サービスも展開。",
			evidence: [{ source: "S2", quote: "designs, manufactures and markets smartphones" }],
		},
		businesses: [],
		segments: [],
		overseasSales: null,
		profile: [
			{
				field: "employees",
				value: { en: "About 166,000 (Sep 27, 2025)", ja: "約16.6万人(2025年9月27日時点)" },
				evidence: [{ source: "S2", quote: "approximately 166,000 full-time equivalent employees" }],
			},
		],
		themes: [],
	},
	facts: {
		listing: "nasdaq",
		sector: null,
		fiscalYearEnd: "09-26",
		figures: [
			{
				metric: "revenue",
				fiscalYear: 2025,
				periodEnd: "2025-09-27",
				value: "416161000000",
				currency: "USD",
			},
		],
		cites: { listing: "S1", sector: null, figures: "S3" },
	},
	references: [
		{
			id: "S1",
			title: { en: "SEC company tickers", ja: "SEC 登録企業ティッカー一覧" },
			publisher: "U.S. SEC",
			asOf: null,
			url: "https://www.sec.gov/files/company_tickers_exchange.json",
			note: null,
		},
		{
			id: "S2",
			title: { en: "Form 10-K, Item 1", ja: "Form 10-K 第1項" },
			publisher: "U.S. SEC EDGAR",
			asOf: "2025-09-27",
			url: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
			note: { en: "Filed 2025-10-31.", ja: "2025-10-31 提出。" },
		},
		{
			id: "S3",
			title: { en: "Form 10-K financial statements", ja: "Form 10-K 財務諸表" },
			publisher: "U.S. SEC EDGAR (XBRL)",
			asOf: "2025-09-27",
			url: null,
			note: null,
		},
	],
	agentId: "claude-api",
	model: "claude-haiku-5-5",
	generatedAt: "2026-11-02T23:30:39.229Z",
});

describe("company overview storage (ADR-0064)", () => {
	it("stores an overview whole and reads it back with no summary beside it", async () => {
		const db = openMigrated();
		try {
			const repository = createCompanySummaryRepository(db);
			expect(await repository.get(OWNER, "US", "AAPL")).toEqual({ summary: null, overview: null });
			await db.batch([companyOverviewStatement(db, OWNER, "US", "AAPL", OVERVIEW)]);
			expect(await repository.get(OWNER, "US", "AAPL")).toEqual({
				summary: null,
				overview: OVERVIEW,
			});
			// A new row is queued at the write time, so the summary schedule sees it.
			expect(await repository.listSchedule(OWNER)).toEqual([
				{ market: "US", symbol: "AAPL", queuedAt: OVERVIEW.generatedAt, generatedAt: null },
			]);
		} finally {
			db.close();
		}
	});

	it("keeps the summary when an overview is stored, and the overview when a summary is", async () => {
		const db = openMigrated();
		try {
			const repository = createCompanySummaryRepository(db);
			const summary = {
				description: { en: "Apple makes iPhone.", ja: "iPhone を製造。" },
				themes: [{ en: "Smartphones", ja: "スマートフォン" }],
			};
			const summarized = (generatedAt: string) =>
				companySummaryStatements(
					db,
					OWNER,
					{
						market: "US",
						symbol: "AAPL",
						summary,
						agentId: "claude-code",
						model: null,
						generatedAt,
					},
					{ sql: "1 = 1", values: [] },
				);
			await db.batch(summarized("2026-11-01T00:00:00.000Z"));
			await db.batch([companyOverviewStatement(db, OWNER, "US", "AAPL", OVERVIEW)]);
			await db.batch(summarized("2026-11-03T00:00:00.000Z"));
			const stored = await repository.get(OWNER, "US", "AAPL");
			expect(stored.overview).toEqual(OVERVIEW);
			expect(stored.summary?.description).toEqual(summary.description);
			expect(stored.summary?.generatedAt).toBe("2026-11-03T00:00:00.000Z");
		} finally {
			db.close();
		}
	});

	it("refuses an overview that cites a source it does not list, and a partial row", async () => {
		const db = openMigrated();
		try {
			const unlisted = { ...OVERVIEW, references: OVERVIEW.references.slice(0, 1) };
			expect(() => companyOverviewStatement(db, OWNER, "US", "AAPL", unlisted)).toThrow(
				/every cited source must be in the references/,
			);
			await expect(
				db
					.prepare(
						`INSERT INTO stock_company_summary (owner_id, market, symbol, queued_at, overview_json)
						VALUES (?, 'US', 'AAPL', ?, '{}')`,
					)
					.bind(OWNER, OVERVIEW.generatedAt)
					.run(),
			).rejects.toThrow(/CHECK constraint failed/);
		} finally {
			db.close();
		}
	});
});
