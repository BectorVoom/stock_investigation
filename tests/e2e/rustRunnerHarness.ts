/**
 * Thin wrapper around the Rust E2E runner (ADR-0030, rr-spec-shell-wire
 * section 10.2): issues the runner credential exactly as the Node harness
 * does, builds `research-runner-e2e` once (skipped while the binaries are
 * newer than every source file), spawns it, forwards SIGINT/SIGTERM and exits
 * with its status. The binary carries the E2E seams (scripted agent through
 * the FR-013 stdio wrapper, fixture fetchers, scripted Google, owner header);
 * production builds cannot reach them (`tests/architecture/rustBoundaries.test.ts`).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoTargetDirFromEnv } from "../../scripts/launchPlan.ts";
import { baseChildEnv } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN } from "./fixtures.ts";
import { issueToken, RUNNER_OWNER } from "./runnerToken.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
const E2E_BINARY = "research-runner-e2e";
/** The stdio trampoline the runner starts agent CLIs (here: the scripted agent) through. */
const SPAWN_HELPER = "research-provider-spawn";

const targetDir = cargoTargetDirFromEnv(process.env, REPO_ROOT);
const binaries = [E2E_BINARY, SPAWN_HELPER].map((name) => join(targetDir, "debug", name));

/** Newest modification time among Rust sources and manifests (target directories skipped). */
function newestSourceMs(directory: string): number {
	let newest = 0;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "target") newest = Math.max(newest, newestSourceMs(path));
		} else if (entry.name.endsWith(".rs") || entry.name === "Cargo.toml") {
			newest = Math.max(newest, statSync(path).mtimeMs);
		}
	}
	return newest;
}

function upToDate(): boolean {
	if (!binaries.every((binary) => existsSync(binary))) return false;
	const oldestBinary = Math.min(...binaries.map((binary) => statSync(binary).mtimeMs));
	const newestSource = Math.max(
		newestSourceMs(join(REPO_ROOT, "crates")),
		statSync(join(REPO_ROOT, "Cargo.toml")).mtimeMs,
		statSync(join(REPO_ROOT, "Cargo.lock")).mtimeMs,
	);
	return oldestBinary > newestSource;
}

/** Builds the E2E runner and its spawn helper into the shared target directory. */
function build(): void {
	if (upToDate()) return;
	const result = spawnSync(
		"cargo",
		[
			"build",
			"--locked",
			"--offline",
			"-p",
			"research-runner-testkit",
			"-p",
			"research-runner",
			"--bin",
			E2E_BINARY,
			"--bin",
			SPAWN_HELPER,
		],
		{
			cwd: REPO_ROOT,
			env: { ...baseChildEnv(), CARGO_TARGET_DIR: targetDir },
			// Build output must not reach the Playwright list reporter's stdout.
			stdio: ["ignore", process.stderr, process.stderr],
		},
	);
	if (result.status !== 0) {
		throw new Error(`building ${E2E_BINARY} failed (status ${result.status ?? "signal"})`);
	}
}

build();
const token = await issueToken();
const [runnerBinary] = binaries;
if (runnerBinary === undefined) throw new Error("no runner binary configured");
const child = spawn(runnerBinary, [], {
	cwd: REPO_ROOT,
	env: {
		...baseChildEnv(),
		RESEARCH_API_URL: E2E_ORIGIN,
		RUNNER_TOKEN: token,
		// Fixture and flag-file paths (tests/e2e/fixtures, test-results/) resolve from here.
		E2E_REPO_ROOT: REPO_ROOT,
		...(RUNNER_OWNER === null ? {} : { E2E_RUNNER_OWNER: RUNNER_OWNER }),
		...(process.env.RUN_LIVE_OPENCODE === undefined
			? {}
			: { RUN_LIVE_OPENCODE: process.env.RUN_LIVE_OPENCODE }),
		...(process.env.OPENCODE_MODEL === undefined
			? {}
			: { OPENCODE_MODEL: process.env.OPENCODE_MODEL }),
	},
	stdio: ["ignore", "inherit", "inherit"],
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => child.kill(signal));
child.once("exit", (code) => {
	process.exit(code ?? 1);
});
