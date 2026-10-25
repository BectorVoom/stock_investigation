import { describe, expect, it, vi } from "vitest";
import {
	createSecClient,
	isUsableSecUserAgent,
	normalizeCik,
	SEC_MIN_REQUEST_INTERVAL_MS,
} from "../../src/finance/secClient.ts";
import { createScriptedFetcher, fixedClock, SEC_USER_AGENT } from "../tools/support.ts";

const URL_A = "https://data.sec.gov/submissions/CIK0009999993.json";
const REQUEST = { maxBytes: 1000, accept: "application/json" } as const;

describe("SEC client: configuration", () => {
	it.each([
		null,
		"",
		"curl/8.0",
		"Mozilla/5.0 (no contact details)",
		"Jane Doe jane@synthetic-wire.org\r\nX-Injected: 1",
		`x@y.zz ${"a".repeat(300)}`,
	])("fails closed with NOT_CONFIGURED and performs no request for User-Agent %j", async (userAgent) => {
		const fetcher = createScriptedFetcher({ [URL_A]: { text: "{}" } });
		const client = createSecClient({ fetcher, clock: fixedClock(), userAgent });
		const result = await client.fetchDocument(URL_A, REQUEST);
		expect(result).toMatchObject({
			ok: false,
			error: { code: "NOT_CONFIGURED", retryable: false },
		});
		expect(fetcher.calls).toHaveLength(0);
	});

	it("accepts a descriptive User-Agent with a contact address", () => {
		expect(isUsableSecUserAgent(SEC_USER_AGENT)).toBe(true);
		expect(isUsableSecUserAgent("Example Fund LLC compliance@synthetic-wire.org")).toBe(true);
	});

	it("sends the owner's User-Agent, pinned to the SEC hosts, with size and time limits", async () => {
		const fetcher = createScriptedFetcher({ [URL_A]: { text: '{"a":1}' } });
		const client = createSecClient({ fetcher, clock: fixedClock(), userAgent: SEC_USER_AGENT });
		const signal = new AbortController().signal;
		const result = await client.fetchDocument(URL_A, { ...REQUEST, signal });
		expect(result).toEqual({ ok: true, value: { url: URL_A, text: '{"a":1}' } });
		const [call] = fetcher.calls;
		expect(call?.options.userAgent).toBe(SEC_USER_AGENT);
		expect([...(call?.options.allowedHosts ?? [])].sort()).toEqual(["data.sec.gov", "www.sec.gov"]);
		expect(call?.options.maxBytes).toBe(1000);
		expect(call?.options.timeoutMs).toBeGreaterThan(0);
		expect(call?.options.accept).toBe("application/json");
		expect(call?.options.signal).toBe(signal);
	});

	it("cannot be pointed at a host other than SEC's", async () => {
		const fetcher = createScriptedFetcher({
			"https://evil.synthetic-attacker.org/x": { text: "leaked" },
		});
		const client = createSecClient({ fetcher, clock: fixedClock(), userAgent: SEC_USER_AGENT });
		const result = await client.fetchDocument("https://evil.synthetic-attacker.org/x", REQUEST);
		expect(result).toMatchObject({ ok: false, error: { code: "FETCH_FAILED", retryable: false } });
	});
});

describe("SEC client: fair-access request spacing", () => {
	it("keeps request starts at least the minimum interval apart, in call order", async () => {
		// A virtual clock: sleeping registers a timer, and the loop below advances time timer by timer.
		let nowMs = 1_000_000;
		const timers: { readonly at: number; readonly wake: () => void }[] = [];
		const startedAt: number[] = [];
		const fetcher = createScriptedFetcher({ [URL_A]: { text: "{}" } });
		const client = createSecClient({
			fetcher: {
				fetchText: (url, options) => {
					startedAt.push(nowMs);
					return fetcher.fetchText(url, options);
				},
			},
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			userAgent: SEC_USER_AGENT,
			sleep: (ms) =>
				new Promise<void>((wake) => {
					timers.push({ at: nowMs + ms, wake });
				}),
		});
		// Twelve requests issued in the same instant: a burst SEC would count against its limit.
		const burst = Promise.all(
			Array.from({ length: 12 }, () => client.fetchDocument(URL_A, REQUEST)),
		);
		for (;;) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			timers.sort((a, b) => a.at - b.at);
			const next = timers.shift();
			if (next === undefined) break;
			nowMs = next.at;
			next.wake();
		}
		const results = await burst;
		expect(results.every((result) => result.ok)).toBe(true);
		expect(startedAt).toHaveLength(12);
		for (let index = 1; index < startedAt.length; index += 1) {
			const gap = (startedAt[index] ?? 0) - (startedAt[index - 1] ?? 0);
			expect(gap).toBeGreaterThanOrEqual(SEC_MIN_REQUEST_INTERVAL_MS);
		}
		// Never more than 10 starts in any one-second window (SEC's stated ceiling).
		for (const windowStart of startedAt) {
			const inWindow = startedAt.filter((at) => at >= windowStart && at < windowStart + 1000);
			expect(inWindow.length).toBeLessThanOrEqual(10);
		}
	});

	it("hands the request's signal to the sleep, so a stop ends the wait", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const client = createSecClient({
			fetcher: createScriptedFetcher({ [URL_A]: { text: "{}" } }),
			clock: { nowMs: () => 5_000, nowIso: () => "" },
			userAgent: SEC_USER_AGENT,
			sleep: async (_ms, signal) => {
				signals.push(signal);
			},
		});
		const stop = new AbortController();
		await client.fetchDocument(URL_A, REQUEST);
		await client.fetchDocument(URL_A, { ...REQUEST, signal: stop.signal });
		expect(signals).toEqual([stop.signal]);
	});

	it("the default wait ends at once when the request is cancelled (F2)", async () => {
		vi.useFakeTimers();
		try {
			const client = createSecClient({
				fetcher: createScriptedFetcher({ [URL_A]: { text: "{}" } }),
				clock: { nowMs: () => 5_000, nowIso: () => "" },
				userAgent: SEC_USER_AGENT,
			});
			await client.fetchDocument(URL_A, REQUEST);
			const stop = new AbortController();
			let finished = false;
			const queued = client.fetchDocument(URL_A, { ...REQUEST, signal: stop.signal }).then(() => {
				finished = true;
			});
			await vi.advanceTimersByTimeAsync(10);
			expect(finished).toBe(false);
			stop.abort();
			// No timer is advanced: the wait must end by itself.
			await queued;
			expect(finished).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not delay a request made after the interval has passed", async () => {
		let nowMs = 5_000;
		const slept: number[] = [];
		const client = createSecClient({
			fetcher: createScriptedFetcher({ [URL_A]: { text: "{}" } }),
			clock: { nowMs: () => nowMs, nowIso: () => "" },
			userAgent: SEC_USER_AGENT,
			sleep: async (ms) => {
				slept.push(ms);
			},
		});
		await client.fetchDocument(URL_A, REQUEST);
		nowMs += 10_000;
		await client.fetchDocument(URL_A, REQUEST);
		expect(slept).toEqual([]);
	});
});

describe("SEC client: failure translation", () => {
	const cases = [
		[{ code: "HTTP_ERROR", detail: "HTTP 404", status: 404 }, "NOT_FOUND", false],
		[{ code: "HTTP_ERROR", detail: "HTTP 403", status: 403 }, "ACCESS_DENIED", false],
		[{ code: "HTTP_ERROR", detail: "HTTP 429", status: 429 }, "RATE_LIMITED", true],
		[{ code: "HTTP_ERROR", detail: "HTTP 503", status: 503 }, "FETCH_FAILED", true],
		[{ code: "HTTP_ERROR", detail: "HTTP 400", status: 400 }, "FETCH_FAILED", false],
		[{ code: "TIMEOUT", detail: "no complete response within 30000 ms" }, "FETCH_FAILED", true],
		[{ code: "NETWORK_ERROR", detail: "ECONNRESET" }, "FETCH_FAILED", true],
		[
			{ code: "RESPONSE_TOO_LARGE", detail: "body exceeds 1000 bytes" },
			"RESPONSE_TOO_LARGE",
			false,
		],
		[{ code: "UNSAFE_REDIRECT", detail: "redirect 1 rejected" }, "FETCH_FAILED", false],
	] as const;

	it.each(cases)("maps %j to %s (retryable: %s)", async (error, code, retryable) => {
		const client = createSecClient({
			fetcher: createScriptedFetcher({ [URL_A]: { error } }),
			clock: fixedClock(),
			userAgent: SEC_USER_AGENT,
		});
		const result = await client.fetchDocument(URL_A, REQUEST);
		expect(result).toMatchObject({ ok: false, error: { code, retryable } });
	});
});

describe("CIK normalization", () => {
	it("pads valid identifiers and rejects everything else", () => {
		expect(normalizeCik("320193")).toBe("0000320193");
		expect(normalizeCik("CIK0001067983")).toBe("0001067983");
		expect(normalizeCik(" 9999993 ")).toBe("0009999993");
		for (const bad of ["", "0", "0000000000", "12345678901", "12a", "-5", "../../etc"]) {
			expect(normalizeCik(bad)).toBeNull();
		}
	});
});
