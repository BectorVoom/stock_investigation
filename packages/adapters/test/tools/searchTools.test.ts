/**
 * Tests for `web.search`, the model's keyword search over recent news (GDELT).
 *
 * Every test uses a scripted fetcher, a controllable clock and a recording
 * sleep: no socket is ever opened. Asserted here are the tool's own contract —
 * GDELT articles becoming evidence with the right URLs, publishers and dates,
 * a GDELT failure failing the call with its cause, Wikipedia never being
 * contacted, the GDELT 5 s spacing with its abort behaviour, and the URL
 * policy dropping non-https and private result URLs. The SSRF hard gate lives
 * in `tests/security/`.
 */
import { createHash } from "node:crypto";
import { evidenceSchema } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createSearchTools, type SearchToolDeps } from "../../src/tools/searchTools.ts";
import { MAX_MODEL_TEXT_BYTES } from "../../src/tools/shared.ts";
import { createScriptedFetcher, createToolContext, NOW_ISO, type ScriptedPage } from "./support.ts";

const GDELT_HOST = "api.gdeltproject.org";

function gdeltUrl(query: string): string {
	return (
		`https://api.gdeltproject.org/api/v2/doc/doc` +
		`?query=${encodeURIComponent(`${query} sourcelang:english`)}` +
		`&mode=artlist&format=json&maxrecords=10&sort=hybridrel`
	);
}

const GDELT_OK = {
	articles: [
		{
			url: "https://news.synthetic-wire.org/2026/10/gold-price-record",
			title: "Gold price hits record on safe-haven demand",
			seendate: "20261016T111500Z",
			domain: "news.synthetic-wire.org",
			language: "English",
			sourcecountry: "United States",
		},
		{
			url: "https://markets.synthetic-wire.org/gold-outlook",
			title: "Dealers raise gold outlook for 2026",
			seendate: "not-a-date",
			domain: "markets.synthetic-wire.org",
			language: "English",
			sourcecountry: "United Kingdom",
		},
	],
};

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function controllableClock(startIso: string = NOW_ISO) {
	let nowMs = Date.parse(startIso);
	return {
		clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
		advance(ms: number) {
			nowMs += ms;
		},
	};
}

function recordingSleep(clock?: { advance(ms: number): void }) {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms: number, _signal: AbortSignal): Promise<void> => {
			waits.push(ms);
			clock?.advance(ms);
		},
	};
}

function setup(
	pages: { readonly [url: string]: ScriptedPage },
	options: { readonly advanceClockOnSleep?: boolean } = {},
) {
	const fetcher = createScriptedFetcher(pages);
	const time = controllableClock();
	const sleep = recordingSleep(options.advanceClockOnSleep === true ? time : undefined);
	const deps: SearchToolDeps = {
		fetcher,
		hasher: { sha256Hex: async (text: string) => sha256(text) },
		clock: time.clock,
		sleep: sleep.sleep,
	};
	const [tool] = createSearchTools(deps);
	if (tool === undefined) throw new Error("web.search was not created");
	return { fetcher, tool, time, sleep };
}

function pagesFor(query: string): { readonly [url: string]: ScriptedPage } {
	return {
		[gdeltUrl(query)]: { text: JSON.stringify(GDELT_OK), contentType: "application/json" },
	};
}

describe("web.search: registration", () => {
	it("declares the ADR-0025 identity and stays within its description budget", () => {
		const { tool } = setup({});
		expect(tool.toolId).toBe("web.search");
		expect(tool.version).toBe("1.0.0");
		expect(tool.permission).toBe("research-read");
		expect(tool.costCategory).toBe("rate-limited");
		expect(tool.sideEffect).toBe("external-read");
		expect(tool.networkAllowlist).toEqual({ kind: "public-web" });
		expect(tool.timeoutMs).toBe(40_000);
		expect(tool.description.length).toBeLessThanOrEqual(200);
		expect(tool.description).toContain("web.fetch_page");
	});
});

describe("web.search: happy path", () => {
	it("keeps a GDELT article without a date or domain: its host names the publisher", async () => {
		const query = "gold price";
		const { tool } = setup({
			[gdeltUrl(query)]: {
				text: JSON.stringify({
					articles: [
						{ url: "https://news.synthetic-wire.org/bare", title: "Gold steadies" },
						...GDELT_OK.articles,
					],
				}),
				contentType: "application/json",
			},
		});
		const result = await tool.execute({ query }, createToolContext());
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.evidence).toHaveLength(3);
		const bare = result.value.evidence[0]?.evidence;
		expect(bare?.publisher).toBe("news.synthetic-wire.org");
		expect(bare?.publishedAt).toBe(null);
	});

	it("turns GDELT articles into evidence with correct URLs, publishers and dates", async () => {
		const query = "gold price";
		const { fetcher, tool } = setup(pagesFor(query));
		const context = createToolContext();
		const result = await tool.execute({ query }, context);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		const output = result.value;

		expect(output.evidence).toHaveLength(2);
		for (const collected of output.evidence) {
			expect(evidenceSchema.safeParse(collected.evidence).success).toBe(true);
			// Invariant relied on by verification: checksum === sha256(retrievedText).
			expect(collected.evidence.checksum).toBe(sha256(collected.retrievedText));
			// Headlines only: nothing is stored (DATA-010).
			expect(collected.retainQuotes).toBe(false);
			expect(collected.evidence.excerpt).toBeNull();
			expect(collected.evidence.retrievedAt).toBe(NOW_ISO);
			expect(collected.evidence.effectiveAt).toBeNull();
		}

		const [gold, dealers] = output.evidence;
		expect(gold?.evidence).toMatchObject({
			evidenceId: "run_test_ev1",
			sourceUrl: "https://news.synthetic-wire.org/2026/10/gold-price-record",
			title: "Gold price hits record on safe-haven demand",
			publisher: "news.synthetic-wire.org",
			publishedAt: "2026-10-16T11:15:00.000Z",
			sourceClass: "news",
		});
		expect(gold?.retrievedText).toBe("Gold price hits record on safe-haven demand");
		// A malformed GDELT seen date is null, never a guess — the result is kept.
		expect(dealers?.evidence.publishedAt).toBeNull();
		expect(dealers?.evidence.sourceUrl).toBe("https://markets.synthetic-wire.org/gold-outlook");
		expect(dealers?.evidence.sourceClass).toBe("news");

		// The model text names every result with id, date-or-undated and URL,
		// carries the untrusted-content notice, and points at the page tool.
		expect(output.modelText).toContain(
			"[run_test_ev1] Gold price hits record on safe-haven demand — news.synthetic-wire.org; 2026-10-16T11:15:00.000Z — https://news.synthetic-wire.org/2026/10/gold-price-record",
		);
		expect(output.modelText).toContain("undated — https://markets.synthetic-wire.org/gold-outlook");
		expect(output.modelText).toContain("untrusted publisher content");
		expect(output.modelText).toContain(
			"Read a promising result with web.fetch_page before relying on it.",
		);
		expect(new TextEncoder().encode(output.modelText).byteLength).toBeLessThanOrEqual(
			MAX_MODEL_TEXT_BYTES,
		);
		// GDELT is the only backend: Wikipedia is never contacted.
		expect([...fetcher.urls()]).toEqual([gdeltUrl(query)]);
	});

	it("pins the request to the GDELT host with a bounded JSON request", async () => {
		const query = "gold price";
		const { fetcher, tool } = setup(pagesFor(query));
		const context = createToolContext();
		const result = await tool.execute({ query }, context);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(fetcher.calls).toHaveLength(1);
		const options = fetcher.calls[0]?.options;
		expect(options?.allowedHosts).toEqual(new Set([GDELT_HOST]));
		expect(options?.maxBytes).toBeLessThanOrEqual(1_000_000);
		expect(options?.timeoutMs).toBeLessThanOrEqual(15_000);
		expect(options?.accept).toContain("application/json");
		expect(options?.userAgent).toBe("research-workspace/1.0 (personal research tool)");
		expect(options?.signal).toBe(context.signal);
	});

	it("deduplicates one URL GDELT lists twice", async () => {
		const query = "gold";
		const article = {
			url: "https://news.synthetic-wire.org/2026/10/gold-price-record",
			title: "Gold price hits record",
			seendate: "20261016T111500Z",
			domain: "news.synthetic-wire.org",
		};
		const { tool } = setup({
			[gdeltUrl(query)]: {
				text: JSON.stringify({
					articles: [article, { ...article, title: "Gold record (update)" }],
				}),
			},
		});
		const result = await tool.execute({ query }, createToolContext());
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.evidence).toHaveLength(1);
		expect(result.value.evidence[0]?.evidence.title).toBe("Gold price hits record");
	});

	it("drops non-https and private result URLs without failing", async () => {
		const query = "gold price";
		const { tool } = setup({
			[gdeltUrl(query)]: {
				text: JSON.stringify({
					articles: [
						{
							url: "http://news.synthetic-wire.org/plain-http",
							title: "Plain http result",
							seendate: "20261016T111500Z",
							domain: "news.synthetic-wire.org",
							language: "English",
							sourcecountry: "United States",
						},
						{
							url: "https://127.0.0.1/loopback",
							title: "Loopback result",
							seendate: "20261016T111500Z",
							domain: "127.0.0.1",
							language: "English",
							sourcecountry: "United States",
						},
						{
							url: "https://news.synthetic-wire.org/2026/10/gold-price-record",
							title: "Gold price hits record on safe-haven demand",
							seendate: "20261016T111500Z",
							domain: "news.synthetic-wire.org",
							language: "English",
							sourcecountry: "United States",
						},
					],
				}),
			},
		});
		const result = await tool.execute({ query }, createToolContext());
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.evidence).toHaveLength(1);
		expect(result.value.evidence[0]?.evidence.sourceUrl).toBe(
			"https://news.synthetic-wire.org/2026/10/gold-price-record",
		);
	});
});

describe("web.search: failures and empty results", () => {
	it("fails with SEARCH_FAILED carrying the first line when GDELT answers with plain text", async () => {
		const query = "gold price";
		const { tool } = setup({
			[gdeltUrl(query)]: {
				text: "Please limit requests to one every 5 seconds.\nTry again later.",
			},
		});
		const result = await tool.execute({ query }, createToolContext());
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "SEARCH_FAILED",
				detail: "Please limit requests to one every 5 seconds.",
				retryable: true,
			},
		});
	});

	it("fails with SEARCH_FAILED carrying the fetch error", async () => {
		const query = "gold price";
		const { tool } = setup({
			[gdeltUrl(query)]: {
				error: { code: "TIMEOUT", detail: "no complete response within 15000 ms" },
			},
		});
		const result = await tool.execute({ query }, createToolContext());
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "SEARCH_FAILED",
				detail: "TIMEOUT: no complete response within 15000 ms",
				retryable: true,
			},
		});
	});

	it("bounds a long plain-text answer to 200 characters in the cause", async () => {
		const query = "gold price";
		const longLine = `x${"y".repeat(500)}`;
		const { tool } = setup({
			[gdeltUrl(query)]: { text: `${longLine}\nsecond line` },
		});
		const result = await tool.execute({ query }, createToolContext());
		if (result.ok) throw new Error("expected SEARCH_FAILED");
		expect(result.error.code).toBe("SEARCH_FAILED");
		expect(result.error.detail.length).toBeLessThanOrEqual(200);
		expect(result.error.detail).not.toContain("second line");
	});

	it("answers zero results as a success with no evidence", async () => {
		const query = "zxqy wobble";
		const { tool } = setup({
			[gdeltUrl(query)]: { text: JSON.stringify({}) },
		});
		const result = await tool.execute({ query }, createToolContext());
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		expect(result.value.evidence).toEqual([]);
		expect(result.value.modelText).toContain(
			"No results for zxqy wobble. Try shorter or different keywords.",
		);
	});
});

describe("web.search: arguments", () => {
	it("rejects too-short, too-long and extra-key arguments before any fetch", async () => {
		const { fetcher, tool } = setup({});
		for (const args of [
			{},
			{ query: "a" },
			{ query: "  " },
			{ query: "x".repeat(201) },
			{ query: "gold price", extra: true },
			null,
			"gold price",
		]) {
			expect(await tool.execute(args, createToolContext())).toMatchObject({
				ok: false,
				error: { code: "INVALID_ARGS" },
			});
		}
		expect(fetcher.calls).toHaveLength(0);
	});
});

describe("web.search: GDELT spacing", () => {
	it("spaces GDELT requests at least 5 s apart within the process", async () => {
		const query = "gold price";
		const { tool, sleep, time } = setup(pagesFor(query), { advanceClockOnSleep: true });
		expect((await tool.execute({ query }, createToolContext())).ok).toBe(true);
		expect(sleep.waits).toEqual([]);
		// The second GDELT request waits the remainder of the 5 s.
		time.advance(200);
		expect((await tool.execute({ query }, createToolContext())).ok).toBe(true);
		expect(sleep.waits).toEqual([4800]);
	});

	it("ends the spacing wait early when the run is aborted", async () => {
		const query = "gold price";
		const pages = pagesFor(query);
		const waits: number[] = [];
		const hanging = (ms: number, signal: AbortSignal): Promise<void> => {
			waits.push(ms);
			return new Promise((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener("abort", () => resolve(), { once: true });
			});
		};
		const [aborting] = createSearchTools({
			fetcher: createScriptedFetcher(pages),
			hasher: { sha256Hex: async (text: string) => sha256(text) },
			clock: controllableClock().clock,
			sleep: hanging,
		});
		if (aborting === undefined) throw new Error("tool missing");
		// Same tool instance twice: the second call must space its GDELT request.
		expect((await aborting.execute({ query }, createToolContext())).ok).toBe(true);
		expect(waits).toEqual([]);
		const controller = new AbortController();
		const pending = aborting.execute({ query }, createToolContext([], controller.signal));
		// Let the second call park in its spacing wait (scripted fetches settle in microtasks).
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(waits).toEqual([5000]);
		controller.abort();
		expect(await pending).toMatchObject({
			ok: false,
			error: { code: "TOOL_ABORTED", retryable: false },
		});
	});
});
