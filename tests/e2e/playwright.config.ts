import { defineConfig } from "@playwright/test";
import { browserUse, parseBrowser } from "./engines.ts";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * Browser E2E against the real Worker runtime (wrangler dev + local D1), the
 * built SPA and the real runner loop. One config file, one set of specs: the
 * engine is selected with `E2E_BROWSER=chrome|firefox|webkit` (default
 * chrome). Chrome keeps using the locally installed Chrome through
 * `channel: "chrome"` so no download is needed; Firefox and WebKit use the
 * Playwright builds (`playwright install firefox webkit`).
 *
 * The specs are stateful (they build on one database in order) and the
 * first-run test needs a fresh database, so `bun run test:e2e` runs this
 * suite once per engine, sequentially, each with a fresh server and database
 * (see `scripts/e2eAll.ts`; the `webServer` below starts fresh every time).
 * Ports stay derived from `E2E_PORT` (see `fixtures.ts`).
 *
 * Launcher specs (`startLocal.spec.ts`, `devLocal.spec.ts`,
 * `devRunnerFailure.spec.ts`) are about the launcher rather than the browser,
 * so they run once, under Chrome only.
 */
const browser = parseBrowser(process.env.E2E_BROWSER, "E2E_BROWSER");

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	testIgnore:
		browser === "chrome"
			? []
			: [/startLocal\.spec\.ts$/, /devLocal\.spec\.ts$/, /devRunnerFailure\.spec\.ts$/],
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 90_000,
	reporter: [["list"]],
	// Per-engine: Playwright wipes its output directory at the start of a run,
	// so sharing one directory would delete the previous engine's traces (and
	// anything else under `test-results/`, such as the UI-review output).
	outputDir: `../../test-results/e2e-${browser}`,
	use: {
		baseURL: E2E_ORIGIN,
		headless: true,
		trace: "retain-on-failure",
		// The specs read the English UI. Pinned so a machine whose system
		// language is another one (ADR-0031: the UI follows the browser) still
		// runs them in English; a spec that checks another language sets its own.
		locale: "en-US",
		...browserUse(browser),
	},
	globalSetup: "./globalSetup.ts",
	webServer: {
		command: "sh tests/e2e/start-worker.sh",
		cwd: "../..",
		url: `${E2E_ORIGIN}/api/v1/session`,
		reuseExistingServer: false,
		timeout: 120_000,
		stdout: "ignore",
		stderr: "pipe",
	},
});
