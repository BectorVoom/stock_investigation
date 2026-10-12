/**
 * E2E runner: the real runner loop, real research tools and real feed parser,
 * with two seams replaced — the agent is the scripted example backend and
 * outbound fetches come from fixtures. It registers a backend ("scripted")
 * that the core has never heard of, which is FR-013 exercised end to end.
 *
 * This is NOT a network test: `fixtureFetcher` serves synthetic feeds and
 * never contacts the network, so a fetcher that hangs under the wrong runtime
 * (Defect 0: the pinned HTTPS fetcher under Bun) passes here and fails only
 * in the real-environment check (`bun run test:real`, which refreshes a real
 * subscribed feed through the real runner).
 *
 * With RUN_LIVE_OPENCODE=1 the agent registry is the real baseline runtimes
 * (so OpenCode is available, with OPENCODE_MODEL from the environment) and
 * per-job scratch directories are real temporary directories, because the
 * OpenCode adapter writes its deny-all config there. Without the switch the
 * scripted agent is used and no live backend is ever started.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFeedParser } from "@research/adapters/feed";
import { createBaselineAgentRuntimes, createNodeProcessRunner } from "@research/adapters/providers";
import { systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createResearchTools } from "@research/adapters/tools";
import { createAgentRegistry, createToolRegistry } from "@research/agent-core";
import { CSRF_HEADER, CSRF_HEADER_VALUE, issuedRunnerCredentialSchema } from "@research/contracts";
import { createEventLogger } from "@research/effects";
import { createHttpRunnerApi, runRunnerLoop } from "../../apps/runner/src/index.ts";
import { createScriptedAgent } from "../../examples/extensions/scriptedAgent.ts";
import { E2E_ORIGIN, fixtureFetcher, HEADLINE, HOSTILE_MARKUP } from "./fixtures.ts";

/** Live backend for `tests/e2e/opencodeLive.spec.ts`; unset everywhere else. */
const LIVE = process.env.RUN_LIVE_OPENCODE === "1";

const logger = createEventLogger((line) => process.stderr.write(line));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function issueToken(): Promise<string> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			const response = await fetch(`${E2E_ORIGIN}/api/v1/runner-credentials`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Origin: E2E_ORIGIN,
					[CSRF_HEADER]: CSRF_HEADER_VALUE,
				},
				body: JSON.stringify({ label: `e2e runner ${Date.now()}`, expiresInDays: 1 }),
			});
			if (response.ok) return issuedRunnerCredentialSchema.parse(await response.json()).token;
		} catch {
			// The Worker is still starting; try again shortly.
		}
		await sleep(500);
	}
	throw new Error("E2E Worker did not become ready");
}

/** Replies as a model would: a plan, then an analysis citing what the tool retrieved, then verdicts. */
const agent = createScriptedAgent({
	agentId: "scripted",
	models: ["scripted/alpha", "scripted/beta", "other/gamma"],
	reply(request) {
		const { prompt, runId } = request;
		if (prompt.includes("planning step")) {
			if (prompt.includes(HEADLINE)) return JSON.stringify({ toolCalls: [], done: true });
			const sourceId = /sourceId (\S+):/.exec(prompt)?.[1] ?? "unknown";
			return JSON.stringify({
				toolCalls: [
					{ toolId: "news.fetch_feed", args: { sourceId } },
					// What an injected instruction would ask for; the policy must refuse it.
					{ toolId: "shell.exec", args: { command: "id" } },
				],
				done: false,
			});
		}
		if (prompt.includes("independent verification step")) {
			return JSON.stringify({ verdicts: [{ claimIndex: 0, verdict: "supported" }] });
		}
		const escaped = HEADLINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const evidenceId =
			new RegExp(`\\[(${runId}_ev\\d+)\\] ${escaped}`).exec(prompt)?.[1] ?? "missing";
		return JSON.stringify({
			// A narrative is no longer part of the protocol; if a model sends one it is ignored.
			answer: "Net profit margin is 999%.",
			claims: [
				{
					text: "Grid storage orders reached 100 GWh in 2026.",
					claimType: "observation",
					evidence: [{ evidenceId, relation: "supports", quote: HEADLINE }],
				},
				{
					text: `Orders will certainly triple next year. ${HOSTILE_MARKUP}`,
					claimType: "forecast",
					evidence: [{ evidenceId: `${runId}_ev999`, relation: "supports", quote: "made up" }],
				},
			],
			scenarios: [
				{
					productOrService: "Grid-scale battery storage",
					quantityKind: "unit-demand",
					unit: "GWh per year",
					baseYear: 2026,
					targetYear: 2030,
					baselineValue: 100,
					baselineEvidenceId: evidenceId,
					baselineQuote: HEADLINE,
					bear: { targetValue: 146.41, assumptions: ["Permitting delays persist"] },
					base: { targetValue: 207.36, assumptions: ["Order trend continues"] },
					bull: { targetValue: 285.61, assumptions: ["Subsidies are extended"] },
					drivers: ["Renewable build-out"],
					barriers: ["Interconnection queues"],
					falsifiers: ["Orders fall for two consecutive years"],
					methodology: "Order-book extrapolation from the cited baseline.",
					supportingEvidenceIds: [evidenceId],
					contraryEvidenceIds: [evidenceId],
				},
			],
			suppliers: [
				{
					issuerName: "Example Storage Corp",
					ticker: "EXMP",
					exchange: "NASDAQ",
					country: "US",
					productsOrServices: ["Battery systems"],
					businessExposure: "Supplies battery systems to utilities.",
					scenarioIndex: 0,
					evidence: [
						{ evidenceId, quote: "Example Storage Corp supplies battery systems to utilities" },
					],
				},
			],
			pricingPower: [],
			uiOperations: [
				{ operation: "script.inject", source: "<script>window.__xss=1</script>" },
				// A model may not author a report, however plausible its badges look.
				{
					operation: "component.create",
					componentId: "model_report",
					componentType: "research-report",
					schemaVersion: 1,
					props: {
						title: "Trust me",
						generatedAt: "2026-10-11T00:00:00.000Z",
						dataCutoffAt: "2026-10-11T00:00:00.000Z",
						sections: [
							{
								heading: "Findings",
								statements: [
									{
										text: "Orders will certainly triple next year.",
										claimId: `${runId}_cl2`,
										claimType: "observation",
										status: "supported",
										sourceIds: [],
									},
								],
							},
						],
						disclaimer: "x",
					},
				},
			],
		});
	},
});

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown.abort());

const feedParser = createFeedParser();
// Without the live switch the scripted example backend runs; with it the
// real baseline runtimes (OpenCode included) answer. The registry is chosen
// here — the harness is not forked.
const agents = LIVE
	? createAgentRegistry(
			createBaselineAgentRuntimes({
				processRunner: createNodeProcessRunner(),
				fetch,
				env: process.env,
			}),
		)
	: createAgentRegistry([agent]);
// The scripted agent never touches the filesystem, but the live OpenCode
// adapter must write its per-run config into a real scratch directory
// (AGT-004): created empty under the OS temp dir, removed when the job ends.
const scratchRoot = LIVE ? await mkdtemp(join(tmpdir(), "research-e2e-live-")) : null;
const exit = await runRunnerLoop(
	{
		api: createHttpRunnerApi({
			apiUrl: E2E_ORIGIN,
			runnerToken: await issueToken(),
			accessClientId: null,
			accessClientSecret: null,
			fetch,
			sleep,
		}),
		agents,
		tools: createToolRegistry(
			createResearchTools({
				fetcher: fixtureFetcher,
				feedParser,
				hasher: webCryptoHasher,
				clock: systemClock,
				secUserAgent: null,
				pageArchive: null,
				sleep: (ms, signal) =>
					new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, Math.min(ms, 500));
						signal.addEventListener("abort", () => {
							clearTimeout(timer);
							resolve();
						});
					}),
			}),
		),
		feed: { fetcher: fixtureFetcher, feedParser, hasher: webCryptoHasher },
		clock: systemClock,
		logger,
		scratch:
			scratchRoot === null
				? { create: async (runId) => `/nonexistent/e2e/${runId}`, remove: async () => {} }
				: {
						create: (runId) => mkdtemp(join(scratchRoot, `${runId}-`)),
						remove: (path) => rm(path, { recursive: true, force: true }).then(() => undefined),
					},
		every: (ms, task) => {
			const timer = setInterval(task, ms);
			return () => clearInterval(timer);
		},
		newFenceToken: () => crypto.randomUUID(),
		allowUnverifiedToolIsolation: false,
		// Poll quickly so the browser test does not wait on the production idle interval.
		sleep: (ms, signal) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, Math.min(ms, 500));
				signal.addEventListener("abort", () => {
					clearTimeout(timer);
					resolve();
				});
			}),
	},
	shutdown.signal,
);
process.exitCode = exit === "shutdown" ? 0 : 1;
