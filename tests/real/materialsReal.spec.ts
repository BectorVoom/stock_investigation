import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { homeDashboardResponseSchema } from "@research/contracts";
import { materialFixture } from "../../examples/materials/fixture.ts";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/** Actual dev launcher and SQLite, owner-import positive path; no provider or model calls needed. */
test("the development app renders imported material database prices after restart", async ({
	page,
}) => {
	test.setTimeout(600_000);
	const resources = new TestResources();
	try {
		const pristine = makePristineCopy(fileURLToPath(new URL("../..", import.meta.url)));
		resources.add(() => pristine.remove());
		const root = mkdtempSync(join(tmpdir(), "research-real-materials-"));
		resources.add(() => rmSync(root, { recursive: true, force: true }));
		const origin = "http://localhost:18974";
		const apiOrigin = "http://localhost:18975";
		const environment = launcherEnv({
			dataDir: join(root, "prod"),
			devDataDir: join(root, "dev"),
			releaseDir: join(root, "release"),
			previousDir: join(root, "previous"),
			runnerEnvFile: writeTestRunnerEnvFile(root, {}),
			scratchRoot: join(root, "scratch"),
			webOutDir: join(root, "web"),
			prodPort: "18976",
			devPort: "18974",
			devApiPort: "18975",
		});
		let service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: environment });
		resources.add(async () => {
			await service.stop();
		});
		const headers = ownerHeaders(apiOrigin);
		const imported = await page.request.post(`${apiOrigin}/api/v1/materials/imports`, {
			headers,
			data: materialFixture,
		});
		expect(imported.status()).toBe(201);
		const read = await page.request.get(`${apiOrigin}/api/v1/home/dashboard`);
		const dashboard = homeDashboardResponseSchema.parse(await read.json());
		const saved = await page.request.put(`${apiOrigin}/api/v1/home/dashboard`, {
			headers,
			data: {
				expectedVersion: dashboard.version,
				dashboard: {
					schemaVersion: 2,
					widgets: [
						{
							widgetId: "material-chart",
							type: "line-chart",
							title: "Physical materials",
							size: "medium",
							seriesIds: ["materials:NDTESTV1"],
							range: "max",
						},
						{
							widgetId: "material-table",
							type: "indicator-table",
							title: "Material indicators",
							size: "large",
							seriesIds: ["materials:NDTESTV1"],
						},
					],
				},
			},
		});
		expect(saved.ok()).toBe(true);
		await page.goto(`${origin}/#/home`);
		const table = page.locator('article[data-widget-id="material-table"]');
		await expect(table).toContainText("72.5");
		await expect(table).toContainText("USD/kg product");
		await expect(
			page.locator('article[data-widget-id="material-chart"] svg path').first(),
		).toBeVisible();
		await service.stop();
		service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: environment });
		await page.reload();
		await expect(table).toContainText("72.5");
		await page.screenshot({ path: "test-results-real/materials-development.png", fullPage: true });
	} finally {
		await resources.close();
	}
});
