import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PlaywrightTestConfig } from "@playwright/test";

/** Every engine the browser suites run in (task 17). */
export type SupportedBrowser = "chrome" | "firefox" | "webkit";

type UseOptions = NonNullable<PlaywrightTestConfig["use"]>;

/**
 * Parses an engine selection (`E2E_BROWSER`, `REVIEW_BROWSER`). Chrome keeps
 * using the locally installed Chrome; Firefox and WebKit use the Playwright
 * builds. One config file and one set of specs per suite — only this value
 * differs per run.
 */
export function parseBrowser(raw: string | undefined, variable: string): SupportedBrowser {
	const browser = raw ?? "chrome";
	if (browser !== "chrome" && browser !== "firefox" && browser !== "webkit") {
		throw new Error(`${variable} must be chrome, firefox or webkit (got ${JSON.stringify(raw)})`);
	}
	return browser;
}

/** Playwright `use` options for the engine: a channel for Chrome, a browser name otherwise. */
export function browserUse(browser: SupportedBrowser): UseOptions {
	if (browser === "chrome") return { channel: "chrome" };
	if (browser === "firefox" && process.platform === "darwin") {
		// macOS 27 TCC blocks direct Firefox access to the user's shared app-data
		// directory (playwright#42768). Keep only test app-data in our ignored cache;
		// Playwright still creates an isolated temporary browser profile per launch.
		// Recheck with Firefox 158 / Playwright 1.65 (upstream #42768); do not change HOME.
		const appDataHome = resolve(".wrangler/playwright-firefox-home");
		mkdirSync(appDataHome, { recursive: true });
		return {
			browserName: "firefox",
			launchOptions: { env: { ...process.env, CFFIXED_USER_HOME: appDataHome } },
		};
	}
	return { browserName: browser };
}
