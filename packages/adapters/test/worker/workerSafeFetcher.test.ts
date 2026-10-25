import { describe, expect, it } from "vitest";
import { createWorkerSafeFetcher } from "../../src/worker/index.ts";
import { DEFAULT_USER_AGENT, MAX_REDIRECT_HOPS } from "../../src/worker/safeFetchCore.ts";
import {
	chunkedBody,
	createFakeFetch,
	FETCH_LIMITS,
	redirectTo,
	stallingBody,
	status,
	text,
} from "./fakeFetch.ts";

const encoder = new TextEncoder();

describe("worker SafeFetcher: request shape", () => {
	it("fetches text with GET, manual redirects and no credentials", async () => {
		const fake = createFakeFetch({
			"https://feeds.synthetic-wire.org/rss.xml": text("<rss/>", {
				"content-type": "application/rss+xml; charset=utf-8",
			}),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://feeds.synthetic-wire.org/rss.xml",
			{ ...FETCH_LIMITS, accept: "application/rss+xml" },
		);
		expect(result).toEqual({
			ok: true,
			value: {
				finalUrl: "https://feeds.synthetic-wire.org/rss.xml",
				contentType: "application/rss+xml; charset=utf-8",
				text: "<rss/>",
			},
		});
		expect(fake.calls).toHaveLength(1);
		const [call] = fake.calls;
		expect(call?.method).toBe("GET");
		expect(call?.redirect).toBe("manual");
		expect(call?.headers).toEqual({
			accept: "application/rss+xml",
			"user-agent": DEFAULT_USER_AGENT,
		});
	});

	it("sends a caller-supplied User-Agent and refuses one that could inject headers", async () => {
		const fake = createFakeFetch({ "https://data.synthetic-wire.org/a": text("ok") });
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		const identified = {
			...FETCH_LIMITS,
			userAgent: "Synthetic Research admin@synthetic-wire.org",
		};
		expect((await fetcher.fetchText("https://data.synthetic-wire.org/a", identified)).ok).toBe(
			true,
		);
		expect(fake.calls[0]?.headers["user-agent"]).toBe(
			"Synthetic Research admin@synthetic-wire.org",
		);

		const injected = {
			...FETCH_LIMITS,
			userAgent: "x\r\nCookie: session=1",
		};
		const refused = await fetcher.fetchText("https://data.synthetic-wire.org/a", injected);
		expect(refused).toMatchObject({ ok: false, error: { code: "NETWORK_ERROR" } });
		expect(fake.calls).toHaveLength(1);
	});

	it("decodes UTF-8 split across chunks and strips a BOM", async () => {
		const bytes = encoder.encode("﻿受注が拡大 ✓");
		const body = chunkedBody([bytes.slice(0, 5), bytes.slice(5, 9), bytes.slice(9)]);
		const fake = createFakeFetch({
			"https://news.synthetic-keizai.org/a": () => new Response(body.stream),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://news.synthetic-keizai.org/a",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({ ok: true, value: { text: "受注が拡大 ✓", contentType: null } });
	});

	it("returns empty text for a bodiless success", async () => {
		const fake = createFakeFetch({
			"https://news.synthetic-wire.org/empty": () => new Response(null, { status: 204 }),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://news.synthetic-wire.org/empty",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({ ok: true, value: { text: "" } });
	});
});

describe("worker SafeFetcher: URL policy and allowlist on the first hop", () => {
	const cases: readonly (readonly [string, string])[] = [
		["http://news.synthetic-wire.org/", "SCHEME_NOT_ALLOWED"],
		["ftp://news.synthetic-wire.org/", "SCHEME_NOT_ALLOWED"],
		["file:///etc/passwd", "SCHEME_NOT_ALLOWED"],
		["https://user:secret@news.synthetic-wire.org/", "CREDENTIALS_NOT_ALLOWED"],
		["https://news.synthetic-wire.org:8443/", "PORT_NOT_ALLOWED"],
		["https://127.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::1]/", "IP_LITERAL_NOT_ALLOWED"],
		["https://2130706433/", "IP_LITERAL_NOT_ALLOWED"],
		["https://169.254.169.254/latest/meta-data/", "IP_LITERAL_NOT_ALLOWED"],
		["https://localhost/", "HOSTNAME_NOT_ALLOWED"],
		["https://router.lan/", "HOSTNAME_NOT_ALLOWED"],
		["https://nas.local/", "HOSTNAME_NOT_ALLOWED"],
		["https://intranet/", "HOSTNAME_NOT_ALLOWED"],
		["not a url", "MALFORMED_URL"],
	];
	for (const [url, detail] of cases) {
		it(`rejects ${url} without fetching`, async () => {
			const fake = createFakeFetch({});
			const result = await createWorkerSafeFetcher(fake.fetch).fetchText(url, FETCH_LIMITS);
			expect(result).toEqual({ ok: false, error: { code: "UNSAFE_URL", detail } });
			expect(fake.calls).toHaveLength(0);
		});
	}

	it("rejects a host outside the allowlist without fetching", async () => {
		const fake = createFakeFetch({ "https://other.synthetic-wire.org/": text("no") });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://other.synthetic-wire.org/",
			{ ...FETCH_LIMITS, allowedHosts: new Set(["news.synthetic-wire.org"]) },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "HOST_NOT_ALLOWED" } });
		expect(fake.calls).toHaveLength(0);
	});

	it("matches the allowlist case-insensitively and ignores a trailing dot", async () => {
		const fake = createFakeFetch({ "https://news.synthetic-wire.org./a": text("yes") });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://NEWS.synthetic-wire.org./a",
			{ ...FETCH_LIMITS, allowedHosts: new Set(["News.Synthetic-Wire.org"]) },
		);
		expect(result).toMatchObject({ ok: true, value: { text: "yes" } });
	});

	it("does not treat a look-alike suffix or subdomain as allowed", async () => {
		const fake = createFakeFetch({});
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		const allowedHosts = new Set(["synthetic-wire.org"]);
		for (const url of [
			"https://evil-synthetic-wire.org/",
			"https://synthetic-wire.org.attacker-synthetic.org/",
			"https://sub.synthetic-wire.org/",
		]) {
			const result = await fetcher.fetchText(url, { ...FETCH_LIMITS, allowedHosts });
			expect(result).toMatchObject({ ok: false, error: { code: "HOST_NOT_ALLOWED" } });
		}
		expect(fake.calls).toHaveLength(0);
	});
});

describe("worker SafeFetcher: redirects", () => {
	it("follows relative and cross-host redirects, validating each hop", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/start": redirectTo("/moved?x=1", 301),
			"https://a.synthetic-wire.org/moved?x=1": redirectTo(
				"https://b.synthetic-wire.org/final",
				307,
			),
			"https://b.synthetic-wire.org/final": text("arrived"),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/start",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({
			ok: true,
			value: { finalUrl: "https://b.synthetic-wire.org/final", text: "arrived" },
		});
		expect(fake.urls()).toEqual([
			"https://a.synthetic-wire.org/start",
			"https://a.synthetic-wire.org/moved?x=1",
			"https://b.synthetic-wire.org/final",
		]);
		expect(fake.calls.every((call) => call.redirect === "manual")).toBe(true);
	});

	const unsafeTargets: readonly (readonly [string, string])[] = [
		["http://a.synthetic-wire.org/plain", "SCHEME_NOT_ALLOWED"],
		["https://10.0.0.5/admin", "IP_LITERAL_NOT_ALLOWED"],
		["https://[fd00::1]/", "IP_LITERAL_NOT_ALLOWED"],
		["//169.254.169.254/latest/meta-data/", "IP_LITERAL_NOT_ALLOWED"],
		["https://printer.local/", "HOSTNAME_NOT_ALLOWED"],
		["https://localhost/", "HOSTNAME_NOT_ALLOWED"],
		["https://a.synthetic-wire.org:8080/", "PORT_NOT_ALLOWED"],
		["https://u:p@a.synthetic-wire.org/", "CREDENTIALS_NOT_ALLOWED"],
		["file:///etc/passwd", "SCHEME_NOT_ALLOWED"],
		["https://", "MALFORMED_URL"],
	];
	for (const [location, reason] of unsafeTargets) {
		it(`refuses a redirect to ${location} and never requests it`, async () => {
			const fake = createFakeFetch({
				"https://a.synthetic-wire.org/start": redirectTo(location),
			});
			const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
				"https://a.synthetic-wire.org/start",
				FETCH_LIMITS,
			);
			expect(result).toEqual({
				ok: false,
				error: { code: "UNSAFE_REDIRECT", detail: `redirect 1 rejected: ${reason}` },
			});
			expect(fake.urls()).toEqual(["https://a.synthetic-wire.org/start"]);
		});
	}

	it("refuses a redirect that leaves the allowlist, even on a later hop", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/start": redirectTo("https://a.synthetic-wire.org/second"),
			"https://a.synthetic-wire.org/second": redirectTo("https://b.synthetic-wire.org/final"),
			"https://b.synthetic-wire.org/final": text("must not be read"),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/start",
			{ ...FETCH_LIMITS, allowedHosts: new Set(["a.synthetic-wire.org"]) },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_REDIRECT" } });
		expect(fake.urls()).toEqual([
			"https://a.synthetic-wire.org/start",
			"https://a.synthetic-wire.org/second",
		]);
	});

	it("stops a redirect loop", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/one": redirectTo("https://a.synthetic-wire.org/two"),
			"https://a.synthetic-wire.org/two": redirectTo("https://a.synthetic-wire.org/one"),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/one",
			FETCH_LIMITS,
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "TOO_MANY_REDIRECTS", detail: "redirect loop" },
		});
		expect(fake.calls).toHaveLength(2);
	});

	function chain(length: number) {
		const routes: { [url: string]: ReturnType<typeof text> } = {};
		for (let hop = 0; hop < length; hop += 1) {
			routes[`https://a.synthetic-wire.org/hop${hop}`] = redirectTo(`/hop${hop + 1}`);
		}
		routes[`https://a.synthetic-wire.org/hop${length}`] = text("end of chain");
		return createFakeFetch(routes);
	}

	it(`follows exactly ${MAX_REDIRECT_HOPS} redirects`, async () => {
		const fake = chain(MAX_REDIRECT_HOPS);
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/hop0",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({ ok: true, value: { text: "end of chain" } });
		expect(fake.calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
	});

	it(`gives up on redirect ${MAX_REDIRECT_HOPS + 1} without requesting it`, async () => {
		const fake = chain(MAX_REDIRECT_HOPS + 1);
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/hop0",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "TOO_MANY_REDIRECTS" } });
		expect(fake.calls).toHaveLength(MAX_REDIRECT_HOPS + 1);
		expect(fake.urls()).not.toContain(`https://a.synthetic-wire.org/hop${MAX_REDIRECT_HOPS + 1}`);
	});

	it("reports a redirect status without a Location as an HTTP error", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/start": () => new Response(null, { status: 302 }),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/start",
			FETCH_LIMITS,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "HTTP_ERROR" } });
	});

	it("consults authorizeRedirect before each redirect hop and stops on refusal", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/start": redirectTo("https://b.synthetic-wire.org/mid"),
			"https://b.synthetic-wire.org/mid": redirectTo("https://c.synthetic-wire.org/final"),
			"https://c.synthetic-wire.org/final": text("must not be read"),
		});
		const seen: string[] = [];
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/start",
			{
				...FETCH_LIMITS,
				authorizeRedirect: async (url) => {
					seen.push(url);
					return !url.includes("c.synthetic-wire.org");
				},
			},
		);
		expect(result).toMatchObject({ ok: false, error: { code: "REDIRECT_NOT_AUTHORIZED" } });
		// The refused hop is never contacted; the callback saw both redirect URLs.
		expect(seen).toEqual([
			"https://b.synthetic-wire.org/mid",
			"https://c.synthetic-wire.org/final",
		]);
		expect(fake.urls()).toEqual([
			"https://a.synthetic-wire.org/start",
			"https://b.synthetic-wire.org/mid",
		]);
	});

	it("treats a throwing authorizeRedirect as a refusal (fail closed)", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/start": redirectTo("https://b.synthetic-wire.org/mid"),
			"https://b.synthetic-wire.org/mid": text("must not be read"),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/start",
			{
				...FETCH_LIMITS,
				authorizeRedirect: async () => {
					throw new Error("robots store unavailable");
				},
			},
		);
		expect(result).toMatchObject({ ok: false, error: { code: "REDIRECT_NOT_AUTHORIZED" } });
		expect(fake.urls()).toEqual(["https://a.synthetic-wire.org/start"]);
	});

	it("never calls authorizeRedirect for a direct (non-redirect) fetch", async () => {
		const fake = createFakeFetch({ "https://a.synthetic-wire.org/only": text("direct") });
		let calls = 0;
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/only",
			{
				...FETCH_LIMITS,
				authorizeRedirect: async () => {
					calls += 1;
					return true;
				},
			},
		);
		expect(result).toMatchObject({ ok: true });
		expect(calls).toBe(0);
	});
});

describe("worker SafeFetcher: size, time and failure limits", () => {
	it("rejects a declared Content-Length above the limit without reading the body", async () => {
		const body = chunkedBody([encoder.encode("x".repeat(100))]);
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/big": () =>
				new Response(body.stream, { headers: { "content-length": "50001" } }),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/big",
			{ ...FETCH_LIMITS, maxBytes: 50_000 },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
		expect(body.pulled()).toBe(0);
	});

	it("stops streaming an undeclared oversized body at the limit", async () => {
		const chunk = encoder.encode("y".repeat(400));
		const body = chunkedBody(Array.from({ length: 1000 }, () => chunk));
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/stream": () => new Response(body.stream),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/stream",
			{ ...FETCH_LIMITS, maxBytes: 1_000 },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } });
		// 1000 bytes fit in two and a half chunks; the other ~997 chunks were never pulled.
		expect(body.pulled()).toBeLessThanOrEqual(4);
		expect(body.cancelled()).toBe(true);
	});

	it("accepts a body of exactly the limit", async () => {
		const fake = createFakeFetch({ "https://a.synthetic-wire.org/exact": text("z".repeat(1_000)) });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/exact",
			{ ...FETCH_LIMITS, maxBytes: 1_000 },
		);
		expect(result.ok).toBe(true);
	});

	it("times out on a body that stalls", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/slow": (call) => new Response(stallingBody(call.signal)),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/slow",
			{ ...FETCH_LIMITS, timeoutMs: 40 },
		);
		expect(result).toEqual({
			ok: false,
			error: { code: "TIMEOUT", detail: "no complete response within 40 ms" },
		});
	});

	it("times out even when the transport ignores the abort signal", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/hang": () => new Promise<Response>(() => {}),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/hang",
			{ ...FETCH_LIMITS, timeoutMs: 40 },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
	});

	it("stops when the caller aborts, and does not start when already aborted", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/slow": (call) => new Response(stallingBody(call.signal)),
		});
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		const controller = new AbortController();
		const pending = fetcher.fetchText("https://a.synthetic-wire.org/slow", {
			...FETCH_LIMITS,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 20);
		expect(await pending).toEqual({
			ok: false,
			error: { code: "TIMEOUT", detail: "aborted by the caller" },
		});
		expect(fake.calls[0]?.signal?.aborted).toBe(true);

		const before = fake.calls.length;
		const alreadyAborted = await fetcher.fetchText("https://a.synthetic-wire.org/slow", {
			...FETCH_LIMITS,
			signal: AbortSignal.abort(),
		});
		expect(alreadyAborted).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
		expect(fake.calls).toHaveLength(before);
	});

	for (const code of [400, 401, 403, 404, 429, 500, 503]) {
		it(`reports HTTP ${code} with the status in the detail`, async () => {
			const fake = createFakeFetch({ "https://a.synthetic-wire.org/x": status(code) });
			const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
				"https://a.synthetic-wire.org/x",
				FETCH_LIMITS,
			);
			expect(result).toEqual({
				ok: false,
				error: { code: "HTTP_ERROR", detail: `HTTP ${code}`, status: code },
			});
		});
	}

	it("translates a thrown network error without leaking its message", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/x": () => {
				throw new TypeError("connect ECONNREFUSED 10.1.2.3:443 secret-internal-detail");
			},
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/x",
			FETCH_LIMITS,
		);
		expect(result).toEqual({ ok: false, error: { code: "NETWORK_ERROR", detail: "TypeError" } });
	});

	it("rejects non-positive limits instead of running unbounded", async () => {
		const fake = createFakeFetch({ "https://a.synthetic-wire.org/x": text("ok") });
		const fetcher = createWorkerSafeFetcher(fake.fetch);
		for (const limits of [
			{ maxBytes: 0, timeoutMs: 1000 },
			{ maxBytes: Number.POSITIVE_INFINITY, timeoutMs: 1000 },
			{ maxBytes: 1000, timeoutMs: 0 },
			{ maxBytes: 1000, timeoutMs: Number.NaN },
		]) {
			const result = await fetcher.fetchText("https://a.synthetic-wire.org/x", {
				...limits,
				accept: "text/plain",
			});
			expect(result.ok).toBe(false);
		}
		expect(fake.calls).toHaveLength(0);
	});
});

describe("worker SafeFetcher: Authorization header and error bodies", () => {
	it("sends the Authorization header on the first request only, never on redirects", async () => {
		const fake = createFakeFetch({
			"https://a.synthetic-wire.org/start": redirectTo("https://a.synthetic-wire.org/final"),
			"https://a.synthetic-wire.org/final": text("done"),
		});
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/start",
			{ ...FETCH_LIMITS, authorization: "apikey synthetic-key" },
		);
		expect(result).toMatchObject({ ok: true, value: { text: "done" } });
		expect(fake.calls).toHaveLength(2);
		expect(fake.calls[0]?.headers.authorization).toBe("apikey synthetic-key");
		expect(fake.calls[1]?.headers).not.toHaveProperty("authorization");
	});

	it("sends no Authorization header unless the caller supplies one", async () => {
		const fake = createFakeFetch({ "https://a.synthetic-wire.org/x": text("ok") });
		await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/x",
			FETCH_LIMITS,
		);
		expect(fake.calls[0]?.headers).toEqual({
			accept: "text/plain",
			"user-agent": DEFAULT_USER_AGENT,
		});
	});

	it("refuses an Authorization value that could inject headers, before any request", async () => {
		const fake = createFakeFetch({ "https://a.synthetic-wire.org/x": text("ok") });
		const result = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/x",
			{ ...FETCH_LIMITS, authorization: "apikey bad\r\nCookie: session=1" },
		);
		expect(result).toMatchObject({ ok: false, error: { code: "NETWORK_ERROR" } });
		expect(fake.calls).toHaveLength(0);
	});

	it("attaches the error body only when includeErrorBody is set", async () => {
		const routes = {
			"https://a.synthetic-wire.org/x": () => new Response('{"code":429}', { status: 429 }),
		};
		const without = await createWorkerSafeFetcher(createFakeFetch(routes).fetch).fetchText(
			"https://a.synthetic-wire.org/x",
			FETCH_LIMITS,
		);
		expect(without).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429 },
		});

		const fake = createFakeFetch(routes);
		const withBody = await createWorkerSafeFetcher(fake.fetch).fetchText(
			"https://a.synthetic-wire.org/x",
			{ ...FETCH_LIMITS, includeErrorBody: true },
		);
		expect(withBody).toEqual({
			ok: false,
			error: { code: "HTTP_ERROR", detail: "HTTP 429", status: 429, body: '{"code":429}' },
		});
	});
});
