/**
 * Fixed-window rate gate (API-007). A request is allowed iff fewer than
 * `maxPerWindow` grants lie in `(nowMs − windowMs, nowMs]`.
 */
export function rateWindowPermit(
	grantedAtMs: readonly number[],
	nowMs: number,
	maxPerWindow: number,
	windowMs: number,
): { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number } {
	const floor = nowMs - windowMs;
	const inWindow = grantedAtMs.filter((at) => at > floor && at <= nowMs).sort((a, b) => a - b);
	if (inWindow.length < maxPerWindow) return { allowed: true };
	const oldest = inWindow[0];
	if (oldest === undefined) return { allowed: true };
	return { allowed: false, retryAfterMs: oldest + windowMs - nowMs };
}
