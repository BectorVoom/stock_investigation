/**
 * Coalesces rapid pointer/wheel updates to one per animation frame
 * (ADR-0025 interaction). The latest work wins; without `requestAnimationFrame`
 * (non-browser runtimes) the work runs at once.
 */
export function createFrameScheduler(): (work: () => void) => void {
	let scheduled = false;
	let pending: (() => void) | null = null;
	return (work) => {
		pending = work;
		if (scheduled) return;
		scheduled = true;
		const run = (): void => {
			scheduled = false;
			const next = pending;
			pending = null;
			if (next !== null) next();
		};
		if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
		else run();
	};
}
