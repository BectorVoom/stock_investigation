import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	idempotencyKey,
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Home market-data refresh against the real network (`bun run test:real`).
 * No model quota is spent: the market-refresh job only calls the two keyed
 * provider APIs. The suite's own runner env file carries Twelve Data: the
 * invoking environment's `TWELVE_DATA_API_KEY` when present (so gold and the
 * whole watchlist can be seen), else the PUBLIC demo key
 * (`TWELVE_DATA_API_KEY=demo`, which serves AAPL). If `FRED_API_KEY` is
 * present in the invoking environment it is passed through and the VIX
 * widget must show a value, otherwise the suite records that FRED was not
 * exercised. Never run by implementation agents (needs the network and
 * minutes); the orchestrator runs it.
 *
 * After the refresh completes, the test opens the development SPA on the
 * suite's own Vite port in a browser (engine selected with
 * `REAL_BROWSER=chrome|firefox|webkit`, default chrome) and asserts the
 * refreshed numbers in the DOM, saving full-page screenshots at 1440×900
 * and 390×844 under `test-results-real/`.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8898;
const API_PORT = 8899;
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
	dataDir = mkdtempSync(join(tmpdir(), "research-real-home-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-home-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	const fredKey = process.env.FRED_API_KEY;
	const twelveKey = process.env.TWELVE_DATA_API_KEY;
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {
		TWELVE_DATA_API_KEY: twelveKey === undefined || twelveKey === "" ? "demo" : twelveKey,
		...(fredKey === undefined || fredKey === "" ? {} : { FRED_API_KEY: fredKey }),
	});
});

test.afterAll(() => resources.close());

function homeEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18992",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api<T>(method: string, path: string, body?: unknown, key?: string): Promise<T> {
	const headers: Record<string, string> = { ...ownerHeaders(API_ORIGIN) };
	if (key !== undefined) headers["Idempotency-Key"] = key;
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

test("a market-data refresh shows a real Twelve Data price with an as-of date", async ({
	page,
}) => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const fredExercised = (process.env.FRED_API_KEY ?? "") !== "";
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: homeEnv() });
	resources.add(async () => {
		await service.stop();
	});
	try {
		const session = await api<{ environment: string }>("GET", "/api/v1/session");
		expect(session.environment).toBe("development");

		const created = await api<{ run: { runId: string } }>(
			"POST",
			"/api/v1/home/refresh",
			{},
			idempotencyKey(),
		);
		const runId = created.run.runId;
		let state = "";
		const deadline = Date.now() + 420_000;
		for (;;) {
			const run = await api<{ run: { state: string } }>("GET", `/api/v1/research-runs/${runId}`);
			state = run.run.state;
			if (state === "completed" || state === "failed" || state === "cancelled") break;
			if (Date.now() > deadline) throw new Error(`market refresh ${runId} did not finish in time`);
			await new Promise((resolve) => setTimeout(resolve, 5_000));
		}
		expect(state).toBe("completed");

		const data = await api<{
			series: {
				seriesId: string;
				title: string;
				unit: string;
				publisher: string;
				sourceUrl: string;
				lastRefreshedAt: string | null;
				unavailable: { code: string; reason: string } | null;
				observations: [string, number][];
			}[];
		}>("GET", "/api/v1/home/data");
		const aapl = data.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		if (aapl === undefined) throw new Error("the AAPL series is missing from /home/data");
		expect(aapl.unavailable).toBeNull();
		expect(aapl.publisher).toBe("Twelve Data");
		expect(aapl.unit).toContain("USD");
		expect(aapl.observations.length).toBeGreaterThan(0);
		const latest = aapl.observations[aapl.observations.length - 1];
		if (latest === undefined) throw new Error("the AAPL series has no observations");
		expect(Number.isFinite(latest[1])).toBe(true);
		expect(latest[1]).toBeGreaterThan(0);
		expect(/^\d{4}-\d{2}-\d{2}$/.test(latest[0])).toBe(true);
		expect(aapl.lastRefreshedAt).not.toBeNull();

		if (fredExercised) {
			const vix = data.series.find((entry) => entry.seriesId === "fred:VIXCLS");
			if (vix === undefined) throw new Error("the VIX series is missing from /home/data");
			expect(vix.unavailable).toBeNull();
			expect(vix.observations.length).toBeGreaterThan(0);
		} else {
			test.info().annotations.push({
				type: "FRED",
				description: "not exercised: no FRED_API_KEY in the invoking environment",
			});
		}

		// The refreshed numbers in the DOM: the development SPA on the
		// suite's own Vite port (which proxies /api to the suite's API
		// port), driven in a real browser on the REAL_BROWSER engine.
		await page.goto(`${VITE_ORIGIN}/#/home`);
		await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
			timeout: 60_000,
		});
		const watchlist = page.locator('article[data-widget-id="w-watchlist"]');
		await expect(watchlist).toBeVisible({ timeout: 60_000 });
		const aaplRow = watchlist.getByRole("row", { name: /AAPL/ });
		await expect(aaplRow).toContainText(/\d+\.\d+/, { timeout: 120_000 });
		await expect(aaplRow).toContainText("USD");
		await expect(aaplRow).toContainText(/\d{4}-\d{2}-\d{2}/);
		const aaplSource = aaplRow.getByRole("link", { name: "Twelve Data" });
		await expect(aaplSource).toHaveAttribute("href", "https://twelvedata.com/");

		if (fredExercised) {
			const vixWidget = page.locator('article[data-widget-id="w-vix"]');
			await expect(vixWidget).toContainText(/\d+\.\d+/, { timeout: 120_000 });
			await expect(vixWidget).toContainText(/\d{4}-\d{2}-\d{2}/);
			await expect(
				vixWidget.getByRole("link", { name: "Federal Reserve Bank of St. Louis (FRED)" }),
			).toHaveAttribute("href", "https://fred.stlouisfed.org/series/VIXCLS");
		}

		const shotsDir = join(REPO_ROOT, "test-results-real");
		mkdirSync(shotsDir, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.waitForTimeout(1_000);

		// Drag to reposition, on the real development stack: the first
		// widget's header is dragged onto the third widget with the real
		// mouse, the drop is saved by the real API, and the new order
		// survives a reload (so it came from the stored dashboard, not from
		// the drag preview).
		const widgetOrder = () =>
			page
				.locator("article[data-widget-id]")
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-id") ?? ""));
		const handleCenter = async (widgetId: string) => {
			const box = await page
				.locator(`article[data-widget-id="${widgetId}"] .wg-grip`)
				.boundingBox();
			if (box === null) throw new Error(`the drag handle of ${widgetId} is not on screen`);
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		};
		await page.evaluate(() => window.scrollTo(0, 0));
		const orderBefore = await widgetOrder();
		const draggedId = orderBefore[0];
		const targetId = orderBefore[2];
		if (draggedId === undefined || targetId === undefined) {
			throw new Error("the default dashboard has fewer than three widgets");
		}
		const from = await handleCenter(draggedId);
		const to = await handleCenter(targetId);
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x + 20, to.y + 10, { steps: 12 });
		await expect(page.locator("[data-widget-placeholder]")).toHaveCount(1);
		await page.screenshot({ path: join(shotsDir, "home-real-drag-mid.png") });
		await page.mouse.up();
		const expectedOrder = orderBefore.filter((id) => id !== draggedId);
		expectedOrder.splice(2, 0, draggedId);
		await expect.poll(widgetOrder, { timeout: 30_000 }).toEqual(expectedOrder);
		await expect
			.poll(
				async () => {
					const stored = await api<{ dashboard: { widgets: { widgetId: string }[] } }>(
						"GET",
						"/api/v1/home/dashboard",
					);
					return stored.dashboard.widgets.map((widget) => widget.widgetId);
				},
				{ timeout: 30_000 },
			)
			.toEqual(expectedOrder);
		await page.reload();
		await expect(watchlist).toBeVisible({ timeout: 60_000 });
		await expect.poll(widgetOrder, { timeout: 30_000 }).toEqual(expectedOrder);
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, "home-real-1440x900.png"), fullPage: true });

		// The chart viewer (ADR-0025) on real held prices: the AAPL row of
		// the watchlist opens it; Max shows every held daily close, 3M
		// narrows the window, and Escape returns focus to the row button.
		const openAapl = aaplRow.getByRole("button", { name: /^Open chart: / });
		await openAapl.click();
		const viewer = page.locator("sl-dialog.chart-viewer[open]");
		await expect(viewer).toBeVisible({ timeout: 30_000 });
		const barsCell = viewer
			.locator("table")
			.first()
			.locator("tbody tr")
			.first()
			.locator("td")
			.last();
		await viewer.getByRole("button", { name: "Max", exact: true }).click();
		await expect(viewer.getByRole("button", { name: "Max", exact: true })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		const maxBars = Number(await barsCell.innerText());
		expect(maxBars).toBeGreaterThan(1);
		await viewer.getByRole("button", { name: "3M", exact: true }).click();
		await expect.poll(async () => Number(await barsCell.innerText())).toBeLessThan(maxBars);
		await page.waitForTimeout(500);
		await page.screenshot({ path: join(shotsDir, "chart-viewer-real-1440x900.png") });
		await page.keyboard.press("Escape");
		await expect(viewer).toBeHidden();
		await expect(openAapl).toBeFocused();

		await page.setViewportSize({ width: 390, height: 844 });
		await page.waitForTimeout(1_000);
		await page.screenshot({ path: join(shotsDir, "home-real-390x844.png"), fullPage: true });
	} finally {
		await service.stop();
	}
});
