import { err, ok, type Result } from "./result.ts";

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * `JSON.parse` as a total function: text that is not JSON is an expected
 * failure, not a throw (docs/rule/error_handling.md). The value is `unknown`
 * on purpose — validate it with a schema before use.
 */
export function parseJson(text: string): Result<unknown, "INVALID_JSON"> {
	try {
		const value: unknown = JSON.parse(text);
		return ok(value);
	} catch {
		// JSON.parse throws only SyntaxError, which is exactly "not JSON".
		return err("INVALID_JSON");
	}
}

/**
 * `parseJson` for text that goes straight into a schema check: text that is
 * not JSON becomes `null`, which the schema then rejects like any other
 * wrong shape.
 */
export function parseJsonOrNull(text: string): unknown {
	const parsed = parseJson(text);
	return parsed.ok ? parsed.value : null;
}
