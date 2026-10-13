import { z } from "zod";
import type { JsonObject, WidgetAgentTool, WidgetAgentToolResult } from "./types.ts";

/**
 * A pure Model Context Protocol handler over JSON-RPC 2.0, with no transport:
 * a host supplies only how messages arrive and leave. Method names, result
 * shapes and error codes follow the MCP specification (modelcontextprotocol.io,
 * "Lifecycle" and "Tools" of protocol version 2025-06-18): `initialize`
 * negotiates the protocol version, `ping` answers `{}`, `tools/list` lists
 * the tools, `tools/call` runs one. A failed tool is a normal result with
 * `isError: true`; only protocol problems (unknown tool, unknown method,
 * malformed message) are JSON-RPC errors. Notifications (no `id`) return
 * `null`. Never throws.
 */

/** Protocol revisions this server speaks; the latest is negotiated by default. */
export const MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"] as const;
export type McpProtocolVersion = (typeof MCP_PROTOCOL_VERSIONS)[number];
export const MCP_LATEST_PROTOCOL_VERSION: McpProtocolVersion = "2025-06-18";

const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

export interface CreateMcpToolServerOptions {
	readonly name: string;
	readonly version: string;
	readonly tools: readonly WidgetAgentTool[];
}

export interface McpToolServer {
	readonly handle: (message: unknown) => Promise<JsonObject | null>;
}

const envelopeSchema = z.object({
	jsonrpc: z.literal("2.0"),
	id: z.union([z.string(), z.number()]).optional(),
	method: z.string().min(1),
	params: z.unknown().optional(),
});

const initializeParamsSchema = z.object({
	protocolVersion: z.string().min(1),
});

const callParamsSchema = z.object({
	name: z.string().min(1),
	arguments: z.record(z.string(), z.unknown()).optional(),
});

/** JSON text of a value, for the single text block of a tool result. */
function jsonText(value: unknown): string {
	try {
		const text: unknown = JSON.stringify(value);
		return typeof text === "string" ? text : "null";
	} catch {
		return "null";
	}
}

function toolResultBody(result: WidgetAgentToolResult): JsonObject {
	const text = result.ok === true ? jsonText(result.snapshot) : jsonText(result.error);
	return {
		content: [{ type: "text", text }],
		isError: result.ok !== true,
	};
}

export function createMcpToolServer(options: CreateMcpToolServerOptions): McpToolServer {
	const { name, version, tools } = options;

	const success = (id: string | number, result: JsonObject): JsonObject => ({
		jsonrpc: "2.0",
		id,
		result,
	});

	const failure = (id: string | number | null, code: number, message: string): JsonObject => ({
		jsonrpc: "2.0",
		id,
		error: { code, message },
	});

	const handle = async (message: unknown): Promise<JsonObject | null> => {
		try {
			const parsed = envelopeSchema.safeParse(message);
			if (!parsed.success) {
				return failure(
					null,
					JSON_RPC_INVALID_REQUEST,
					"Invalid request: not a JSON-RPC 2.0 message.",
				);
			}
			const { id, method, params } = parsed.data;
			// A notification carries no id and gets no response.
			if (id === undefined) return null;
			switch (method) {
				case "initialize": {
					const init = initializeParamsSchema.safeParse(params);
					if (!init.success) {
						return failure(
							id,
							JSON_RPC_INVALID_PARAMS,
							'Invalid params: "protocolVersion" is required.',
						);
					}
					const requested = init.data.protocolVersion;
					const negotiated: string = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(
						requested,
					)
						? requested
						: MCP_LATEST_PROTOCOL_VERSION;
					return success(id, {
						protocolVersion: negotiated,
						capabilities: { tools: {} },
						serverInfo: { name, version },
					});
				}
				case "ping": {
					return success(id, {});
				}
				case "tools/list": {
					return success(id, {
						tools: tools.map((tool) => ({
							name: tool.name,
							title: tool.title,
							description: tool.description,
							inputSchema: tool.inputSchema,
							annotations: { readOnlyHint: tool.readOnly },
						})),
					});
				}
				case "tools/call": {
					const call = callParamsSchema.safeParse(params);
					if (!call.success) {
						return failure(id, JSON_RPC_INVALID_PARAMS, "Invalid params: a tool name is required.");
					}
					const tool = tools.find((candidate) => candidate.name === call.data.name);
					if (tool === undefined) {
						return failure(id, JSON_RPC_INVALID_PARAMS, `Unknown tool: "${call.data.name}".`);
					}
					let result: WidgetAgentToolResult;
					try {
						result = await tool.execute(call.data.arguments ?? {});
					} catch {
						return failure(id, JSON_RPC_INTERNAL_ERROR, "Internal error: the tool threw.");
					}
					return success(id, toolResultBody(result));
				}
				default: {
					return failure(id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: "${method}".`);
				}
			}
		} catch {
			return failure(null, JSON_RPC_INTERNAL_ERROR, "Internal error.");
		}
	};

	return { handle };
}
