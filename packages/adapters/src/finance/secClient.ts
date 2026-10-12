/**
 * Shared access path to SEC EDGAR (official, free, US-government public data).
 *
 * SEC fair-access rules this client honours:
 *  - every request carries the owner's descriptive User-Agent with contact
 *    details. It is configuration, never invented here: without it the client
 *    fails closed with `NOT_CONFIGURED` and performs no request;
 *  - request starts are spaced so the client stays well under 10 requests per
 *    second (SEC's published ceiling);
 *  - no automatic retries (retry ceiling 0); callers get a `retryable` flag.
 * All network access goes through the injected SafeFetcher, pinned to the two
 * SEC hosts, with a byte cap and a timeout per request (API-007).
 */
import type { Clock, SafeFetchError, SafeFetcher, SafeFetchOptions } from "@research/application";
import { err, ok, type Result } from "@research/domain";

export const SEC_HOSTS: readonly string[] = ["www.sec.gov", "data.sec.gov"];
export const SEC_PUBLISHER = "U.S. Securities and Exchange Commission (EDGAR)";

/** 8 request starts per second at most; SEC's ceiling is 10. */
export const SEC_MIN_REQUEST_INTERVAL_MS = 125;

const SEC_ALLOWED_HOSTS: ReadonlySet<string> = new Set(SEC_HOSTS);
const SEC_TIMEOUT_MS = 30_000;

export type SecErrorCode =
	| "NOT_CONFIGURED"
	| "INVALID_IDENTIFIER"
	| "NOT_FOUND"
	| "ACCESS_DENIED"
	| "RATE_LIMITED"
	| "FETCH_FAILED"
	| "RESPONSE_TOO_LARGE"
	| "UNEXPECTED_RESPONSE"
	| "NO_DATA";

export interface SecError {
	readonly code: SecErrorCode;
	readonly detail: string;
	readonly retryable: boolean;
}

export function secError(code: SecErrorCode, detail: string, retryable = false): SecError {
	return { code, detail, retryable };
}

export interface SecDocument {
	/** The URL that was actually retrieved (after validated redirects). */
	readonly url: string;
	readonly text: string;
}

export interface SecClient {
	fetchDocument(
		url: string,
		request: { readonly maxBytes: number; readonly accept: string; readonly signal?: AbortSignal },
	): Promise<Result<SecDocument, SecError>>;
}

export interface SecClientDeps {
	readonly fetcher: SafeFetcher;
	readonly clock: Clock;
	/** e.g. "Jane Doe research jane@example.com". null = SEC access is not configured. */
	readonly userAgent: string | null;
	/** Injected in tests; defaults to a real timer. */
	readonly sleep?: (ms: number) => Promise<void>;
}

const NOT_CONFIGURED_DETAIL =
	"SEC EDGAR access is not configured: set a descriptive User-Agent with a contact e-mail address (SEC fair-access policy)";

/**
 * SEC asks for "Sample Company Name AdminContact@example.com". We cannot verify
 * the contact is real, but we can refuse values that plainly carry none.
 */
export function isUsableSecUserAgent(userAgent: string | null): userAgent is string {
	return (
		userAgent !== null &&
		/^[\x20-\x7e]{8,200}$/.test(userAgent) &&
		/[^\s@]+@[^\s@]+\.[^\s@]+/.test(userAgent)
	);
}

function httpStatusOf(error: SafeFetchError): number | null {
	if (error.code !== "HTTP_ERROR") return null;
	const match = /\b(\d{3})\b/.exec(error.detail);
	return match?.[1] === undefined ? null : Number(match[1]);
}

function translateFetchError(error: SafeFetchError): SecError {
	const status = httpStatusOf(error);
	if (status === 404) return secError("NOT_FOUND", "SEC has no document at this address");
	if (status === 403) {
		return secError(
			"ACCESS_DENIED",
			"SEC refused the request (HTTP 403): check the configured User-Agent contact details and request rate",
		);
	}
	if (status === 429) return secError("RATE_LIMITED", "SEC rate limit reached (HTTP 429)", true);
	if (error.code === "RESPONSE_TOO_LARGE") return secError("RESPONSE_TOO_LARGE", error.detail);
	const retryable =
		error.code === "TIMEOUT" ||
		error.code === "NETWORK_ERROR" ||
		(status !== null && status >= 500);
	return secError("FETCH_FAILED", `${error.code}: ${error.detail}`, retryable);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function createSecClient(deps: SecClientDeps): SecClient {
	const sleep = deps.sleep ?? defaultSleep;
	let nextSlotMs = 0;

	/** Reserves the next request slot synchronously, so concurrent callers queue up in order. */
	async function waitForSlot(): Promise<void> {
		const nowMs = deps.clock.nowMs();
		const slotMs = Math.max(nowMs, nextSlotMs);
		nextSlotMs = slotMs + SEC_MIN_REQUEST_INTERVAL_MS;
		if (slotMs > nowMs) await sleep(slotMs - nowMs);
	}

	return {
		async fetchDocument(url, request) {
			if (!isUsableSecUserAgent(deps.userAgent)) {
				return err(secError("NOT_CONFIGURED", NOT_CONFIGURED_DETAIL));
			}
			await waitForSlot();
			const options: SafeFetchOptions = {
				maxBytes: request.maxBytes,
				timeoutMs: SEC_TIMEOUT_MS,
				accept: request.accept,
				allowedHosts: SEC_ALLOWED_HOSTS,
				userAgent: deps.userAgent,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			};
			const fetched = await deps.fetcher.fetchText(url, options);
			if (!fetched.ok) return err(translateFetchError(fetched.error));
			return ok({ url: fetched.value.finalUrl, text: fetched.value.text });
		},
	};
}

export function parseSecJson(document: SecDocument): Result<unknown, SecError> {
	try {
		const value: unknown = JSON.parse(document.text);
		return ok(value);
	} catch {
		return err(secError("UNEXPECTED_RESPONSE", "SEC response is not valid JSON"));
	}
}

/** Ten-digit zero-padded CIK, or null when the text is not a CIK. */
export function normalizeCik(text: string): string | null {
	const digits = text.trim().replace(/^CIK/i, "");
	if (!/^\d{1,10}$/.test(digits)) return null;
	const padded = digits.padStart(10, "0");
	return /^0{10}$/.test(padded) ? null : padded;
}

/** "2024-11-01" -> "2024-11-01T00:00:00.000Z". SEC publishes dates, not instants. */
export function isoDateToInstant(isoDate: string): string {
	return `${isoDate}T00:00:00.000Z`;
}
