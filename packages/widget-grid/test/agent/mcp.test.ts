import { describe, expect, it } from "vitest";
import { createWidgetAgentHost } from "../../src/agent/host.ts";
import { createMcpToolServer, MCP_LATEST_PROTOCOL_VERSION } from "../../src/agent/mcp.ts";
import { createWidgetAgentTools } from "../../src/agent/tools.ts";
import type { JsonObject } from "../../src/agent/types.ts";
import { bannerType, createToyStore, freshId, noteType, toy } from "./support.ts";

const SERVER = { name: "widget-grid-test", version: "0.1.0" };

async function call(message: unknown): Promise<JsonObject> {
	const controls = createToyStore([toy("a"), toy("b")]);
	const host = createWidgetAgentHost({
		store: controls.store,
		types: [noteType, bannerType],
		newWidgetId: freshId,
	});
	const server = createMcpToolServer({
		...SERVER,
		tools: createWidgetAgentTools(host),
	});
	const response = await server.handle(message);
	if (response === null) throw new Error("expected a response, got a notification null");
	return response;
}

function resultOf(response: JsonObject): unknown {
	if (!("result" in response)) throw new Error(`no result: ${JSON.stringify(response)}`);
	return response.result;
}

function errorOf(response: JsonObject): { readonly code: number; readonly message: string } {
	if (!("error" in response)) throw new Error(`no error: ${JSON.stringify(response)}`);
	const error: unknown = response.error;
	if (typeof error !== "object" || error === null || !("code" in error)) {
		throw new Error(`malformed error: ${JSON.stringify(response)}`);
	}
	const code: unknown = error.code;
	if (typeof code !== "number") throw new Error(`malformed error: ${JSON.stringify(response)}`);
	return { code, message: JSON.stringify(error) };
}

/** The text of the single content block of a tools/call result. */
function callText(response: JsonObject): { readonly text: string; readonly isError: boolean } {
	const result: unknown = resultOf(response);
	if (typeof result !== "object" || result === null || !("content" in result)) {
		throw new Error(`malformed tool result: ${JSON.stringify(response)}`);
	}
	const content: unknown = result.content;
	if (!Array.isArray(content)) throw new Error("content is not an array");
	const first: unknown = content[0];
	if (typeof first !== "object" || first === null || !("text" in first)) {
		throw new Error("content has no text block");
	}
	const text: unknown = first.text;
	if (typeof text !== "string") throw new Error("text block is not a string");
	if (!("isError" in result)) throw new Error("tool result has no isError");
	return { text, isError: result.isError === true };
}

describe("createMcpToolServer", () => {
	it("negotiates the protocol version on initialize", async () => {
		const supported = await call({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "probe", version: "1" },
			},
		});
		expect(supported).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: SERVER,
			},
		});
		const other = await call({
			jsonrpc: "2.0",
			id: 2,
			method: "initialize",
			params: { protocolVersion: "1999-01-01", capabilities: {} },
		});
		expect(resultOf(other)).toMatchObject({ protocolVersion: MCP_LATEST_PROTOCOL_VERSION });
		const missing = await call({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
		expect(errorOf(missing).code).toBe(-32602);
	});

	it("answers ping with an empty object", async () => {
		expect(await call({ jsonrpc: "2.0", id: 1, method: "ping" })).toEqual({
			jsonrpc: "2.0",
			id: 1,
			result: {},
		});
	});

	it("lists every tool with its schema and read-only hint", async () => {
		const response = await call({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const result: unknown = resultOf(response);
		if (typeof result !== "object" || result === null || !("tools" in result)) {
			throw new Error("malformed tools/list result");
		}
		const tools: unknown = result.tools;
		if (!Array.isArray(tools)) throw new Error("tools is not an array");
		const names: string[] = [];
		for (const tool of tools) {
			if (typeof tool !== "object" || tool === null || !("name" in tool)) {
				throw new Error("malformed tool entry");
			}
			const name: unknown = tool.name;
			if (typeof name !== "string") throw new Error("malformed tool entry");
			names.push(name);
		}
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
		for (const tool of tools) {
			if (typeof tool !== "object" || tool === null) throw new Error("malformed tool entry");
			for (const key of ["name", "title", "description", "inputSchema", "annotations"] as const) {
				if (!(key in tool)) throw new Error(`tool entry misses ${key}`);
			}
		}
		const hints = new Map(
			tools.map((tool) => {
				if (typeof tool !== "object" || tool === null) throw new Error("malformed tool entry");
				const entry: { readonly name?: unknown; readonly annotations?: unknown } = tool;
				if (typeof entry.name !== "string") throw new Error("tool entry misses name");
				if (
					typeof entry.annotations !== "object" ||
					entry.annotations === null ||
					!("readOnlyHint" in entry.annotations)
				) {
					throw new Error("tool entry misses annotations.readOnlyHint");
				}
				return [entry.name, entry.annotations.readOnlyHint];
			}),
		);
		expect(hints.get("widgets_describe")).toBe(true);
		expect(hints.get("widgets_add")).toBe(false);
	});

	it("calls a tool and returns the snapshot as text", async () => {
		const response = await call({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "widgets_reorder", arguments: { widgetId: "b", toIndex: 0 } },
		});
		const { text, isError } = callText(response);
		expect(isError).toBe(false);
		const body: unknown = JSON.parse(text);
		expect(body).toMatchObject({ protocolVersion: 1 });
		if (typeof body !== "object" || body === null || !("widgets" in body)) {
			throw new Error("snapshot misses widgets");
		}
		const widgets: unknown = body.widgets;
		if (!Array.isArray(widgets)) throw new Error("widgets is not an array");
		const ids: string[] = [];
		for (const widget of widgets) {
			if (typeof widget !== "object" || widget === null || !("widgetId" in widget)) {
				throw new Error("malformed snapshot widget");
			}
			const widgetId: unknown = widget.widgetId;
			if (typeof widgetId !== "string") throw new Error("malformed snapshot widget");
			ids.push(widgetId);
		}
		expect(ids).toEqual(["b", "a"]);
	});

	it("duplicates through widgets_duplicate", async () => {
		const response = await call({
			jsonrpc: "2.0",
			id: 5,
			method: "tools/call",
			params: { name: "widgets_duplicate", arguments: { widgetId: "a" } },
		});
		const { text, isError } = callText(response);
		expect(isError).toBe(false);
		const body: unknown = JSON.parse(text);
		if (typeof body !== "object" || body === null || !("widgets" in body)) {
			throw new Error("snapshot misses widgets");
		}
		const widgets: unknown = body.widgets;
		if (!Array.isArray(widgets)) throw new Error("widgets is not an array");
		const titles: string[] = [];
		for (const widget of widgets) {
			if (typeof widget !== "object" || widget === null || !("title" in widget)) {
				throw new Error("malformed snapshot widget");
			}
			const title: unknown = widget.title;
			if (typeof title !== "string") throw new Error("malformed snapshot widget");
			titles.push(title);
		}
		expect(titles).toEqual(["Title a", "Title a (copy)", "Title b"]);
	});

	it("returns a failed tool as a normal result with isError", async () => {
		const response = await call({
			jsonrpc: "2.0",
			id: 6,
			method: "tools/call",
			params: { name: "widgets_remove", arguments: { widgetId: "missing" } },
		});
		const { text, isError } = callText(response);
		expect(isError).toBe(true);
		expect(JSON.parse(text)).toMatchObject({ code: "WIDGET_NOT_FOUND" });
	});

	it("rejects an unknown tool name with -32602", async () => {
		const response = await call({
			jsonrpc: "2.0",
			id: 7,
			method: "tools/call",
			params: { name: "widgets_explode", arguments: {} },
		});
		expect(errorOf(response).code).toBe(-32602);
		const missing = await call({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} });
		expect(errorOf(missing).code).toBe(-32602);
	});

	it("rejects an unknown method with -32601", async () => {
		expect(errorOf(await call({ jsonrpc: "2.0", id: 9, method: "resources/list" })).code).toBe(
			-32601,
		);
	});

	it("rejects malformed messages with -32600 and a null id", async () => {
		for (const message of [
			null,
			42,
			"initialize",
			[],
			{},
			{ method: "ping" },
			{ jsonrpc: "1.0", id: 1, method: "ping" },
			{ jsonrpc: "2.0", id: 1 },
		]) {
			const response = await call(message);
			expect(response).toMatchObject({
				jsonrpc: "2.0",
				id: null,
				error: { code: -32600 },
			});
		}
	});

	it("returns null for notifications", async () => {
		const controls = createToyStore();
		const host = createWidgetAgentHost({
			store: controls.store,
			types: [noteType],
			newWidgetId: freshId,
		});
		const server = createMcpToolServer({
			...SERVER,
			tools: createWidgetAgentTools(host),
		});
		expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
		expect(await server.handle({ jsonrpc: "2.0", method: "ping" })).toBeNull();
	});
});
