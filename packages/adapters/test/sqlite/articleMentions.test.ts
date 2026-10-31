import { fileURLToPath } from "node:url";
import { mentionLikePattern, type StockMentionTerm } from "@research/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createArticleRepository } from "../../src/sql/repositories.ts";
import {
	initializeSqlSchema,
	type NodeSqliteDatabase,
	openNodeSqlite,
	readSqlMigrations,
	readSqlSchema,
} from "../../src/sqlite/index.ts";

/**
 * The Stocks page's News read (ADR-0049 §7) on `node:sqlite`: the `LIKE`
 * prefilter with its escapes, the newest-first order, the strict cursor
 * bound, owner isolation and the article stamp. D1 runs the same SQL text
 * through the API suite.
 */
const opened: NodeSqliteDatabase[] = [];
afterEach(() => {
	for (const db of opened.splice(0)) db.close();
});

function openInitialized(): NodeSqliteDatabase {
	const db = openNodeSqlite(":memory:");
	opened.push(db);
	initializeSqlSchema(
		db,
		readSqlSchema(fileURLToPath(new URL("../../../../db/schema.sql", import.meta.url))),
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

let fingerprintCounter = 0;

async function insertArticle(
	db: NodeSqliteDatabase,
	row: {
		readonly ownerId?: string;
		readonly articleId: string;
		readonly title: string;
		readonly excerpt?: string | null;
		readonly retrievedAt: string;
	},
): Promise<void> {
	fingerprintCounter += 1;
	await db
		.prepare(
			`INSERT INTO articles (owner_id, article_id, source_id, canonical_url, publisher, title,
				published_at, retrieved_at, content_fingerprint, excerpt)
			VALUES (?, ?, 'src_feed', ?, 'Example News', ?, NULL, ?, ?, ?)`,
		)
		.bind(
			row.ownerId ?? "owner_1",
			row.articleId,
			`https://news.example.org/${row.articleId}`,
			row.title,
			row.retrievedAt,
			fingerprintCounter.toString(16).padStart(64, "0"),
			row.excerpt ?? null,
		)
		.run();
}

const name = (text: string): StockMentionTerm => ({ text, kind: "name" });
const patternsOf = (...terms: StockMentionTerm[]) => terms.map(mentionLikePattern);

describe("listMentionCandidates", () => {
	it("matches the title or the excerpt, newest first, with ties broken by article id", async () => {
		const db = openInitialized();
		await insertArticle(db, {
			articleId: "art_a",
			title: "Apple results",
			retrievedAt: "2026-10-01T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_b",
			title: "Quarterly results",
			excerpt: "apple beat estimates",
			retrievedAt: "2026-10-02T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_c",
			title: "Apple again",
			retrievedAt: "2026-10-02T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_d",
			title: "Oranges",
			retrievedAt: "2026-10-03T00:00:00.000Z",
		});
		const repository = createArticleRepository(db);
		const rows = await repository.listMentionCandidates("owner_1", {
			patterns: patternsOf(name("Apple")),
			before: null,
			limit: 10,
		});
		// LIKE folds ASCII case: "apple" in the excerpt is a candidate too.
		expect(rows.map((row) => row.articleId)).toEqual(["art_c", "art_b", "art_a"]);
		expect(rows[1]?.excerpt).toBe("apple beat estimates");
	});

	it("reads strictly below the cursor key and stops at the limit", async () => {
		const db = openInitialized();
		for (let index = 0; index < 6; index += 1) {
			await insertArticle(db, {
				articleId: `art_${index}`,
				title: `Apple ${index}`,
				retrievedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
			});
		}
		const repository = createArticleRepository(db);
		const patterns = patternsOf(name("Apple"));
		const first = await repository.listMentionCandidates("owner_1", {
			patterns,
			before: null,
			limit: 2,
		});
		expect(first.map((row) => row.articleId)).toEqual(["art_5", "art_4"]);
		const last = first.at(-1);
		if (last === undefined) throw new Error("no rows");
		const next = await repository.listMentionCandidates("owner_1", {
			patterns,
			before: { retrievedAt: last.retrievedAt, articleId: last.articleId },
			limit: 10,
		});
		expect(next.map((row) => row.articleId)).toEqual(["art_3", "art_2", "art_1", "art_0"]);
		// Same retrieval time, smaller id: still below the key.
		await insertArticle(db, {
			articleId: "art_3a",
			title: "Apple tie",
			retrievedAt: "2026-10-04T00:00:00.000Z",
		});
		const tie = await repository.listMentionCandidates("owner_1", {
			patterns,
			before: { retrievedAt: "2026-10-04T00:00:00.000Z", articleId: "art_3b" },
			limit: 2,
		});
		expect(tie.map((row) => row.articleId)).toEqual(["art_3a", "art_3"]);
	});

	it("treats %, _ and \\ in a term as themselves, and a separator as one character", async () => {
		const db = openInitialized();
		await insertArticle(db, {
			articleId: "art_pct",
			title: "Save 100% now",
			retrievedAt: "2026-10-01T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_pc",
			title: "Save 100 percent now",
			retrievedAt: "2026-10-02T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_us",
			title: "A_B Corp",
			retrievedAt: "2026-10-03T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_ax",
			title: "AxB Corp",
			retrievedAt: "2026-10-04T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_bs",
			title: "Back\\slash Ltd",
			retrievedAt: "2026-10-05T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_hy",
			title: "Coca-Cola deal",
			retrievedAt: "2026-10-06T00:00:00.000Z",
		});
		const repository = createArticleRepository(db);
		const ids = async (term: StockMentionTerm) =>
			(
				await repository.listMentionCandidates("owner_1", {
					patterns: patternsOf(term),
					before: null,
					limit: 10,
				})
			).map((row) => row.articleId);
		expect(await ids(name("100% now"))).toEqual(["art_pct"]);
		expect(await ids(name("A_B"))).toEqual(["art_us"]);
		expect(await ids(name("Back\\slash"))).toEqual(["art_bs"]);
		// A space in a term is `_`: it lets the hyphen through (the domain decides).
		expect(await ids(name("Coca Cola"))).toEqual(["art_hy"]);
	});

	it("matches any of several patterns and Japanese text exactly", async () => {
		const db = openInitialized();
		await insertArticle(db, {
			articleId: "art_jp",
			title: "任天堂が新型機",
			retrievedAt: "2026-10-01T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_en",
			title: "Nintendo shares",
			retrievedAt: "2026-10-02T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_no",
			title: "任天 only",
			retrievedAt: "2026-10-03T00:00:00.000Z",
		});
		const repository = createArticleRepository(db);
		const rows = await repository.listMentionCandidates("owner_1", {
			patterns: patternsOf(name("Nintendo"), name("任天堂")),
			before: null,
			limit: 10,
		});
		expect(rows.map((row) => row.articleId)).toEqual(["art_en", "art_jp"]);
	});

	it("never returns another owner's articles", async () => {
		const db = openInitialized();
		await insertArticle(db, {
			articleId: "art_mine",
			title: "Apple",
			retrievedAt: "2026-10-01T00:00:00.000Z",
		});
		await insertArticle(db, {
			ownerId: "owner_2",
			articleId: "art_theirs",
			title: "Apple",
			retrievedAt: "2026-10-02T00:00:00.000Z",
		});
		const repository = createArticleRepository(db);
		const rows = await repository.listMentionCandidates("owner_1", {
			patterns: patternsOf(name("Apple")),
			before: null,
			limit: 10,
		});
		expect(rows.map((row) => row.articleId)).toEqual(["art_mine"]);
	});
});

describe("stamp", () => {
	it("is zero and null for an owner without articles, then the count and the newest key", async () => {
		const db = openInitialized();
		const repository = createArticleRepository(db);
		expect(await repository.stamp("owner_1")).toEqual({ articleCount: 0, newest: null });
		await insertArticle(db, {
			articleId: "art_a",
			title: "One",
			retrievedAt: "2026-10-02T00:00:00.000Z",
		});
		await insertArticle(db, {
			articleId: "art_b",
			title: "Two",
			retrievedAt: "2026-10-01T00:00:00.000Z",
		});
		await insertArticle(db, {
			ownerId: "owner_2",
			articleId: "art_c",
			title: "Three",
			retrievedAt: "2026-10-09T00:00:00.000Z",
		});
		expect(await repository.stamp("owner_1")).toEqual({
			articleCount: 2,
			newest: { retrievedAt: "2026-10-02T00:00:00.000Z", articleId: "art_a" },
		});
	});
});
