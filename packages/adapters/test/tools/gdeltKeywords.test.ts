/**
 * `shortGdeltKeyword`: which words of a `news.search` query GDELT would find
 * too short (docs/external-apis/apis/gdelt-doc.md section 2). Kept apart from
 * searchTools.test.ts, whose tool calls are recorded as conformance vectors;
 * the Rust twin `short_gdelt_keyword` is checked against the same cases in
 * crates/research-tools/tests/behavior.rs.
 */
import { ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createSearchTools, shortGdeltKeyword } from "../../src/tools/searchTools.ts";
import { createToolContext } from "./support.ts";

describe("shortGdeltKeyword", () => {
	it.each([
		["ai", "ai"],
		["ai chips", "ai"],
		["nvidia -ai", "ai"],
		["(ai OR ml) chips", "ai"],
		["Q3 results", "Q3"],
		["gold 😀", "😀"],
		["S & P 500", "S"],
		["gold — price", "—"],
		["日銀", "日銀"],
		["fed rate", null],
		["gold OR silver", null],
		["tesla sourcecountry:us", null],
		['"ai chips" nvidia', null],
		["(gold) -silver", null],
		["gold & silver", null],
		["日本銀行", null],
	])("%j → %j", (query, expected) => {
		expect(shortGdeltKeyword(query)).toBe(expected);
	});
});

describe("news.search spacing under concurrency", () => {
	it("starts concurrent GDELT requests at least 5 s apart", async () => {
		let nowMs = Date.parse("2026-10-11T03:00:00.000Z");
		const starts: number[] = [];
		const [tool] = createSearchTools({
			fetcher: {
				async fetchText(url) {
					starts.push(nowMs);
					await new Promise((resolve) => setTimeout(resolve, 1));
					return ok({ finalUrl: url, contentType: "application/json", text: "{}" });
				},
			},
			hasher: { sha256Hex: async () => "0".repeat(64) },
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			sleep: async (ms) => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				nowMs += ms;
			},
			tavilyApiKey: null,
		});
		const results = await Promise.all(
			["gold price", "battery storage", "copper demand"].map((query) =>
				tool?.execute({ query }, createToolContext()),
			),
		);
		expect(results.map((result) => result?.ok)).toEqual([true, true, true]);
		expect(starts).toHaveLength(3);
		expect((starts[1] ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(5_000);
		expect((starts[2] ?? 0) - (starts[1] ?? 0)).toBeGreaterThanOrEqual(5_000);
	});
});
