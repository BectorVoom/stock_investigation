import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { buildChildEnv, writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { E2E_PORT } from "./fixtures.ts";

/**
 * Development on this PC (`bun run dev`, ADR-0011): the working tree, live —
 * Vite hot module replacement for the SPA, the API with reload on change, the
 * runner rebuilt from source on change into the data directory and run under
 * `node --watch` (never Bun: the pinned HTTPS fetcher hangs there) — against
 * its own ports and a throwaway data directory, so development can never
 * change what production serves. Ports derive from E2E_PORT like every other
 * spec in this suite, offset clear of the owner's own `bun run dev` (3000 and
 * 8788) and `bun run prod` (8787), which may be running at the same time.
 */
const VITE_PORT = E2E_PORT - 20;
const API_PORT = E2E_PORT - 21;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

test.describe.configure({ mode: "serial" });

let dataDir: string;
let extraRoot: string;
let launcher: ChildProcess | null = null;
let output = "";

function start(): Promise<void> {
	output = "";
	const child = spawn("bun", ["run", "dev"], {
		cwd: REPO_ROOT,
		// Fully explicit throwaway environment (finding 5): every path and
		// port the launcher or runner reads is set here, and the operational
		// `apps/runner/.env` is never read.
		env: buildChildEnv({
			RESEARCH_PORT: "18992",
			RESEARCH_DATA_DIR: join(extraRoot, "prod-data"),
			RESEARCH_DEV_PORT: String(VITE_PORT),
			RESEARCH_DEV_API_PORT: String(API_PORT),
			RESEARCH_DEV_DATA_DIR: dataDir,
			RESEARCH_RELEASE_DIR: join(extraRoot, "release"),
			RESEARCH_PREVIOUS_RELEASE_DIR: join(extraRoot, "release.previous"),
			RESEARCH_RUNNER_ENV_FILE: join(extraRoot, "test-runner.env"),
			RUNNER_SCRATCH_ROOT: join(extraRoot, "scratch"),
			RESEARCH_WEB_OUT_DIR: join(extraRoot, "web-out"),
		}),
		stdio: ["ignore", "pipe", "pipe"],
	});
	launcher = child;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`dev launcher did not become ready in time:\n${output}`)),
			180_000,
		);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.includes("stop: Ctrl+C")) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`dev launcher exited with ${code}:\n${output}`));
		});
	});
}

function stop(): Promise<number | null> {
	const child = launcher;
	launcher = null;
	if (child === null || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null);
	const exited = new Promise<number | null>((resolve) =>
		child.once("exit", (code) => resolve(code)),
	);
	child.kill("SIGINT");
	return exited;
}

test.beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "research-dev-"));
	extraRoot = mkdtempSync(join(tmpdir(), "research-dev-extra-"));
	// Test-owned runner settings (finding 5): the operational
	// `apps/runner/.env` is never read by a test launcher.
	writeTestRunnerEnvFile(extraRoot, {}, "test-runner.env");
});

test.afterAll(async () => {
	await stop();
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(extraRoot, { recursive: true, force: true });
});

test("development serves the SPA from Vite and reports the development environment", async ({
	request,
}) => {
	test.setTimeout(180_000);
	await start();
	// The document is served by the Vite dev server, not a built bundle.
	const html = await (await request.get(`${VITE_ORIGIN}/`)).text();
	expect(html).toContain("/@vite/client");
	// The session reports development both through the Vite /api proxy and directly.
	for (const base of [VITE_ORIGIN, API_ORIGIN]) {
		const session = await (await request.get(`${base}/api/v1/session`)).json();
		expect(session).toMatchObject({ ownerId: "owner@localhost", environment: "development" });
	}
});

test("the header shows the Development badge", async ({ page }) => {
	await page.goto(VITE_ORIGIN);
	await expect(page.getByRole("heading", { level: 1, name: "Research workspace" })).toBeVisible();
	await expect(page.locator('[data-field="session-summary"]')).toContainText("owner@localhost");
	const badge = page.locator('[data-field="environment-badge"]');
	await expect(badge).toBeVisible();
	await expect(badge).toContainText("Development");
});

test("the runner runs under Node and restarts when its bundle is rebuilt", async () => {
	test.setTimeout(180_000);
	const runnerLog = join(dataDir, "logs", "runner.log");
	const bundle = join(dataDir, "runner", "main.mjs");
	// The runner's start-up line carries its runtime: Node, never Bun (the
	// pinned HTTPS fetcher hangs under Bun's Node compatibility layer). The
	// very first line is Node's own "--env-file-if-exists" notice.
	const startedLine =
		readFileSync(runnerLog, "utf8")
			.split("\n")
			.find((line) => line.includes("runner_started")) ?? "";
	expect(startedLine).toContain('"runtime":"node"');
	expect(startedLine).not.toContain('"runtime":"bun"');
	// Rewriting the bundle (what the watching rebuild does after a source
	// edit) restarts the runner under `node --watch`: a second start-up line
	// appears. The bundle itself lives in the throwaway data directory, so
	// no tracked file is touched.
	const startsBefore = readFileSync(runnerLog, "utf8").split("runner_started").length;
	const beforeMtime = statSync(bundle).mtimeMs;
	writeFileSync(bundle, `${readFileSync(bundle, "utf8")}\n`);
	expect(statSync(bundle).mtimeMs).toBeGreaterThanOrEqual(beforeMtime);
	let restarted = false;
	for (let waited = 0; waited < 60_000; waited += 1_000) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		if (readFileSync(runnerLog, "utf8").split("runner_started").length > startsBefore) {
			restarted = true;
			break;
		}
	}
	expect(restarted, "the runner did not restart after its bundle was rebuilt").toBe(true);
});

test("a file the dev server serves is picked up without a page navigation", async ({ page }) => {
	// A THROWAWAY module under a git-ignored path (removed afterwards): never a
	// tracked source file. Vite serves public/ live, so rewriting it is visible
	// immediately — the same path hot module replacement takes. (Full HMR of an
	// edited component, the API reload and the runner restart were additionally
	// verified by hand; see ADR-0011.)
	const name = `__e2e_hot_${process.pid}.txt`;
	const file = join(REPO_ROOT, "apps/web/public", name);
	const inPage = (path: string) =>
		page.evaluate((url) => fetch(url).then((response) => response.text()), path);
	await page.goto(VITE_ORIGIN);
	const urlBefore = page.url();
	try {
		writeFileSync(file, "marker-one\n");
		await expect.poll(() => inPage(`/${name}`), { timeout: 15_000 }).toBe("marker-one\n");
		writeFileSync(file, "marker-two\n");
		await expect.poll(() => inPage(`/${name}`), { timeout: 15_000 }).toBe("marker-two\n");
	} finally {
		rmSync(file, { force: true });
	}
	// No navigation happened between the two reads: the update arrived live.
	expect(page.url()).toBe(urlBefore);
});
