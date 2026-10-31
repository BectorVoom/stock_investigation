import { defineConfig } from "@playwright/test";
import { browserUse, parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN } from "../e2e/fixtures.ts";
import e2eConfig from "../e2e/playwright.config.ts";

/**
 * Scripted UI review of the Chat page (`bun run review:ui`).
 *
 * Reuses the E2E server stack (web server, global setup, fixtures) by
 * spreading the E2E config — no duplicated server logic. It is a REVIEW, not
 * a gate: it is not part of `bun run test:e2e` (that config's `testDir` only
 * covers `tests/e2e/`) and never fails because of a finding.
 *
 * The engine is selected with `REVIEW_BROWSER=chrome|firefox|webkit`
 * (default chrome); output goes under
 * `test-results/ui-review/<engine>/` (see `UIREVIEW_OUT` in
 * `chatReview.spec.ts`). A UI change is reviewed in all three engines
 * (see `docs/rule/UI_review_rule.md`).
 */
const browser = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");

export default defineConfig({
	...e2eConfig,
	testDir: ".",
	testMatch: [
		"chatReview.spec.ts",
		"homeReview.spec.ts",
		"materialsReview.spec.ts",
		"tasksReview.spec.ts",
		"watchlistReview.spec.ts",
		"watchlistListsReview.spec.ts",
		"equitiesReview.spec.ts",
	],
	globalSetup: "../e2e/globalSetup.ts",
	// Per-engine: Playwright wipes its output directory at the start of a
	// run, so sharing one directory would delete the other engines' output.
	outputDir: `../../test-results/ui-review/${browser}/playwright-output`,
	use: {
		baseURL: E2E_ORIGIN,
		headless: true,
		trace: "retain-on-failure",
		// The specs read the English UI. Pinned so a machine whose system
		// language is another one (ADR-0032: the UI follows the browser) still
		// runs them in English; a spec that checks another language sets its own.
		locale: "en-US",
		...browserUse(browser),
	},
});
