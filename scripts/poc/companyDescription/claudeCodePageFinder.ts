import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { extractJsonObject } from "@research/agent-core";
import { z } from "zod";
import {
	MAX_SEARCHES,
	type PageFinding,
	pageFinderPrompt,
	pagesFromResults,
	samePageKey,
} from "./claudePageFinder.ts";
import type { StockSources } from "./sources.ts";

/**
 * The page search run by Claude Code (`claude -p`) with Haiku 5.5 on the
 * owner's subscription login instead of the metered Claude API (ADR-0064
 * §2d): the owner chose it when the API's prepaid credit ran out
 * (2026-11-04). Same prompt and the same rule as the API finder: a picked
 * URL is read only when it appeared in the search results.
 *
 * Isolation, checked on every run from the CLI's own `system/init` line
 * (fails closed otherwise): the only tool is WebSearch, no MCP server, and
 * `apiKeySource` "none" (a subscription login, never an API key: the child
 * gets no ANTHROPIC_* variable). No settings, CLAUDE.md, skills or hooks
 * (`--setting-sources ""`, `--safe-mode`).
 */

export const CLAUDE_CODE_MODEL = "claude-haiku-5-5";
const TURN_TIMEOUT_MS = 180_000;
/** The init line's `apiKeySource` for a subscription login (observed live 2026-11-04). */
const SUBSCRIPTION_API_KEY_SOURCE = "none";
/** Variables that would turn the CLI into a metered or third-party backend. */
const METERED_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$)/;

const SYSTEM_PROMPT =
	"You find web pages for a research application. Use only the WebSearch tool. Answer with text only, in exactly the format the user message asks for.";

/** One window of the plan's usage limit as the CLI reports it. */
export interface PlanWindow {
	readonly name: string;
	readonly utilization: number;
	readonly resetsAtMs: number;
	readonly status: string;
}

export interface PlanStatus {
	readonly status: string;
	readonly windows: readonly PlanWindow[];
}

const windowSchema = z.looseObject({
	utilization: z.number(),
	resetsAt: z.number(),
	status: z.string(),
});

const lineSchema = z.discriminatedUnion("type", [
	z.looseObject({
		type: z.literal("system"),
		subtype: z.string().optional(),
		tools: z.array(z.string()).optional(),
		mcp_servers: z.array(z.unknown()).optional(),
		apiKeySource: z.string().optional(),
	}),
	z.looseObject({
		type: z.literal("rate_limit_event"),
		rate_limit_info: z.looseObject({
			status: z.string(),
			unifiedWindows: z.record(z.string(), windowSchema).optional(),
		}),
	}),
	z.looseObject({
		type: z.literal("user"),
		message: z.looseObject({ content: z.unknown() }),
	}),
	z.looseObject({
		type: z.literal("assistant"),
		message: z.looseObject({ content: z.unknown() }),
	}),
	z.looseObject({
		type: z.literal("result"),
		is_error: z.boolean(),
		result: z.string().optional(),
	}),
]);

const toolUseSchema = z.looseObject({ type: z.literal("tool_use"), name: z.string() });
const toolResultSchema = z.looseObject({ type: z.literal("tool_result"), content: z.unknown() });
const textBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
const pickSchema = z.looseObject({
	pages: z.array(z.looseObject({ url: z.string() })),
});

/** The arguments of one page-search turn. */
export function claudeCodeSearchArgs(model: string): string[] {
	return [
		"-p",
		"--output-format",
		"stream-json",
		"--verbose",
		"--input-format",
		"text",
		"--model",
		model,
		"--effort",
		"low",
		"--tools",
		"WebSearch",
		"--allowedTools",
		"WebSearch",
		"--strict-mcp-config",
		"--setting-sources",
		"",
		"--disable-slash-commands",
		"--no-session-persistence",
		"--safe-mode",
		"--permission-mode",
		"dontAsk",
		"--system-prompt",
		SYSTEM_PROMPT,
	];
}

/** The child's environment: the runner's, without anything that would bill an API key. */
export function subscriptionEnv(
	env: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(
			(entry): entry is [string, string] => entry[1] !== undefined && !METERED_ENV.test(entry[0]),
		),
	);
}

/** The URLs of a WebSearch tool result ("Links: [{"title":…,"url":…}]"). */
export function urlsOfSearchResult(content: unknown): string[] {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((part) => {
							const parsed = textBlockSchema.safeParse(part);
							return parsed.success ? parsed.data.text : "";
						})
						.join("\n")
				: "";
	return [...text.matchAll(/"url"\s*:\s*"(https?:\/\/[^"\\]+)"/g)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]],
	);
}

/** The plan's usage as one `rate_limit_event` line reports it. */
function planStatusOf(info: {
	readonly status: string;
	readonly unifiedWindows?: Readonly<Record<string, z.infer<typeof windowSchema>>> | undefined;
}): PlanStatus {
	return {
		status: info.status,
		windows: Object.entries(info.unifiedWindows ?? {}).map(([name, window]) => ({
			name,
			utilization: window.utilization,
			resetsAtMs: window.resetsAt * 1000,
			status: window.status,
		})),
	};
}

interface TurnLines {
	readonly results: string[];
	answer: string;
	searches: number;
	isolation: string | null;
	error: string | null;
	finished: boolean;
}

export function createClaudeCodePageFinder(environment: {
	readonly env: Readonly<Record<string, string | undefined>>;
	/** An empty directory the CLI runs in (no project files, no CLAUDE.md). */
	readonly workingDirectory: string;
	readonly blockedDomains: readonly string[];
	readonly onPlanStatus: (status: PlanStatus) => void;
}): { find(stock: StockSources): Promise<PageFinding> } {
	mkdirSync(environment.workingDirectory, { recursive: true });
	const childEnv = subscriptionEnv(environment.env);

	function read(line: string, turn: TurnLines, stop: () => void): void {
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			return;
		}
		const parsed = lineSchema.safeParse(json);
		if (!parsed.success) return;
		const value = parsed.data;
		if (value.type === "system" && value.subtype === "init") {
			const tools = value.tools ?? [];
			if (tools.length !== 1 || tools[0] !== "WebSearch" || (value.mcp_servers ?? []).length > 0) {
				turn.isolation = `tools ${JSON.stringify(tools)}`;
			} else if (value.apiKeySource !== SUBSCRIPTION_API_KEY_SOURCE) {
				turn.isolation = `apiKeySource ${value.apiKeySource ?? "missing"}: not a subscription login`;
			}
			if (turn.isolation !== null) stop();
		} else if (value.type === "rate_limit_event") {
			environment.onPlanStatus(planStatusOf(value.rate_limit_info));
		} else if (value.type === "assistant" && Array.isArray(value.message.content)) {
			for (const block of value.message.content) {
				const tool = toolUseSchema.safeParse(block);
				if (tool.success) {
					if (tool.data.name !== "WebSearch") {
						turn.isolation = `tool_use ${tool.data.name}`;
						stop();
					}
					turn.searches += 1;
				}
				const text = textBlockSchema.safeParse(block);
				if (text.success) turn.answer += text.data.text;
			}
		} else if (value.type === "user" && Array.isArray(value.message.content)) {
			for (const block of value.message.content) {
				const result = toolResultSchema.safeParse(block);
				if (result.success) turn.results.push(...urlsOfSearchResult(result.data.content));
			}
		} else if (value.type === "result") {
			turn.finished = true;
			if (value.is_error) turn.error = (value.result ?? "the CLI reported an error").slice(0, 300);
		}
	}

	function runTurn(prompt: string): Promise<TurnLines> {
		const turn: TurnLines = {
			results: [],
			answer: "",
			searches: 0,
			isolation: null,
			error: null,
			finished: false,
		};
		return new Promise((resolve) => {
			const child = spawn("claude", claudeCodeSearchArgs(CLAUDE_CODE_MODEL), {
				cwd: environment.workingDirectory,
				env: childEnv,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stop = () => child.kill("SIGKILL");
			const timer = setTimeout(() => {
				turn.error ??= "timed out";
				stop();
			}, TURN_TIMEOUT_MS);
			let buffer = "";
			let stderr = "";
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				buffer += chunk;
				let newline = buffer.indexOf("\n");
				while (newline >= 0) {
					read(buffer.slice(0, newline), turn, stop);
					buffer = buffer.slice(newline + 1);
					newline = buffer.indexOf("\n");
				}
			});
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", (chunk: string) => {
				stderr = (stderr + chunk).slice(-500);
			});
			child.on("error", (error) => {
				turn.error ??= error.message;
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (buffer.trim() !== "") read(buffer, turn, stop);
				if (!turn.finished && turn.error === null) {
					turn.error = `claude exited ${code ?? "by signal"} without a result: ${stderr.trim()}`;
				}
				resolve(turn);
			});
			child.stdin.end(prompt);
		});
	}

	return {
		async find(stock) {
			const prompt = pageFinderPrompt(stock, environment.blockedDomains, "WebSearch");
			const turn = await runTurn(prompt);
			if (turn.isolation !== null) {
				return { ok: false, code: "TOOL_ISOLATION_VIOLATED", detail: turn.isolation, costUsd: 0 };
			}
			if (turn.error !== null) {
				const limited = /usage limit|rate limit|limit reached/i.test(turn.error);
				return {
					ok: false,
					code: limited ? "PLAN_RATE_LIMITED" : "CLAUDE_CODE_ERROR",
					detail: turn.error,
					costUsd: 0,
				};
			}
			if (turn.searches > 0 && turn.results.length === 0) {
				// A failed search is not "nothing found": the stock must not wait a month for it.
				return { ok: false, code: "SEARCH_TOOL_ERROR", detail: "no search results", costUsd: 0 };
			}
			const json = extractJsonObject(turn.answer);
			const pick = json.ok ? pickSchema.safeParse(json.value) : null;
			const picked = pick?.success === true ? pick.data.pages.map((page) => page.url) : [];
			const log: string[] = [];
			if (pick?.success !== true) log.push("the agent's answer had no page list");
			const dropped = picked.filter(
				(url) => !turn.results.some((result) => samePageKey(result) === samePageKey(url)),
			);
			if (dropped.length > 0) {
				log.push(`dropped ${dropped.length} picked URL(s) not in the search results`);
			}
			return {
				ok: true,
				urls: pagesFromResults(picked, turn.results),
				searches: Math.min(turn.searches, MAX_SEARCHES),
				// A subscription turn bills nothing per call.
				costUsd: 0,
				log,
			};
		},
	};
}
