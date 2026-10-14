import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_HOME_DASHBOARD,
	type HomeDashboard,
	homeDashboardSchema,
} from "@research/contracts";
import { isJsonObject, type JsonObject, type McpToolServer } from "@research/widget-grid/agent";
import { describe, expect, it } from "vitest";
import type { HomeStoreFetch } from "../src/homeStore.ts";
import {
	createHomeMcpServer,
	HOME_MCP_SERVER_NAME,
	HOME_MCP_SERVER_VERSION,
	newHomeWidgetId,
} from "../src/server.ts";

const API_ORIGIN = "http://127.0.0.1:8787";

/** The fake owner API: the two Home routes over mutable state, nothing else. */
function fakeHomeApi(
	initial: HomeDashboard,
	version: number,
): {
	fetch: HomeStoreFetch;
	puts: () => number;
	dashboard: () => HomeDashboard;
	version: () => number;
	armConflict: () => void;
} {
	let dashboard: HomeDashboard = structuredClone(initial);
	let currentVersion = version;
	let putCount = 0;
	/** The next PUT answers 409, as if a writer slipped in mid-command. */
	let conflictArmed = false;
	const fetch: HomeStoreFetch = (input, init) => {
		if (input !== `${API_ORIGIN}/api/v1/home/dashboard`) {
			return Promise.resolve(
				new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "no such route" } }), {
					status: 404,
				}),
			);
		}
		if (init.method === "GET") {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						dashboard,
						version: currentVersion,
						updatedAt: null,
						origin: "saved",
					}),
					{ status: 200 },
				),
			);
		}
		putCount += 1;
		if (conflictArmed) {
			conflictArmed = false;
			return Promise.resolve(
				new Response(
					JSON.stringify({
						error: {
							code: "VERSION_CONFLICT",
							message: "The dashboard changed; reload and try again.",
						},
					}),
					{ status: 409 },
				),
			);
		}
		let body: unknown;
		try {
			body = JSON.parse(String(init.body));
		} catch {
			return Promise.resolve(
				new Response(
					JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "body is not JSON" } }),
					{ status: 400 },
				),
			);
		}
		if (
			!isJsonObject(body) ||
			!isJsonObject(body.dashboard) ||
			typeof body.expectedVersion !== "number"
		) {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						error: { code: "VALIDATION_FAILED", message: "dashboard is required" },
					}),
					{ status: 400 },
				),
			);
		}
		const stored = homeDashboardSchema.safeParse(body.dashboard);
		if (!stored.success) {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						error: { code: "VALIDATION_FAILED", message: "the dashboard is invalid" },
					}),
					{ status: 400 },
				),
			);
		}
		if (body.expectedVersion !== currentVersion) {
			return Promise.resolve(
				new Response(
					JSON.stringify({
						error: {
							code: "VERSION_CONFLICT",
							message: "The dashboard changed; reload and try again.",
						},
					}),
					{ status: 409 },
				),
			);
		}
		dashboard = stored.data;
		currentVersion += 1;
		return Promise.resolve(
			new Response(
				JSON.stringify({ dashboard, version: currentVersion, updatedAt: null, origin: "saved" }),
				{ status: 200 },
			),
		);
	};
	return {
		fetch,
		puts: () => putCount,
		dashboard: () => dashboard,
		version: () => currentVersion,
		armConflict: () => {
			conflictArmed = true;
		},
	};
}

interface SnapshotWidget {
	readonly widgetId: string;
	readonly type: string;
	readonly title: string;
	readonly size: string;
	readonly config: JsonObject;
}

function widgetView(value: unknown): SnapshotWidget {
	if (!isJsonObject(value)) throw new Error("a snapshot widget is not an object");
	const { widgetId, title, size, type, config } = value;
	if (
		typeof widgetId !== "string" ||
		typeof title !== "string" ||
		typeof size !== "string" ||
		typeof type !== "string" ||
		!isJsonObject(config)
	) {
		throw new Error("a snapshot widget is missing its fields");
	}
	return { widgetId, title, size, type, config };
}

function snapshotWidgets(result: JsonObject): SnapshotWidget[] {
	const content: unknown = result.content;
	if (!Array.isArray(content) || content.length === 0)
		throw new Error("a tool result has no content");
	const first: unknown = content[0];
	if (!isJsonObject(first) || typeof first.text !== "string") {
		throw new Error("a tool result has no text block");
	}
	if (result.isError === true) throw new Error(`the tool failed: ${first.text}`);
	const snapshot: unknown = JSON.parse(first.text);
	if (!isJsonObject(snapshot) || !Array.isArray(snapshot.widgets)) {
		throw new Error("a snapshot has no widgets");
	}
	return snapshot.widgets.map(widgetView);
}

function toolError(result: JsonObject): { readonly code: string; readonly message: string } {
	if (result.isError !== true) throw new Error("the tool did not fail");
	const content: unknown = result.content;
	if (!Array.isArray(content) || content.length === 0)
		throw new Error("a tool failure has no content");
	const first: unknown = content[0];
	if (!isJsonObject(first) || typeof first.text !== "string") {
		throw new Error("a tool failure has no text block");
	}
	const error: unknown = JSON.parse(first.text);
	if (!isJsonObject(error) || typeof error.code !== "string" || typeof error.message !== "string") {
		throw new Error("a tool failure has no code and message");
	}
	return { code: error.code, message: error.message };
}

async function callTool(
	server: McpToolServer,
	id: number,
	name: string,
	args: Record<string, unknown>,
): Promise<JsonObject> {
	const response = await server.handle({
		jsonrpc: "2.0",
		id,
		method: "tools/call",
		params: { name, arguments: args },
	});
	if (response === null) throw new Error("a tools/call produced no response");
	const result: unknown = response.result;
	if (!isJsonObject(result)) throw new Error("a tools/call has no result object");
	return result;
}

function toolNames(result: JsonObject): string[] {
	const tools: unknown = result.tools;
	if (!Array.isArray(tools)) throw new Error("tools/list has no tools");
	return tools.map((tool) => {
		if (!isJsonObject(tool) || typeof tool.name !== "string") throw new Error("a tool has no name");
		return tool.name;
	});
}

describe("createHomeMcpServer", () => {
	it("identifies itself with the packaged version", async () => {
		const api = fakeHomeApi(DEFAULT_HOME_DASHBOARD, 0);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });
		const manifest: unknown = JSON.parse(
			readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
		);
		if (!isJsonObject(manifest) || typeof manifest.version !== "string") {
			throw new Error("apps/mcp/package.json has no version");
		}
		expect(HOME_MCP_SERVER_VERSION).toBe(manifest.version);
		const response = await server.handle({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18" },
		});
		if (response === null) throw new Error("initialize produced no response");
		const result: unknown = response.result;
		if (!isJsonObject(result) || !isJsonObject(result.serverInfo)) {
			throw new Error("initialize has no serverInfo");
		}
		expect(result.serverInfo.name).toBe(HOME_MCP_SERVER_NAME);
		expect(result.serverInfo.version).toBe(manifest.version);
	});

	it("lists all eight tools", async () => {
		const api = fakeHomeApi(DEFAULT_HOME_DASHBOARD, 0);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });
		const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		if (response === null) throw new Error("tools/list produced no response");
		const result: unknown = response.result;
		if (!isJsonObject(result)) throw new Error("tools/list has no result object");
		expect(toolNames(result)).toEqual([
			"widgets_describe",
			"widgets_add",
			"widgets_remove",
			"widgets_duplicate",
			"widgets_move",
			"widgets_reorder",
			"widgets_resize",
			"widgets_update",
		]);
	});

	it("adds, resizes, reorders, updates and removes through the API", async () => {
		const api = fakeHomeApi(DEFAULT_HOME_DASHBOARD, 0);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });

		const described = snapshotWidgets(await callTool(server, 1, "widgets_describe", {}));
		expect(described).toHaveLength(7);

		const added = snapshotWidgets(
			await callTool(server, 2, "widgets_add", {
				type: "metric",
				title: "Gold (agent)",
				config: { seriesId: "twelve-data:XAU/USD" },
				toIndex: 0,
			}),
		);
		expect(added[0]?.title).toBe("Gold (agent)");
		const addedId = added[0]?.widgetId;
		if (addedId === undefined) throw new Error("the added widget has no id");

		const resized = snapshotWidgets(
			await callTool(server, 3, "widgets_resize", { widgetId: "w-vix-chart", size: "large" }),
		);
		expect(resized.find((widget) => widget.widgetId === "w-vix-chart")?.size).toBe("large");

		const reordered = snapshotWidgets(
			await callTool(server, 4, "widgets_reorder", { widgetId: "w-us-economy", toIndex: 1 }),
		);
		expect(reordered.map((widget) => widget.widgetId)[1]).toBe("w-us-economy");

		const updated = snapshotWidgets(
			await callTool(server, 5, "widgets_update", {
				widgetId: "w-vix-chart",
				config: { range: "3m" },
			}),
		);
		expect(updated.find((widget) => widget.widgetId === "w-vix-chart")?.config).toMatchObject({
			range: "3m",
		});

		const removed = snapshotWidgets(
			await callTool(server, 6, "widgets_remove", { widgetId: addedId }),
		);
		expect(removed.map((widget) => widget.widgetId)).toEqual([
			"w-us-economy",
			"w-vix",
			"w-gold",
			"w-dgs10",
			"w-sp500",
			"w-vix-chart",
			"w-watchlist",
		]);
		// What the snapshots show is what the API stored: every edit went
		// through the versioned PUT.
		expect(api.dashboard().widgets.map((widget) => widget.widgetId)).toEqual(
			removed.map((widget) => widget.widgetId),
		);
		expect(api.version()).toBe(5);
		expect(api.puts()).toBe(5);
	});

	it("duplicates a widget right after the original through the API", async () => {
		const api = fakeHomeApi(DEFAULT_HOME_DASHBOARD, 0);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });

		const before = snapshotWidgets(await callTool(server, 1, "widgets_describe", {}));
		const source = before.find((widget) => widget.widgetId === "w-gold");
		if (source === undefined) throw new Error("the gold widget is missing");

		const duplicated = snapshotWidgets(
			await callTool(server, 2, "widgets_duplicate", { widgetId: "w-gold" }),
		);
		expect(duplicated).toHaveLength(before.length + 1);
		const at = duplicated.findIndex((widget) => widget.widgetId === "w-gold");
		const copy = duplicated[at + 1];
		if (copy === undefined) throw new Error("the duplicate did not land after the original");
		expect(copy.widgetId).not.toBe("w-gold");
		expect(copy.title).toBe(`${source.title} (copy)`);
		expect(copy.type).toBe(source.type);
		expect(copy.config).toEqual(source.config);
		// What the snapshot shows is what the API stored: the copy went
		// through the versioned PUT.
		expect(api.dashboard().widgets.map((widget) => widget.widgetId)).toEqual(
			duplicated.map((widget) => widget.widgetId),
		);
		expect(api.version()).toBe(1);
		expect(api.puts()).toBe(1);
	});

	it("refuses a 31st distinct series before any PUT", async () => {
		const series = (n: number): string => `fred:S${String(n).padStart(2, "0")}`;
		const table = (index: number, ids: readonly string[]): HomeDashboard["widgets"][number] => ({
			type: "indicator-table",
			widgetId: `w-t${index}`,
			title: `Table ${index}`,
			size: "large",
			seriesIds: [...ids],
		});
		const full: HomeDashboard = {
			schemaVersion: 1,
			widgets: [
				table(
					0,
					Array.from({ length: 12 }, (_, n) => series(n)),
				),
				table(
					1,
					Array.from({ length: 12 }, (_, n) => series(n + 12)),
				),
				table(
					2,
					Array.from({ length: 6 }, (_, n) => series(n + 24)),
				),
			],
		};
		const api = fakeHomeApi(full, 10);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });
		const putsBefore = api.puts();
		const result = await callTool(server, 1, "widgets_add", {
			type: "metric",
			title: "One too many",
			config: { seriesId: "fred:VIXCLS" },
		});
		const error = toolError(result);
		expect(error.code).toBe("INVALID_WIDGET");
		expect(error.message).toContain("too many distinct series");
		expect(api.puts()).toBe(putsBefore);
		expect(api.version()).toBe(10);
	});

	it("surfaces a conflict as isError with CONFLICT", async () => {
		const api = fakeHomeApi(DEFAULT_HOME_DASHBOARD, 0);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });
		// A writer slips in between the read and the write: the PUT is refused.
		api.armConflict();
		const result = await callTool(server, 1, "widgets_remove", { widgetId: "w-gold" });
		const error = toolError(result);
		expect(error.code).toBe("CONFLICT");
		expect(api.version()).toBe(0);
	});

	it("answers an unknown widget id with isError and leaves the version unchanged", async () => {
		const api = fakeHomeApi(DEFAULT_HOME_DASHBOARD, 0);
		const server = createHomeMcpServer({ apiOrigin: API_ORIGIN, fetch: api.fetch });
		const result = await callTool(server, 1, "widgets_remove", { widgetId: "w-missing" });
		const error = toolError(result);
		expect(error.code).toBe("WIDGET_NOT_FOUND");
		expect(api.version()).toBe(0);
		expect(api.puts()).toBe(0);
	});

	it("allocates ids the contract accepts", () => {
		expect(newHomeWidgetId()).toMatch(/^w-mcp-[A-Za-z0-9_.-]+$/);
		expect(newHomeWidgetId()).not.toBe(newHomeWidgetId());
	});
});
