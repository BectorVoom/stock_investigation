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
import { docExampleJson, docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, type ScriptedPage } from "../tools/support.ts";
import { expectOk } from "./support.ts";

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
});
