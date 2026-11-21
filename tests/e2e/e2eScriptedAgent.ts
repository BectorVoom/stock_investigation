/**
 * The E2E scripted agent: prompt-driven replies (a plan with one feed fetch
 * and an injected `shell.exec`, verifier verdicts, an analysis with a hostile
 * claim and forbidden UI operations) on top of the FR-013 example backend in
 * `examples/extensions/scriptedAgent.ts` (which also answers notebook-assist
 * prompts). Used in process by the Node runner harness and, through the
 * external-process wrapper (`e2eExternalAgent.ts`), by the Rust E2E runner, so
 * both runners are answered by this one piece of logic.
 */

import { createScriptedAgent } from "../../examples/extensions/scriptedAgent.ts";
import { HEADLINE, HOSTILE_MARKUP } from "./fixtures.ts";

/** The direct answer to a diagram question (ADR-0079): plain text and a three-stage flow. */
export const DIRECT_ANSWER_TEXT =
	"後工程では、ウェハーを薄く削り（バックグラインド）、チップに切り分け（ダイシング）、樹脂で封止します（モールディング）。";
const DIRECT_ANSWER = JSON.stringify({
	answer: DIRECT_ANSWER_TEXT,
	diagram: {
		title: "半導体後工程の流れ",
		steps: [
			{ label: "バックグラインド", detail: "ウェハーの裏面を研削して薄くする。" },
			{ label: "ダイシング", detail: "ウェハーを個々のチップに切り分ける。" },
			{ label: "モールディング", detail: "チップを樹脂で封止して保護する。" },
		],
	},
});

/** Replies as a model would: a plan, then an analysis citing what the tool retrieved, then verdicts. */
export function createE2eScriptedAgent(): ReturnType<typeof createScriptedAgent> {
	return createScriptedAgent({
		agentId: "scripted",
		models: ["scripted/alpha", "scripted/beta", "other/gamma"],
		reply(request) {
			const { prompt, runId } = request;
			// ADR-0079: a question asking for a diagram (図) needs no research. Only
			// the first round offers the choice; the answer step then explains it.
			if (
				prompt.includes("planning step") &&
				prompt.includes('Return: {"needsResearch":') &&
				/^Research question: [^\n]*図/m.test(prompt)
			) {
				return JSON.stringify({ needsResearch: false, toolCalls: [], done: true });
			}
			if (prompt.startsWith("You are the answer step")) return DIRECT_ANSWER;
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
}
