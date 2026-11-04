import {
	CLAUDE_API_MESSAGES_URL,
	CLAUDE_API_VERSION,
	claudeCostUsd,
	claudeModel,
} from "@research/adapters/providers";
import { extractJsonObject } from "@research/agent-core";
import { z } from "zod";
import type { StockSources } from "./sources.ts";

/**
 * Finds the pages that describe a company's business with a Claude Haiku
 * 5.5 agent and the Claude API's web search tool (owner's choice,
 * 2026-11-04, when Tavily's free credits ran out). The agent searches at most
 * MAX_SEARCHES times and picks pages from its results, the company's own
 * site first. Only URLs that appear in the search results are kept, so a
 * URL the model writes from memory is never read; the pages themselves are
 * then read by the runner's own fetcher and quoted like any other source
 * (webSources.ts), so the evidence check does not depend on this step.
 *
 * `web_search_20250305` (the basic version) is used on purpose: with
 * `web_search_20260209` Haiku 5.5 filtered the results in a hidden code step
 * and then answered with a URL from memory (probe, 2026-11-04).
 *
 * Wire format and prices: docs/external-apis/apis/claude-api.md (web search).
 */

export const PAGE_FINDER_MODEL = "claude-haiku-5-5";
/** Web searches per stock. */
export const MAX_SEARCHES = 2;
/** The web search tool's price: USD 10 per 1,000 searches. */
export const WEB_SEARCH_PRICE_USD = 0.01;
/** Pages the agent may pick. */
const MAX_PICKED_PAGES = 6;
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 4_000;
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 15_000;

export type PageFinding =
	| {
			readonly ok: true;
			/** Pages to read, best first; every one appeared in the search results. */
			readonly urls: readonly string[];
			readonly searches: number;
			readonly costUsd: number;
			readonly log: readonly string[];
	  }
	| {
			readonly ok: false;
			readonly code: string;
			readonly detail: string;
			readonly costUsd: number;
	  };

export type PageText =
	| {
			readonly ok: true;
			readonly url: string;
			readonly title: string | null;
			readonly text: string;
			readonly retrievedAt: string;
			readonly costUsd: number;
	  }
	| { readonly ok: false; readonly detail: string; readonly costUsd: number };

export interface PageFinder {
	find(stock: StockSources): Promise<PageFinding>;
	/**
	 * A page's text read by the Claude API's web fetch tool: the fallback for
	 * a page the runner's own fetcher could not read (HTTP errors to bots,
	 * pages rendered only by script, pages over its 2 MiB limit). Never used
	 * for a page robots.txt refuses or the safety policy rejects (webSources.ts).
	 * HTML only: a PDF comes back as base64 and is not read.
	 */
	fetchText(url: string): Promise<PageText>;
}

/** The web fetch tool's text without its metadata header ("---\ncanonical: …\n---") and table padding. */
export function cleanFetchedText(text: string): string {
	return text
		.replace(/^\uFEFF?---\n[\s\S]*?\n---\n/, "")
		.replace(/\|[-:| ]{3,}\|/g, "|")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Tokens the web fetch tool may return for one page. */
const MAX_FETCHED_TOKENS = 8_000;

const fetchResultSchema = z.object({
	type: z.literal("web_fetch_result"),
	url: z.string(),
	retrieved_at: z.string().optional(),
	content: z.object({
		type: z.literal("document"),
		title: z.string().nullable().optional(),
		source: z.object({ type: z.string(), media_type: z.string().optional(), data: z.string() }),
	}),
});

const searchResultSchema = z.object({
	type: z.literal("web_search_result"),
	url: z.string(),
	title: z.string().nullable().optional(),
});

const contentBlockSchema = z.union([
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({
		type: z.literal("web_search_tool_result"),
		// A list of results, or one error object (`web_search_tool_result_error`).
		content: z.union([z.array(z.unknown()), z.object({ error_code: z.string() }).passthrough()]),
	}),
	z.object({ type: z.string() }).passthrough(),
]);

const responseSchema = z.object({
	stop_reason: z.string().nullable(),
	content: z.array(contentBlockSchema),
	usage: z.object({
		input_tokens: z.number(),
		output_tokens: z.number(),
		cache_creation_input_tokens: z.number().nullable().optional(),
		cache_read_input_tokens: z.number().nullable().optional(),
		server_tool_use: z.object({ web_search_requests: z.number().optional() }).optional(),
	}),
});

const pickSchema = z.object({
	pages: z
		.array(
			z.object({
				url: z.string(),
				kind: z.enum(["official", "regulator", "other"]).optional(),
			}),
		)
		.max(20),
});

/** "https://Example.com/a/" and "https://example.com/a" are one page. */
export function samePageKey(url: string): string | null {
	if (!URL.canParse(url)) return null;
	const parsed = new URL(url);
	parsed.hash = "";
	const path = parsed.pathname.replace(/\/+$/, "");
	return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${parsed.search}`;
}

/**
 * The picked pages that appeared in the search results, in the agent's
 * order, each once. Results the agent did not pick are never read: adding
 * them after its picks brought back the job sites and subsidiaries it had
 * passed over (24 of 214 entries cited a job site; review of 2026-11-04).
 */
export function pagesFromResults(picked: readonly string[], results: readonly string[]): string[] {
	const byKey = new Map<string, string>();
	for (const url of results) {
		const key = samePageKey(url);
		if (key !== null && !byKey.has(key)) byKey.set(key, url);
	}
	const chosen: string[] = [];
	const seen = new Set<string>();
	for (const url of picked) {
		const key = samePageKey(url);
		const known = key === null ? undefined : byKey.get(key);
		if (key === null || known === undefined || seen.has(key)) continue;
		seen.add(key);
		chosen.push(known);
	}
	return chosen;
}

/** The instruction for one stock. */
export function pageFinderPrompt(stock: StockSources, excludedHosts: readonly string[]): string {
	const japanese = stock.stock.market === "JP";
	const exchange = japanese ? "Tokyo Stock Exchange" : "a US exchange";
	return [
		`Find web pages that describe the business of this listed company: ${stock.name.ja}${stock.name.ja === stock.name.en ? "" : ` (${stock.name.en})`}, ${exchange}, code ${stock.stock.symbol}.`,
		`Use the web_search tool, at most ${MAX_SEARCHES} searches${japanese ? ", in Japanese (e.g. 「<company name> 事業内容 会社概要」)" : ""}.`,
		`From the search results, pick up to ${MAX_PICKED_PAGES} pages, best first:`,
		"1. the company's own website: its business, products or services, company profile (会社概要) or investor-relations pages;",
		"2. regulators and stock exchanges (EDINET, SEC, JPX, TDnet);",
		"3. other pages that describe this company's business in prose.",
		"Only pages about this company itself: not a subsidiary, a parent, or another company with a similar name.",
		`Never pick: ${excludedHosts.join(", ")}; social media, forums, Q&A sites, job boards, or data aggregators that only list figures.`,
		"Pick only URLs that appear in your search results. Do not write a URL from memory.",
		'Answer with one JSON object and nothing else: {"pages": [{"url": "https://...", "kind": "official" | "regulator" | "other"}]}. When nothing suitable was found, answer {"pages": []}.',
	].join("\n");
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function transientStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 529 || status >= 500;
}

export function createClaudePageFinder(environment: {
	readonly apiKey: string;
	readonly fetch: typeof fetch;
	/** Hosts the search must never return (Wikipedia, 会社四季報, job boards…). */
	readonly blockedDomains: readonly string[];
}): PageFinder {
	const model = claudeModel(PAGE_FINDER_MODEL);
	if (model === null) throw new Error(`${PAGE_FINDER_MODEL} has no price in CLAUDE_API_MODELS`);

	async function requestOnce(
		tools: readonly Record<string, unknown>[],
		prompt: string,
	): Promise<
		| { kind: "answer"; body: z.infer<typeof responseSchema> }
		| { kind: "failed"; status: number | null; detail: string }
	> {
		let response: Response;
		try {
			response = await environment.fetch(CLAUDE_API_MESSAGES_URL, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				headers: {
					"content-type": "application/json",
					"x-api-key": environment.apiKey,
					"anthropic-version": CLAUDE_API_VERSION,
				},
				body: JSON.stringify({
					model: PAGE_FINDER_MODEL,
					max_tokens: MAX_OUTPUT_TOKENS,
					output_config: { effort: "low" },
					tools,
					messages: [{ role: "user", content: prompt }],
				}),
			});
		} catch (error) {
			return {
				kind: "failed",
				status: null,
				detail: error instanceof Error ? error.message : String(error),
			};
		}
		const text = await response.text();
		if (!response.ok) {
			return { kind: "failed", status: response.status, detail: text.slice(0, 300) };
		}
		const parsed = responseSchema.safeParse(parseJson(text));
		if (!parsed.success) {
			return { kind: "failed", status: response.status, detail: "unreadable response" };
		}
		return { kind: "answer", body: parsed.data };
	}

	/** One request, retried on a transient failure. */
	async function request(
		tools: readonly Record<string, unknown>[],
		prompt: string,
	): Promise<
		| { kind: "answer"; body: z.infer<typeof responseSchema> }
		| { kind: "failed"; status: number | null; detail: string }
	> {
		for (let attempt = 1; ; attempt += 1) {
			const outcome = await requestOnce(tools, prompt);
			const retry =
				outcome.kind === "failed" &&
				attempt < ATTEMPTS &&
				(outcome.status === null || transientStatus(outcome.status));
			if (!retry) return outcome;
			await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS * attempt));
		}
	}

	function tokenCostUsd(usage: z.infer<typeof responseSchema>["usage"]): number {
		if (model === null) return 0;
		return (
			claudeCostUsd(model, {
				inputTokens: usage.input_tokens,
				outputTokens: usage.output_tokens,
				cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
				cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
			}) ?? 0
		);
	}

	return {
		async fetchText(url) {
			const outcome = await request(
				[
					{
						type: "web_fetch_20250910",
						name: "web_fetch",
						max_uses: 1,
						max_content_tokens: MAX_FETCHED_TOKENS,
						blocked_domains: environment.blockedDomains,
					},
				],
				`Fetch ${url} with the web_fetch tool once, then answer only: done.`,
			);
			if (outcome.kind === "failed") {
				return {
					ok: false,
					detail: `${outcome.status ?? "network"} ${outcome.detail}`,
					costUsd: 0,
				};
			}
			const costUsd = tokenCostUsd(outcome.body.usage);
			for (const block of outcome.body.content) {
				if (block.type !== "web_fetch_tool_result" || !("content" in block)) continue;
				const result = fetchResultSchema.safeParse(block.content);
				if (!result.success) {
					return { ok: false, detail: JSON.stringify(block.content).slice(0, 200), costUsd };
				}
				const { source } = result.data.content;
				if (source.type !== "text") {
					return { ok: false, detail: `not text (${source.media_type ?? source.type})`, costUsd };
				}
				return {
					ok: true,
					url: result.data.url,
					title: result.data.content.title ?? null,
					text: cleanFetchedText(source.data),
					retrievedAt: result.data.retrieved_at ?? new Date().toISOString(),
					costUsd,
				};
			}
			return { ok: false, detail: "no web_fetch result", costUsd };
		},

		async find(stock) {
			const tools = [
				{
					type: "web_search_20250305",
					name: "web_search",
					max_uses: MAX_SEARCHES,
					blocked_domains: environment.blockedDomains,
				},
			];
			const prompt = pageFinderPrompt(stock, environment.blockedDomains);
			{
				const outcome = await request(tools, prompt);
				if (outcome.kind === "failed") {
					return {
						ok: false,
						code: outcome.status === null ? "NETWORK_ERROR" : `HTTP ${outcome.status}`,
						detail: outcome.detail,
						costUsd: 0,
					};
				}
				const { body } = outcome;
				const searches = body.usage.server_tool_use?.web_search_requests ?? 0;
				const costUsd = tokenCostUsd(body.usage) + searches * WEB_SEARCH_PRICE_USD;
				const results: string[] = [];
				const log: string[] = [];
				const toolErrors: string[] = [];
				let answer = "";
				for (const block of body.content) {
					if (block.type === "text" && "text" in block && typeof block.text === "string") {
						answer += block.text;
					} else if (block.type === "web_search_tool_result" && "content" in block) {
						if (Array.isArray(block.content)) {
							for (const item of block.content) {
								const result = searchResultSchema.safeParse(item);
								if (result.success) results.push(result.data.url);
							}
						} else {
							toolErrors.push(JSON.stringify(block.content).slice(0, 200));
						}
					}
				}
				if (results.length === 0 && toolErrors.length > 0) {
					// A failed search is not "nothing found": the stock must not wait a month for it.
					return {
						ok: false,
						code: "SEARCH_TOOL_ERROR",
						detail: toolErrors.join("; "),
						costUsd,
					};
				}
				const json = extractJsonObject(answer);
				const pick = json.ok ? pickSchema.safeParse(json.value) : null;
				const picked = pick?.success === true ? pick.data.pages.map((page) => page.url) : [];
				if (pick?.success !== true) log.push("the agent's answer had no page list");
				const dropped = picked.filter(
					(url) => !results.some((result) => samePageKey(result) === samePageKey(url)),
				);
				if (dropped.length > 0) {
					log.push(`dropped ${dropped.length} picked URL(s) not in the search results`);
				}
				return {
					ok: true,
					urls: pagesFromResults(picked, results),
					searches,
					costUsd,
					log,
				};
			}
		},
	};
}
