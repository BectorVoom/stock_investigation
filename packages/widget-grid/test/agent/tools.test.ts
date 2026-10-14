import { describe, expect, it } from "vitest";
import { isJsonObject } from "../../src/agent/commands.ts";
import { createWidgetAgentHost } from "../../src/agent/host.ts";
import { createWidgetAgentTools } from "../../src/agent/tools.ts";
import type { JsonObject, WidgetAgentTool } from "../../src/agent/types.ts";
import { bannerType, createToyStore, freshId, noteType, toy } from "./support.ts";

function toolsWith(options?: { readonly prefix?: string }): readonly WidgetAgentTool[] {
	const controls = createToyStore([toy("a")]);
	const host = createWidgetAgentHost({
		store: controls.store,
		types: [noteType, bannerType],
		newWidgetId: freshId,
	});
	return createWidgetAgentTools(host, options);
}

function propertiesOf(tool: WidgetAgentTool): string[] {
	const properties: unknown = tool.inputSchema.properties;
	if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
		return [];
	}
	return Object.keys(properties);
}

describe("createWidgetAgentTools", () => {
	it("names one tool per command kind plus describe", () => {
		const names = toolsWith().map((tool) => tool.name);
		expect(names).toEqual([
			"widgets_describe",
			"widgets_add",
			"widgets_remove",
			"widgets_duplicate",
			"widgets_move",
			"widgets_reorder",
			"widgets_resize",
			"widgets_update",
		]);
		expect(toolsWith({ prefix: "grid_" }).map((tool) => tool.name)[0]).toBe("grid_describe");
	});

	it("marks only describe as read-only and describes every tool for a model", () => {
		for (const tool of toolsWith()) {
			expect(tool.readOnly).toBe(tool.name === "widgets_describe");
			expect(tool.title.length).toBeGreaterThan(0);
			expect(tool.description.length).toBeGreaterThan(0);
			expect(tool.description).toContain("widgets_describe");
		}
	});

	it("generates object schemas without kind from the command schemas", () => {
		for (const tool of toolsWith()) {
			const schema: JsonObject = tool.inputSchema;
			expect(schema.type).toBe("object");
			expect(propertiesOf(tool)).not.toContain("kind");
		}
		const byName = new Map(toolsWith().map((tool) => [tool.name, tool]));
		const add = byName.get("widgets_add");
		if (add === undefined) throw new Error("missing widgets_add");
		expect(propertiesOf(add)).toContain("type");
		const reorder = byName.get("widgets_reorder");
		if (reorder === undefined) throw new Error("missing widgets_reorder");
		expect(propertiesOf(reorder).sort()).toEqual(["toIndex", "widgetId"]);
	});

	it("describes the config field as an object pointing at the describe tool", () => {
		const byName = new Map(toolsWith().map((tool) => [tool.name, tool]));
		for (const name of ["widgets_add", "widgets_update"]) {
			const tool = byName.get(name);
			if (tool === undefined) throw new Error(`missing ${name}`);
			const properties: unknown = tool.inputSchema.properties;
			if (!isJsonObject(properties)) throw new Error(`${name} has no input properties`);
			const config: unknown = properties.config;
			if (!isJsonObject(config)) throw new Error(`${name} has no config field`);
			expect(config.type).toBe("object");
			const description: unknown = config.description;
			if (typeof description !== "string") throw new Error(`${name} config has no description`);
			expect(description).toContain("configSchema of the widget type in widgets_describe");
		}
	});

	it("round-trips describe and the command tools through execute", async () => {
		const tools = toolsWith();
		const byName = new Map(tools.map((tool) => [tool.name, tool]));
		const take = (name: string) => {
			const tool = byName.get(name);
			if (tool === undefined) throw new Error(`missing ${name}`);
			return tool;
		};
		const described = await take("widgets_describe").execute({});
		if (!described.ok) throw new Error(JSON.stringify(described.error));
		expect(described.snapshot.widgets.map((widget) => widget.widgetId)).toEqual(["a"]);

		const added = await take("widgets_add").execute({
			type: "note",
			title: "Second",
			config: { text: "two" },
		});
		if (!added.ok) throw new Error(JSON.stringify(added.error));
		expect(added.snapshot.widgets.map((widget) => widget.widgetId)).toHaveLength(2);

		const bad = await take("widgets_remove").execute({ widgetId: "missing" });
		if (bad.ok) throw new Error("expected a failure");
		expect(bad.error.code).toBe("WIDGET_NOT_FOUND");

		const copied = await take("widgets_duplicate").execute({ widgetId: "a" });
		if (!copied.ok) throw new Error(JSON.stringify(copied.error));
		expect(copied.snapshot.widgets.map((widget) => widget.title)).toEqual([
			"Title a",
			"Title a (copy)",
			"Second",
		]);

		const invalid = await take("widgets_add").execute({ title: "No type" });
		if (invalid.ok) throw new Error("expected a failure");
		expect(invalid.error.code).toBe("INVALID_COMMAND");
	});
});
