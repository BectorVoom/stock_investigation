import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFrameScheduler,
	WHEEL_MAX_FACTOR_PER_FRAME,
	wheelDeltaPx,
	wheelZoomFactor,
} from "../src/chartViewer/frame.ts";

describe("frame scheduler", () => {
	const queued: FrameRequestCallback[] = [];
	let raf: ReturnType<typeof vi.spyOn>;
	let caf: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		queued.length = 0;
		raf = vi
			.spyOn(globalThis, "requestAnimationFrame")
			.mockImplementation((callback: FrameRequestCallback): number => {
				queued.push(callback);
				return queued.length;
			});
		caf = vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	const flush = (): void => {
		for (const callback of queued.splice(0)) callback(0);
	};

	it("coalesces rapid updates to the latest work", () => {
		const frame = createFrameScheduler();
		const seen: string[] = [];
		frame.schedule(() => seen.push("first"));
		frame.schedule(() => seen.push("second"));
		expect(queued).toHaveLength(1);
		flush();
		expect(seen).toEqual(["second"]);
	});

	it("drops a queued callback on cancel", () => {
		const frame = createFrameScheduler();
		let calls = 0;
		frame.schedule(() => {
			calls += 1;
		});
		frame.cancel();
		flush();
		expect(calls).toBe(0);
	});

	it("schedules again after a cancel", () => {
		const frame = createFrameScheduler();
		let calls = 0;
		frame.schedule(() => {
			calls += 1;
		});
		frame.cancel();
		frame.schedule(() => {
			calls += 1;
		});
		flush();
		expect(calls).toBe(1);
	});

	it("a cancel without a queued frame is harmless", () => {
		const frame = createFrameScheduler();
		expect(() => frame.cancel()).not.toThrow();
		expect(raf).not.toHaveBeenCalled();
		expect(caf).not.toHaveBeenCalled();
	});
});

describe("wheel zoom factor (fix round 6)", () => {
	it("normalises pixel, line and page deltas to pixels", () => {
		expect(wheelDeltaPx(100, 0)).toBe(100);
		expect(wheelDeltaPx(3, 1)).toBe(48);
		expect(wheelDeltaPx(1, 2)).toBe(800);
		expect(wheelDeltaPx(Number.NaN, 0)).toBe(0);
	});

	it("zooms exponentially in the summed distance, 15 % per 100 px", () => {
		expect(wheelZoomFactor(100)).toBeCloseTo(1.15, 10);
		expect(wheelZoomFactor(-100)).toBeCloseTo(1 / 1.15, 10);
		// Ten 10 px deltas equal one 100 px notch, never ten 15 % steps.
		expect(wheelZoomFactor(10 * 10)).toBeCloseTo(wheelZoomFactor(100), 10);
		expect(wheelZoomFactor(0)).toBe(1);
		expect(wheelZoomFactor(Number.POSITIVE_INFINITY)).toBe(1);
	});

	it("clamps one frame's zoom either way", () => {
		expect(wheelZoomFactor(1e6)).toBe(WHEEL_MAX_FACTOR_PER_FRAME);
		expect(wheelZoomFactor(-1e6)).toBe(1 / WHEEL_MAX_FACTOR_PER_FRAME);
	});
});
