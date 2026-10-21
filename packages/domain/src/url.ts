/**
 * `new URL` as a total function: a malformed URL (or base) is an expected
 * outcome, so it returns `null` instead of throwing
 * (docs/rule/error_handling.md).
 */
export function parseUrl(raw: string, base?: string | URL): URL | null {
	try {
		return new URL(raw, base);
	} catch {
		// The URL constructor throws only TypeError, which is exactly "not a URL".
		return null;
	}
}
