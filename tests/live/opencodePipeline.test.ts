/**
 * Opt-in live pipeline test: the real OpenCode backend through the whole
 * research pipeline on fixed fixture news (never the network).
 *
 * Skipped unless RUN_LIVE_OPENCODE=1, so `bun run test` and CI stay
 * deterministic and offline. With the switch on but OPENCODE_MODEL unset the
 * test fails with a clear message instead of letting the CLI pick a provider
 * on its own (AGT-012).
 *
 *   RUN_LIVE_OPENCODE=1 OPENCODE_MODEL=opencode-go/muse-spark-1.3-contributor \
 *     node_modules/.bin/vitest run --project node tests/live/opencodePipeline.test.ts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedParser } from "@research/adapters/feed";
import { createBaselineAgentRuntimes, createNodeProcessRunner } from "@research/adapters/providers";
import { systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createResearchTools } from "@research/adapters/tools";
import { createToolRegistry } from "@research/agent-core";
import { type PipelineReporter, PROMPT_VERSION, runResearchPipeline } from "@research/application";
import { researchBundleSchema } from "@research/contracts";
import { EMPTY_USAGE, type JobState, type ResourceUsage, summarizeCost } from "@research/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEED_URL, fixtureFetcher, HEADLINE } from "../e2e/fixtures.ts";

const LIVE = process.env.RUN_LIVE_OPENCODE === "1";
/** Generous timeout: a real model may take minutes for several turns. */
const PIPELINE_TIMEOUT_MS = 900_000;
const RUN_ID = "run_live_opencode";

/** Lifecycle order of the pipeline states (ARCH-015). */
const LIFECYCLE: readonly JobState[] = [
	"planning",
	"collecting",
	"analyzing",
	"verifying",
	"publishing",
];

interface RecordedProgress {
	readonly states: JobState[];
	readonly notes: string[];
	readonly tools: { toolId: string; outcome: string; detail: string }[];
	readonly usage: ResourceUsage[];
}

function recordingReporter(): PipelineReporter & { readonly recorded: RecordedProgress } {
	const recorded: RecordedProgress = { states: [], notes: [], tools: [], usage: [] };
	return {
		recorded,
		async state(state) {
			recorded.states.push(state);
		},
		async note(text) {
			recorded.notes.push(text);
		},
		async tool(toolId, outcome, detail) {
			recorded.tools.push({ toolId, outcome, detail });
		},
		async usage(usage) {
			recorded.usage.push(usage);
		},
	};
}

describe.skipIf(!LIVE)("live OpenCode research pipeline (spends real quota)", () => {
	let scratchDirectory = "";

	beforeAll(async () => {
		scratchDirectory = await mkdtemp(join(tmpdir(), "research-live-opencode-"));
	});

	afterAll(async () => {
		if (scratchDirectory !== "") await rm(scratchDirectory, { recursive: true, force: true });
	});

	it(
		"completes a fixture-fed run with a verifiable bundle",
		async () => {
			const model = process.env.OPENCODE_MODEL;
			if (model === undefined || model.trim() === "") {
				throw new Error(
					"RUN_LIVE_OPENCODE=1 requires OPENCODE_MODEL=provider/model in the environment, so the CLI never picks a provider on its own",
				);
			}

			const runtimes = createBaselineAgentRuntimes({
				processRunner: createNodeProcessRunner(),
				fetch,
				env: process.env,
			});
			const agent = runtimes.find((runtime) => runtime.agentId === "opencode");
			if (agent === undefined) throw new Error("expected an opencode runtime in the baselines");

			const reporter = recordingReporter();
			const feedParser = createFeedParser();
			const tools = createToolRegistry(
				createResearchTools({
					fetcher: fixtureFetcher,
					feedParser,
					hasher: webCryptoHasher,
					clock: systemClock,
					secUserAgent: null,
					tavilyApiKey: null,
					// No page archive: the web tool is not registered, so the run is feed-only.
					pageArchive: null,
					sleep: (ms, signal) =>
						new Promise<void>((resolve) => {
							if (signal.aborted) {
								resolve();
								return;
							}
							const timer = setTimeout(resolve, ms);
							signal.addEventListener("abort", () => {
								clearTimeout(timer);
								resolve();
							});
						}),
				}),
			);
			// The run is feed-only by construction: without an archive there is
			// nowhere to keep a page (DATA-010), so the web tool must be absent.
			expect(tools.list().map((tool) => tool.toolId)).not.toContain("web.fetch_page");

			const startedMs = Date.now();
			const outcome = await runResearchPipeline(
				{
					runId: RUN_ID,
					request: {
						workspaceId: "ws_live",
						question:
							"What did grid storage orders reach in 2026, and which company supplies battery systems to utilities?",
						agentId: "opencode",
						model: null,
						effort: "low",
						horizonYears: 5,
						markets: ["JP", "US"],
						budget: {
							maxAgentSteps: 6,
							maxToolCalls: 8,
							maxWallClockMs: 600_000,
							maxInputBytes: 400_000,
							maxSpendUsd: null,
						},
						webAccess: "off",
					},
					sources: [
						{
							sourceId: "src_e2e_fixture",
							canonicalUrl: FEED_URL,
							publisher: "Example Energy News",
							title: "Example Energy News (synthetic)",
							licensePolicy: "short-excerpt-permitted",
						},
					],
					workspaceComponents: [],
					conversationContext: [],
					priorUsage: EMPTY_USAGE,
					signal: new AbortController().signal,
					allowUnverifiedToolIsolation: false,
				},
				{
					agent,
					tools,
					clock: systemClock,
					reporter,
					newFenceToken: () => crypto.randomUUID(),
					scratchDirectory,
				},
			);
			const durationMs = Date.now() - startedMs;

			const bundle =
				outcome.kind === "completed" || outcome.kind === "partial" ? outcome.bundle : null;
			const evidenceCount = bundle?.evidence.length ?? 0;
			const claims = bundle?.claims ?? [];
			const statusCount = (status: string) =>
				claims.filter((claim) => claim.status === status).length;
			// Printed with stdout (not console.log) so the summary stays visible
			// when vitest hides passing-test console output.
			process.stdout.write(
				`${JSON.stringify({
					outcome: outcome.kind,
					failureCode:
						outcome.kind === "partial" || outcome.kind === "failed" ? outcome.failureCode : null,
					steps: outcome.usage.agentSteps,
					toolCalls: outcome.usage.toolCalls,
					inputBytes: outcome.usage.inputBytes,
					evidence: evidenceCount,
					claims: {
						supported: statusCount("supported"),
						conflicting: statusCount("conflicting"),
						unsupported: statusCount("unsupported"),
					},
					scenarios: bundle?.scenarios.length ?? 0,
					suppliers: bundle?.supplierLinks.length ?? 0,
					durationMs,
				})}\n`,
			);

			// A partial or failed outcome is a finding, not something to assert
			// around: fail with the failure code and the recorded notes.
			if (outcome.kind !== "completed") {
				const detail =
					outcome.kind === "cancelled" || outcome.kind === "waiting_approval"
						? outcome.kind
						: outcome.failureCode;
				throw new Error(
					`live pipeline did not complete (outcome=${outcome.kind}, detail=${detail}); notes: ${reporter.recorded.notes.join(" | ").slice(0, 2000)}`,
				);
			}

			// The bundle satisfies the same contract the Worker enforces.
			expect(researchBundleSchema.safeParse(outcome.bundle).success).toBe(true);

			// The fixed news tool ran; nothing was refused outside the model (AGT-006).
			expect(reporter.recorded.tools.map((entry) => entry.toolId)).toContain("news.fetch_feed");
			expect(reporter.recorded.tools.filter((entry) => entry.outcome === "denied")).toEqual([]);

			// Evidence and claims are structural: wording varies, the protocol does not.
			expect(outcome.bundle.evidence.some((item) => item.title === HEADLINE)).toBe(true);
			expect(outcome.bundle.claims.length).toBeGreaterThan(0);
			const evidenceIds = new Set(outcome.bundle.evidence.map((item) => item.evidenceId));
			for (const claim of outcome.bundle.claims) {
				if (claim.status !== "supported") continue;
				const supports = claim.links.filter((link) => link.relation === "supports");
				expect(supports.length).toBeGreaterThan(0);
				for (const link of supports) expect(evidenceIds.has(link.evidenceId)).toBe(true);
			}

			expect(outcome.bundle.answerText.trim()).not.toBe("");
			const claimIds = new Set(outcome.bundle.claims.map((claim) => claim.claimId));
			expect(outcome.bundle.answerClaimIds.length).toBeGreaterThan(0);
			for (const claimId of outcome.bundle.answerClaimIds) {
				expect(claimIds.has(claimId)).toBe(true);
			}

			// Provenance: this model, through this backend, on the current prompts (AGT-010).
			expect(outcome.bundle.provenance.agentId).toBe("opencode");
			expect(outcome.bundle.provenance.providerModel).toBe(model);
			expect(outcome.bundle.provenance.promptVersion).toBe(PROMPT_VERSION);

			// Plan-limited cost is unknown, never presented as zero (AGT-008).
			expect(outcome.usage.agentSteps).toBeGreaterThanOrEqual(2);
			expect(outcome.usage.knownCostUsd).toBe(0);
			expect(outcome.usage.hasUnmeteredUsage).toBe(true);
			expect(summarizeCost(outcome.usage)).toMatchObject({
				status: "unknown-plan-limited",
				totalCostUsd: null,
			});

			// States were reported in lifecycle order (ARCH-015).
			const orderOf = (state: JobState): number => LIFECYCLE.indexOf(state);
			expect(reporter.recorded.states.length).toBeGreaterThan(0);
			for (const state of reporter.recorded.states) expect(orderOf(state)).toBeGreaterThan(-1);
			const first = reporter.recorded.states.at(0);
			const last = reporter.recorded.states.at(-1);
			expect(first).toBe("planning");
			expect(last).toBe("publishing");
			expect(reporter.recorded.states).toEqual(
				[...reporter.recorded.states].sort((a, b) => orderOf(a) - orderOf(b)),
			);
		},
		PIPELINE_TIMEOUT_MS,
	);
});
