import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
	buildChildEnv,
	suiteRunnerSettings,
	writeTestRunnerEnvFile,
} from "../../scripts/testEnv.ts";
import { E2E_PORT } from "./fixtures.ts";

/**
 * Runner supervision in development (finding 7, task 23b): `node --watch`
 * (and, with RESEARCH_RUNNER=rust, the supervising `scripts/runnerDev.ts`)
 * stays alive when the program it runs exits, so the launcher cannot treat
 * the surviving watch process as health. Readiness means the runner has
 * actually reported to the API after this launch.
 *
 * - A runner that fails at start (an invalid configuration) makes start-up
 *   FAIL with the runner's last error line — never "✔ ready".
 * - A runner that crashes later is reported on the launcher's console at
 *   once (with the crash line), while the launcher keeps running.
 *
 * Runs under Chrome only (see `testIgnore` in `playwright.config.ts`).
 * Ports derive from E2E_PORT like every other spec in this suite.
 */
const VITE_PORT = E2E_PORT - 30;
const API_PORT = E2E_PORT - 31;
const API_ORIGIN = `http://localhost:${API_PORT}`;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The suite's runner (RESEARCH_RUNNER, default `DEFAULT_RUNNER_KIND`): `buildChildEnv` passes it to the launcher. */
const RUNNER = suiteRunnerSettings().RESEARCH_RUNNER === "rust" ? "rust" : "node";

test.describe.configure({ mode: "serial" });

let extraRoot: string;
let dataDir: string;

function childEnv(runnerEnvFile: string): Record<string, string> {
	return buildChildEnv({
		RESEARCH_PORT: String(E2E_PORT - 32),
		RESEARCH_DATA_DIR: join(extraRoot, "prod-data"),
		RESEARCH_DEV_PORT: String(VITE_PORT),
		RESEARCH_DEV_API_PORT: String(API_PORT),
		RESEARCH_DEV_DATA_DIR: dataDir,
		RESEARCH_RELEASE_DIR: join(extraRoot, "release"),
		RESEARCH_PREVIOUS_RELEASE_DIR: join(extraRoot, "release.previous"),
		RESEARCH_RUNNER_ENV_FILE: runnerEnvFile,
		RUNNER_SCRATCH_ROOT: join(extraRoot, "scratch"),
		RESEARCH_WEB_OUT_DIR: join(extraRoot, "web-out"),
	});
}

interface Watched {
	readonly child: ChildProcess;
	output(): string;
}

function spawnDev(runnerEnvFile: string): Watched {
	let output = "";
	const child = spawn("bun", ["run", "dev"], {
		cwd: REPO_ROOT,
		env: childEnv(runnerEnvFile),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const onData = (chunk: Buffer) => {
		output += chunk.toString("utf8");
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	return { child, output: () => output };
}

function stop(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
	child.kill("SIGINT");
	return exited;
}

test.beforeAll(() => {
	extraRoot = mkdtempSync(join(tmpdir(), "research-devfail-extra-"));
	dataDir = mkdtempSync(join(tmpdir(), "research-devfail-data-"));
});

test.afterAll(() => {
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(extraRoot, { recursive: true, force: true });
});

test("a runner that fails at start fails the start-up with its last error line", async () => {
	test.setTimeout(240_000);
	// SEC_USER_AGENT=x is an invalid configuration (too short): the runner
	// logs `invalid_configuration` and never reports. The setting travels in
	// a test-owned env file (finding 5), never the operational `.env`.
	const runnerEnvFile = writeTestRunnerEnvFile(extraRoot, { SEC_USER_AGENT: "x" }, "bad.env");
	const watched = spawnDev(runnerEnvFile);
	const code = await new Promise<number | null>((resolve) => watched.child.once("exit", resolve));
	expect(code, `launcher output:\n${watched.output()}`).not.toBe(0);
	expect(watched.output()).not.toContain("✔ ready");
	expect(watched.output()).toContain("did not report");
	expect(watched.output()).toContain("invalid_configuration");
	// Everything started so far is stopped: the API port is free.
	await expect
		.poll(
			async () =>
				fetch(`${API_ORIGIN}/api/v1/session`).then(
					() => false,
					() => true,
				),
			{
				timeout: 30_000,
			},
		)
		.toBe(true);
});

test("a runner that crashes later is reported at once", async () => {
	test.setTimeout(300_000);
	const runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {}, "good.env");
	const watched = spawnDev(runnerEnvFile);
	try {
		// Wait for the ready block: this runner really reported.
		let ready = false;
		for (let waited = 0; waited < 180_000; waited += 1_000) {
			if (watched.output().includes("stop: Ctrl+C")) {
				ready = true;
				break;
			}
			if (watched.child.exitCode !== null) break;
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		expect(ready, `launcher output:\n${watched.output()}`).toBe(true);
		// Crash the file the watch process runs: the watch process survives, so
		// only the runner-log watcher can report it — at once, on the
		// launcher's console.
		const crashLine = '{"event":"runner_crashed","error":"Error"}';
		if (RUNNER === "rust") {
			// An executable script through a temp file and a rename (the
			// supervisor restarts on a replaced binary).
			const binary = join(dataDir, "runner", "research-runner");
			const swap = `${binary}.e2e-swap`;
			writeFileSync(swap, `#!/bin/sh\nprintf '%s\\n' '${crashLine}' >&2\nexit 1\n`, {
				mode: 0o755,
			});
			renameSync(swap, binary);
		} else {
			const bundle = join(dataDir, "runner", "main.mjs");
			writeFileSync(bundle, `process.stderr.write('${crashLine}\\n');\nprocess.exit(1);\n`);
		}
		let reported = false;
		for (let waited = 0; waited < 60_000; waited += 1_000) {
			if (watched.output().includes("runner_crashed")) {
				reported = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 1_000));
		}
		expect(reported, `launcher output:\n${watched.output()}`).toBe(true);
		// The launcher itself keeps running (the exit is the runner's, and a
		// single crash is not a crash loop).
		expect(watched.child.exitCode).toBeNull();
		expect(readFileSync(join(dataDir, "logs", "runner.log"), "utf8")).toContain("runner_crashed");
	} finally {
		await stop(watched.child);
	}
});
