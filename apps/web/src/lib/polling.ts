/**
 * Adaptive polling (architecture section 5.1): fast only while a run is being
 * executed, exponential backoff while nothing changes, and no requests at all
 * while the tab is hidden. There is deliberately no fixed per-second timer.
 */

/** What one poll observed; decides how soon the next poll happens. */
export type PollSignal =
	/** A runner is executing a job right now. */
	| "active"
	/** Jobs are queued but nothing is executing (e.g. the runner is offline). */
	| "queued"
	/** Idle, but something differed from the previous poll. */
	| "changed"
	/** Idle and identical to the previous poll (typically all 304s). */
	| "unchanged"
	/** The poll itself failed (network or server error). */
	| "failed";

export interface PollSchedule {
	readonly activeMs: number;
	readonly idleBaseMs: number;
	readonly idleMaxMs: number;
	/** Backoff ceiling while jobs wait for a runner, so a reconnect is noticed reasonably soon. */
	readonly queuedMaxMs: number;
	readonly backoffFactor: number;
}

export const DEFAULT_POLL_SCHEDULE: PollSchedule = {
	activeMs: 2_500,
	idleBaseMs: 5_000,
	idleMaxMs: 60_000,
	queuedMaxMs: 15_000,
	backoffFactor: 2,
};

/** Pure schedule: delay before the next poll given the previous delay and what was observed. */
export function nextPollDelay(
	previousDelayMs: number,
	signal: PollSignal,
	schedule: PollSchedule = DEFAULT_POLL_SCHEDULE,
): number {
	if (signal === "active") return schedule.activeMs;
	if (signal === "changed") return schedule.idleBaseMs;
	const backedOff = Math.max(previousDelayMs, schedule.idleBaseMs) * schedule.backoffFactor;
	return Math.min(backedOff, signal === "queued" ? schedule.queuedMaxMs : schedule.idleMaxMs);
}

export interface VisibilitySource {
	readonly isVisible: () => boolean;
	/** Returns an unsubscribe function. */
	readonly subscribe: (listener: () => void) => () => void;
}

export function documentVisibility(doc: Document): VisibilitySource {
	return {
		isVisible: () => doc.visibilityState === "visible",
		subscribe: (listener) => {
			doc.addEventListener("visibilitychange", listener);
			return () => doc.removeEventListener("visibilitychange", listener);
		},
	};
}

export interface Poller {
	/** Begins polling (immediately, when visible). Idempotent. */
	readonly start: () => void;
	readonly stop: () => void;
	/** Polls as soon as possible, e.g. right after the owner submitted something. */
	readonly pollNow: () => void;
}

export interface PollerOptions {
	/** Must not reject; a rejection is treated as a failed poll. */
	readonly poll: () => Promise<PollSignal>;
	readonly visibility: VisibilitySource;
	readonly schedule?: PollSchedule;
}

export function createPoller(options: PollerOptions): Poller {
	const schedule = options.schedule ?? DEFAULT_POLL_SCHEDULE;
	let running = false;
	let inFlight = false;
	let rerunRequested = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let delayMs = schedule.idleBaseMs;
	let unsubscribe: (() => void) | null = null;

	const clearTimer = () => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const scheduleNext = () => {
		clearTimer();
		// Hidden tab: no timer at all. The visibility listener resumes polling.
		if (!running || !options.visibility.isVisible()) return;
		timer = setTimeout(() => {
			timer = null;
			void run();
		}, delayMs);
	};

	const run = async (): Promise<void> => {
		if (!running) return;
		if (inFlight) {
			rerunRequested = true;
			return;
		}
		clearTimer();
		inFlight = true;
		let signal: PollSignal;
		try {
			signal = await options.poll();
		} catch {
			// The poll callback is expected to return "failed" itself; this keeps the
			// loop alive (with backoff) if it ever rejects instead.
			signal = "failed";
		}
		inFlight = false;
		delayMs = nextPollDelay(delayMs, signal, schedule);
		if (rerunRequested && running && options.visibility.isVisible()) {
			rerunRequested = false;
			void run();
			return;
		}
		rerunRequested = false;
		scheduleNext();
	};

	const onVisibilityChange = () => {
		if (!running) return;
		if (options.visibility.isVisible()) {
			// Catch up immediately after the tab was hidden, then resume the schedule.
			if (timer === null && !inFlight) void run();
		} else {
			clearTimer();
		}
	};

	return {
		start: () => {
			if (running) return;
			running = true;
			unsubscribe = options.visibility.subscribe(onVisibilityChange);
			if (options.visibility.isVisible()) void run();
		},
		stop: () => {
			running = false;
			clearTimer();
			unsubscribe?.();
			unsubscribe = null;
		},
		pollNow: () => {
			if (!running || !options.visibility.isVisible()) return;
			void run();
		},
	};
}

export interface VisibleTicker {
	/** Begins watching (the first tick waits a full interval or the next return to visible). Idempotent. */
	readonly start: () => void;
	readonly stop: () => void;
}

/**
 * Calls `tick` when the page becomes visible again and every `intervalMs`
 * while it stays visible (ADR-0044 §4: a page left open re-checks its
 * data). Like the poller, there is no timer at all while the tab is hidden;
 * the return to visible ticks at once and restarts the interval. `tick` is
 * the caller's decision — it must not throw, and it decides by itself
 * whether anything is due (a refresh already active, nothing stale).
 */
export function createVisibleTicker(options: {
	readonly visibility: VisibilitySource;
	readonly intervalMs: number;
	readonly tick: () => void;
}): VisibleTicker {
	let running = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let unsubscribe: (() => void) | null = null;

	const clearTimer = (): void => {
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
	};
	const schedule = (): void => {
		clearTimer();
		if (!running || !options.visibility.isVisible()) return;
		timer = setTimeout(() => {
			timer = null;
			if (!running) return;
			options.tick();
			schedule();
		}, options.intervalMs);
	};
	const onVisibilityChange = (): void => {
		if (!running) return;
		if (!options.visibility.isVisible()) {
			clearTimer();
			return;
		}
		// Only a real return: a repeated "visible" event while a timer runs is not one.
		if (timer !== null) return;
		options.tick();
		schedule();
	};

	return {
		start: () => {
			if (running) return;
			running = true;
			unsubscribe = options.visibility.subscribe(onVisibilityChange);
			schedule();
		},
		stop: () => {
			running = false;
			clearTimer();
			unsubscribe?.();
			unsubscribe = null;
		},
	};
}
