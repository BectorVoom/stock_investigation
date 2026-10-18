import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ALL_TEST_CONTROLLED_VARS,
	buildChildEnv,
	INHERITED_ENV_ALLOWLIST,
	newTestDirs,
	suiteRunnerSettings,
	writeTestRunnerEnvFile,
} from "../../scripts/testEnv.ts";

/**
 * Finding 5 (task 23b): suites construct child environments from an explicit
 * allowlist plus their own throwaway values — never `{ ...process.env }`.
 * This test poisons the parent environment with hostile values for every
 * variable in the list and asserts none reaches a child, through the helper
 * and through a real spawned process.
 */
const HOSTILE_DIR = "/repo/data";
const saved = new Map<string, string | undefined>();

function poisonParent(): void {
	saved.clear();
	for (const name of ALL_TEST_CONTROLLED_VARS) {
		saved.set(name, process.env[name]);
		process.env[name] = name.includes("PORT") ? "8787" : HOSTILE_DIR;
	}
	// The exact cases from the finding: job directories inside production
	// data, and Vite emptying the production asset directory.
	process.env.RUNNER_SCRATCH_ROOT = "/repo/data";
	process.env.RESEARCH_WEB_OUT_DIR = "/repo/release/web";
	process.env.RESEARCH_DATA_DIR = "/repo/data";
	process.env.RESEARCH_DEV_DATA_DIR = "/repo/data";
	process.env.RESEARCH_RELEASE_DIR = "/repo/release";
}

afterEach(() => {
	for (const [name, value] of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	saved.clear();
});

function throwaway(): Record<string, string> {
	const dirs = newTestDirs("research-testenv-");
	return {
		RESEARCH_DATA_DIR: dirs.dataDir,
		RESEARCH_DEV_DATA_DIR: dirs.devDataDir,
		RESEARCH_RELEASE_DIR: dirs.releaseDir,
		RESEARCH_PREVIOUS_RELEASE_DIR: dirs.previousDir,
		RESEARCH_RUNNER_ENV_FILE: dirs.runnerEnvFile,
		RUNNER_SCRATCH_ROOT: dirs.scratchRoot,
		RESEARCH_WEB_OUT_DIR: dirs.webOutDir,
		RESEARCH_PORT: "18901",
		RESEARCH_DEV_PORT: "18902",
		RESEARCH_DEV_API_PORT: "18903",
	};
}

describe("test child environments are isolated by construction (finding 5)", () => {
	it("never inherits allowlisted names and requires every path and port", () => {
		for (const name of ALL_TEST_CONTROLLED_VARS) {
			expect(INHERITED_ENV_ALLOWLIST).not.toContain(name);
		}
		expect(() => buildChildEnv({})).toThrow(/missing explicit values/);
		expect(() => buildChildEnv({ ...throwaway(), RESEARCH_DATA_DIR: "" })).toThrow(
			/missing explicit values/,
		);
	});

	it("keeps hostile parent values out of the built environment", () => {
		poisonParent();
		const values = throwaway();
		const child = buildChildEnv(values);
		for (const [name, value] of Object.entries(values)) {
			expect(child[name]).toBe(value);
		}
		expect(child.RUNNER_SCRATCH_ROOT).not.toBe("/repo/data");
		expect(child.RESEARCH_WEB_OUT_DIR).not.toBe("/repo/release/web");
		// Nothing else test-controlled leaks through the allowlist either.
		for (const name of ALL_TEST_CONTROLLED_VARS) {
			if (values[name] === undefined) expect(child[name]).toBeUndefined();
		}
		expect(child.WRANGLER_SEND_METRICS).toBe("false");
	});

	it("keeps hostile parent values out of a real spawned child", () => {
		poisonParent();
		const values = throwaway();
		const child = buildChildEnv(values);
		const probe = spawnSync(
			process.execPath,
			[
				"-e",
				`console.log(JSON.stringify(${JSON.stringify(ALL_TEST_CONTROLLED_VARS)}.map((name) => [name, process.env[name] ?? null])))`,
			],
			{ env: child, encoding: "utf8" },
		);
		expect(probe.status).toBe(0);
		const seen = new Map<string, string | null>(
			JSON.parse(probe.stdout) as [string, string | null][],
		);
		for (const [name, expected] of Object.entries(values)) {
			expect(seen.get(name)).toBe(expected);
		}
		for (const name of ALL_TEST_CONTROLLED_VARS) {
			if (values[name] === undefined) {
				expect(seen.get(name)).toBeNull();
			}
		}
	});

	it("writes a test-owned runner env file instead of reading the operational one", () => {
		const dir = mkdtempSync(join(tmpdir(), "research-testenv-runner-"));
		const file = writeTestRunnerEnvFile(dir, { SEC_USER_AGENT: "test-suite contact" });
		expect(file.startsWith(dir)).toBe(true);
		expect(file).not.toContain("apps/runner/.env");
		const empty = writeTestRunnerEnvFile(dir, {}, "empty.env");
		const child = buildChildEnv({ ...throwaway(), RESEARCH_RUNNER_ENV_FILE: empty });
		expect(child.RESEARCH_RUNNER_ENV_FILE).toBe(empty);
	});
});

describe("the Rust toolchain in the isolated environment (ADR-0030)", () => {
	const touched = ["RESEARCH_RUNNER", "RESEARCH_CARGO_TARGET_DIR", "RUSTFLAGS", "CARGO_BUILD_JOBS"];
	const before = new Map<string, string | undefined>();

	afterEach(() => {
		for (const [name, value] of before) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		before.clear();
	});

	function remember(): void {
		for (const name of touched) before.set(name, process.env[name]);
	}

	it("inherits the toolchain plumbing but never compiler flags or build settings", () => {
		for (const name of ["CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN"]) {
			expect(INHERITED_ENV_ALLOWLIST).toContain(name);
		}
		for (const name of ["RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "RUSTC_WRAPPER"]) {
			expect(INHERITED_ENV_ALLOWLIST).not.toContain(name);
		}
		expect(INHERITED_ENV_ALLOWLIST.some((name) => name.startsWith("CARGO_BUILD_"))).toBe(false);
		remember();
		process.env.RUSTFLAGS = "--cfg test_seams";
		process.env.CARGO_BUILD_JOBS = "1";
		const child = buildChildEnv(throwaway());
		expect(child.RUSTFLAGS).toBeUndefined();
		expect(child.CARGO_BUILD_JOBS).toBeUndefined();
	});

	it("defaults to the rust runner and the repository target directory", () => {
		remember();
		delete process.env.RESEARCH_RUNNER;
		delete process.env.RESEARCH_CARGO_TARGET_DIR;
		const settings = suiteRunnerSettings();
		expect(settings.RESEARCH_RUNNER).toBe("rust");
		expect(settings.RESEARCH_CARGO_TARGET_DIR).toMatch(/[\\/]target$/);
		expect(buildChildEnv(throwaway()).RESEARCH_RUNNER).toBe("rust");
	});

	it("passes the suite's runner choice and shared target directory explicitly", () => {
		remember();
		process.env.RESEARCH_RUNNER = "rust";
		process.env.RESEARCH_CARGO_TARGET_DIR = "/shared/cache";
		const child = buildChildEnv(throwaway());
		expect(child.RESEARCH_RUNNER).toBe("rust");
		expect(child.RESEARCH_CARGO_TARGET_DIR).toBe("/shared/cache");
	});

	it("passes RESEARCH_RUNNER=node through as the rollback", () => {
		remember();
		process.env.RESEARCH_RUNNER = "node";
		expect(buildChildEnv(throwaway()).RESEARCH_RUNNER).toBe("node");
	});

	it("refuses an unknown runner instead of silently testing node", () => {
		remember();
		process.env.RESEARCH_RUNNER = "rsut";
		expect(() => buildChildEnv(throwaway())).toThrow(/RESEARCH_RUNNER/);
	});
});
