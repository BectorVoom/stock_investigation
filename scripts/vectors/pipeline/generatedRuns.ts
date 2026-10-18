/**
 * Seeded whole-pipeline scenarios (rr-spec-pipeline.md section 3.2-4). The
 * existing TypeScript tests give 67 hand-written runs; these add randomized
 * ones over the same real `runResearchPipeline`: random budgets, tools that
 * succeed / fail / return records, model replies that are valid, mutated,
 * fenced, native-tool-call or broken. Replies are derived from the prompt
 * actually received, so claims quote the real evidence text.
 */
import {
	createToolRegistry,
	defineTool,
	EMPTY_TOOL_OUTPUT,
	type ToolDefinition,
} from "@research/agent-core";
import type {
	AgentEvent,
	Evidence,
	ResearchRequest,
	SubscribedSourceRef,
	WorkspaceComponentSummary,
} from "@research/contracts";
import { EMPTY_USAGE, err, type JsonObject, ok } from "@research/domain";
import { z } from "zod";
import { createScriptedAgent } from "../../../examples/extensions/scriptedAgent.ts";
import type { ResearchPipelineInput } from "../../../packages/application/src/research/pipeline.ts";
import { seededRandom } from "../shared.ts";
import { capturedRunResearchPipeline } from "./capture.ts";
import { setCurrentCase } from "./harness.ts";

type Random = () => number;
const pick = <T>(random: Random, values: readonly T[]): T =>
	values[Math.floor(random() * values.length)] as T;
const int = (random: Random, low: number, high: number): number =>
	low + Math.floor(random() * (high - low + 1));
const chance = (random: Random, p: number): boolean => random() < p;

const RUN_ID = "run_gen";
const SENTENCES = [
	"Orders for grid storage reached 100 GWh in 2026, up from 70 GWh a year earlier.",
	"Example Storage Corp supplies battery systems to utilities.",
	"Analysts at a rival firm said demand could stall if subsidies lapse.",
	"Gross margin improved 120 bps while volumes grew 8.5% and prices rose 3.2%.",
	"売上高は1,234億円となり、前年比で12.5%増加した。",
	"Revenue was ＄４５６ million (fullwidth digits) in the period.",
	"Hitachi Ltd. (TSE: 6501) expects capacity of 2,000 MW by 2030.",
	"The İstanbul office closed; ΑΣ results were final.  Spaced　text﻿ here.",
	"Short interest fell to 1.2 million shares as reported on 2026-09-30.",
	"Emoji \u{1F4C8} appear in headlines sometimes and 0.5 percent is small.",
];
const PUBLISHERS = ["Example News", "Wire Service", "日本経済新聞", "  Trim Me  "];
const FEEDS = ["src_news", "src_other"];

function hex(random: Random): string {
	return Array.from({ length: 64 }, () => "0123456789abcdef"[int(random, 0, 15)]).join("");
}

function evidenceFor(
	random: Random,
	id: string,
	retrieved: string,
	long: boolean,
): { evidence: Evidence; retrievedText: string; retainQuotes: boolean } {
	const sentences = Array.from({ length: int(random, 1, long ? 120 : 6) }, () =>
		pick(random, chance(random, 0.5) ? SENTENCES.slice(0, 4) : SENTENCES),
	);
	const retrievedText = sentences.join(chance(random, 0.3) ? "\n" : " ");
	return {
		evidence: {
			evidenceId: id,
			sourceUrl: `https://news.example.org/articles/${id}`,
			title: pick(random, [
				"Grid storage orders rise",
				"Two\nline title",
				"日本の蓄電池需要",
				"T".repeat(int(random, 1, 300)),
			]),
			publisher: pick(random, PUBLISHERS).trim(),
			publishedAt: chance(random, 0.3) ? null : "2026-10-01T00:00:00.000Z",
			retrievedAt: retrieved,
			effectiveAt: chance(random, 0.2) ? "2026-09-30T00:00:00.000Z" : null,
			excerpt: Array.from(retrievedText).slice(0, 120).join(""),
			checksum: chance(random, 0.25) ? "c".repeat(64) : hex(random),
			sourceClass: pick(random, ["news", "regulatory-filing", "company-disclosure"] as const),
		},
		retrievedText,
		retainQuotes: chance(random, 0.7),
	};
}

function records(random: Random, context: { nextId: (prefix: string) => string }) {
	const securityId = context.nextId("sec");
	const output = { ...EMPTY_TOOL_OUTPUT };
	const securities = chance(random, 0.7)
		? [
				{
					securityId,
					country: "US" as const,
					ticker: pick(random, ["EXMP", "HTCH", "ABC.D"]),
					exchange: pick(random, ["NASDAQ", "NYSE"]),
					issuerName: "Example Storage Corp",
					issuerIdentifier: null,
					listingCurrency: "USD",
					reportingCurrency: null,
					listingVerification: pick(random, ["source-verified", "unverified"] as const),
					formerTickers: [],
				},
			]
		: [];
	const unavailable = chance(random, 0.5);
	const financialObservations = chance(random, 0.7)
		? [
				{
					observationId: context.nextId("fo"),
					securityId: chance(random, 0.8) ? securityId : "sec_orphan",
					metricCode: pick(random, ["revenue", "net-income"] as const),
					value: unavailable ? null : pick(random, [12.5, 1e21, 0.0000001, 100, 3]),
					unavailableReason: unavailable ? "not reported" : null,
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
					sourceEvidenceId: unavailable ? null : "run_gen_ev1",
				},
			]
		: [];
	const positionObservations = chance(random, 0.4)
		? [
				{
					observationId: context.nextId("po"),
					securityId: chance(random, 0.7) ? securityId : "sec_orphan",
					jurisdiction: "US" as const,
					metric: "us-short-interest" as const,
					figures: null,
					unavailableReason: "no licensed source",
					metricDefinition: "FINRA consolidated short interest",
					unit: "shares" as const,
					asOfDate: null,
					disseminatedAt: null,
					sourceEvidenceId: null,
				},
			]
		: [];
	const investorFilings = chance(random, 0.3)
		? [
				{
					filingId: context.nextId("fil"),
					investorName: "Example Capital",
					reportingEntityIdentifier: { scheme: "CIK" as const, value: "0000123456" },
					form: "13F-HR",
					reportPeriodEnd: "2026-06-30",
					filedAt: "2026-08-14",
					filingUrl: "https://www.sec.gov/Archives/edgar/data/1/x.txt",
					holdings: [],
					sourceEvidenceId: "run_gen_ev1",
				},
			]
		: [];
	const articles = chance(random, 0.5)
		? Array.from({ length: int(random, 1, 3) }, (_, index) => ({
				sourceId: "src_news",
				canonicalUrl: `https://news.example.org/a/${int(random, 1, 3)}`,
				publisher: "Example News",
				title: `Article ${index}`,
				publishedAt: null,
				retrievedAt: "2026-10-11T00:00:00.000Z",
				contentFingerprint: hex(random),
				excerpt: null,
			}))
		: [];
	return {
		...output,
		securities,
		financialObservations,
		positionObservations,
		investorFilings,
		articles,
	};
}

interface World {
	readonly tools: ToolDefinition[];
	readonly advance: (ms: number) => void;
}

function buildTools(
	random: Random,
	advanceClock: (ms: number) => void,
	nowIso: () => string,
): ToolDefinition[] {
	const failureRate = pick(random, [0, 0, 0, 0, 0.1, 0.5, 1]);
	const base = {
		version: "1",
		timeoutMs: 5_000,
		permission: "research-read" as const,
		costCategory: "free" as const,
	};
	const maybeFail = () => {
		advanceClock(chance(random, 0.1) ? int(random, 5_000, 30_000) : int(random, 0, 50));
		if (!chance(random, failureRate)) return null;
		return err({
			code: pick(random, ["FETCH_FAILED", "lowercase_code", "X".repeat(100), "UNSAFE_URL", "A"]),
			detail: "scripted failure",
			retryable: chance(random, 0.5),
		});
	};
	const evidenceTool = (
		toolId: string,
		networkAllowlist: ToolDefinition["networkAllowlist"],
		argsSchema: z.ZodType,
		argsHint: string,
		long: boolean,
	) =>
		defineTool({
			...base,
			toolId,
			description: `Scripted ${toolId}.`,
			argsSchema,
			argsHint,
			sideEffect: "external-read",
			networkAllowlist,
			async execute(_args, context) {
				const failed = maybeFail();
				if (failed !== null) return failed;
				const items = Array.from({ length: pick(random, [1, 1, 1, 2, 3, 6, 0]) }, () =>
					evidenceFor(random, context.nextId("ev"), nowIso(), long && chance(random, 0.4)),
				);
				return ok({
					...EMPTY_TOOL_OUTPUT,
					modelText: items
						.map(
							(item) =>
								`[${item.evidence.evidenceId}] ${item.evidence.title}\n${item.retrievedText}`,
						)
						.join("\n\n"),
					evidence: items,
				});
			},
		});
	const recordsTool = defineTool({
		...base,
		toolId: "records.lookup",
		description: "Scripted records.",
		argsSchema: z.strictObject({ ticker: z.string() }),
		argsHint: '{"ticker": string}',
		sideEffect: "none",
		networkAllowlist: { kind: "none" },
		async execute(_args, context) {
			const failed = maybeFail();
			if (failed !== null) return failed;
			return ok({
				...records(random, context),
				modelText: `records ${pick(random, ["ok", "Ünïcode ✓", ""])}`,
			});
		},
	});
	const tools = [
		evidenceTool(
			"news.fetch_feed",
			{ kind: "subscribed-sources" },
			z.strictObject({ sourceId: z.string() }),
			'{"sourceId": string}',
			false,
		),
		evidenceTool(
			"web.search",
			{ kind: "public-web" },
			z.strictObject({ query: z.string().min(1) }),
			'{"query": string}',
			true,
		),
		recordsTool,
	];
	return tools;
}

function planReply(random: Random, step: number): readonly AgentEvent[] | string {
	const call = () =>
		pick(random, [
			{ toolId: "news.fetch_feed", args: { sourceId: pick(random, FEEDS) } },
			{ toolId: "news.fetch_feed", args: { sourceId: 7 } },
			{ toolId: "web.search", args: { query: "battery demand" } },
			{ toolId: "records.lookup", args: { ticker: "EXMP" } },
			{ toolId: "shell", args: { cmd: "id" } },
			{ toolId: "x".repeat(100), args: {} },
		]);
	// Most plans lead with a call that can succeed, so runs reach analysis.
	const good = [
		{ toolId: "news.fetch_feed", args: { sourceId: "src_news" } },
		{ toolId: "web.search", args: { query: "battery demand" } },
		{ toolId: "records.lookup", args: { ticker: "EXMP" } },
	];
	const first = () => (chance(random, 0.85) ? pick(random, good) : call());
	const plan = () =>
		JSON.stringify({
			toolCalls: Array.from({ length: pick(random, [1, 1, 1, 2, 3, 10, 0]) }, (_, i) =>
				i === 0 ? first() : call(),
			),
			...(chance(random, 0.5) ? { done: chance(random, 0.5) } : {}),
		});
	const delta = (text: string): AgentEvent => ({ type: "text.delta", text });
	switch (
		step === 0 && chance(random, 0.8)
			? "plan"
			: pick(random, [
					"plan",
					"plan",
					"plan",
					"plan",
					"plan",
					"plan",
					"plan",
					"plan",
					"plan",
					"fenced",
					"fenced",
					"junk",
					"native",
					"native-ui",
					"failed",
					"no-complete",
					"cost",
					"empty-done",
					"bad-schema",
				])
	) {
		case "fenced":
			return `Here is the plan:\n\`\`\`json\n${plan()}\n\`\`\`\nDone.`;
		case "junk":
			return pick(random, ["I cannot do that.", "{broken", "[]", ""]);
		case "native":
			return [
				delta("thinking"),
				{
					type: "tool.request",
					toolId: "news.fetch_feed",
					args: { sourceId: "src_news" },
					callId: `c${step}a`,
				},
				{ type: "tool.request", toolId: "web.search", args: { query: "x" }, callId: `c${step}b` },
				{ type: "completed" },
			];
		case "native-ui":
			return [
				delta(plan()),
				{
					type: "ui.command",
					command: { operation: "component.remove", componentId: "run_old_x" },
				},
				{
					type: "tool.request",
					toolId: "records.lookup",
					args: { ticker: "EXMP" },
					callId: `c${step}`,
				},
				{ type: "completed" },
			];
		case "failed":
			return [
				delta(plan()),
				{
					type: "failed",
					code: pick(random, ["PROVIDER_DOWN", "RATE_LIMITED", "Z".repeat(60)]),
					retryable: chance(random, 0.5),
				},
			];
		case "no-complete":
			return [delta(plan())];
		case "cost":
			return [
				delta(plan()),
				{ type: "usage", knownCostUsd: pick(random, [0, 0.01, 0.5, 2.5, null]) },
				{ type: "completed" },
			];
		case "empty-done":
			return JSON.stringify({ toolCalls: [], done: true });
		case "bad-schema":
			return JSON.stringify({ toolCalls: [{ toolId: "news.fetch_feed" }] });
		default:
			return plan();
	}
}

/** Evidence blocks parsed back out of the analysis prompt: id and text. */
function evidenceInPrompt(prompt: string): { id: string; text: string }[] {
	const start = prompt.indexOf("Evidence (cite ONLY");
	const body = start < 0 ? "" : prompt.slice(start);
	const found: { id: string; text: string }[] = [];
	const pattern = /^\[(run_gen_ev\d+)\] [^\n]*?; retrieved [^\n]*\n([\s\S]*?)\n\n/gm;
	for (let match = pattern.exec(body); match !== null; match = pattern.exec(body))
		found.push({ id: match[1] ?? "", text: match[2] ?? "" });
	return found;
}

/** A passage cut on code-point boundaries: a lone surrogate is the documented ADR-0030 divergence, not under test here. */
function quoteOf(random: Random, text: string): string {
	const points = Array.from(text);
	if (points.length < 20 || chance(random, 0.1))
		return pick(random, ["", "not in the text at all", "short"]);
	const length = int(random, 12, Math.min(90, points.length));
	const start = int(random, 0, points.length - length);
	return points.slice(start, start + length).join("");
}

function analysisReply(
	random: Random,
	prompt: string,
	step: number,
): readonly AgentEvent[] | string {
	const evidence = evidenceInPrompt(prompt);
	const any = () =>
		evidence.length === 0 || chance(random, 0.08)
			? { id: "run_gen_ev99", text: "" }
			: pick(random, evidence);
	const claim = () => {
		const source = any();
		return {
			text: pick(random, [
				"Grid storage orders reached 100 GWh in 2026.",
				"Revenue was 456 million.",
				"  Padded claim text  ",
				"The thesis is plausible.",
				"売上高は1234億円。",
				"x".repeat(1100),
			]),
			claimType: pick(random, ["observation", "inference", "hypothesis", "forecast"]),
			evidence: Array.from({ length: pick(random, [0, 1, 1, 2, 3]) }, () => ({
				evidenceId: source.id,
				relation: pick(random, ["supports", "supports", "contradicts", "context"]),
				quote: chance(random, 0.1) ? null : quoteOf(random, source.text),
			})),
		};
	};
	const scenario = () => {
		const source = any();
		const target = (n: number) => ({
			targetValue: n,
			assumptions: chance(random, 0.9) ? ["A driver holds"] : [],
		});
		return {
			productOrService: "Grid-scale battery storage",
			quantityKind: pick(random, ["unit-demand", "revenue", "price"]),
			unit: pick(random, ["GWh per year", " "]),
			baseYear: 2026,
			targetYear: pick(random, [2030, 2030, 2029, 2040]),
			baselineValue: chance(random, 0.7) ? pick(random, [100, 70, 456, 1234]) : null,
			baselineEvidenceId: source.id,
			baselineQuote: chance(random, 0.6) ? quoteOf(random, source.text) : null,
			bear: target(pick(random, [146.41, 90])),
			base: target(pick(random, [207.36, 100, 207.36])),
			bull: target(pick(random, [285.61, 400])),
			drivers: chance(random, 0.9) ? ["Renewable build-out"] : [],
			barriers: ["Interconnection queues"],
			falsifiers: ["Orders fall"],
			methodology: "Extrapolation.",
			supportingEvidenceIds: [source.id, source.id, "run_gen_ev3"],
			contraryEvidenceIds: chance(random, 0.5) ? [source.id] : [],
		};
	};
	const NAMING = "Example Storage Corp supplies battery systems to utilities";
	const supplier = () => {
		const naming = evidence.find((item) => item.text.includes(NAMING));
		if (naming !== undefined && chance(random, 0.75)) {
			return {
				issuerName: "Example Storage Corp",
				ticker: pick(random, ["EXMP", " exmp "]),
				exchange: "NASDAQ",
				country: "US",
				productsOrServices: ["Battery systems"],
				businessExposure: "Supplies battery systems to utilities.",
				scenarioIndex: pick(random, [0, null]),
				evidence: [{ evidenceId: naming.id, quote: NAMING }],
			};
		}
		const source = any();
		return {
			issuerName: pick(random, ["Example Storage Corp", "Hitachi Ltd.", "Nobody Inc"]),
			ticker: pick(random, ["EXMP", " hitachi ", "6501", "bad ticker!"]),
			exchange: pick(random, ["NASDAQ", "TSE", "XYZ"]),
			country: pick(random, ["US", "JP"]),
			productsOrServices: pick(random, [
				["Battery systems"],
				["Battery systems", "capacity of 2,000 MW"],
			]),
			businessExposure: pick(random, [
				"Supplies battery systems to utilities.",
				"Revenue of 999 million.",
			]),
			scenarioIndex: pick(random, [0, 1, null, 5]),
			evidence: [{ evidenceId: source.id, quote: quoteOf(random, source.text) }],
		};
	};
	const pricing = () => {
		const disclosing = evidence.find((item) => item.text.includes("Gross margin improved 120 bps"));
		const source = disclosing !== undefined && chance(random, 0.75) ? disclosing : any();
		return {
			ticker: "EXMP",
			exchange: "NASDAQ",
			fiscalYear: 2026,
			fiscalPeriod: pick(random, ["FY", "Q3"]),
			periodStart: "2026-01-01",
			periodEnd: pick(random, ["2026-12-31", "2026-02-30", "2025-01-01"]),
			priceRealizationPct: pick(random, [3.2, 3.2, 9.9, null]),
			volumeGrowthPct: pick(random, [8.5, null]),
			revenueGrowthPct: pick(random, [12.5, 1, null]),
			grossMarginChangeBps: pick(random, [120, null]),
			evidenceIds: [source.id],
		};
	};
	const ui = (): JsonObject =>
		pick<JsonObject>(random, [
			{ operation: "component.remove", componentId: "run_old_1" },
			{ operation: "component.remove", componentId: "run_gen_report" },
			{
				operation: "component.create",
				componentId: "mine",
				componentType: "bar-chart",
				schemaVersion: 1,
				props: { title: "t", datasetRef: "run_gen_ds_growth" },
			},
			{
				operation: "component.create",
				componentId: "mine",
				componentType: "research-report",
				schemaVersion: 1,
				props: {},
			},
			{ operation: "component.focus", componentId: "mine" },
			{ nonsense: true },
		]);
	const draft = JSON.stringify({
		claims: Array.from({ length: pick(random, [0, 1, 2, 4, 6]) }, claim),
		scenarios: Array.from({ length: pick(random, [0, 1, 2, 3]) }, scenario),
		suppliers: Array.from({ length: pick(random, [0, 1, 1, 2]) }, supplier),
		pricingPower: Array.from({ length: pick(random, [0, 1, 1, 2]) }, pricing),
		uiOperations: Array.from({ length: pick(random, [0, 0, 1, 3]) }, ui),
	});
	switch (
		pick(random, ["ok", "ok", "ok", "ok", "ok", "junk", "bad-schema", "failed", "cost", "ui-event"])
	) {
		case "junk":
			return "no json here";
		case "bad-schema":
			return JSON.stringify({ claims: "nope", scenarios: 5 });
		case "failed":
			return [
				{ type: "text.delta", text: draft },
				{ type: "failed", code: "PROVIDER_DOWN", retryable: true },
			];
		case "cost":
			return [
				{ type: "text.delta", text: draft },
				{ type: "usage", knownCostUsd: pick(random, [0.05, null, 3]) },
				{ type: "completed" },
			];
		case "ui-event":
			return [
				{ type: "text.delta", text: draft },
				{ type: "ui.command", command: ui() },
				{ type: "completed" },
			];
		default:
			return step % 2 === 0 ? draft : `Sure!\n\`\`\`json\n${draft}\n\`\`\``;
	}
}

function verdictReply(random: Random, prompt: string): readonly AgentEvent[] | string {
	const indexes = [...prompt.matchAll(/^Claim (\d+): /gm)].map((match) => Number(match[1]));
	const verdicts = indexes.map((claimIndex) => ({
		claimIndex,
		verdict: pick(random, ["supported", "supported", "supported", "unsupported", "contradicted"]),
	}));
	if (chance(random, 0.15))
		verdicts.push({ claimIndex: pick(random, [0, 99]), verdict: "supported" });
	switch (pick(random, ["ok", "ok", "ok", "ok", "junk", "failed", "empty"])) {
		case "junk":
			return "cannot say";
		case "failed":
			return [{ type: "failed", code: "PROVIDER_DOWN", retryable: false }];
		case "empty":
			return "{}";
		default:
			return JSON.stringify({ verdicts });
	}
}

function scenarioInput(random: Random): {
	input: Omit<ResearchPipelineInput, "signal">;
	metered: boolean;
} {
	const metered = chance(random, 0.1);
	const maxSpendUsd = metered
		? pick(random, [null, 0.05, 1, 5, 5, 5])
		: pick(random, [null, null, 2]);
	const request: ResearchRequest = {
		workspaceId: "ws_gen",
		question: pick(random, [
			"Which storage products will see demand growth?",
			"日本の蓄電池需要はどう変わるか?",
			"Q ".repeat(300).trim(),
		]),
		agentId: "scripted",
		model: pick(random, [null, "gpt-x"]),
		effort: pick(random, ["low", "medium", "high"] as const),
		horizonYears: pick(random, [3, 4, 5] as const),
		markets: pick(random, [
			["JP"],
			["US"],
			["JP", "US"],
		] as const).slice() as ResearchRequest["markets"],
		budget: {
			maxAgentSteps: pick(random, [1, 2, 4, 5, 6, 6, 6, 8, 12, 12, 12, 12, 12, 12]),
			maxToolCalls: pick(random, [0, 1, 3, 10, 10, 60, 60, 60, 60, 60, 60]),
			maxWallClockMs: pick(random, [30_000, 60_000, 600_000]),
			maxInputBytes: pick(random, [10_000, 30_000, 120_000, 400_000]),
			maxSpendUsd,
		},
		webAccess: pick(random, ["off", "public-web"] as const),
	};
	const sources: SubscribedSourceRef[] = pick(random, [
		[],
		[
			{
				sourceId: "src_news",
				canonicalUrl: "https://news.example.org/feed.xml",
				publisher: "Example News",
				title: "Example News",
				licensePolicy: "short-excerpt-permitted" as const,
			},
		],
	]);
	const components: WorkspaceComponentSummary[] = chance(random, 0.3)
		? [
				{
					componentId: "run_old_1",
					componentType: "data-table",
					title: chance(random, 0.5) ? null : "Old table",
				},
			]
		: [];
	return {
		metered,
		input: {
			runId: RUN_ID,
			request,
			sources,
			workspaceComponents: components,
			conversationContext: chance(random, 0.3)
				? [{ role: "owner", text: "Earlier question about grid storage." }]
				: [],
			priorUsage: chance(random, 0.2)
				? {
						agentSteps: int(random, 0, 3),
						toolCalls: int(random, 0, 5),
						inputBytes: int(random, 0, 9000),
						knownCostUsd: pick(random, [0, 0.4]),
						hasUnmeteredUsage: false,
					}
				: EMPTY_USAGE,
			allowUnverifiedToolIsolation: false,
		},
	};
}

/** Runs `count` generated scenarios through the capturing pipeline wrapper. */
export async function generateRuns(count: number): Promise<void> {
	const random = seededRandom(9099);
	for (let index = 0; index < count; index++) {
		const { input, metered } = scenarioInput(random);
		let nowMs = Date.parse("2026-10-11T00:00:00.000Z");
		const clock = { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() };
		const world: World = {
			tools: buildTools(random, (ms) => (nowMs += ms), clock.nowIso),
			advance: (ms) => (nowMs += ms),
		};
		let turn = 0;
		const unavailable = chance(random, 0.04);
		const isolation = chance(random, 0.05) ? ("unverified" as const) : ("enforced" as const);
		const agent = createScriptedAgent({
			costModel: metered ? "metered" : "plan-limited",
			toolIsolation: isolation,
			...(unavailable
				? {
						availability: {
							status: "unavailable" as const,
							reasonCode: "NOT_AUTHENTICATED" as const,
							detail: "log in",
						},
					}
				: {}),
			...(metered || chance(random, 0.3)
				? { costPerTurnUsd: pick(random, [0.01, 0.2, null]) }
				: {}),
			reply: (request) => {
				const step = turn++;
				if (request.prompt.startsWith("You are the planning step")) return planReply(random, step);
				if (request.prompt.startsWith("You are the analysis step"))
					return analysisReply(random, request.prompt, step);
				return verdictReply(random, request.prompt);
			},
		});
		let fence = 0;
		const controller = new AbortController();
		if (chance(random, 0.02)) controller.abort();
		setCurrentCase(`gen/${index}`);
		await capturedRunResearchPipeline(
			{ ...input, signal: controller.signal },
			{
				agent,
				tools: createToolRegistry(world.tools),
				clock,
				reporter: { async state() {}, async note() {}, async tool() {}, async usage() {} },
				newFenceToken: () => `fence-${++fence}`,
				scratchDirectory: pick(random, [null, null, "/tmp/scratch"]),
			},
		);
	}
}
