/**
 * Count of the most recent messages that fit a data-volume budget.
 *
 * `sizes` holds per-message UTF-8 byte counts, oldest first. The answer is the
 * length of the longest suffix whose total is at most `budget` and whose length
 * is at most `maxItems`: walk from the newest item backwards and stop at the
 * first item that does not fit, so the kept messages stay contiguous (ARCH-009).
 * Anything that is not a non-negative safe integer (in `sizes`, `budget` or
 * `maxItems`) makes the answer 0: when in doubt, send nothing (ARCH-017).
 */
export function recentCountWithinBudget(
	sizes: readonly number[],
	budget: number,
	maxItems: number,
): number {
	if (!Number.isSafeInteger(budget) || budget < 0) return 0;
	if (!Number.isSafeInteger(maxItems) || maxItems < 0) return 0;
	let count = 0;
	let total = 0;
	let stopped = false;
	for (let index = sizes.length - 1; index >= 0; index -= 1) {
		const size: unknown = sizes[index];
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return 0;
		if (stopped) continue;
		if (count >= maxItems) {
			stopped = true;
			continue;
		}
		if (total + size > budget) {
			stopped = true;
			continue;
		}
		total += size;
		count += 1;
	}
	return count;
}
