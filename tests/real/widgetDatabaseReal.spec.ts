import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	homeDashboardResponseSchema,
	notebookResponseSchema,
	watchlistResponseSchema,
	workspaceSummarySchema,
} from "@research/contracts";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/** Real dev launcher + SQLite; owner edits need neither a model nor a provider. */
for (const upgrade of [false, true]) {
	test(`widgets wait for database readback and survive a development restart (upgrade=${upgrade})`, async ({
		page,
	}) => {
		const resources = new TestResources();
		try {
			const pristine = makePristineCopy(fileURLToPath(new URL("../..", import.meta.url)));
			resources.add(() => pristine.remove());
			// Reproduce the populated schema immediately before the additive source migration.
			const migration = join(pristine.root, "infra/migrations/0018_widget_earnings_sources.sql");
			const root = mkdtempSync(join(tmpdir(), "research-widget-database-"));
			resources.add(() => rmSync(root, { recursive: true, force: true }));
			if (upgrade) renameSync(migration, join(root, "pending-migration.sql"));
			const origin = "http://localhost:18964";
			const apiOrigin = "http://localhost:18965";
			const environment = launcherEnv({
				dataDir: join(root, "prod"),
				devDataDir: join(root, "dev"),
				releaseDir: join(root, "release"),
				previousDir: join(root, "previous"),
				runnerEnvFile: writeTestRunnerEnvFile(root, {}),
				scratchRoot: join(root, "scratch"),
				webOutDir: join(root, "web"),
				prodPort: "18966",
				devPort: "18964",
				devApiPort: "18965",
			});
			let service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: environment });
			resources.add(async () => {
				await service.stop();
			});
			const headers = ownerHeaders(apiOrigin);
			const created = await page.request.post(`${apiOrigin}/api/v1/workspaces`, {
				headers,
				data: { title: "Database widget check" },
			});
			expect(created.status()).toBe(201);
			const workspace = workspaceSummarySchema.parse(await created.json());
			const path = `/api/v1/workspaces/${workspace.workspaceId}/notebook`;
			await page.goto(`${origin}/#/chat/${workspace.workspaceId}`);
			const notebook = page.getByRole("region", { name: "Notebook", exact: true });
			const widgets = notebook.locator("article[data-widget-id]");
			await expect(notebook.getByRole("button", { name: "Add widget" })).toBeEnabled();
			await expect(widgets).toHaveCount(0);

			let release: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			let reached: () => void = () => {};
			const received = new Promise<void>((resolve) => {
				reached = resolve;
			});
			await page.route(`**${path}`, async (route) => {
				if (route.request().method() !== "PUT") {
					await route.continue();
					return;
				}
				reached();
				await held;
				await route.continue();
			});
			await notebook.getByRole("button", { name: "Add widget" }).click();
			await page.getByRole("menuitem", { name: "Text", exact: true }).click();
			await received;
			// The draft exists only in the write queue; neither database nor widget shows it.
			await expect(widgets).toHaveCount(0);
			const before = await page.request.get(`${apiOrigin}${path}`);
			expect(notebookResponseSchema.parse(await before.json()).notebook.widgets).toEqual([]);
			release();
			await expect(widgets).toHaveCount(1);
			await page.unroute(`**${path}`);
			const committed = notebookResponseSchema.parse(
				await (await page.request.get(`${apiOrigin}${path}`)).json(),
			);
			expect(committed.notebook.widgets).toHaveLength(1);
			await expect(widgets.first()).toHaveAttribute(
				"data-widget-id",
				committed.notebook.widgets[0]?.widgetId ?? "missing",
			);
			// Close the starter's editor before checking its persisted read view.
			await page.keyboard.press("Escape");
			await service.stop();
			if (upgrade) renameSync(join(root, "pending-migration.sql"), migration);
			service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: environment });
			await page.reload();
			await expect(widgets).toHaveCount(1);
			const restored = notebookResponseSchema.parse(
				await (await page.request.get(`${apiOrigin}${path}`)).json(),
			);
			expect(restored).toEqual(committed);
			await page.screenshot({
				path: `test-results-real/widget-database-notebook-upgrade-${upgrade}.png`,
				fullPage: true,
			});
			// The upgrade also exposes the new persisted attribution to an earnings widget.
			const added = await page.request.post(`${apiOrigin}/api/v1/watchlist/stocks`, {
				headers,
				data: { market: "US", symbol: "AAPL" },
			});
			expect(added.ok()).toBe(true);
			const watchlist = watchlistResponseSchema.parse(await added.json());
			expect(watchlist.stocks[0]?.publisher).toBe("Finnhub");
			const home = homeDashboardResponseSchema.parse(
				await (await page.request.get(`${apiOrigin}/api/v1/home/dashboard`)).json(),
			);
			const savedHome = await page.request.put(`${apiOrigin}/api/v1/home/dashboard`, {
				headers,
				data: {
					expectedVersion: home.version,
					dashboard: {
						schemaVersion: 2,
						widgets: [
							{
								widgetId: "earnings-from-database",
								type: "earnings-calendar",
								title: "Earnings",
								size: "large",
								daysAhead: 30,
							},
						],
					},
				},
			});
			expect(savedHome.ok()).toBe(true);
			await page.goto(`${origin}/#/home`);
			await expect(page.locator('article[data-widget-id="earnings-from-database"]')).toBeVisible();
			await expect(page.getByRole("alert")).toHaveCount(0);

			await page.screenshot({
				path: `test-results-real/widget-database-development-upgrade-${upgrade}.png`,
				fullPage: true,
			});
		} finally {
			await resources.close();
		}
	});
}
