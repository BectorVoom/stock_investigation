import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	startLauncher,
	stashMigrationsFrom,
	TestResources,
} from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MIGRATION = "0037_stock_margin_balances.sql";
const OWNER = "owner@localhost";
const API = "http://localhost:8931";
const WEB = "http://localhost:8930";

function databasePath(directory: string): string {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = databasePath(path);
			if (nested !== "") return nested;
		} else if (entry.name.endsWith(".sqlite")) {
			const db = new DatabaseSync(path, { readOnly: true });
			try {
				if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'stock_directory'").get())
					return path;
			} finally {
				db.close();
			}
		}
	}
	return "";
}

// Synthetic share counts; actual dev launcher, D1 migration runner and browser.
// No provider or model credentials; all directories and ports are isolated.
test("fresh and populated version-36 dev installations support margin share counts across restart", async ({
	page,
}) => {
	test.setTimeout(900_000);
	const resources = new TestResources();
	try {
		const copy = makePristineCopy(ROOT);
		resources.add(() => copy.remove());
		const extra = mkdtempSync(join(tmpdir(), "research-margin-upgrade-"));
		resources.add(() => rmSync(extra, { recursive: true, force: true }));
		const data = join(extra, "dev-data");
		const runnerEnvFile = writeTestRunnerEnvFile(extra, {});
		const env = (devDataDir: string) =>
			launcherEnv({
				dataDir: join(extra, "prod-data"),
				devDataDir,
				releaseDir: join(extra, "release"),
				previousDir: join(extra, "previous"),
				runnerEnvFile,
				scratchRoot: join(extra, "scratch"),
				webOutDir: join(extra, "web"),
				prodPort: "19030",
				devPort: "8930",
				devApiPort: "8931",
			});
		const stash = stashMigrationsFrom(
			join(copy.root, "infra/migrations"),
			MIGRATION,
			join(extra, "stash"),
		);
		resources.add(() => stash.restore());
		const before = await startLauncher({ cwd: copy.root, args: ["dev"], env: env(data) });
		try {
			const db = new DatabaseSync(databasePath(data));
			try {
				expect(
					db
						.prepare(
							"SELECT name FROM pragma_table_info('stock_directory') WHERE name = 'margin_buying_balance'",
						)
						.get(),
				).toBeUndefined();
				db.prepare(`INSERT INTO stock_directory (owner_id, market, symbol, name, listing,
                    symbol_key, name_key, local_name_key, search_key)
                    VALUES (?, 'US', 'ZZZZ', 'Margin Upgrade Probe', 'nyse', 'zzzz', 'margin upgrade probe', '', 'zzzz margin upgrade probe')`).run(
					OWNER,
				);
			} finally {
				db.close();
			}
		} finally {
			await before.stop();
		}
		stash.restore();

		const pageErrors: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		for (const phase of ["upgrade", "restart", "fresh"] as const) {
			const phaseData = phase === "fresh" ? join(extra, "fresh-data") : data;
			const launcher = await startLauncher({ cwd: copy.root, args: ["dev"], env: env(phaseData) });
			try {
				const db = new DatabaseSync(databasePath(phaseData));
				try {
					expect(
						db
							.prepare(
								"SELECT name FROM pragma_table_info('stock_directory') WHERE name LIKE 'margin_%' ORDER BY cid",
							)
							.all(),
					).toEqual([{ name: "margin_buying_balance" }, { name: "margin_selling_balance" }]);
					if (phase !== "fresh") {
						expect(
							db
								.prepare(
									"SELECT margin_buying_balance, margin_selling_balance FROM stock_directory WHERE owner_id = ? AND symbol = 'ZZZZ'",
								)
								.get(OWNER),
						).toEqual({
							margin_buying_balance: phase === "upgrade" ? null : 12345600,
							margin_selling_balance: phase === "upgrade" ? null : 0,
						});
						db.prepare(
							"UPDATE stock_directory SET margin_buying_balance = 12345600, margin_selling_balance = 0 WHERE owner_id = ? AND symbol = 'ZZZZ'",
						).run(OWNER);
					}
					expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
				} finally {
					db.close();
				}
				const response = await fetch(`${API}/api/v1/stocks/us:ZZZZ`, {
					headers: ownerHeaders(API),
				});
				// The fresh database has no synthetic listing; use the stored-list status instead.
				if (phase !== "fresh") expect(response.status).toBe(200);
				const status = await fetch(`${API}/api/v1/watchlist/directory`, {
					headers: ownerHeaders(API),
				});
				expect(status.ok).toBe(true);
				await page.goto(`${WEB}/#/stocks${phase === "fresh" ? "" : "/us:ZZZZ/company"}`);
				await expect(page.getByRole("heading", { level: 2, name: "Stocks" })).toBeVisible({
					timeout: 60_000,
				});
				if (phase !== "fresh")
					await expect(page.getByText("Margin Upgrade Probe").first()).toBeVisible();
				expect(pageErrors).toEqual([]);
			} finally {
				await launcher.stop();
			}
		}
	} finally {
		await resources.close();
	}
});
