/** Tool transcripts, recorded from real TS tests and a seeded generated corpus. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SafeFetchErrorCode, SafeFetcher } from "@research/application";
import { err, ok } from "@research/domain";
import { createFeedParser } from "../../packages/adapters/src/feed/index.ts";
import { createToolContext } from "../../packages/adapters/test/tools/support.ts";
import { seededRandom, type VectorExporter, type VectorFile } from "./shared.ts";
import {
	createNewsTools,
	createSearchTools,
	createWebTools,
	isPathAllowed,
	normalizeRobotsPath,
	parseRobotsTxt,
} from "./tools/recorder.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
async function generated(): Promise<void> {
	const random = seededRandom(20261018);
	const hash = {
		sha256Hex: async (text: string) => createHash("sha256").update(text).digest("hex"),
	};
	const context = () => createToolContext([]);
	const types = [
		null,
		"text/html",
		"TEXT/HTML; charset=utf-8",
		"text/plain",
		"application/xhtml+xml",
		"application/pdf",
		"xtext/plain",
		"text/plainx",
		"x-text/html",
		"text/html+xml",
		"text/html",
		"text/plain\uFEFF",
	];
	const texts = [
		"",
		"\uFEFF \t\r\n",
		"<h1>Title</h1><p>Hello &amp; world</p>",
		"a\r\n\n\n  b\u0085\uFEFFc",
		"<nav>menu</nav><main><h1>Story</h1><p>Body</p></main>",
		"<html><head><title>A &amp; B</title><meta content='2026-02-30' property='article:published_time'></head><body>Text</body></html>",
	];
	for (let i = 0; i < 100; i++) {
		let now = 1792195200000;
		const host = `https://news${i}.synthetic-wire.org`;
		const type = types[Math.floor(random() * types.length)] ?? null;
		const text = texts[Math.floor(random() * texts.length)] ?? "";
		const fetcher: SafeFetcher = {
			fetchText: async (url, options) => {
				if (url.endsWith("robots.txt"))
					return i % 13 === 0
						? err({ code: "HTTP_ERROR", detail: "HTTP 503" })
						: i % 11 === 0
							? err({ code: "HTTP_ERROR", detail: "HTTP 404" })
							: ok({
									finalUrl: url,
									contentType: "text/plain",
									text:
										i % 7 === 0
											? "User-agent: *\nDisallow: /blocked\nAllow: /"
											: "User-agent: *\nAllow: /",
								});
				if (i % 5 === 0 && options.authorizeRedirect !== undefined) {
					const hop = `${host}/redirected`;
					if (!(await options.authorizeRedirect(hop)))
						return err({
							code: "REDIRECT_NOT_AUTHORIZED",
							detail: "redirect 1 was not authorized",
						});
					return ok({ finalUrl: hop, contentType: type, text });
				}
				return ok({ finalUrl: url, contentType: type, text });
			},
		};
		const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };
		const deps = {
			fetcher,
			hasher: hash,
			clock,
			sleep: async (ms: number) => {
				now += ms;
			},
			pageArchive: {
				save: async () =>
					i % 17 === 0
						? err({ code: "ARCHIVE_WRITE_FAILED" as const, detail: "EACCES" })
						: ok({ fileName: "generated.md" }),
			},
		};
		const [web] = createWebTools(deps);
		await web?.execute({ url: `${host}/${i % 7 === 0 ? "blocked" : "article"}` }, context());
		const source = {
			sourceId: "src_gen",
			canonicalUrl: `${host}/feed`,
			publisher: i % 2 === 0 ? "  " : " Generated ",
			title: "Feed",
			licensePolicy:
				i % 2 === 0 ? ("headline-and-link-only" as const) : ("short-excerpt-permitted" as const),
		};
		const news = createNewsTools({ ...deps, feedParser: createFeedParser() });
		await news[1]?.execute({ url: `${host}/article` }, createToolContext([source]));
	}
	const variants: unknown[] = [
		{},
		{ articles: [] },
		null,
		[],
		{ articles: null },
		{ articles: [{ url: "https://a.org/x", title: " A ", seendate: "00990101T000000Z" }] },
		{
			articles: [
				{ url: "https://a.org/x", title: " A ", seendate: "20260230T000000Z", domain: "" },
			],
		},
		{ articles: [{ url: "https://a.org/x", title: "", domain: null }] },
		{
			articles: [
				{ url: "http://a.org/x", title: "a" },
				{ url: "https://a.org/x", title: "b" },
				{ url: "https://a.org/x", title: "c" },
			],
		},
	];
	const errors: SafeFetchErrorCode[] = ["TIMEOUT", "NETWORK_ERROR", "HTTP_ERROR", "UNSAFE_URL"];
	for (let i = 0; i < 200; i++) {
		let now = 1792195200000;
		const bodies = [
			JSON.stringify(variants[Math.floor(random() * variants.length)]),
			"Rate limited\r\nPlease wait",
			"\uFEFF \nbody",
			"x".repeat(300),
			"[",
			`{"extra":${"[".repeat(150)}0${"]".repeat(150)}}`,
		];
		const gdelt = bodies[Math.floor(random() * bodies.length)] ?? "{}";
		const fetcher: SafeFetcher = {
			fetchText: async (url) =>
				i % 9 === 0
					? err({
							code: errors[i % errors.length] ?? "TIMEOUT",
							detail: "HTTP 503 generated failure",
						})
					: ok({
							finalUrl: url,
							contentType: "application/json",
							text: gdelt,
						}),
		};
		const [tool] = createSearchTools({
			fetcher,
			hasher: hash,
			clock: { nowMs: () => now, nowIso: () => new Date(now).toISOString() },
			sleep: async (ms) => {
				now += ms;
			},
			tavilyApiKey: null,
		});
		await tool?.execute({ query: i % 5 === 0 ? "\uFEFF gold 😀 \uFEFF" : "gold price" }, context());
		if (i % 8 === 0) {
			now += 200;
			await tool?.execute({ query: "gold price" }, context());
		}
	}
	// Tavily (web.search): result shapes, zone-safe dates and the escalating pause.
	// Its own seed, so the corpora after it (robots) do not shift.
	const tavilyRandom = seededRandom(20261025);
	const dates = [
		"Thu, 30 Oct 2026 20:30:00 GMT",
		"2026-10-30T20:30:00Z",
		"2026-10-30T20:30:00.123+09:00",
		"2026-10-30T20:30:00+0530",
		"2026-10-30",
		"2026-10-30 10:00",
		"2026-02-30",
		"Oct 30 2026 UTC",
		"not a date",
		" 2026-10-30T20:30:00Z\uFEFF",
		"",
	];
	const snippets = [
		null,
		"",
		"Revenue rose\n\t 8 percent\u00a0year over year.\uFEFF",
		"x".repeat(1_200),
		"Apple 😀 supplier\u2028news",
	];
	const tavilyErrors: [SafeFetchErrorCode, string][] = [
		["HTTP_ERROR", "HTTP 401"],
		["HTTP_ERROR", "HTTP 400"],
		["HTTP_ERROR", "HTTP 422"],
		["HTTP_ERROR", "HTTP 429"],
		["HTTP_ERROR", "HTTP 432"],
		["HTTP_ERROR", "HTTP 503"],
		["TIMEOUT", "request timed out"],
		["NETWORK_ERROR", "connection failed"],
		["UNSAFE_URL", "HTTP 500"],
	];
	for (let i = 0; i < 200; i++) {
		let now = 1792195200000;
		const pick = <T>(items: readonly T[]): T | undefined =>
			items[Math.floor(tavilyRandom() * items.length)];
		const result = () => ({
			title:
				tavilyRandom() < 0.03
					? 7
					: pick([" Apple  results\n", "", "Apple — IR", "\uFEFF", "Apple supplier news"]),
			url: pick([
				"https://www.synthetic-wire.org/a",
				"https://www.synthetic-wire.org/a",
				"http://plain.synthetic-wire.org/",
				"https://10.0.0.1/x",
				"https://investor.synthetic-corp.org/",
			]),
			content: pick(snippets),
			published_date: tavilyRandom() < 0.03 ? 5 : pick([...dates, null]),
			score: tavilyRandom(),
		});
		const bodies = [
			JSON.stringify({ query: "q", results: Array.from({ length: i % 6 }, result) }),
			JSON.stringify({ query: "q", results: Array.from({ length: 1 + (i % 5) }, result) }),
			JSON.stringify({ query: "q", results: Array.from({ length: 2 + (i % 4) }, result) }),
			JSON.stringify({ query: "q", results: [{ title: "Only title" }] }),
			JSON.stringify({ query: "q" }),
			JSON.stringify({ results: "none" }),
			"Bad gateway\r\nretry",
			"[",
		];
		const answers = Array.from({ length: 4 }, () =>
			tavilyRandom() < 0.3
				? err({
						code: pick(tavilyErrors)?.[0] ?? "TIMEOUT",
						detail: pick(tavilyErrors)?.[1] ?? "HTTP 503",
					})
				: ok({
						finalUrl: "https://api.tavily.com/search",
						contentType: "application/json",
						text: pick(bodies) ?? "{}",
					}),
		);
		let call = 0;
		const fetcher: SafeFetcher = {
			fetchText: async () =>
				answers[Math.min(call++, answers.length - 1)] ??
				answers[0] ??
				err({ code: "TIMEOUT", detail: "none" }),
		};
		const [web] = createSearchTools({
			fetcher,
			hasher: hash,
			clock: { nowMs: () => now, nowIso: () => new Date(now).toISOString() },
			sleep: async (ms) => {
				now += ms;
			},
			tavilyApiKey: i % 7 === 0 ? "tvly-generated-key-😀" : "tvly-generated-key",
		});
		for (let step = 0; step < 4; step++) {
			await web?.execute(
				{ query: i % 5 === 0 ? '\uFEFF apple "revenue" 😀 \uFEFF' : "apple revenue" },
				context(),
			);
			now += [0, 30_000, 60_000, 125_000][step % 4] ?? 0;
		}
	}
	const atoms = [
		"/",
		"*",
		"$",
		"/a",
		"/a*b$",
		"/%61",
		"/日本",
		"/%2f",
		"?q=x",
		"/robots.txt",
		"/x#ignored",
		"/%ZZ",
		"/😀",
	];
	for (let i = 0; i < 500; i++) {
		const pick = () => atoms[Math.floor(random() * atoms.length)] ?? "/";
		const text = `User-agent: *\r\nDisallow: ${pick()}\nAllow: ${pick()}\rUser-agent: research\nDisallow: ${pick()}\nAllow: ${pick()}`;
		const rules = parseRobotsTxt(text, i % 2 === 0 ? " research-workspace " : "OTHER");
		for (let j = 0; j < 4; j++) {
			const path = pick();
			normalizeRobotsPath(path);
			isPathAllowed(rules, path);
		}
	}
}
export const toolsExporter: VectorExporter = {
	name: "tools",
	async build() {
		const directory = await mkdtemp(join(tmpdir(), "rr-tools-vectors-"));
		const target = join(directory, "capture.jsonl");
		const previous = process.env.TOOLS_CAPTURE_FILE;
		try {
			const result = spawnSync(
				process.execPath,
				[
					"node_modules/vitest/vitest.mjs",
					"run",
					"--config",
					"scripts/vectors/tools/capture.vitest.config.ts",
				],
				{
					cwd: root,
					env: { ...process.env, TOOLS_CAPTURE_FILE: target },
					encoding: "utf8",
					timeout: 120000,
				},
			);
			if (result.status !== 0)
				throw new Error(`tool test capture failed: ${result.stdout}\n${result.stderr}`);
			process.env.TOOLS_CAPTURE_FILE = target;
			await generated();
			const rows = (await readFile(target, "utf8"))
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const groups = new Map<string, Record<string, unknown>>();
			const robots = new Map<string, Record<string, unknown>>();
			for (const row of rows) {
				if (typeof row.id === "string") groups.set(row.id, row);
				else robots.set(JSON.stringify(row), row);
			}
			const transcripts = [...groups.entries()]
				.sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
				.map(([, row]) => {
					const { id: _, ...rest } = row;
					return rest;
				});
			const files: VectorFile[] = [];
			for (const [kind, cases] of [
				["transcripts", transcripts],
				["robots", [...robots.values()]],
			] as const) {
				let batch: unknown[] = [];
				let bytes = 0;
				let index = 0;
				for (const item of cases) {
					const size = JSON.stringify(item, null, "\t").length;
					if (bytes + size > 3000000 && batch.length > 0) {
						files.push({ path: `tools/${kind}-${index++}.json`, content: batch });
						batch = [];
						bytes = 0;
					}
					batch.push(item);
					bytes += size;
				}
				if (batch.length > 0) files.push({ path: `tools/${kind}-${index}.json`, content: batch });
			}
			return files;
		} finally {
			if (previous === undefined) delete process.env.TOOLS_CAPTURE_FILE;
			else process.env.TOOLS_CAPTURE_FILE = previous;
			await rm(directory, { recursive: true, force: true });
		}
	},
};
