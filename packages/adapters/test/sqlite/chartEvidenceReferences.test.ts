import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createChartEvidenceReferences } from "../../src/sql/repositories.ts";
import { applySqlMigrations, openNodeSqlite, readSqlMigrations } from "../../src/sqlite/index.ts";

/**
 * ADR-0026: the evidence chart copies cite, on Home and in every other
 * notebook — one set-based statement, the same SQL text D1 runs.
 */
function openMigrated() {
	const db = openNodeSqlite(":memory:");
	applySqlMigrations(
		db,
		readSqlMigrations(fileURLToPath(new URL("../../../../infra/migrations", import.meta.url))),
	);
	return db;
}

const STAMP = "2026-10-17T00:00:00.000Z";

const chart = (widgetId: string, evidenceIds: readonly string[]) => ({
	widgetId,
	type: "chart",
	title: "Chart",
	size: "medium",
	chartType: "line",
	unit: "USD",
	series: [{ name: "P", points: [{ x: "Mon", y: 1 }] }],
	sources: evidenceIds.map((evidenceId) => ({ evidenceId })),
});

describe("chart evidence references (ADR-0026)", () => {
	it("lists ids cited by chart copies on Home and in other notebooks only", async () => {
		const db = openMigrated();
		try {
			const notebook = async (ownerId: string, workspaceId: string, widgets: unknown[]) =>
				db
					.prepare(
						`INSERT INTO workspace_notebooks (owner_id, workspace_id, body_json, version, last_mutation_id, updated_at)
						VALUES (?, ?, ?, 1, 'mut_1', ?)`,
					)
					.bind(ownerId, workspaceId, JSON.stringify({ widgets }), STAMP)
					.run();
			await notebook("owner_1", "ws_doomed", [chart("w-1", ["ev_doomed_only"])]);
			await notebook("owner_1", "ws_other", [
				chart("w-2", ["ev_shared", "ev_other"]),
				{ widgetId: "w-3", type: "text", title: "T", size: "small", text: "x" },
			]);
			await notebook("owner_2", "ws_foreign", [chart("w-4", ["ev_foreign"])]);
			await notebook("owner_1", "ws_broken", []);
			await db
				.prepare(
					`UPDATE workspace_notebooks SET body_json = 'not json' WHERE workspace_id = 'ws_broken'`,
				)
				.run();
			await db
				.prepare(
					`INSERT INTO home_dashboards (owner_id, dashboard_json, version, updated_at) VALUES (?, ?, 1, ?)`,
				)
				.bind(
					"owner_1",
					JSON.stringify({ schemaVersion: 2, widgets: [chart("w-h", ["ev_home", "ev_shared"])] }),
					STAMP,
				)
				.run();

			const ids = await createChartEvidenceReferences(db).listChartEvidenceIds(
				"owner_1",
				"ws_doomed",
			);
			expect([...ids].sort()).toEqual(["ev_home", "ev_other", "ev_shared"]);
		} finally {
			db.close();
		}
	});
});
