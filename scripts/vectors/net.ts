/**
 * Outbound fetch layer (crate `research-net`): the hop loop of
 * `safeFetchCore.ts` replayed over scripted transports, the page archive's
 * file names and bytes, `isSameIpAddress`, and `TextDecoder("utf-8")`.
 *
 * Hop-core cases record everything the core does: each request it hands
 * the transport (URL, host, headers, byte ceiling), each redirect it asks
 * the authorizer about, and the final result. The transport answers from a
 * script that is generated lazily (seeded) and recorded, so the Rust replay
 * sees exactly the answers the TypeScript saw.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline, Readable } from "node:stream";
import {
	brotliCompressSync,
	createBrotliDecompress,
	createGunzip,
	createInflate,
	deflateRawSync,
	deflateSync,
	gzipSync,
	constants as zlibConstants,
} from "node:zlib";
import type { ArchivedPage, SafeFetchOptions } from "@research/application";
import { createFilePageArchive } from "../../packages/adapters/src/node/pageArchive.ts";
import { isSameIpAddress } from "../../packages/adapters/src/node/pinnedConnect.ts";
import { webCryptoHasher } from "../../packages/adapters/src/runtime/index.ts";
import {
	createSafeBinaryFetcher,
	createSafeFetcher,
	type HopOutcome,
	type HopRequest,
	ResponseBodyTooLargeError,
} from "../../packages/adapters/src/worker/safeFetchCore.ts";
import { seededRandom, type VectorExporter, wellFormed } from "./shared.ts";

type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
	const item = items[Math.floor(random() * items.length)];
	if (item === undefined) throw new Error("pick from an empty list");
	return item;
}

function hex(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("hex");
}

/* ---------- TextDecoder ---------- */

const DECODER_EDGES: readonly number[][] = [
	[],
	[0xef, 0xbb, 0xbf],
	[0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf, 0x61],
	[0xef, 0xbb],
	[0x61, 0xef, 0xbb, 0xbf],
	[0xf0, 0x9f, 0x98, 0x41, 0xe2, 0x28, 0xa1, 0xc0, 0xaf, 0xed, 0xa0, 0x80],
	[0xed, 0xbf, 0xbf],
	[0xf4, 0x90, 0x80, 0x80],
	[0xf8, 0x88, 0x80, 0x80, 0x80],
	[0xe0, 0x80, 0xaf],
	[0xc2],
	[0xe3, 0x81],
	[0xf0, 0x9f, 0x98],
	[0xff, 0xfe, 0x00, 0x61],
	[0x00, 0x7f, 0x80, 0xbf],
];

function randomDecoderInput(random: Random): number[] {
	const out: number[] = [];
	if (random() < 0.15) out.push(0xef, 0xbb, 0xbf);
	const length = Math.floor(random() * 24);
	for (let index = 0; index < length; index += 1) {
		const roll = random();
		if (roll < 0.35) {
			out.push(0x20 + Math.floor(random() * 0x5f));
		} else if (roll < 0.6) {
			const codePoint = pick(random, [0xe9, 0x3042, 0x1f600, 0x10ffff, 0xfeff, 0x7ff, 0x800]);
			out.push(...new TextEncoder().encode(String.fromCodePoint(codePoint)));
		} else if (roll < 0.8) {
			out.push(
				pick(
					random,
					[0x80, 0xbf, 0xc0, 0xc1, 0xc2, 0xdf, 0xe0, 0xed, 0xef, 0xf0, 0xf4, 0xf5, 0xff],
				),
			);
		} else {
			out.push(Math.floor(random() * 256));
		}
	}
	return out;
}

function textDecoderCases(): { input: string; output: string }[] {
	const random = seededRandom(0x7e47);
	const inputs = [...DECODER_EDGES];
	for (let index = 0; index < 3_000; index += 1) inputs.push(randomDecoderInput(random));
	return inputs.map((bytes) => {
		const array = new Uint8Array(bytes);
		return { input: hex(array), output: new TextDecoder("utf-8").decode(array) };
	});
}

/* ---------- isSameIpAddress ---------- */

const IP_TEXTS = [
	"93.184.216.34",
	"93.184.216.35",
	"127.0.0.1",
	"0127.0.0.1",
	"1.2.3",
	"256.1.1.1",
	"::1",
	"0:0:0:0:0:0:0:1",
	"::ffff:127.0.0.1",
	"::ffff:7f00:1",
	"2606:2800:220:1::1",
	"2606:2800:220:1:0:0:0:1",
	"2606:2800:0220:0001:0000:0000:0000:0001",
	"2606:2800:220:1::1%en0",
	"fe80::1%en0",
	"fe80::1",
	"[::1]",
	"not-an-ip",
	"",
	" 93.184.216.34",
	"2001:DB8::1",
	"2001:db8::1",
	"::",
	"1::2::3",
];

function sameIpCases(): { input: { actual: string | null; expected: string }; output: boolean }[] {
	const cases: { input: { actual: string | null; expected: string }; output: boolean }[] = [];
	for (const expected of IP_TEXTS) {
		cases.push({ input: { actual: null, expected }, output: isSameIpAddress(undefined, expected) });
		for (const actual of IP_TEXTS) {
			cases.push({ input: { actual, expected }, output: isSameIpAddress(actual, expected) });
		}
	}
	return cases;
}

/* ---------- hop core ---------- */

interface ScriptedResponse {
	readonly kind: "response";
	readonly status: number;
	readonly location: string | null;
	readonly contentType: string | null;
	readonly contentLength: number | null;
	readonly chunks: readonly string[];
	/** After the chunks: `"too-large"`, an error code, or nothing. */
	readonly bodyError: string | null;
}

type ScriptedOutcome =
	| ScriptedResponse
	| { readonly kind: "unsafe-destination"; readonly detail: string }
	| { readonly kind: "network-error"; readonly detail: string };

interface HopOptionsInput {
	readonly maxBytes: number;
	readonly timeoutMs: number;
	readonly accept: string;
	readonly allowedHosts: readonly string[] | null;
	readonly userAgent: string | null;
	readonly authorization: string | null;
	readonly finnhubToken: string | null;
	readonly includeErrorBody: boolean;
	/** Successive authorizer answers (`"throw"` throws); null = no authorizer. */
	readonly authorize: readonly (boolean | "throw")[] | null;
}

interface HopCase {
	readonly input: {
		readonly url: string;
		readonly binary: boolean;
		readonly options: HopOptionsInput;
		readonly script: Record<string, ScriptedOutcome>;
	};
	readonly output: {
		readonly requests: readonly {
			url: string;
			hostname: string;
			accept: string;
			userAgent: string;
			authorization: string | null;
			finnhubToken: string | null;
			maxBytes: number;
		}[];
		readonly authorizeCalls: readonly string[];
		readonly result: unknown;
	};
}

const HOSTS = [
	"a.example.org",
	"b.example.org",
	"News.Example.ORG.",
	"xn--bcher-kva.org",
	"sub.a.example.org",
];
const URL_SHAPES: readonly ((host: string) => string)[] = [
	(host) => `https://${host}/`,
	(host) => `https://${host}/path/to/page?x=1&y=%20z`,
	(host) => `https://${host}/?`,
	(host) => `https://${host}/café?q=ü#frag`,
	(host) => `https://${host}:443/default-port`,
	(host) => `https://${host}/a/../b/./c`,
	(host) => `HTTPS://${host.toUpperCase()}/Upper`,
];
const BAD_URLS = [
	"http://a.example.org/",
	"https://127.0.0.1/",
	"https://[::1]/",
	"https://localhost/",
	"https://a.example.org:8443/",
	"https://u:p@a.example.org/",
	"https://printer.local/",
	"not a url",
	"",
	`https://a.example.org/${"x".repeat(2050)}`,
	"https://intranet/",
	"https://0x7f.1/",
];
const LOCATIONS = [
	"hello",
	"../up",
	"/abs?b=2#c",
	"?only=query",
	"//b.example.org/protocol-relative",
	"https://b.example.org/y",
	"https://B.EXAMPLE.ORG./z",
	"http://b.example.org/plain",
	"https://127.0.0.1/admin",
	"https://[::1]/x",
	"https://a.example.org:8443/port",
	"https://u:p@a.example.org/cred",
	"",
	" /spaced ",
	"https://bad host/",
	"javascript:alert(1)",
	"/café",
	"/Ã©",
	"https://xn--bcher-kva.example/bücher",
	"\t/tab\n",
	"https://a.example.org/",
	"https://a.example.org/?",
	"https://localhost/",
];
const STATUSES = [
	200, 200, 200, 201, 204, 299, 300, 301, 302, 303, 304, 307, 308, 308, 302, 301, 302, 301, 307,
	400, 404, 410, 429, 500, 503, 199, 100,
];
const VALID_HEADER_VALUES = [
	"research-workspace/1.0 (personal research tool)",
	"a".repeat(300),
	"~ printable !",
	"x",
];
const INVALID_HEADER_VALUES = ["", "caf\u00e9", "a".repeat(301), "tab\there", "line\nbreak"];

/** Mostly absent or valid; sometimes a value the header allowlist refuses. */
function randomHeader(random: Random, absent: number): string | null {
	if (random() < 0.04) return pick(random, INVALID_HEADER_VALUES);
	return random() < absent ? null : pick(random, VALID_HEADER_VALUES);
}

function randomBytes(random: Random, length: number): Uint8Array {
	const bytes = new Uint8Array(length);
	for (let index = 0; index < length; index += 1) {
		bytes[index] = random() < 0.7 ? 0x61 + Math.floor(random() * 26) : Math.floor(random() * 256);
	}
	return bytes;
}

function randomOutcome(random: Random, maxBytes: number): ScriptedOutcome {
	const roll = random();
	if (roll < 0.04) {
		return {
			kind: "unsafe-destination",
			detail: pick(random, [
				"host resolves to a non-public address",
				"host resolves to a invalid address",
			]),
		};
	}
	if (roll < 0.08) {
		return {
			kind: "network-error",
			detail: pick(random, [
				"DNS lookup failed: ENOTFOUND",
				"ECONNREFUSED",
				"ERR_TLS_CERT_ALTNAME_INVALID",
				"DNS lookup returned no addresses",
			]),
		};
	}
	const status = pick(random, STATUSES);
	const redirect = [301, 302, 303, 307, 308].includes(status);
	const total = Math.floor(random() * (random() < 0.3 ? maxBytes * 2 + 2 : Math.max(1, maxBytes)));
	const chunks: string[] = [];
	let left = total;
	while (left > 0) {
		const size = Math.min(left, 1 + Math.floor(random() * Math.max(1, total)));
		chunks.push(hex(randomBytes(random, size)));
		left -= size;
	}
	if (random() < 0.1) chunks.push("");
	const lengthRoll = random();
	return {
		kind: "response",
		status,
		location:
			redirect && random() < 0.9 ? pick(random, LOCATIONS) : random() < 0.05 ? "/ignored" : null,
		contentType: pick(random, [null, "text/html; charset=utf-8", "application/json", "TEXT/PLAIN"]),
		contentLength:
			lengthRoll < 0.6
				? null
				: lengthRoll < 0.8
					? total
					: pick(random, [0, maxBytes, maxBytes + 1, total + 5]),
		chunks,
		bodyError: random() < 0.1 ? pick(random, ["too-large", "ECONNRESET", "Z_DATA_ERROR"]) : null,
	};
}

function randomOptions(random: Random): HopOptionsInput {
	const allowed =
		random() < 0.35
			? HOSTS.filter(() => random() < 0.5).map((host) =>
					random() < 0.3 ? `${host.toUpperCase()}.` : host,
				)
			: null;
	return {
		maxBytes: random() < 0.02 ? 0 : pick(random, [1, 10, 64, 200, 1_000, 1_000]),
		timeoutMs: random() < 0.02 ? 0 : 60_000,
		accept: randomHeader(random, 0) ?? "text/plain",
		allowedHosts: allowed,
		userAgent: randomHeader(random, 0.6),
		authorization: randomHeader(random, 0.7),
		finnhubToken: randomHeader(random, 0.7),
		includeErrorBody: random() < 0.3,
		authorize:
			random() < 0.3
				? Array.from({ length: 6 }, () => (random() < 0.15 ? ("throw" as const) : random() < 0.8))
				: null,
	};
}

function toPortOptions(input: HopOptionsInput, authorizeCalls: string[]): SafeFetchOptions {
	let answer = 0;
	return {
		maxBytes: input.maxBytes,
		timeoutMs: input.timeoutMs,
		accept: input.accept,
		...(input.allowedHosts === null ? {} : { allowedHosts: new Set(input.allowedHosts) }),
		...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
		...(input.authorization === null ? {} : { authorization: input.authorization }),
		...(input.finnhubToken === null ? {} : { finnhubToken: input.finnhubToken }),
		...(input.includeErrorBody ? { includeErrorBody: true } : {}),
		...(input.authorize === null
			? {}
			: {
					authorizeRedirect: async (url: string) => {
						authorizeCalls.push(url);
						const next = input.authorize?.[answer] ?? false;
						answer += 1;
						if (next === "throw") throw new Error("authorizer failure");
						return next;
					},
				}),
	};
}

async function runHopCase(
	url: string,
	binary: boolean,
	options: HopOptionsInput,
	nextOutcome: (href: string) => ScriptedOutcome,
	script: Record<string, ScriptedOutcome>,
): Promise<HopCase> {
	const requests: HopCase["output"]["requests"][number][] = [];
	const authorizeCalls: string[] = [];
	const transport = async (request: HopRequest): Promise<HopOutcome> => {
		const href = request.url.href;
		requests.push({
			url: href,
			hostname: request.hostname,
			accept: request.headers.accept,
			userAgent: request.headers["user-agent"],
			authorization: request.headers.authorization,
			finnhubToken: request.headers.finnhubToken,
			maxBytes: request.maxBytes,
		});
		if (!Object.hasOwn(script, href)) script[href] = nextOutcome(href);
		const outcome = script[href];
		if (outcome === undefined || outcome.kind !== "response")
			return outcome ?? { kind: "network-error", detail: "unscripted" };
		const { chunks, bodyError } = outcome;
		return {
			kind: "response",
			status: outcome.status,
			location: outcome.location,
			contentType: outcome.contentType,
			contentLength: outcome.contentLength,
			body: (async function* body() {
				for (const chunk of chunks) yield new Uint8Array(Buffer.from(chunk, "hex"));
				if (bodyError === "too-large") throw new ResponseBodyTooLargeError();
				if (bodyError !== null) throw Object.assign(new Error("body failure"), { code: bodyError });
			})(),
			discard: () => {},
		};
	};
	const portOptions = toPortOptions(options, authorizeCalls);
	let result: unknown;
	if (binary) {
		const fetched = await createSafeBinaryFetcher(transport).fetchBytes(url, portOptions);
		result = fetched.ok
			? {
					ok: true,
					finalUrl: fetched.value.finalUrl,
					contentType: fetched.value.contentType,
					bytes: hex(fetched.value.bytes),
				}
			: { ok: false, ...fetched.error };
	} else {
		const fetched = await createSafeFetcher(transport).fetchText(url, portOptions);
		result = fetched.ok ? { ok: true, ...fetched.value } : { ok: false, ...fetched.error };
	}
	return {
		input: { url: wellFormed(url), binary, options, script },
		output: { requests, authorizeCalls, result },
	};
}

async function hopCoreCases(): Promise<HopCase[]> {
	const random = seededRandom(0x5afe);
	const cases: HopCase[] = [];
	const ok = (body: string, extra: Partial<ScriptedResponse> = {}): ScriptedResponse => ({
		kind: "response",
		status: 200,
		location: null,
		contentType: "text/plain",
		contentLength: null,
		chunks: [Buffer.from(body).toString("hex")],
		bodyError: null,
		...extra,
	});
	const redirectTo = (location: string | null, status = 302): ScriptedResponse => ({
		kind: "response",
		status,
		location,
		contentType: null,
		contentLength: null,
		chunks: [],
		bodyError: null,
	});
	const base: HopOptionsInput = {
		maxBytes: 10_000,
		timeoutMs: 2_000,
		accept: "text/plain",
		allowedHosts: null,
		userAgent: null,
		authorization: null,
		finnhubToken: null,
		includeErrorBody: false,
		authorize: null,
	};
	const fixed: [string, HopOptionsInput, Record<string, ScriptedOutcome>, boolean][] = [
		["https://a.example.org/hello", base, { "https://a.example.org/hello": ok("hello") }, false],
		[
			"https://a.example.org/bom",
			base,
			{ "https://a.example.org/bom": { ...ok(""), chunks: ["efbbbf68c3", "a9ff"] } },
			false,
		],
		[
			"https://a.example.org/to-b",
			{ ...base, allowedHosts: ["a.example.org"] },
			{ "https://a.example.org/to-b": redirectTo("https://b.example.org/hello") },
			false,
		],
		["https://a.example.org/r", base, { "https://a.example.org/r": redirectTo(null, 308) }, false],
		[
			"https://a.example.org/loop",
			base,
			{ "https://a.example.org/loop": redirectTo("/loop") },
			false,
		],
		[
			"https://a.example.org/gone",
			{ ...base, includeErrorBody: true },
			{ "https://a.example.org/gone": { ...ok("gone"), status: 410 } },
			false,
		],
		[
			"https://a.example.org/big",
			{ ...base, maxBytes: 3 },
			{ "https://a.example.org/big": ok("toolarge") },
			true,
		],
		[
			"https://a.example.org/declared",
			{ ...base, maxBytes: 3 },
			{ "https://a.example.org/declared": { ...ok("ab"), contentLength: 4 } },
			true,
		],
		[
			"https://www.jpx.co.jp/start",
			{
				...base,
				allowedHosts: ["www.jpx.co.jp"],
				finnhubToken: "synthetic-key",
				authorization: "apikey k",
			},
			{
				"https://www.jpx.co.jp/start": redirectTo("/final.xlsx"),
				"https://www.jpx.co.jp/final.xlsx": { ...ok(""), chunks: ["504b0304ff0089"] },
			},
			true,
		],
	];
	for (const [url, options, script, binary] of fixed) {
		cases.push(
			await runHopCase(
				url,
				binary,
				options,
				() => ({ kind: "network-error", detail: "unscripted" }),
				{ ...script },
			),
		);
	}
	// Six chained redirects: one too many.
	const chain: Record<string, ScriptedOutcome> = {};
	for (let index = 0; index < 7; index += 1)
		chain[`https://a.example.org/${index}`] = redirectTo(`/${index + 1}`, 301);
	cases.push(
		await runHopCase(
			"https://a.example.org/0",
			false,
			base,
			() => ({ kind: "network-error", detail: "unscripted" }),
			chain,
		),
	);

	for (let index = 0; index < 2_500; index += 1) {
		const options = randomOptions(random);
		const url =
			random() < 0.85 ? pick(random, URL_SHAPES)(pick(random, HOSTS)) : pick(random, BAD_URLS);
		cases.push(
			await runHopCase(
				url,
				random() < 0.3,
				options,
				() => randomOutcome(random, Math.max(1, options.maxBytes)),
				{},
			),
		);
	}
	return cases;
}

/* ---------- page archive ---------- */

const FINAL_URLS = [
	"https://news.synthetic-wire.org/2026/10/grid-battery-orders",
	"https://[::1]:8080/x?y=1",
	"https://NEWS.Example.ORG./Path",
	"https://bücher.example/café",
	"https://xn--bcher-kva.example/",
	`https://${"a".repeat(90)}.example.org/`,
	"https://a_b.example.org/",
	"not a url",
	"",
	"http://plain.example.org/",
	"file:///etc/passwd",
	"https://192.168.1.10/",
	"https://a.example.org/?q= ",
];
const TITLES: readonly (string | null)[] = [
	null,
	"Grid battery orders double",
	'x\n---\nsource_url: evil\ntitle: "injected',
	'quotes " and \\ backslash',
	"controls \u0000\u0001\u001f\u007f \t\r\n",
	"line sep   para  ",
	"emoji \u{1f600} and CJK 信用",
	"",
];
const RETRIEVED = [
	"2026-10-11T03:00:00.000Z",
	"2026-1-11T03:00:00Z",
	"",
	"+020260-01-01T00:00:00.000Z",
	"2026-10-11",
];

async function pageArchiveCases(): Promise<
	{ input: ArchivedPage; output: { fileName: string; content: string } }[]
> {
	const random = seededRandom(0xa7c4);
	const directory = await mkdtemp(join(tmpdir(), "net-vectors-"));
	const archive = createFilePageArchive({ directory, hasher: webCryptoHasher });
	const cases: { input: ArchivedPage; output: { fileName: string; content: string } }[] = [];
	try {
		const pages: ArchivedPage[] = [];
		for (const finalUrl of FINAL_URLS) {
			for (const title of TITLES) {
				pages.push({
					sourceUrl: "https://news.synthetic-wire.org/feed-item",
					finalUrl,
					title,
					retrievedAt: pick(random, RETRIEVED),
					markdown: pick(random, [
						"# Heading\n\nBody.",
						"",
						"\n",
						"x".repeat(300),
						"日本語\n\n- item",
					]),
					...(random() < 0.5
						? {}
						: {
								omitted: {
									boilerplateBlocks: Math.floor(random() * 5),
									menuLists: Math.floor(random() * 3),
									leadingBlocks: Math.floor(random() * 2),
								},
							}),
				});
			}
		}
		for (const page of pages) {
			const saved = await archive.save(page);
			if (!saved.ok) throw new Error(`archive failed: ${saved.error.detail}`);
			const content = await readFile(join(directory, saved.value.fileName), "utf8");
			cases.push({ input: page, output: { fileName: saved.value.fileName, content } });
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
	return cases;
}

/* ---------- content decoding (pinnedConnect.ts decodedBody + readBounded) ---------- */

type DecodeOutput =
	| { readonly ok: string }
	| { readonly okLength: number; readonly okSha256: string }
	| { readonly tooLarge: true }
	| { readonly error: string };

/** `boundedWireBytes`: the wire bytes, refused past the ceiling. */
async function* boundedWire(
	chunks: readonly Buffer[],
	maxEncodedBytes: number,
): AsyncGenerator<Uint8Array> {
	let wireBytes = 0;
	for (const chunk of chunks) {
		wireBytes += chunk.byteLength;
		if (wireBytes > maxEncodedBytes) throw new ResponseBodyTooLargeError();
		yield chunk;
	}
}

function nodeDecoder(encoding: string) {
	if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
	if (encoding === "deflate") return createInflate();
	return createBrotliDecompress();
}

/** What the TypeScript's pinned connect + `readBounded` make of these wire chunks. */
async function nodeDecode(
	encoding: string,
	chunks: readonly Buffer[],
	maxBytes: number,
): Promise<DecodeOutput> {
	const wire = Readable.from(boundedWire(chunks, maxBytes), { objectMode: false });
	const decoder = nodeDecoder(encoding);
	pipeline(wire, decoder, () => {});
	const parts: Buffer[] = [];
	let total = 0;
	try {
		for await (const chunk of decoder as AsyncIterable<Buffer>) {
			total += chunk.byteLength;
			if (total > maxBytes) {
				decoder.destroy();
				return { tooLarge: true };
			}
			parts.push(chunk);
		}
	} catch (error) {
		if (error instanceof ResponseBodyTooLargeError) return { tooLarge: true };
		const code = (error as { code?: unknown }).code;
		return { error: typeof code === "string" ? code : "unknown error" };
	}
	const bytes = Buffer.concat(parts);
	return bytes.length <= 2_048
		? { ok: bytes.toString("hex") }
		: { okLength: bytes.length, okSha256: createHash("sha256").update(bytes).digest("hex") };
}

/** Stored (level 0) blocks only for small payloads, so bombs stay small on the wire. */
function zlibLevel(random: Random, payload: Buffer): number {
	return pick(random, payload.length <= 4_096 ? [0, 1, 6, 9] : [1, 6, 9]);
}

function encodeWith(random: Random, encoding: string, payload: Buffer): Buffer {
	if (encoding === "deflate")
		return random() < 0.08
			? deflateRawSync(payload)
			: deflateSync(payload, { level: zlibLevel(random, payload) });
	if (encoding === "br") {
		return brotliCompressSync(payload, {
			params: { [zlibConstants.BROTLI_PARAM_QUALITY]: pick(random, [0, 4, 11]) },
		});
	}
	return gzipSync(payload, { level: zlibLevel(random, payload) });
}

function randomPayload(random: Random): Buffer {
	const roll = random();
	if (roll < 0.15) return Buffer.alloc(0);
	if (roll < 0.35) return Buffer.alloc(Math.floor(random() * 300_000));
	if (roll < 0.7)
		return Buffer.from("圧縮された応答 compressed answer ".repeat(1 + Math.floor(random() * 80)));
	return Buffer.from(randomBytes(random, Math.floor(random() * 3_000)));
}

const TAILS: readonly number[][] = [
	[0, 0, 0, 0],
	[0, 0x78],
	[0x78],
	[0x78, 0x79, 0x7a],
	[0x1f, 0x8b],
	[0],
	[0, 0x1f, 0x8b, 8],
];

function splitWire(random: Random, wire: Buffer, boundaries: readonly number[]): Buffer[] {
	const cuts = new Set<number>(
		random() < 0.5 ? boundaries.filter((at) => at > 0 && at < wire.length) : [],
	);
	const pieces = Math.floor(random() * 6);
	for (let index = 0; index < pieces; index += 1)
		cuts.add(1 + Math.floor(random() * Math.max(1, wire.length - 1)));
	if (wire.length <= 40 && random() < 0.3) for (let at = 1; at < wire.length; at += 1) cuts.add(at);
	const sorted = [...cuts].filter((at) => at > 0 && at < wire.length).sort((a, b) => a - b);
	const chunks: Buffer[] = [];
	let start = 0;
	for (const at of sorted) {
		chunks.push(wire.subarray(start, at));
		start = at;
	}
	chunks.push(wire.subarray(start));
	return chunks.filter((chunk, index) => chunk.length > 0 || index === 0);
}

async function decodeCases(): Promise<
	{ input: { encoding: string; chunks: string[]; maxBytes: number }; output: DecodeOutput }[]
> {
	const random = seededRandom(0xdec0);
	const cases: {
		input: { encoding: string; chunks: string[]; maxBytes: number };
		output: DecodeOutput;
	}[] = [];
	for (let index = 0; index < 1_500; index += 1) {
		const encoding = pick(random, ["gzip", "gzip", "x-gzip", "deflate", "br"]);
		const payload = randomPayload(random);
		let wire = encodeWith(random, encoding, payload);
		const boundaries = [wire.length];
		let decodedLength = payload.length;
		if (encoding !== "br" && encoding !== "deflate" && random() < 0.3) {
			// Multi-member gzip, sometimes with empty members.
			const second = random() < 0.4 ? Buffer.alloc(0) : randomPayload(random);
			wire = Buffer.concat([wire, encodeWith(random, encoding, second)]);
			boundaries.push(wire.length);
			decodedLength += second.length;
		}
		const mutation = random();
		if (mutation < 0.25) {
			wire = Buffer.concat([
				wire,
				Buffer.from(
					random() < 0.8 ? pick(random, TAILS) : randomBytes(random, 1 + Math.floor(random() * 20)),
				),
			]);
		} else if (mutation < 0.4) {
			wire = wire.subarray(0, Math.floor(random() * wire.length));
		} else if (mutation < 0.5 && wire.length > 0) {
			const copy = Buffer.from(wire);
			const at = Math.floor(random() * copy.length);
			copy[at] = (copy[at] ?? 0) ^ (1 << Math.floor(random() * 8));
			wire = copy;
		}
		const maxBytes = Math.max(
			1,
			pick(random, [
				decodedLength - 1,
				decodedLength,
				decodedLength + 1,
				wire.length - 1,
				wire.length,
				32,
				100_000,
				1_000_000,
			]),
		);
		const chunks = splitWire(random, wire, boundaries);
		const output = await nodeDecode(encoding, chunks, maxBytes);
		cases.push({
			input: { encoding, chunks: chunks.map((chunk) => chunk.toString("hex")), maxBytes },
			output,
		});
	}
	return cases;
}

export const netExporter: VectorExporter = {
	name: "net",
	async build() {
		return [
			{ path: "net/text-decoder.json", content: textDecoderCases() },
			{ path: "net/same-ip.json", content: sameIpCases() },
			{ path: "net/hop-core.json", content: await hopCoreCases() },
			{ path: "net/page-archive.json", content: await pageArchiveCases() },
			{ path: "net/decode.json", content: await decodeCases() },
		];
	},
};
