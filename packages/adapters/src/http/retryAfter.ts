/**
 * The one `Retry-After` reader (RFC 9110 section 10.2.3) of the TypeScript
 * runner: the model providers, Google Calendar and Tavily all read the header
 * here. Each caller applies its own cap; this only turns the header into a
 * wait. The Rust twin is `research_net::retry_after::parse_retry_after_ms`.
 */

/**
 * Reads a Retry-After header: delay-seconds or an HTTP date, as milliseconds
 * from `nowEpochMs` (a date in the past is 0). `null` when absent or
 * unreadable — a negative or fractional number, or text that is not a date.
 */
export function parseRetryAfterMs(value: string | null, nowEpochMs: number): number | null {
	if (value === null) return null;
	const trimmed = value.trim();
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
	// An HTTP date always names its weekday; this keeps "-5" from parsing as a year.
	if (!/^[A-Za-z]{3}, /.test(trimmed)) return null;
	const at = Date.parse(trimmed);
	return Number.isFinite(at) ? Math.max(0, at - nowEpochMs) : null;
}
