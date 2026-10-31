import { expect, test } from "@playwright/test";
import { homeDashboardResponseSchema } from "@research/contracts";
import { materialFixture } from "../../examples/materials/fixture.ts";
import { E2E_ORIGIN } from "./fixtures.ts";

test("material database feeds chart and indicator widgets and survives reload", async ({
	page,
}) => {
	const headers = {
		Origin: E2E_ORIGIN,
		"X-Research-Csrf": "1",
		"Content-Type": "application/json",
	};
	const imported = await page.request.post(`${E2E_ORIGIN}/api/v1/materials/imports`, {
		headers,
		data: materialFixture,
	});
	expect(imported.status()).toBe(201);
	const read = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	const stored = homeDashboardResponseSchema.parse(await read.json());
	const saved = await page.request.put(`${E2E_ORIGIN}/api/v1/home/dashboard`, {
		headers,
		data: {
			expectedVersion: stored.version,
			dashboard: {
				schemaVersion: 2,
				widgets: [
					{
						widgetId: "material-chart",
						type: "line-chart",
						title: "Material chart",
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
	await page.goto("/#/home");
	const chart = page.locator('article[data-widget-id="material-chart"]');
	const table = page.locator('article[data-widget-id="material-table"]');
	await expect(chart.locator("svg path").first()).toBeVisible();
	await expect(table).toContainText("72.5");
	await expect(table).toContainText("USD/kg product");
	await expect(table.getByRole("link").first()).toHaveAttribute(
		"href",
		"https://example.com/materials/neodymium",
	);
	await table.getByText("Material details", { exact: true }).click();
	await expect(table).toContainText("2026-01-02T10:45:30.000Z");
	await expect(table).toContainText("Synthetic 99.5%");
	await page.screenshot({
		path: `test-results/materials-details-${process.env.REVIEW_BROWSER ?? process.env.E2E_BROWSER ?? "chrome"}.png`,
		fullPage: true,
	});
	await page.reload();
	await expect(table).toContainText("72.5");
	await page.getByRole("button", { name: "Add widget", exact: true }).click();
	await page.getByRole("menuitem", { name: "Indicator table", exact: true }).click();
	await expect(page.locator("sl-dialog sl-option[value='materials:NDTESTV1']")).toBeAttached();
	await page.screenshot({
		path: `test-results/materials-${process.env.REVIEW_BROWSER ?? process.env.E2E_BROWSER ?? "chrome"}.png`,
		fullPage: true,
	});
});
