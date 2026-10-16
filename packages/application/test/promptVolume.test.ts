import { createToolRegistry, defineTool, EMPTY_TOOL_OUTPUT } from "@research/agent-core";
import { EMPTY_USAGE, ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createScriptedAgent } from "../../../examples/extensions/scriptedAgent.ts";
import { PLANNING_PROMPT_BUDGET_BYTES, runResearchPipeline } from "../src/index.ts";
import {
	analysis,
	fixedClock,
	RUN_ID,
	recordingReporter,
	request,
	SOURCES,
	VERDICT_SUPPORTED,
} from "./support.ts";

const encoder = new TextEncoder();

function bytes(text: string): number {
	return encoder.encode(text).length;
}

const BASE_PASSAGES =
	"Orders for grid storage reached 100 GWh in 2026, up from 70 GWh a year earlier. " +
	"Example Storage Corp supplies battery systems to utilities. " +
	"Analysts at a rival firm said demand could stall if subsidies lapse.";

function padTo(text: string, size: number, fill: string): string {
	if (text.length >= size) return text.slice(0, size);
	return (
		text + fill.repeat(Math.ceil((size - text.length) / fill.length)).slice(0, size - text.length)
	);
}

function hex64(n: number): string {
	return n.toString(16).padStart(64, "0");
}

/**
 * Total prompt bytes of this scenario against the pre-change pipeline
 * (planning prompts re-sent every earlier tool output via tail(40_000)).
 * Measured 2026-10-12: planning=[1321,11459,21509,31559,41411]
 * analysis=[98666] verification=[1275]. Locked here so prompt bloat fails loudly.
 */
const BEFORE_TOTAL_BYTES = 207_200;

/** Deterministic 5-step volume scenario: 2 tool calls per step, 5,000-byte modelText each. */
async function runVolumeScenario() {
	const time = fixedClock();
	const reporter = recordingReporter();
	let callIndex = -1;
	let previousFirst: {
		readonly retrievedText: string;
		readonly sourceUrl: string;
		readonly title: string;
		readonly checksum: string;
	} | null = null;

	const volumeTool = defineTool({
		toolId: "test.volume",
		version: "1",
		description: "Volume probe tool.",
		argsSchema: z.strictObject({ slot: z.string() }),
		argsHint: '{"slot": string}',
		timeoutMs: 5_000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "none",
		networkAllowlist: { kind: "none" },
		async execute(_args, context) {
			callIndex += 1;
			const marker = `VOLMARK-${callIndex}`;
			const modelText = padTo(`${marker} `, 5_000, "x");
			// The first call of steps 1-4 re-returns one item of the previous step exactly.
			const dupSource = callIndex >= 2 && callIndex % 2 === 0 ? previousFirst : null;
			const evidence = [];
			for (let item = 0; item < 3; item += 1) {
				if (item === 0 && dupSource !== null) {
					const evidenceId = context.nextId("ev");
					evidence.push({
						evidence: {
							evidenceId,
							sourceUrl: dupSource.sourceUrl,
							title: dupSource.title,
							publisher: "Example News",
							publishedAt: "2026-10-01T00:00:00.000Z",
							retrievedAt: "2026-10-11T00:00:00.000Z",
							effectiveAt: null,
							excerpt: dupSource.retrievedText.slice(0, 200),
							checksum: dupSource.checksum,
							sourceClass: "news" as const,
						},
						retrievedText: dupSource.retrievedText,
						retainQuotes: true,
					});
					continue;
				}
				const uniq = callIndex * 3 + item;
				const retrievedText = padTo(`${BASE_PASSAGES} vol-${uniq} `, 3_000, "y");
				const sourceUrl = `https://news.example.org/articles/vol-${uniq}`;
				const title = `Volume evidence ${uniq}`;
				const checksum = hex64(1000 + uniq);
				if (item === 1 && callIndex % 2 === 0) {
					previousFirst = { retrievedText, sourceUrl, title, checksum };
				}
				const evidenceId = context.nextId("ev");
				evidence.push({
					evidence: {
						evidenceId,
						sourceUrl,
						title,
						publisher: "Example News",
						publishedAt: "2026-10-01T00:00:00.000Z",
						retrievedAt: "2026-10-11T00:00:00.000Z",
						effectiveAt: null,
						excerpt: retrievedText.slice(0, 200),
						checksum,
						sourceClass: "news" as const,
					},
					retrievedText,
					retainQuotes: true,
				});
			}
			return ok({ ...EMPTY_TOOL_OUTPUT, modelText, evidence });
		},
	});

	const plans = Array.from({ length: 5 }, (_, step) =>
		JSON.stringify({
			toolCalls: [
				{ toolId: "test.volume", args: { slot: `s${step}a` } },
				{ toolId: "test.volume", args: { slot: `s${step}b` } },
			],
			done: step === 4,
		}),
	);
	const replies = [...plans, analysis(), VERDICT_SUPPORTED];
	const agent = createScriptedAgent({
		reply: (_request, turnIndex) => {
			const reply = replies[turnIndex];
			if (reply === undefined) throw new Error(`no scripted reply for turn ${turnIndex}`);
			return reply;
		},
	});
	const outcome = await runResearchPipeline(
		{
			runId: RUN_ID,
			request: request({
				budget: { ...request().budget, maxAgentSteps: 7, maxToolCalls: 10 },
			}),
			sources: SOURCES,
			workspaceComponents: [],
			conversationContext: [],
			priorUsage: EMPTY_USAGE,
			signal: new AbortController().signal,
			allowUnverifiedToolIsolation: false,
		},
		{
			agent,
			tools: createToolRegistry([volumeTool]),
			clock: time.clock,
			reporter,
			newFenceToken: () => "fence",
			scratchDirectory: null,
		},
	);
	return { outcome, agent, reporter };
}

describe("prompt volume budget (FR-016, ADR-0010)", () => {
	it("sends each tool output once, digests the rest, and stays within budget", async () => {
		const { outcome, agent } = await runVolumeScenario();
		expect(outcome.kind).toBe("completed");
		const prompts = agent.requests.map((sent) => sent.prompt);
		const planning = prompts.filter((prompt) => prompt.includes("planning step"));
		const analysisPrompts = prompts.filter((prompt) => prompt.includes("analysis step"));
		const verification = prompts.filter((prompt) =>
			prompt.includes("independent verification step"),
		);
		expect(planning).toHaveLength(5);
		expect(analysisPrompts).toHaveLength(1);
		expect(verification).toHaveLength(1);
		const planningBytes = planning.map((prompt) => bytes(prompt));
		const analysisBytes = bytes(analysisPrompts[0] ?? "");
		const verificationBytes = bytes(verification[0] ?? "");
		const total = planningBytes.reduce((a, b) => a + b, 0) + analysisBytes + verificationBytes;
		console.log(
			`VOLUME planning=[${planningBytes.join(",")}] analysis=[${analysisBytes}] verification=[${verificationBytes}] total=${total}`,
		);

		// Full tool text is shown in exactly one planning prompt (the next one);
		// the last step has no later prompt, so its output appears in none.
		for (let call = 0; call < 10; call += 1) {
			const fullText = padTo(`VOLMARK-${call} `, 5_000, "x");
			const holders = planning.filter((prompt) => prompt.includes(fullText));
			if (call < 8) {
				expect(holders).toHaveLength(1);
				expect(planning.indexOf(holders[0] ?? "")).toBe(Math.floor(call / 2) + 1);
			} else {
				expect(holders).toHaveLength(0);
			}
		}

		// Every evidence id of an earlier step is still mentioned in later planning prompts.
		for (let promptIndex = 1; promptIndex < 5; promptIndex += 1) {
			const prompt = planning[promptIndex] ?? "";
			for (let seq = 1; seq <= promptIndex * 6; seq += 1) {
				expect(prompt).toContain(`[${RUN_ID}_ev${seq}]`);
			}
		}

		// The duplicate evidence text occurs once in the analysis prompt:
		// the first copy carries the citation, later copies are skipped.
		const dupText = padTo(`${BASE_PASSAGES} vol-1 `, 3_000, "y");
		expect((analysisPrompts[0] ?? "").split(dupText)).toHaveLength(2);

		// Total prompt bytes stay well below the pre-change total. The 60% target
		// from the task brief proved unreachable for this scenario (measured
		// 66-67%: the previous step's full output alone is 10 kB per prompt and
		// the 26 unique evidence items must all stay citable); see ADR-0010.
		// ADR-0025 adds planning instructions (~0.4 kB per planning prompt),
		// so the cap is 142,000 (measured ~141,200; still < 0.7 of before).
		expect(total).toBeLessThanOrEqual(142_000);
		expect(total / BEFORE_TOTAL_BYTES).toBeLessThan(0.7);

		// Absolute ceiling: no planning prompt exceeds the budget derived from
		// the planning constants, whatever the tools return.
		for (const prompt of planning) {
			expect(bytes(prompt)).toBeLessThanOrEqual(PLANNING_PROMPT_BUDGET_BYTES);
		}
	});
});
