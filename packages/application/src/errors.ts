import type { ApiErrorCode } from "@research/contracts";
import { err, type Result, thrownName } from "@research/domain";

/** Expected use-case failure. `code` is the stable API error code; `message` is safe to show. */
export interface UseCaseError {
	readonly code: ApiErrorCode;
	readonly message: string;
	readonly detail?: string;
	/**
	 * Set when an external service caused the failure: the status it answered
	 * with, unchanged. The API answers with this status (4xx/5xx) instead of
	 * the code's own (docs/rule/error_handling.md §4a).
	 */
	readonly upstreamStatus?: number;
}

export type UseCaseResult<T> = Result<T, UseCaseError>;

export function fail(
	code: ApiErrorCode,
	message: string,
	detail?: string,
): Result<never, UseCaseError> {
	return err(detail === undefined ? { code, message } : { code, message, detail });
}

/**
 * A use-case failure an external service caused. `upstreamStatus` is the
 * status it answered with (null when nothing answered: a timeout, a refused
 * connection), passed through unchanged.
 */
export function failUpstream(
	code: ApiErrorCode,
	message: string,
	detail: string | undefined,
	upstreamStatus: number | null,
): Result<never, UseCaseError> {
	const base: UseCaseError = detail === undefined ? { code, message } : { code, message, detail };
	return err(upstreamStatus === null ? base : { ...base, upstreamStatus });
}

/**
 * The failure code of an agent turn that threw instead of reporting a
 * `failed` event. Adapters are contractually non-throwing, so a throw is a
 * retryable provider failure, not a crash. The Rust runner reports the same
 * shape (`AGENT_THREW_Panic`, `crates/research-application`).
 */
export function agentThrewCode(thrown: unknown): string {
	return `AGENT_THREW_${thrownName(thrown)}`.slice(0, 60);
}
