/**
 * Typed-failure bridge between the pure core's `Result` and Effect (ADR-0007).
 * Use cases keep returning `Result`; shell code lifts them with `fromResult`
 * / `attemptResult` and runs Effect programs back into `Result` with
 * `toResult` at the next boundary.
 */

import { err, ok, type Result, thrownCode, thrownName } from "@research/domain";
import { Data, Effect, Result as EffectResult } from "effect";

/**
 * A failure the program did not plan for: a thrown error or a rejected
 * promise. Carries the operation name, the thrown value's name and — when it
 * carries a safe one — its OS error code only (`thrownName` / `thrownCode`),
 * never its message, which can contain stored content or identifiers (SEC-010).
 */
export class UnexpectedError extends Data.TaggedError("UnexpectedError")<{
	readonly operation: string;
	readonly errorName: string;
	readonly errorCode?: string;
}> {}

/** A pure-core `Result` becomes an Effect: `ok` succeeds, `err` fails. */
export function fromResult<T, E>(result: Result<T, E>): Effect.Effect<T, E> {
	return result.ok ? Effect.succeed(result.value) : Effect.fail(result.error);
}

/**
 * A throwing or rejecting promise becomes a typed `UnexpectedError` naming
 * the operation in progress.
 */
export function attempt<T>(
	operation: string,
	run: () => Promise<T>,
): Effect.Effect<T, UnexpectedError> {
	return Effect.tryPromise({
		try: run,
		catch: (thrown) =>
			new UnexpectedError({
				operation,
				errorName: thrownName(thrown),
				errorCode: thrownCode(thrown),
			}),
	});
}

/** `attempt` followed by `fromResult`, for promises of a `Result`. */
export function attemptResult<T, E>(
	operation: string,
	run: () => Promise<Result<T, E>>,
): Effect.Effect<T, E | UnexpectedError> {
	return Effect.flatMap(attempt(operation, run), fromResult);
}

/**
 * Runs the effect back into a pure-core `Result`: a typed failure becomes
 * `err`, success becomes `ok`. A defect (a bug) is not a typed failure, so
 * the promise rejects with it instead of converting it.
 */
export async function toResult<T, E>(effect: Effect.Effect<T, E>): Promise<Result<T, E>> {
	const outcome = await Effect.runPromise(Effect.result(effect));
	return EffectResult.isFailure(outcome) ? err(outcome.failure) : ok(outcome.success);
}
