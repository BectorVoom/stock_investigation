/**
 * The examples in docs/external-apis/apis/jquants.md, fed through the
 * J-Quants parsers and source the TypeScript runner uses (conventions §4):
 * each documented body is parsed as is, and served by the scripted fetcher
 * at the exact URLs the source builds for the documented requests.
 */
import type { MarketRequestAdmission } from "@research/application";
import { describe, expect, it } from "vitest";
import {
	createJquantsStockPriceSource,
	jquantsDayAnswer,
	jquantsHistoryBars,
	jquantsProblem,
	parseJquantsPage,
} from "../../src/finance/jquants.ts";
import {
	createJquantsFinancialsSource,
	createJquantsProfileSource,
	jquantsMasterToProfiles,
	jquantsSummariesToSync,
} from "../../src/finance/jquantsFinancials.ts";
import { docExampleJson, docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, type ScriptedPage } from "../tools/support.ts";
import { jquantsTarget, queryFor } from "./equitySyncSupport.ts";
import { expectErr, expectOk } from "./support.ts";

const API_KEY = "jquants-doc-example-key";
const BASE = "https://api.jquants.com/v2/equities/bars/daily";
const context = {
	signal: new AbortController().signal,
	/** Admits every request, as an unpaced runner would. */
	beforeRequest: (): Promise<MarketRequestAdmission> => Promise.resolve("granted"),
};

const barsText = docExampleText("jquants", "jquants-bars-daily");
const noDataText = docExampleText("jquants", "jquants-no-data");
/** The sample's one record (`86970`, adjusted values equal to the raw ones). */
const SAMPLE_BAR = [2045, [2047, 2069, 2035, 2202500]] as const;

function sourceServing(pages: Record<string, ScriptedPage>) {
	const fetcher = createScriptedFetcher(pages);
	return {
		fetcher,
		source: createJquantsStockPriceSource({ apiKey: API_KEY, fetcher, delayDays: 84 }),
	};
}

describe("J-Quants document examples", () => {
	it("reads the sample page: its 5-character code as the directory's code, the adjusted values", () => {
		const page = parseJquantsPage(JSON.parse(barsText));
		expect(page?.next).toBe("value1.value2.");
		expect(page?.records).toHaveLength(1);
		const records = page?.records ?? [];
		expect(jquantsDayAnswer(records, "2023-03-24")).toEqual({
			bars: [["8697", ...SAMPLE_BAR]],
			// `AdjFactor` 1.0: no adjustment that day.
			adjustedSymbols: [],
		});
		// Another date's records are not that day's answer.
		expect(jquantsDayAnswer(records, "2023-03-23").bars).toEqual([]);
		expect(jquantsHistoryBars(records, "8697")).toEqual([["2023-03-24", ...SAMPLE_BAR]]);
	});

	it("reads the empty answer as the last page without records", () => {
		expect(parseJquantsPage(docExampleJson("jquants", "jquants-no-data"))).toEqual({
			records: [],
			next: null,
		});
	});

	it("asks the documented day URLs, following pagination_key, with the x-api-key header", async () => {
		const first = `${BASE}?date=2023-03-24`;
		const next = `${BASE}?date=2023-03-24&pagination_key=value1.value2.`;
		const { fetcher, source } = sourceServing({
			[first]: { text: barsText },
			[next]: { text: noDataText },
		});
		const answer = expectOk(await source.fetchDay("2023-03-24", context));
		expect(answer.bars).toEqual([["8697", ...SAMPLE_BAR]]);
		expect(fetcher.urls()).toEqual([first, next]);
		for (const call of fetcher.calls) {
			expect(call.options.xApiKey).toBe(API_KEY);
			expect(call.options.authorization).toBeUndefined();
			expect(call.options.includeErrorBody).toBe(true);
		}
	});

	it("asks the documented window URL by 5-character code", async () => {
		const first = `${BASE}?code=86970&from=2023-03-01&to=2023-03-31`;
		const next = `${first}&pagination_key=value1.value2.`;
		const { fetcher, source } = sourceServing({
			[first]: { text: barsText },
			[next]: { text: noDataText },
		});
		const bars = expectOk(await source.fetchHistory("8697", "2023-03-01", "2023-03-31", context));
		expect(bars).toEqual([["2023-03-24", ...SAMPLE_BAR]]);
		expect(fetcher.urls()).toEqual([first, next]);
	});

	it("tells the documented invalid-key 403 from a plan refusal, and keeps the 400's status", () => {
		const invalidKey = docExampleText("jquants", "jquants-error-invalid-key");
		expect(
			jquantsProblem({ code: "HTTP_ERROR", detail: "HTTP 403", status: 403, body: invalidKey }),
		).toEqual({ kind: "auth-failed", status: 403 });
		// The same status with another message is the plan, not the key.
		const missing = docExampleText("jquants", "jquants-error-missing-parameter");
		expect(
			jquantsProblem({ code: "HTTP_ERROR", detail: "HTTP 403", status: 403, body: missing }),
		).toEqual({ kind: "plan-refused", status: 403 });
		expect(
			jquantsProblem({ code: "HTTP_ERROR", detail: "HTTP 400", status: 400, body: missing }),
		).toEqual({ kind: "failed", status: 400 });
	});

	it("turns the documented summaries into JT's FY2024 summary and its correction (ADR-0059 §2)", () => {
		const page = parseJquantsPage(docExampleJson("jquants", "jquants-fins-summary"));
		expect(page?.next).toBeNull();
		const data = jquantsSummariesToSync("29140", [], page?.records ?? []);
		expect(data.identity).toEqual({ sourceCompanyId: "29140", name: null, fiscalYearEnd: "12-31" });
		expect(data.more).toBe(false);
		// Newest first; the 3Q summary is not a filing.
		expect(
			data.filings.map((filing) => [
				filing.sourceDocumentId,
				filing.form,
				filing.amendsSourceDocumentId,
				filing.submittedAt,
				filing.accountingStandard,
			]),
		).toEqual([
			[
				"20250310590632",
				"amended-earnings-report",
				"20250212569311",
				"2025-03-10T06:30:00.000Z",
				"IFRS",
			],
			["20250212569311", "earnings-report", null, "2025-02-13T06:30:00.000Z", "IFRS"],
		]);
		const operatingProfit = (index: number) =>
			data.filings[index]?.facts.find(
				(fact) => fact.concept === "jquants:OP" && fact.scope === "consolidated",
			)?.valueDecimal;
		expect([operatingProfit(1), operatingProfit(0)]).toEqual(["697203000000", "323461000000"]);
		expect(data.filings[1]?.sourceUrl).toBe(
			"https://api.jquants.com/v2/fins/summary?code=29140&date=2025-02-13",
		);
	});

	it("asks the documented summaries URL with the x-api-key header, and reads the empty answer", async () => {
		const url = "https://api.jquants.com/v2/fins/summary?code=29140";
		const fetcher = createScriptedFetcher({
			[url]: { text: docExampleText("jquants", "jquants-fins-summary") },
			"https://api.jquants.com/v2/fins/summary?code=99990": {
				text: docExampleText("jquants", "jquants-fins-summary-empty"),
			},
		});
		const source = createJquantsFinancialsSource({ apiKey: API_KEY, fetcher });
		const data = expectOk(await source.sync(queryFor(jquantsTarget({ code: "29140" })).query));
		expect(data.filings).toHaveLength(2);
		expect(data.requests).toBe(1);
		expect(fetcher.calls[0]?.options.xApiKey).toBe(API_KEY);
		const empty = expectOk(await source.sync(queryFor(jquantsTarget({ code: "99990" })).query));
		expect(empty).toMatchObject({ identity: null, filings: [], more: false, requests: 1 });
	});

	it("fails the documented invalid-code 400 as a parse failure, keeping its status", async () => {
		const fetcher = createScriptedFetcher({
			"https://api.jquants.com/v2/fins/summary?code=72030": {
				error: {
					code: "HTTP_ERROR",
					detail: "HTTP 400",
					status: 400,
					body: docExampleText("jquants", "jquants-error-invalid-code"),
				},
			},
		});
		const source = createJquantsFinancialsSource({ apiKey: API_KEY, fetcher });
		expect(expectErr(await source.sync(queryFor(jquantsTarget()).query))).toEqual({
			code: "FINANCIAL_PARSE_FAILED",
			upstreamStatus: 400,
			requests: 1,
		});
	});

	it("turns the documented master into the common stocks' profiles (ADR-0059 §3)", async () => {
		const page = parseJquantsPage(docExampleJson("jquants", "jquants-equities-master"));
		const profiles = jquantsMasterToProfiles(page?.records ?? []);
		// ITO EN's preferred line (25935) is not a directory stock.
		expect(profiles.map((profile) => profile.symbol)).toEqual(["7203", "130A"]);
		expect(profiles[0]).toEqual({
			symbol: "7203",
			nameEn: "TOYOTA MOTOR CORPORATION",
			sector17Code: "6",
			sector17Name: "自動車・輸送機",
			sector33Code: "3700",
			sector33Name: "輸送用機器",
			scaleCategory: "TOPIX Core30",
			marketSegmentCode: "0111",
			marketSegmentName: "プライム",
			asOf: "2026-08-10",
		});
		expect(profiles[1]?.scaleCategory).toBeNull();
		const fetcher = createScriptedFetcher({
			"https://api.jquants.com/v2/equities/master": {
				text: docExampleText("jquants", "jquants-equities-master"),
			},
		});
		const source = createJquantsProfileSource({ apiKey: API_KEY, fetcher });
		const fetched = expectOk(
			await source.fetchProfiles({
				signal: new AbortController().signal,
				beforeRequest: () => Promise.resolve(true),
			}),
		);
		expect(fetched).toEqual({ profiles, requests: 1 });
	});
});
