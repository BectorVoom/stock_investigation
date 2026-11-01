/**
 * The J-Quants JP stock-price source (ADR-0058 §2) over the scripted
 * fetcher: the exact URLs, the `x-api-key` header, pagination, adjusted
 * values, code mapping and the 403 split between key and plan.
 */
import type { MarketRequestAdmission } from "@research/application";
import { describe, expect, it } from "vitest";
import { createJquantsStockPriceSource } from "../../src/finance/jquants.ts";
import { createScriptedFetcher, fixtureText, type ScriptedPage } from "../tools/support.ts";
import { expectErr, expectOk } from "./support.ts";

const API_KEY = "jquants-test-key";
const NEVER = new AbortController().signal;
const BASE = "https://api.jquants.com/v2/equities/bars/daily";
const fixture = (name: string): ScriptedPage => ({ text: fixtureText(`stock-prices/${name}`) });
const context = {
	signal: NEVER,
	beforeRequest: (): Promise<MarketRequestAdmission> => Promise.resolve("granted"),
};

function source(pages: Record<string, ScriptedPage>) {
	const fetcher = createScriptedFetcher(pages);
	return {
		fetcher,
		source: createJquantsStockPriceSource({ apiKey: API_KEY, fetcher, delayDays: 84 }),
	};
}

const forbidden = (body: string): ScriptedPage => ({
	error: { code: "HTTP_ERROR", detail: "HTTP 403", status: 403, body },
});

describe("J-Quants daily bars by date", () => {
	const first = `${BASE}?date=2026-08-07`;
	const second = `${BASE}?date=2026-08-07&pagination_key=synthetic.page2.`;

	it("reads every page, keeps the adjusted values of common stock and flags adjustments", async () => {
		const run = source({
			[first]: fixture("jquants-daily-2026-08-07-page1.synthetic.json"),
			[second]: fixture("jquants-daily-2026-08-07-page2.synthetic.json"),
		});
		const answer = expectOk(await run.source.fetchDay("2026-08-07", context));
		expect(answer.bars).toEqual([
			["1380", 1204, [1210, 1220, 1190, 35000]],
			// The adjusted values of a 1:2 split day.
			["7203", 1420, [1400, 1430, 1395, 18000000]],
			["8697", 2045, [2047, 2069, 2035, 2202500]],
		]);
		expect(answer.adjustedSymbols).toEqual(["7203"]);
		expect(run.fetcher.urls()).toEqual([first, second]);
		const options = run.fetcher.calls[0]?.options;
		expect(options?.xApiKey).toBe(API_KEY);
		expect(options?.authorization).toBeUndefined();
		expect(options?.includeErrorBody).toBe(true);
		expect(run.fetcher.calls[0]?.url).not.toContain(API_KEY);
	});

	it("flags an adjustment on a day without trades although it gives no bar", async () => {
		const noTrade = {
			Date: "2026-08-07",
			Code: "45670",
			AdjO: null,
			AdjH: null,
			AdjL: null,
			AdjC: null,
			AdjVo: null,
			AdjFactor: 0.5,
		};
		const run = source({ [first]: { text: JSON.stringify({ data: [noTrade] }) } });
		expect(expectOk(await run.source.fetchDay("2026-08-07", context))).toEqual({
			bars: [],
			adjustedSymbols: ["4567"],
		});
	});

	it("reads an empty day as no bars", async () => {
		const run = source({ [first]: fixture("jquants-empty.synthetic.json") });
		expect(expectOk(await run.source.fetchDay("2026-08-07", context))).toEqual({
			bars: [],
			adjustedSymbols: [],
		});
	});

	it("tells a rejected key from a plan refusal by the 403 message", async () => {
		const key = source({
			[first]: forbidden(fixtureText("stock-prices/jquants-error-403-key.synthetic.json")),
		});
		expect(expectErr(await key.source.fetchDay("2026-08-07", context))).toEqual({
			kind: "auth-failed",
			status: 403,
		});
		const plan = source({
			[first]: forbidden(fixtureText("stock-prices/jquants-error-403-plan.synthetic.json")),
		});
		expect(expectErr(await plan.source.fetchDay("2026-08-07", context))).toEqual({
			kind: "plan-refused",
			status: 403,
		});
		const bare = source({ [first]: forbidden("not json") });
		expect(expectErr(await bare.source.fetchDay("2026-08-07", context))).toEqual({
			kind: "plan-refused",
			status: 403,
		});
	});

	it("fails a day whose later page fails, so a partial day is never stored", async () => {
		const run = source({
			[first]: fixture("jquants-daily-2026-08-07-page1.synthetic.json"),
			[second]: { error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429 } },
		});
		expect(expectErr(await run.source.fetchDay("2026-08-07", context))).toEqual({
			kind: "rate-limited",
			status: 429,
		});
	});
});

describe("J-Quants daily bars by code", () => {
	it("asks for the 5-character code over the window", async () => {
		const url = `${BASE}?code=13800&from=2026-08-05&to=2026-08-07`;
		const run = source({ [url]: fixture("jquants-history-13800.synthetic.json") });
		const bars = expectOk(
			await run.source.fetchHistory("1380", "2026-08-05", "2026-08-07", context),
		);
		expect(bars.map(([date, close]) => [date, close])).toEqual([
			["2026-08-05", 1195],
			["2026-08-06", 1200],
			["2026-08-07", 1204],
		]);
	});

	it("answers not-found for a symbol that is not a JP code, without a request", async () => {
		const run = source({});
		expect(
			expectErr(await run.source.fetchHistory("AAPL", "2026-08-05", "2026-08-07", context)).kind,
		).toBe("not-found");
		expect(run.fetcher.calls).toHaveLength(0);
	});
});
