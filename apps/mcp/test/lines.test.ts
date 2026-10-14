import { isJsonObject, type JsonObject } from "@research/widget-grid/agent";
import { describe, expect, it } from "vitest";
import { serveMcpLines } from "../src/main.ts";

async function collect(
	lines: readonly string[],
	handle: (message: unknown) => Promise<JsonObject | null>,
): Promise<string[]> {
	const written: string[] = [];
	await serveMcpLines({
		lines: (async function* () {
			for (const line of lines) yield line;
		})(),
		handle,
		writeLine: (line) => {
			written.push(line);
		},
	});
	return written;
}

describe("serveMcpLines", () => {
	it("answers in arrival order, skips blank lines, and writes one line per response", async () => {
		const seen: unknown[] = [];
		const written = await collect(
			["", "  ", '{"jsonrpc":"2.0","id":1,"method":"ping"}'],
			async (message) => {
				seen.push(message);
				return { jsonrpc: "2.0", id: 1, result: {} };
			},
		);
		expect(seen).toHaveLength(1);
		expect(written).toHaveLength(1);
		const response: unknown = JSON.parse(written[0] ?? "");
		if (!isJsonObject(response)) throw new Error("the response is not an object");
		expect(response).toMatchObject({ jsonrpc: "2.0", id: 1, result: {} });
	});

	it("keeps arrival order even when a later message handles faster", async () => {
		const order: number[] = [];
		const written = await collect(
			['{"jsonrpc":"2.0","id":1,"method":"slow"}', '{"jsonrpc":"2.0","id":2,"method":"fast"}'],
			async (message) => {
				if (
					!isJsonObject(message) ||
					typeof message.method !== "string" ||
					(typeof message.id !== "number" && typeof message.id !== "string")
				) {
					throw new Error("unexpected message shape");
				}
				if (message.method === "slow") await new Promise((resolve) => setTimeout(resolve, 20));
				order.push(typeof message.id === "number" ? message.id : -1);
				return { jsonrpc: "2.0", id: message.id, result: {} };
			},
		);
		expect(order).toEqual([1, 2]);
		const ids = written.map((line) => {
			const parsed: unknown = JSON.parse(line);
			if (!isJsonObject(parsed) || typeof parsed.id !== "number") {
				throw new Error("a response line has no numeric id");
			}
			return parsed.id;
		});
		expect(ids).toEqual([1, 2]);
	});

	it("answers a line that is not JSON with -32700 and keeps going", async () => {
		const written = await collect(
			["not json", '{"jsonrpc":"2.0","id":7,"method":"ping"}'],
			async () => ({
				jsonrpc: "2.0",
				id: 7,
				result: {},
			}),
		);
		expect(written).toHaveLength(2);
		const first: unknown = JSON.parse(written[0] ?? "");
		if (!isJsonObject(first) || !isJsonObject(first.error)) {
			throw new Error("the first answer is not a JSON-RPC error");
		}
		expect(first.error.code).toBe(-32700);
		expect(first.id).toBeNull();
		const second: unknown = JSON.parse(written[1] ?? "");
		if (!isJsonObject(second)) throw new Error("the second answer is not an object");
		expect(second.id).toBe(7);
	});

	it("writes no line for a notification", async () => {
		const written = await collect(
			['{"jsonrpc":"2.0","method":"ping"}', '{"jsonrpc":"2.0","id":3,"method":"ping"}'],
			async (message) => {
				if (!isJsonObject(message) || message.id === undefined) return null;
				return { jsonrpc: "2.0", id: message.id, result: {} };
			},
		);
		expect(written).toHaveLength(1);
	});
});
