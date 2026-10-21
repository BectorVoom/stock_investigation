/**
 * Log-safe labels for a thrown value (docs/rule/error_handling.md, SEC-010).
 *
 * A thrown value's message and stack can carry stored content, prompts,
 * tokens, paths or a remote address (Node puts the IP and port into socket
 * errors), so nothing but these short tokens ever leaves a `catch`. Every
 * `catch` that has to name what it caught uses these functions — there is no
 * other copy of the rule.
 */

/** What the labels fall back to when the thrown value carries no safe token. */
export const UNKNOWN_THROWN_NAME = "unknown";

/**
 * `describeThrown`'s fallback. The Rust runner writes the same string
 * (`UNKNOWN_ERROR` in `crates/research-net/src/errors.rs`), so failure details
 * stay comparable across the two runtimes.
 */
export const UNKNOWN_ERROR = "unknown error";

/** An OS / library error code such as `EACCES` or `ERR_TLS_CERT_ALTNAME_INVALID`. */
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,59}$/;

/** A class or `name` property such as `TypeError`, `AbortError` or `StoredDataError`. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;

function stringProperty(thrown: unknown, key: "code" | "name"): string | undefined {
	if (typeof thrown !== "object" || thrown === null || !(key in thrown)) return undefined;
	const value: unknown = Reflect.get(thrown, key);
	return typeof value === "string" ? value : undefined;
}

/**
 * The thrown value's error code when it is a safe token (`EACCES`, `ENOENT`,
 * `ECONNRESET`), otherwise `undefined` — never free text.
 */
export function thrownCode(thrown: unknown): string | undefined {
	const code = stringProperty(thrown, "code");
	return code !== undefined && SAFE_CODE.test(code) ? code : undefined;
}

/**
 * The thrown value's `name` (`TypeError`, `AbortError`, `TimeoutError`) when it
 * is a safe token, otherwise `"unknown"`. A thrown string or number has no name.
 */
export function thrownName(thrown: unknown): string {
	const name = stringProperty(thrown, "name");
	return name !== undefined && SAFE_NAME.test(name) ? name : UNKNOWN_THROWN_NAME;
}

/**
 * One short label for a failure detail: the safe code when there is one
 * (more specific: `ECONNREFUSED` over `Error`), else the safe name, else
 * `"unknown error"`.
 */
export function describeThrown(thrown: unknown): string {
	const code = thrownCode(thrown);
	if (code !== undefined) return code;
	const name = thrownName(thrown);
	return name === UNKNOWN_THROWN_NAME ? UNKNOWN_ERROR : name;
}
