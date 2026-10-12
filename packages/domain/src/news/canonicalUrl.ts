import { err, ok, type Result } from "../result.ts";
import { type UrlPolicyError, validateFetchUrl } from "./urlPolicy.ts";

const TRACKING_PARAMETERS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
	"mc_cid",
	"mc_eid",
	"igshid",
	"yclid",
	"ref_src",
	"cmpid",
	"ocid",
]);

function isTrackingParameter(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.startsWith("utm_") || TRACKING_PARAMETERS.has(lower);
}

/**
 * Code-unit order. Unlike `localeCompare` it never ranks two distinct strings as
 * equal and does not depend on the runtime's locale, so the Worker and the
 * runner always derive the same identity (ARCH-011).
 */
function compareCodeUnits(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? -1 : 1;
}

/**
 * Canonical form used as the article identity (FR-003): lower-case host, no
 * fragment, no tracking parameters, stable parameter order, no trailing slash
 * on non-root paths. Two URLs that differ only in those respects are one article.
 */
export function canonicalizeArticleUrl(rawUrl: string): Result<string, UrlPolicyError> {
	const validated = validateFetchUrl(rawUrl);
	if (!validated.ok) return err(validated.error);
	const url = new URL(validated.value.href);
	url.hash = "";
	url.hostname = validated.value.hostname;
	const kept = [...url.searchParams.entries()]
		.filter(([name]) => !isTrackingParameter(name))
		.sort(
			([nameA, valueA], [nameB, valueB]) =>
				compareCodeUnits(nameA, nameB) || compareCodeUnits(valueA, valueB),
		);
	url.search = new URLSearchParams(kept).toString();
	if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
		url.pathname = url.pathname.replace(/\/+$/, "");
	}
	return ok(url.href);
}
