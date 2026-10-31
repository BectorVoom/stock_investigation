import { claimedJobSchema } from "@research/contracts";
import { HISTORY_FULL_CHECK_DAYS } from "@research/domain";
import { describe, expect, it } from "vitest";
import { type MarketSeriesRefreshState, marketClaimSeries } from "../src/index.ts";

/**
 * ADR-0044 §3, the claim: what a market-refresh claim tells the runner per
 * series, from the stored refresh state a fake repository answers with.
 */

const NOW = "2026-10-31T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const DAY_MS = 86_400_000;
const ANCHOR = { observedOn: "2026-09-17", value: 16.25 } as const;

function stored(overrides: Partial<MarketSeriesRefreshState>): MarketSeriesRefreshState {
	return {
		latestObservedOn: "2026-10-30",
		lastRefreshedAt: "2026-10-30T12:00:00.000Z",
		unavailableCode: null,
		anchor: ANCHOR,
		historyCheckedAt: null,
		...overrides,
	};
}

const isoAgo = (ms: number) => new Date(NOW_MS - ms).toISOString();

describe("market-refresh claim series (ADR-0044)", () => {
	it("sends no anchor and no full check for a series with nothing stored", () => {
		const state = new Map([
			["fred:EMPTY", stored({ latestObservedOn: null, anchor: null, historyCheckedAt: null })],
		]);
		expect(marketClaimSeries(["fred:EMPTY", "fred:UNKNOWN"], state, NOW_MS)).toEqual([
			{ seriesId: "fred:EMPTY", latestObservedOn: null, anchor: null, fullCheck: false },
			{ seriesId: "fred:UNKNOWN", latestObservedOn: null, anchor: null, fullCheck: false },
		]);
	});

	it("asks for a full check when the series was never fetched in full", () => {
		const state = new Map([["fred:VIXCLS", stored({ historyCheckedAt: null })]]);
		expect(marketClaimSeries(["fred:VIXCLS"], state, NOW_MS)).toEqual([
			{ seriesId: "fred:VIXCLS", latestObservedOn: "2026-10-30", anchor: ANCHOR, fullCheck: true },
		]);
	});

	it("is due exactly at 7 days and not a millisecond before", () => {
		const fullCheckMs = HISTORY_FULL_CHECK_DAYS * DAY_MS;
		expect(HISTORY_FULL_CHECK_DAYS).toBe(7);
		const state = new Map([
			["fred:AT", stored({ historyCheckedAt: isoAgo(fullCheckMs) })],
			["fred:BEFORE", stored({ historyCheckedAt: isoAgo(fullCheckMs - 1) })],
			["fred:AFTER", stored({ historyCheckedAt: isoAgo(fullCheckMs + DAY_MS) })],
			["fred:RECENT", stored({ historyCheckedAt: isoAgo(DAY_MS) })],
		]);
		const fullCheck = marketClaimSeries(
			["fred:AT", "fred:BEFORE", "fred:AFTER", "fred:RECENT"],
			state,
			NOW_MS,
		).map((series) => [series.seriesId, series.fullCheck, series.anchor]);
		expect(fullCheck).toEqual([
			["fred:AT", true, ANCHOR],
			["fred:BEFORE", false, ANCHOR],
			["fred:AFTER", true, ANCHOR],
			["fred:RECENT", false, ANCHOR],
		]);
	});

	it("treats an unreadable stamp as never checked and a future stamp as not due", () => {
		const state = new Map([
			["fred:GARBLED", stored({ historyCheckedAt: "not a time" })],
			["fred:FUTURE", stored({ historyCheckedAt: new Date(NOW_MS + DAY_MS).toISOString() })],
		]);
		expect(
			marketClaimSeries(["fred:GARBLED", "fred:FUTURE"], state, NOW_MS).map(
				(series) => series.fullCheck,
			),
		).toEqual([true, false]);
	});

	it("produces entries the strict claim contract accepts", () => {
		const state = new Map([
			["fred:VIXCLS", stored({ historyCheckedAt: isoAgo(DAY_MS) })],
			["twelve-data:AAPL", stored({ historyCheckedAt: null })],
		]);
		const series = marketClaimSeries(
			["fred:VIXCLS", "twelve-data:AAPL", "fred:DGS10"],
			state,
			NOW_MS,
		);
		const parsed = claimedJobSchema.safeParse({
			kind: "market-refresh",
			runId: "run_market",
			leaseGeneration: 1,
			leaseExpiresAt: NOW,
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			series,
		});
		expect(parsed.success).toBe(true);
	});
});
