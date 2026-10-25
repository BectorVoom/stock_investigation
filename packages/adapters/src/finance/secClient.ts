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
import {
	type Clock,
	type SafeFetchError,
	type SafeFetcher,
	type SafeFetchOptions,
	upstreamStatusOf,
} from "@research/application";
import { err, ok, parseJson, type Result } from "@research/domain";

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
	/** SEC's answer status behind `code`, unchanged; null when SEC did not answer with one (§4a). */
	readonly upstreamStatus: number | null;
}

export function secError(
	code: SecErrorCode,
	detail: string,
	retryable = false,
	upstreamStatus: number | null = null,
): SecError {
	return { code, detail, retryable, upstreamStatus };
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
	/** Injected in tests; defaults to a real timer. Resolves early when `signal` aborts. */
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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

/** What the safe fetcher reports for a request the caller aborted (its TIMEOUT detail). */
const CALLER_ABORTED_DETAIL = "aborted by the caller";

/**
 * The error an aborted SEC fetch ends with, for a source that answers from
 * its cache instead of fetching: a stopped job fails the same way either way.
 */
export function secCancelledError(): SecError {
	return translateFetchError({ code: "TIMEOUT", detail: CALLER_ABORTED_DETAIL });
}

function translateFetchError(error: SafeFetchError): SecError {
	const httpStatus = error.code === "HTTP_ERROR" ? error.status : null;
	// SEC's own status travels with every translation, unchanged (§4a).
	const upstreamStatus = upstreamStatusOf(error);
	if (httpStatus === 404) {
		return secError("NOT_FOUND", "SEC has no document at this address", false, upstreamStatus);
	}
	if (httpStatus === 403) {
		return secError(
			"ACCESS_DENIED",
			"SEC refused the request (HTTP 403): check the configured User-Agent contact details and request rate",
			false,
			upstreamStatus,
		);
	}
	if (httpStatus === 429) {
		return secError("RATE_LIMITED", "SEC rate limit reached (HTTP 429)", true, upstreamStatus);
	}
	if (error.code === "RESPONSE_TOO_LARGE") return secError("RESPONSE_TOO_LARGE", error.detail);
	const retryable =
		error.code === "TIMEOUT" ||
		error.code === "NETWORK_ERROR" ||
		(httpStatus !== null && httpStatus >= 500);
	return secError("FETCH_FAILED", `${error.code}: ${error.detail}`, retryable, upstreamStatus);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve();
			return;
		}
		const done = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

export function createSecClient(deps: SecClientDeps): SecClient {
	const sleep = deps.sleep ?? defaultSleep;
	let nextSlotMs = 0;

	/** Reserves the next request slot synchronously, so concurrent callers queue up in order. */
	async function waitForSlot(signal: AbortSignal | undefined): Promise<void> {
		const nowMs = deps.clock.nowMs();
		const slotMs = Math.max(nowMs, nextSlotMs);
		nextSlotMs = slotMs + SEC_MIN_REQUEST_INTERVAL_MS;
		// A stopped job must not keep waiting for its slot; the fetch then sees the same signal.
		if (slotMs > nowMs) await sleep(slotMs - nowMs, signal);
	}

	return {
		async fetchDocument(url, request) {
			if (!isUsableSecUserAgent(deps.userAgent)) {
				return err(secError("NOT_CONFIGURED", NOT_CONFIGURED_DETAIL));
			}
			await waitForSlot(request.signal);
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
	const parsed = parseJson(document.text);
	return parsed.ok
		? parsed
		: err(secError("UNEXPECTED_RESPONSE", "SEC response is not valid JSON"));
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
