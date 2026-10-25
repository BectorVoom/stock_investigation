/**
 * Ingest parity corpus: the real `ingestSources` runs against scripted
 * fakes (fetcher, feed parser, clock, hasher). Every call a fake receives is
 * recorded, so the Rust replay proves the same requests, the same clock
 * reads (fetchedAt / retrievedAt order), the same dedupe and the same order.
 */
import { createHash } from "node:crypto";
import type { SubscribedSourceRef } from "@research/contracts";
import type { RawFeed } from "@research/domain";
import { err, ok } from "@research/domain";
import { ingestSources } from "../../../packages/application/src/ingest.ts";
import { seededRandom } from "../shared.ts";

type Fetch =
	| {
			readonly ok: {
				readonly finalUrl: string;
				readonly contentType: string | null;
				readonly text: string;
			};
	  }
	| {
			readonly err: {
				readonly code: string;
				readonly detail: string;
				/** The feed host's answer status, on an `HTTP_ERROR` only (as the real fetcher sets it). */
				readonly status?: number;
			};
	  };

interface IngestScript {
	readonly name: string;
	readonly sources: readonly SubscribedSourceRef[];
	readonly maxArticles: number;
	/** Abort the run during the n-th fetch (1-based), after it returned. */
	readonly abortOnFetch: number | null;
	/** Fetch result per source index (consumed in fetch order). */
	readonly fetches: readonly Fetch[];
	/** Feed per fetched text; absent text is not a feed. */
	readonly feeds: Readonly<Record<string, RawFeed>>;
}

const CODES = [
	"UNSAFE_URL",
	"HOST_NOT_ALLOWED",
	"UNSAFE_REDIRECT",
	"TOO_MANY_REDIRECTS",
	"REDIRECT_NOT_AUTHORIZED",
	"TIMEOUT",
	"HTTP_ERROR",
	"RESPONSE_TOO_LARGE",
	"NETWORK_ERROR",
] as const;

const TITLES = [
	"Quarterly results beat estimates",
	"  Spaced &amp; <b>marked</b> up title  ",
	"日本銀行が政策金利を維持",
	"Caf&eacute; chain expands &#8212; again",
	"",
	"x".repeat(340),
	"Emoji \u{1F600} headline\u0085with NEL",
];
const LINKS = [
	"https://news.example.com/a?utm_source=x&b=2&a=1",
	"https://news.example.com/a?a=1&b=2",
	"https://news.example.com/b/",
	"https://News.Example.COM./c#frag",
	"http://news.example.com/insecure",
	"javascript:alert(1)",
	"https://user:pw@news.example.com/d",
	"https://192.168.0.1/e",
	"https://news.example.com:8443/f",
	"https://other.example.org/g",
	"  https://news.example.com/h  ",
	"",
	"   ",
];
const DATES = [
	"Mon, 05 Oct 2026 12:00:00 GMT",
	"2026-10-05T12:00:00+09:00",
	"2026-02-30",
	"garbage",
	"1 Jan 0099 00:00 UT",
	null,
];
const SUMMARIES = [
	"A <p>short</p> summary.",
	"s".repeat(900),
	"<script>alert(1)</script>Plain after script",
	"",
	null,
];

function pick<T>(random: () => number, values: readonly T[]): T {
	return values[Math.floor(random() * values.length)] as T;
}

function feedOf(random: () => number, count: number): RawFeed {
	const items = Array.from({ length: count }, (_, index) => ({
		title: random() < 0.05 ? null : pick(random, TITLES),
		link:
			random() < 0.6
				? `https://news.example.com/item-${index}-${Math.floor(random() * 5)}`
				: random() < 0.1
					? null
					: pick(random, LINKS),
		publishedText: pick(random, DATES),
		summaryText: pick(random, SUMMARIES),
	}));
	return {
		kind: random() < 0.5 ? "rss" : "atom",
		title: "Feed",
		siteLink: "https://news.example.com/",
		items,
	};
}

function scripts(): IngestScript[] {
	const random = seededRandom(5151);
	const result: IngestScript[] = [];
	const source = (index: number, url?: string): SubscribedSourceRef => ({
		sourceId: `src_${index}`,
		canonicalUrl: url ?? `https://news${index % 3}.example.com/feed.xml`,
		publisher: `Publisher ${index}`,
		title: `Source ${index}`,
		licensePolicy: random() < 0.5 ? "short-excerpt-permitted" : "headline-and-link-only",
	});
	// Fixed edge cases first.
	result.push({
		name: "no sources",
		sources: [],
		maxArticles: 400,
		abortOnFetch: null,
		fetches: [],
		feeds: {},
	});
	const one = feedOf(random, 5);
	result.push({
		name: "one source",
		sources: [source(0)],
		maxArticles: 400,
		abortOnFetch: null,
		fetches: [
			{
				ok: {
					finalUrl: "https://news0.example.com/feed.xml",
					contentType: "application/rss+xml",
					text: "feed-0",
				},
			},
		],
		feeds: { "feed-0": one },
	});
	result.push({
		name: "invalid stored url throws after earlier sources",
		sources: [source(0), source(1, "not a url"), source(2)],
		maxArticles: 400,
		abortOnFetch: null,
		fetches: [
			{ ok: { finalUrl: "https://news0.example.com/feed.xml", contentType: null, text: "feed-0" } },
		],
		feeds: { "feed-0": one },
	});
	result.push({
		name: "IPv6 and uppercase hosts",
		sources: [
			source(0, "https://[2001:db8::1]/feed"),
			source(1, "https://NEWS.Example.com:8443/feed.xml"),
		],
		maxArticles: 400,
		abortOnFetch: null,
		fetches: [
			{ err: { code: "UNSAFE_URL", detail: "blocked" } },
			{ err: { code: "NETWORK_ERROR", detail: "reset" } },
		],
		feeds: {},
	});
	for (let index = 0; index < 160; index++) {
		const count = Math.floor(random() * 6);
		const sources = Array.from({ length: count }, (_, i) => source(i));
		const fetches: Fetch[] = [];
		const feeds: Record<string, RawFeed> = {};
		sources.forEach((_, i) => {
			const roll = random();
			if (roll < 0.15) {
				const code = pick(random, CODES);
				// No extra random draw, so the later cases stay put; 410 is a status
				// no mapping names, so the replay shows it comes out unchanged (§4a).
				fetches.push({
					err:
						code === "HTTP_ERROR"
							? { code, detail: "HTTP 410", status: 410 }
							: { code, detail: "scripted failure" },
				});
			} else {
				const text = roll < 0.25 ? `garbage-${i}` : `feed-${index}-${i}`;
				fetches.push({
					ok: { finalUrl: sources[i]?.canonicalUrl ?? "", contentType: "application/xml", text },
				});
				if (!text.startsWith("garbage")) feeds[text] = feedOf(random, Math.floor(random() * 14));
			}
		});
		const maxArticles = pick(random, [400, 400, 1, 3, 7, 12, 0]);
		const abortOnFetch = random() < 0.2 && count > 0 ? 1 + Math.floor(random() * count) : null;
		result.push({ name: `generated ${index}`, sources, maxArticles, abortOnFetch, fetches, feeds });
	}
	// A 100+-item feed and a source count that overruns the article cap.
	result.push({
		name: "150-item feed",
		sources: [source(0), source(1)],
		maxArticles: 400,
		abortOnFetch: null,
		fetches: [
			{ ok: { finalUrl: "u", contentType: null, text: "big-0" } },
			{ ok: { finalUrl: "u", contentType: null, text: "big-1" } },
		],
		feeds: { "big-0": feedOf(random, 150), "big-1": feedOf(random, 150) },
	});
	return result;
}

async function run(script: IngestScript): Promise<unknown> {
	const calls: unknown[] = [];
	const parserInputs: string[] = [];
	let clockCalls = 0;
	let fetchIndex = 0;
	const controller = new AbortController();
	const fetcher = {
		async fetchText(
			url: string,
			options: {
				maxBytes: number;
				timeoutMs: number;
				accept: string;
				signal?: AbortSignal;
				allowedHosts?: ReadonlySet<string>;
			},
		) {
			const number = ++fetchIndex;
			calls.push({
				url,
				maxBytes: options.maxBytes,
				timeoutMs: options.timeoutMs,
				accept: options.accept,
				allowedHosts: options.allowedHosts === undefined ? null : [...options.allowedHosts],
				hasSignal: options.signal !== undefined,
			});
			const scripted = script.fetches[number - 1];
			if (script.abortOnFetch === number) controller.abort();
			if (scripted === undefined) throw new Error("fetch not scripted");
			return "ok" in scripted ? ok(scripted.ok) : err(scripted.err);
		},
	};
	const feedParser = {
		parse(text: string) {
			parserInputs.push(text);
			const feed = script.feeds[text];
			return feed === undefined ? err("NOT_A_FEED" as const) : ok(feed);
		},
	};
	const clock = {
		nowMs: () => 0,
		nowIso: () => new Date(Date.UTC(2026, 9, 17, 0, 0, 0) + ++clockCalls * 1000).toISOString(),
	};
	const hasher = {
		sha256Hex: async (text: string) => createHash("sha256").update(text, "utf8").digest("hex"),
	};
	try {
		const outcome = await ingestSources(
			script.sources,
			{ fetcher, feedParser, hasher, clock } as never,
			{
				signal: controller.signal,
				maxArticles: script.maxArticles,
			},
		);
		return { calls, parserInputs, clockCalls, outcome };
	} catch (error) {
		return { calls, threw: error instanceof Error ? error.name : "unknown" };
	}
}

export async function ingestVectors(): Promise<{ input: IngestScript; output: unknown }[]> {
	const cases = [];
	for (const script of scripts())
		cases.push({ input: script, output: JSON.parse(JSON.stringify(await run(script))) });
	return cases;
}
