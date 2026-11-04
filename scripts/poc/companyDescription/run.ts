/**
 * PoC: write 事業概要 (the company overview, ADR-0064) with Claude Haiku 5.5,
 * following the template in template.ts, and check every field's evidence
 * against its sources: the stored records and up to three public web pages
 * (webSources.ts).
 *
 *   node --env-file=.env scripts/poc/companyDescription/run.ts [--db <sqlite file>] [--out <dir>]
 *     [--store] [--all] [--limit <n>] [--concurrency <n>] [--force] [--rewrite-before <ISO>]
 *     [--no-web | --web-all] [--search claude|tavily] [--backend claude-code|claude-api]
 *     [MARKET:SYMBOL ...]
 *
 * Backend (ADR-0064 §2d): `claude-code` (the default) runs Haiku 5.5 through
 * the Claude Code CLI on the owner's subscription login — writing turns with
 * no tools (the claude-code adapter), page searches with WebSearch only
 * (claudeCodePageFinder.ts) — pausing when the plan's 5-hour window is
 * nearly used and stopping when its 7-day window is (runPolicy.ts
 * `PlanGate`); there is no web-fetch fallback. `claude-api` uses the metered
 * Claude API (ANTHROPIC_API_KEY) as before.
 *
 * Which stocks: the ones named, else every stock-list stock with `--all`
 * (sources.ts `directoryStocks` gives the order), else the Watchlist. A
 * stock whose overview is already stored is skipped unless `--force` or
 * `--rewrite-before` says otherwise, so an interrupted run resumes where it
 * stopped; a rewrite keeps the stored entry when the new one is less full
 * (runPolicy.ts `mayReplace`). `--limit` caps how many are written.
 *
 * Web pages: by default only a stock without a stored business text (every
 * Japanese stock, a US one without a 10-K Item 1) is searched — by a Claude
 * Haiku 5.5 agent with the Claude API's web search tool (claudePageFinder.ts,
 * about USD 0.02 a stock) or, with `--search tavily`, by Tavily;
 * `--web-all` searches every stock and `--no-web` none. Five failed searches
 * in a row pause searching for five minutes (runPolicy.ts `WebBudget`). A
 * stock left with no business text and no web page is skipped without a
 * model turn: a sector code and figures describe no business.
 *
 * A page the runner's fetcher cannot read (HTTP error, script-only page,
 * over 2 MiB, timeout) is read once more with the Claude API's web fetch
 * tool. A preferred share, warrant, unit or right whose issuer is listed
 * copies the issuer's entry once every other stock is done.
 *
 * Each reply is checked for evidence (evidence.ts: quotes word for word,
 * numbers, and names that appear in no cited source) and for style
 * (style.ts); a problem asks for the one repair turn. An entry is stored
 * only when it describes the business and, when a source describes it, has
 * a 【事業内容】 (runPolicy.ts `storeRefusal`).
 *
 * Runs under Node: the web step's safe fetcher does not work under Bun, and
 * the store step needs node:sqlite.
 *
 * Reads the development database (data-dev) read-only by default and calls
 * the Claude API through the project's own adapter (ANTHROPIC_API_KEY from
 * .env), one turn per stock plus at most one repair turn — the same shape
 * as the production `company-summary` job (ADR-0060). Writes, per stock,
 * `<MARKET>-<SYMBOL>.html` (the section in Japanese and English, laid out
 * like a 会社四季報 entry, and the check result), `.json` (the reply and the
 * sources), `.replies.json` (raw replies) and `.overview.json` (what is
 * stored), and one line per stock to `run.jsonl`. With `--store` each
 * stock's overview is written to the database as soon as it is checked.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createClaudeApiRuntime,
	createClaudeCodeRuntime,
	createNodeProcessRunner,
} from "@research/adapters/providers";
import { type AgentRuntime, parseAgentEvent, type ToolDefinition } from "@research/agent-core";
import { CLAUDE_API_AGENT_ID, type CompanyOverviewView } from "@research/contracts";
import { createClaudeCodePageFinder } from "./claudeCodePageFinder.ts";
import { createClaudePageFinder } from "./claudePageFinder.ts";
import { checkDescription, describeProblems, keepVerified } from "./evidence.ts";
import { companyDescriptionPrompt } from "./prompt.ts";
import { renderCheck, renderPage, renderSection } from "./render.ts";
import { parseReply, salvageReply } from "./reply.ts";
import {
	ISSUER_NOT_WRITTEN,
	isOutOfCredit,
	KEPT_STORED,
	mayReplace,
	NO_BUSINESS_SOURCE,
	PlanGate,
	recentlyUnreadableIn,
	type SearchProvider,
	storeRefusal,
	UNREADABLE_DAYS,
	WebBudget,
} from "./runPolicy.ts";
import {
	directoryStocks,
	issuerFinder,
	ownerOf,
	readStockSources,
	type StockKey,
	type StockSources,
	storedOverviewEntry,
	storedOverviewKeys,
	storedOverviewView,
	watchlistStocks,
} from "./sources.ts";
import { type StoredOverview, storeOverviews } from "./storeOverview.ts";
import { styleProblems } from "./style.ts";
import type { DescriptionToCheck, VerifiedDescription } from "./template.ts";
import {
	createWebTools,
	EXCLUDED_HOST_SUFFIXES,
	type FallbackRead,
	type PageSearch,
	tavilyPageSearch,
	withWebSources,
} from "./webSources.ts";

const MODEL = "claude-haiku-5-5";
const TURN_DEADLINE_MS = 300_000;
/** Rate-limited writing turns one stock waits out before it counts as failed. */
const PLAN_RATE_LIMIT_WAITS = 10;

function devDatabasePath(): string {
	const directory = "data-dev/d1/v3/d1/miniflare-D1DatabaseObject";
	const files = readdirSync(directory).filter(
		(name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
	);
	const [file] = files;
	if (file === undefined || files.length > 1) {
		throw new Error(`expected one D1 database in ${directory}, found ${files.length}; pass --db`);
	}
	return join(directory, file);
}

type WebPolicy = "missing-text" | "all" | "none";

type Backend = "claude-code" | "claude-api";

interface Args {
	readonly backend: Backend;
	readonly db: string;
	readonly out: string;
	readonly store: boolean;
	readonly web: WebPolicy;
	readonly search: SearchProvider;
	readonly all: boolean;
	readonly limit: number | null;
	readonly concurrency: number;
	readonly force: boolean;
	/** Rewrite stored entries written before this instant (ISO), keeping a fuller stored one. */
	readonly rewriteBefore: string | null;
	readonly stocks: StockKey[] | null;
}

function positiveInteger(flag: string, value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`${flag} expects a positive integer, got ${value}`);
	}
	return parsed;
}

function parseArgs(argv: readonly string[]): Args {
	let db: string | null = null;
	let store = false;
	let web: WebPolicy = "missing-text";
	let search: SearchProvider = "claude";
	let backend: Backend = "claude-code";
	let all = false;
	let limit: number | null = null;
	let concurrency = 1;
	let force = false;
	let rewriteBefore: string | null = null;
	let out = "scripts/poc/companyDescription/output";
	const stocks: StockKey[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db") db = argv[++index] ?? null;
		else if (arg === "--out") out = argv[++index] ?? out;
		else if (arg === "--store") store = true;
		else if (arg === "--no-web") web = "none";
		else if (arg === "--web-all") web = "all";
		else if (arg === "--search") {
			const value = argv[++index];
			if (value !== "claude" && value !== "tavily") {
				throw new Error(`--search expects claude or tavily, got ${value}`);
			}
			search = value;
		} else if (arg === "--backend") {
			const value = argv[++index];
			if (value !== "claude-code" && value !== "claude-api") {
				throw new Error(`--backend expects claude-code or claude-api, got ${value}`);
			}
			backend = value;
		} else if (arg === "--all") all = true;
		else if (arg === "--force") force = true;
		else if (arg === "--rewrite-before") {
			const value = argv[++index] ?? "";
			if (Number.isNaN(Date.parse(value))) {
				throw new Error(`--rewrite-before expects an ISO instant, got ${value}`);
			}
			rewriteBefore = new Date(value).toISOString();
		} else if (arg === "--limit") limit = positiveInteger(arg, argv[++index]);
		else if (arg === "--concurrency") concurrency = positiveInteger(arg, argv[++index]);
		else if (arg !== undefined) {
			const match = /^(US|JP):([A-Z0-9.-]{1,16})$/.exec(arg);
			if (match?.[1] === undefined || match[2] === undefined) {
				throw new Error(`expected MARKET:SYMBOL, got ${arg}`);
			}
			stocks.push({ market: match[1] === "US" ? "US" : "JP", symbol: match[2] });
		}
	}
	if (all && stocks.length > 0)
		throw new Error("--all and MARKET:SYMBOL arguments exclude each other");
	return {
		backend,
		db: db ?? devDatabasePath(),
		out,
		store,
		web,
		search,
		all,
		limit,
		concurrency,
		force,
		rewriteBefore,
		stocks: stocks.length === 0 ? null : stocks,
	};
}

const providerEnvironment = {
	processRunner: createNodeProcessRunner(),
	fetch: globalThis.fetch,
	env: process.env,
};
/** The writing turns' runtime and the agent id stored with the entry; set by `main` from `--backend`. */
let agent: AgentRuntime = createClaudeCodeRuntime(providerEnvironment);
let agentId: string = "claude-code";
/** An empty directory the CLI runs in (no project files, no CLAUDE.md); set by `main`. */
let scratchDirectory: string | null = null;

interface TurnResult {
	readonly text: string;
	readonly costUsd: number | null;
}

/** One model turn with no tools; throws with the provider's failure code. */
async function modelTurn(prompt: string, runId: string): Promise<TurnResult> {
	let text = "";
	let costUsd: number | null = null;
	const events = agent.run(
		{
			runId,
			conversationId: runId,
			prompt,
			permittedToolIds: [],
			maxToolCalls: 0,
			deadline: new Date(Date.now() + TURN_DEADLINE_MS).toISOString(),
		},
		{
			signal: AbortSignal.timeout(TURN_DEADLINE_MS),
			// The claude-code adapter runs the CLI in it; the API ignores it.
			scratchDirectory: scratchDirectory,
			model: MODEL,
			effort: "medium",
		},
	);
	for await (const raw of events) {
		const parsed = parseAgentEvent(raw);
		if (!parsed.ok) throw new Error("AGENT_EVENT_INVALID");
		const event = parsed.value;
		if (event.type === "text.delta") text += event.text;
		else if (event.type === "usage") costUsd = event.knownCostUsd ?? null;
		else if (event.type === "failed") {
			throw new Error(
				`${event.code}${event.upstreamStatus ? ` (HTTP ${event.upstreamStatus})` : ""}`,
			);
		} else if (event.type === "completed") return { text, costUsd };
	}
	throw new Error("AGENT_STREAM_ENDED_EARLY");
}

interface StockOutcome {
	readonly stock: string;
	readonly turns: number;
	readonly costUsd: number;
	readonly verified: number;
	readonly total: number;
	/** How many web pages were among the sources. */
	readonly webPages: number;
	/** Whether a web search answered for this stock (its credit was spent). */
	readonly searched: boolean;
	/** Who searched: "claude" (the Haiku agent) or "tavily"; null when nobody did. */
	readonly searchedWith: SearchProvider | null;
	readonly stored: boolean;
	/** Why nothing was written, or null. */
	readonly error: string | null;
}

/** The stored form of a verified overview: the references without the source text. */
function overviewView(
	stock: StockSources,
	entry: CompanyOverviewView["entry"],
	generatedAt: string,
): CompanyOverviewView {
	return {
		entry,
		facts: {
			listing: stock.profile.listing,
			sector: stock.profile.sector,
			fiscalYearEnd: stock.profile.fiscalYearEnd,
			figures: [...stock.figures],
			cites: stock.cites,
		},
		references: stock.sources.map(({ text: _text, ...reference }) => reference),
		agentId,
		model: MODEL,
		generatedAt,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The owner's local day (sv-SE formats as YYYY-MM-DD), not the UTC one. */
function localDay(): string {
	return new Date().toLocaleDateString("sv-SE");
}

interface Described {
	readonly outcome: Omit<StockOutcome, "webPages" | "stored" | "searched" | "searchedWith">;
	readonly overview: StoredOverview | null;
}

async function describeStock(
	stock: StockSources,
	ownerId: string,
	out: string,
	stored: VerifiedDescription | null,
): Promise<Described> {
	const label = `${stock.stock.market}:${stock.stock.symbol}`;
	const runId = `poc_${stock.stock.symbol}_${Date.now()}`;
	const today = localDay();
	const prompt = (repairNote: string | null) =>
		companyDescriptionPrompt({
			stock,
			fenceToken: randomBytes(12).toString("hex"),
			repairNote,
			today,
		});
	let costUsd = 0;
	let turns = 0;
	let repairNote: string | null = null;
	let lastDescription: DescriptionToCheck | null = null;
	let lastJson: unknown = null;
	const replies: string[] = [];
	// One turn plus at most one repair turn, like the production job.
	while (turns < 2) {
		turns += 1;
		const reply = await modelTurn(prompt(repairNote), `${runId}_${turns}`);
		costUsd += reply.costUsd ?? 0;
		replies.push(reply.text);
		const parsed = parseReply(reply.text);
		if (!parsed.ok) {
			repairNote = parsed.message;
			lastJson = parsed.json;
			continue;
		}
		lastJson = null;
		lastDescription = parsed.description;
		const problems = [
			...describeProblems(checkDescription(parsed.description, stock.sources)),
			// Wording only: asks for the repair turn, never removes a field.
			...styleProblems(parsed.description, stock.sources),
		];
		if (parsed.description.businesses.length === 0) {
			// 【事業内容】 is the summary of the business: always written when a source describes it.
			problems.push(
				"businesses: 【事業内容】 is empty, but the sources describe the business; write its summary.",
			);
		}
		if (problems.length === 0) break;
		repairNote = problems.join("\n");
	}
	if (lastDescription === null && lastJson !== null) lastDescription = salvageReply(lastJson);
	const stem = join(out, `${stock.stock.market}-${stock.stock.symbol}`);
	writeFileSync(`${stem}.replies.json`, JSON.stringify(replies, null, 2));
	if (lastDescription === null) {
		return {
			outcome: { stock: label, turns, costUsd, verified: 0, total: 0, error: repairNote },
			overview: null,
		};
	}
	const checked = checkDescription(lastDescription, stock.sources);
	const verified = keepVerified(lastDescription, checked);
	const sections = (["ja", "en"] as const).map((language) =>
		renderSection({ stock, description: verified, language, model: MODEL, generatedOn: today }),
	);
	writeFileSync(
		`${stem}.html`,
		renderPage({
			title: `事業概要 — ${stock.name.ja} (${stock.stock.symbol})`,
			sections,
			check: renderCheck(checked),
		}),
	);
	writeFileSync(
		`${stem}.json`,
		JSON.stringify({ description: lastDescription, sources: stock.sources }, null, 2),
	);
	const refusal = storeRefusal(verified, stock);
	const outcome = {
		stock: label,
		turns,
		costUsd,
		verified: checked.filter((item) => item.problems.length === 0).length,
		total: checked.length,
		error: refusal ?? (mayReplace(verified, stored) ? null : KEPT_STORED),
	};
	if (outcome.error !== null) return { outcome, overview: null };
	// What the store step writes to the database (ADR-0064).
	const overview: StoredOverview = {
		ownerId,
		market: stock.stock.market,
		symbol: stock.stock.symbol,
		overview: overviewView(stock, verified, new Date().toISOString()),
	};
	writeFileSync(`${stem}.overview.json`, JSON.stringify(overview, null, 2));
	return { outcome, overview };
}

/** A model failure worth another try after a pause: rate limit, overload, server error. */
function isTransient(message: string): boolean {
	return /HTTP (429|5\d\d)|RATE_LIMIT|OVERLOAD|UNAVAILABLE|TIMEOUT|NETWORK/i.test(message);
}

const TRANSIENT_RETRIES = 3;
const TRANSIENT_PAUSE_MS = 30_000;

/** Reads while the database file cannot be opened for a moment, and the pause between them. */
const DATABASE_ATTEMPTS = 6;
const DATABASE_PAUSE_MS = 5_000;

/**
 * A stock's sources, read again after a pause when the database cannot be
 * opened for a moment ("unable to open database file", "database is
 * locked"). On 2026-11-04 a two-second outage failed 189 stocks in a row,
 * because the run moved straight on to the next one.
 */
async function readSourcesWithRetries(db: string, key: StockKey): Promise<StockSources> {
	for (let attempt = 1; ; attempt += 1) {
		try {
			return readStockSources(db, key);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const passing = /unable to open database|database is locked|SQLITE_BUSY/i.test(message);
			if (!passing || attempt === DATABASE_ATTEMPTS) throw error;
			await new Promise((resolve) => setTimeout(resolve, DATABASE_PAUSE_MS * attempt));
		}
	}
}

/**
 * The page search the run uses, and the fallback reader for pages the
 * runner's fetcher cannot read (the Claude API's web fetch; none with
 * Tavily). The Haiku agent needs ANTHROPIC_API_KEY, Tavily TAVILY_API_KEY.
 */
function pageSearchFor(
	provider: SearchProvider,
	tavily: ToolDefinition | null,
	backend: Backend,
	out: string,
	plan: PlanGate,
): { readonly find: PageSearch; readonly fallbackRead: FallbackRead | null } {
	if (provider === "tavily") {
		if (tavily === null) throw new Error("--search tavily needs TAVILY_API_KEY");
		return { find: tavilyPageSearch(tavily), fallbackRead: null };
	}
	if (backend === "claude-code") {
		const finder = createClaudeCodePageFinder({
			env: process.env,
			workingDirectory: join(out, "claude-code-cwd"),
			blockedDomains: EXCLUDED_HOST_SUFFIXES,
			onPlanStatus: (status) => plan.observe(status),
		});
		return {
			find: async (stock, log) => {
				const found = await finder.find(stock);
				if (!found.ok) {
					if (found.code === "PLAN_RATE_LIMITED") plan.rateLimited();
					return found;
				}
				log.push(
					`Haiku agent (Claude Code): ${found.searches} search(es), ${found.urls.length} picked pages`,
				);
				log.push(...found.log);
				return { ok: true, urls: found.urls, order: "as-given", costUsd: 0 };
			},
			// Claude Code's WebFetch returns a model's summary, not the page's words: no quote could be checked.
			fallbackRead: null,
		};
	}
	const apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
	if (apiKey === "") throw new Error("--search claude needs ANTHROPIC_API_KEY");
	const finder = createClaudePageFinder({
		apiKey,
		fetch: globalThis.fetch,
		blockedDomains: EXCLUDED_HOST_SUFFIXES,
	});
	return {
		find: async (stock, log) => {
			const found = await finder.find(stock);
			if (!found.ok) return found;
			log.push(`Haiku agent: ${found.searches} search(es), ${found.urls.length} picked pages`);
			log.push(...found.log);
			return { ok: true, urls: found.urls, order: "as-given", costUsd: found.costUsd };
		},
		fallbackRead: (url) => finder.fetchText(url),
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.backend === "claude-api") {
		agent = createClaudeApiRuntime(providerEnvironment);
		agentId = CLAUDE_API_AGENT_ID;
	}
	const probe = await agent.probe();
	if (probe.availability.status !== "available") {
		throw new Error(`${args.backend} unavailable: ${probe.availability.reasonCode}`);
	}
	mkdirSync(args.out, { recursive: true });
	scratchDirectory = join(args.out, "claude-code-cwd");
	mkdirSync(scratchDirectory, { recursive: true });
	const plan = new PlanGate();
	const webTools = args.web === "none" ? null : createWebTools(join(args.out, "pages"));
	const search =
		webTools === null
			? null
			: pageSearchFor(args.search, webTools.search, args.backend, args.out, plan);
	const findPages = search?.find ?? null;
	const fallbackRead = search?.fallbackRead ?? null;
	const web = new WebBudget(findPages !== null);
	const storedAt = storedOverviewKeys(args.db);
	const rewriteBefore = args.rewriteBefore;
	// Stored and not due for a rewrite: skipped.
	const done = new Set(
		args.force
			? []
			: [...storedAt]
					.filter(([, at]) => rewriteBefore === null || at >= rewriteBefore)
					.map(([key]) => key),
	);
	const directory = directoryStocks(args.db);
	const issuerOf = issuerFinder(directory);
	const candidates = args.stocks ?? (args.all ? directory : watchlistStocks(args.db));
	const logFile = join(args.out, "run.jsonl");
	const unreadable = args.force
		? new Set<string>()
		: recentlyUnreadableIn(logFile, Date.now(), args.search);
	const pending = candidates.filter(
		(key) =>
			!done.has(`${key.market}:${key.symbol}`) && !unreadable.has(`${key.market}:${key.symbol}`),
	);
	const stocks = args.limit === null ? pending : pending.slice(0, args.limit);
	console.log(
		`${stocks.length} stocks to write (${done.size} stored and kept, ${storedAt.size - done.size} stored and due for a rewrite, ${unreadable.size} searched in the last ${UNREADABLE_DAYS} days without a usable page, concurrency ${args.concurrency})`,
	);
	const ownerId = ownerOf(args.db);
	// Why the run stopped taking stocks (the account cannot pay), or null.
	let stopReason: string | null = null;
	const searchPaysWithClaude = args.search === "claude";
	let finished = 0;
	let totalCost = 0;
	const outcomes: StockOutcome[] = [];

	async function writeOne(key: StockKey): Promise<StockOutcome> {
		const label = `${key.market}:${key.symbol}`;
		await plan.ready(sleep);
		let sources = await readSourcesWithRetries(args.db, key);
		const searchesWeb =
			webTools !== null &&
			findPages !== null &&
			(args.web === "all" || !sources.hasBusinessText) &&
			(await web.ready(sleep));
		let webPages = 0;
		let searched = false;
		let searchCostUsd = 0;
		if (searchesWeb) {
			const before = sources.sources.length;
			const withWeb = await withWebSources(sources, findPages, webTools.fetchPage, fallbackRead);
			searchCostUsd = withWeb.costUsd;
			web.record(withWeb.searchFailure);
			searched = withWeb.searchFailure === null;
			sources = withWeb.stock;
			webPages = sources.sources.length - before;
			for (const line of withWeb.log) console.log(`  ${label} ${line}`);
			// The Haiku search is paid by the same account as the turns: nothing more can be written.
			if (searchPaysWithClaude && web.exhaustedBy !== null) stopReason ??= web.exhaustedBy;
		}
		if (stopReason !== null && !searched) {
			return {
				stock: label,
				turns: 0,
				costUsd: searchCostUsd,
				verified: 0,
				total: 0,
				webPages,
				searched,
				searchedWith: null,
				stored: false,
				error: `run stopped: ${stopReason}`,
			};
		}
		if (!sources.hasBusinessText && webPages === 0) {
			return {
				stock: label,
				turns: 0,
				costUsd: searchCostUsd,
				verified: 0,
				total: 0,
				webPages,
				searched,
				searchedWith: searched ? args.search : null,
				stored: false,
				error: NO_BUSINESS_SOURCE,
			};
		}
		// A stored entry is replaced only by one at least as full (ADR-0064 §5d).
		const stored = storedAt.has(label) ? storedOverviewEntry(args.db, key) : null;
		let described: Described | null = null;
		let failure = "";
		for (let attempt = 0; described === null; attempt += 1) {
			try {
				described = await describeStock(sources, ownerId, args.out, stored);
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
				if (isOutOfCredit(failure)) stopReason ??= failure;
				if (args.backend === "claude-code" && /RATE_LIMIT/.test(failure)) {
					// The plan's window is used up: wait for it instead of failing the stock.
					plan.rateLimited();
					await plan.ready(sleep);
					if (plan.exhaustedBy === null && attempt < PLAN_RATE_LIMIT_WAITS) continue;
				}
				if (attempt >= TRANSIENT_RETRIES || !isTransient(failure)) break;
				await sleep(TRANSIENT_PAUSE_MS * (attempt + 1));
			}
		}
		const searchFields = {
			webPages,
			searched,
			searchedWith: searched ? args.search : null,
		};
		if (described === null) {
			return {
				stock: label,
				turns: 0,
				costUsd: searchCostUsd,
				verified: 0,
				total: 0,
				...searchFields,
				stored: false,
				error: failure,
			};
		}
		const outcome = {
			...described.outcome,
			costUsd: described.outcome.costUsd + searchCostUsd,
			...searchFields,
		};
		if (!args.store || described.overview === null || outcome.error !== null) {
			return { ...outcome, stored: false };
		}
		try {
			await storeOverviews(args.db, [described.overview]);
			return { ...outcome, stored: true };
		} catch (error) {
			// The turns were spent: their cost stays in the outcome.
			const message = error instanceof Error ? error.message : String(error);
			return { ...outcome, stored: false, error: `store failed: ${message}` };
		}
	}

	/**
	 * A preferred share, warrant, unit or right takes its issuer's entry: its
	 * business is the issuer's (ADR-0064 §5e). No model turn.
	 */
	async function copyFromIssuer(key: StockKey, issuer: StockKey): Promise<StockOutcome> {
		const label = `${key.market}:${key.symbol}`;
		const base = {
			stock: label,
			turns: 0,
			costUsd: 0,
			verified: 0,
			total: 0,
			webPages: 0,
			searched: false,
			searchedWith: null,
		};
		const view = storedOverviewView(args.db, issuer);
		if (view === null) {
			return { ...base, stored: false, error: `${ISSUER_NOT_WRITTEN} ${issuer.symbol}` };
		}
		if (!args.store) return { ...base, stored: false, error: null };
		await storeOverviews(args.db, [
			{ ownerId, market: key.market, symbol: key.symbol, overview: view },
		]);
		return { ...base, stored: true, error: null };
	}

	async function worker(queue: readonly StockKey[], counter: { next: number }): Promise<void> {
		for (let key = queue[counter.next++]; key !== undefined; key = queue[counter.next++]) {
			stopReason ??= plan.exhaustedBy;
			// Stocks not started are left for the next run, not logged as failed.
			if (stopReason !== null) return;
			let outcome: StockOutcome;
			try {
				const issuer = issuerOf(key);
				outcome = issuer === null ? await writeOne(key) : await copyFromIssuer(key, issuer);
			} catch (error) {
				// A source or store failure for one stock must not stop the others.
				outcome = {
					stock: `${key.market}:${key.symbol}`,
					turns: 0,
					costUsd: 0,
					verified: 0,
					total: 0,
					webPages: 0,
					searched: false,
					searchedWith: null,
					stored: false,
					error: error instanceof Error ? error.message : String(error),
				};
			}
			outcomes.push(outcome);
			finished += 1;
			totalCost += outcome.costUsd;
			appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...outcome })}\n`);
			console.log(
				`[${finished}/${stocks.length}] $${totalCost.toFixed(4)} ${JSON.stringify(outcome)}`,
			);
		}
	}

	// Issuers first, then the listings that copy their entries.
	const derived = stocks.filter((key) => issuerOf(key) !== null);
	const primary = stocks.filter((key) => issuerOf(key) === null);
	for (const queue of [primary, derived]) {
		const counter = { next: 0 };
		await Promise.all(Array.from({ length: args.concurrency }, () => worker(queue, counter)));
	}
	if (stopReason !== null) {
		console.log(
			`stopped after ${finished} of ${stocks.length} stocks: the account cannot pay (${stopReason}). Add credit, then run the same command again.`,
		);
		process.exit(2);
	}
	const written = outcomes.filter((outcome) => outcome.error === null).length;
	console.log(
		`done: ${written} written${args.store ? " and stored" : ""}, ${outcomes.length - written} not, ${web.searches} web searches, $${totalCost.toFixed(4)}`,
	);
	process.exit(outcomes.some((outcome) => outcome.error !== null && outcome.turns > 0) ? 1 : 0);
}

await main();
