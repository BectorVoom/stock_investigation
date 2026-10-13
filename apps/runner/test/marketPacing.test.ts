import { describe, expect, it } from "vitest";
import { fixedClock } from "../../../packages/application/test/support.ts";
import {
	createMarketPacer,
	FRED_RATE_LIMIT,
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

	it("S6: paces per request, not per series (FRED costs two grants)", async () => {
		const time = fixedClock();
		const slept: number[] = [];
		const pacer = createMarketPacer({
			clock: time.clock,
			sleep: async (ms) => {
				slept.push(ms);
				time.advance(ms);
			},
			limits: new Map([["fred", { maxPerWindow: 4, windowMs: TWELVE_DATA_WINDOW_MS }]]),
		});
		// One FRED series costs two requests: two pace() calls spend the window of 4.
		expect(await pacer.pace("fred", NEVER)).toBe(true);
		expect(await pacer.pace("fred", NEVER)).toBe(true);
		expect(slept).toEqual([]);
		// The third series must wait out the window before its first request.
		expect(await pacer.pace("fred", NEVER)).toBe(true);
		expect(slept).toEqual([TWELVE_DATA_WINDOW_MS]);
	});
});
