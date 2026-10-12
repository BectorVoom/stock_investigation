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
