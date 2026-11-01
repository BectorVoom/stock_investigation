/**
 * The provider-neutral `stock-prices-sync` body and its rules (ADR-0058 §2):
 * ticker and code mapping, market dates, day outcomes and the job walk
 * over a scripted source.
 */
import type { MarketRequestAdmission } from "@research/application";
import type { StockDayBar, StockHistoryBar } from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	delayedDayOutcome,
	emptyDayOutcome,
	jquantsCodeToSymbol,
	marketToday,
	massiveTickerToSymbol,
	newYorkDate,
	planRefusalOutcome,
	type StockDayAnswer,
	type StockPriceProblem,
	type StockPriceSource,
	type StockPricesJob,
	symbolToJquantsCode,
	symbolToMassiveTicker,
	syncStockPrices,
	tokyoDate,
} from "../../src/finance/stockPrices.ts";

describe("Massive tickers ↔ directory symbols", () => {
	const pairs: readonly (readonly [string, string])[] = [
		["AAPL", "AAPL"],
		["BRKHU", "BRKHU"],
		["BRK.B", "BRK-B"],
		["MKC.V", "MKC-V"],
		["KIMpL", "KIM-PL"],
		["DCOMp", "DCOM-P"],
		["AAC.WS", "AAC-WT"],
		["NE.WS.A", "NE-WTA"],
		["AAC.U", "AAC-UN"],
		["AIIAr", "AIIA-RI"],
		["MSGKw", "MSGK-WI"],
	];
	it("maps each form both ways", () => {
		for (const [ticker, symbol] of pairs) {
			expect(massiveTickerToSymbol(ticker), ticker).toBe(symbol);
			expect(symbolToMassiveTicker(symbol), symbol).toBe(ticker);
		}
	});
	it("drops what has no directory form", () => {
		for (const ticker of [
			"",
			"brk.b",
			"BRK.BB",
			"AB-C",
			"X.WS.AB",
			"ABpDE",
			"A B",
			"ÄBC",
			"ABCDEFGHIJKLMNOPQ",
		]) {
			expect(massiveTickerToSymbol(ticker), ticker).toBeNull();
		}
		for (const symbol of ["BRK-ABCD", "BRK-", "-A", "BRK.B", "BRK-pA"]) {
			expect(symbolToMassiveTicker(symbol), symbol).toBeNull();
		}
	});
});

describe("J-Quants codes ↔ directory symbols", () => {
	it("keeps 5-character codes ending in 0 as their first four", () => {
		expect(jquantsCodeToSymbol("13800")).toBe("1380");
		expect(jquantsCodeToSymbol("130A0")).toBe("130A");
		expect(symbolToJquantsCode("1380")).toBe("13800");
		expect(symbolToJquantsCode("130A")).toBe("130A0");
	});
	it("drops preferred lines and malformed codes", () => {
		for (const code of ["25935", "1380", "138000", "A3800", "130a0", ""]) {
			expect(jquantsCodeToSymbol(code), code).toBeNull();
		}
		for (const symbol of ["AAPL", "13800", "130a", ""]) {
			expect(symbolToJquantsCode(symbol), symbol).toBeNull();
		}
	});
});

describe("market dates", () => {
	it("follows US daylight time for New York", () => {
		// 2026: daylight time from 2026-03-08 07:00Z to 2026-11-01 06:00Z.
		expect(newYorkDate(Date.parse("2026-03-08T06:59:59Z"))).toBe("2026-03-08");
		expect(newYorkDate(Date.parse("2026-03-08T04:30:00Z"))).toBe("2026-03-07");
		expect(newYorkDate(Date.parse("2026-07-01T03:59:59Z"))).toBe("2026-06-30");
		expect(newYorkDate(Date.parse("2026-07-01T04:00:00Z"))).toBe("2026-07-01");
		expect(newYorkDate(Date.parse("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
		expect(newYorkDate(Date.parse("2026-11-02T04:30:00Z"))).toBe("2026-11-01");
		expect(newYorkDate(Date.parse("2026-11-02T05:00:00Z"))).toBe("2026-11-02");
		expect(newYorkDate(Date.parse("2027-01-01T04:59:59Z"))).toBe("2026-12-31");
	});
	it("is UTC+9 for Tokyo", () => {
		expect(tokyoDate(Date.parse("2026-11-01T14:59:59Z"))).toBe("2026-11-01");
		expect(tokyoDate(Date.parse("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
		expect(marketToday("JP", Date.parse("2026-11-01T15:00:00Z"))).toBe("2026-11-02");
		expect(marketToday("US", Date.parse("2026-11-01T15:00:00Z"))).toBe("2026-11-01");
	});
});

describe("day outcomes", () => {
	it("holds back days within the plan's delay", () => {
		expect(delayedDayOutcome(83, 84)).toBe("not-yet-available");
		expect(delayedDayOutcome(84, 84)).toBeNull();
		expect(delayedDayOutcome(0, 0)).toBeNull();
	});
	it("settles an empty day after settleDays beyond the delay", () => {
		expect(emptyDayOutcome(3, 0)).toBe("not-yet-available");
		expect(emptyDayOutcome(4, 0)).toBe("no-trading");
		expect(emptyDayOutcome(87, 84)).toBe("not-yet-available");
		expect(emptyDayOutcome(88, 84)).toBe("no-trading");
	});
	it("reads a plan refusal by the day's age", () => {
		expect(planRefusalOutcome(0, 0)).toBe("not-yet-available");
		expect(planRefusalOutcome(3, 0)).toBe("not-yet-available");
		expect(planRefusalOutcome(4, 0)).toBeNull();
		expect(planRefusalOutcome(365, 0)).toBeNull();
		expect(planRefusalOutcome(366, 0)).toBe("too-old");
		expect(planRefusalOutcome(449, 84)).toBeNull();
		expect(planRefusalOutcome(450, 84)).toBe("too-old");
	});
});

/* ---------- The job walk over a scripted source ---------- */

const NOW = Date.parse("2026-10-31T15:00:00Z"); // 2026-10-31 in New York, 2026-11-01 in Tokyo
const NEVER = new AbortController().signal;
const bar = (symbol: string, close: number): StockDayBar => [
	symbol,
	close,
	[close, close, close, 1],
];
const historyBar = (date: string, close: number): StockHistoryBar => [
	date,
	close,
	[close, close, close, 1],
];

type DayScript = Result<StockDayAnswer, StockPriceProblem>;
type HistoryScript = Result<readonly StockHistoryBar[], StockPriceProblem>;

interface Scripted extends StockPriceSource {
	readonly calls: string[];
}

function scriptedSource(script: {
	readonly market?: "US" | "JP";
	readonly delayDays?: number;
	readonly days?: Readonly<Record<string, DayScript>>;
	/** Each stock's answers in call order (the last one repeats). */
	readonly histories?: Readonly<Record<string, readonly HistoryScript[]>>;
	readonly splits?: Result<readonly string[], StockPriceProblem>;
}): Scripted {
	const calls: string[] = [];
	const historyCalls = new Map<string, number>();
	const market = script.market ?? "US";
	return {
		calls,
		provider: market === "US" ? "massive" : "jquants",
		market,
		delayDays: script.delayDays ?? 0,
		splitsInDayAnswers: market === "JP",
		async fetchDay(date) {
			calls.push(`day ${date}`);
			return script.days?.[date] ?? ok({ bars: [], adjustedSymbols: [] });
		},
		async fetchHistory(symbol, from, to) {
			calls.push(`history ${symbol} ${from} ${to}`);
			const entry = script.histories?.[symbol];
			const index = historyCalls.get(symbol) ?? 0;
			historyCalls.set(symbol, index + 1);
			const answer = entry?.[Math.min(index, entry.length - 1)];
			return answer ?? err({ kind: "not-found", status: 404 });
		},
		async fetchSplitSymbols(after, through) {
			calls.push(`splits ${after} ${through}`);
			return script.splits ?? ok([]);
		},
	};
}

function job(fields: Partial<StockPricesJob> = {}): StockPricesJob {
	return {
		kind: "stock-prices-sync",
		runId: "run_1",
		leaseGeneration: 1,
		leaseExpiresAt: "2026-10-31T16:00:00.000Z",
		attempt: 1,
		heartbeatIntervalMs: 20_000,
		sources: [],
		market: "US",
		days: ["2026-10-30", "2026-10-29"],
		histories: [],
		adjustmentsSince: null,
		windowStart: "2024-11-01",
		...fields,
	};
}

const run = (claim: StockPricesJob, source: StockPriceSource) =>
	syncStockPrices(claim, source, {
		nowMs: NOW,
		signal: NEVER,
		beforeRequest: (): Promise<MarketRequestAdmission> => Promise.resolve("granted"),
	});

describe("syncStockPrices", () => {
	it("stores bars, reads an empty recent day as not yet available and an old one as a holiday", async () => {
		const source = scriptedSource({
			days: { "2026-10-30": ok({ bars: [bar("AAPL", 270)], adjustedSymbols: [] }) },
		});
		const outcome = await run(job({ days: ["2026-10-30", "2026-10-29", "2026-10-20"] }), source);
		expect(outcome).toEqual({
			kind: "synced",
			days: [
				{ date: "2026-10-30", outcome: "stored", bars: [bar("AAPL", 270)] },
				{ date: "2026-10-29", outcome: "not-yet-available", bars: [] },
				{ date: "2026-10-20", outcome: "no-trading", bars: [] },
			],
			histories: [],
			splitsOverCap: 0,
			endedBy: null,
		});
	});

	it("asks nothing for days within the J-Quants delay", async () => {
		const source = scriptedSource({ market: "JP", delayDays: 84 });
		const outcome = await run(job({ market: "JP", days: ["2026-10-30", "2026-08-03"] }), source);
		expect(source.calls).toEqual(["day 2026-08-03"]);
		expect(outcome.kind === "synced" && outcome.days.map((day) => day.outcome)).toEqual([
			"not-yet-available",
			"no-trading",
		]);
	});

	it("maps plan refusals by age, and fails the job when the plan lacks recent data", async () => {
		const refused = err<StockPriceProblem>({ kind: "plan-refused", status: 403 });
		const edges = scriptedSource({ days: { "2026-10-30": refused, "2024-10-01": refused } });
		const outcome = await run(job({ days: ["2026-10-30", "2024-10-01"] }), edges);
		expect(outcome.kind === "synced" && outcome.days).toEqual([
			{ date: "2026-10-30", outcome: "not-yet-available", bars: [], upstreamStatus: 403 },
			{ date: "2024-10-01", outcome: "too-old", bars: [], upstreamStatus: 403 },
		]);
		const middle = scriptedSource({ days: { "2026-06-01": refused } });
		expect(await run(job({ days: ["2026-06-01"] }), middle)).toEqual({
			kind: "failed",
			code: "PLAN_NOT_ENTITLED",
			upstreamStatus: 403,
			retryable: false,
		});
	});

	it("fails the whole job on a rejected key, with the provider's status", async () => {
		const source = scriptedSource({
			days: { "2026-10-29": err({ kind: "auth-failed", status: 401 }) },
		});
		expect(await run(job(), source)).toEqual({
			kind: "failed",
			code: "SOURCE_AUTH_FAILED",
			upstreamStatus: 401,
			retryable: false,
		});
	});

	it("ends the fetching at a rate limit and reports what it has, or fails when it has nothing", async () => {
		const limited = err<StockPriceProblem>({ kind: "rate-limited", status: 429 });
		const some = scriptedSource({
			days: {
				"2026-10-30": ok({ bars: [bar("AAPL", 270)], adjustedSymbols: [] }),
				"2026-10-29": limited,
			},
		});
		const outcome = await run(
			job({
				days: ["2026-10-30", "2026-10-29", "2026-10-28"],
				histories: [{ symbol: "MSFT", from: "2024-11-01", to: "2026-10-30" }],
			}),
			some,
		);
		expect(some.calls).toEqual(["day 2026-10-30", "day 2026-10-29"]);
		expect(outcome).toMatchObject({ kind: "synced", endedBy: "rate-limited", histories: [] });
		const none = scriptedSource({ days: { "2026-10-30": limited } });
		expect(await run(job(), none)).toEqual({
			kind: "failed",
			code: "RATE_LIMITED",
			upstreamStatus: 429,
			retryable: false,
		});
		const broken = scriptedSource({ days: { "2026-10-30": err({ kind: "failed", status: 503 }) } });
		expect(await run(job(), broken)).toEqual({
			kind: "failed",
			code: "SOURCE_FAILED",
			upstreamStatus: 503,
			retryable: true,
		});
	});

	it("fetches requested histories, clamped to the plan's newest day, unknown stocks as not-found", async () => {
		const source = scriptedSource({
			market: "JP",
			delayDays: 84,
			histories: { "1380": [ok([historyBar("2026-08-07", 1204), historyBar("2026-08-06", 1200)])] },
		});
		const outcome = await run(
			job({
				market: "JP",
				days: [],
				histories: [
					{ symbol: "1380", from: "2024-08-05", to: "2026-10-30" },
					{ symbol: "9999", from: "2024-08-05", to: "2026-10-30" },
				],
			}),
			source,
		);
		expect(source.calls).toEqual([
			"history 1380 2024-08-05 2026-08-09",
			"history 9999 2024-08-05 2026-08-09",
		]);
		expect(outcome.kind === "synced" && outcome.histories).toEqual([
			{
				symbol: "1380",
				reason: "requested",
				outcome: "stored",
				from: "2024-08-05",
				to: "2026-08-09",
				bars: [historyBar("2026-08-06", 1200), historyBar("2026-08-07", 1204)],
			},
			{
				symbol: "9999",
				reason: "requested",
				outcome: "not-found",
				from: "2024-08-05",
				to: "2026-08-09",
				bars: [],
			},
		]);
	});

	it("asks a refused window once more from inside the plan's two years", async () => {
		const source = scriptedSource({
			histories: {
				AAPL: [err({ kind: "plan-refused", status: 403 }), ok([historyBar("2026-10-30", 270)])],
			},
		});
		const outcome = await run(
			job({ days: [], histories: [{ symbol: "AAPL", from: "2024-10-31", to: "2026-10-30" }] }),
			source,
		);
		expect(source.calls).toEqual([
			"history AAPL 2024-10-31 2026-10-30",
			"history AAPL 2024-11-30 2026-10-30",
		]);
		expect(outcome.kind === "synced" && outcome.histories[0]?.from).toBe("2024-11-30");
	});

	it("refetches split stocks after the stored days, within the history cap", async () => {
		const splitSymbols = ["NVDA", "AAPL", "NVDA", ...Array.from({ length: 12 }, (_, i) => `S${i}`)];
		const source = scriptedSource({
			days: { "2026-10-30": ok({ bars: [bar("AAPL", 270)], adjustedSymbols: [] }) },
			histories: { NVDA: [ok([historyBar("2026-10-30", 200)])] },
			splits: ok(splitSymbols),
		});
		const outcome = await run(
			job({
				adjustmentsSince: "2026-10-27",
				histories: [{ symbol: "AAPL", from: "2024-11-01", to: "2026-10-30" }],
			}),
			source,
		);
		expect(source.calls.slice(0, 4)).toEqual([
			"day 2026-10-30",
			"day 2026-10-29",
			"history AAPL 2024-11-01 2026-10-30",
			"splits 2026-10-27 2026-10-30",
		]);
		expect(source.calls[4]).toBe("history NVDA 2024-11-01 2026-10-30");
		// 1 requested + 9 split refetches; NVDA, S0…S11 are 13 candidates.
		expect(source.calls).toHaveLength(4 + 9);
		expect(outcome).toMatchObject({ kind: "synced", splitsOverCap: 4 });
		expect(outcome.kind === "synced" && outcome.histories[1]).toMatchObject({
			symbol: "NVDA",
			reason: "split",
			outcome: "stored",
		});
	});

	it("takes JP splits from the stored days' adjustment factors, not a listing", async () => {
		const source = scriptedSource({
			market: "JP",
			delayDays: 84,
			days: {
				"2026-08-07": ok({ bars: [bar("7203", 1420)], adjustedSymbols: ["7203"] }),
				"2026-08-06": ok({ bars: [bar("6758", 1)], adjustedSymbols: ["6758"] }),
			},
			histories: { "7203": [ok([historyBar("2026-08-07", 1420)])] },
		});
		await run(
			job({
				market: "JP",
				days: ["2026-08-07", "2026-08-06"],
				adjustmentsSince: "2026-08-06",
				windowStart: "2024-08-05",
			}),
			source,
		);
		expect(source.calls).toEqual([
			"day 2026-08-07",
			"day 2026-08-06",
			"history 7203 2024-08-05 2026-08-07",
		]);
	});

	it("stops without a result when the job is stopped", async () => {
		const source = scriptedSource({ days: { "2026-10-30": err({ kind: "stopped" }) } });
		expect(await run(job(), source)).toEqual({ kind: "stopped" });
	});
});
