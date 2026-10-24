import { defineConfig } from "@playwright/test";
import { browserUse, parseBrowser } from "../e2e/engines.ts";

/**
 * Real-environment suite (`bun run test:real`): the launchers for real, one
 * real public feed through the runner's real network path, no model quota.
 * Needs the network, so it is separate from `bun run test:e2e`. Slow by
 * design (pristine copies, real builds, real fetches): minutes, not seconds.
 *
 * Like the E2E suite it drives the locally installed Chrome (`channel:
 * "chrome"`), so no browser download is needed. `live.spec.ts` in this
 * directory skips without `RUN_LIVE_OPENCODE=1` + `OPENCODE_MODEL` and runs
 * as `bun run test:real:live`.
 *
 * The engine is selected with `REAL_BROWSER=chrome|firefox|webkit` (default
 * chrome), exactly like `E2E_BROWSER` in the E2E suite.
 */
const browser = parseBrowser(process.env.REAL_BROWSER, "REAL_BROWSER");

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 600_000,
	reporter: [["list"]],
	outputDir: "../../test-results-real",
	use: {
		headless: true,
		trace: "retain-on-failure",
		// The specs read the English UI. Pinned so a machine whose system
		// language is another one (ADR-0031: the UI follows the browser) still
		// runs them in English; a spec that checks another language sets its own.
		locale: "en-US",
		...browserUse(browser),
	},
});
