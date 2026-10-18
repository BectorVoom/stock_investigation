/**
 * Targeted cases for what the seeded corpus does not reach: all ten widget types,
 * chart provenance and evidence copies, a history longer than the context budget,
 * and the repair prompt in each of its three selection modes.
 */
import type { Evidence, Notebook, NotebookWidget } from "@research/contracts";
import { notebookSchema } from "@research/contracts";
import { applyNotebookCommands } from "../../../packages/application/src/notebook/notebookAgent.ts";
import { notebookResearchComponentIds } from "../../../packages/application/src/notebook/prompts.ts";
import { textWidget } from "../../../packages/application/test/support.ts";
import { run } from "./generated.ts";
import { save } from "./record.ts";

const META = {
	createdAt: "2026-10-14T00:00:00.000Z",
	updatedAt: "2026-10-15T00:00:00.000Z",
	revision: 2,
	origin: { kind: "chat", messageId: "msg_1", runId: "run_1", componentId: "comp_1" },
} as const;

const EVIDENCE: Evidence = {
	evidenceId: "ev_1",
	sourceUrl: "https://news.example.org/articles/ev_1",
	title: "Storage orders \u{1F600}",
	publisher: "Example News",
	publishedAt: "2026-10-01T00:00:00.000Z",
	retrievedAt: "2026-10-11T00:00:00.000Z",
	effectiveAt: null,
	excerpt: "Orders reached 100 GWh.",
	checksum: "a".repeat(64),
	sourceClass: "news",
};

function provenanceChart(id: string): NotebookWidget {
	return {
		widgetId: id,
		title: "Sourced chart",
		size: "large",
		...META,
		type: "chart",
		chartType: "bar",
		unit: "GWh",
		xLabel: "Year",
		yLabel: "Orders",
		xKind: "number",
		series: [
			{
				name: "Orders",
				points: [
					{ x: "2025", y: 70, basis: "assumption" },
					{ x: "2026", y: 100, sourceId: "ev_1", asOf: "2026-10-01" },
					{ x: "2026", y: 101, basis: "derived" },
					{ x: "2027", y: 120 },
				],
			},
		],
		sourceIds: ["ev_1"],
		sources: [EVIDENCE],
	};
}

function allTypes(): NotebookWidget[] {
	return [
		textWidget("t1", "# Heading\n\nBody **bold** \u{1F600}"),
		{
			widgetId: "m1",
			title: "Metric",
			size: "small",
			...META,
			type: "metric",
			value: -0,
			unit: "%",
			change: 0.5,
			caption: "Margin",
			asOf: "2026-10-14",
		},
		provenanceChart("c1"),
		{
			widgetId: "tb1",
			title: "Table",
			size: "medium",
			...META,
			type: "table",
			columns: ["A", "B"],
			rows: [
				["x", 1],
				["y", null],
				["z", 2.5],
			],
		},
		{
			widgetId: "r1",
			title: "Research",
			size: "large",
			...META,
			type: "research",
			componentId: "comp_1",
		},
		{
			widgetId: "mm1",
			title: "Market metric",
			size: "small",
			...META,
			type: "market-metric",
			seriesId: "fred:VIXCLS",
		},
		{
			widgetId: "lc1",
			title: "Line chart",
			size: "medium",
			...META,
			type: "line-chart",
			seriesIds: ["fred:VIXCLS", "twelve-data:AAPL"],
			range: "1y",
		},
		{
			widgetId: "st1",
			title: "Stock table",
			size: "medium",
			...META,
			type: "stock-table",
			seriesIds: ["twelve-data:AAPL"],
		},
		{
			widgetId: "it1",
			title: "Indicator table",
			size: "large",
			...META,
			type: "indicator-table",
			seriesIds: ["fred:VIXCLS"],
		},
		{
			widgetId: "ec1",
			title: "Earnings",
			size: "large",
			...META,
			type: "earnings-calendar",
			daysAhead: 90,
		},
	];
}

/** Records one command batch against the real engine, including earned chart provenance. */
async function recordCommands(notebook: Notebook, commands: readonly unknown[]): Promise<void> {
	const known = [...notebookResearchComponentIds(notebook)];
	const ids: string[] = [];
	const output = await applyNotebookCommands(notebook, commands, {
		knownComponentIds: new Set(known),
		newWidgetId: () => {
			const id = `assist-preview-${ids.length + 1}`;
			ids.push(id);
			return id;
		},
	});
	save({
		area: "commands",
		input: { notebook, commands, ids, known },
		output: output.ok
			? { ok: true, widgets: output.value.widgets }
			: { ok: false, error: output.error },
	});
}

const GOOD = JSON.stringify({ reply: "Done.", commands: [] });
const BAD = "not json at all";

export async function coverageTurns(): Promise<void> {
	const notebook = notebookSchema.parse({ widgets: allTypes() });
	const history = Array.from({ length: 60 }, (_, n) => ({
		role: n % 2 === 0 ? ("owner" as const) : ("assistant" as const),
		text: `Message ${n} \u{1F600} ${"word ".repeat(40)}`,
	}));
	const commands: unknown[] = [
		{ kind: "update", widgetId: "c1", title: "Renamed" },
		{ kind: "update", widgetId: "c1", config: { unit: "TWh" } },
		{
			kind: "update",
			widgetId: "c1",
			config: {
				series: [
					{ name: "Orders", points: [{ x: "2026", y: 100, sourceId: "ev_1", asOf: "2026-10-01" }] },
				],
			},
		},
		{ kind: "update", widgetId: "c1", config: { sources: [], sourceIds: [] } },
		{ kind: "update", widgetId: "mm1", config: { seriesId: "twelve-data:XAU/USD" } },
		{ kind: "update", widgetId: "lc1", config: { range: "6m" } },
		{ kind: "update", widgetId: "ec1", config: { daysAhead: 30 } },
		{ kind: "update", widgetId: "r1", config: { componentId: "comp_missing" } },
		{ kind: "update", widgetId: "m1", config: { value: null, asOf: null } },
		{ kind: "update", widgetId: "tb1", config: { rows: [["only"]] } },
		{ kind: "resize", widgetId: "r1", size: "small" },
		{ kind: "resize", widgetId: "r1", size: "medium" },
		{ kind: "duplicate", widgetId: "c1" },
		{ kind: "duplicate", widgetId: "r1", toIndex: 0 },
		{ kind: "add", type: "market-metric", title: "New", config: { seriesId: "fred:DGS10" } },
		{
			kind: "add",
			type: "line-chart",
			title: "New",
			size: "large",
			config: { seriesIds: ["fred:DGS10"], range: "max" },
		},
		{ kind: "add", type: "stock-table", title: "New", config: { seriesIds: [] } },
		{ kind: "add", type: "indicator-table", title: "New", config: { seriesIds: ["bogus"] } },
		{ kind: "add", type: "earnings-calendar", title: "New", config: { daysAhead: 45 } },
		{ kind: "add", type: "research", title: "New", config: { componentId: "comp_1" } },
		{
			kind: "add",
			type: "chart",
			title: "New",
			config: {
				chartType: "line",
				unit: "",
				series: [{ name: "S", points: [{ x: "a", y: 1, sourceId: "ev_9" }] }],
			},
		},
		{
			kind: "add",
			type: "chart",
			title: "New",
			config: {
				chartType: "line",
				unit: "",
				series: [{ name: "S", points: [{ x: "a", y: 1, basis: "derived" }] }],
				sourceIds: ["ev_1"],
				sources: [EVIDENCE],
			},
		},
		{
			kind: "add",
			type: "metric",
			title: "New",
			size: "large",
			config: { value: 1, unit: "", change: null, caption: "", asOf: "2026-02-30" },
		},
		{ kind: "add", type: "table", title: "New", config: { columns: ["A"], rows: [["x", "y"]] } },
		{ kind: "remove", widgetId: "t1" },
		{ kind: "remove", widgetId: "r1" },
		{ kind: "remove", widgetId: "t1" },
	];
	// A rejected command is repaired by the good second reply.
	for (const command of commands) await recordCommands(notebook, [command]);
	await recordCommands(notebook, commands.slice(0, 4));
	await recordCommands(notebook, commands.slice(0, 13));
	for (const command of commands)
		await run([JSON.stringify({ reply: "Edited.", commands: [command] }), GOOD], { notebook });
	await run([JSON.stringify({ reply: "Edited.", commands: commands.slice(0, 4) }), GOOD], {
		notebook,
	});

	// Long history: only the newest messages fit the context budget.
	await run([GOOD], { notebook, conversationContext: history });
	await run([GOOD], { notebook, conversationContext: history.slice(0, 3) });

	// The repair prompt in all three selection modes.
	await run([BAD, GOOD], {
		notebook,
		selectedWidgetIds: ["c1", "tb1", "r1"],
		conversationContext: history,
	});
	await run([BAD, GOOD], { notebook });
	const big = notebookSchema.parse({
		widgets: [
			...allTypes(),
			...Array.from({ length: 11 }, (_, i) =>
				textWidget(`big-${i}`, `${"Long body \u{1F600} ".repeat(500)}`.slice(0, 7900)),
			),
		],
	});
	await run([BAD, GOOD], { notebook: big });
	await run([BAD, GOOD], { notebook: big, selectedWidgetIds: ["big-0", "c1"] });
}
