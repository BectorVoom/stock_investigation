import type { HomeWidget } from "@research/contracts";
import { HOME_WIDGET_TYPES } from "@research/contracts";
import { isJsonObject, type JsonObject } from "@research/widget-grid/agent";
import { describe, expect, it } from "vitest";
import { HOME_WIDGET_AGENT_TYPES } from "../src/homeWidgetTypes.ts";

const GENERIC_FIELDS = ["type", "widgetId", "title", "size"];

function byType(type: HomeWidget["type"]) {
	const found = HOME_WIDGET_AGENT_TYPES.find((entry) => entry.type === type);
	if (found === undefined) throw new Error(`no agent type for "${type}"`);
	return found;
}

function propertiesOf(configSchema: JsonObject): Record<string, unknown> {
	const properties: unknown = configSchema.properties;
	if (!isJsonObject(properties)) throw new Error("the config schema has no properties");
	const record: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(properties)) record[key] = value;
	return record;
}

describe("HOME_WIDGET_AGENT_TYPES", () => {
	it("covers every Home widget type with the shared label, description, default size and all sizes", () => {
		// ADR-0024: every type of the one specification but the research result.
		expect(HOME_WIDGET_AGENT_TYPES.map((entry) => entry.type).sort()).toEqual([
			"chart",
			"earnings-calendar",
			"indicator-table",
			"line-chart",
			"market-metric",
			"metric",
			"scheduled-tasks",
			"stock-table",
			"table",
			"task-result",
			"text",
			"watchlist-prices",
		]);
		for (const entry of HOME_WIDGET_AGENT_TYPES) {
			expect(entry.label.trim().length).toBeGreaterThan(0);
			expect([...entry.sizes].sort()).toEqual(["large", "medium", "small"]);
		}
		for (const type of ["market-metric", "line-chart", "stock-table", "indicator-table"] as const) {
			const description = byType(type).description;
			expect(description).toContain("fred:VIXCLS");
			expect(description).toContain("twelve-data:AAPL");
		}
		const calendar = byType("earnings-calendar").description;
		expect(calendar).toContain("daysAhead");
		expect(calendar).not.toContain("fred:");
		expect(byType("market-metric").defaultSize).toBe("small");
		expect(byType("earnings-calendar").description).not.toContain("fred:");
		// The static types tell the agent to use the live types for market data.
		expect(byType("metric").description).toContain("market-metric");
		expect(byType("chart").description).toContain("line-chart");
		// ADR-0033: agents may place the tasks widget, never create or run tasks through it.
		const tasks = byType("scheduled-tasks");
		expect(tasks.label).toBe("Scheduled tasks");
		expect(tasks.defaultSize).toBe("medium");
		expect(tasks.description).toContain("No fields");
		expect(tasks.description).toContain("cannot create, edit or run tasks");
		expect(tasks.description).not.toContain("fred:");
		// ADR-0038 §6: listed so agents see and arrange it, but only the owner places one.
		const result = byType("task-result");
		expect(result.ownerPlaced?.reason).toContain("cannot add one or change its taskId");
		expect(result.description).toContain("cannot add one");
		// ADR-0040 §8: the same rule for a Watchlist prices widget (agents cannot look lists up).
		const prices = byType("watchlist-prices");
		expect(prices.label).toBe("Watchlist prices");
		expect(prices.defaultSize).toBe("medium");
		expect(prices.ownerPlaced?.reason).toContain("cannot add one or change its listId");
		expect(prices.description).not.toContain("fred:");
		expect(
			HOME_WIDGET_AGENT_TYPES.filter((entry) => entry.ownerPlaced !== undefined)
				.map((entry) => entry.type)
				.sort(),
		).toEqual([result.type, prices.type]);
	});

	it("generates config schemas with no generic fields", () => {
		for (const entry of HOME_WIDGET_AGENT_TYPES) {
			expect(entry.configSchema.type).toBe("object");
			const keys = Object.keys(propertiesOf(entry.configSchema));
			expect(keys.filter((key) => GENERIC_FIELDS.includes(key))).toEqual([]);
			// Only the scheduled-tasks widget has no content fields (ADR-0033).
			if (entry.type !== "scheduled-tasks") expect(keys.length).toBeGreaterThan(0);
		}
		const tasksSchema = byType("scheduled-tasks").configSchema;
		expect(propertiesOf(tasksSchema)).toEqual({});
		expect(tasksSchema.additionalProperties).toBe(false);
		expect(Object.keys(propertiesOf(byType("market-metric").configSchema)).sort()).toEqual([
			"seriesId",
		]);
		expect(Object.keys(propertiesOf(byType("text").configSchema)).sort()).toEqual(["text"]);
		expect(Object.keys(propertiesOf(byType("line-chart").configSchema)).sort()).toEqual([
			"range",
			"seriesIds",
		]);
		expect(Object.keys(propertiesOf(byType("earnings-calendar").configSchema)).sort()).toEqual([
			"daysAhead",
		]);
	});

	it("builds each type from a valid config", () => {
		const cases: { readonly type: HomeWidget["type"]; readonly config: JsonObject }[] = [
			{ type: "market-metric", config: { seriesId: "fred:VIXCLS" } },
			{ type: "line-chart", config: { seriesIds: ["fred:VIXCLS"], range: "1y" } },
			{ type: "stock-table", config: { seriesIds: ["twelve-data:AAPL", "twelve-data:MSFT"] } },
			{ type: "indicator-table", config: { seriesIds: ["fred:CPIAUCSL"] } },
			{ type: "earnings-calendar", config: { daysAhead: 90 } },
			{ type: "scheduled-tasks", config: {} },
			{ type: "text", config: { text: "## Note\n\n**Bold** idea." } },
			{
				type: "metric",
				config: { value: 3.2, unit: "%", change: null, caption: "Margin", asOf: null },
			},
			{
				type: "chart",
				config: {
					chartType: "bar",
					unit: "",
					series: [{ name: "A", points: [{ x: "Q1", y: 1 }] }],
				},
			},
			{ type: "table", config: { columns: ["Name", "Value"], rows: [["A", 1]] } },
		];
		for (const { type, config } of cases) {
			const built = byType(type).build({ widgetId: "w-1", title: "T", size: "small", config });
			if (!built.ok) throw new Error(`${type}: ${built.error}`);
			expect(built.value.type).toBe(type);
			expect(built.value.widgetId).toBe("w-1");
		}
	});

	it("rejects an invalid config with one sentence naming the field", () => {
		const cases: {
			readonly type: HomeWidget["type"];
			readonly config: JsonObject;
			readonly field: string;
		}[] = [
			{ type: "market-metric", config: {}, field: "seriesId" },
			{ type: "market-metric", config: { seriesId: "nope" }, field: "seriesId" },
			{ type: "market-metric", config: { seriesId: "fred:VIXCLS", nope: 1 }, field: "nope" },
			{ type: "line-chart", config: { seriesIds: [], range: "1y" }, field: "seriesIds" },
			{ type: "line-chart", config: { seriesIds: ["fred:VIXCLS"], range: "9y" }, field: "range" },
			{ type: "earnings-calendar", config: { daysAhead: 45 }, field: "daysAhead" },
			// A task's question cannot ride in on the widget: the type has no fields.
			{ type: "scheduled-tasks", config: { question: "Run this daily" }, field: "question" },
		];
		for (const { type, config, field } of cases) {
			const built = byType(type).build({ widgetId: "w-1", title: "T", size: "small", config });
			if (built.ok) throw new Error(`${type} accepted ${JSON.stringify(config)}`);
			expect(built.error).toContain(`"${field}"`);
			expect(built.error.endsWith(".")).toBe(true);
		}
	});

	it("refuses a widget that repeats a series, naming the field (the one widget rule)", () => {
		const built = byType("stock-table").build({
			widgetId: "w-1",
			title: "T",
			size: "small",
			config: { seriesIds: ["fred:VIXCLS", "fred:VIXCLS"] },
		});
		if (built.ok) throw new Error("a repeated series was accepted");
		expect(built.error).toContain('"seriesIds"');
	});

	it("refuses a table whose rows do not match its columns", () => {
		const built = byType("table").build({
			widgetId: "w-1",
			title: "T",
			size: "small",
			config: { columns: ["A", "B"], rows: [["only one"]] },
		});
		if (built.ok) throw new Error("a short row was accepted");
		expect(built.error).toContain('"rows"');
	});

	it("round-trips configOf after build", () => {
		const cases: { readonly type: HomeWidget["type"]; readonly config: JsonObject }[] = [
			{ type: "market-metric", config: { seriesId: "twelve-data:XAU/USD" } },
			{ type: "line-chart", config: { seriesIds: ["fred:VIXCLS", "fred:SP500"], range: "3m" } },
			{ type: "stock-table", config: { seriesIds: ["twelve-data:NVDA"] } },
			{ type: "indicator-table", config: { seriesIds: ["fred:UNRATE", "fred:CPIAUCSL"] } },
			{ type: "earnings-calendar", config: { daysAhead: 30 } },
			{ type: "scheduled-tasks", config: {} },
			// Built when an agent renames an owner-placed one (ADR-0038 §6).
			{ type: "task-result", config: { taskId: "task_abc" } },
			{ type: "watchlist-prices", config: { listId: "list_abc" } },
		];
		for (const { type, config } of cases) {
			const agentType = byType(type);
			const built = agentType.build({
				widgetId: "w-9",
				title: "Round trip",
				size: "medium",
				config,
			});
			if (!built.ok) throw new Error(`${type}: ${built.error}`);
			expect(agentType.configOf(built.value)).toEqual(config);
		}
	});

	it("has an agent type for every HOME_WIDGET_TYPES entry", () => {
		expect(HOME_WIDGET_AGENT_TYPES).toHaveLength(HOME_WIDGET_TYPES.length);
		for (const type of HOME_WIDGET_TYPES) {
			expect(HOME_WIDGET_AGENT_TYPES.some((entry) => entry.type === type)).toBe(true);
		}
	});
});
