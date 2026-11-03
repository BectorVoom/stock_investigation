import { fileURLToPath } from "node:url";
import {
	type CompanyOverviewView,
	type CompanySummary,
	companyOverviewViewSchema,
} from "@research/contracts";
import { themeNeedle } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	companyOverviewStatement,
	companySummaryStatements,
	createCompanySummaryRepository,
} from "../../src/sql/companySummary.ts";
import type { SqlDatabase } from "../../src/sql/database.ts";
import {
	applySqlMigrations,
	initializeSqlSchema,
	openNodeSqlite,
	readSqlMigrations,
	readSqlSchema,
} from "../../src/sqlite/index.ts";

/**
 * The searchable theme names (ADR-0066) on real SQLite: the triggers keep
 * `theme_names` equal to the themes the Company tab shows — the overview's
 * when one is stored, else the summary's — on a migrated database and on
 * one built from `db/schema.sql`, and `searchThemes` finds the owner's
 * stocks by a folded, JSON-escaped needle.
 */
const MIGRATIONS = fileURLToPath(new URL("../../../../infra/migrations", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../../../../db/schema.sql", import.meta.url));

function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(db, readSqlMigrations(MIGRATIONS));
	return db;
}

function openFromSchema() {
	const db = openNodeSqlite(":memory:");
	initializeSqlSchema(db, readSqlSchema(SCHEMA), readSqlMigrations(MIGRATIONS));
	return db;
}

const OWNER = "owner_1";
const OTHER = "owner_2";

function summarize(
	db: SqlDatabase,
	owner: string,
	market: "US" | "JP",
	symbol: string,
	themes: CompanySummary["themes"],
) {
	return db.batch(
		companySummaryStatements(
			db,
			owner,
			{
				market,
				symbol,
				summary: { description: { en: "A company.", ja: "企業。" }, themes },
				agentId: "claude-code",
				model: null,
				generatedAt: "2026-11-01T00:00:00.000Z",
			},
			{ sql: "1 = 1", values: [] },
		),
	);
}

function overviewWithThemes(labels: readonly { en: string; ja: string }[]): CompanyOverviewView {
	return companyOverviewViewSchema.parse({
		entry: {
			feature: null,
			businesses: [],
			segments: [],
			overseasSales: null,
			profile: [],
			themes: labels.map((label) => ({
				label,
				reason: {
					en: "Sells it.",
					ja: "販売する。",
					evidence: [{ source: "S1", quote: "organic vegetables" }],
				},
			})),
		},
		facts: {
			listing: null,
			sector: null,
			fiscalYearEnd: null,
			figures: [],
			cites: { listing: null, sector: null, figures: null },
		},
		references: [
			{
				id: "S1",
				title: { en: "Company site", ja: "企業サイト" },
				publisher: "example.com",
				asOf: null,
				url: "https://example.com/",
				note: null,
			},
		],
		agentId: "claude-api",
		model: "claude-haiku-5-5",
		generatedAt: "2026-11-03T00:00:00.000Z",
	});
}

async function storedThemeNames(db: SqlDatabase, symbol: string): Promise<unknown> {
	const row = await db
		.prepare("SELECT theme_names FROM stock_company_summary WHERE owner_id = ? AND symbol = ?")
		.bind(OWNER, symbol)
		.first();
	return row?.theme_names ?? null;
}

describe.each([
	["migrated", openMigrated],
	["built from db/schema.sql", openFromSchema],
])("theme names on a %s database (ADR-0066)", (_label, open) => {
	it("follow the summary, then the overview, and stay null for a row only queued", async () => {
		const db = open();
		try {
			const repository = createCompanySummaryRepository(db);
			await repository.markQueued(OWNER, "JP", "1380", "2026-11-01T00:00:00.000Z");
			expect(await storedThemeNames(db, "1380")).toBeNull();
			await summarize(db, OWNER, "JP", "1380", [{ en: "Poultry", ja: "鶏肉" }]);
			expect(await storedThemeNames(db, "1380")).toBe('[["Poultry","鶏肉"]]');
			await db.batch([
				companyOverviewStatement(
					db,
					OWNER,
					"JP",
					"1380",
					overviewWithThemes([{ en: "Organic Vegetables", ja: "無農薬野菜" }]),
				),
			]);
			// The overview's themes are the ones shown, so they replace the summary's.
			expect(await storedThemeNames(db, "1380")).toBe('[["Organic Vegetables","無農薬野菜"]]');
			// A later summary leaves the shown (overview) themes in place.
			await summarize(db, OWNER, "JP", "1380", [{ en: "Eggs", ja: "鶏卵" }]);
			expect(await storedThemeNames(db, "1380")).toBe('[["Organic Vegetables","無農薬野菜"]]');
		} finally {
			db.close();
		}
	});

	it("are searched by the owner's needle, with the stock list's names", async () => {
		const db = open();
		try {
			await db
				.prepare(
					`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
						symbol_key, name_key, local_name_key, search_key)
					VALUES (?, 'JP', '1380', 'AKIKAWA FOODS & FARMS CO.,LTD.', '秋川牧園', 'prime', '1380', 'a', 'a', 'a')`,
				)
				.bind(OWNER)
				.run();
			await summarize(db, OWNER, "JP", "1380", [
				{ en: "Organic Vegetables", ja: "無農薬野菜" },
				{ en: 'Free-range "Chicken"', ja: "平飼い鶏" },
			]);
			await summarize(db, OWNER, "US", "KO", [{ en: "Soft Drinks", ja: "清涼飲料" }]);
			await summarize(db, OTHER, "US", "PEP", [{ en: "Organic Snacks", ja: "有機スナック" }]);
			const repository = createCompanySummaryRepository(db);
			const found = await repository.searchThemes(OWNER, themeNeedle("ORGANIC"));
			expect(found).toEqual([
				{
					market: "JP",
					symbol: "1380",
					name: "AKIKAWA FOODS & FARMS CO.,LTD.",
					localName: "秋川牧園",
					themes: [
						{ en: "Organic Vegetables", ja: "無農薬野菜" },
						{ en: 'Free-range "Chicken"', ja: "平飼い鶏" },
					],
				},
			]);
			// Japanese, a quote inside a name, and a stock outside the stock lists.
			expect(
				(await repository.searchThemes(OWNER, themeNeedle("野菜"))).map((r) => r.symbol),
			).toEqual(["1380"]);
			expect(
				(await repository.searchThemes(OWNER, themeNeedle('"Chicken"'))).map((r) => r.symbol),
			).toEqual(["1380"]);
			const drinks = await repository.searchThemes(OWNER, themeNeedle("drinks"));
			expect(drinks.map((r) => [r.symbol, r.name])).toEqual([["KO", null]]);
			expect(await repository.searchThemes(OWNER, themeNeedle("snacks"))).toEqual([]);
		} finally {
			db.close();
		}
	});
});
