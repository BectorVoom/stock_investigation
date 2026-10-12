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
	return { browserName: browser };
}
