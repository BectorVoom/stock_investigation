/**
 * Test isolation by construction (finding 5, task 23b). Every suite that
 * starts a launcher, a runner or a build (`test:e2e`, `test:real`,
 * `review:ui`, the launcher unit tests) builds its child environment through
 * THIS module — never `{ ...process.env, ...overrides }` — and sets EVERY
 * path-valued setting itself. A child therefore cannot inherit a hostile or
 * operational path from the caller's environment or from `apps/runner/.env`.
 *
 * The enumeration below is the complete list of path/port/origin settings
 * the launcher or runner reads, gathered from the code (ARCH-014):
 * - `scripts/launchPlan.ts`: RESEARCH_PORT, RESEARCH_DATA_DIR,
 *   RESEARCH_DEV_PORT, RESEARCH_DEV_API_PORT, RESEARCH_DEV_DATA_DIR,
 *   RESEARCH_RELEASE_DIR, RESEARCH_PREVIOUS_RELEASE_DIR,
 *   RESEARCH_RUNNER_ENV_FILE (RUNNER_ENV_FILE default `apps/runner/.env`),
 *   RESEARCH_RUNNER (node|rust, default node) and RESEARCH_CARGO_TARGET_DIR
 *   (shared Cargo build cache; see `suiteRunnerSettings`);
 *   the plan sets RESEARCH_API_URL, RUNNER_PAGES_DIR and
 *   RESEARCH_DEV_API_PORT on its children itself.
 * - `apps/runner/src/config.ts`: RESEARCH_API_URL, RUNNER_TOKEN,
 *   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET, SEC_USER_AGENT,
 *   ALLOW_UNVERIFIED_TOOL_ISOLATION, RUNNER_SCRATCH_ROOT, RUNNER_PAGES_DIR,
 *   FRED_API_KEY, TWELVE_DATA_API_KEY, TWELVE_DATA_REQUESTS_PER_MINUTE.
 * - `apps/web/vite.config.ts`: RESEARCH_DEV_API_PORT (proxy target),
 *   RESEARCH_WEB_OUT_DIR (build output, default `dist/web`).
 * - `scripts/launch.ts`: WRANGLER_SEND_METRICS (forced `false` here).
 * - `scripts/releaseOps.ts`: RESEARCH_ALLOW_NEWER_DB, RESEARCH_RELEASE_MARKER,
 *   RESEARCH_BUILD_FAIL_AT (behaviour switches, set explicitly per test).
 * - `tests/real/helpers.ts`: RESEARCH_REAL_FEED_URL (network input, not a path).
 *
 * Operational `.env` files are never copied or read by a test: the pristine
 * copy excludes `apps/runner/.env`, and suites point RESEARCH_RUNNER_ENV_FILE
 * at a file they wrote themselves (or a path that does not exist). A test
 * that needs runner settings (e.g. the live test's model choice travels in
 * the environment the agent runtimes inherit) writes its own file with
 * `writeTestRunnerEnvFile` and passes every other setting explicitly.
 */
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CARGO_TARGET_DIR_ENV_VAR,
	cargoTargetDirFromEnv,
	parseRunnerKind,
	RUNNER_KIND_ENV_VAR,
} from "./launchPlan.ts";

/**
 * Ambient variables a child may inherit. WHY only these: everything the
 * launcher or runner writes (directories, ports, credentials, model choice)
 * is set explicitly per suite; what remains is process plumbing (PATH so
 * `bun`/`node`/`wrangler` resolve, HOME for tool caches, locale/timezone).
 * In particular no `RESEARCH_*`, `RUNNER_*`, `SEC_*`, `OPENCODE_*`,
 * `OPENROUTER_*`, `FRED_*`, `TWELVE_DATA_*`, `CF_ACCESS_*`, `E2E_*`,
 * `REVIEW_*` or `BUN_*`/`NODE_*` variable is ever inherited. Windows needs its system variables to spawn
 * anything, so they are included there only.
 */
/**
 * Rust toolchain plumbing, like PATH/HOME: where rustup and Cargo keep their
 * toolchains and registry cache, and which toolchain a shim picks. Without
 * them `cargo` cannot run under the allowlist (ADR-0030). RUSTFLAGS and
 * CARGO_BUILD_* are deliberately NOT here: they could enable test seams or
 * change code generation, so a caller's values never reach a build.
 */
const RUST_TOOLCHAIN_PLUMBING = ["CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN"] as const;

export const INHERITED_ENV_ALLOWLIST: readonly string[] =
	process.platform === "win32"
		? [
				"PATH",
				"HOME",
				"LANG",
				"LC_ALL",
				"LC_MESSAGES",
				"TZ",
				"SystemRoot",
				"SystemDrive",
				"PATHEXT",
				"COMSPEC",
				"TEMP",
				"TMP",
				...RUST_TOOLCHAIN_PLUMBING,
			]
		: ["PATH", "HOME", "LANG", "LC_ALL", "LC_MESSAGES", "TZ", ...RUST_TOOLCHAIN_PLUMBING];

/** Every directory a launcher run writes: all must be explicit throwaway values. */
export const REQUIRED_PATH_SETTINGS = [
	"RESEARCH_DATA_DIR",
	"RESEARCH_DEV_DATA_DIR",
	"RESEARCH_RELEASE_DIR",
	"RESEARCH_PREVIOUS_RELEASE_DIR",
	"RESEARCH_RUNNER_ENV_FILE",
	"RUNNER_SCRATCH_ROOT",
	"RESEARCH_WEB_OUT_DIR",
] as const;

/** Every port a launcher run listens on: all must be explicit test ports. */
export const REQUIRED_PORT_SETTINGS = [
	"RESEARCH_PORT",
	"RESEARCH_DEV_PORT",
	"RESEARCH_DEV_API_PORT",
] as const;

/** Runner identity and network settings: never inherited, set explicitly or absent. */
export const RUNNER_BEHAVIOR_SETTINGS = [
	"RESEARCH_API_URL",
	"RUNNER_TOKEN",
	"RUNNER_PAGES_DIR",
	"CF_ACCESS_CLIENT_ID",
	"CF_ACCESS_CLIENT_SECRET",
	"SEC_USER_AGENT",
	"ALLOW_UNVERIFIED_TOOL_ISOLATION",
	"OPENCODE_MODEL",
	"OPENROUTER_API_KEY",
	"OPENROUTER_MODEL",
	"OPENROUTER_FREE_MODEL",
	"FRED_API_KEY",
	"TWELVE_DATA_API_KEY",
	"TWELVE_DATA_REQUESTS_PER_MINUTE",
] as const;

/** Release behaviour switches: set explicitly per test, never inherited. */
export const RELEASE_CONTROL_SETTINGS = [
	"RESEARCH_ALLOW_NEWER_DB",
	"RESEARCH_RELEASE_MARKER",
	"RESEARCH_BUILD_FAIL_AT",
] as const;

/**
 * Everything a hostile parent environment could use to redirect a suite:
 * the hostile-parent regression test (`tests/local/testEnv.test.ts`) sets
 * each of these to an operational path and asserts none reaches a child.
 */
export const ALL_TEST_CONTROLLED_VARS: readonly string[] = [
	...REQUIRED_PATH_SETTINGS,
	...REQUIRED_PORT_SETTINGS,
	...RUNNER_BEHAVIOR_SETTINGS,
	...RELEASE_CONTROL_SETTINGS,
];

/**
 * The repository the suites run from (this file is `scripts/testEnv.ts`):
 * the default home of the shared Cargo target directory.
 */
const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * The runner choice and the Cargo build cache of a suite. Both are explicit
 * suite selectors, not inherited ambient state: `RESEARCH_RUNNER` (node by
 * default, `rust` to exercise the Rust runner) is read from the test process's
 * own environment and validated; a pristine copy builds into the SAME
 * `RESEARCH_CARGO_TARGET_DIR` (default `<repo>/target`), because that is a
 * build cache, not operational data — registry dependencies compile once and
 * workspace crates from other source paths get distinct artifact hashes.
 * Throws on an unknown runner kind, so a typo can never silently test node.
 */
export function suiteRunnerSettings(): Record<string, string> {
	const kind = parseRunnerKind(process.env[RUNNER_KIND_ENV_VAR]);
	if (!kind.ok) throw new Error(`test isolation: ${kind.error.message}`);
	return {
		[RUNNER_KIND_ENV_VAR]: kind.value,
		[CARGO_TARGET_DIR_ENV_VAR]: cargoTargetDirFromEnv(process.env, REPOSITORY_ROOT),
	};
}

/** Where a suite recorded the directories it configured (finding 15 guard audit). */
export const ISOLATION_RECORD_ENV_VAR = "TEST_ISOLATION_RECORD";

function pickInheritedEnv(): Record<string, string> {
	const child: Record<string, string> = {};
	for (const name of INHERITED_ENV_ALLOWLIST) {
		const value = process.env[name];
		if (value !== undefined) child[name] = value;
	}
	return child;
}

/** The allowlist alone, for spawns that take no test-controlled settings (tar, bun install). */
export function baseChildEnv(): Record<string, string> {
	return { ...pickInheritedEnv(), WRANGLER_SEND_METRICS: "false" };
}

/**
 * Builds a child environment from the allowlist plus the suite's own
 * throwaway values. Throws when any required path or port setting is
 * missing, so a suite cannot silently fall back to an operational default
 * (isolated by construction, not by convention). Records the configured
 * directories for the finding-15 guard when TEST_ISOLATION_RECORD is set.
 */
export function buildChildEnv(overrides: Readonly<Record<string, string>>): Record<string, string> {
	const missing = [...REQUIRED_PATH_SETTINGS, ...REQUIRED_PORT_SETTINGS].filter(
		(name) => overrides[name] === undefined || overrides[name] === "",
	);
	if (missing.length > 0) {
		throw new Error(
			`test isolation: child environment is missing explicit values for ${missing.join(", ")}. ` +
				`Every path and port setting must be a throwaway value (see scripts/testEnv.ts).`,
		);
	}
	const child: Record<string, string> = {
		...pickInheritedEnv(),
		WRANGLER_SEND_METRICS: "false",
		...suiteRunnerSettings(),
		...overrides,
	};
	const record = process.env[ISOLATION_RECORD_ENV_VAR];
	if (record !== undefined && record !== "") {
		try {
			appendFileSync(
				record,
				`${REQUIRED_PATH_SETTINGS.map((name) => child[name] ?? "").join("\n")}\n`,
			);
		} catch {
			// Recording is audit-only; a failure here must not break the suite.
		}
	}
	return child;
}

/** A fresh set of throwaway directories plus a test-owned runner env file. */
export interface TestDirs {
	readonly root: string;
	readonly dataDir: string;
	readonly devDataDir: string;
	readonly releaseDir: string;
	readonly previousDir: string;
	readonly runnerEnvFile: string;
	readonly scratchRoot: string;
	readonly webOutDir: string;
}

function writeEmptyFile(file: string): void {
	writeFileSync(file, "", { mode: 0o600 });
}

/**
 * Creates one throwaway root with every directory a launcher run needs, plus
 * a test-owned (empty) runner env file. Suites pass the result into
 * `buildChildEnv` together with their test ports.
 */
export function newTestDirs(prefix: string): TestDirs {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const dirs: TestDirs = {
		root,
		dataDir: join(root, "data"),
		devDataDir: join(root, "data-dev"),
		releaseDir: join(root, "release"),
		previousDir: join(root, "release.previous"),
		runnerEnvFile: join(root, "test-runner.env"),
		scratchRoot: join(root, "scratch"),
		webOutDir: join(root, "web-out"),
	};
	writeEmptyFile(dirs.runnerEnvFile);
	return dirs;
}

/**
 * A test that needs runner settings writes its own env file (finding 5):
 * `KEY=VALUE` lines (values must be single-line). Returns the file path for
 * RESEARCH_RUNNER_ENV_FILE. Never points at the operational `apps/runner/.env`.
 */
export function writeTestRunnerEnvFile(
	dir: string,
	vars: Readonly<Record<string, string>>,
	fileName = "test-runner.env",
): string {
	for (const [key, value] of Object.entries(vars)) {
		if (value.includes("\n"))
			throw new Error(`test runner env value for ${key} must be single-line.`);
	}
	const file = join(dir, fileName);
	writeFileSync(
		file,
		`${Object.entries(vars)
			.map(([key, value]) => `${key}=${value}`)
			.join("\n")}${Object.keys(vars).length === 0 ? "" : "\n"}`,
		{ mode: 0o600 },
	);
	return file;
}
