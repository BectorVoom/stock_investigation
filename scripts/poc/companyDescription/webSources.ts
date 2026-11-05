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
 * three pages, found by a `PageSearch` — the Haiku agent
 * (claudePageFinder.ts, the default) or Tavily's `web.search` — and read
 * with the runner's own `web.fetch_page` (the pinned safe fetcher,
 * robots.txt, per-host spacing, 2 MiB / 15 s per page). Their text is
 * quoted and checked word for word like any other source.
 *
 * Which pages are acceptable, in this order:
 *   1. the company's own site (its registered domain name is built from
 *      its English name, see `pageKind`) — business, IR and corporate pages;
 *   2. regulators and exchanges (SEC, EDINET, JPX, TDnet, *.go.jp);
 *   3. any other page, after the excluded kinds below.
 * Never: open-edit encyclopedias (Wikipedia was removed from research by the
 * owner, ADR-0025), social media, forums, Q&A and video sites, 会社四季報's
 * own site and other licensed editorial blurbs and quote pages (Nikkei,
 * 株予報, みんかぶ, 株探, Yahoo Finance), machine-written profiles (Tavily's,
 * MarkLines' AI analysis), contact-list aggregators, job boards and
 * recruiting pages (by host name too, `isJobSiteHost`).
 */

/** Pages read per stock. */
export const MAX_WEB_PAGES = 3;
/** Acceptable results tried at most, so failing pages cannot make a stock slow. */
export const MAX_WEB_PAGE_ATTEMPTS = 6;
/** Page text the model may quote, per page. */
export const MAX_WEB_TEXT_CHARS = 10_000;
/** Of a longer page: its start, and an excerpt at its sales-by-region table (【海外】). */
const PAGE_HEAD_CHARS = 8_000;
const REGION_EXCERPT_CHARS = 2_000;
const REGION_EXCERPT_LEAD_CHARS = 200;
/** Headings of a table of sales by country or region. */
const REGION_SALES_HEADING =
	/地域ごとの情報|所在地別|地域別(?:の)?売上|仕向地別|海外売上高|geographic(?:al)? (?:area|information|region)|revenues? by (?:geograph|region|country)/i;

/**
 * The text a page contributes: all of it up to MAX_WEB_TEXT_CHARS, else its
 * start and an excerpt at its first sales-by-region table after the start.
 * Cutting at 10,000 characters dropped the region tables of long pages
 * (有価証券報告書 texts), so 【海外】 could not name the countries
 * (ADR-0064 §5f). A quote cannot span the "…" between the two parts.
 */
export function pageTextForModel(text: string): string {
	if (text.length <= MAX_WEB_TEXT_CHARS) return text;
	const head = text.slice(0, PAGE_HEAD_CHARS);
	const rest = text.slice(PAGE_HEAD_CHARS);
	const match = REGION_SALES_HEADING.exec(rest);
	if (match === null) return text.slice(0, MAX_WEB_TEXT_CHARS);
	const start = Math.max(0, match.index - REGION_EXCERPT_LEAD_CHARS);
	return `${head}\n…\n${rest.slice(start, start + REGION_EXCERPT_CHARS)}`;
}

export const EXCLUDED_HOST_SUFFIXES = [
	"wikipedia.org",
	"wikiwand.com",
	"weblio.jp",
	// User-written wikis, like Wikipedia (ニコニコ大百科 came back for Sony, 2026-11-04).
	"dic.nicovideo.jp",
	"dic.pixiv.net",
	"fandom.com",
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
	// Tavily's own company profiles: machine-written, not a publisher's page.
	"tavily.com",
	// Job boards: recruiting copy about the company, not its own or a regulator's page.
	"mynavi.jp",
	"rikunabi.com",
	"career-tasu.jp",
	"careerforum.net",
	"en-japan.com",
	"doda.jp",
	"onecareer.jp",
	"openwork.jp",
	"glassdoor.com",
	"indeed.com",
	"bizreach.jp",
	"jinjibu.jp",
	"geekly.co.jp",
	"fact-board.com",
	"baseme.app",
	"sincereed-agent.com",
	"jobhakase.com",
	// Recruiting pages the review of 2026-11-05 found cited by 292 stocks.
	"mynavi-agent.jp",
	"r-agent.com",
	"hrmos.co",
	"wantedly.com",
	"herp.careers",
	"corp-research.jp",
	"agrijob.jp",
	// Blogs, a Wikipedia mirror and investor forums (same review).
	"wikid.org",
	"gem.wiki",
	"hatenablog.com",
	"hatenablog.jp",
	"hateblo.jp",
	"hatena.ne.jp",
	"tradingview.com",
	"seekingalpha.com",
	"stocktwits.com",
	// Licensed editorial company blurbs and quote pages, copied near word for word
	// like 会社四季報's would be (review of 2026-11-04).
	"nikkei.com",
	"kabuyoho.jp",
	"minkabu.jp",
	"kabutan.jp",
	"finance.yahoo.co.jp",
	"finance.yahoo.com",
	"investing.com",
	// Machine-written analysis ("[生成AI分析]").
	"marklines.com",
	// Contact-list aggregators with no business prose.
	"zoominfo.com",
	"rocketreach.co",
	"datanyze.com",
	// Pages the runner's fetcher cannot read (bot walls, script-only pages): at most
	// 15% of their picks were read in the 2026-11-04 runs (roic.ai 2 of 74, CEF
	// Connect 11 of 82, barchart.com 0 of 45), so a pick there wasted a page.
	"roic.ai",
	"cefconnect.com",
	"gurufocus.com",
	"simplywall.st",
	"stocknear.com",
	"barchart.com",
	"capedge.com",
	"craft.co",
	"pitchbook.com",
	"app.edgar.tools",
	"ycharts.com",
	"rallies.ai",
	"morningstar.com.au",
	"financialreports.eu",
	"business.mammothtimes.com",
];

/**
 * Hosts named like job or recruiting sites, beyond the listed ones: any
 * registered name containing these words (mid-tenshoku, typeshukatsu,
 * careermap, j-career…), and a company's own recruiting subdomain
 * (recruit.…, saiyo.…), which describes jobs rather than the business.
 */
const JOB_SITE_WORDS = /tenshoku|shukatsu|career|jinzai|kyujin|baito|hellowork/;
const RECRUITING_SUBDOMAIN = /^(recruit|recruits|saiyo|saiyou|careers?|jobs?)[.-]/;

/** Whether a host is a job or recruiting site by its name. */
export function isJobSiteHost(host: string): boolean {
	const label = registeredLabel(host) ?? "";
	// Only the labels before the registered name: recruit-holdings.com is Recruit's own site.
	const subdomains = host.replace(/^www\./, "").split(`${label}.`)[0] ?? "";
	return JOB_SITE_WORDS.test(label) || RECRUITING_SUBDOMAIN.test(subdomains);
}

/**
 * Company registers: one page per registered company, listed or not
 * (法人番号 databases). A Japanese name is shared by many companies, so a
 * register page counts for a Japanese stock only when it shows the stock
 * code, as its listed companies' pages do (「1333 東証プライム」,
 * 「証券コード | 1992」). The review of 2026-11-05 found entries quoting an
 * unlisted namesake (JP:6555 a 有限会社エムエス・コンサルティング, JP:4055).
 */
const COMPANY_REGISTER_HOST_SUFFIXES = [
	"compalyze.co.jp",
	"atsoho.com",
	"salesnow.jp",
	"houjin.jp",
	"biz.ne.jp",
	"tsr-net.co.jp",
	"baseconnect.in",
	"alarmbox.jp",
];

/** Whether a page is a company register's page that does not show this Japanese stock's code. */
export function isRegisterPageOfAnother(
	url: string,
	pageText: string,
	stock: { readonly market: string; readonly symbol: string },
): boolean {
	const host = hostOf(url);
	if (stock.market !== "JP" || host === null) return false;
	if (!hasSuffix(host, COMPANY_REGISTER_HOST_SUFFIXES)) return false;
	const code = new RegExp(`(?<![0-9A-Z])${stock.symbol}(?![0-9A-Z])`);
	return !code.test(pageText.normalize("NFKC"));
}

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

/** Words a company's own domain adds to its name ("toyota-global", "sony-hd"). */
const SITE_WORDS = new Set([
	"global",
	"group",
	"grp",
	"corp",
	"corporate",
	"company",
	"inc",
	"ir",
	"investor",
	"investors",
	"hd",
	"hds",
	"hldgs",
	"holdings",
	"jp",
	"japan",
	"us",
	"usa",
	"world",
]);

/** Second-level labels under a country code: "toyota.co.jp" is registered as "toyota". */
const SECOND_LEVEL_LABELS = new Set([
	"co",
	"or",
	"ne",
	"ac",
	"go",
	"gr",
	"ed",
	"lg",
	"com",
	"net",
	"org",
]);

/** The registered name of a host without its public suffix: "ir.toyota.co.jp" → "toyota". */
export function registeredLabel(host: string): string | null {
	const labels = host.split(".");
	const tld = labels.pop();
	if (tld === undefined) return null;
	const last = labels.at(-1);
	if (
		tld.length === 2 &&
		last !== undefined &&
		SECOND_LEVEL_LABELS.has(last) &&
		labels.length > 1
	) {
		labels.pop();
	}
	return labels.at(-1) ?? null;
}

/**
 * Romanized words of Japanese company names and the kanji they stand for.
 * Many Japanese companies name their site after the Japanese name
 * (スバル興業 is subaru-kougyou.jp, not "Subaru Enterprise"), so a word
 * counts as part of the name when the Japanese name has its kanji. Only
 * then: subaru-kougyou.jp must not pass as SUBARU's own site.
 */
const ROMANIZED_NAME_WORDS: readonly (readonly [readonly string[], readonly string[]])[] = [
	[
		["kogyo", "kougyou", "kogyou", "kougyo"],
		["興業", "工業", "鉱業"],
	],
	[["sangyo", "sangyou"], ["産業"]],
	[["shoji", "shouji", "syoji"], ["商事"]],
	[["shokai", "syokai", "shoukai"], ["商会"]],
	[["shoten", "syoten", "shouten"], ["商店"]],
	[["kensetsu"], ["建設"]],
	[["denki"], ["電気", "電機"]],
	[["denko", "denkou"], ["電工"]],
	[["seiyaku"], ["製薬"]],
	[["shokuhin", "syokuhin"], ["食品"]],
	[["unyu"], ["運輸"]],
	[["soko", "souko"], ["倉庫"]],
	[["seisakusho", "seisakujo"], ["製作所"]],
	[
		["tekko", "tekkou"],
		["鉄工", "鉄鋼"],
	],
	[["kosan", "kousan"], ["興産"]],
	[["kaihatsu"], ["開発"]],
	[["fudosan", "fudousan"], ["不動産"]],
	[["shoken", "shouken"], ["証券"]],
	[["kagaku"], ["化学"]],
	[["kikai"], ["機械"]],
	[["seiko", "seikou"], ["精工"]],
	[["jidosha", "jidousha"], ["自動車"]],
	[["zosen", "zousen"], ["造船"]],
	[["seishi"], ["製紙"]],
	[["seifun"], ["製粉"]],
	[["seito", "seitou"], ["製糖"]],
];

/** The romanized words whose kanji the Japanese name has. */
function romanizedWordsOf(localName: string): string[] {
	return ROMANIZED_NAME_WORDS.flatMap(([words, kanji]) =>
		kanji.some((text) => localName.includes(text)) ? [...words] : [],
	);
}

/** Whether `text` is made only of `tokens` run together ("colacompany" = cola + company). */
function isMadeOf(text: string, tokens: ReadonlySet<string>): boolean {
	const reachable = new Array<boolean>(text.length + 1).fill(false);
	reachable[0] = true;
	for (let end = 1; end <= text.length; end += 1) {
		for (let start = 0; start < end && !reachable[end]; start += 1) {
			if (reachable[start] && tokens.has(text.slice(start, end))) reachable[end] = true;
		}
	}
	return reachable[text.length] === true;
}

/**
 * Where a result stands in the acceptance order, or null when it is never used.
 *
 * A host is the company's own when its registered name is built from the
 * company's name ("coca-colacompany" for COCA COLA CO, "toyota" for TOYOTA
 * MOTOR). One that only starts with a distinctive word of it is an
 * ordinary page: "akikawabokuen" is AKIKAWA FOODS & FARMS's own site, but
 * "shochikugeino" is 松竹芸能's, not SHOCHIKU's. A registered name with a
 * distinctive word plus a hyphenated word the name lacks ("toyota-body",
 * "toyota-ej") belongs to a different company of the same family and is
 * never read: its profile page would pass the quote check while
 * describing someone else. `localName` (the Japanese name) adds the
 * romanized words of its kanji ("kougyou" for スバル興業).
 */
export function pageKind(url: string, companyName: string, localName = ""): PageKind | null {
	const host = hostOf(url);
	if (host === null || !url.startsWith("https://")) return null;
	if (hasSuffix(host, EXCLUDED_HOST_SUFFIXES) || isJobSiteHost(host)) return null;
	if (hasSuffix(host, REGULATOR_HOST_SUFFIXES)) return "regulator";
	const label = registeredLabel(host);
	if (label === null) return "other";
	const distinctive = nameWords(companyName);
	if (!distinctive.some((word) => label.replaceAll("-", "").includes(word))) return "other";
	const tokens = new Set([
		...companyName
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((word) => word.length >= 2),
		...SITE_WORDS,
		...romanizedWordsOf(localName),
	]);
	const parts = label.split("-").filter((part) => part !== "");
	if (parts.every((part) => isMadeOf(part, tokens))) return "official";
	return parts.length === 1 ? "other" : null;
}

const KIND_ORDER: Record<PageKind, number> = { official: 0, regulator: 1, other: 2 };

/** The search results to read: acceptable ones, official first, in search order within a kind. */
export function choosePages(
	results: readonly { readonly url: string }[],
	companyName: string,
	limit: number,
	order: "by-kind" | "as-given" = "by-kind",
	localName = "",
): { url: string; kind: PageKind }[] {
	const seen = new Set<string>();
	const ranked: { url: string; kind: PageKind; rank: number }[] = [];
	results.forEach((result, rank) => {
		const kind = pageKind(result.url, companyName, localName);
		if (kind === null || seen.has(result.url)) return;
		seen.add(result.url);
		ranked.push({ url: result.url, kind, rank });
	});
	// The Haiku agent already ranked its picks (company site first); Tavily's results are ranked here.
	if (order === "by-kind") {
		ranked.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.rank - b.rank);
	}
	return ranked.slice(0, limit).map(({ url, kind }) => ({ url, kind }));
}

export interface WebTools {
	/** Tavily's `web.search`; null without TAVILY_API_KEY (the Haiku agent searches then). */
	readonly search: ToolDefinition | null;
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
	const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() || null;
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
	return {
		search: tavilyApiKey === null ? null : find("web.search"),
		fetchPage: find("web.fetch_page"),
	};
}

function toolContext(runId: string): ToolContext {
	let next = 0;
	return {
		runId,
		leaseGeneration: 1,
		signal: AbortSignal.timeout(120_000),
		nowIso: () => new Date().toISOString(),
		nextId: (prefix) => {
			next += 1;
			return `${runId}_${prefix}${next}`;
		},
		subscribedSources: [],
	};
}

/** The URL with a "/" added to a path that has none and no file extension, or null. */
export function withTrailingSlash(url: string): string | null {
	if (!URL.canParse(url)) return null;
	const parsed = new URL(url);
	const last = parsed.pathname.split("/").at(-1) ?? "";
	if (last === "" || last.includes(".")) return null;
	parsed.pathname = `${parsed.pathname}/`;
	return parsed.href;
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

interface ReadPage {
	readonly url: string;
	readonly title: string;
	readonly publisher: string;
	readonly publishedAt: string | null;
	readonly retrievedAt: string;
	readonly text: string;
}

function readPageOf(page: CollectedEvidence): ReadPage {
	return {
		url: page.evidence.sourceUrl,
		title: page.evidence.title,
		publisher: page.evidence.publisher,
		publishedAt: page.evidence.publishedAt ?? null,
		retrievedAt: page.evidence.retrievedAt,
		text: page.retrievedText,
	};
}

/** A fetched page as a numbered source: its host as the publisher; its kind and retrieval day as a note, in both languages. */
function pageSource(id: SourceId, page: ReadPage, kind: PageKind): CompanySource {
	const day = page.retrievedAt.slice(0, 10);
	const title = page.title.slice(0, 280) || page.url.slice(0, 280);
	const host = hostOf(page.url) ?? page.publisher;
	return {
		id,
		title: { en: title, ja: title },
		publisher: host.slice(0, 300),
		asOf: page.publishedAt?.slice(0, 10) ?? null,
		url: page.url,
		note: {
			en: `${KIND_LABEL[kind].en[0]?.toUpperCase()}${KIND_LABEL[kind].en.slice(1)}. Retrieved ${day}.`,
			ja: `${KIND_LABEL[kind].ja}。${day} 取得。`,
		},
		text: pageTextForModel(page.text),
	};
}

/**
 * Why the runner's fetcher could not read a page, for which the Claude API's
 * web fetch tool may try instead: the site refused bots (HTTP error), the
 * page renders only by script, it is over 2 MiB, or it timed out. A page
 * robots.txt refuses, a rejected address or redirect, and a PDF are never
 * retried this way.
 */
const FALLBACK_REASONS = new Set([
	"HTTP_ERROR",
	"EMPTY_PAGE",
	"RESPONSE_TOO_LARGE",
	"TIMEOUT",
	"no readable text",
]);

/** The Claude API's web fetch, as the fallback reader (claudePageFinder.ts `fetchText`). */
export type FallbackRead = (url: string) => Promise<
	| {
			readonly ok: true;
			readonly url: string;
			readonly title: string | null;
			readonly text: string;
			readonly retrievedAt: string;
			readonly costUsd: number;
	  }
	| { readonly ok: false; readonly detail: string; readonly costUsd: number }
>;

export interface WebSourcesResult {
	readonly stock: StockSources;
	/** What happened to each candidate, for the run's report. */
	readonly log: readonly string[];
	/** Why the search failed (its tool error code and detail), or null when it answered. */
	readonly searchFailure: { readonly code: string; readonly detail: string } | null;
	/** What finding the pages cost (the Haiku agent's tokens and searches; Tavily's is not metered here). */
	readonly costUsd: number;
}

/** How a stock's candidate pages are found: Tavily (`web.search`) or the Haiku agent. */
export type PageSearch = (
	stock: StockSources,
	log: string[],
) => Promise<
	| {
			readonly ok: true;
			readonly urls: readonly string[];
			readonly order: "by-kind" | "as-given";
			readonly costUsd: number;
	  }
	| { readonly ok: false; readonly code: string; readonly detail: string; readonly costUsd: number }
>;

/** Tavily through the runner's own `web.search`, one query per stock. */
export function tavilyPageSearch(search: ToolDefinition): PageSearch {
	return async (stock, log) => {
		const context = toolContext(`poc_search_${randomUUID().slice(0, 8)}`);
		const query = searchQuery(stock);
		const searched = await searchWithRetries(search, query, context, log);
		if (!searched.ok) {
			return { ok: false, code: searched.error.code, detail: searched.error.detail, costUsd: 0 };
		}
		log.push(`search "${query}": ${searched.value.evidence.length} results`);
		return {
			ok: true,
			urls: searched.value.evidence.map((item) => item.evidence.sourceUrl),
			order: "by-kind",
			costUsd: 0,
		};
	};
}

/** Search attempts per stock: a pause or a transient error is waited out this many times. */
const SEARCH_ATTEMPTS = 4;
/** The wait after a transient search error (timeout, network, HTTP 5xx). */
const TRANSIENT_SEARCH_PAUSE_MS = 10_000;

/** The seconds a SEARCH_COOLDOWN answer says the search is paused for (60 when unreadable). */
export function cooldownSeconds(detail: string): number {
	const match = /paused for (\d+) seconds/.exec(detail);
	return match?.[1] === undefined ? 60 : Number(match[1]);
}

/**
 * One web search, tried again after the search tool's outage pause or a
 * transient error. One 15 s timeout opened a 60 s pause on 2026-11-04 and,
 * with eight stocks searching at once, the run counted the paused searches
 * as failures and stopped using the web after 368 of its credits.
 */
async function searchWithRetries(
	search: ToolDefinition,
	query: string,
	context: ToolContext,
	log: string[],
): ReturnType<ToolDefinition["execute"]> {
	for (let attempt = 1; ; attempt += 1) {
		const searched = await search.execute({ query }, context);
		if (searched.ok || attempt === SEARCH_ATTEMPTS) return searched;
		const { code, detail } = searched.error;
		const transient = code === "SEARCH_COOLDOWN" || /TIMEOUT|NETWORK_ERROR|HTTP 5\d\d/.test(detail);
		if (!transient) return searched;
		const waitMs =
			code === "SEARCH_COOLDOWN"
				? cooldownSeconds(detail) * 1_000 + Math.floor(Math.random() * 5_000)
				: TRANSIENT_SEARCH_PAUSE_MS;
		log.push(`search ${code}, trying again in ${Math.round(waitMs / 1_000)} s`);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
}

/** The stock's sources with up to MAX_WEB_PAGES web pages appended as the next ids. */
export async function withWebSources(
	stock: StockSources,
	findPages: PageSearch,
	fetchPage: ToolDefinition,
	fallbackRead: FallbackRead | null = null,
): Promise<WebSourcesResult> {
	const context = toolContext(`poc_web_${randomUUID().slice(0, 8)}`);
	const log: string[] = [];
	const found = await findPages(stock, log);
	if (!found.ok) {
		log.push(`search failed (${found.code}): ${found.detail}`);
		return {
			stock,
			log,
			searchFailure: { code: found.code, detail: found.detail },
			costUsd: found.costUsd,
		};
	}
	// Every acceptable result in order; a page that fails gives its place to the next one.
	const candidates = choosePages(
		found.urls.map((url) => ({ url })),
		stock.name.en,
		MAX_WEB_PAGE_ATTEMPTS,
		found.order,
		stock.name.ja,
	);
	log.push(`${found.urls.length} pages found, ${candidates.length} acceptable`);
	const sources = [...stock.sources];
	let read = 0;
	let costUsd = found.costUsd;
	for (const page of candidates) {
		if (read === MAX_WEB_PAGES) break;
		let fetched = await fetchPage.execute({ url: page.url }, context);
		const slashed = withTrailingSlash(page.url);
		if (!fetched.ok && fetched.error.code === "UNSAFE_REDIRECT" && slashed !== null) {
			// Many Japanese company sites redirect "/company" to "http://…/company/";
			// the https URL with the slash serves the same page.
			fetched = await fetchPage.execute({ url: slashed }, context);
		}
		const evidence = fetched.ok ? fetched.value.evidence[0] : undefined;
		let readPage: ReadPage | null =
			evidence !== undefined && evidence.retrievedText.trim().length >= 200
				? readPageOf(evidence)
				: null;
		let via = "";
		if (readPage === null) {
			const reason = fetched.ok ? "no readable text" : fetched.error.code;
			if (fallbackRead === null || !FALLBACK_REASONS.has(reason)) {
				log.push(`skipped ${page.url}: ${reason}`);
				continue;
			}
			const fallback = await fallbackRead(page.url);
			costUsd += fallback.costUsd;
			if (!fallback.ok || fallback.text.length < 200) {
				log.push(
					`skipped ${page.url}: ${reason}, web fetch: ${fallback.ok ? "no readable text" : fallback.detail}`,
				);
				continue;
			}
			readPage = {
				url: page.url,
				title: fallback.title ?? "",
				publisher: hostOf(page.url) ?? "",
				publishedAt: null,
				retrievedAt: fallback.retrievedAt,
				text: fallback.text,
			};
			via = ` (web fetch after ${reason})`;
		}
		if (isRegisterPageOfAnother(readPage.url, `${readPage.title}\n${readPage.text}`, stock.stock)) {
			log.push(`skipped ${page.url}: a company register page without the stock code`);
			continue;
		}
		const id: SourceId = `S${sources.length + 1}`;
		sources.push(pageSource(id, readPage, page.kind));
		read += 1;
		log.push(`${id} ${page.kind} ${readPage.url}${via}`);
	}
	return { stock: { ...stock, sources }, log, searchFailure: null, costUsd };
}
