import type { Result } from "../../src/result.ts";

/** Narrows a Result to its value, failing the test with the error otherwise. */
export function expectOk<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(`expected ok, got error ${JSON.stringify(result.error)}`);
	return result.value;
}

/** Narrows a Result to its error, failing the test when it unexpectedly succeeded. */
export function expectErr<T, E>(result: Result<T, E>): E {
	if (result.ok) throw new Error(`expected an error, got ok ${JSON.stringify(result.value)}`);
	return result.error;
}
