import type { ApiErrorCode } from "@research/contracts";
import { err, type Result } from "@research/domain";

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
