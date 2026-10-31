import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibleTicker } from "../src/lib/polling.ts";
import {
	type AskedStamps,
	motivatingStamps,
	pruneAsked,
	recheckDecision,
	recordAsked,
	stampKey,
} from "../src/lib/refreshScope.ts";
import { createControllableVisibility } from "./fakeBackend.ts";

/**
 * The re-check a page takes while it stays open (ADR-0044 §4): the pure
 * decision (never while a refresh is active, at most once per stale stamp
 * per 30 minutes)
 * and the visible-only ticker that runs it every 5 minutes and on every
 * return to the page.
 */
describe("recheckDecision", () => {
	const NOW = Date.parse("2026-10-12T12:00:00Z");
	const STALE_MS = 30 * 60_000;
	const decide = (
		stamps: readonly { id: string; lastRefreshedAt: string | null }[],
		asked: ReadonlyMap<string, number>,
		refreshActive = false,
		scope: "all" | "unrefreshed" | null = "all",
		nowMs = NOW,
		lastStaleQueueAt: number | null = null,
	) =>
		recheckDecision({
			scope,
			stamps,
			staleAfterMs: STALE_MS,
			nowMs,
			refreshActive,
			asked,
			lastStaleQueueAt,
		});
	/** The asks a page records once a refresh was queued at `at`. */
	const askedAt = (keys: readonly string[], at = NOW): AskedStamps => {
		const asked: AskedStamps = new Map();
		recordAsked(asked, keys, at);
		return asked;
	};
	const vixFresh = { id: "fred:VIXCLS", lastRefreshedAt: "2026-10-12T11:50:00Z" };
	const aaplStale = { id: "twelve-data:AAPL", lastRefreshedAt: "2026-10-10T00:00:00Z" };

	it("keys only the stamps that motivate the refresh: the stale and the missing ones", () => {
		const missing = { id: "fred:DGS10", lastRefreshedAt: null };
		const bad = { id: "fred:SP500", lastRefreshedAt: "not-a-date" };
		expect(motivatingStamps([vixFresh, aaplStale, missing, bad], STALE_MS, NOW)).toEqual([
			aaplStale,
			missing,
			bad,
		]);
		expect(decide([vixFresh, aaplStale, missing], new Map())).toEqual({
			scope: "all",
			keys: [stampKey(aaplStale), stampKey(missing)],
			stale: true,
		});
		// Only never-refreshed stamps: not a staleness-driven queue.
		expect(decide([vixFresh, missing], new Map(), false, "unrefreshed")?.stale).toBe(false);
	});

	it("asks once per stale stamp: a series no refresh stamps never causes a second refresh", () => {
		const first = decide([vixFresh, aaplStale], new Map());
		const asked = askedAt(first?.keys ?? []);
		// The refresh stamped VIX again but never AAPL (past the claim's series
		// limit): the same stale AAPL stamp is not asked for twice.
		const vixRestamped = { ...vixFresh, lastRefreshedAt: "2026-10-12T11:59:00Z" };
		expect(decide([vixRestamped, aaplStale], asked)).toBeNull();
		// The probe's loop: every round restamps VIX, none restamps AAPL.
		for (let round = 0; round < 20; round += 1) {
			const restamped = { ...vixFresh, lastRefreshedAt: `2026-10-12T11:5${round % 10}:00Z` };
			expect(decide([restamped, aaplStale], asked)).toBeNull();
		}
		// A stamp gone stale since is a new reason: one more refresh.
		const vixStale = { ...vixFresh, lastRefreshedAt: "2026-10-12T11:00:00Z" };
		expect(decide([vixStale, aaplStale], asked)?.keys).toEqual([
			stampKey(vixStale),
			stampKey(aaplStale),
		]);
	});

	it("asks again for a stamp whose refresh was never queued", () => {
		// The caller adds the keys only on "queued": an empty asked set after a failed POST.
		expect(decide([aaplStale], new Map())).not.toBeNull();
		expect(decide([aaplStale], askedAt([stampKey(aaplStale)]))).toBeNull();
	});

	it("lets an ask expire after the staleness limit: one more refresh per 30 minutes, never a loop", () => {
		// A queued job failed as a whole: nothing was stamped, AAPL is as stale as before.
		const asked = askedAt([stampKey(aaplStale)]);
		expect(decide([aaplStale], asked, false, "all", NOW + 29 * 60_000)).toBeNull();
		expect(decide([aaplStale], asked, false, "all", NOW + 30 * 60_000)).toBeNull();
		expect(decide([aaplStale], asked, false, "all", NOW + 30 * 60_000 + 1)?.keys).toEqual([
			stampKey(aaplStale),
		]);
		// Asked again at +31 min: quiet for the next 30 minutes again.
		recordAsked(asked, [stampKey(aaplStale)], NOW + 31 * 60_000);
		expect(decide([aaplStale], asked, false, "all", NOW + 45 * 60_000)).toBeNull();
		// An ask dated after the clock (a clock step back) still counts as recent.
		expect(decide([aaplStale], askedAt([stampKey(aaplStale)], NOW + 60_000))).toBeNull();
	});

	it("spaces staleness-driven queues 30 minutes apart: a run outlasting the limit is not followed at once", () => {
		// The review probe: every run takes over 30 minutes, so the stamp it
		// writes for VIX is already stale — a new stamp each time.
		const queuedAt = NOW;
		const asked = askedAt([stampKey(aaplStale)], queuedAt);
		for (let run = 1; run <= 20; run += 1) {
			const vixAlreadyStale = {
				...vixFresh,
				lastRefreshedAt: new Date(NOW - 40 * 60_000 + run).toISOString(),
			};
			expect(
				decide([vixAlreadyStale, aaplStale], asked, false, "all", NOW + run, queuedAt),
			).toBeNull();
		}
		// 30 minutes after the last staleness queue, the next one may go.
		const vixStale = { ...vixFresh, lastRefreshedAt: "2026-10-12T11:20:00Z" };
		expect(
			decide([vixStale, aaplStale], asked, false, "all", NOW + 30 * 60_000, queuedAt),
		).toBeNull();
		expect(
			decide([vixStale, aaplStale], asked, false, "all", NOW + 30 * 60_000 + 1, queuedAt)?.scope,
		).toBe("all");
	});

	it("lets a never-refreshed series ask at once, narrowly, while staleness queues are spaced", () => {
		const added = { id: "fred:DGS10", lastRefreshedAt: null };
		const vixStale = { ...vixFresh, lastRefreshedAt: "2026-10-12T11:00:00Z" };
		expect(
			decide([vixStale, aaplStale, added], new Map(), false, "all", NOW, NOW - 60_000),
		).toEqual({ scope: "unrefreshed", keys: [stampKey(added)], stale: false });
		// Once asked for, the same missing stamp waits like any other.
		expect(
			decide([vixStale, added], askedAt([stampKey(added)]), false, "all", NOW, NOW - 60_000),
		).toBeNull();
		// With only stale stamps and a recent staleness queue: nothing.
		expect(decide([vixStale], new Map(), false, "all", NOW, NOW - 60_000)).toBeNull();
	});

	it("prunes the asks to the stamps the page still shows", () => {
		const vixRestamped = { ...vixFresh, lastRefreshedAt: "2026-10-12T11:59:00Z" };
		const asked = askedAt([stampKey(aaplStale), stampKey(vixFresh)]);
		pruneAsked(asked, [vixRestamped, aaplStale]);
		// VIX moved on (its old stamp can never match again); AAPL's ask stays.
		expect([...asked.keys()]).toEqual([stampKey(aaplStale)]);
		pruneAsked(asked, []);
		expect(asked.size).toBe(0);
	});

	it("never queues while a refresh is active or when the page's rule finds nothing to do", () => {
		expect(decide([aaplStale], new Map(), true)).toBeNull();
		expect(decide([aaplStale], new Map(), false, null)).toBeNull();
		expect(decide([vixFresh], new Map(), false, null)).toBeNull();
	});

	it("keys a stamp by item and stamp", () => {
		expect(stampKey({ id: "a", lastRefreshedAt: null })).not.toBe(
			stampKey({ id: "a", lastRefreshedAt: "2026-10-12T11:00:00Z" }),
		);
		expect(stampKey({ id: "a", lastRefreshedAt: null })).not.toBe(
			stampKey({ id: "b", lastRefreshedAt: null }),
		);
	});
});

describe("createVisibleTicker", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ticks every interval while visible, not at start", async () => {
		const visibility = createControllableVisibility();
		const tick = vi.fn();
		const ticker = createVisibleTicker({ visibility, intervalMs: 300_000, tick });
		ticker.start();
		expect(tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(299_999);
		expect(tick).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(tick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(300_000);
		expect(tick).toHaveBeenCalledTimes(2);
		ticker.stop();
	});

	it("holds no timer while hidden and ticks at once on the return to visible", async () => {
		const visibility = createControllableVisibility();
		const tick = vi.fn();
		const ticker = createVisibleTicker({ visibility, intervalMs: 300_000, tick });
		ticker.start();
		visibility.setVisible(false);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(tick).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		visibility.setVisible(true);
		expect(tick).toHaveBeenCalledTimes(1);
		// The interval restarts from the return.
		await vi.advanceTimersByTimeAsync(299_999);
		expect(tick).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(tick).toHaveBeenCalledTimes(2);
		// A repeated "visible" event while visible is not a return.
		visibility.setVisible(true);
		expect(tick).toHaveBeenCalledTimes(2);
		ticker.stop();
	});

	it("stops its timer and its visibility listener on stop", async () => {
		const visibility = createControllableVisibility();
		const tick = vi.fn();
		const ticker = createVisibleTicker({ visibility, intervalMs: 300_000, tick });
		ticker.start();
		ticker.start();
		expect(vi.getTimerCount()).toBe(1);
		ticker.stop();
		expect(vi.getTimerCount()).toBe(0);
		visibility.setVisible(false);
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(900_000);
		expect(tick).not.toHaveBeenCalled();
	});
});
