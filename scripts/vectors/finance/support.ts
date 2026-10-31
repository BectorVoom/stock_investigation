/**
 * Shared pieces of the finance / Google exporters (ADR-0030): a seeded
 * generator with the conveniences the corpora need, a scripted fetcher that
 * answers from a sequential script and records every call, and the
 * normalisation of recorded calls and values into the JSON the Rust replay
 * compares against.
 */
import { createHash } from "node:crypto";
import type {
	BinaryDocument,
	Clock,
	FetchedDocument,
	MarketRequestAdmission,
	SafeBinaryFetcher,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import { err, ok } from "@research/domain";
import { seededRandom } from "../shared.ts";

/** A seeded generator with the helpers every corpus uses. */
export class Rng {
	private readonly next: () => number;

	constructor(seed: number) {
		this.next = seededRandom(seed);
	}

	float(): number {
		return this.next();
	}

	/** An integer in `[min, max]`. */
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1));
	}

	chance(probability: number): boolean {
		return this.next() < probability;
	}

	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error("pick from an empty list");
		// `T` may include `undefined`, so the bounds check is on the index.
		return items[Math.floor(this.next() * items.length)] as T;
	}

	/** `count` items picked with replacement. */
	picks<T>(items: readonly T[], count: number): T[] {
		return Array.from({ length: count }, () => this.pick(items));
	}

	/** Fisher-Yates, in place; returns the same array. */
	shuffle<T>(items: T[]): T[] {
		for (let index = items.length - 1; index > 0; index -= 1) {
			const other = this.int(0, index);
			const first = items[index];
			const second = items[other];
			if (first === undefined || second === undefined) continue;
			items[index] = second;
			items[other] = first;
		}
		return items;
	}
}

/** One scripted answer. `bytes` (base64) answers the binary fetcher. */
export type ScriptEntry =
	| {
			readonly text: string;
			readonly contentType?: string | null;
			readonly finalUrl?: string;
	  }
	| { readonly bytes: string; readonly contentType?: string | null; readonly finalUrl?: string }
	| { readonly error: SafeFetchError };

export interface RecordedCall {
	readonly url: string;
	readonly accept: string;
	readonly maxBytes: number;
	readonly timeoutMs: number;
	readonly allowedHosts: readonly string[] | null;
	readonly userAgent: string | null;
	readonly authorization: string | null;
	readonly finnhubToken: string | null;
	readonly includeErrorBody: boolean;
	readonly hasSignal: boolean;
}

export function normalizeCall(url: string, options: SafeFetchOptions): RecordedCall {
	return {
		url,
		accept: options.accept,
		maxBytes: options.maxBytes,
		timeoutMs: options.timeoutMs,
		allowedHosts: options.allowedHosts === undefined ? null : [...options.allowedHosts].sort(),
		userAgent: options.userAgent ?? null,
		authorization: options.authorization ?? null,
		finnhubToken: options.finnhubToken ?? null,
		includeErrorBody: options.includeErrorBody === true,
		hasSignal: options.signal !== undefined,
	};
}

export type FetchEvent =
	| { readonly fetch: RecordedCall }
	| { readonly before: true }
	| { readonly sleep: number };

/**
 * A fetcher (text and binary) that answers the n-th call with the n-th
 * script entry, refuses hosts outside `allowedHosts` like the real one, and
 * answers `HTTP 404` once the script is exhausted. Calls are appended to
 * `events` (shared with the other recording doubles so the interleaving is
 * recorded too).
 */
export function scriptedFetcher(
	script: readonly ScriptEntry[],
	events: FetchEvent[],
): SafeFetcher & SafeBinaryFetcher {
	let index = 0;
	function take(url: string, options: SafeFetchOptions): ScriptEntry | SafeFetchError {
		events.push({ fetch: normalizeCall(url, options) });
		const host = new URL(url).hostname;
		if (options.allowedHosts !== undefined && !options.allowedHosts.has(host)) {
			return { code: "HOST_NOT_ALLOWED", detail: "host is not on the allowlist" };
		}
		const entry = script[index];
		index += 1;
		if (entry === undefined) return { code: "HTTP_ERROR", detail: "HTTP 404", status: 404 };
		return entry;
	}
	return {
		async fetchText(url, options) {
			const entry = take(url, options);
			if ("code" in entry) return err(entry);
			if ("error" in entry) return err(entry.error);
			if ("bytes" in entry) return err({ code: "NETWORK_ERROR", detail: "binary entry for text" });
			const document: FetchedDocument = {
				finalUrl: entry.finalUrl ?? url,
				contentType: entry.contentType ?? null,
				text: entry.text,
			};
			return ok(document);
		},
		async fetchBytes(url, options) {
			const entry = take(url, options);
			if ("code" in entry) return err(entry);
			if ("error" in entry) return err(entry.error);
			if ("text" in entry) return err({ code: "NETWORK_ERROR", detail: "text entry for bytes" });
			const document: BinaryDocument = {
				finalUrl: entry.finalUrl ?? url,
				contentType: entry.contentType ?? null,
				bytes: new Uint8Array(Buffer.from(entry.bytes, "base64")),
			};
			return ok(document);
		},
	};
}

/** `beforeRequest` hook answering from a list (true once the list is used up). */
/** Answers a market request's admission with the n-th scripted answer (then `granted`), logged like `scriptedBefore`. */
export function scriptedAdmission(
	answers: readonly MarketRequestAdmission[],
	events: FetchEvent[],
): () => Promise<MarketRequestAdmission> {
	let index = 0;
	return async () => {
		events.push({ before: true });
		const answer = answers[index] ?? "granted";
		index += 1;
		return answer;
	};
}

export function scriptedBefore(
	answers: readonly boolean[],
	events: FetchEvent[],
): () => Promise<boolean> {
	let index = 0;
	return async () => {
		events.push({ before: true });
		const answer = answers[index] ?? true;
		index += 1;
		return answer;
	};
}

/** A clock fixed at one instant. */
export function fixedClockAt(ms: number): Clock {
	return { nowMs: () => ms, nowIso: () => new Date(ms).toISOString() };
}

/** A clock a test advances by hand. */
export interface TickingClock extends Clock {
	advance(ms: number): void;
	set(ms: number): void;
}

export function tickingClock(start: number): TickingClock {
	let now = start;
	return {
		nowMs: () => now,
		nowIso: () => new Date(now).toISOString(),
		advance(ms) {
			now += ms;
		},
		set(ms) {
			now = ms;
		},
	};
}

/** Marks a negative zero, which JSON text cannot carry. */
export const NEGATIVE_ZERO = "-0(neg)";

/**
 * Plain JSON copy of a value (drops `undefined`). A negative zero becomes the
 * string `NEGATIVE_ZERO`, so the replays can compare it exactly.
 */
export function plain(value: unknown): unknown {
	return JSON.parse(
		JSON.stringify(value, (_key, item: unknown) => (Object.is(item, -0) ? NEGATIVE_ZERO : item)),
	);
}

/** JSON with sorted keys and JavaScript number text, the form digests are taken of. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

/** SHA-256 (hex) of the canonical form: lets a replay compare a long list exactly. */
export function digestOf(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(plain(value)))
		.digest("hex");
}

/**
 * The status a scripted `HTTP_ERROR` carries when its detail names none
 * ("x", "HTTP 1234"): a status no mapping table names, so a replay shows it
 * comes out unchanged (docs/rule/error_handling.md §4a).
 */
export const UNNAMED_STATUS = 520;

/**
 * A SafeFetchError as the exporters script it. An `HTTP_ERROR` carries
 * `status` like the real fetcher's: the number its "HTTP NNN" detail names
 * (fixture generation only — production code never reads a status from
 * text), else `UNNAMED_STATUS`.
 */
export function scriptedFetchError(
	code: SafeFetchError["code"],
	detail: string,
	body?: string,
): SafeFetchError {
	if (code !== "HTTP_ERROR") return { code, detail };
	const named = /^HTTP (\d{3})(?!\d)/.exec(detail)?.[1];
	const status = named === undefined ? UNNAMED_STATUS : Number(named);
	return body === undefined ? { code, detail, status } : { code, detail, status, body };
}

/** `scriptedFetchError` as a script entry. */
export function fetchError(
	code: SafeFetchError["code"],
	detail: string,
	body?: string,
): ScriptEntry {
	return { error: scriptedFetchError(code, detail, body) };
}

export const FETCH_ERROR_CODES: readonly SafeFetchError["code"][] = [
	"UNSAFE_URL",
	"HOST_NOT_ALLOWED",
	"UNSAFE_REDIRECT",
	"TOO_MANY_REDIRECTS",
	"REDIRECT_NOT_AUTHORIZED",
	"TIMEOUT",
	"HTTP_ERROR",
	"RESPONSE_TOO_LARGE",
	"NETWORK_ERROR",
];

/** Details real fetchers produce, plus hostile ones for the status parser. */
export const HTTP_DETAILS: readonly string[] = [
	"HTTP 400",
	"HTTP 401",
	"HTTP 403",
	"HTTP 404",
	"HTTP 429",
	"HTTP 500",
	"HTTP 503",
	"HTTP 301 without a Location header",
	"HTTP 1234",
	"HTTP 12",
	"HTTP",
	"status 404 and 429",
	"HTTP 4040 404",
	"HTTP_404",
	"é404",
	"",
];

export function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}
