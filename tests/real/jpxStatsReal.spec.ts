import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { waitForSync } from "../e2e/marketSync.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Real-network positive-path check for ADR-0076 on `bun run dev`: with no API
 * keys configured at all, adding `jpx:SHORT_SELLING_RATIO`,
 * `jpx:MARGIN_BUYING_VALUE` and `jpx:MARGIN_RATIO` through the Home widget
 * dialog causes the server to queue `market-refresh`, the Rust runner to fetch
 * JPX's live short-selling PDFs and margin `.xlsx` workbooks, and Home to
 * render the three series with units, 1-month changes (for the ~8-week margin
 * series), sparklines and JPX attribution links.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8944;
const API_PORT = 8945;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-jpx-stats-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-jpx-stats-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	// JPX statistics require no API keys.
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
});

test.afterAll(() => resources.close());

function envForTest(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18944",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: ownerHeaders(API_ORIGIN),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

test("Home adds JPX short-selling and margin series from the catalog and syncs live JPX PDFs and workbooks", async ({
	page,
}) => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: envForTest() });
	resources.add(async () => {
		await service.stop();
	});
	try {
		// Start with one JPX metric widget so no unconfigured FRED / Twelve Data series are queued,
		// then add the Indicator table with all three JPX series through the browser UI.
		const current = await api<{ version: number }>("GET", "/api/v1/home/dashboard");
		await api("PUT", "/api/v1/home/dashboard", {
			expectedVersion: current.version,
			dashboard: {
				schemaVersion: 2,
				widgets: [
					{
						type: "market-metric",
						widgetId: "w-ss-metric",
						title: "TSE short-selling ratio",
						size: "small",
						seriesId: "jpx:SHORT_SELLING_RATIO",
					},
				],
			},
		});

		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});

		await page.getByRole("button", { name: "Add widget" }).click();
		await page.getByRole("menuitem", { name: "Indicator table", exact: true }).click();
		const dialog = page.locator("sl-dialog");
		await expect(dialog).toBeAttached();
		await expect(dialog.locator('sl-option[value="__group-margin"]')).toContainText(
			"Margin & short selling",
		);
		await page
			.locator('sl-dialog sl-input[label="Title"] input')
			.fill("JPX margin & short selling");
		await page.evaluate(() => {
			const select = document.querySelector('sl-dialog sl-select[label="Series"]');
			if (!(select instanceof HTMLElement)) throw new Error("missing Series select");
			Object.assign(select, {
				value: ["jpx:SHORT_SELLING_RATIO", "jpx:MARGIN_BUYING_VALUE", "jpx:MARGIN_RATIO"],
			});
			select.dispatchEvent(new Event("sl-change", { bubbles: true, composed: true }));
		});
		await dialog.getByRole("button", { name: "Add widget" }).click();

		const synced = await waitForSync(
			() =>
				api<{
					series: {
						seriesId: string;
						unit: string;
						frequency: string;
						publisher: string;
						sourceUrl: string;
						lastRefreshedAt: string | null;
						unavailable: { code: string; reason: string } | null;
						observations: [string, number][];
					}[];
					refresh: {
						activeRunId: string | null;
						lastSucceededAt: string | null;
						lastFailure: { code: string } | null;
					};
				}>("GET", "/api/v1/home/data"),
			(state) =>
				["jpx:SHORT_SELLING_RATIO", "jpx:MARGIN_BUYING_VALUE", "jpx:MARGIN_RATIO"].every((id) =>
					state.series.some((entry) => entry.seriesId === id && entry.lastRefreshedAt !== null),
				),
			"the three JPX statistics series",
			{ intervalMs: 5_000 },
		);

		const byId = new Map(synced.series.map((entry) => [entry.seriesId, entry]));
		const ss = byId.get("jpx:SHORT_SELLING_RATIO");
		const buyVal = byId.get("jpx:MARGIN_BUYING_VALUE");
		const ratio = byId.get("jpx:MARGIN_RATIO");
		if (ss === undefined || buyVal === undefined || ratio === undefined) {
			throw new Error("missing JPX series in /api/v1/home/data");
		}
		expect(ss.unavailable).toBeNull();
		expect(ss.unit).toBe("Percent");
		expect(ss.frequency).toBe("daily");
		expect(ss.publisher).toBe("Japan Exchange Group (JPX)");
		expect(ss.sourceUrl).toBe(
			"https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html",
		);
		expect(ss.observations.length).toBeGreaterThanOrEqual(5);
		const latestSs = ss.observations.at(-1)?.[1] ?? 0;
		expect(latestSs).toBeGreaterThan(10);
		expect(latestSs).toBeLessThan(80);

		expect(buyVal.unavailable).toBeNull();
		expect(buyVal.unit).toBe("Millions of Yen");
		expect(buyVal.frequency).toBe("weekly");
		expect(buyVal.observations.length).toBeGreaterThanOrEqual(6);
		expect(buyVal.observations.at(-1)?.[1] ?? 0).toBeGreaterThan(100_000);

		expect(ratio.unavailable).toBeNull();
		expect(ratio.unit).toBe("Times");
		expect(ratio.frequency).toBe("weekly");
		expect(ratio.observations.length).toBeGreaterThanOrEqual(6);
		expect(ratio.observations.at(-1)?.[1] ?? 0).toBeGreaterThan(0.5);

		const metric = page.locator('article[data-widget-id="w-ss-metric"]');
		await expect(metric).toContainText(/\d+\.\d+\s*%/, { timeout: 60_000 });
		await expect(metric.getByRole("link", { name: "Japan Exchange Group (JPX)" })).toHaveAttribute(
			"href",
			"https://www.jpx.co.jp/markets/statistics-equities/short-selling/index.html",
		);

		const table = page.getByRole("article", { name: "JPX margin & short selling" });
		await expect(table).toContainText("Millions of Yen", { timeout: 60_000 });
		await expect(table).toContainText("Times");

		const shotsDir = join(REPO_ROOT, "test-results-real");
		mkdirSync(shotsDir, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, "jpx-stats-real-1440x900.png"), fullPage: true });
	} finally {
		await service.stop();
	}
});
