import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createPoller,
	DEFAULT_POLL_SCHEDULE,
	documentVisibility,
	nextPollDelay,
	type PollSignal,
	type VisibilitySource,
} from "../src/lib/polling.ts";

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

/** A visibility source the test flips by hand. */
function fakeVisibility(initiallyVisible = true) {
	let visible = initiallyVisible;
	const listeners = new Set<() => void>();
	const source: VisibilitySource = {
		isVisible: () => visible,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		source,
		listenerCount: () => listeners.size,
		set(next: boolean) {
			visible = next;
			for (const listener of listeners) listener();
		},
	};
}

/** A poll function that answers from a script and records when it was called. */
function scriptedPoll(signals: readonly PollSignal[], fallback: PollSignal = "unchanged") {
	const calledAt: number[] = [];
	const start = Date.now();
	const poll = vi.fn(async (): Promise<PollSignal> => {
		const index = calledAt.length;
		calledAt.push(Date.now() - start);
		return signals[index] ?? fallback;
	});
	return { poll, calledAt };
}

describe("nextPollDelay", () => {
	it("polls fast while a run is active, regardless of the previous delay", () => {
		expect(nextPollDelay(60_000, "active")).toBe(2_500);
		expect(nextPollDelay(5_000, "active")).toBe(2_500);
	});

	it("returns to the idle base after a change", () => {
		expect(nextPollDelay(40_000, "changed")).toBe(5_000);
		expect(nextPollDelay(2_500, "changed")).toBe(5_000);
	});

	it("doubles while nothing changes, up to the idle cap", () => {
		const delays: number[] = [];
		let delay = 5_000;
		for (let step = 0; step < 6; step += 1) {
			delay = nextPollDelay(delay, "unchanged");
			delays.push(delay);
		}
		expect(delays).toEqual([10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
	});

	it("backs off on failures exactly like on no change", () => {
		expect(nextPollDelay(5_000, "failed")).toBe(10_000);
		expect(nextPollDelay(60_000, "failed")).toBe(60_000);
	});

	it("backs off only to a lower cap while runs are queued", () => {
		expect(nextPollDelay(2_500, "queued")).toBe(10_000);
		expect(nextPollDelay(10_000, "queued")).toBe(15_000);
		expect(nextPollDelay(15_000, "queued")).toBe(15_000);
	});

	it("never polls every second when idle", () => {
		for (const signal of ["changed", "unchanged", "queued", "failed"] as const) {
			for (const previous of [0, 1_000, 2_500, 5_000, 60_000]) {
				expect(nextPollDelay(previous, signal)).toBeGreaterThanOrEqual(
					DEFAULT_POLL_SCHEDULE.idleBaseMs,
				);
			}
		}
	});
});

describe("createPoller", () => {
	it("polls immediately on start, then backs off while unchanged up to the cap", async () => {
		const { poll, calledAt } = scriptedPoll([]);
		const poller = createPoller({ poll, visibility: fakeVisibility().source });
		poller.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(calledAt).toEqual([0]);

		await vi.advanceTimersByTimeAsync(300_000);
		// Gaps: 10 s, 20 s, 40 s, then 60 s for good.
		expect(calledAt.slice(0, 7)).toEqual([0, 10_000, 30_000, 70_000, 130_000, 190_000, 250_000]);
		poller.stop();
	});

	it("polls at the fast interval while a run is active and slows down afterwards", async () => {
		const { poll, calledAt } = scriptedPoll(["active", "active", "active", "changed", "unchanged"]);
		const poller = createPoller({ poll, visibility: fakeVisibility().source });
		poller.start();
		await vi.advanceTimersByTimeAsync(40_000);
		expect(calledAt).toEqual([0, 2_500, 5_000, 7_500, 12_500, 22_500]);
		poller.stop();
	});

	it("makes no request while the document is hidden and resumes when it becomes visible", async () => {
		const visibility = fakeVisibility(true);
		const { poll, calledAt } = scriptedPoll(["active", "active"], "active");
		const poller = createPoller({ poll, visibility: visibility.source });
		poller.start();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(poll).toHaveBeenCalledTimes(2);

		visibility.set(false);
		await vi.advanceTimersByTimeAsync(600_000);
		expect(poll).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);

		visibility.set(true);
		await vi.advanceTimersByTimeAsync(0);
		// Catches up at once on becoming visible, then continues on schedule.
		expect(poll).toHaveBeenCalledTimes(3);
		expect(calledAt[2]).toBe(602_500);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(poll).toHaveBeenCalledTimes(4);
		poller.stop();
	});

	it("does not poll at all when started in a hidden tab", async () => {
		const visibility = fakeVisibility(false);
		const { poll } = scriptedPoll([]);
		const poller = createPoller({ poll, visibility: visibility.source });
		poller.start();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(poll).not.toHaveBeenCalled();

		visibility.set(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(poll).toHaveBeenCalledTimes(1);
		poller.stop();
	});

	it("never overlaps polls, even when a response is slower than the interval", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		const poll = vi.fn(async (): Promise<PollSignal> => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setTimeout(resolve, 9_000));
			inFlight -= 1;
			return "active";
		});
		const poller = createPoller({ poll, visibility: fakeVisibility().source });
		poller.start();
		poller.pollNow();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(maxInFlight).toBe(1);
		// 9 s per poll, an immediate re-run for the queued pollNow, then 2.5 s gaps.
		expect(poll.mock.calls.length).toBeLessThanOrEqual(4);
		poller.stop();
	});

	it("pollNow polls immediately instead of waiting out a long backoff", async () => {
		const { poll, calledAt } = scriptedPoll([]);
		const poller = createPoller({ poll, visibility: fakeVisibility().source });
		poller.start();
		await vi.advanceTimersByTimeAsync(4_000);
		expect(calledAt).toEqual([0]);
		poller.pollNow();
		await vi.advanceTimersByTimeAsync(0);
		expect(calledAt).toEqual([0, 4_000]);
		poller.stop();
	});

	it("treats a rejected poll as a failure and keeps polling with backoff", async () => {
		const calledAt: number[] = [];
		const start = Date.now();
		const poll = vi.fn(async (): Promise<PollSignal> => {
			calledAt.push(Date.now() - start);
			throw new Error("boom");
		});
		const poller = createPoller({ poll, visibility: fakeVisibility().source });
		poller.start();
		await vi.advanceTimersByTimeAsync(31_000);
		expect(calledAt).toEqual([0, 10_000, 30_000]);
		poller.stop();
	});

	it("stops polling and unsubscribes from visibility changes", async () => {
		const visibility = fakeVisibility();
		const { poll } = scriptedPoll([], "active");
		const poller = createPoller({ poll, visibility: visibility.source });
		poller.start();
		await vi.advanceTimersByTimeAsync(2_500);
		expect(visibility.listenerCount()).toBe(1);
		const callsBeforeStop = poll.mock.calls.length;

		poller.stop();
		expect(visibility.listenerCount()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
		visibility.set(true);
		poller.pollNow();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(poll).toHaveBeenCalledTimes(callsBeforeStop);
	});

	it("is idempotent to start twice", async () => {
		const visibility = fakeVisibility();
		const { poll } = scriptedPoll([]);
		const poller = createPoller({ poll, visibility: visibility.source });
		poller.start();
		poller.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(poll).toHaveBeenCalledTimes(1);
		expect(visibility.listenerCount()).toBe(1);
		poller.stop();
	});
});

describe("documentVisibility", () => {
	it("reads document.visibilityState and forwards visibilitychange events", () => {
		let state: DocumentVisibilityState = "visible";
		Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
		const source = documentVisibility(document);
		const listener = vi.fn();
		const unsubscribe = source.subscribe(listener);

		expect(source.isVisible()).toBe(true);
		state = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(source.isVisible()).toBe(false);
		expect(listener).toHaveBeenCalledTimes(1);

		unsubscribe();
		document.dispatchEvent(new Event("visibilitychange"));
		expect(listener).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(document, "visibilityState");
	});
});
