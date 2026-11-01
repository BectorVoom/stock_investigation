/**
 * The examples in docs/external-apis/apis/massive.md, fed through the
 * Massive parsers and source the TypeScript runner uses (conventions §4):
 * each documented body is parsed as is, and served by the scripted fetcher
 * at the exact URL the source builds for the documented request.
 */
import type { MarketRequestAdmission } from "@research/application";
import { describe, expect, it } from "vitest";
import {
	createMassiveStockPriceSource,
	parseMassiveDay,
	parseMassiveHistory,
	parseMassiveSplits,
} from "../../src/finance/massive.ts";
import { docExampleText } from "../docExamples.ts";
import { createScriptedFetcher, type ScriptedPage } from "../tools/support.ts";
import { expectErr, expectOk } from "./support.ts";

const API_KEY = "massive-doc-example-key";
const HOST = "https://api.massive.com";
const context = {
	signal: new AbortController().signal,
	/** Admits every request, as an unpaced runner would. */
	beforeRequest: (): Promise<MarketRequestAdmission> => Promise.resolve("granted"),
};

const groupedText = docExampleText("massive", "massive-grouped-daily");
const rangeText = docExampleText("massive", "massive-range-aapl");
const splitsText = docExampleText("massive", "massive-splits");

function sourceServing(pages: Record<string, ScriptedPage>) {
	const fetcher = createScriptedFetcher(pages);
	return { fetcher, source: createMassiveStockPriceSource({ apiKey: API_KEY, fetcher }) };
}

describe("Massive document examples", () => {
	it("maps the grouped sample's tickers to the directory's form, with each day's bar", () => {
		// `KIMpL` is a preferred line (KIM-PL in SEC's list); `v` may be fractional.
		expect(parseMassiveDay(JSON.parse(groupedText))).toEqual([
			["KIM-PL", 25.9102, [26.07, 26.25, 25.91, 4369]],
			["TANH", 23.4, [24.5, 24.763, 22.65, 25933.6]],
			["VSAT", 34.24, [34.9, 35.47, 34.21, 312583]],
		]);
	});

	it("asks the documented grouped URL with the Bearer header", async () => {
		const url = `${HOST}/v2/aggs/grouped/locale/us/market/stocks/2020-10-14?adjusted=true`;
		const { fetcher, source } = sourceServing({ [url]: { text: groupedText } });
		const answer = expectOk(await source.fetchDay("2020-10-14", context));
		expect(answer.bars.map(([symbol]) => symbol)).toEqual(["KIM-PL", "TANH", "VSAT"]);
		expect(answer.adjustedSymbols).toEqual([]);
		expect(fetcher.urls()).toEqual([url]);
		expect(fetcher.calls[0]?.options.authorization).toBe(`Bearer ${API_KEY}`);
		expect(fetcher.calls[0]?.options.allowedHosts?.has("api.massive.com")).toBe(true);
	});

	it("dates the range sample's bars by their New York day and keeps its next page", () => {
		const parsed = parseMassiveHistory(JSON.parse(rangeText));
		// `t` 1577941200000 is 2020-01-02T05:00Z: midnight in New York.
		expect(parsed?.bars).toEqual([
			["2020-01-02", 75.0875, [74.06, 75.15, 73.7975, 135647456]],
			["2020-01-03", 74.3575, [74.2875, 75.145, 74.125, 146535512]],
		]);
		expect(parsed?.next).toBe(
			"https://api.massive.com/v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw",
		);
	});

	it("asks the documented range URL, then follows the sample's next_url as given", async () => {
		const first = `${HOST}/v2/aggs/ticker/AAPL/range/1/day/2020-01-01/2020-01-10?adjusted=true&sort=asc&limit=50000`;
		const next = `${HOST}/v2/aggs/ticker/AAPL/range/1/day/1578114000000/2020-01-10?cursor=bGltaXQ9MiZzb3J0PWFzYw`;
		// The documented next page is not published: the scripted fetcher answers it 404.
		const { fetcher, source } = sourceServing({ [first]: { text: rangeText } });
		const problem = expectErr(
			await source.fetchHistory("AAPL", "2020-01-01", "2020-01-10", context),
		);
		expect(problem).toEqual({ kind: "not-found", status: 404 });
		expect(fetcher.urls()).toEqual([first, next]);
		expect(fetcher.calls[1]?.options.authorization).toBe(`Bearer ${API_KEY}`);
	});

	it("reads the split sample's ticker as a directory symbol", async () => {
		expect(parseMassiveSplits(JSON.parse(splitsText))).toEqual({ symbols: ["AAPL"], next: null });
		const url = `${HOST}/stocks/v1/splits?execution_date.gt=2026-10-23&execution_date.lte=2026-10-30&limit=5000`;
		const { fetcher, source } = sourceServing({ [url]: { text: splitsText } });
		expect(expectOk(await source.fetchSplitSymbols("2026-10-23", "2026-10-30", context))).toEqual([
			"AAPL",
		]);
		expect(fetcher.urls()).toEqual([url]);
	});
});
