/**
 * Hand-designed pipeline scenarios that land exactly on each byte/unit budget
 * edge with non-ASCII text, stop a run at each budget limit with usable
 * records (partial outcomes), cancel in the middle of a plan, and make tools
 * and adapters throw or hang. Every scenario asserts its own outcome, so a
 * regenerated corpus that stops covering a path fails the export instead of
 * silently shrinking. These are the "hand-checked list" of the review.
 */
import {
	createToolRegistry,
	defineTool,
	EMPTY_TOOL_OUTPUT,
	type ToolDefinition,
} from "@research/agent-core";
import type { AgentEvent, Evidence, ResearchRequest } from "@research/contracts";
import { EMPTY_USAGE, ok, type ResourceUsage } from "@research/domain";
import { z } from "zod";
import {
	type PipelineOutcome,
	runResearchPipeline,
} from "../../../packages/application/src/research/pipeline.ts";
import { request as baseRequest, SOURCES } from "../../../packages/application/test/support.ts";
import { capturedRunResearchPipeline, markRunAbortedByTool } from "./capture.ts";
import { setCurrentCase } from "./harness.ts";
import { ToolPanic, type TurnScript, textTurn, worldAgent } from "./world.ts";

const RUN_ID = "run_edge";
const START = Date.parse("2026-10-11T00:00:00.000Z");
const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;
const points = (text: string): string[] => Array.from(text);

/** Texts whose UTF-8 size, UTF-16 length and code-point count all differ. */
const CJK = "日本銀行政策金利蓄電池需要予測供給網半導体電力会社株価決算発表";
const EMOJI = "\u{1F4C8}\u{1F600}\u{1F1EF}\u{1F1F5}";
const COMBINING = "éäñ";
function repeatPoints(unit: string, count: number): string {
	const source = points(unit);
	return Array.from({ length: count }, (_, i) => source[i % source.length]).join("");
}

function evidence(
	id: string,
	title: string,
	publisher: string,
	checksumSeed: number,
	publishedAt: string | null = null,
): Evidence {
	return {
		evidenceId: id,
		sourceUrl: `https://news.example.org/articles/${id}`,
		title,
		publisher,
		publishedAt,
		retrievedAt: "2026-10-11T00:00:00.000Z",
		effectiveAt: null,
		excerpt: null,
		checksum: checkSum(checksumSeed),
		sourceClass: "news",
	};
}
const checkSum = (seed: number): string => seed.toString(16).padStart(64, "0");

interface World {
	readonly controller: AbortController;
	readonly advance: (ms: number) => void;
}

interface Spec {
	readonly name: string;
	readonly budget?: Partial<ResearchRequest["budget"]>;
	readonly priorUsage?: ResourceUsage;
	readonly question?: string;
	/** Replies by prompt kind and per-kind index. */
	readonly reply: (
		kind: "planning" | "analysis" | "verification",
		index: number,
		prompt: string,
	) => TurnScript | string;
	readonly tools: (world: World) => ToolDefinition[];
	/** Returns an error message when the outcome is not the one this scenario exists for. */
	readonly expect: (outcome: PipelineOutcome) => string | null;
}

const NO_ARGS = z.strictObject({});
const base = {
	version: "1",
	permission: "research-read" as const,
	costCategory: "free" as const,
	sideEffect: "none" as const,
	networkAllowlist: { kind: "none" } as const,
};

/** A tool with no arguments whose behaviour the scenario supplies. */
export function tool(
	toolId: string,
	execute: ToolDefinition["execute"],
	timeoutMs = 5_000,
): ToolDefinition {
	return defineTool({
		...base,
		toolId,
		timeoutMs,
		description: `Scripted ${toolId}.`,
		argsSchema: NO_ARGS,
		argsHint: "{}",
		execute: execute as never,
	});
}

const planOf = (...ids: string[]): string =>
	JSON.stringify({ toolCalls: ids.map((toolId) => ({ toolId, args: {} })), done: false });
const doneOf = (...ids: string[]): string =>
	JSON.stringify({ toolCalls: ids.map((toolId) => ({ toolId, args: {} })), done: true });
const EMPTY_ANALYSIS = JSON.stringify({ claims: [] });

function replyFor(spec: Spec): (prompt: string, index: number) => TurnScript | string {
	const counts = { planning: 0, analysis: 0, verification: 0 };
	return (prompt) => {
		const kind = prompt.startsWith("You are the planning step")
			? "planning"
			: prompt.startsWith("You are the analysis step")
				? "analysis"
				: "verification";
		return spec.reply(kind, counts[kind]++, prompt);
	};
}

interface Probe {
	readonly outcome: PipelineOutcome;
	/** input bytes charged when the analysis state began */
	readonly inputBytesBeforeAnalysis: number;
}

async function execute(
	spec: Spec,
	options: { readonly budget?: Partial<ResearchRequest["budget"]>; readonly capture: boolean },
): Promise<Probe> {
	let nowMs = START;
	const controller = new AbortController();
	const world: World = {
		controller,
		advance: (ms) => {
			nowMs += ms;
		},
	};
	const reply = replyFor(spec);
	const agent = worldAgent({ controller, script: (request) => reply(request.prompt, 0) });
	const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
	let fence = 0;
	let lastUsage = EMPTY_USAGE;
	let beforeAnalysis = 0;
	const reporter = {
		async state(state: string) {
			if (state === "analyzing") beforeAnalysis = lastUsage.inputBytes;
		},
		async note() {},
		async tool() {},
		async usage(usage: ResourceUsage) {
			lastUsage = usage;
		},
	};
	const input = {
		runId: RUN_ID,
		request: {
			...baseRequest(),
			...(spec.question === undefined ? {} : { question: spec.question }),
			budget: { ...baseRequest().budget, ...spec.budget, ...options.budget },
		},
		sources: SOURCES,
		workspaceComponents: [],
		conversationContext: [],
		priorUsage: spec.priorUsage ?? EMPTY_USAGE,
		signal: controller.signal,
		allowUnverifiedToolIsolation: false,
	};
	const deps = {
		agent,
		tools: createToolRegistry(spec.tools(world)),
		clock,
		reporter,
		newFenceToken: () => `fence-${++fence}`,
		scratchDirectory: null,
	};
	const outcome = options.capture
		? await capturedRunResearchPipeline(input, deps)
		: await runResearchPipeline(input, deps);
	return { outcome, inputBytesBeforeAnalysis: beforeAnalysis };
}

async function run(
	spec: Spec,
	budget?: Partial<ResearchRequest["budget"]>,
	label = "",
): Promise<void> {
	setCurrentCase(`edge/${spec.name}${label}`);
	const { outcome } = await execute(spec, { budget, capture: true });
	const problem = spec.expect(outcome);
	if (problem !== null) {
		throw new Error(`targeted scenario ${spec.name}${label}: ${problem}`);
	}
}

/** A feed tool: returns the given evidence (ids allocated through the run). */
function feed(
	items: (nextId: (prefix: string) => string) => {
		evidence: Evidence;
		text: string;
	}[],
	extra?: (world: World, nextId: (prefix: string) => string) => Partial<typeof EMPTY_TOOL_OUTPUT>,
	modelText = "ok",
): (world: World) => ToolDefinition[] {
	return (world) => [
		tool("feed.read", async (_args, context) => {
			const found = items(context.nextId);
			return ok({
				...EMPTY_TOOL_OUTPUT,
				modelText,
				evidence: found.map((item) => ({
					evidence: item.evidence,
					retrievedText: item.text,
					retainQuotes: true,
				})),
				...(extra?.(world, context.nextId) ?? {}),
			});
		}),
	];
}

const completes = (outcome: PipelineOutcome) =>
	outcome.kind === "completed" ? null : `expected completed, got ${outcome.kind}`;

/* ---------------- budget edges ---------------- */

function entryBytes(item: { evidence: Evidence; text: string }): number {
	const e = item.evidence;
	return bytes(
		`[${e.evidenceId}] ${e.title} — ${e.publisher}; published ${e.publishedAt ?? "undated"}; retrieved ${e.retrievedAt}\n${sliceUnits(item.text, 4000)}\n\n`,
	);
}
/** `String#slice(0, n)` on UTF-16 units (inputs here never split a pair). */
function sliceUnits(text: string, units: number): string {
	return text.slice(0, units);
}

const packTexts: Record<string, (n: number) => string> = {
	cjk: (n) => repeatPoints(CJK, n),
	emoji: (n) => repeatPoints(EMOJI, n),
	combining: (n) => repeatPoints(`${COMBINING}${CJK}ab`, n),
};

async function packEdges(): Promise<void> {
	for (const [kind, make] of Object.entries(packTexts)) {
		const items = (nextId: (prefix: string) => string) => [
			{
				evidence: evidence(nextId("ev"), repeatPoints(CJK, 20), "日本経済新聞", 1),
				text: make(kind === "emoji" ? 1200 : 1800),
			},
			{
				evidence: evidence(
					nextId("ev"),
					repeatPoints(CJK, 25),
					"Example Wire",
					2,
					"2026-10-01T00:00:00.000Z",
				),
				// Longer than 4000 units: the pack cuts item text at 4000 UTF-16 units.
				text: make(kind === "emoji" ? 2600 : 4400),
			},
			{
				evidence: evidence(nextId("ev"), "third", "P3", 3),
				text: make(300),
			},
		];
		let counter = 0;
		const sized = items((prefix) => `${RUN_ID}_${prefix}${++counter}`);
		const [a, b, c] = sized;
		if (a === undefined || b === undefined || c === undefined) throw new Error("items");
		const spec: Spec = {
			name: `pack-${kind}`,
			reply: (k) => (k === "planning" ? doneOf("feed.read") : EMPTY_ANALYSIS),
			tools: feed(items),
			expect: () => null,
		};
		// Learn the input bytes charged before analysis (the budget is not in any prompt).
		const probe = await execute(spec, { budget: { maxInputBytes: 2_000_000 }, capture: false });
		const fixed = probe.inputBytesBeforeAnalysis + 12_000;
		const edges = [entryBytes(a) + entryBytes(b), entryBytes(a) + entryBytes(b) + entryBytes(c)];
		for (const [edgeIndex, edge] of edges.entries()) {
			for (const delta of [-1, 0, 1]) {
				await run(
					{ ...spec, expect: completes },
					{ maxInputBytes: fixed + edge + delta },
					`-edge${edgeIndex}${delta >= 0 ? "+" : ""}${delta}`,
				);
			}
		}
		// The first item alone does not fit: MAX_INPUT_BYTES (nothing shown).
		await run(
			{
				...spec,
				expect: (o) =>
					o.kind === "failed" && o.failureCode === "MAX_INPUT_BYTES" ? null : `got ${o.kind}`,
			},
			{ maxInputBytes: fixed + entryBytes(a) - 1 },
			"-first-misses",
		);
	}
}

async function freshTextEdges(): Promise<void> {
	for (const [kind, filler] of [
		["cjk", CJK],
		["emoji", EMOJI],
		["mixed", `${COMBINING}${CJK}`],
	] as const) {
		for (const delta of [-3, -1, 0, 1, 2, 5]) {
			// "Result of feed.read:\n" + modelText is the fresh block of the second step.
			const prefix = "Result of feed.read:\n";
			const target = 48_000 + delta;
			let text = repeatPoints(filler, Math.floor((target - bytes(prefix)) / 4));
			// Pad with ASCII (and one 2-byte letter when odd) to land on the exact byte.
			while (bytes(prefix) + bytes(text) < target) text += "x";
			const modelText = text;
			await run({
				name: `fresh-${kind}${delta >= 0 ? "+" : ""}${delta}`,
				reply: (k, index) => {
					if (k === "planning") return index === 0 ? planOf("feed.read") : doneOf();
					return EMPTY_ANALYSIS;
				},
				tools: feed(
					(nextId) => [
						{ evidence: evidence(nextId("ev"), "日本の需要", "Wire", 9), text: "short text" },
					],
					undefined,
					modelText,
				),
				expect: completes,
			});
		}
	}
}

async function digestEdges(): Promise<void> {
	// Lines are "[<id>] <title> — <publisher>; undated"; sizes are summed in bytes.
	const lineBytes = (id: number, title: string) =>
		bytes(`[${RUN_ID}_ev${id}] ${title} — Wire; undated`);
	for (const [kind, filler, count] of [
		["cjk", CJK, 40],
		["emoji", EMOJI, 40],
		["many-short", "a", 401],
		["mixed", `${COMBINING}${CJK}`, 55],
	] as const) {
		for (const delta of kind === "many-short" ? [0] : [-2, -1, 0, 1, 2]) {
			const titles: string[] = [];
			if (kind === "many-short") {
				for (let i = 1; i <= count; i++) titles.push("t");
			} else {
				const body = repeatPoints(filler, 60);
				for (let i = 1; i <= count; i++) titles.push(body);
				// Make the digest total exactly 8000 + delta bytes by padding the oldest title.
				const total = titles.reduce((sum, title, i) => sum + lineBytes(i + 1, title) + 1, 0);
				const first = titles[0] ?? "";
				const shrink = total - (8000 + delta + count);
				if (shrink > 0)
					titles[0] = points(first)
						.slice(0, Math.max(1, points(first).length - Math.ceil(shrink / 4)))
						.join("");
				let current = titles.reduce((sum, title, i) => sum + lineBytes(i + 1, title), 0) + 0;
				while (current < 8000 + delta) {
					titles[0] = `${titles[0]}x`;
					current += 1;
				}
			}
			await run({
				name: `digest-${kind}${delta >= 0 ? "+" : ""}${delta}`,
				budget: { maxToolCalls: 10 },
				reply: (k, index) => {
					if (k === "planning") return index === 0 ? planOf("feed.read") : doneOf();
					return EMPTY_ANALYSIS;
				},
				tools: feed((nextId) =>
					titles.map((title, i) => ({
						evidence: evidence(nextId("ev"), title, "Wire", 100 + i),
						text: "t",
					})),
				),
				expect: completes,
			});
		}
	}
}

async function recordSummaryEdges(): Promise<void> {
	for (const delta of [-2, -1, 0, 1, 2]) {
		for (const [kind, filler] of [
			["cjk", CJK],
			["combining", `${COMBINING}${CJK}`],
		] as const) {
			const lines = (names: string[]) =>
				names.map((name) => `security ${name} NASDAQ:EXMP (US)`).join("\n");
			const names: string[] = [];
			for (let i = 0; i < 40; i++) names.push(repeatPoints(filler, 250));
			// Whole-summary length lands on 8000 + delta UTF-16 units.
			let length = lines(names).length;
			let tail = names[names.length - 1] ?? "";
			while (length > 8000 + delta + 120) {
				names.pop();
				length = lines(names).length;
				tail = names[names.length - 1] ?? "";
			}
			void tail;
			while (lines(names).length < 8000 + delta)
				names.push(repeatPoints(filler, Math.min(250, 8000 + delta - lines(names).length - 25)));
			await run({
				name: `summary-${kind}${delta >= 0 ? "+" : ""}${delta}`,
				reply: (k) => (k === "planning" ? doneOf("feed.read") : EMPTY_ANALYSIS),
				tools: feed(
					(nextId) => [
						{ evidence: evidence(nextId("ev"), "records", "Wire", 7), text: "records text" },
					],
					(_world, nextId) => ({
						securities: names.map((name) => ({
							securityId: nextId("sec"),
							country: "US" as const,
							ticker: "EXMP",
							exchange: "NASDAQ",
							issuerName: name,
							issuerIdentifier: null,
							listingCurrency: "USD",
							reportingCurrency: null,
							listingVerification: "source-verified" as const,
							formerTickers: [],
						})),
					}),
				),
				expect: completes,
			});
		}
	}
}

async function outputLimit(): Promise<void> {
	for (const [name, count, expectLarge] of [
		["output-400000", 400_000, false],
		["output-400001", 400_001, true],
	] as const) {
		const text = "x".repeat(count);
		const quarter = count / 4;
		const deltas = [0, 1, 2, 3].map((i) =>
			text.slice(Math.floor(i * quarter), Math.floor((i + 1) * quarter)),
		);
		deltas[3] = text.slice(Math.floor(3 * quarter));
		await run({
			name,
			budget: { maxAgentSteps: 3 },
			reply: () => ({
				events: [
					...deltas.map((delta): AgentEvent => ({ type: "text.delta", text: delta })),
					{ type: "completed" },
				],
			}),
			tools: () => [tool("feed.read", async () => ok(EMPTY_TOOL_OUTPUT))],
			expect: (o) =>
				o.kind === "failed" &&
				(expectLarge
					? o.failureCode === "AGENT_OUTPUT_TOO_LARGE"
					: o.failureCode === "NO_EVIDENCE_COLLECTED")
					? null
					: `got ${JSON.stringify(o).slice(0, 200)}`,
		});
	}
}

/* ---------------- partial outcomes, cancellation, throws ---------------- */

const securityRecord = (nextId: (prefix: string) => string) => {
	const securityId = nextId("sec");
	return {
		securities: [
			{
				securityId,
				country: "US" as const,
				ticker: "EXMP",
				exchange: "NASDAQ",
				issuerName: "Example Storage Corp",
				issuerIdentifier: null,
				listingCurrency: "USD",
				reportingCurrency: null,
				listingVerification: "source-verified" as const,
				formerTickers: [],
			},
		],
		financialObservations: [
			{
				observationId: nextId("fo"),
				securityId,
				metricCode: "revenue" as const,
				value: 12.5,
				unavailableReason: null,
				unit: "currency" as const,
				currency: "USD",
				accountingStandard: "US-GAAP" as const,
				period: {
					fiscalYear: 2026,
					fiscalPeriod: "FY" as const,
					periodStart: "2026-01-01",
					periodEnd: "2026-12-31",
				},
				actualOrEstimate: "actual" as const,
				marketDataAsOf: null,
				formula: null,
				sourceEvidenceId: `${RUN_ID}_ev1`,
			},
		],
	};
};
const article = (nextId: (prefix: string) => string) => ({
	evidence: evidence(nextId("ev"), "Grid storage orders rise", "Example News", 5),
	text: "Orders for grid storage reached 100 GWh in 2026.",
});
const partial = (code: string) => (outcome: PipelineOutcome) =>
	outcome.kind === "partial" && outcome.failureCode === code
		? null
		: `expected partial ${code}, got ${outcome.kind} ${JSON.stringify(outcome).slice(0, 160)}`;
const failed = (code: string, detail?: string) => (outcome: PipelineOutcome) =>
	outcome.kind === "failed" &&
	outcome.failureCode === code &&
	(detail === undefined || outcome.failureDetail === detail)
		? null
		: `expected failed ${code}, got ${outcome.kind} ${JSON.stringify(outcome).slice(0, 160)}`;

async function limitsAndFaults(): Promise<void> {
	const hang = () => tool("hang.read", () => new Promise(() => {}), 15);
	// MAX_WALL_CLOCK: the run deadline ends a hanging second call (real 1 ms timer).
	await run({
		name: "partial-wall-clock-deadline",
		budget: { maxWallClockMs: 30_000 },
		reply: (k, index) =>
			k === "planning"
				? index === 0
					? planOf("feed.read", "hang.read")
					: doneOf()
				: EMPTY_ANALYSIS,
		tools: (world) => [
			...feed(
				(nextId) => [article(nextId)],
				(w, nextId) => {
					w.advance(29_999);
					return securityRecord(nextId);
				},
			)(world),
			hang(),
		],
		expect: partial("MAX_WALL_CLOCK"),
	});
	// MAX_WALL_CLOCK: the budget is spent before the second call is authorized.
	await run({
		name: "partial-wall-clock-spent",
		budget: { maxWallClockMs: 30_000 },
		reply: (k) => (k === "planning" ? planOf("feed.read", "feed.read") : EMPTY_ANALYSIS),
		tools: feed(
			(nextId) => [article(nextId)],
			(w, nextId) => {
				w.advance(31_000);
				return securityRecord(nextId);
			},
		),
		expect: partial("MAX_WALL_CLOCK"),
	});
	// MAX_AGENT_STEPS: the repair turn of the analysis has no step left.
	await run({
		name: "partial-agent-steps",
		budget: { maxAgentSteps: 6 },
		priorUsage: { ...EMPTY_USAGE, agentSteps: 4 },
		reply: (k) => (k === "planning" ? doneOf("feed.read") : "no json at all"),
		tools: feed(
			(nextId) => [article(nextId)],
			(_w, nextId) => securityRecord(nextId),
		),
		expect: partial("MAX_AGENT_STEPS"),
	});
	// MAX_INPUT_BYTES: a 60 KB tool result makes the second planning prompt too big.
	await run({
		name: "partial-input-bytes",
		budget: { maxInputBytes: 24_000 },
		reply: (k, index) =>
			k === "planning" ? (index === 0 ? planOf("feed.read") : doneOf()) : EMPTY_ANALYSIS,
		tools: feed(
			(nextId) => [article(nextId)],
			(_w, nextId) => securityRecord(nextId),
			repeatPoints(CJK, 20_000),
		),
		expect: partial("MAX_INPUT_BYTES"),
	});
	// Mid-plan cancellation: the first call aborts the run, the second never starts.
	await run({
		name: "cancel-mid-plan",
		reply: (k) =>
			k === "planning" ? planOf("abort.read", "feed.read", "feed.read") : EMPTY_ANALYSIS,
		tools: (world) => [
			tool("abort.read", async (_args, context) => {
				markRunAbortedByTool();
				world.controller.abort();
				return ok({ ...EMPTY_TOOL_OUTPUT, modelText: context.runId });
			}),
			...feed((nextId) => [article(nextId)])(world),
		],
		expect: (o) => (o.kind === "cancelled" ? null : `expected cancelled, got ${o.kind}`),
	});
	// A tool that throws, one that times out, one that returns a typed failure.
	await run({
		name: "tool-throws",
		reply: (k) => (k === "planning" ? doneOf("throw.read") : EMPTY_ANALYSIS),
		tools: () => [
			tool("throw.read", async () => {
				throw new ToolPanic("boom");
			}),
		],
		expect: failed("ALL_TOOL_CALLS_FAILED", "TOOL_THREW"),
	});
	await run({
		name: "tool-times-out",
		reply: (k) => (k === "planning" ? doneOf("hang.read") : EMPTY_ANALYSIS),
		tools: () => [hang()],
		expect: failed("ALL_TOOL_CALLS_FAILED", "TOOL_TIMEOUT"),
	});
	// Adapter faults: a throw after the events, a cancel between events, a malformed event.
	await run({
		name: "adapter-throws",
		reply: (k) =>
			k === "planning"
				? { events: textTurn(doneOf("feed.read")).events.slice(0, -1), throws: true }
				: EMPTY_ANALYSIS,
		tools: feed((nextId) => [article(nextId)]),
		expect: failed("AGENT_THREW_Panic"),
	});
	await run({
		name: "adapter-cancels-mid-stream",
		reply: (k) =>
			k === "planning"
				? {
						...textTurn(doneOf("feed.read"), [{ type: "usage", knownCostUsd: 0.5 }]),
						abortAfter: 2,
					}
				: EMPTY_ANALYSIS,
		tools: feed((nextId) => [article(nextId)]),
		expect: (o) => (o.kind === "cancelled" ? null : `got ${o.kind}`),
	});
	await run({
		name: "adapter-malformed-event",
		reply: (k) =>
			k === "planning"
				? {
						events: [
							{ type: "text.delta", text: "{}" },
							JSON.parse('{"type":"exec","command":"rm -rf /"}') as AgentEvent,
						],
					}
				: EMPTY_ANALYSIS,
		tools: feed((nextId) => [article(nextId)]),
		expect: failed("AGENT_EVENT_INVALID"),
	});
}

/** Runs every targeted scenario through the capturing wrapper. */
export async function generateTargetedRuns(): Promise<void> {
	await packEdges();
	await freshTextEdges();
	await digestEdges();
	await recordSummaryEdges();
	await outputLimit();
	await limitsAndFaults();
}
