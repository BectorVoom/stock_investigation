import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createFeedParser } from "@research/adapters/feed";
import { createFilePageArchive, createNodeSafeFetcher } from "@research/adapters/node";
import { systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createResearchTools } from "@research/adapters/tools";
import type { CollectedEvidence, ToolContext, ToolDefinition } from "@research/agent-core";
import type { StockSources } from "./sources.ts";
import type { CompanySource, SourceId } from "./template.ts";

/**
 * Public web pages as sources (ADR-0064 §2a): the stored records alone
 * left many companies without a cited business description (a Japanese
 * company has no business text at all), so each stock also gets up to
 * three pages found by one web search and read with the runner's own tools
 * — `web.search` (Tavily) and `web.fetch_page` (the pinned safe fetcher,
 * robots.txt, per-host spacing, 2 MiB / 15 s per page). Their text is
 * quoted and checked word for word like any other source.
 *
 * Which pages are acceptable, in this order:
 *   1. the company's own site (its host contains a word of its English
 *      name) — business, IR and corporate pages;
 *   2. regulators and exchanges (SEC, EDINET, JPX, TDnet, *.go.jp);
 *   3. any other page, after the excluded kinds below.
 * Never: open-edit encyclopedias (Wikipedia was removed from research by the
 * owner, ADR-0025), social media, forums, Q&A and video sites, and 会社四季報's
 * own site (its text is licensed).
 */

/** Pages read per stock. */
export const MAX_WEB_PAGES = 3;
/** Page text the model may quote, per page. */
export const MAX_WEB_TEXT_CHARS = 10_000;

const EXCLUDED_HOST_SUFFIXES = [
	"wikipedia.org",
	"wikiwand.com",
	"weblio.jp",
	"x.com",
	"twitter.com",
	"facebook.com",
	"instagram.com",
	"linkedin.com",
	"youtube.com",
	"tiktok.com",
	"reddit.com",
	"quora.com",
	"5ch.net",
	"2ch.sc",
	"chiebukuro.yahoo.co.jp",
	"detail.chiebukuro.yahoo.co.jp",
	"ameblo.jp",
	"note.com",
	"medium.com",
	"shikiho.toyokeizai.net",
];

const REGULATOR_HOST_SUFFIXES = [
	"sec.gov",
	"edinet-fsa.go.jp",
	"jpx.co.jp",
	"release.tdnet.info",
	"go.jp",
];

/** Words of a company name that say nothing about which site is its own. */
const GENERIC_NAME_WORDS = new Set([
	"inc",
	"corp",
	"corporation",
	"company",
	"limited",
	"ltd",
	"holdings",
	"group",
	"the",
	"and",
	"co",
	"plc",
]);

export type PageKind = "official" | "regulator" | "other";

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return null;
	}
}

function hasSuffix(host: string, suffixes: readonly string[]): boolean {
	return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** The name's distinctive words ("COCA COLA CO" → coca, cola), lower case. */
export function nameWords(name: string): string[] {
	return name
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length >= 4 && !GENERIC_NAME_WORDS.has(word));
}

/** Where a result stands in the acceptance order, or null when it is never used. */
export function pageKind(url: string, companyName: string): PageKind | null {
	const host = hostOf(url);
	if (host === null || !url.startsWith("https://")) return null;
	if (hasSuffix(host, EXCLUDED_HOST_SUFFIXES)) return null;
	const words = nameWords(companyName);
	// The host's labels without the public suffix: "www.coca-colacompany.com" → "www.coca-colacompany".
	const hostName = host.split(".").slice(0, -1).join(".");
	if (words.some((word) => hostName.includes(word))) return "official";
	if (hasSuffix(host, REGULATOR_HOST_SUFFIXES)) return "regulator";
	return "other";
}

const KIND_ORDER: Record<PageKind, number> = { official: 0, regulator: 1, other: 2 };

/** The search results to read: acceptable ones, official first, in search order within a kind. */
export function choosePages(
	results: readonly { readonly url: string }[],
	companyName: string,
	limit: number,
): { url: string; kind: PageKind }[] {
	const seen = new Set<string>();
	const ranked: { url: string; kind: PageKind; rank: number }[] = [];
	results.forEach((result, rank) => {
		const kind = pageKind(result.url, companyName);
		if (kind === null || seen.has(result.url)) return;
		seen.add(result.url);
		ranked.push({ url: result.url, kind, rank });
	});
	ranked.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.rank - b.rank);
	return ranked.slice(0, limit).map(({ url, kind }) => ({ url, kind }));
}

export interface WebTools {
	readonly search: ToolDefinition;
	readonly fetchPage: ToolDefinition;
}

/** The runner's own `web.search` and `web.fetch_page`, built as the runner builds them. */
export function createWebTools(pagesDirectory: string): WebTools {
	// The pinned safe fetcher's sockets time out under Bun (measured 2026-11-03:
	// 15 s timeout under Bun, 349 ms under Node); the runner itself runs under Node.
	if (process.versions.bun !== undefined) {
		throw new Error(
			"web sources need Node: node --env-file=.env scripts/poc/companyDescription/run.ts (or pass --no-web)",
		);
	}
	const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
	if (tavilyApiKey === "") throw new Error("TAVILY_API_KEY is not set; web sources need it");
	mkdirSync(pagesDirectory, { recursive: true });
	const tools = createResearchTools({
		fetcher: createNodeSafeFetcher(),
		feedParser: createFeedParser(),
		hasher: webCryptoHasher,
		clock: systemClock,
		secUserAgent: null,
		tavilyApiKey,
		pageArchive: createFilePageArchive({ directory: pagesDirectory, hasher: webCryptoHasher }),
		sleep: (ms, signal) =>
			new Promise((resolve) => {
				const timer = setTimeout(resolve, ms);
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			}),
	});
	const find = (toolId: string): ToolDefinition => {
		const tool = tools.find((item) => item.toolId === toolId);
		if (tool === undefined) throw new Error(`${toolId} is not available`);
		return tool;
	};
	return { search: find("web.search"), fetchPage: find("web.fetch_page") };
}

function toolContext(runId: string): ToolContext {
	let next = 0;
	return {
		runId,
		signal: AbortSignal.timeout(120_000),
		nowIso: () => new Date().toISOString(),
		nextId: (prefix) => {
			next += 1;
			return `${runId}_${prefix}${next}`;
		},
		subscribedSources: [],
	};
}

/** The search query: the company's business, in its home language. */
export function searchQuery(stock: StockSources): string {
	return stock.stock.market === "JP"
		? `${stock.name.ja} 事業内容 会社概要`
		: `${stock.name.en} company business segments products`;
}

const KIND_LABEL: Record<PageKind, { en: string; ja: string }> = {
	official: { en: "company website", ja: "企業の公式サイト" },
	regulator: { en: "regulator or exchange", ja: "規制当局・取引所" },
	other: { en: "web page", ja: "ウェブページ" },
};

/** A fetched page as a numbered source: its host as the publisher; its kind and retrieval day as a note, in both languages. */
function pageSource(id: SourceId, page: CollectedEvidence, kind: PageKind): CompanySource {
	const day = page.evidence.retrievedAt.slice(0, 10);
	const title = page.evidence.title.slice(0, 280);
	const host = hostOf(page.evidence.sourceUrl) ?? page.evidence.publisher;
	return {
		id,
		title: { en: title, ja: title },
		publisher: host.slice(0, 300),
		asOf: page.evidence.publishedAt?.slice(0, 10) ?? null,
		url: page.evidence.sourceUrl,
		note: {
			en: `${KIND_LABEL[kind].en[0]?.toUpperCase()}${KIND_LABEL[kind].en.slice(1)}. Retrieved ${day}.`,
			ja: `${KIND_LABEL[kind].ja}。${day} 取得。`,
		},
		text: page.retrievedText.slice(0, MAX_WEB_TEXT_CHARS),
	};
}

export interface WebSourcesResult {
	readonly stock: StockSources;
	/** What happened to each candidate, for the run's report. */
	readonly log: readonly string[];
}

/** The stock's sources with up to MAX_WEB_PAGES web pages appended as the next ids. */
export async function withWebSources(
	stock: StockSources,
	tools: WebTools,
): Promise<WebSourcesResult> {
	const context = toolContext(`poc_web_${randomUUID().slice(0, 8)}`);
	const log: string[] = [];
	const query = searchQuery(stock);
	const searched = await tools.search.execute({ query }, context);
	if (!searched.ok) {
		log.push(`search failed (${searched.error.code}): ${searched.error.detail}`);
		return { stock, log };
	}
	const results = searched.value.evidence.map((item) => ({ url: item.evidence.sourceUrl }));
	const chosen = choosePages(results, stock.name.en, MAX_WEB_PAGES);
	log.push(`search "${query}": ${results.length} results, reading ${chosen.length}`);
	const sources = [...stock.sources];
	for (const page of chosen) {
		const fetched = await tools.fetchPage.execute({ url: page.url }, context);
		const evidence = fetched.ok ? fetched.value.evidence[0] : undefined;
		if (!fetched.ok || evidence === undefined || evidence.retrievedText.trim().length < 200) {
			log.push(`skipped ${page.url}: ${fetched.ok ? "no readable text" : fetched.error.code}`);
			continue;
		}
		const id: SourceId = `S${sources.length + 1}`;
		sources.push(pageSource(id, evidence, page.kind));
		log.push(`${id} ${page.kind} ${page.url}`);
	}
	return { stock: { ...stock, sources }, log };
}
