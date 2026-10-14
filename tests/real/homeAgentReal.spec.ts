import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildChildEnv, writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * The Home MCP server against the real stack (`bun run test:real`). No model
 * quota is spent: the spec speaks MCP to the real server process itself over
 * its real stdin/stdout. A pristine copy runs the real `bun run dev` launcher
 * on its own test ports with throwaway directories (isolation exactly like
 * `homeReal.spec.ts`); the server process
 * (`bun apps/mcp/src/main.ts --api <dev API origin>`) edits the dashboard
 * through the real owner API, and the development SPA shows the result in a
 * real browser. Never run by implementation agents (needs the network and
 * minutes); the orchestrator runs it.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8908;
const API_PORT = 8909;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const MCP_TOOLS = [
	"widgets_describe",
	"widgets_add",
	"widgets_remove",
	"widgets_move",
	"widgets_reorder",
	"widgets_resize",
	"widgets_update",
];

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-agent-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-agent-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
});

test.afterAll(() => resources.close());

function homeEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18988",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method,
		headers: { ...ownerHeaders(API_ORIGIN) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		throw new Error(`${method} ${path} -> ${response.status}: ${text}`);
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

/** Next-line reader over a piped stdout: one MCP answer per line. */
function createLineReader(stream: Readable): () => Promise<string> {
	let buffer = "";
	const queued: string[] = [];
	const waiting: { resolve: (line: string) => void; reject: (error: Error) => void }[] = [];
	const take = (): Promise<string> => {
		const line = queued.shift();
		if (line !== undefined) return Promise.resolve(line);
		return new Promise<string>((resolve, reject) => {
			waiting.push({ resolve, reject });
		});
	};
	stream.on("data", (chunk: Buffer) => {
		buffer += chunk.toString("utf8");
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).replace(/\r$/, "");
			buffer = buffer.slice(index + 1);
			const next = waiting.shift();
			if (next !== undefined) next.resolve(line);
			else queued.push(line);
			index = buffer.indexOf("\n");
		}
	});
	stream.on("end", () => {
		for (const next of waiting.splice(0)) next.reject(new Error("the MCP server closed stdout"));
	});
	return take;
}

interface McpProcess {
	readonly child: ChildProcess;
	readonly call: (id: number, method: string, params?: unknown) => Promise<unknown>;
	readonly stderr: () => string;
	readonly stop: () => Promise<void>;
}

async function startMcpServer(apiOrigin: string, env: Record<string, string>): Promise<McpProcess> {
	if (pristine === null) throw new Error("the pristine copy was not created");
	const child = spawn("bun", ["apps/mcp/src/main.ts", "--api", apiOrigin], {
		cwd: pristine.root,
		env: buildChildEnv(env),
		stdio: ["pipe", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	if (child.stdout === null || child.stdin === null) {
		child.kill("SIGKILL");
		throw new Error("the MCP server has no piped stdio");
	}
	const takeLine = createLineReader(child.stdout);
	let nextId = 0;
	const call = async (id: number, method: string, params?: unknown): Promise<unknown> => {
		nextId = Math.max(nextId + 1, id);
		const message =
			params === undefined
				? { jsonrpc: "2.0", id, method }
				: { jsonrpc: "2.0", id, method, params };
		child.stdin?.write(`${JSON.stringify(message)}\n`);
		const line = await takeLine();
		return JSON.parse(line) as unknown;
	};
	return {
		child,
		call,
		stderr: () => stderr,
		stop: async () => {
			child.stdin?.end();
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			const done = await Promise.race([
				exited.then(() => true),
				new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
			]);
			if (!done) child.kill("SIGKILL");
			await exited;
		},
	};
}

function toolNames(listAnswer: unknown): string[] {
	if (typeof listAnswer !== "object" || listAnswer === null) throw new Error("no MCP answer");
	const result: unknown = (listAnswer as { result?: unknown }).result;
	if (typeof result !== "object" || result === null) throw new Error("no MCP result");
	const tools: unknown = (result as { tools?: unknown }).tools;
	if (!Array.isArray(tools)) throw new Error("tools/list has no tools");
	return tools.map((tool) => {
		if (typeof tool !== "object" || tool === null || !("name" in tool)) {
			throw new Error("a tool has no name");
		}
		return String((tool as { name: unknown }).name);
	});
}

function snapshotOf(callAnswer: unknown): {
	widgets: { widgetId: string; title: string; size: string; type: string }[];
	isError: boolean;
	errorCode: string | null;
} {
	if (typeof callAnswer !== "object" || callAnswer === null) throw new Error("no MCP answer");
	const result: unknown = (callAnswer as { result?: unknown }).result;
	if (typeof result !== "object" || result === null) throw new Error("no MCP result");
	const typed = result as { content?: unknown; isError?: unknown };
	if (!Array.isArray(typed.content) || typed.content.length === 0) {
		throw new Error("a tool result has no content");
	}
	const first: unknown = typed.content[0];
	if (typeof first !== "object" || first === null || !("text" in first)) {
		throw new Error("a tool result has no text block");
	}
	const text = String((first as { text: unknown }).text);
	const body: unknown = JSON.parse(text) as unknown;
	if (typed.isError === true) {
		if (typeof body !== "object" || body === null || !("code" in body)) {
			throw new Error("a tool failure has no code");
		}
		return { widgets: [], isError: true, errorCode: String((body as { code: unknown }).code) };
	}
	if (typeof body !== "object" || body === null || !("widgets" in body)) {
		throw new Error("a snapshot has no widgets");
	}
	const widgets: unknown = (body as { widgets: unknown }).widgets;
	if (!Array.isArray(widgets)) throw new Error("a snapshot has no widget list");
	return {
		widgets: widgets.map((widget) => {
			if (typeof widget !== "object" || widget === null)
				throw new Error("a widget is not an object");
			const record = widget as Record<string, unknown>;
			return {
				widgetId: String(record.widgetId),
				title: String(record.title),
				size: String(record.size),
				type: String(record.type),
			};
		}),
		isError: false,
		errorCode: null,
	};
}

test("an MCP client arranges the Home widgets through the owner API", async ({ page }) => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: homeEnv() });
	resources.add(async () => {
		await service.stop();
	});
	try {
		const session = await api<{ environment: string }>("GET", "/api/v1/session");
		expect(session.environment).toBe("development");

		const mcp = await startMcpServer(API_ORIGIN, homeEnv());
		resources.add(() => mcp.stop());
		try {
			const initialized = await mcp.call(1, "initialize", { protocolVersion: "2025-06-18" });
			if (typeof initialized !== "object" || initialized === null) {
				throw new Error(`initialize failed:\n${mcp.stderr()}`);
			}
			expect(toolNames(await mcp.call(2, "tools/list"))).toEqual(MCP_TOOLS);

			const before = snapshotOf(
				await mcp.call(3, "tools/call", { name: "widgets_describe", arguments: {} }),
			);
			expect(before.isError).toBe(false);
			expect(before.widgets).toHaveLength(7);

			const added = snapshotOf(
				await mcp.call(4, "tools/call", {
					name: "widgets_add",
					arguments: {
						type: "metric",
						title: "Gold (agent)",
						config: { seriesId: "twelve-data:XAU/USD" },
						toIndex: 0,
					},
				}),
			);
			expect(added.isError).toBe(false);
			expect(added.widgets[0]?.title).toBe("Gold (agent)");

			const resized = snapshotOf(
				await mcp.call(5, "tools/call", {
					name: "widgets_resize",
					arguments: { widgetId: "w-vix-chart", size: "large" },
				}),
			);
			expect(resized.isError).toBe(false);

			const reordered = snapshotOf(
				await mcp.call(6, "tools/call", {
					name: "widgets_reorder",
					arguments: { widgetId: "w-us-economy", toIndex: 1 },
				}),
			);
			expect(reordered.isError).toBe(false);
			const agentId = reordered.widgets[0]?.widgetId;
			if (agentId === undefined) throw new Error("the added widget is missing");
			expect(reordered.widgets.map((widget) => widget.widgetId)).toEqual([
				agentId,
				"w-us-economy",
				"w-vix",
				"w-gold",
				"w-dgs10",
				"w-sp500",
				"w-vix-chart",
				"w-watchlist",
			]);

			// The stored dashboard has exactly that arrangement…
			const stored = await api<{
				dashboard: { widgets: { widgetId: string; title: string; size: string }[] };
				version: number;
			}>("GET", "/api/v1/home/dashboard");
			expect(stored.dashboard.widgets.map((widget) => widget.widgetId)).toEqual(
				reordered.widgets.map((widget) => widget.widgetId),
			);
			expect(stored.dashboard.widgets[0]).toMatchObject({ title: "Gold (agent)", size: "small" });
			expect(
				stored.dashboard.widgets.find((widget) => widget.widgetId === "w-vix-chart"),
			).toMatchObject({ size: "large" });

			// …and the development SPA shows the same order and sizes.
			await page.goto(`${VITE_ORIGIN}/#/home`);
			await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
				timeout: 60_000,
			});
			await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible({
				timeout: 60_000,
			});
			const order = () =>
				page
					.locator("article[data-widget-id]")
					.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-id") ?? ""));
			await expect
				.poll(order, { timeout: 30_000 })
				.toEqual(reordered.widgets.map((widget) => widget.widgetId));
			const sizes = await page
				.locator("article[data-widget-id]")
				.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-size") ?? ""));
			expect(
				sizes[reordered.widgets.findIndex((widget) => widget.widgetId === "w-vix-chart")],
			).toBe("large");
			expect(sizes[0]).toBe("small");

			const shotsDir = join(REPO_ROOT, "test-results-real");
			mkdirSync(shotsDir, { recursive: true });
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.waitForTimeout(1_000);
			await page.screenshot({ path: join(shotsDir, "home-agent-1440x900.png"), fullPage: true });
			await page.setViewportSize({ width: 390, height: 844 });
			await page.waitForTimeout(1_000);
			await page.screenshot({ path: join(shotsDir, "home-agent-390x844.png"), fullPage: true });

			// A refused command answers isError and leaves the version unchanged.
			const refused = snapshotOf(
				await mcp.call(7, "tools/call", {
					name: "widgets_remove",
					arguments: { widgetId: "w-no-such-widget" },
				}),
			);
			expect(refused.isError).toBe(true);
			expect(refused.errorCode).toBe("WIDGET_NOT_FOUND");
			const after = await api<{ version: number }>("GET", "/api/v1/home/dashboard");
			expect(after.version).toBe(stored.version);
		} finally {
			await mcp.stop();
		}
	} finally {
		await service.stop();
	}
});
