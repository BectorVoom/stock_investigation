import type { SafeFetcher } from "@research/application";
import { err, ok } from "@research/domain";
import fixtureData from "./fixtures/e2e-fixtures.json" with { type: "json" };

/**
 * Synthetic data for the browser E2E run. `example.org` is a reserved
 * documentation domain: nothing here is real news, and no test ever contacts
 * the network. Both the E2E Worker and the E2E runner serve this one feed.
 */
/**
 * Port of the E2E Worker. Overridable with E2E_PORT so two checkouts can run the
 * suite at the same time. Read defensively: this module is also bundled into the
 * E2E Worker, where there is no `process`.
 */
const configuredPort = Number(typeof process === "undefined" ? undefined : process.env.E2E_PORT);
export const E2E_PORT =
	Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65_534
		? configuredPort
		: 8799;
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;
/**
 * The synthetic data lives in `fixtures/e2e-fixtures.json`, one file read by
 * these specs, the Worker and the Rust E2E runner (`research-runner-testkit`),
 * so the three can never disagree about the feed, the headline or the dates.
 */
export const FEED_URL: string = fixtureData.feedUrl;
export const HEADLINE: string = fixtureData.headline;

/** Markup that must only ever appear as inert text in the page. */
export const HOSTILE_MARKUP: string = fixtureData.hostileMarkup;

export const FEED_XML: string = fixtureData.feedXml.replaceAll("{{headline}}", HEADLINE);

/** The sign-in URL the scripted Google connect delivers (a well-formed Google consent link). */
export const GOOGLE_SIGN_IN_URL: string = fixtureData.googleAuthUrl;

/** Offsets and events of the canned earnings answers (`earningsFixtures.ts`). */
export const EARNINGS_FIXTURES = fixtureData.earnings;

/** Named rows and padding of the canned stock lists (`directoryFixtures.ts`, ADR-0033). */
export const STOCK_DIRECTORY_FIXTURE_DATA = fixtureData.stockDirectory;

export const fixtureFetcher: SafeFetcher = {
	async fetchText(url) {
		if (url !== FEED_URL) return err({ code: "NETWORK_ERROR", detail: "not an E2E fixture URL" });
		return ok({ finalUrl: FEED_URL, contentType: "application/rss+xml", text: FEED_XML });
	},
};
