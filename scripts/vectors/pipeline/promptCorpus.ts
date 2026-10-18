/**
 * Seeded prompt corpus (rr-spec-pipeline.md section 3.2-3): the REAL
 * TypeScript builders over generated inputs, concentrated on every byte
 * budget edge (tool catalog 4 000, sources 8 000, context 4 000, the
 * collected section's remainder of the planning budget) and on multi-byte
 * text (CJK, emoji, combining marks) that straddles each cut.
 */
import { fenceUntrustedText, type ToolDefinition } from "@research/agent-core";
import type {
	ConversationContextMessage,
	ResearchRequest,
	SubscribedSourceRef,
	WorkspaceComponentSummary,
} from "@research/contracts";
import { datasetGuide } from "../../../packages/application/src/research/presentation.ts";
import { PLANNING_REMINDER } from "../../../packages/application/src/research/prompts.ts";
import { seededRandom } from "../shared.ts";
import {
	capturedAnalysisPrompt,
	capturedPlanningPrompt,
	capturedVerificationPrompt,
} from "./capture.ts";

const WORDS = [
	"storage",
	"grid",
	"demand",
	"battery",
	"Q3",
	"results",
	"ticker",
	"TSE:6501",
	"(note)",
	'"quoted"',
	"{braces}",
	"back\\slash",
];
const CJK = Array.from("日本銀行政策金利蓄電池需要予測供給網半導体電力会社株価決算発表");
const EMOJI = ["\u{1F600}", "\u{1F4C8}", "\u{1F1EF}\u{1F1F5}", "é", "\u{FEFF}", "\u0085"];

type Random = () => number;
const pick = <T>(random: Random, values: readonly T[]): T =>
	values[Math.floor(random() * values.length)] as T;
const int = (random: Random, low: number, high: number): number =>
	low + Math.floor(random() * (high - low + 1));

/** Text of exactly `codePoints` code points drawn from a mix of scripts. */
function text(
	random: Random,
	codePoints: number,
	style: "ascii" | "cjk" | "mixed" = "mixed",
): string {
	const out: string[] = [];
	while (out.length < codePoints) {
		const roll = random();
		if (style === "ascii" || (style === "mixed" && roll < 0.45))
			out.push(...Array.from(`${pick(random, WORDS)} `));
		else if (style === "cjk" || roll < 0.9) out.push(pick(random, CJK));
		else out.push(...Array.from(pick(random, EMOJI)));
	}
	return out
		.slice(0, codePoints)
		.join("")
		.replace(/[\uD800-\uDBFF]$/, "x");
}

const bytes = (value: string): number => new TextEncoder().encode(value).length;
const fenceToken = (random: Random, index: number): string =>
	`fence-${index}-${Math.floor(random() * 1e6).toString(36)}`;

function request(random: Random): ResearchRequest {
	const markets =
		random() < 0.4
			? (["JP"] as const)
			: random() < 0.5
				? (["US"] as const)
				: (["JP", "US"] as const);
	return {
		workspaceId: "ws_gen",
		question: `${text(random, int(random, 3, 300)).trim() || "question"} ?`,
		agentId: "scripted",
		model: null,
		effort: "medium",
		horizonYears: pick(random, [3, 4, 5] as const),
		markets: [...markets],
		budget: {
			maxAgentSteps: 6,
			maxToolCalls: 10,
			maxWallClockMs: 600_000,
			maxInputBytes: 400_000,
			maxSpendUsd: null,
		},
		webAccess: "off",
	};
}

function tools(random: Random): ToolDefinition[] {
	const count = pick(random, [0, 1, 3, 6, 12, 30]);
	return Array.from({ length: count }, (_, index) => ({
		toolId: `tool.generated_${index}`,
		version: `${int(random, 0, 3)}.${int(random, 0, 9)}.${int(random, 0, 20)}`,
		description: text(random, pick(random, [10, 150, 199, 200, 201, 260, 400])),
		argsHint:
			random() < 0.3
				? `{"sourceId": string, "n"?: number} ${text(random, int(random, 0, 230))}`
				: text(random, pick(random, [5, 120, 200, 201, 230])),
		timeoutMs: 15_000,
		permission: "research-read",
		costCategory: "free",
		sideEffect: "external-read",
		networkAllowlist:
			random() < 0.5 ? { kind: "subscribed-sources" } : { kind: "hosts", hosts: ["example.com"] },
	})) as unknown as ToolDefinition[];
}

function sources(random: Random): SubscribedSourceRef[] {
	const count = pick(random, [0, 1, 5, 40, 40, 100, 250]);
	return Array.from({ length: count }, (_, index) => ({
		sourceId: `src_${index}`,
		canonicalUrl: `https://news${index}.example.com/feed.xml`,
		publisher: text(
			random,
			pick(random, [5, 79, 80, 81, 150]),
			pick(random, ["ascii", "cjk", "mixed"] as const),
		),
		title: text(
			random,
			pick(random, [5, 79, 80, 81, 200]),
			pick(random, ["ascii", "cjk", "mixed"] as const),
		),
		licensePolicy: random() < 0.5 ? "short-excerpt-permitted" : "headline-and-link-only",
	}));
}

function context(random: Random): ConversationContextMessage[] {
	const count = pick(random, [0, 0, 1, 2, 6, 6]);
	return Array.from({ length: count }, (_, index) => ({
		role: index % 2 === 0 ? ("owner" as const) : ("assistant" as const),
		text: text(
			random,
			pick(random, [5, 120, 300, 600]),
			pick(random, ["ascii", "cjk", "mixed"] as const),
		),
	}));
}

function components(random: Random): WorkspaceComponentSummary[] {
	const count = pick(random, [0, 1, 4, 20]);
	return Array.from({ length: count }, (_, index) => ({
		componentId: `run_prev_${index}`,
		componentType: pick(random, ["data-table", "bar-chart", "research-report", "source-list"]),
		title: random() < 0.4 ? null : text(random, int(random, 1, 60)),
	}));
}

/** Registers generated cases in the shared `prompts` list through the capturing builders. */
export function generatePromptCases(): void {
	const random = seededRandom(7707);
	let counter = 0;
	// Planning: edge sweeps of the collected section for each configuration.
	for (let config = 0; config < 20; config++) {
		const base = {
			request: request(random),
			nowIso: "2026-10-11T08:09:10.000Z",
			tools: tools(random),
			sources: sources(random),
			remainingToolCalls: int(random, 0, 60),
			conversationContext: context(random),
			reminder: pick(random, [null, undefined, "", PLANNING_REMINDER, text(random, 40)] as const),
		};
		const token = fenceToken(random, ++counter);
		const withCollected = (collectedSoFar: string, promptBudgetBytes: number) =>
			({ ...base, collectedSoFar, promptBudgetBytes, fenceToken: token }) as Parameters<
				typeof capturedPlanningPrompt
			>[0];
		// The collected section's budget is B - fixed - overhead; sweep B across it.
		// Heavy bases (hundreds of sources) get fewer variants to keep the files small.
		const heavy = base.sources.length >= 100 || base.tools.length >= 12;
		const empty = capturedPlanningPrompt(withCollected("", 76_000));
		const fixed = bytes(empty) - bytes("(nothing yet)");
		const overhead = bytes(fenceUntrustedText("collected tool output", "", token));
		for (const style of ["ascii", "cjk", "mixed"] as const) {
			const length = pick(random, [20, 300, 1500]);
			const collected = text(random, length, style) + (random() < 0.3 ? token : "");
			const size = bytes(collected);
			const notice = bytes("\n[collected output truncated to the planning budget]");
			for (const delta of heavy
				? [-notice - 1, 0]
				: [-notice - 3, -notice - 1, -notice, -1, 0, 1, 2]) {
				capturedPlanningPrompt(withCollected(collected, fixed + overhead + size + delta));
			}
		}
		if (config % 12 === 0) {
			capturedPlanningPrompt(withCollected(text(random, 30_000, "cjk"), 76_000));
			capturedPlanningPrompt(withCollected(text(random, 80_000, "ascii"), 76_000));
		}
		capturedPlanningPrompt(withCollected(text(random, 200, "ascii"), 0));
		capturedPlanningPrompt(withCollected("", 0));
	}
	// Analysis.
	for (let index = 0; index < 40; index++) {
		const token = fenceToken(random, ++counter);
		const guide = datasetGuide(`run_${index}`);
		capturedAnalysisPrompt({
			request: request(random),
			nowIso: "2026-10-11T00:00:00.000Z",
			evidencePack:
				text(random, pick(random, [0, 10, 800, 3000]), "mixed") + (random() < 0.3 ? token : ""),
			recordSummary: pick(random, ["(none)", text(random, 300)]),
			datasetGuide: guide,
			existingComponents: components(random),
			conversationContext: context(random),
			fenceToken: token,
			repairNote:
				random() < 0.5
					? null
					: pick(random, ["invalid fields: claims.0.text, scenarios", text(random, 120), ""]),
		});
	}
	// Verification.
	for (let index = 0; index < 60; index++) {
		const token = fenceToken(random, ++counter);
		const claims = Array.from({ length: int(random, 0, 8) }, (_, claimIndex) => ({
			index: claimIndex * int(random, 1, 3),
			text: text(random, int(random, 1, 200)),
			passages:
				Array.from(
					{ length: int(random, 0, 3) },
					() => `"${text(random, int(random, 12, 80))}"`,
				).join("\n") + (random() < 0.2 ? token : ""),
		}));
		capturedVerificationPrompt({ claims, fenceToken: token });
	}
}
