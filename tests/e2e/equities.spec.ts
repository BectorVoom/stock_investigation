import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

test("imports and inspects a two-market financial library", async ({ page }, info) => {
	await page.goto("/#/equities");
	await expect(
		page.getByText("No companies imported yet. Import a financial data file to begin."),
	).toBeVisible();
	await page
		.getByLabel("Financial data file")
		.setInputFiles(
			fileURLToPath(new URL("../../examples/equities/synthetic.json", import.meta.url)),
		);
	await expect(page.getByText(/records ready to import/)).toBeVisible();
	await page.getByRole("button", { name: "Import file", exact: true }).click();
	await page.getByRole("button", { name: /Example US Industries/ }).click();
	await expect(page.getByText("9007199254740993.25", { exact: true })).toBeVisible();
	await expect(page.getByRole("link", { name: "Synthetic US annual statement" })).toHaveAttribute(
		"href",
		"https://example.com/us",
	);
	await page.getByText("Provenance", { exact: true }).click();
	await expect(page.getByText("example:Revenue", { exact: true })).toBeVisible();
	const out = `test-results/equities-${process.env.E2E_BROWSER ?? "chrome"}`;
	mkdirSync(out, { recursive: true });
	for (const width of [1440, 820, 390]) {
		await page.setViewportSize({ width, height: 900 });
		await expect(page.locator("html")).toHaveJSProperty("scrollWidth", width);
		await page.screenshot({ path: `${out}/library-${width}.png`, fullPage: true });
	}
	await page
		.getByLabel("Public information cutoff (UTC, optional)")
		.fill("2026-04-01T00:00:00.000Z");
	await page.getByRole("button", { name: "Apply filters" }).click();
	await expect(page.getByText("No financial facts are available for these filters.")).toBeVisible();
	await page.getByLabel("Public information cutoff (UTC, optional)").fill("");
	await page.getByRole("button", { name: "Apply filters" }).click();
	await page.getByRole("button", { name: /サンプル日本工業/ }).click();
	await expect(page.getByText("1234567890123", { exact: true })).toBeVisible();
	const downloadPromise = page.waitForEvent("download");
	await page.getByRole("button", { name: "Download import", exact: true }).first().click();
	const download = await downloadPromise;
	expect(download.suggestedFilename()).toMatch(/^eqimp.*\.json$/);
	await info.attach("equities-library", {
		path: `${out}/library-390.png`,
		contentType: "image/png",
	});
});
