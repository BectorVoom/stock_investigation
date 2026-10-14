import type { AgentEvent } from "@research/contracts";
import { describe, expect, it } from "vitest";
import { createScriptedAgent } from "../../../examples/extensions/scriptedAgent.ts";
import { notebookAssistPrompt } from "../src/index.ts";
import { chartWidget, notebookFixture, textWidget } from "./support.ts";

function promptFor(instruction: string, selected: readonly string[]): string {
	return notebookAssistPrompt({
		notebook: notebookFixture([textWidget("w-text", "Body of w-text."), chartWidget("w-chart")]),
		selectedWidgetIds: selected,
		instruction,
		conversationContext: [],
		fenceToken: "fence-test",
		repairNote: null,
	});
}

async function notebookReply(prompt: string): Promise<{ reply: unknown; commands: unknown }> {
	const agent = createScriptedAgent({
		reply: () => {
			throw new Error("the research reply must not answer a notebook prompt");
		},
	});
	const events: AgentEvent[] = [];
	for await (const event of agent.run(
		{
			runId: "run_test",
			conversationId: "ws_test",
			prompt,
			permittedToolIds: [],
			maxToolCalls: 0,
			deadline: "2026-10-11T01:00:00.000Z",
		},
		{
			signal: new AbortController().signal,
			scratchDirectory: null,
			model: null,
			effort: "medium",
		},
	)) {
		events.push(event);
	}
	const text = events.map((event) => (event.type === "text.delta" ? event.text : "")).join("");
	expect(events.at(-1)).toEqual({ type: "completed" });
	const parsed: unknown = JSON.parse(text);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("notebook reply is not an object");
	}
	const { reply, commands } = parsed as { reply: unknown; commands: unknown };
	return { reply, commands };
}

describe("scripted agent: notebook-assistant contract", () => {
	it("gold adds a gold price line chart before the chart rule", async () => {
		const { reply, commands } = await notebookReply(
			promptFor("Create a chart of gold prices over the past year.", []),
		);
		expect(reply).toBe("Added a gold price chart.");
		expect(commands).toEqual([
			{
				kind: "add",
				type: "line-chart",
				title: "Gold price, past year",
				size: "medium",
				config: { seriesIds: ["twelve-data:XAU/USD"], range: "1y" },
			},
		]);
	});

	it("chart adds a revenue line chart", async () => {
		const { reply, commands } = await notebookReply(promptFor("Please add a chart.", []));
		expect(reply).toBe("Added a revenue chart.");
		expect(commands).toEqual([
			{
				kind: "add",
				type: "chart",
				title: "Revenue",
				config: {
					chartType: "line",
					unit: "USD",
					series: [
						{
							name: "Revenue",
							points: [
								{ x: "2022", y: 10 },
								{ x: "2023", y: 12 },
								{ x: "2024", y: 15 },
							],
						},
					],
				},
			},
		]);
	});

	it("larger resizes every selected widget to large", async () => {
		const { reply, commands } = await notebookReply(
			promptFor("Make it larger, please.", ["w-text", "w-chart"]),
		);
		expect(reply).toBe("Made it larger.");
		expect(commands).toEqual([
			{ kind: "resize", widgetId: "w-text", size: "large" },
			{ kind: "resize", widgetId: "w-chart", size: "large" },
		]);
	});

	it("explain adds a text widget after the first selected widget", async () => {
		const { reply, commands } = await notebookReply(promptFor("Explain this.", ["w-chart"]));
		expect(reply).toBe("Added an explanation.");
		// w-chart is at position 1, so the explanation lands at index 2.
		expect(commands).toEqual([
			{
				kind: "add",
				type: "text",
				title: "Explanation",
				config: { text: "Revenue rises from 10 to 15 over three years." },
				toIndex: 2,
			},
		]);
	});

	it("explain omits toIndex when nothing is selected", async () => {
		const { reply, commands } = await notebookReply(promptFor("Explain.", []));
		expect(reply).toBe("Added an explanation.");
		expect(commands).toEqual([
			{
				kind: "add",
				type: "text",
				title: "Explanation",
				config: { text: "Revenue rises from 10 to 15 over three years." },
			},
		]);
	});

	it("bar updates every selected widget to a bar chart", async () => {
		const { reply, commands } = await notebookReply(promptFor("Switch to bar.", ["w-chart"]));
		expect(reply).toBe("Switched to a bar chart.");
		expect(commands).toEqual([
			{ kind: "update", widgetId: "w-chart", config: { chartType: "bar" } },
		]);
	});

	it("duplicate duplicates every selected widget", async () => {
		const { reply, commands } = await notebookReply(promptFor("Duplicate it.", ["w-text"]));
		expect(reply).toBe("Duplicated it.");
		expect(commands).toEqual([{ kind: "duplicate", widgetId: "w-text" }]);
	});

	it("remove proposes every selected widget", async () => {
		const { reply, commands } = await notebookReply(promptFor("Remove this.", ["w-text"]));
		expect(reply).toBe("Proposed removing it.");
		expect(commands).toEqual([{ kind: "remove", widgetId: "w-text" }]);
	});

	it("answers anything else with no commands", async () => {
		const { reply, commands } = await notebookReply(promptFor("Tidy up.", ["w-text"]));
		expect(reply).toBe("Noted.");
		expect(commands).toEqual([]);
	});

	it("takes the first matching rule in table order", async () => {
		const { reply } = await notebookReply(promptFor("Add a larger bar chart.", []));
		expect(reply).toBe("Added a revenue chart.");
	});

	it("still answers research prompts through the configured reply", async () => {
		const agent = createScriptedAgent({ reply: () => '{"toolCalls":[],"done":true}' });
		const events: AgentEvent[] = [];
		for await (const event of agent.run(
			{
				runId: "run_test",
				conversationId: "ws_test",
				prompt: "You are the planning step of an evidence-first research pipeline.",
				permittedToolIds: [],
				maxToolCalls: 0,
				deadline: "2026-10-11T01:00:00.000Z",
			},
			{
				signal: new AbortController().signal,
				scratchDirectory: null,
				model: null,
				effort: "medium",
			},
		)) {
			events.push(event);
		}
		const text = events.map((event) => (event.type === "text.delta" ? event.text : "")).join("");
		expect(text).toBe('{"toolCalls":[],"done":true}');
	});
});
