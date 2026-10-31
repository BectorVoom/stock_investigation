import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../packages/application/test/support.ts";
import {
	createMarketPacer,
	DEFAULT_TWELVE_DATA_DAILY_LIMIT,
	FRED_RATE_LIMIT,
	GOOGLE_RATE_LIMIT,
	marketDailyBudgets,
	TWELVE_DATA_WINDOW_MS,
	twelveDataRateLimit,
} from "../src/marketPacing.ts";

const NEVER = new AbortController().signal;

describe("market request pacing (API-007)", () => {
	it("admits requests inside the window and waits out the excess with a fake clock", async () => {
		const time = fixedClock();
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([["twelve-data", twelveDataRateLimit(2)]]),
		});
		expect(await pacer.pace("twelve-data", NEVER)).toBe(true);
		expect(await pacer.pace("twelve-data", NEVER)).toBe(true);
		// The third start does not fit 2 per 60 s: it waits a full window, then proceeds.
		expect(await pacer.pace("twelve-data", NEVER)).toBe(true);
		expect(slept).toEqual([TWELVE_DATA_WINDOW_MS]);
	});

	it("tracks providers independently and shares one window across calls", async () => {
		const time = fixedClock();
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([
				["fred", FRED_RATE_LIMIT],
				["twelve-data", twelveDataRateLimit(1)],
			]),
		});
		expect(await pacer.pace("twelve-data", NEVER)).toBe(true);
		// Twelve Data is spent for this window, but FRED is untouched.
		expect(await pacer.pace("fred", NEVER)).toBe(true);
		expect(await pacer.pace("fred", NEVER)).toBe(true);
		expect(slept).toEqual([]);
		// A provider without a limit is always admitted.
		const open = createMarketPacer({
			clock: time.clock,
			sleep: async () => {
				throw new Error("must not sleep without a limit");
			},
			limits: new Map(),
		});
		expect(await open.pace("fred", NEVER)).toBe(true);
	});

	it("stops waiting when the signal aborts, without recording a grant", async () => {
		const time = fixedClock();
		const controller = new AbortController();
		let sleeps = 0;
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async () => {
				sleeps += 1;
				controller.abort();
			},
			limits: new Map([["twelve-data", twelveDataRateLimit(1)]]),
		});
		expect(await pacer.pace("twelve-data", NEVER)).toBe(true);
		expect(await pacer.pace("twelve-data", controller.signal)).toBe(false);
		expect(sleeps).toBe(1);
	});

	it("pins the documented defaults", () => {
		expect(FRED_RATE_LIMIT).toEqual({ maxPerWindow: 100, windowMs: 60_000 });
		expect(twelveDataRateLimit(8)).toEqual({ maxPerWindow: 8, windowMs: TWELVE_DATA_WINDOW_MS });
	});

	it("S6: takes one grant per admitted request; a named count takes that many", async () => {
		const time = fixedClock();
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([["fred", { maxPerWindow: 3, windowMs: TWELVE_DATA_WINDOW_MS }]]),
		});
		// The FRED adapter admits each request it sends: a cached series costs one grant.
		expect(await pacer.admit("fred", NEVER)).toBe("granted");
		expect(await pacer.pace("fred", NEVER, 2)).toBe(true);
		expect(slept).toEqual([]);
		expect(await pacer.admit("fred", NEVER)).toBe("granted");
		expect(slept).toEqual([TWELVE_DATA_WINDOW_MS]);
	});

	it("refuses at once, without waiting, when the UTC day's budget is spent", async () => {
		// 2026-10-11T23:59:00Z: one minute before the UTC date changes.
		const time = fixedClock("2026-10-11T23:59:00.000Z");
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([["twelve-data", twelveDataRateLimit(8)]]),
			dailyBudgets: new Map([["twelve-data", 2]]),
		});
		expect(await pacer.admit("twelve-data", NEVER)).toBe("granted");
		expect(await pacer.admit("twelve-data", NEVER)).toBe("granted");
		expect(await pacer.admit("twelve-data", NEVER)).toBe("budget-spent");
		expect(await pacer.pace("twelve-data", NEVER)).toBe(false);
		expect(slept).toEqual([]);
		// A refusal is not counted, and the count starts again at 00:00 UTC.
		time.advance(60_000);
		expect(await pacer.admit("twelve-data", NEVER)).toBe("granted");
		// A stopped job is told so before the budget is consulted.
		const stopped = new AbortController();
		stopped.abort();
		expect(await pacer.admit("twelve-data", stopped.signal)).toBe("stopped");
	});

	it("reserves all units of a multi-unit request at once (a Google PATCH costs 3 of 5)", async () => {
		const time = fixedClock();
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([["google", GOOGLE_RATE_LIMIT]]),
		});
		expect(await pacer.pace("google", NEVER, 3)).toBe(true);
		expect(slept).toEqual([]);
		// The second PATCH waits for the whole window instead of taking 2 now and 1 later.
		expect(await pacer.pace("google", NEVER, 3)).toBe(true);
		expect(slept).toEqual([1_000]);
		// 3 in the window: 2 more fit exactly, the next one waits.
		expect(await pacer.pace("google", NEVER, 2)).toBe(true);
		expect(slept).toEqual([1_000]);
		expect(await pacer.admit("google", NEVER)).toBe("granted");
		expect(slept).toEqual([1_000, 1_000]);
	});

	it("lets a request larger than the window take the whole window", async () => {
		const time = fixedClock();
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([["google", GOOGLE_RATE_LIMIT]]),
		});
		expect(await pacer.pace("google", NEVER, 7)).toBe(true);
		expect(slept).toEqual([]);
		expect(await pacer.pace("google", NEVER, 1)).toBe(true);
		expect(slept).toEqual([1_000]);
	});

	it("budgets Twelve Data by its configured daily limit; 0 means none", () => {
		expect(DEFAULT_TWELVE_DATA_DAILY_LIMIT).toBe(800);
		expect(marketDailyBudgets(800)).toEqual(new Map([["twelve-data", 800]]));
		expect(marketDailyBudgets(1)).toEqual(new Map([["twelve-data", 1]]));
		expect(marketDailyBudgets(0)).toEqual(new Map());
	});
});
