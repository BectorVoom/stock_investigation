import { createInterface } from "node:readline";
import type { JsonObject } from "@research/widget-grid/agent";
import { HOME_MCP_HELP, parseHomeMcpConfig } from "./config.ts";
import { createHomeMcpServer, HOME_MCP_SERVER_NAME, HOME_MCP_SERVER_VERSION } from "./server.ts";

/**
 * The transport only (ADR-0019): newline-delimited JSON on stdin, one message
 * per line handled strictly in arrival order, one JSON line per response on
 * stdout. A line that is not JSON gets JSON-RPC error `-32700` (parse error).
 * Diagnostics go to stderr only — stdout carries nothing but protocol
 * messages. Exits 0 when stdin closes.
 *
 * Logging (docs/rule/logging.md, as far as it applies to a process whose
 * stdout is a protocol channel): this process cannot import the Effect
 * logger (its import boundary is contracts + widget-grid + zod + node:), so
 * it writes the same shape by hand — one JSON line per event on stderr, a
 * snake_case event name, identifiers and codes only, never message text or
 * stored content (there are no credentials here to leak: the API is loopback
 * with no sign-in).
 */

const JSON_RPC_PARSE_ERROR = -32700;

function logEvent(event: string, fields: Readonly<Record<string, string | number>>): void {
	process.stderr.write(
		`${JSON.stringify({ at: new Date().toISOString(), level: "info", event, ...fields })}\n`,
	);
}

/**
 * The line loop as a pure function of its inputs: an async iterable of lines
 * and a sink. Sequential on purpose — each message is handled before the next
 * line is read, so responses keep arrival order. A notification (the handler
 * answers null) produces no line.
 */
export async function serveMcpLines(options: {
	readonly lines: AsyncIterable<string>;
	readonly handle: (message: unknown) => Promise<JsonObject | null>;
	readonly writeLine: (line: string) => void;
}): Promise<void> {
	for await (const line of options.lines) {
		if (line.trim() === "") continue;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			options.writeLine(
				JSON.stringify({
					jsonrpc: "2.0",
					id: null,
					error: { code: JSON_RPC_PARSE_ERROR, message: "Parse error: the line is not JSON." },
				}),
			);
			continue;
		}
		const response = await options.handle(message);
		if (response !== null) options.writeLine(JSON.stringify(response));
	}
}

async function main(): Promise<void> {
	const parsed = parseHomeMcpConfig(process.argv.slice(2), process.env);
	if (!parsed.ok) {
		process.stderr.write(`${HOME_MCP_SERVER_NAME}: ${parsed.error}\n`);
		process.exitCode = 1;
		return;
	}
	if (parsed.value.help) {
		process.stderr.write(`${HOME_MCP_HELP}\n`);
		return;
	}
	const server = createHomeMcpServer({ apiOrigin: parsed.value.apiOrigin });
	logEvent("mcp_home_started", {
		server: HOME_MCP_SERVER_NAME,
		version: HOME_MCP_SERVER_VERSION,
		apiOrigin: parsed.value.apiOrigin,
	});
	const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
	try {
		await serveMcpLines({
			lines,
			handle: (message) => server.handle(message),
			writeLine: (line) => {
				process.stdout.write(`${line}\n`);
			},
		});
	} finally {
		lines.close();
	}
}

/**
 * Runs only when executed directly (`bun apps/mcp/src/main.ts`): importing
 * this module (as the tests do for `serveMcpLines`) must never start the
 * server — and must never write to stdout, the protocol channel.
 */
const invokedDirectly = process.argv[1]?.endsWith("apps/mcp/src/main.ts") ?? false;
if (invokedDirectly) {
	main().catch((cause: unknown) => {
		const name = cause instanceof Error ? cause.name : "unknown";
		process.stderr.write(`${HOME_MCP_SERVER_NAME}: fatal ${name}.\n`);
		process.exitCode = 1;
	});
}
