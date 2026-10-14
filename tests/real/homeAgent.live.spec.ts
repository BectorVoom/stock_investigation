import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { baseChildEnv, writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * A real agent arranges the Home widgets through the MCP server
 * (`bun run test:real:live`, spends plan quota).
 *
 * Opt-in: skipped without `RUN_LIVE_OPENCODE=1` and `OPENCODE_MODEL` (the
 * same switches the existing live suites use). Same launcher set-up as the
 * quota-free agent spec, then the real CLI does the work: the server is
 * registered with `opencode mcp add home-widgets -- bun
 * <pristine>/apps/mcp/src/main.ts --api <dev API origin>` in a throwaway
 * directory, and `opencode run` carries the prompt. A model that does not do
 * it fails the test — a finding, never something to assert around. Never run
 * by implementation agents (needs plan quota and minutes); the orchestrator
 * runs it.
 */
test.describe.configure({ mode: "serial" });

const LIVE = process.env.RUN_LIVE_OPENCODE === "1";
const MODEL = (process.env.OPENCODE_MODEL ?? "").trim();
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VITE_PORT = 8910;
const API_PORT = 8911;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const PROMPT =
	"Use the home-widgets tools. Add a small Metric widget titled 'Gold (agent)' " +
	"for series twelve-data:XAU/USD and put it first. Then make the widget titled " +
	"'Watchlist' large. Do not change anything else.";
const DEFAULT_ORDER = [
	"w-vix",
	"w-gold",
	"w-dgs10",
	"w-sp500",
	"w-vix-chart",
	"w-watchlist",
	"w-us-economy",
];

let pristine: PristineCopy | null = null;
let extraRoot = "";
let dataDir = "";
let opencodeDir = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.describe("a real agent arranges the Home widgets (spends plan quota)", () => {
	test.skip(!LIVE, "needs RUN_LIVE_OPENCODE=1 with OPENCODE_MODEL in the environment");

	test.beforeAll(() => {
		if (MODEL === "") {
			throw new Error(
				"RUN_LIVE_OPENCODE=1 requires OPENCODE_MODEL=provider/model in the environment",
			);
		}
		test.setTimeout(300_000);
		pristine = makePristineCopy(REPO_ROOT);
		resources.add(() => pristine?.remove());
		dataDir = mkdtempSync(join(tmpdir(), "research-live-agent-data-"));
		resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
		extraRoot = mkdtempSync(join(tmpdir(), "research-live-agent-extra-"));
		resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
		opencodeDir = mkdtempSync(join(tmpdir(), "research-live-agent-opencode-"));
		resources.add(() => rmSync(opencodeDir, { recursive: true, force: true }));
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
			prodPort: "18989",
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

	function opencodeEnv(): Record<string, string> {
		return { ...baseChildEnv(), OPENCODE_MODEL: MODEL };
	}

	function registerMcpServer(): void {
		if (pristine === null) throw new Error("the pristine copy was not created");
		const added = spawnSync(
			"opencode",
			[
				"mcp",
				"add",
				"home-widgets",
				"--",
				"bun",
				join(pristine.root, "apps", "mcp", "src", "main.ts"),
				"--api",
				API_ORIGIN,
			],
			{ cwd: opencodeDir, env: opencodeEnv(), encoding: "utf8", timeout: 60_000 },
		);
		if (added.status !== 0) {
			throw new Error(`opencode mcp add failed:\n${added.stdout}\n${added.stderr}`);
		}
		if (!existsSync(join(opencodeDir, "opencode.json"))) {
			throw new Error("opencode mcp add wrote no opencode.json in the throwaway directory");
		}
	}

	function runAgent(): Promise<{ status: number | null; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			let child: ChildProcess;
			try {
				child = spawn("opencode", ["run", "--standalone", "--auto", "--model", MODEL, PROMPT], {
					cwd: opencodeDir,
					env: opencodeEnv(),
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (cause) {
				reject(cause instanceof Error ? cause : new Error("opencode run did not start"));
				return;
			}
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
			const timer = setTimeout(() => {
				child.kill("SIGKILL");
				reject(
					new Error(
						`opencode run did not finish within 10 minutes.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
					),
				);
			}, 600_000);
			child.once("error", (cause) => {
				clearTimeout(timer);
				reject(cause);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				resolve({ status: code, stdout, stderr });
			});
		});
	}

	test("the agent adds Gold first and makes Watchlist large, changing nothing else", async ({
		page,
	}) => {
		test.setTimeout(900_000);
		if (pristine === null) throw new Error("the pristine copy was not created");
		const service = await startLauncher({ cwd: pristine.root, args: ["dev"], env: homeEnv() });
		resources.add(async () => {
			await service.stop();
		});
		try {
			const session = await api<{ environment: string }>("GET", "/api/v1/session");
			expect(session.environment).toBe("development");

			registerMcpServer();
			const run = await runAgent();
			if (run.status !== 0) {
				throw new Error(
					`opencode run exited with ${run.status}.\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
				);
			}

			const stored = await api<{
				dashboard: {
					widgets: {
						widgetId: string;
						type: string;
						title: string;
						size: string;
						seriesId?: string;
					}[];
				};
			}>("GET", "/api/v1/home/dashboard");
			const widgets = stored.dashboard.widgets;
			const first = widgets[0];
			if (first === undefined) throw new Error("the stored dashboard is empty");
			expect(first).toMatchObject({
				type: "metric",
				title: "Gold (agent)",
				seriesId: "twelve-data:XAU/USD",
			});
			const watchlist = widgets.find((widget) => widget.title === "Watchlist");
			if (watchlist === undefined) throw new Error("the Watchlist widget is missing");
			expect(watchlist.size).toBe("large");
			const others = widgets
				.map((widget) => widget.widgetId)
				.filter((id) => id !== first.widgetId && id !== watchlist.widgetId);
			expect(others).toEqual(DEFAULT_ORDER.filter((id) => id !== watchlist.widgetId));

			await page.goto(`${VITE_ORIGIN}/#/home`);
			await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
				timeout: 60_000,
			});
			const order = () =>
				page
					.locator("article[data-widget-id]")
					.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-widget-id") ?? ""));
			await expect
				.poll(order, { timeout: 30_000 })
				.toEqual(widgets.map((widget) => widget.widgetId));
			const watchlistSize = await page
				.locator(`article[data-widget-id="${watchlist.widgetId}"]`)
				.getAttribute("data-widget-size");
			expect(watchlistSize).toBe("large");

			const shotsDir = join(REPO_ROOT, "test-results-real");
			mkdirSync(shotsDir, { recursive: true });
			await page.setViewportSize({ width: 1440, height: 900 });
			await page.waitForTimeout(1_000);
			await page.screenshot({
				path: join(shotsDir, "home-agent-live-1440x900.png"),
				fullPage: true,
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await page.waitForTimeout(1_000);
			await page.screenshot({
				path: join(shotsDir, "home-agent-live-390x844.png"),
				fullPage: true,
			});
		} finally {
			await service.stop();
		}
	});
});
