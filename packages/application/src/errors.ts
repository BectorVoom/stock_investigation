import type { ApiErrorCode } from "@research/contracts";
import { err, type Result, thrownName } from "@research/domain";

/** Expected use-case failure. `code` is the stable API error code; `message` is safe to show. */
export interface UseCaseError {
	readonly code: ApiErrorCode;
	readonly message: string;
	readonly detail?: string;
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
 * The failure code of an agent turn that threw instead of reporting a
 * `failed` event. Adapters are contractually non-throwing, so a throw is a
 * retryable provider failure, not a crash. The Rust runner reports the same
 * shape (`AGENT_THREW_Panic`, `crates/research-application`).
 */
export function agentThrewCode(thrown: unknown): string {
	return `AGENT_THREW_${thrownName(thrown)}`.slice(0, 60);
}
