import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AWAITING_REREAD_BASE_MS,
	createIdleReread,
	createVisibleTicker,
	IDLE_REREAD_MS,
} from "../src/lib/polling.ts";
import { createControllableVisibility, deferred } from "./fakeBackend.ts";

/**
 * How an open page keeps showing what the server syncs on its own
 * schedule: the idle re-read (`createIdleReread`) every page that shows
 * synced data shares — every minute while visible, sooner while something
 * shown was never fetched, at once on every return to the page, never while
 * hidden or while a run is followed — and the visible-only ticker the read
 * cache uses.
 */
describe("createIdleReread", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const setup = (state: { busy?: boolean; awaiting?: boolean } = {}) => {
		const visibility = createControllableVisibility();
		const flags = { busy: state.busy ?? false, awaiting: state.awaiting ?? false };
		const reread = vi.fn(() => Promise.resolve());
		const idle = createIdleReread({
			visibility,
			reread,
			busy: () => flags.busy,
			awaiting: () => flags.awaiting,
		});
		return { visibility, flags, reread, idle };
	};

	it("re-reads every minute while visible, not at start", async () => {
		const { idle, reread } = setup();
		expect(IDLE_REREAD_MS).toBe(60_000);
		idle.start();
		expect(reread).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(reread).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(reread).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reread).toHaveBeenCalledTimes(2);
		idle.stop();
	});

	it("re-reads sooner while something shown was never fetched: 5 s, doubling up to a minute", async () => {
		const { idle, reread, flags } = setup({ awaiting: true });
		expect(AWAITING_REREAD_BASE_MS).toBe(5_000);
		idle.start();
		const at: number[] = [];
		reread.mockImplementation(() => {
			at.push(Date.now());
			return Promise.resolve();
		});
		const start = Date.now();
		await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 60_000);
		expect(at.map((ms) => ms - start)).toEqual([5_000, 15_000, 35_000, 75_000, 135_000, 195_000]);
		// Once nothing is missing, the minute cadence; a new miss starts at 5 s again.
		flags.awaiting = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reread).toHaveBeenCalledTimes(7);
		flags.awaiting = true;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reread).toHaveBeenCalledTimes(8);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reread).toHaveBeenCalledTimes(9);
		idle.stop();
	});

	it("soon() restarts the short cadence, e.g. after a save added a series", async () => {
		const { idle, reread, flags } = setup();
		idle.start();
		await vi.advanceTimersByTimeAsync(30_000);
		flags.awaiting = true;
		idle.soon();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(reread).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(reread).toHaveBeenCalledTimes(1);
		idle.stop();
	});

	it("reads nothing while busy (a run the fast poller follows), and resumes after", async () => {
		const { idle, reread, flags } = setup({ busy: true, awaiting: true });
		idle.start();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(reread).not.toHaveBeenCalled();
		flags.busy = false;
		// The skipped ticks kept the short delay: the next read is at most 5 s away.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reread).toHaveBeenCalledTimes(1);
		idle.stop();
	});

	it("holds no timer while hidden and re-reads at once on the return to visible", async () => {
		const { idle, reread, visibility } = setup();
		idle.start();
		visibility.setVisible(false);
		await vi.advanceTimersByTimeAsync(3_600_000);
		expect(reread).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(reread).toHaveBeenCalledTimes(1);
		// The minute restarts from the return.
		await vi.advanceTimersByTimeAsync(59_999);
		expect(reread).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(reread).toHaveBeenCalledTimes(2);
		// A repeated "visible" event while visible is not a return.
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(reread).toHaveBeenCalledTimes(2);
		idle.stop();
	});

	it("never overlaps two re-reads: the next waits for the one in flight", async () => {
		const { idle, reread, visibility } = setup();
		const slow = deferred<void>();
		reread.mockImplementationOnce(() => slow.promise);
		idle.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reread).toHaveBeenCalledTimes(1);
		// A return to visible while the read is out reads nothing more.
		visibility.setVisible(false);
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(reread).toHaveBeenCalledTimes(1);
		slow.resolve();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(reread).toHaveBeenCalledTimes(2);
		idle.stop();
	});

	it("stops its timer and its visibility listener on stop", async () => {
		const { idle, reread, visibility } = setup();
		idle.start();
		idle.start();
		expect(vi.getTimerCount()).toBe(1);
		idle.stop();
		expect(vi.getTimerCount()).toBe(0);
		visibility.setVisible(false);
		visibility.setVisible(true);
		idle.soon();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(reread).not.toHaveBeenCalled();
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
