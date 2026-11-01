/**
 * The Massive US stock-price source (ADR-0058 §2) over the scripted fetcher:
 * the exact URLs, the Bearer header, ticker mapping, bar checks, pages and
 * the status mapping.
 */
import type { MarketRequestAdmission, SafeFetchError } from "@research/application";
import { describe, expect, it } from "vitest";
import { createMassiveStockPriceSource, massiveProblem } from "../../src/finance/massive.ts";
import { createScriptedFetcher, fixtureText, type ScriptedPage } from "../tools/support.ts";
import { expectErr, expectOk } from "./support.ts";

const API_KEY = "massive-test-key";
const NEVER = new AbortController().signal;
const HOST = "https://api.massive.com";
const fixture = (name: string): ScriptedPage => ({ text: fixtureText(`stock-prices/${name}`) });

function source(pages: Record<string, ScriptedPage>, admissions: MarketRequestAdmission[] = []) {
	const fetcher = createScriptedFetcher(pages);
	let admitted = 0;
	const context = {
		signal: NEVER,
		beforeRequest: async (): Promise<MarketRequestAdmission> => {
			admitted += 1;
			return admissions.shift() ?? "granted";
		},
	};
	return {
		fetcher,
		context,
		admitted: () => admitted,
		source: createMassiveStockPriceSource({ apiKey: API_KEY, fetcher }),
	};
}

const http = (status: number): ScriptedPage => ({
	error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status },
});

describe("Massive grouped daily", () => {
	const url = `${HOST}/v2/aggs/grouped/locale/us/market/stocks/2026-10-30?adjusted=true`;

	it("maps every listed form to the directory's and drops what it cannot store", async () => {
		const run = source({ [url]: fixture("massive-grouped-2026-10-30.synthetic.json") });
		const answer = expectOk(await run.source.fetchDay("2026-10-30", run.context));
		expect(answer.adjustedSymbols).toEqual([]);
		expect(answer.bars).toEqual([
			["AAC-UN", 10.02, [10.02, 10.02, 10.02, 100]],
			["AAC-WT", 0.12, [0.12, 0.13, 0.11, 20100]],
			["AAPL", 270.5, [268, 271, 267.5, 51234567]],
			["AIIA-RI", 0.2, [0.2, 0.21, 0.19, 900.5]],
			["BRK-B", 412.5, [410, 415.25, 409.5, 3120455]],
			["DCOM-P", 24.1, [24.05, 24.2, 24, 1500]],
			["KIM-PL", 25.9102, [26.07, 26.25, 25.91, 4369]],
			["MSGK-WI", 180, [181, 182, 179, 7000]],
			["NE-WTA", 10.5, [10.6, 10.9, 10.4, 8800]],
			// A negative volume is unknown, never stored.
			["NEGV", 5, [5, 6, 4, null]],
		]);
		const call = run.fetcher.calls[0];
		expect(call?.options.authorization).toBe(`Bearer ${API_KEY}`);
		expect(call?.options.maxBytes).toBe(8_000_000);
		expect([...(call?.options.allowedHosts ?? [])]).toEqual(["api.massive.com"]);
		// The key never travels in the URL.
		expect(call?.url).not.toContain(API_KEY);
		expect(run.admitted()).toBe(1);
	});

	it("reads a holiday's empty answer as no bars", async () => {
		const run = source({ [url]: fixture("massive-grouped-empty.synthetic.json") });
		expect(expectOk(await run.source.fetchDay("2026-10-30", run.context)).bars).toEqual([]);
	});

	it("maps 401 to the key, 403 to the plan, 429 to the rate limit, with the status kept", async () => {
		for (const [status, kind] of [
			[401, "auth-failed"],
			[403, "plan-refused"],
			[404, "not-found"],
			[429, "rate-limited"],
			[503, "failed"],
		] as const) {
			const run = source({ [url]: http(status) });
			expect(expectErr(await run.source.fetchDay("2026-10-30", run.context))).toEqual({
				kind,
				status,
			});
		}
		const unreadable = source({ [url]: { text: "[1,2]" } });
		expect(expectErr(await unreadable.source.fetchDay("2026-10-30", unreadable.context))).toEqual({
			kind: "failed",
			status: null,
		});
	});

	it("sends nothing when the admission is refused", async () => {
		const stopped = source({}, ["stopped"]);
		expect(expectErr(await stopped.source.fetchDay("2026-10-30", stopped.context))).toEqual({
			kind: "stopped",
		});
		const spent = source({}, ["budget-spent"]);
		expect(expectErr(await spent.source.fetchDay("2026-10-30", spent.context))).toEqual({
			kind: "rate-limited",
			status: null,
		});
		expect(stopped.fetcher.calls).toHaveLength(0);
		expect(spent.fetcher.calls).toHaveLength(0);
	});

	it("classifies a timeout as a source failure without a status", () => {
		const timeout: SafeFetchError = { code: "TIMEOUT", detail: "timed out" };
		expect(massiveProblem(timeout)).toEqual({ kind: "failed", status: null });
	});
});

describe("Massive range aggregates", () => {
	const first = `${HOST}/v2/aggs/ticker/BRK.B/range/1/day/2026-10-27/2026-10-30?adjusted=true&sort=asc&limit=50000`;
	const second = `${HOST}/v2/aggs/ticker/BRK.B/range/1/day/1793160000000/2026-10-30?cursor=c3ludGhldGlj`;

	it("asks in Massive's form, follows next_url and dates bars in New York", async () => {
		const run = source({
			[first]: fixture("massive-range-BRK.B-page1.synthetic.json"),
			[second]: fixture("massive-range-BRK.B-page2.synthetic.json"),
		});
		const bars = expectOk(
			await run.source.fetchHistory("BRK-B", "2026-10-27", "2026-10-30", run.context),
		);
		expect(bars.map(([date]) => date)).toEqual([
			"2026-10-27",
			"2026-10-28",
			"2026-10-29",
			"2026-10-30",
		]);
		expect(bars[3]).toEqual(["2026-10-30", 412.5, [410, 415.25, 409.5, 3120455]]);
		expect(run.fetcher.urls()).toEqual([first, second]);
		// Every page is paced.
		expect(run.admitted()).toBe(2);
	});

	it("answers not-found for a symbol Massive cannot spell, without a request", async () => {
		const run = source({});
		expect(
			expectErr(await run.source.fetchHistory("BRK-ABCD", "2026-10-27", "2026-10-30", run.context)),
		).toEqual({
			kind: "not-found",
			status: null,
		});
		expect(run.fetcher.calls).toHaveLength(0);
	});
});

describe("Massive splits", () => {
	it("lists the split tickers of the window in the directory's form", async () => {
		const url = `${HOST}/stocks/v1/splits?execution_date.gt=2026-10-27&execution_date.lte=2026-10-30&limit=5000`;
		const run = source({ [url]: fixture("massive-splits.synthetic.json") });
		expect(
			expectOk(await run.source.fetchSplitSymbols("2026-10-27", "2026-10-30", run.context)),
		).toEqual(["NVDA", "ABR-PD"]);
	});
});
