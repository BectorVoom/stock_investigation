import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNotebookRepository } from "../../src/sql/repositories.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * The notebook series scan (ADR-0021): one set-based statement over the
 * stored notebook bodies with SQLite JSON functions — no new table, no N+1.
 * Runs here on `node:sqlite`; the API suite runs the same SQL text on D1.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

const STAMP = "2026-10-14T00:00:00.000Z";

function widget(base: Record<string, unknown>) {
	return {
		widgetId: "w-x",
		title: "Widget",
		size: "medium",
		createdAt: STAMP,
		updatedAt: STAMP,
		revision: 1,
		origin: { kind: "owner", messageId: null, runId: null, componentId: null },
		...base,
	};
}

async function insertNotebook(
	db: ReturnType<typeof openNodeSqlite>,
	ownerId: string,
	workspaceId: string,
	body: string,
) {
	await db
		.prepare(
			`INSERT INTO workspace_notebooks (owner_id, workspace_id, body_json, version, last_mutation_id, updated_at)
			VALUES (?, ?, ?, 1, ?, ?)`,
		)
		.bind(ownerId, workspaceId, body, "mut_1", STAMP)
		.run();
}

describe("notebook market series scan (ADR-0021)", () => {
	it("reads the distinct series of every conversation's market widgets, sorted", async () => {
		const db = openMigrated();
		try {
			await insertNotebook(
				db,
				"owner_1",
				"ws_1",
				JSON.stringify({
					widgets: [
						widget({
							widgetId: "w-1",
							type: "line-chart",
							seriesIds: ["fred:VIXCLS", "fred:DGS10"],
							range: "1y",
						}),
						widget({ widgetId: "w-2", type: "text", text: "notes" }),
					],
				}),
			);
			await insertNotebook(
				db,
				"owner_1",
				"ws_2",
				JSON.stringify({
					widgets: [
						widget({
							widgetId: "w-3",
							type: "market-metric",
							size: "small",
							seriesId: "twelve-data:AAPL",
						}),
						widget({
							widgetId: "w-4",
							type: "stock-table",
							seriesIds: ["fred:VIXCLS", "fred:SP500"],
						}),
						widget({ widgetId: "w-5", type: "indicator-table", seriesIds: ["fred:UNRATE"] }),
						// The earnings calendar names no series and is ignored.
						widget({ widgetId: "w-6", type: "earnings-calendar", size: "large", daysAhead: 30 }),
						// A static metric carries no series and is ignored.
						widget({
							widgetId: "w-7",
							type: "metric",
							size: "small",
							value: 3,
							unit: "x",
							change: null,
							caption: "",
							asOf: null,
						}),
					],
				}),
			);
			// Another owner's notebooks never leak in.
			await insertNotebook(
				db,
				"owner_2",
				"ws_9",
				JSON.stringify({
					widgets: [
						widget({
							widgetId: "w-8",
							type: "market-metric",
							size: "small",
							seriesId: "fred:PAYEMS",
						}),
					],
				}),
			);
			const repository = createNotebookRepository(db);
			expect(await repository.listMarketSeriesIds("owner_1")).toEqual([
				"fred:DGS10",
				"fred:SP500",
				"fred:UNRATE",
				"fred:VIXCLS",
				"twelve-data:AAPL",
			]);
			expect(await repository.listMarketSeriesIds("owner_2")).toEqual(["fred:PAYEMS"]);
			expect(await repository.listMarketSeriesIds("owner_missing")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("drops invalid ids and skips unreadable bodies instead of failing", async () => {
		const db = openMigrated();
		try {
			await insertNotebook(
				db,
				"owner_1",
				"ws_1",
				JSON.stringify({
					widgets: [
						widget({ widgetId: "w-1", type: "market-metric", size: "small", seriesId: "nope" }),
						widget({
							widgetId: "w-2",
							type: "line-chart",
							seriesIds: ["fred:VIXCLS", "also-bad"],
							range: "1y",
						}),
						widget({
							widgetId: "w-3",
							type: "market-metric",
							size: "small",
							seriesId: "fred:DGS10",
						}),
					],
				}),
			);
			// A body that no longer parses is skipped, never fatal.
			await insertNotebook(db, "owner_1", "ws_2", "{not json");
			const repository = createNotebookRepository(db);
			expect(await repository.listMarketSeriesIds("owner_1")).toEqual([
				"fred:DGS10",
				"fred:VIXCLS",
			]);
		} finally {
			db.close();
		}
	});

	it("answers [] when the owner has no notebooks", async () => {
		const db = openMigrated();
		try {
			expect(await createNotebookRepository(db).listMarketSeriesIds("owner_1")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("reads the distinct list ids of every notebook's watchlist-prices widgets (ADR-0040)", async () => {
		const db = openMigrated();
		try {
			const prices = (widgetId: string, listId: string) =>
				widget({ widgetId, type: "watchlist-prices", listId });
			await insertNotebook(
				db,
				"owner_1",
				"ws_1",
				JSON.stringify({
					widgets: [
						prices("w-1", "list_b"),
						prices("w-2", "bad id"),
						widget({ widgetId: "w-3", type: "market-metric", size: "small", seriesId: "fred:X" }),
					],
				}),
			);
			await insertNotebook(
				db,
				"owner_1",
				"ws_2",
				JSON.stringify({ widgets: [prices("w-1", "list_a"), prices("w-2", "list_b")] }),
			);
			await insertNotebook(db, "owner_1", "ws_3", "{not json");
			await insertNotebook(
				db,
				"owner_2",
				"ws_1",
				JSON.stringify({ widgets: [prices("w-1", "list_z")] }),
			);
			const repository = createNotebookRepository(db);
			// Sorted, de-duplicated, invalid ids dropped, unreadable bodies skipped.
			expect(await repository.listWatchlistListIds("owner_1")).toEqual(["list_a", "list_b"]);
			expect(await repository.listWatchlistListIds("owner_2")).toEqual(["list_z"]);
			expect(await repository.listWatchlistListIds("owner_missing")).toEqual([]);
		} finally {
			db.close();
		}
	});
});
