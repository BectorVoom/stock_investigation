/**
 * Typed-failure bridge between the pure core's `Result` and Effect (ADR-0007).
 * Use cases keep returning `Result`; shell code lifts them with `fromResult`
 * / `attemptResult` and runs Effect programs back into `Result` with
 * `toResult` at the next boundary.
 */

import { err, ok, type Result } from "@research/domain";
import { Data, Effect, Result as EffectResult } from "effect";

/**
 * A failure the program did not plan for: a thrown error or a rejected
 * promise. Carries the operation name, the thrown value's class name and —
 * when the thrown value carries a safe one — its OS error code only, never
 * its message, which can contain stored content or identifiers (SEC-010).
 */
export class UnexpectedError extends Data.TaggedError("UnexpectedError")<{
	readonly operation: string;
	readonly errorName: string;
	readonly errorCode?: string;
}> {}

/** The thrown value's class name only — never its message (SEC-010). */
function errorNameOf(thrown: unknown): string {
	if (thrown instanceof Error) return thrown.constructor.name;
	if (typeof thrown === "object" && thrown !== null) {
		const prototype: unknown = Object.getPrototypeOf(thrown);
		if (
			typeof prototype === "object" &&
			prototype !== null &&
			"constructor" in prototype &&
			typeof prototype.constructor === "function" &&
			prototype.constructor.name !== ""
		) {
			return prototype.constructor.name;
		}
	}
	return "unknown";
}

/** A string `code` on the thrown value is kept only when it is a safe OS-style token. */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * The OS error code (`EACCES`, `ENOENT`) when the thrown value carries one as
 * a safe token — never free text, which can contain paths or stored content
 * (SEC-010).
 */
function errorCodeOf(thrown: unknown): string | undefined {
	if (typeof thrown === "object" && thrown !== null && "code" in thrown) {
		const code: unknown = thrown.code;
		if (typeof code === "string" && ERROR_CODE_PATTERN.test(code)) return code;
	}
	return undefined;
}

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
				errorName: errorNameOf(thrown),
				errorCode: errorCodeOf(thrown),
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
