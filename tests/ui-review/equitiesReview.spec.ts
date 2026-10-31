import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const engine = process.env.REVIEW_BROWSER ?? "chrome";
const out = `test-results/ui-review/${engine}/equities`;
const viewports = [
	{ width: 1440, height: 900 },
	{ width: 1280, height: 720 },
	{ width: 820, height: 1180 },
	{ width: 390, height: 844 },
];
test.use({ extraHTTPHeaders: { "X-E2E-Owner": `ui-review-equities-${Date.now()}@example.test` } });

test("review equities import, financial provenance and historical filters", async ({ page }) => {
	mkdirSync(out, { recursive: true });
	const findings: { state: string; rule: string }[] = [];
	page.on("pageerror", () => findings.push({ state: "page", rule: "page-error" }));
	async function capture(page: Page, state: string): Promise<void> {
		for (const size of viewports) {
			await page.setViewportSize(size);
			await page.screenshot({ path: `${out}/${state}-${size.width}.png`, fullPage: true });
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > window.innerWidth,
			);
			if (overflow) findings.push({ state: `${state}-${size.width}`, rule: "page-overflow" });
		}
	}
	await page.goto("/#/equities");
	await expect(
		page.getByText("No companies imported yet. Import a financial data file to begin."),
	).toBeVisible();
	await capture(page, "empty");
	await page
		.getByLabel("Financial data file")
		.setInputFiles(
			fileURLToPath(new URL("../../examples/equities/synthetic.json", import.meta.url)),
		);
	await expect(page.getByText(/records ready to import/)).toBeVisible();
	await capture(page, "import-preview");
	await page.getByRole("button", { name: "Import file", exact: true }).click();
	await page.getByRole("button", { name: /Example US Industries/ }).click();
	await expect(page.getByText("9007199254740993.25", { exact: true })).toBeVisible();
	await page.getByText("Provenance", { exact: true }).click();
	await capture(page, "financial-provenance");
	await page
		.getByLabel("Public information cutoff (UTC, optional)")
		.fill("2026-04-01T00:00:00.000Z");
	await page.getByRole("button", { name: "Apply filters" }).click();
	await expect(page.getByText("No financial facts are available for these filters.")).toBeVisible();
	await capture(page, "historical-empty");
	writeFileSync(`${out}/findings.json`, `${JSON.stringify(findings, null, 2)}\n`);
});
