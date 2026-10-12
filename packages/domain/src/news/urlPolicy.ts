import { err, ok, type Result } from "../result.ts";
import { looksLikeIpLiteral } from "./ipClassification.ts";

/**
 * String-level URL policy for outbound fetches (SEC-002, layer 1 of 4).
 * Passing this check is necessary but NOT sufficient: adapters must still
 * enforce connection-time destination checks, per-hop redirect validation and
 * byte/time limits, because DNS can map an innocent name to a private address.
 */
export type UrlPolicyError =
	| "MALFORMED_URL"
	| "URL_TOO_LONG"
	| "SCHEME_NOT_ALLOWED"
	| "CREDENTIALS_NOT_ALLOWED"
	| "PORT_NOT_ALLOWED"
	| "IP_LITERAL_NOT_ALLOWED"
	| "HOSTNAME_NOT_ALLOWED";

export const MAX_URL_LENGTH = 2048;

const FORBIDDEN_HOST_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".intranet",
	".lan",
	".home",
	".corp",
	".home.arpa",
	".test",
	".invalid",
	".example",
	".onion",
];

export interface ValidatedFetchUrl {
	/** Normalized absolute URL, safe to hand to a network-restricted fetch adapter. */
	readonly href: string;
	readonly hostname: string;
}

export function validateFetchUrl(rawUrl: string): Result<ValidatedFetchUrl, UrlPolicyError> {
	if (rawUrl.length > MAX_URL_LENGTH) return err("URL_TOO_LONG");
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return err("MALFORMED_URL");
	}
	if (url.protocol !== "https:") return err("SCHEME_NOT_ALLOWED");
	if (url.username !== "" || url.password !== "") return err("CREDENTIALS_NOT_ALLOWED");
	// URL normalizes the default port to "", so any explicit value is a non-443 port.
	if (url.port !== "") return err("PORT_NOT_ALLOWED");
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (looksLikeIpLiteral(hostname)) return err("IP_LITERAL_NOT_ALLOWED");
	if (
		hostname === "" ||
		hostname === "localhost" ||
		!hostname.includes(".") ||
		// An empty label ("localhost..", "a..b") names nothing resolvable and would dodge the suffix checks.
		hostname.split(".").includes("") ||
		FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
	) {
		return err("HOSTNAME_NOT_ALLOWED");
	}
	return ok({ href: url.href, hostname });
}
