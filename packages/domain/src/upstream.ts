/**
 * The status an external service answered with (docs/rule/error_handling.md
 * §4a "External-service errors keep their status").
 *
 * When a third-party service (a feed host, SEC, JPX, FRED, Twelve Data,
 * Finnhub, Tavily, GDELT, Google, the Claude API, OpenRouter, a model CLI
 * reporting its API's status) answers with an error, the code that receives
 * the answer keeps that status as a number, exactly as received, and every
 * failure built from it carries it unchanged. Our own codes classify the
 * failure; they never replace the status.
 *
 * The Rust runner holds the same rule in `crates/research-domain/src/upstream.rs`.
 */

/** HTTP status codes are three digits, 1xx–5xx (RFC 9110 §15). */
export const UPSTREAM_STATUS_MIN = 100;
export const UPSTREAM_STATUS_MAX = 599;

/** A value that can be an HTTP status an external service answered with. */
export function isUpstreamStatus(value: number): boolean {
	return Number.isInteger(value) && value >= UPSTREAM_STATUS_MIN && value <= UPSTREAM_STATUS_MAX;
}

/**
 * `value` when it is a status an external service could have answered with,
 * else null. For statuses read from a parsed provider document (a CLI's
 * `api_error_status`, a JSON error `code`), which may hold anything.
 */
export function upstreamStatusOrNull(value: unknown): number | null {
	return typeof value === "number" && isUpstreamStatus(value) ? value : null;
}

/**
 * The HTTP status our API answers with for a failure an external service
 * caused: the upstream's own status when it is an error status (4xx/5xx),
 * otherwise `fallback`. A 1xx–3xx is kept in the failure body unchanged but
 * cannot be the status line of our error response, because a browser reads
 * those as "continue" or "go elsewhere", not as a failure.
 */
export function responseStatusForUpstream(
	upstreamStatus: number | null | undefined,
	fallback: number,
): number {
	return upstreamStatus !== null &&
		upstreamStatus !== undefined &&
		isUpstreamStatus(upstreamStatus) &&
		upstreamStatus >= 400
		? upstreamStatus
		: fallback;
}
