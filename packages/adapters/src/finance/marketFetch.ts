/**
 * Shared HTTP and date plumbing for the keyed market-data adapters (FRED,
 * Twelve Data). Every request goes through the injected `SafeFetcher` pinned
 * to the provider's one host with byte and time ceilings (ADR-0005); the key
 * travels in the URL only where the provider's own API design requires it
 * (FRED's `api_key` parameter) and otherwise in the single allowed
 * `Authorization` header — never in a log line, an error message or stored
 * data.
 */
import type { SafeFetchError, SafeFetcher, SafeFetchOptions } from "@research/application";
import { err, ok, parseJson, type Result } from "@research/domain";

/** HTTP status carried by an `HTTP_ERROR`, or null for any other failure. */
export function httpStatusOf(error: SafeFetchError): number | null {
	if (error.code !== "HTTP_ERROR") return null;
	const match = /\b(\d{3})\b/.exec(error.detail);
	return match?.[1] === undefined ? null : Number(match[1]);
}

export interface JsonDocument {
	/** The URL that was actually retrieved (after validated redirects). */
	readonly finalUrl: string;
	readonly json: unknown;
}

/**
 * One GET that must answer JSON. Transport failures (including an attached
 * error body, which stays inside this module) are returned as-is for the
 * adapter to map; a 200 that is not JSON is `NETWORK_ERROR` with a fixed
 * detail, never provider text.
 */
export async function fetchJsonDocument(
	fetcher: SafeFetcher,
	url: string,
	options: SafeFetchOptions,
): Promise<Result<JsonDocument, SafeFetchError>> {
	const fetched = await fetcher.fetchText(url, options);
	if (!fetched.ok) return fetched;
	const json = parseJson(fetched.value.text);
	if (!json.ok) return err({ code: "NETWORK_ERROR", detail: "response is not valid JSON" });
	return ok({ finalUrl: fetched.value.finalUrl, json: json.value });
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/** True only for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
	const match = ISO_DATE_PATTERN.exec(value);
	if (match === null) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const check = new Date(Date.UTC(year, month - 1, day));
	return (
		check.getUTCFullYear() === year &&
		check.getUTCMonth() === month - 1 &&
		check.getUTCDate() === day
	);
}

/**
 * The leading YYYY-MM-DD of a provider timestamp (Twelve Data bars may carry
 * a time part), or null when it is not a real calendar date.
 */
export function datePrefixOf(value: string): string | null {
	const prefix = value.slice(0, 10);
	return isIsoDate(prefix) ? prefix : null;
}

/**
 * `isoDate` minus `days` calendar days (UTC, ISO text only — no `Date.now()`,
 * no time zones), or null when the input is not a valid ISO date. Used for
 * the `since − 45 days` revision overlap on incremental refreshes.
 */
export function subtractDaysIso(isoDate: string, days: number): string | null {
	if (!isIsoDate(isoDate)) return null;
	const at = Date.parse(`${isoDate}T00:00:00.000Z`);
	if (!Number.isFinite(at)) return null;
	return new Date(at - days * MS_PER_DAY).toISOString().slice(0, 10);
}
