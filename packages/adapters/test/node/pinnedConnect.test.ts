import { createServer, type Server } from "node:https";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	buildPinnedRequestOptions,
	createPinnedHttpsConnect,
	isSameIpAddress,
	type PinnedRequest,
	type PinnedResponse,
} from "../../src/node/pinnedConnect.ts";
import { ResponseBodyTooLargeError } from "../../src/worker/safeFetchCore.ts";
import { createSelfSignedCertificate } from "./selfSignedCert.ts";

const HOSTNAME = "pinned.synthetic-wire.org";
const LOOPBACK = { address: "127.0.0.1", family: 4 } as const;

function pinnedRequest(overrides: Partial<PinnedRequest> = {}): PinnedRequest {
	return {
		hostname: HOSTNAME,
		address: LOOPBACK,
		path: "/echo?x=1",
		headers: { accept: "text/plain", "user-agent": "pinned-connect-test" },
		maxEncodedBytes: 1_000_000,
		signal: new AbortController().signal,
		...overrides,
	};
}

async function readAll(response: PinnedResponse): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of response.body) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf8");
}

describe("pinned request options (production defaults)", () => {
	const options = buildPinnedRequestOptions(
		pinnedRequest({ address: { address: "93.184.216.34", family: 4 } }),
	);

	it("connects to the validated IP literal, not the host name", () => {
		expect(options.host).toBe("93.184.216.34");
		expect(options.family).toBe(4);
		expect(options.hostname).toBeUndefined();
		expect(options.port).toBe(443);
	});

	it("verifies TLS against the host name and keeps verification on", () => {
		expect(options.servername).toBe(HOSTNAME);
		expect(options.rejectUnauthorized).toBe(true);
		expect(options.ca).toBeUndefined();
		expect(options).not.toHaveProperty("checkServerIdentity");
	});

	it("sends the host name as Host, GET only, without credentials or pooling", () => {
		expect(options.method).toBe("GET");
		expect(options.agent).toBe(false);
		expect(options.headers).toEqual({
			host: HOSTNAME,
			accept: "text/plain",
			"user-agent": "pinned-connect-test",
			"accept-encoding": "gzip",
		});
	});

	it("refuses any DNS lookup Node might attempt for this request", async () => {
		const error = await new Promise<unknown>((resolve) => {
			options.lookup?.("anything.synthetic-wire.org", {}, (lookupError) => resolve(lookupError));
		});
		expect(error).toMatchObject({ code: "DNS_LOOKUP_FORBIDDEN" });
	});
});

describe("peer address comparison", () => {
	it("accepts the same address in a different spelling only", () => {
		expect(isSameIpAddress("93.184.216.34", "93.184.216.34")).toBe(true);
		expect(isSameIpAddress("2606:2800:220:1:0:0:0:1", "2606:2800:220:1::1")).toBe(true);
		expect(isSameIpAddress("2606:2800:220:1::1", "2606:2800:0220:0001:0000:0000:0000:0001")).toBe(
			true,
		);
		expect(isSameIpAddress("93.184.216.35", "93.184.216.34")).toBe(false);
		expect(isSameIpAddress("127.0.0.1", "93.184.216.34")).toBe(false);
		expect(isSameIpAddress(undefined, "93.184.216.34")).toBe(false);
		expect(isSameIpAddress("not-an-ip", "not-an-ip")).toBe(false);
	});
});

describe("pinned HTTPS connection against a local TLS server", () => {
	const trusted = createSelfSignedCertificate([HOSTNAME]);
	let server: Server;
	let port = 0;
	const seen: {
		servername: string | false;
		host: string | undefined;
		url: string | undefined;
		cookie: string | undefined;
	}[] = [];

	beforeAll(async () => {
		server = createServer({ key: trusted.keyPem, cert: trusted.certPem }, (request, response) => {
			const socket = request.socket;
			seen.push({
				servername:
					"servername" in socket && typeof socket.servername === "string"
						? socket.servername
						: false,
				host: request.headers.host,
				url: request.url,
				cookie: request.headers.cookie,
			});
			if (request.url === "/gzip") {
				response.writeHead(200, { "content-encoding": "gzip", "content-type": "application/json" });
				response.end(gzipSync('{"compressed":true}'));
			} else if (request.url === "/gzip-empty-members") {
				response.writeHead(200, { "content-encoding": "gzip" });
				response.end(Buffer.concat(Array.from({ length: 500 }, () => gzipSync(""))));
			} else if (request.url === "/weird-encoding") {
				response.writeHead(200, { "content-encoding": "zstd" });
				response.end("opaque");
			} else if (request.url === "/missing") {
				response.writeHead(404, { "content-encoding": "zstd" });
				response.end("not found page");
			} else {
				response.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
				response.end("hello");
			}
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("no TCP address");
		port = address.port;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it("reaches the pinned address with SNI and Host set to the host name", async () => {
		const connect = createPinnedHttpsConnect({ port, ca: trusted.certPem });
		const response = await connect(pinnedRequest());
		expect(response.statusCode).toBe(200);
		expect(response.contentType).toBe("text/plain");
		expect(response.contentLength).toBe(5);
		expect(await readAll(response)).toBe("hello");
		expect(seen.at(-1)).toEqual({
			servername: HOSTNAME,
			host: HOSTNAME,
			url: "/echo?x=1",
			cookie: undefined,
		});
	});

	it("rejects a certificate that is not valid for the host name", async () => {
		const connect = createPinnedHttpsConnect({ port, ca: trusted.certPem });
		await expect(
			connect(pinnedRequest({ hostname: "other.synthetic-wire.org" })),
		).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
	});

	it("rejects an untrusted certificate when no extra root is supplied", async () => {
		const connect = createPinnedHttpsConnect({ port });
		await expect(connect(pinnedRequest())).rejects.toMatchObject({
			code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY/),
		});
	});

	it("keeps verifying even when NODE_TLS_REJECT_UNAUTHORIZED=0 is set", async () => {
		const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		try {
			const connect = createPinnedHttpsConnect({ port });
			await expect(connect(pinnedRequest())).rejects.toMatchObject({
				code: expect.stringMatching(/SELF_SIGNED|UNABLE_TO_VERIFY/),
			});
		} finally {
			if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
			else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
		}
	});

	it("decodes a gzip body", async () => {
		const connect = createPinnedHttpsConnect({ port, ca: trusted.certPem });
		const response = await connect(pinnedRequest({ path: "/gzip" }));
		expect(await readAll(response)).toBe('{"compressed":true}');
	});

	it("stops reading an encoded body at the encoded-byte ceiling, even when nothing decodes", async () => {
		const connect = createPinnedHttpsConnect({ port, ca: trusted.certPem });
		// 500 empty gzip members: about 10 kB on the wire, zero decoded bytes.
		const response = await connect(
			pinnedRequest({ path: "/gzip-empty-members", maxEncodedBytes: 64 }),
		);
		await expect(readAll(response)).rejects.toBeInstanceOf(ResponseBodyTooLargeError);
		const underLimit = await connect(
			pinnedRequest({ path: "/gzip-empty-members", maxEncodedBytes: 50_000 }),
		);
		expect(await readAll(underLimit)).toBe("");
	});

	it("refuses a content encoding it cannot decode, but only for bodies it would read", async () => {
		const connect = createPinnedHttpsConnect({ port, ca: trusted.certPem });
		await expect(connect(pinnedRequest({ path: "/weird-encoding" }))).rejects.toMatchObject({
			code: "UNSUPPORTED_CONTENT_ENCODING",
		});
		const missing = await connect(pinnedRequest({ path: "/missing" }));
		expect(missing.statusCode).toBe(404);
		expect(await readAll(missing)).toBe("");
		missing.destroy();
	});

	it("aborts with the request signal", async () => {
		const connect = createPinnedHttpsConnect({ port, ca: trusted.certPem });
		await expect(connect(pinnedRequest({ signal: AbortSignal.abort() }))).rejects.toMatchObject({
			name: "AbortError",
		});
	});
});
