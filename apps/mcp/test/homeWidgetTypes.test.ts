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
		expect(HOME_WIDGET_AGENT_TYPES.map((entry) => entry.type).sort()).toEqual([
			"earnings-calendar",
			"indicator-table",
			"line-chart",
			"metric",
			"stock-table",
		]);
		for (const entry of HOME_WIDGET_AGENT_TYPES) {
			expect(entry.label.trim().length).toBeGreaterThan(0);
			expect([...entry.sizes].sort()).toEqual(["large", "medium", "small"]);
		}
		for (const type of ["metric", "line-chart", "stock-table", "indicator-table"] as const) {
			const description = byType(type).description;
			expect(description).toContain("fred:VIXCLS");
			expect(description).toContain("twelve-data:AAPL");
		}
		const calendar = byType("earnings-calendar").description;
		expect(calendar).toContain("daysAhead");
		expect(calendar).not.toContain("fred:");
		expect(byType("metric").defaultSize).toBe("small");
		expect(byType("earnings-calendar").description).not.toContain("fred:");
	});

	it("generates config schemas with no generic fields", () => {
		for (const entry of HOME_WIDGET_AGENT_TYPES) {
			expect(entry.configSchema.type).toBe("object");
			const keys = Object.keys(propertiesOf(entry.configSchema));
			expect(keys.filter((key) => GENERIC_FIELDS.includes(key))).toEqual([]);
			expect(keys.length).toBeGreaterThan(0);
		}
		expect(Object.keys(propertiesOf(byType("metric").configSchema)).sort()).toEqual(["seriesId"]);
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
			{ type: "metric", config: { seriesId: "fred:VIXCLS" } },
			{ type: "line-chart", config: { seriesIds: ["fred:VIXCLS"], range: "1y" } },
			{ type: "stock-table", config: { seriesIds: ["twelve-data:AAPL", "twelve-data:MSFT"] } },
			{ type: "indicator-table", config: { seriesIds: ["fred:CPIAUCSL"] } },
			{ type: "earnings-calendar", config: { daysAhead: 90 } },
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
			{ type: "metric", config: {}, field: "seriesId" },
			{ type: "metric", config: { seriesId: "nope" }, field: "seriesId" },
			{ type: "metric", config: { seriesId: "fred:VIXCLS", nope: 1 }, field: "nope" },
			{ type: "line-chart", config: { seriesIds: [], range: "1y" }, field: "seriesIds" },
			{ type: "line-chart", config: { seriesIds: ["fred:VIXCLS"], range: "9y" }, field: "range" },
			{ type: "earnings-calendar", config: { daysAhead: 45 }, field: "daysAhead" },
		];
		for (const { type, config, field } of cases) {
			const built = byType(type).build({ widgetId: "w-1", title: "T", size: "small", config });
			if (built.ok) throw new Error(`${type} accepted ${JSON.stringify(config)}`);
			expect(built.error).toContain(`"${field}"`);
			expect(built.error.endsWith(".")).toBe(true);
		}
	});

	it("leaves the no-repeat rule to the layout check, like the contract does", () => {
		const built = byType("stock-table").build({
			widgetId: "w-1",
			title: "T",
			size: "small",
			config: { seriesIds: ["fred:VIXCLS", "fred:VIXCLS"] },
		});
		if (!built.ok) throw new Error(`a repeated series failed build: ${built.error}`);
	});

	it("round-trips configOf after build", () => {
		const cases: { readonly type: HomeWidget["type"]; readonly config: JsonObject }[] = [
			{ type: "metric", config: { seriesId: "twelve-data:XAU/USD" } },
			{ type: "line-chart", config: { seriesIds: ["fred:VIXCLS", "fred:SP500"], range: "3m" } },
			{ type: "stock-table", config: { seriesIds: ["twelve-data:NVDA"] } },
			{ type: "indicator-table", config: { seriesIds: ["fred:UNRATE", "fred:CPIAUCSL"] } },
			{ type: "earnings-calendar", config: { daysAhead: 30 } },
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
