/** Result narrowing for finance adapter tests (mirrors the domain support). */
import type { Result } from "@research/domain";

export function expectOk<T, E>(result: Result<T, E>): T {
	if (!result.ok) throw new Error(`expected ok, got error ${JSON.stringify(result.error)}`);
	return result.value;
}

export function expectErr<T, E>(result: Result<T, E>): E {
	if (result.ok) throw new Error(`expected an error, got ok ${JSON.stringify(result.value)}`);
	return result.error;
}
