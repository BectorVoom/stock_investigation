/**
 * The catalogue's page tools share one `PageAccess` (pageAccess.ts): one
 * robots.txt cache and one per-host spacing for `news.fetch_article` and
 * `web.fetch_page`. Kept apart from newsTools.test.ts / webTools.test.ts,
 * whose tool calls are recorded per factory as conformance vectors; the Rust
 * catalogue's sharing is checked in crates/research-tools/src/catalogue.rs.
 */
import type { SubscribedSourceRef } from "@research/contracts";
import { ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createFeedParser } from "../../src/feed/index.ts";
import { webCryptoHasher } from "../../src/runtime/index.ts";
import { createResearchTools } from "../../src/tools/index.ts";
import { createScriptedFetcher, createToolContext, fixedClock, fixtureText } from "./support.ts";

const ARTICLE_URL = "https://news.synthetic-wire.org/2026/10/grid-battery-orders";
const OTHER_URL = "https://news.synthetic-wire.org/other";
const HTML = fixtureText("feeds/html-page-synthetic.html");
const WIRE: SubscribedSourceRef = {
	sourceId: "src_wire",
	canonicalUrl: "https://news.synthetic-wire.org/feed.xml",
	publisher: "Synthetic Industry Wire",
	title: "Synthetic Industry Wire feed",
	licensePolicy: "short-excerpt-permitted",
};

describe("page access shared by news.fetch_article and web.fetch_page", () => {
	it("reads robots.txt once for both tools and spaces their requests to one host", async () => {
		const fetcher = createScriptedFetcher({
			[ARTICLE_URL]: { text: HTML, contentType: "text/html" },
			[OTHER_URL]: { text: HTML, contentType: "text/html" },
		});
		const waits: number[] = [];
		const tools = createResearchTools({
			fetcher,
			feedParser: createFeedParser(),
			hasher: webCryptoHasher,
			clock: fixedClock(),
			secUserAgent: null,
			tavilyApiKey: null,
			pageArchive: { save: async () => ok({ fileName: "page.md" }) },
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		const article = tools.find((candidate) => candidate.toolId === "news.fetch_article");
		const page = tools.find((candidate) => candidate.toolId === "web.fetch_page");
		const context = createToolContext([WIRE]);
		expect((await article?.execute({ url: ARTICLE_URL }, context))?.ok).toBe(true);
		expect((await page?.execute({ url: OTHER_URL }, context))?.ok).toBe(true);
		expect(fetcher.urls()).toEqual([
			"https://news.synthetic-wire.org/robots.txt",
			ARTICLE_URL,
			OTHER_URL,
		]);
		// The fixed clock never moves, so the second request waits the whole second.
		expect(waits).toEqual([1_000]);
	});
});

describe("per-host spacing under concurrency", () => {
	it("starts concurrent news.fetch_article and web.fetch_page requests a second apart", async () => {
		let nowMs = Date.parse("2026-10-11T03:00:00.000Z");
		const pageStarts: number[] = [];
		const base = createScriptedFetcher({
			[ARTICLE_URL]: { text: HTML, contentType: "text/html" },
			[OTHER_URL]: { text: HTML, contentType: "text/html" },
			"https://news.synthetic-wire.org/third": { text: HTML, contentType: "text/html" },
		});
		const fetcher: typeof base = {
			...base,
			async fetchText(url, options) {
				if (!url.endsWith("/robots.txt")) pageStarts.push(nowMs);
				// Each request takes a moment, so the callers really overlap.
				await new Promise((resolve) => setTimeout(resolve, 1));
				return base.fetchText(url, options);
			},
		};
		const tools = createResearchTools({
			fetcher,
			feedParser: createFeedParser(),
			hasher: webCryptoHasher,
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			secUserAgent: null,
			tavilyApiKey: null,
			pageArchive: { save: async () => ok({ fileName: "page.md" }) },
			sleep: async (ms) => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				nowMs += ms;
			},
		});
		const article = tools.find((candidate) => candidate.toolId === "news.fetch_article");
		const page = tools.find((candidate) => candidate.toolId === "web.fetch_page");
		const context = createToolContext([WIRE]);
		const results = await Promise.all([
			article?.execute({ url: ARTICLE_URL }, context),
			page?.execute({ url: OTHER_URL }, context),
			page?.execute({ url: "https://news.synthetic-wire.org/third" }, context),
		]);
		expect(results.map((result) => result?.ok)).toEqual([true, true, true]);
		expect(pageStarts).toHaveLength(3);
		const sorted = [...pageStarts].sort((a, b) => a - b);
		for (let index = 1; index < sorted.length; index += 1) {
			expect((sorted[index] ?? 0) - (sorted[index - 1] ?? 0)).toBeGreaterThanOrEqual(1_000);
		}
	});

	it("lets a caller cancelled while waiting for its turn leave without delaying the others", async () => {
		let nowMs = Date.parse("2026-10-11T03:00:00.000Z");
		const pageStarts: number[] = [];
		const base = createScriptedFetcher({
			[ARTICLE_URL]: { text: HTML, contentType: "text/html" },
			[OTHER_URL]: { text: HTML, contentType: "text/html" },
		});
		const fetcher: typeof base = {
			...base,
			async fetchText(url, options) {
				if (!url.endsWith("/robots.txt")) pageStarts.push(nowMs);
				return base.fetchText(url, options);
			},
		};
		const tools = createResearchTools({
			fetcher,
			feedParser: createFeedParser(),
			hasher: webCryptoHasher,
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			secUserAgent: null,
			tavilyApiKey: null,
			pageArchive: { save: async () => ok({ fileName: "page.md" }) },
			sleep: async (ms) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				nowMs += ms;
			},
		});
		const page = tools.find((candidate) => candidate.toolId === "web.fetch_page");
		// A first request records the host's start, so the next two must wait.
		expect((await page?.execute({ url: ARTICLE_URL }, createToolContext([WIRE])))?.ok).toBe(true);
		const doomed = new AbortController();
		const waiting = page?.execute({ url: OTHER_URL }, createToolContext([WIRE], doomed.signal));
		const behind = page?.execute({ url: OTHER_URL }, createToolContext([WIRE]));
		doomed.abort();
		expect(await waiting).toMatchObject({ ok: false, error: { code: "TOOL_ABORTED" } });
		expect((await behind)?.ok).toBe(true);
		expect(pageStarts).toHaveLength(2);
		expect((pageStarts[1] ?? 0) - (pageStarts[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
	});
});
