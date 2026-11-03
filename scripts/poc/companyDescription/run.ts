/**
 * PoC: write 事業概要 (the company overview, ADR-0064) for the Watchlist
 * stocks with Claude Haiku 5.5, following the template in template.ts, and
 * check every field's evidence against its sources: the stored records and
 * up to three public web pages (webSources.ts; `--no-web` leaves them out).
 *
 *   node --env-file=.env scripts/poc/companyDescription/run.ts [--db <sqlite file>] [--out <dir>] [--store] [--no-web] [MARKET:SYMBOL ...]
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
 * sources) and `.replies.json` (raw replies); `--store` then writes the
 * overviews to the database with store.ts.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeApiRuntime, createNodeProcessRunner } from "@research/adapters/providers";
import { extractJsonObject, parseAgentEvent } from "@research/agent-core";
import { CLAUDE_API_AGENT_ID, type CompanyOverviewView } from "@research/contracts";
import { checkDescription, describeProblems, keepVerified } from "./evidence.ts";
import { companyDescriptionPrompt } from "./prompt.ts";
import { renderCheck, renderPage, renderSection } from "./render.ts";
import {
	ownerOf,
	readStockSources,
	type StockKey,
	type StockSources,
	watchlistStocks,
} from "./sources.ts";
import { type CompanyDescription, companyDescriptionSchema } from "./template.ts";
import { createWebTools, withWebSources } from "./webSources.ts";

const MODEL = "claude-haiku-5-5";
const TURN_DEADLINE_MS = 300_000;

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

function parseArgs(argv: readonly string[]): {
	db: string;
	out: string;
	store: boolean;
	web: boolean;
	stocks: StockKey[] | null;
} {
	let db: string | null = null;
	let store = false;
	let web = true;
	let out = "scripts/poc/companyDescription/output";
	const stocks: StockKey[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--db") db = argv[++index] ?? null;
		else if (arg === "--out") out = argv[++index] ?? out;
		else if (arg === "--store") store = true;
		else if (arg === "--no-web") web = false;
		else if (arg !== undefined) {
			const match = /^(US|JP):([A-Z0-9.-]{1,16})$/.exec(arg);
			if (match?.[1] === undefined || match[2] === undefined) {
				throw new Error(`expected MARKET:SYMBOL, got ${arg}`);
			}
			stocks.push({ market: match[1] === "US" ? "US" : "JP", symbol: match[2] });
		}
	}
	return {
		db: db ?? devDatabasePath(),
		out,
		store,
		web,
		stocks: stocks.length === 0 ? null : stocks,
	};
}

const agent = createClaudeApiRuntime({
	processRunner: createNodeProcessRunner(),
	fetch: globalThis.fetch,
	env: process.env,
});

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
			scratchDirectory: null,
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

type ReplyCheck =
	| { readonly ok: true; readonly description: CompanyDescription }
	| { readonly ok: false; readonly message: string };

function parseReply(text: string): ReplyCheck {
	const json = extractJsonObject(text);
	if (!json.ok) return { ok: false, message: "The reply contained no parseable JSON object." };
	const parsed = companyDescriptionSchema.safeParse(json.value);
	if (!parsed.success) {
		const fields = parsed.error.issues
			.slice(0, 8)
			.map((issue) => `${issue.path.join(".")} (${issue.message})`)
			.join(", ");
		return { ok: false, message: `Invalid fields: ${fields}.` };
	}
	return { ok: true, description: parsed.data };
}

interface StockOutcome {
	readonly stock: string;
	readonly turns: number;
	readonly costUsd: number;
	readonly verified: number;
	readonly total: number;
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
		agentId: CLAUDE_API_AGENT_ID,
		model: MODEL,
		generatedAt,
	};
}

async function describeStock(
	stock: StockSources,
	ownerId: string,
	out: string,
): Promise<StockOutcome> {
	const label = `${stock.stock.market}:${stock.stock.symbol}`;
	const runId = `poc_${stock.stock.symbol}_${Date.now()}`;
	const prompt = (repairNote: string | null) =>
		companyDescriptionPrompt({
			stock,
			fenceToken: randomBytes(12).toString("hex"),
			repairNote,
		});
	let costUsd = 0;
	let turns = 0;
	let repairNote: string | null = null;
	let lastDescription: CompanyDescription | null = null;
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
			continue;
		}
		lastDescription = parsed.description;
		const problems = describeProblems(checkDescription(parsed.description, stock.sources));
		if (problems.length === 0) break;
		repairNote = problems.join("\n");
	}
	const stem = join(out, `${stock.stock.market}-${stock.stock.symbol}`);
	writeFileSync(`${stem}.replies.json`, JSON.stringify(replies, null, 2));
	if (lastDescription === null) {
		return { stock: label, turns, costUsd, verified: 0, total: 0, error: repairNote };
	}
	const checked = checkDescription(lastDescription, stock.sources);
	const verified = keepVerified(lastDescription, checked);
	// The owner's local day (sv-SE formats as YYYY-MM-DD), not the UTC one.
	const generatedOn = new Date().toLocaleDateString("sv-SE");
	const sections = (["ja", "en"] as const).map((language) =>
		renderSection({ stock, description: verified, language, model: MODEL, generatedOn }),
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
	// What `store.ts` writes to the database (ADR-0064).
	writeFileSync(
		`${stem}.overview.json`,
		JSON.stringify(
			{
				ownerId,
				market: stock.stock.market,
				symbol: stock.stock.symbol,
				overview: overviewView(stock, verified, new Date().toISOString()),
			},
			null,
			2,
		),
	);
	return {
		stock: label,
		turns,
		costUsd,
		verified: checked.filter((item) => item.problems.length === 0).length,
		total: checked.length,
		error: null,
	};
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const probe = await agent.probe();
	if (probe.availability.status !== "available") {
		throw new Error(`Claude API unavailable: ${probe.availability.reasonCode}`);
	}
	mkdirSync(args.out, { recursive: true });
	const webTools = args.web ? createWebTools(join(args.out, "pages")) : null;
	const stocks = args.stocks ?? watchlistStocks(args.db);
	const ownerId = ownerOf(args.db);
	const outcomes: StockOutcome[] = [];
	for (const key of stocks) {
		let sources = readStockSources(args.db, key);
		if (webTools !== null) {
			const withWeb = await withWebSources(sources, webTools);
			sources = withWeb.stock;
			for (const line of withWeb.log) console.log(`  ${key.market}:${key.symbol} ${line}`);
		}
		try {
			outcomes.push(await describeStock(sources, ownerId, args.out));
		} catch (error) {
			outcomes.push({
				stock: `${key.market}:${key.symbol}`,
				turns: 0,
				costUsd: 0,
				verified: 0,
				total: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		const last = outcomes.at(-1);
		if (last !== undefined) console.log(JSON.stringify(last));
	}
	const failed = outcomes.filter((outcome) => outcome.error !== null);
	if (args.store) {
		// node:sqlite is Node's: the store step runs under Node, not Bun.
		const files = outcomes
			.filter((outcome) => outcome.error === null)
			.map((outcome) => join(args.out, `${outcome.stock.replace(":", "-")}.overview.json`));
		const stored = spawnSync(
			"node",
			["scripts/poc/companyDescription/store.ts", "--db", args.db, ...files],
			{ stdio: "inherit" },
		);
		if (stored.status !== 0) process.exit(1);
	}
	process.exit(failed.length === 0 ? 0 : 1);
}

await main();
