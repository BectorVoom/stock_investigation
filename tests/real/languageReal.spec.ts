import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	type PristineCopy,
	refreshRealFeed,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * UI languages on the real development stack (ADR-0032, `bun run test:real`):
 * the dev launcher from a pristine copy, one real feed fetched through the
 * real runner, then a Japanese-preferring browser on every page. The UI's own
 * words are Japanese, the fetched article titles stay as published, and
 * Settings → Language switches to English and back without a reload.
 * Screenshots of each page in Japanese land in `test-results-real/`.
 * No model quota is spent.
 */
test.describe.configure({ mode: "serial" });
test.use({ locale: "ja-JP" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8896;
const API_PORT = 8897;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

const PAGES = [
	{ hash: "#/home", heading: "ホーム", shot: "home" },
	{ hash: "#/watchlist", heading: "ウォッチリスト", shot: "watchlist" },
	{ hash: "#/chat", heading: "チャット", shot: "chat" },
	{ hash: "#/sources", heading: "情報源", shot: "sources" },
	{ hash: "#/settings", heading: "設定", shot: "settings" },
] as const;

let pristine: PristineCopy | null = null;
let extraRoot = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-language-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
});

test.afterAll(() => resources.close());

test("the development stack shows every page in Japanese over real data", async ({ page }) => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const env = launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: join(extraRoot, "dev-data"),
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile: writeTestRunnerEnvFile(extraRoot, {}),
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18996",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env });
	resources.add(async () => {
		await service.stop();
	});
	const consoleErrors: string[] = [];
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	try {
		const refreshed = await refreshRealFeed(API_ORIGIN);
		expect(refreshed.finalState).toBe("completed");
		expect(refreshed.articleCount).toBeGreaterThanOrEqual(1);

		const shotsDir = join(REPO_ROOT, "test-results-real");
		mkdirSync(shotsDir, { recursive: true });
		await page.setViewportSize({ width: 1440, height: 900 });

		for (const entry of PAGES) {
			await page.goto(`${VITE_ORIGIN}/${entry.hash}`);
			await expect(page.getByRole("heading", { level: 2, name: entry.heading })).toBeVisible({
				timeout: 60_000,
			});
			await expect(page.locator("html")).toHaveAttribute("lang", "ja");
			await expect(page.getByText("開発環境", { exact: true })).toBeVisible();
			await page.waitForTimeout(1_500);
			await page.screenshot({
				path: join(shotsDir, `language-ja-${entry.shot}.png`),
				fullPage: true,
			});
		}

		// The real articles: listed under the Japanese UI, titles as published.
		await page.goto(`${VITE_ORIGIN}/#/sources`);
		const articles = page.getByRole("region", { name: "最近の記事" });
		await expect(articles.getByRole("link").first()).toBeVisible({ timeout: 60_000 });

		// Settings → Language: English and back, without a reload.
		await page.goto(`${VITE_ORIGIN}/#/settings`);
		await page.evaluate(() => Reflect.set(window, "__sameDocument", true));
		await page.getByLabel("表示言語").selectOption("en");
		await expect(page.getByRole("heading", { level: 2, name: "Settings" })).toBeVisible();
		await page.getByLabel("Display language").selectOption("system");
		await expect(page.getByRole("heading", { level: 2, name: "設定" })).toBeVisible();
		expect(await page.evaluate(() => Reflect.get(window, "__sameDocument"))).toBe(true);
		expect(consoleErrors).toEqual([]);
	} finally {
		await service.stop();
	}
});
