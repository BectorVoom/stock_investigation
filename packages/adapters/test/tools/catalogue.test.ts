import { createToolRegistry } from "@research/agent-core";
import { evidenceSchema, positionObservationSchema } from "@research/contracts";
import { ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createFeedParser } from "../../src/feed/index.ts";
import {
	NO_JP_MARGIN_BALANCE_SOURCE_REASON,
	NO_US_SHORT_INTEREST_SOURCE_REASON,
	unconfiguredJpMarginBalanceSource,
} from "../../src/finance/marketData.ts";
import { webCryptoHasher } from "../../src/runtime/index.ts";
import { createResearchTools } from "../../src/tools/index.ts";
import { createPositionTools } from "../../src/tools/positionTools.ts";
import {
	boundModelText,
	collectEvidence,
	MAX_MODEL_TEXT_BYTES,
	truncateText,
} from "../../src/tools/shared.ts";
import { createScriptedFetcher, createToolContext, fixedClock, NOW_ISO } from "./support.ts";

function setup() {
	const fetcher = createScriptedFetcher({});
	const tools = createResearchTools({
		fetcher,
		feedParser: createFeedParser(),
		hasher: webCryptoHasher,
		clock: fixedClock(),
		secUserAgent: null,
		pageArchive: null,
		sleep: async () => {},
	});
	return { fetcher, tools, registry: createToolRegistry(tools) };
}

function setupWithArchive() {
	const fetcher = createScriptedFetcher({});
	const tools = createResearchTools({
		fetcher,
		feedParser: createFeedParser(),
		hasher: webCryptoHasher,
		clock: fixedClock(),
		secUserAgent: null,
		pageArchive: {
			async save() {
				return { ok: true as const, value: { fileName: "archived.md" } };
			},
		},
		sleep: async () => {},
	});
	return { fetcher, tools, registry: createToolRegistry(tools) };
}

describe("research tool catalogue", () => {
	it("registers the expected tools with complete policy metadata", () => {
		const { tools, registry } = setup();
		expect(tools.map((tool) => tool.toolId)).toEqual([
			"news.fetch_feed",
			"news.fetch_article",
			"finance.sec_company_financials",
			"filings.sec_13f_holdings",
			"positions.us_short_interest",
			"positions.jp_margin_balance",
		]);
		expect(registry.list()).toHaveLength(6);
		for (const tool of tools) {
			expect(tool.version).toMatch(/^\d+\.\d+\.\d+$/);
			expect(tool.permission).toBe("research-read");
			expect(tool.timeoutMs).toBeGreaterThan(0);
			expect(tool.timeoutMs).toBeLessThanOrEqual(120_000);
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.argsHint.startsWith("{")).toBe(true);
			expect(["free", "rate-limited", "metered"]).toContain(tool.costCategory);
		}
	});

	it("declares a network allowlist that matches what each tool may reach", () => {
		const { registry } = setup();
		expect(registry.get("news.fetch_feed")?.networkAllowlist).toEqual({
			kind: "subscribed-sources",
		});
		expect(registry.get("news.fetch_article")?.networkAllowlist).toEqual({
			kind: "subscribed-sources",
		});
		for (const toolId of ["finance.sec_company_financials", "filings.sec_13f_holdings"]) {
			expect(registry.get(toolId)?.networkAllowlist).toEqual({
				kind: "hosts",
				hosts: ["www.sec.gov", "data.sec.gov"],
			});
			expect(registry.get(toolId)?.sideEffect).toBe("external-read");
			expect(registry.get(toolId)?.costCategory).toBe("rate-limited");
		}
		for (const toolId of ["positions.us_short_interest", "positions.jp_margin_balance"]) {
			expect(registry.get(toolId)?.networkAllowlist).toEqual({ kind: "none" });
			expect(registry.get(toolId)?.sideEffect).toBe("none");
		}
		// Without an archive there is nowhere to keep a retrieved page (DATA-010).
		expect(registry.get("web.fetch_page")).toBeUndefined();
	});

	it("registers web.fetch_page only when a page archive is configured", () => {
		const { tools, registry } = setupWithArchive();
		expect(tools.map((tool) => tool.toolId)).toContain("web.fetch_page");
		expect(registry.list()).toHaveLength(7);
		const web = registry.get("web.fetch_page");
		expect(web).toMatchObject({
			version: "1.0.0",
			permission: "research-read",
			timeoutMs: 40_000,
			costCategory: "rate-limited",
			sideEffect: "external-read+archive-write",
			networkAllowlist: { kind: "public-web" },
		});
		expect(web?.argsHint.startsWith("{")).toBe(true);
		expect(web?.description).toContain("cannot search");
	});
});

describe("position tools without a configured source", () => {
	it("reports US short interest as unavailable, with a contract-valid record and no request", async () => {
		const { fetcher, registry } = setup();
		const result = await registry
			.get("positions.us_short_interest")
			?.execute({ ticker: "xtesta", securityId: "run_test_sec3" }, createToolContext());
		if (result === undefined || !result.ok) throw new Error("unexpected failure");
		expect(fetcher.calls).toHaveLength(0);
		expect(result.value.evidence).toEqual([]);
		expect(result.value.positionObservations).toHaveLength(1);
		const [observation] = result.value.positionObservations;
		expect(positionObservationSchema.safeParse(observation).success).toBe(true);
		expect(observation).toMatchObject({
			observationId: "run_test_po1",
			securityId: "run_test_sec3",
			jurisdiction: "US",
			metric: "us-short-interest",
			figures: null,
			unavailableReason: NO_US_SHORT_INTEREST_SOURCE_REASON,
			unit: "shares",
			asOfDate: null,
			disseminatedAt: null,
			sourceEvidenceId: null,
		});
		expect(observation?.metricDefinition).toContain(
			"Not equivalent to Japan's margin-sale balance",
		);
		expect(result.value.modelText).toContain("UNAVAILABLE");
		expect(result.value.modelText).toContain("do not estimate");
		expect(result.value.modelText).not.toMatch(/\d{4,}/);
	});

	it("reports JP margin balances as unavailable, separately labelled", async () => {
		const { fetcher, registry } = setup();
		const context = createToolContext();
		const result = await registry
			.get("positions.jp_margin_balance")
			?.execute({ code: "7203" }, context);
		if (result === undefined || !result.ok) throw new Error("unexpected failure");
		expect(fetcher.calls).toHaveLength(0);
		const [observation] = result.value.positionObservations;
		expect(positionObservationSchema.safeParse(observation).success).toBe(true);
		expect(observation).toMatchObject({
			jurisdiction: "JP",
			metric: "jp-margin-balance",
			figures: null,
			unavailableReason: NO_JP_MARGIN_BALANCE_SOURCE_REASON,
		});
		expect(observation?.metricDefinition).toContain("信用取引残高");
		expect(observation?.metricDefinition).toContain("Not comparable to US short interest");
		// Without a securityId argument the observation says it is not linked to a Security.
		expect(result.value.modelText).toContain("not linked to a Security record");
		expect(context.allocatedIds).toHaveLength(2);
	});

	it("rejects malformed tickers and codes", async () => {
		const { registry } = setup();
		for (const args of [
			{ ticker: "" },
			{ ticker: "TOO-LONG-TICKER-X" },
			{ ticker: "A", securityId: "bad id" },
			{},
		]) {
			expect(
				await registry.get("positions.us_short_interest")?.execute(args, createToolContext()),
			).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
		}
		for (const args of [{ code: "72" }, { code: "72033" }, { code: "ABCD" }, { code: 7203 }]) {
			expect(
				await registry.get("positions.jp_margin_balance")?.execute(args, createToolContext()),
			).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
		}
	});

	it("carries figures, dates and evidence when a source is configured", async () => {
		const [usTool] = createPositionTools({
			usShortInterest: {
				latestShortInterest: async ({ ticker }) =>
					ok({
						figures: {
							jurisdiction: "US",
							metric: "us-short-interest",
							reportedShortInterestShares: 1_500_000,
							averageDailyVolumeShares: 500_000,
						},
						settlementDate: "2026-09-30",
						disseminatedAt: "2026-10-09T20:00:00.000Z",
						provenance: {
							sourceUrl: `https://short-interest.synthetic-wire.org/${ticker}`,
							title: `Synthetic short interest for ${ticker}`,
							publisher: "Synthetic Short Interest Source",
							publishedAt: "2026-10-09T20:00:00.000Z",
							retrievedText: `${ticker} short interest 1,500,000 shares as of 2026-09-30`,
						},
					}),
			},
			jpMarginBalance: unconfiguredJpMarginBalanceSource,
			hasher: webCryptoHasher,
		});
		const result = await usTool?.execute(
			{ ticker: "XTESTA", securityId: "sec_9" },
			createToolContext(),
		);
		if (result === undefined || !result.ok) throw new Error("unexpected failure");
		const [observation] = result.value.positionObservations;
		const [collected] = result.value.evidence;
		expect(positionObservationSchema.safeParse(observation).success).toBe(true);
		expect(evidenceSchema.safeParse(collected?.evidence).success).toBe(true);
		expect(observation).toMatchObject({
			securityId: "sec_9",
			figures: { reportedShortInterestShares: 1_500_000, averageDailyVolumeShares: 500_000 },
			unavailableReason: null,
			asOfDate: "2026-09-30",
			disseminatedAt: "2026-10-09T20:00:00.000Z",
			sourceEvidenceId: collected?.evidence.evidenceId,
		});
		expect(collected?.evidence).toMatchObject({
			sourceClass: "market-data",
			retrievedAt: NOW_ISO,
			effectiveAt: "2026-09-30T00:00:00.000Z",
			excerpt: null,
		});
		// A market-data source's terms are unknown to the tool: no passage may be stored.
		expect(collected?.retainQuotes).toBe(false);
	});
});

describe("shared tool helpers", () => {
	it("bounds model text by UTF-8 bytes and says when it cut", () => {
		const short = boundModelText(["one", "two"]);
		expect(short).toBe("one\ntwo");
		const long = boundModelText(["header", "日本語のテキスト。".repeat(2_000), "never shown"]);
		expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(MAX_MODEL_TEXT_BYTES);
		expect(long.startsWith("header\n日本語")).toBe(true);
		expect(long.endsWith("[output truncated]")).toBe(true);
		expect(long).not.toContain("never shown");
		// No replacement character from a split multi-byte sequence.
		expect(long).not.toContain("�");
	});

	it("truncates on code points and never exceeds the limit", () => {
		expect(truncateText("short", 10)).toBe("short");
		expect(truncateText("abcdefghij", 5)).toBe("abcd…");
		const emoji = truncateText("😀".repeat(10), 6);
		expect(emoji.length).toBeLessThanOrEqual(6);
		expect(emoji).toBe("😀😀…");
	});

	it("stores an excerpt only when quotes may be retained, and always states which", async () => {
		const input = {
			evidenceId: "ev_1",
			sourceUrl: "https://news.synthetic-wire.org/a",
			title: "A title",
			publisher: "Synthetic Industry Wire",
			publishedAt: null,
			retrievedAt: NOW_ISO,
			effectiveAt: null,
			sourceClass: "news",
			retrievedText: "Full article text that verification may read during the run.",
			excerpt: "Full article text",
		} as const;
		const permitted = await collectEvidence(webCryptoHasher, { ...input, retainQuotes: true });
		expect(permitted.retainQuotes).toBe(true);
		expect(permitted.evidence.excerpt).toBe("Full article text");
		// Even if a caller hands over an excerpt, a headline-only source keeps none.
		const headlineOnly = await collectEvidence(webCryptoHasher, { ...input, retainQuotes: false });
		expect(headlineOnly.retainQuotes).toBe(false);
		expect(headlineOnly.evidence.excerpt).toBeNull();
		expect(headlineOnly.retrievedText).toBe(input.retrievedText);
		expect(headlineOnly.evidence.checksum).toBe(permitted.evidence.checksum);
	});
});
