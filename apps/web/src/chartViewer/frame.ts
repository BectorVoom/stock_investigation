/**
 * Coalesces rapid pointer/wheel updates to one per animation frame
 * (ADR-0025 interaction). The latest work wins; without `requestAnimationFrame`
 * (non-browser runtimes) the work runs at once. `cancel` drops a queued
 * callback: both chart components register it with `onCleanup`, so a pending
 * frame never touches a disposed component after unmount.
 */
export interface FrameScheduler {
	readonly schedule: (work: () => void) => void;
	readonly cancel: () => void;
}

export function createFrameScheduler(): FrameScheduler {
	let scheduled = false;
	let pending: (() => void) | null = null;
	let frameId: number | null = null;
	const run = (): void => {
		scheduled = false;
		frameId = null;
		const next = pending;
		pending = null;
		if (next !== null) next();
	};
	return {
		schedule: (work) => {
			pending = work;
			if (scheduled) return;
			scheduled = true;
			if (typeof requestAnimationFrame === "function") frameId = requestAnimationFrame(run);
			else run();
		},
		cancel: () => {
			if (frameId !== null && typeof cancelAnimationFrame === "function") {
				cancelAnimationFrame(frameId);
			}
			frameId = null;
			scheduled = false;
			pending = null;
		},
	};
}
