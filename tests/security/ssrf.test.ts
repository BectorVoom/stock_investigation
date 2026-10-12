/**
 * SSRF adversarial suite (SEC-002, hard gate 3). Runs the same hostile cases
 * against both SafeFetcher adapters through scripted transports: no socket is
 * ever opened, and each case asserts not only the typed rejection but that the
 * forbidden destination was never contacted.
 */
import { describe, expect, it } from "vitest";
import { createNodeSafeFetcher } from "../../packages/adapters/src/node/index.ts";
import { createWorkerSafeFetcher } from "../../packages/adapters/src/worker/index.ts";
import {
	createFakeNetwork,
	type DnsAnswer,
	type FakePage,
	PUBLIC_V4,
	PUBLIC_V4_B,
	PUBLIC_V6,
} from "../../packages/adapters/test/node/fakeNetwork.ts";
import { createFakeFetch, type FakeRoute } from "../../packages/adapters/test/worker/fakeFetch.ts";
import type { SafeFetcher, SafeFetchOptions } from "../../packages/application/src/index.ts";

const LIMITS: SafeFetchOptions = { maxBytes: 10_000, timeoutMs: 2_000, accept: "text/html" };

interface Harness {
	readonly fetcher: SafeFetcher;
	/** URLs a request was actually sent for, in order. */
	readonly requested: () => readonly string[];
}

type Pages = { readonly [url: string]: FakePage };

function workerHarness(pages: Pages): Harness {
	const routes: { [url: string]: FakeRoute } = {};
	for (const [url, page] of Object.entries(pages)) {
		routes[url] = () =>
			new Response(page.body ?? null, {
				status: page.status ?? 200,
				headers: page.location === undefined ? {} : { location: page.location },
			});
	}
	const fake = createFakeFetch(routes);
	return { fetcher: createWorkerSafeFetcher(fake.fetch), requested: fake.urls };
}

function nodeHarness(pages: Pages): Harness {
	const network = createFakeNetwork({ pages });
	return {
		fetcher: createNodeSafeFetcher(network),
		requested: () =>
			network.connections.map((connection) => `https://${connection.hostname}${connection.path}`),
	};
}

const ADAPTERS: readonly (readonly [string, (pages: Pages) => Harness])[] = [
	["worker adapter", workerHarness],
	["node adapter", nodeHarness],
];

const START = "https://news.synthetic-wire.org/start";

describe.each(ADAPTERS)("SSRF policy shared by both adapters: %s", (_name, harness) => {
	const forbiddenTargets: readonly (readonly [string, string])[] = [
		["http://news.synthetic-wire.org/", "SCHEME_NOT_ALLOWED"],
		["gopher://news.synthetic-wire.org/", "SCHEME_NOT_ALLOWED"],
		["file:///etc/passwd", "SCHEME_NOT_ALLOWED"],
		["https://admin:hunter2@news.synthetic-wire.org/", "CREDENTIALS_NOT_ALLOWED"],
		["https://news.synthetic-wire.org:22/", "PORT_NOT_ALLOWED"],
		["https://news.synthetic-wire.org:8443/", "PORT_NOT_ALLOWED"],
		["https://127.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://10.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://192.168.0.1/router", "IP_LITERAL_NOT_ALLOWED"],
		["https://169.254.169.254/latest/meta-data/iam/", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::1]/", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::ffff:10.0.0.1]/", "IP_LITERAL_NOT_ALLOWED"],
		["https://0x7f.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://0177.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://2130706433/", "IP_LITERAL_NOT_ALLOWED"],
		["https://127.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://8.8.8.8/", "IP_LITERAL_NOT_ALLOWED"],
		["https://localhost/", "HOSTNAME_NOT_ALLOWED"],
		["https://LOCALHOST./", "HOSTNAME_NOT_ALLOWED"],
		["https://nas/", "HOSTNAME_NOT_ALLOWED"],
		["https://printer.local/", "HOSTNAME_NOT_ALLOWED"],
		["https://router.lan/", "HOSTNAME_NOT_ALLOWED"],
		["https://build.corp/", "HOSTNAME_NOT_ALLOWED"],
		["https://metadata.internal/", "HOSTNAME_NOT_ALLOWED"],
		["https://hidden.onion/", "HOSTNAME_NOT_ALLOWED"],
		["//news.synthetic-wire.org/", "MALFORMED_URL"],
		["", "MALFORMED_URL"],
	];

	it.each(forbiddenTargets)("refuses target %s (%s) with no request", async (url, detail) => {
		const { fetcher, requested } = harness({});
		expect(await fetcher.fetchText(url, LIMITS)).toEqual({
			ok: false,
			error: { code: "UNSAFE_URL", detail },
		});
		expect(requested()).toEqual([]);
	});

	it("refuses an over-long URL", async () => {
		const { fetcher, requested } = harness({});
		const url = `https://news.synthetic-wire.org/${"a".repeat(2100)}`;
		expect(await fetcher.fetchText(url, LIMITS)).toEqual({
			ok: false,
			error: { code: "UNSAFE_URL", detail: "URL_TOO_LONG" },
		});
		expect(requested()).toEqual([]);
	});

	const forbiddenRedirects: readonly (readonly [string, string])[] = [
		["http://news.synthetic-wire.org/downgrade", "SCHEME_NOT_ALLOWED"],
		["https://127.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://10.0.0.1/", "IP_LITERAL_NOT_ALLOWED"],
		["https://169.254.169.254/latest/meta-data/", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::1]/", "IP_LITERAL_NOT_ALLOWED"],
		["https://[::ffff:192.168.1.1]/", "IP_LITERAL_NOT_ALLOWED"],
		["//10.0.0.1/protocol-relative", "IP_LITERAL_NOT_ALLOWED"],
		["https://localhost/", "HOSTNAME_NOT_ALLOWED"],
		["https://nas.local/share", "HOSTNAME_NOT_ALLOWED"],
		["https://intranet/", "HOSTNAME_NOT_ALLOWED"],
		["https://news.synthetic-wire.org:6379/", "PORT_NOT_ALLOWED"],
		["https://u:p@news.synthetic-wire.org/", "CREDENTIALS_NOT_ALLOWED"],
		["file:///etc/shadow", "SCHEME_NOT_ALLOWED"],
		["javascript:alert(1)", "SCHEME_NOT_ALLOWED"],
		["data:text/html,hi", "SCHEME_NOT_ALLOWED"],
	];

	it.each(
		forbiddenRedirects,
	)("refuses a redirect to %s (%s) and never requests it", async (location, reason) => {
		const { fetcher, requested } = harness({ [START]: { status: 302, location } });
		expect(await fetcher.fetchText(START, LIMITS)).toEqual({
			ok: false,
			error: { code: "UNSAFE_REDIRECT", detail: `redirect 1 rejected: ${reason}` },
		});
		expect(requested()).toEqual([START]);
	});

	it("refuses an unsafe redirect on a later hop, after safe ones", async () => {
		const second = "https://cdn.synthetic-wire.org/second";
		const { fetcher, requested } = harness({
			[START]: { status: 301, location: second },
			[second]: { status: 307, location: "https://192.168.1.1/" },
		});
		expect(await fetcher.fetchText(START, LIMITS)).toEqual({
			ok: false,
			error: { code: "UNSAFE_REDIRECT", detail: "redirect 2 rejected: IP_LITERAL_NOT_ALLOWED" },
		});
		expect(requested()).toEqual([START, second]);
	});

	it("enforces the allowlist on the first hop", async () => {
		const { fetcher, requested } = harness({ [START]: { body: "must not be read" } });
		const result = await fetcher.fetchText(START, {
			...LIMITS,
			allowedHosts: new Set(["www.sec.gov", "data.sec.gov"]),
		});
		expect(result).toMatchObject({ ok: false, error: { code: "HOST_NOT_ALLOWED" } });
		expect(requested()).toEqual([]);
	});

	it("treats an empty allowlist as allowing nothing", async () => {
		const { fetcher, requested } = harness({ [START]: { body: "must not be read" } });
		const result = await fetcher.fetchText(START, { ...LIMITS, allowedHosts: new Set() });
		expect(result).toMatchObject({ ok: false, error: { code: "HOST_NOT_ALLOWED" } });
		expect(requested()).toEqual([]);
	});

	it("enforces the allowlist on every redirect hop", async () => {
		const offList = "https://tracker.synthetic-attacker.org/collect";
		const { fetcher, requested } = harness({
			[START]: { status: 302, location: offList },
			[offList]: { body: "must not be read" },
		});
		const result = await fetcher.fetchText(START, {
			...LIMITS,
			allowedHosts: new Set(["news.synthetic-wire.org"]),
		});
		expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_REDIRECT" } });
		expect(requested()).toEqual([START]);
	});

	it("stops redirect loops", async () => {
		const other = "https://news.synthetic-wire.org/other";
		const { fetcher, requested } = harness({
			[START]: { status: 302, location: other },
			[other]: { status: 302, location: START },
		});
		expect(await fetcher.fetchText(START, LIMITS)).toMatchObject({
			ok: false,
			error: { code: "TOO_MANY_REDIRECTS" },
		});
		expect(requested()).toEqual([START, other]);
	});

	it("stops a self-redirect after one request", async () => {
		const { fetcher, requested } = harness({ [START]: { status: 302, location: START } });
		expect(await fetcher.fetchText(START, LIMITS)).toMatchObject({
			ok: false,
			error: { code: "TOO_MANY_REDIRECTS" },
		});
		expect(requested()).toEqual([START]);
	});

	it("follows at most five redirects", async () => {
		const pages: { [url: string]: FakePage } = {};
		for (let hop = 0; hop < 20; hop += 1) {
			pages[`https://news.synthetic-wire.org/hop${hop}`] = {
				status: 302,
				location: `/hop${hop + 1}`,
			};
		}
		const { fetcher, requested } = harness(pages);
		expect(await fetcher.fetchText("https://news.synthetic-wire.org/hop0", LIMITS)).toEqual({
			ok: false,
			error: { code: "TOO_MANY_REDIRECTS", detail: "more than 5 redirects" },
		});
		// The original request plus five redirects; hop6 is never requested.
		expect(requested()).toHaveLength(6);
	});

	it("returns the document for a safe redirect chain", async () => {
		const final = "https://www.synthetic-wire.org/article";
		const { fetcher } = harness({
			[START]: { status: 308, location: final },
			[final]: { body: "<p>article</p>" },
		});
		expect(await fetcher.fetchText(START, LIMITS)).toMatchObject({
			ok: true,
			value: { finalUrl: final, text: "<p>article</p>" },
		});
	});
});

describe("SSRF at the DNS/connection layer: node adapter", () => {
	const HOST = "innocent.synthetic-wire.org";
	const URL_UNDER_TEST = `https://${HOST}/feed`;

	const privateAnswers: readonly (readonly [string, DnsAnswer, string])[] = [
		["loopback 127.0.0.1", [{ address: "127.0.0.1", family: 4 }], "non-public"],
		["loopback 127.8.8.8", [{ address: "127.8.8.8", family: 4 }], "non-public"],
		["RFC 1918 10.x", [{ address: "10.20.30.40", family: 4 }], "non-public"],
		["RFC 1918 172.16.x", [{ address: "172.16.0.1", family: 4 }], "non-public"],
		["RFC 1918 192.168.x", [{ address: "192.168.1.1", family: 4 }], "non-public"],
		["cloud metadata 169.254.169.254", [{ address: "169.254.169.254", family: 4 }], "non-public"],
		["CGNAT 100.64.x", [{ address: "100.64.0.1", family: 4 }], "non-public"],
		["unspecified 0.0.0.0", [{ address: "0.0.0.0", family: 4 }], "non-public"],
		["broadcast", [{ address: "255.255.255.255", family: 4 }], "non-public"],
		["IPv6 loopback ::1", [{ address: "::1", family: 6 }], "non-public"],
		["IPv6 unspecified ::", [{ address: "::", family: 6 }], "non-public"],
		["IPv4-mapped ::ffff:10.0.0.1", [{ address: "::ffff:10.0.0.1", family: 6 }], "non-public"],
		["IPv4-mapped hex ::ffff:7f00:1", [{ address: "::ffff:7f00:1", family: 6 }], "non-public"],
		["unique local fd00::/8", [{ address: "fd12:3456:789a::1", family: 6 }], "non-public"],
		["link-local fe80::/10", [{ address: "fe80::1", family: 6 }], "non-public"],
		["link-local with zone", [{ address: "fe80::1%en0", family: 6 }], "non-public"],
		["NAT64 of 10.0.0.1", [{ address: "64:ff9b::a00:1", family: 6 }], "non-public"],
		["6to4 of 192.168.0.1", [{ address: "2002:c0a8:1::1", family: 6 }], "non-public"],
		["unparseable answer", [{ address: "not-an-ip", family: 4 }], "invalid"],
		["octal-looking answer", [{ address: "0177.0.0.1", family: 4 }], "invalid"],
	];

	it.each(
		privateAnswers,
	)("refuses a public-looking name that resolves to %s, with no connection attempt", async (_label, answer, addressClass) => {
		const network = createFakeNetwork({
			dns: { [HOST]: answer },
			pages: { [URL_UNDER_TEST]: { body: "internal service response" } },
		});
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(result).toEqual({
			ok: false,
			error: { code: "UNSAFE_URL", detail: `host resolves to a ${addressClass} address` },
		});
		expect(network.connections).toHaveLength(0);
		expect(network.lookups).toEqual([HOST]);
	});

	it("never echoes the internal address in the error", async () => {
		const network = createFakeNetwork({ dns: { [HOST]: [{ address: "10.99.88.77", family: 4 }] } });
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(JSON.stringify(result)).not.toContain("10.99.88.77");
	});

	it.each([
		["public first, private second", [PUBLIC_V4, { address: "10.0.0.1", family: 4 } as const]],
		["private first, public second", [{ address: "127.0.0.1", family: 4 } as const, PUBLIC_V4]],
		["public IPv4 with loopback IPv6", [PUBLIC_V4, { address: "::1", family: 6 } as const]],
		[
			"many public, one metadata",
			[PUBLIC_V4, PUBLIC_V4_B, PUBLIC_V6, { address: "169.254.169.254", family: 4 } as const],
		],
	])("refuses mixed DNS answers (%s) with no connection attempt", async (_label, answer) => {
		const network = createFakeNetwork({
			dns: { [HOST]: answer },
			pages: { [URL_UNDER_TEST]: { body: "x" } },
		});
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_URL" } });
		expect(network.connections).toHaveLength(0);
	});

	it("DNS rebinding: the connection uses the address that was validated, and the name is resolved once", async () => {
		let lookupCount = 0;
		const network = createFakeNetwork({
			dns: {
				[HOST]: () => {
					lookupCount += 1;
					// First answer public (passes validation); every later answer points inward.
					return lookupCount === 1 ? [PUBLIC_V4] : [{ address: "127.0.0.1", family: 4 }];
				},
			},
			pages: { [URL_UNDER_TEST]: { body: "public content" } },
		});
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(result).toMatchObject({ ok: true, value: { text: "public content" } });
		expect(lookupCount).toBe(1);
		expect(network.connectedAddresses()).toEqual([PUBLIC_V4.address]);
	});

	it("DNS rebinding across a redirect: the re-resolved private answer is refused, never connected", async () => {
		let lookupCount = 0;
		const next = `https://${HOST}/next`;
		const network = createFakeNetwork({
			dns: {
				[HOST]: () => {
					lookupCount += 1;
					return lookupCount === 1 ? [PUBLIC_V4] : [{ address: "192.168.1.1", family: 4 }];
				},
			},
			pages: {
				[URL_UNDER_TEST]: { status: 302, location: next },
				[next]: { body: "router admin page" },
			},
		});
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(result).toEqual({
			ok: false,
			error: {
				code: "UNSAFE_REDIRECT",
				detail: "redirect 1 rejected: host resolves to a non-public address",
			},
		});
		expect(lookupCount).toBe(2);
		expect(network.connectedAddresses()).toEqual([PUBLIC_V4.address]);
	});

	it("DNS rebinding in the other direction: a first private answer is final for that request", async () => {
		let lookupCount = 0;
		const network = createFakeNetwork({
			dns: {
				[HOST]: () => {
					lookupCount += 1;
					return lookupCount === 1 ? [{ address: "10.0.0.1", family: 4 }] : [PUBLIC_V4];
				},
			},
			pages: { [URL_UNDER_TEST]: { body: "x" } },
		});
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_URL" } });
		expect(network.connections).toHaveLength(0);
	});

	it("refuses a redirect to a public-looking name that resolves inward", async () => {
		const inward = "https://cdn.synthetic-attacker.org/payload";
		const network = createFakeNetwork({
			dns: { "cdn.synthetic-attacker.org": [{ address: "169.254.169.254", family: 4 }] },
			pages: {
				[URL_UNDER_TEST]: { status: 302, location: inward },
				[inward]: { body: "metadata credentials" },
			},
		});
		const result = await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(result).toMatchObject({ ok: false, error: { code: "UNSAFE_REDIRECT" } });
		expect(network.connections.map((connection) => connection.hostname)).toEqual([HOST]);
	});

	it("does not resolve a name the string policy or the allowlist already rejected", async () => {
		const network = createFakeNetwork({});
		const fetcher = createNodeSafeFetcher(network);
		await fetcher.fetchText("https://printer.local/", LIMITS);
		await fetcher.fetchText(URL_UNDER_TEST, { ...LIMITS, allowedHosts: new Set(["www.sec.gov"]) });
		expect(network.lookups).toEqual([]);
		expect(network.connections).toHaveLength(0);
	});

	it("connects only to addresses from the validated answer, keeping the host name for TLS", async () => {
		const network = createFakeNetwork({
			dns: { [HOST]: [PUBLIC_V6, PUBLIC_V4] },
			pages: { [URL_UNDER_TEST]: { body: "ok" } },
		});
		await createNodeSafeFetcher(network).fetchText(URL_UNDER_TEST, LIMITS);
		expect(network.connections).toHaveLength(1);
		expect(network.connections[0]).toMatchObject({
			hostname: HOST,
			address: PUBLIC_V6,
			path: "/feed",
		});
	});
});
