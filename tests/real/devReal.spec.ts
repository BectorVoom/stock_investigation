import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { suiteRunnerSettings, writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import {
	launcherEnv,
	makePristineCopy,
	type PristineCopy,
	refreshRealFeed,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Development positive path in the real environment network (`bun run
 * test:real`). RESEARCH_RUNNER=node: the development runner runs under Node
 * (its first log line carries `runtime: node`); with the runner switched back
 * to Bun this same refresh fails with every tool call timing out, which is the
 * defect this check guards against. RESEARCH_RUNNER=rust: the Cargo-built
 * binary runs (`runtime: rust`), and an edit to the runner crate's `main.rs`
 * rebuilds incrementally and restarts it. No model quota is spent.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** The suite's runner (RESEARCH_RUNNER, default `DEFAULT_RUNNER_KIND`): `launcherEnv` + `buildChildEnv` pass it on. */
const RUNNER = suiteRunnerSettings().RESEARCH_RUNNER === "rust" ? "rust" : "node";
/** The runner source whose edit must rebuild and restart the runner, and the file the launcher keeps fresh. */
const RUNNER_EDIT_SOURCE =
	RUNNER === "rust" ? "crates/research-runner/src/main.rs" : "apps/runner/src/main.ts";
const RUNNER_ARTIFACT = RUNNER === "rust" ? "research-runner" : "main.mjs";
const VITE_PORT = 8892;
const API_PORT = 8893;
const VITE_ORIGIN = `http://localhost:${VITE_PORT}`;
const API_ORIGIN = `http://localhost:${API_PORT}`;

let pristine: PristineCopy | null = null;
let dataDir = "";
let extraRoot = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-dev-data-"));
	resources.add(() => rmSync(dataDir, { recursive: true, force: true }));
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-dev-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	// Test-owned runner settings (finding 5): the operational
	// `apps/runner/.env` is neither copied nor read.
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
});

test.afterAll(() => resources.close());

/** Fully explicit throwaway environment for the dev launcher (finding 5). */
function devEnv(): Record<string, string> {
	return launcherEnv({
		dataDir: join(extraRoot, "prod-data"),
		devDataDir: dataDir,
		releaseDir: join(extraRoot, "release"),
		previousDir: join(extraRoot, "release.previous"),
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: "18998",
		devPort: String(VITE_PORT),
		devApiPort: String(API_PORT),
	});
}

test(`dev refreshes a real feed with the ${RUNNER} runner, and restarts it on a source edit`, async () => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const pristineRoot = pristine.root;
	const env = devEnv();
	const service = await startLauncher({ cwd: pristineRoot, args: ["dev"], env });
	resources.add(async () => {
		await service.stop();
	});
	try {
		expect(service.output()).toMatch(/agents: /);
		// The node runner runs under Node, not Bun: the pinned HTTPS fetcher only
		// completes there. Its start-up line carries the runtime (the very
		// first line is Node's own "--env-file-if-exists" notice).
		const runnerLog = join(dataDir, "logs", "runner.log");
		const startedLine =
			readFileSync(runnerLog, "utf8")
				.split("\n")
				.find((line) => line.includes("runner_started")) ?? "";
		expect(startedLine).toContain(`"runtime":"${RUNNER}"`);
		expect(startedLine).not.toContain('"runtime":"bun"');

		const session = await (await fetch(`${API_ORIGIN}/api/v1/session`)).json();
		expect(session).toMatchObject({ environment: "development" });

		const refreshed = await refreshRealFeed(API_ORIGIN);
		expect(refreshed.finalState).toBe("completed");
		expect(refreshed.articleCount).toBeGreaterThanOrEqual(1);
		expect(refreshed.lastErrorCode).toBeNull();

		// An edit to a runner source rebuilds the bundle and restarts the
		// runner: the bundle is rewritten and a second start-up line appears.
		const source = join(pristineRoot, RUNNER_EDIT_SOURCE);
		const bundle = join(dataDir, "runner", RUNNER_ARTIFACT);
		const original = readFileSync(source, "utf8");
		const beforeMtime = statSync(bundle).mtimeMs;
		const startsBefore = readFileSync(runnerLog, "utf8").split("runner_started").length;
		writeFileSync(source, `${original}\n// real-environment restart probe\n`);
		try {
			let rebuilt = false;
			for (let waited = 0; waited < 120_000; waited += 1_000) {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				if (statSync(bundle).mtimeMs > beforeMtime) {
					rebuilt = true;
					break;
				}
			}
			expect(rebuilt, "the runner bundle was not rebuilt after a source edit").toBe(true);
			let restarted = false;
			for (let waited = 0; waited < 120_000; waited += 1_000) {
				await new Promise((resolve) => setTimeout(resolve, 1_000));
				if (readFileSync(runnerLog, "utf8").split("runner_started").length > startsBefore) {
					restarted = true;
					break;
				}
			}
			expect(restarted, "the runner did not restart after its bundle was rebuilt").toBe(true);
		} finally {
			writeFileSync(source, original);
		}
		// The SPA is served by Vite, not a built bundle.
		const html = await (await fetch(`${VITE_ORIGIN}/`)).text();
		expect(html).toContain("/@vite/client");
	} finally {
		await service.stop();
	}
});
