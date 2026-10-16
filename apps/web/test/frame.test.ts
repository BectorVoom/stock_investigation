import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFrameScheduler } from "../src/chartViewer/frame.ts";

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
