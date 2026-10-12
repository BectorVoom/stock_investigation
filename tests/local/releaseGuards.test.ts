import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildChildEnv } from "../../scripts/testEnv.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROD_BUILD = join(REPO_ROOT, "scripts/prodBuild.ts");
const PROD_ROLLBACK = join(REPO_ROOT, "scripts/prodRollback.ts");
const PROD_START = join(REPO_ROOT, "scripts/prodStart.ts");

/**
 * Command-level guards for findings 1 and 2: the refusals live in the real
 * entries (`prod:build`, `prod:rollback`, `prod:start`), run against a fake
 * repository root in the OS temp directory, and fail before any write — so
 * each case runs in about a second with no build and no server.
 */
let root = "";

afterEach(() => {
	if (root !== "") {
		// Adopted generations are read-only: make the tree writable first.
		try {
			const walk = (dir: string): void => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const full = join(dir, entry.name);
					if (entry.isDirectory()) walk(full);
					try {
						chmodSync(full, statSync(full).isDirectory() ? 0o755 : 0o644);
					} catch {
						// Best effort; the rm below reports the real failure.
					}
				}
			};
			walk(root);
		} catch {
			// Best effort.
		}
		rmSync(root, { recursive: true, force: true });
	}
	root = "";
});

function fakeRepo(): string {
	root = mkdtempSync(join(tmpdir(), "research-guards-"));
	return root;
}

function runScript(
	script: string,
	cwd: string,
	env: Record<string, string>,
): { status: number | null; output: string } {
	const result = spawnSync("bun", [script], {
		cwd,
		// Isolated by construction (finding 5): the allowlist plus the
		// case's throwaway values, never the caller's environment.
		env: buildChildEnv(env),
		encoding: "utf8",
		timeout: 60_000,
	});
	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

/**
 * Fills the settings a case does not care about with throwaway values under
 * the fake root, so every spawn carries the full explicit environment.
 */
function fullEnv(repo: string, partial: Record<string, string>): Record<string, string> {
	return {
		RESEARCH_PORT: "18991",
		RESEARCH_DEV_PORT: "18990",
		RESEARCH_DEV_API_PORT: "18989",
		RESEARCH_RUNNER_ENV_FILE: join(repo, "test-runner.env"),
		RUNNER_SCRATCH_ROOT: join(repo, "scratch"),
		RESEARCH_WEB_OUT_DIR: join(repo, "web-out"),
		...partial,
	};
}

function legacyManifest(): string {
	return JSON.stringify({
		builtAt: "2026-10-11T00:00:00.000Z",
		revision: null,
		versions: { bun: "1.3.0", node: "v23.6.0" },
	});
}

describe("prod:build refuses dangerous directories before any write (finding 2)", () => {
	it("RESEARCH_PREVIOUS_RELEASE_DIR=data refuses and leaves production data alone", () => {
		const repo = fakeRepo();
		mkdirSync(join(repo, "data"), { recursive: true });
		writeFileSync(join(repo, "data", "sentinel"), "production");
		const result = runScript(
			PROD_BUILD,
			repo,
			fullEnv(repo, {
				RESEARCH_DATA_DIR: "data",
				RESEARCH_DEV_DATA_DIR: "data-dev",
				RESEARCH_RELEASE_DIR: "release",
				RESEARCH_PREVIOUS_RELEASE_DIR: "data",
			}),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("previous release directory");
		expect(result.output).toContain("production data directory");
		expect(readFileSync(join(repo, "data", "sentinel"), "utf8")).toBe("production");
		expect(existsSync(join(repo, "release"))).toBe(false);
	});

	it("both release settings naming one directory refuses", () => {
		const repo = fakeRepo();
		mkdirSync(join(repo, "shared"), { recursive: true });
		writeFileSync(join(repo, "shared", "manifest.json"), legacyManifest());
		const result = runScript(
			PROD_BUILD,
			repo,
			fullEnv(repo, {
				RESEARCH_DATA_DIR: "data",
				RESEARCH_DEV_DATA_DIR: "data-dev",
				RESEARCH_RELEASE_DIR: "shared",
				RESEARCH_PREVIOUS_RELEASE_DIR: "shared",
			}),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("resolve to the same directory");
		// The almost-deleted release is still there.
		expect(existsSync(join(repo, "shared", "manifest.json"))).toBe(true);
	});

	it("a symlinked development data directory refuses (finding 1)", () => {
		const repo = fakeRepo();
		mkdirSync(join(repo, "data"), { recursive: true });
		writeFileSync(join(repo, "data", "sentinel"), "production");
		symlinkSync(join(repo, "data"), join(repo, "dev-link"));
		const result = runScript(
			PROD_BUILD,
			repo,
			fullEnv(repo, {
				RESEARCH_DATA_DIR: "data",
				RESEARCH_DEV_DATA_DIR: "dev-link",
				RESEARCH_RELEASE_DIR: "release",
				RESEARCH_PREVIOUS_RELEASE_DIR: "release.previous",
			}),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("data");
		expect(result.output).toContain("dev-link");
		expect(readFileSync(join(repo, "data", "sentinel"), "utf8")).toBe("production");
	});
});

describe("prod:rollback validates before touching the pointer (findings 2, 4)", () => {
	it("refuses when the release settings collide", () => {
		const repo = fakeRepo();
		const result = runScript(
			PROD_ROLLBACK,
			repo,
			fullEnv(repo, {
				RESEARCH_DATA_DIR: "data",
				RESEARCH_DEV_DATA_DIR: "data-dev",
				RESEARCH_RELEASE_DIR: "shared",
				RESEARCH_PREVIOUS_RELEASE_DIR: "shared",
			}),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("resolve to the same directory");
	});
});

describe("prod:start refuses overlapping data directories before any write (finding 1)", () => {
	it("a symlinked development directory never gets migrated or logged into", () => {
		const repo = fakeRepo();
		mkdirSync(join(repo, "data"), { recursive: true });
		writeFileSync(join(repo, "data", "sentinel"), "production");
		symlinkSync(join(repo, "data"), join(repo, "dev-link"));
		const result = runScript(
			PROD_START,
			repo,
			fullEnv(repo, {
				RESEARCH_PORT: "18999",
				RESEARCH_DATA_DIR: "data",
				RESEARCH_DEV_DATA_DIR: "dev-link",
				RESEARCH_RELEASE_DIR: "release",
				RESEARCH_PREVIOUS_RELEASE_DIR: "release.previous",
			}),
		);
		expect(result.status).toBe(2);
		expect(result.output).toContain("data");
		expect(result.output).toContain("dev-link");
		// Before ANY write: no state, no logs, no credential beside the sentinel.
		expect(readdirSync(join(repo, "data"))).toEqual(["sentinel"]);
	});
});

describe("prod:build migrates an old-layout release instead of destroying it (finding 3)", () => {
	it("adopts the release and its previous into generations", () => {
		const repo = fakeRepo();
		// The migration records the working tree's migrations: plant the real set.
		mkdirSync(join(repo, "infra", "migrations"), { recursive: true });
		for (const name of readdirSync(join(REPO_ROOT, "infra", "migrations"))) {
			writeFileSync(
				join(repo, "infra", "migrations", name),
				readFileSync(join(REPO_ROOT, "infra", "migrations", name)),
			);
		}
		const area = join(repo, "release");
		const previous = join(repo, "previous");
		for (const [dir, page] of [
			[area, "<html>current</html>"],
			[previous, "<html>previous</html>"],
		] as const) {
			mkdirSync(join(dir, "web"), { recursive: true });
			mkdirSync(join(dir, "worker"), { recursive: true });
			mkdirSync(join(dir, "runner"), { recursive: true });
			writeFileSync(join(dir, "web", "index.html"), page);
			writeFileSync(join(dir, "worker", "worker.js"), "worker");
			writeFileSync(join(dir, "runner", "main.mjs"), "runner");
			writeFileSync(join(dir, "wrangler.jsonc"), "{}");
			writeFileSync(join(dir, "manifest.json"), legacyManifest());
		}
		// The entry checks its tools exist before doing anything: plant
		// stand-ins (the spa hook below fires before they could ever run).
		mkdirSync(join(repo, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(repo, "node_modules", ".bin", "wrangler"), "");
		writeFileSync(join(repo, "node_modules", ".bin", "vite"), "");
		// Fail right after the migration: no build runs, but adoption did.
		const result = runScript(
			PROD_BUILD,
			repo,
			fullEnv(repo, {
				RESEARCH_DATA_DIR: "data",
				RESEARCH_DEV_DATA_DIR: "data-dev",
				RESEARCH_RELEASE_DIR: "release",
				RESEARCH_PREVIOUS_RELEASE_DIR: "previous",
				RESEARCH_BUILD_FAIL_AT: "spa",
			}),
		);
		expect(result.status).toBe(1);
		expect(result.output).toContain("adopted the old-layout release");
		const generations = readdirSync(join(area, "generations")).sort();
		expect(generations).toHaveLength(2);
		const previousId = generations.find((id) => id.startsWith("migrated-previous-"));
		const currentId = generations.find((id) => id.startsWith("migrated-current-"));
		expect(previousId).toBeDefined();
		expect(currentId).toBeDefined();
		if (previousId === undefined || currentId === undefined) return;
		const pointer: unknown = JSON.parse(readFileSync(join(area, "current.json"), "utf8"));
		expect(pointer).toMatchObject({ active: currentId });
		// Content preserved; the legacy manifests are gone from the roots.
		const pages = [previousId, currentId].map((id) =>
			readFileSync(join(area, "generations", id, "web", "index.html"), "utf8"),
		);
		expect(pages.sort()).toEqual(["<html>current</html>", "<html>previous</html>"]);
		expect(existsSync(join(area, "manifest.json"))).toBe(false);
		expect(existsSync(previous)).toBe(false);
	});
});
