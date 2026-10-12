import { expect } from "vitest";
import type { z } from "zod";

/** Asserts the schema accepts the value and returns the parsed output. */
export function expectAccepted<Output>(schema: z.ZodType<Output>, value: unknown): Output {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new Error(`expected acceptance, got: ${JSON.stringify(parsed.error.issues)}`);
	}
	return parsed.data;
}

/**
 * Asserts the schema rejects the value. When `path` is given, at least one
 * issue must be reported at (or below) that path, so the test fails if the
 * value was rejected for an unrelated reason.
 */
export function expectRejected(
	schema: z.ZodType,
	value: unknown,
	path?: readonly (string | number)[],
): void {
	const parsed = schema.safeParse(value);
	if (parsed.success) {
		throw new Error(`expected rejection, but the schema accepted ${JSON.stringify(value)}`);
	}
	if (path === undefined) return;
	const paths = parsed.error.issues.map((issue) => issue.path);
	const matches = paths.some((issuePath) =>
		path.every((segment, index) => issuePath[index] === segment),
	);
	expect({ expectedPath: path, reportedPaths: paths, matches }).toMatchObject({ matches: true });
}

/** Shallow copy without one key, for "required field is missing" cases. */
export function without<T extends object>(value: T, key: keyof T & string): object {
	return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

/** N copies of a fixture, for collection-size limits. */
export function repeat<T>(value: T, count: number): T[] {
	return Array.from({ length: count }, () => value);
}
