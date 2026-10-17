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

/** Pixels per wheel "line" (`deltaMode` 1), the browsers' usual line height. */
export const WHEEL_LINE_PX = 16;
/** Pixels per wheel "page" (`deltaMode` 2). */
export const WHEEL_PAGE_PX = 800;
/**
 * Zoom rate per wheel pixel: one classic mouse notch (100 px) zooms 15 %,
 * while a trackpad or pinch (many small `ctrl`+wheel deltas) zooms in
 * proportion to the distance travelled instead of 15 % per event.
 */
export const WHEEL_ZOOM_PER_PX = Math.log(1.15) / 100;
/** Largest zoom one animation frame may apply, either way. */
export const WHEEL_MAX_FACTOR_PER_FRAME = 2;

/** A wheel delta in pixels, whatever unit the engine reported it in. */
export function wheelDeltaPx(deltaY: number, deltaMode: number): number {
	if (!Number.isFinite(deltaY)) return 0;
	if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
	if (deltaMode === 2) return deltaY * WHEEL_PAGE_PX;
	return deltaY;
}

/**
 * Zoom factor for the wheel pixels summed over one frame: `exp(px × k)`
 * (positive px zoom out, negative in), clamped so a burst can never zoom
 * more than `WHEEL_MAX_FACTOR_PER_FRAME` in one frame. Zero or non-finite
 * input is the identity.
 */
export function wheelZoomFactor(totalPx: number): number {
	if (!Number.isFinite(totalPx) || totalPx === 0) return 1;
	const factor = Math.exp(totalPx * WHEEL_ZOOM_PER_PX);
	return Math.min(WHEEL_MAX_FACTOR_PER_FRAME, Math.max(1 / WHEEL_MAX_FACTOR_PER_FRAME, factor));
}
