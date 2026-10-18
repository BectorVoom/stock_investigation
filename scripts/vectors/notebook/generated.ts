/** Seeded corpus supplements every input exercised by the existing notebook suites. */
import type { AgentEvent, NotebookWidget } from "@research/contracts";
import { notebookSchema } from "@research/contracts";
import { runNotebookAssistTurn } from "../../../packages/application/src/notebook/assistTurn.ts";
import {
	assistInput,
	chartWidget,
	fixedClock,
	recordingReporter,
	tableWidget,
	textWidget,
} from "../../../packages/application/test/support.ts";
import { seededRandom } from "../shared.ts";
import { recordTurn } from "./record.ts";

export async function generatedTurns(): Promise<void> {
	const random = seededRandom(0xb50019);
	const good = JSON.stringify({ reply: "Done.", commands: [] });
	const commands: unknown[] = [
		null,
		1,
		[],
		{},
		{ kind: "bogus" },
		{ kind: "remove", widgetId: "" },
		{ kind: "remove", widgetId: "w-text", extra: true },
		{ kind: "update", widgetId: "w-text" },
		{ kind: "update", widgetId: "w-text", config: { text: "\uFEFF Done \u0085" } },
		{ kind: "resize", widgetId: "w-text", size: "wrong" },
		{ kind: "move", widgetId: "w-text", direction: "earlier" },
		{ kind: "reorder", widgetId: "w-text", toIndex: 999 },
		{ kind: "add", type: "research", title: "R", config: { componentId: "missing" } },
		{ kind: "add", type: "text", title: "N", config: { text: "new", extra: 1 } },
		{ kind: "duplicate", widgetId: "w-text", title: "\uFEFFcopy\uFEFF" },
		{
			kind: "add",
			type: "metric",
			title: "M",
			config: { value: -0, unit: "USD", change: null, asOf: null },
		},
	];
	const replies = [
		"",
		"{broken}",
		"{",
		"{}",
		'{"reply":3,"commands":false,"extra":true}',
		'{"reply":"ok","commands":[],"extra":1}',
		'{"reply":"","commands":[]}',
		JSON.stringify({ reply: "\uFEFFok\u0085\uFEFF", commands: [] }),
		JSON.stringify({ reply: "😀".repeat(1001), commands: [] }),
		JSON.stringify({
			reply: "x",
			commands: Array.from({ length: 13 }, () => ({ kind: "remove", widgetId: "w-text" })),
		}),
		...commands.map((command) => JSON.stringify({ reply: "Changed.", commands: [command] })),
	];
	for (const reply of replies) await run([reply, good]);
	for (const events of [
		[],
		[{ type: "text.delta", text: good }],
		[{ type: "failed", code: "x".repeat(61), retryable: false }],
		[{ type: "usage", knownCostUsd: Number.NaN }, { type: "completed" }],
		[{ type: "usage", knownCostUsd: Number.POSITIVE_INFINITY }, { type: "completed" }],
		[
			{ type: "usage", knownCostUsd: 0.25 },
			{ type: "usage", knownCostUsd: null },
			{ type: "text.delta", text: good },
			{ type: "completed" },
		],
		[
			{ type: "tool.request", toolId: "ignored", args: {}, callId: "call1" },
			{ type: "ui.command", command: {} },
			{ type: "tool.result", callId: "call1", resultRef: "ref" },
			{ type: "text.delta", text: good },
			{ type: "completed" },
			{ type: "failed", code: "late", retryable: true },
		],
		[{ type: "text.delta", text: "😀".repeat(200001) }],
	] satisfies AgentEvent[][])
		await run([events]);

	for (let index = 0; index < 24; index += 1) {
		const count = [0, 1, 12, 32, 100, 200][index % 6] ?? 0;
		const widgets: NotebookWidget[] = Array.from({ length: count }, (_, position) => {
			const id = `w-${position}`;
			const kind = Math.floor(random() * 3);
			if (kind === 0)
				return textWidget(
					id,
					'日本語 😀 "\\\n\uFEFF\u0085fence-1 '.repeat(
						1 + Math.floor(random() * (count <= 12 ? 280 : 8)),
					),
				);
			if (kind === 1)
				return {
					...chartWidget(id),
					series: Array.from({ length: position < 2 && count <= 12 ? 6 : 1 }, (_, series) => ({
						name: `S${series}`,
						points: Array.from({ length: position < 2 && count <= 12 ? 400 : 4 }, (_, point) => ({
							x: `p${point}`,
							y: (point - 100) / 8,
						})),
					})),
				};
			return {
				...tableWidget(id),
				columns: ["A", "B"],
				rows: Array.from({ length: count <= 1 ? 200 : 8 }, (_, row) => [
					`r-${row}`,
					"字".repeat(180),
				]),
			};
		});
		const notebook = notebookSchema.parse({ widgets });
		const ids = index % 2 === 0 ? [] : widgets.slice(0, 12).map((w) => w.widgetId);
		await run([good], {
			notebook,
			selectedWidgetIds: ids,
			conversationContext: Array.from({ length: 6 }, (_, n) => ({
				role: n % 2 === 0 ? "owner" : "assistant",
				text: "😀".repeat(90),
			})),
		});
	}
	// Exact UTF-8 capacity boundary and an already oversized notebook shrinking.
	for (const length of [7990, 8000]) {
		const notebook = notebookSchema.parse({
			widgets: Array.from({ length: 106 }, (_, i) => textWidget(`w-${i}`, "x".repeat(length))),
		});
		await run(
			[
				JSON.stringify({ reply: "Grew.", commands: [{ kind: "duplicate", widgetId: "w-0" }] }),
				good,
			],
			{ notebook },
		);
	}
}

async function run(
	replies: readonly (string | readonly AgentEvent[])[],
	overrides: Parameters<typeof assistInput>[0] = {},
): Promise<void> {
	let index = 0;
	let fence = 0;
	await recordTurn(
		assistInput(overrides),
		{
			clock: fixedClock().clock,
			reporter: recordingReporter(),
			newFenceToken: () => `fence-${++fence}`,
			scratchDirectory: "/scratch/run_notebook",
			agent: {
				agentId: "scripted",
				displayName: "Vector agent",
				costModel: "plan-limited",
				toolIsolation: "enforced",
				probe: async () => ({
					capabilities: { supported: ["stream"] },
					availability: { status: "available" },
				}),
				async *run() {
					const reply = replies[index++];
					if (reply === undefined) throw new Error("missing scripted reply");
					if (typeof reply === "string") {
						yield { type: "text.delta", text: reply };
						yield { type: "completed" };
					} else yield* reply;
				},
			},
		},
		runNotebookAssistTurn,
	);
}
