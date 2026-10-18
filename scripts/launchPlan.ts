/**
 * One launcher, two environments (ADR-0011). This module holds the decisions
 * that can be pure — which processes with which arguments, ports, directories
 * and environment variables for a given mode and settings — as a plain
 * description (`LaunchPlan`). `launch.ts` supervises that description;
 * `prodBuild.ts` produces what the production plan runs. Tested in
 * `tests/local/launchPlan.test.ts` without starting anything.
 *
 * Development runs the working tree live (Vite HMR, `wrangler dev` reload,
 * a watching `bun build` of the runner into the development data directory
 * plus the bundle run under `node --watch`) against `data-dev/`. Production runs ONLY the
 * generation the pointer names under `release/generations/` (prebuilt Worker bundle with
 * bundling disabled, so later source edits and rebuilds of `dist/` cannot change what it serves)
 * against `data/`. Neither mode reads the other's data directory.
 */
import { resolve, sep } from "node:path";

export const LAUNCH_MODES = ["development", "production"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/** Ports and directories when no setting overrides them. */
export const DEFAULT_PROD_PORT = 8787;
export const DEFAULT_PROD_DATA_DIR = "data";
export const DEFAULT_DEV_PORT = 3000;
export const DEFAULT_DEV_API_PORT = 8788;
export const DEFAULT_DEV_DATA_DIR = "data-dev";
export const DEFAULT_RELEASE_DIR = "release";
export const DEFAULT_PREVIOUS_RELEASE_DIR = "release.previous";
export const PREVIOUS_RELEASE_DIR = DEFAULT_PREVIOUS_RELEASE_DIR;

export const DATABASE_NAME = "research";
export const WRANGLER = "node_modules/.bin/wrangler";
export const VITE = "node_modules/.bin/vite";
export const RUNNER_ENV_FILE = "apps/runner/.env";
/**
 * Setting that overrides which env file the runner processes load
 * (`--env-file-if-exists`). Default is the operational `apps/runner/.env`.
 * Tests point it at a file they wrote themselves (or a path that does not
 * exist), so an operational `.env` is never read by a test (finding 5).
 */
export const RUNNER_ENV_FILE_ENV_VAR = "RESEARCH_RUNNER_ENV_FILE";
export const RUNNER_SOURCE = "apps/runner/src/main.ts";

/**
 * Which runner the launcher starts (ADR-0030). `node` is the TypeScript
 * runner bundled by Bun and run under Node; `rust` is the `research-runner`
 * binary built by Cargo. The default stays `node` until the owner switches
 * after the real-environment run.
 */
export const RUNNER_KINDS = ["node", "rust"] as const;
export type RunnerKind = (typeof RUNNER_KINDS)[number];
export const DEFAULT_RUNNER_KIND: RunnerKind = "node";
export const RUNNER_KIND_ENV_VAR = "RESEARCH_RUNNER";
/**
 * Setting naming the shared Cargo target directory (default `<repo>/target`).
 * One build cache for the working tree, pristine copies and tests: registry
 * dependencies are compiled once.
 */
export const CARGO_TARGET_DIR_ENV_VAR = "RESEARCH_CARGO_TARGET_DIR";
export const DEFAULT_CARGO_TARGET_DIR = "target";
/** The runner binary and the companion it spawns agent CLIs through, built by `-p research-runner`. */
export const RUST_RUNNER_BINARY = "research-runner";
export const RUST_PROVIDER_SPAWN_BINARY = "research-provider-spawn";
/**
 * Companion binaries copied beside the runner when the build produced them.
 * TODO(ADR-0030): require `research-provider-spawn` (move it into
 * `RUST_REQUIRED_BINARIES`) once the runner crate declares that `[[bin]]`.
 */
export const RUST_OPTIONAL_BINARIES: readonly string[] = [RUST_PROVIDER_SPAWN_BINARY];
export const RUST_REQUIRED_BINARIES: readonly string[] = [RUST_RUNNER_BINARY];
/** The supervising development process that builds, copies and restarts the Rust runner. */
export const RUNNER_DEV_SCRIPT = "scripts/runnerDev.ts";
/** Cargo arguments of the development build (dev profile, lockfile respected). */
export const CARGO_DEV_BUILD_ARGS: readonly string[] = [
	"build",
	"--locked",
	"-p",
	"research-runner",
];
/** Cargo arguments of the release build `prod:build` runs. */
export const CARGO_RELEASE_BUILD_ARGS: readonly string[] = [
	"build",
	"--release",
	"--locked",
	"-p",
	"research-runner",
];

/**
 * Variables that would change what Cargo compiles. They are never passed on
 * from the caller: `RUSTFLAGS` or `CARGO_BUILD_*` could enable test seams or
 * change code generation, and a release must be a function of the sources.
 */
const CARGO_CODEGEN_VARS = new Set([
	"RUSTFLAGS",
	"CARGO_ENCODED_RUSTFLAGS",
	"RUSTC_WRAPPER",
	"RUSTC_WORKSPACE_WRAPPER",
	"RUSTDOCFLAGS",
]);

/** Environment for a Cargo child: the caller's, minus codegen overrides, with the shared target dir. */
export function cargoBuildEnv(
	base: Readonly<Record<string, string | undefined>>,
	targetDir: string,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (CARGO_CODEGEN_VARS.has(name) || name.startsWith("CARGO_BUILD_")) continue;
		env[name] = value;
	}
	env.CARGO_TARGET_DIR = targetDir;
	return env;
}

/** Absolute shared Cargo target directory from the settings. */
export function cargoTargetDirFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	repoRoot: string,
): string {
	return resolve(repoRoot, nonEmpty(env[CARGO_TARGET_DIR_ENV_VAR], DEFAULT_CARGO_TARGET_DIR));
}

/** Parses `RESEARCH_RUNNER`; an unknown value is refused, never guessed. */
export function parseRunnerKind(raw: string | undefined): PlanResult<RunnerKind> {
	if (raw === undefined || raw.trim() === "") return ok(DEFAULT_RUNNER_KIND);
	const value = raw.trim();
	const kind = RUNNER_KINDS.find((candidate) => candidate === value);
	if (kind === undefined) {
		return fail(
			"INVALID_RUNNER",
			`${RUNNER_KIND_ENV_VAR} must be "node" or "rust" (got ${JSON.stringify(raw)}).`,
		);
	}
	return ok(kind);
}
/** Worker entry served by both the dev server and the release builds. */
export const WORKER_SOURCE = "apps/api/src/worker.ts";
/** Migrations resolve to the working tree by absolute path, taken at start/build time. */
export const MIGRATIONS_DIR = "infra/migrations";
/** Node runs the development runner bundle (never Bun: see apps/runner/src/runtime.ts). */
export const NODE = "node";

/**
 * The Wrangler configuration `bun run dev` serves. Unlike
 * `infra/wrangler.jsonc` it never reads `dist/`: the SPA comes from the Vite
 * dev server, so the Worker's static-asset directory is an empty directory
 * inside the development data directory (only `/api/*` reaches the Worker;
 * a direct non-API hit finds nothing there, which is correct — Vite serves
 * the page). It has no `env` section, so Wrangler never warns about an
 * unspecified environment. Absolute paths keep it correct when the data
 * directory is a throwaway OS-temp directory outside the repository.
 */
export function devWranglerConfig(args: {
	readonly workerEntry: string;
	readonly webDir: string;
	readonly migrationsDir: string;
	readonly viteOrigin: string;
}): string {
	const config = {
		$schema: "../node_modules/wrangler/config-schema.json",
		name: "research-workspace",
		main: args.workerEntry,
		compatibility_date: "2026-09-01",
		assets: {
			directory: args.webDir,
			binding: "ASSETS",
			not_found_handling: "single-page-application",
			run_worker_first: ["/api/*"],
		},
		d1_databases: [
			{
				binding: "DB",
				database_name: "research",
				database_id: "00000000-0000-0000-0000-0000000010ca",
				migrations_dir: args.migrationsDir,
			},
		],
		vars: {
			AUTH_MODE: "local-dev",
			OWNER_EMAIL: "owner@localhost",
			APP_ENV: "development",
			DEV_ALLOWED_ORIGIN: args.viteOrigin,
		},
	};
	return `${JSON.stringify(config, null, "\t")}\n`;
}

export interface PlanError {
	readonly code: "INVALID_PORT" | "INVALID_RUNNER" | "DATA_DIR_REFUSED";
	readonly message: string;
}

export type PlanResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: PlanError };

/** Everything `planLaunch` needs, already parsed; see `readLaunchInputs`. */
export interface LaunchInputs {
	readonly mode: LaunchMode;
	/** Absolute repository root, used to resolve data directories for comparison. */
	readonly repoRoot: string;
	/** The Bun executable (the launcher runs under Bun). */
	readonly bunExe: string;
	readonly prodPort: number;
	readonly prodDataDir: string;
	readonly devPort: number;
	readonly devApiPort: number;
	readonly devDataDir: string;
	readonly releaseDir: string;
	readonly previousReleaseDir: string;
	/** Env file the runner processes load; tests override it (finding 5). */
	readonly runnerEnvFile: string;
	/** Which runner the settings ask for (`RESEARCH_RUNNER`, default node). */
	readonly runnerKind: RunnerKind;
	/** Absolute shared Cargo target directory (`RESEARCH_CARGO_TARGET_DIR`, default `<repo>/target`). */
	readonly cargoTargetDir: string;
	/**
	 * Production only: which runners the served generation contains. A
	 * generation built before the switch has only `runner/main.mjs`, one built
	 * with `RESEARCH_RUNNER=rust` only the binary; the plan runs what exists
	 * (the rust request falls back to node for a generation without a binary).
	 */
	readonly generationRunners: { readonly node: boolean; readonly rust: boolean };
}

export interface PlannedProcess {
	readonly name: string;
	readonly command: string;
	readonly args: readonly string[];
	/** Repository-root-relative log file. */
	readonly logFile: string;
	readonly extraEnv: Readonly<Record<string, string>>;
}

export interface ListenPort {
	readonly port: number;
	/** Setting that overrides it, named in the port-busy error. */
	readonly envVar: string;
}

/**
 * The development runner: either the Bun bundle run under `node --watch`, or
 * the Cargo-built binary kept fresh by the supervising `scripts/runnerDev.ts`.
 * `prepare` is the one-shot step the launcher runs before anything starts, so
 * the file the runner process watches exists.
 */
export type DevRunnerPlan =
	| {
			readonly kind: "node";
			readonly bunExe: string;
			readonly source: string;
			readonly bundle: string;
	  }
	| {
			readonly kind: "rust";
			readonly bunExe: string;
			/** Directory holding `research-runner` (and its companion), inside the data directory. */
			readonly binaryDir: string;
			readonly binary: string;
			readonly cargoTargetDir: string;
			/** One-shot build + copy run by the launcher before anything starts. */
			readonly prepare: { readonly command: string; readonly args: readonly string[] };
	  };

export interface LaunchPlan {
	readonly mode: LaunchMode;
	/** What the owner opens: the app in production, the Vite server in development. */
	readonly origin: string;
	/** Base URL of the API (the same as `origin` in production). */
	readonly apiOrigin: string;
	readonly appEnv: "development" | "production";
	readonly dataDir: string;
	readonly stateDir: string;
	readonly logDir: string;
	readonly credentialFile: string;
	readonly credentialLabel: string;
	/**
	 * Runner-side Google refresh-token file (FR-019, mode 0600, beside the
	 * credential file). Passed to the runner as `GOOGLE_TOKEN_FILE` in both
	 * modes, so dev and prod never share a grant.
	 */
	readonly googleTokenFile: string;
	readonly serverLog: string;
	readonly runnerLog: string;
	readonly buildLog: string;
	/** Every port this mode listens on, refused when busy before anything starts. */
	readonly listenPorts: readonly ListenPort[];
	/** Migrations run against this configuration and state directory at start. */
	readonly migrations: { readonly config: string; readonly stateDir: string };
	/** For production: the release that is served. Absent in development. */
	readonly release: {
		readonly dir: string;
		readonly manifestFile: string;
		readonly wranglerConfig: string;
		readonly workerBundle: string;
		/** The runner file this plan starts: `runner/main.mjs` (node) or `runner/research-runner` (rust). */
		readonly runnerBundle: string;
		readonly runnerKind: RunnerKind;
		/** True when `RESEARCH_RUNNER=rust` was asked for but the generation has no binary. */
		readonly runnerFellBack: boolean;
	} | null;
	/**
	 * For development: the one-shot build the launcher runs before starting
	 * anything, plus the two watching processes that keep the runner live.
	 * The bundle lives inside the development data directory so throwaway
	 * test directories stay isolated and nothing is written into the
	 * repository. Absent in production.
	 */
	readonly devRunner: DevRunnerPlan | null;
	/**
	 * For development: the generated Wrangler configuration the dev server
	 * and migrations run against (never `dist/`), written into the
	 * development data directory at start-up. Absent in production.
	 */
	readonly devWrangler: {
		readonly file: string;
		readonly webDir: string;
		readonly content: string;
	} | null;
	readonly processes: readonly PlannedProcess[];
}

function ok<T>(value: T): PlanResult<T> {
	return { ok: true, value };
}

function fail<T>(code: PlanError["code"], message: string): PlanResult<T> {
	return { ok: false, error: { code, message } };
}

function parsePort(raw: string | undefined, fallback: number, envVar: string): PlanResult<number> {
	if (raw === undefined || raw.trim() === "") return ok(fallback);
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65_535) {
		return fail(
			"INVALID_PORT",
			`${envVar} must be a port number between 1024 and 65535 (got ${JSON.stringify(raw)}).`,
		);
	}
	return ok(parsed);
}

function nonEmpty(raw: string | undefined, fallback: string): string {
	return raw === undefined || raw.trim() === "" ? fallback : raw;
}

/**
 * Parses the launcher settings from the environment. Production honours
 * `RESEARCH_PORT` / `RESEARCH_DATA_DIR`; development honours
 * `RESEARCH_DEV_PORT` / `RESEARCH_DEV_API_PORT` / `RESEARCH_DEV_DATA_DIR`;
 * `RESEARCH_RELEASE_DIR` names the release production serves (a test hook for
 * the missing-release refusal; default `release/`), and
 * `RESEARCH_PREVIOUS_RELEASE_DIR` names where the previous release is kept
 * for rollback (default `release.previous/`; a test hook so the suite never
 * touches the repository-root release directories). `RESEARCH_RUNNER`
 * (`node`, the default, or `rust`) picks the runner and
 * `RESEARCH_CARGO_TARGET_DIR` the shared Cargo build cache.
 */
export function readLaunchInputs(
	mode: LaunchMode,
	env: Readonly<Record<string, string | undefined>>,
	repoRoot: string,
	bunExe: string,
	/** Production only: the runners the served generation contains (the launcher looks). */
	generationRunners: LaunchInputs["generationRunners"] = { node: true, rust: false },
): PlanResult<LaunchInputs> {
	const prodPort = parsePort(env.RESEARCH_PORT, DEFAULT_PROD_PORT, "RESEARCH_PORT");
	if (!prodPort.ok) return prodPort;
	const devPort = parsePort(env.RESEARCH_DEV_PORT, DEFAULT_DEV_PORT, "RESEARCH_DEV_PORT");
	if (!devPort.ok) return devPort;
	const devApiPort = parsePort(
		env.RESEARCH_DEV_API_PORT,
		DEFAULT_DEV_API_PORT,
		"RESEARCH_DEV_API_PORT",
	);
	if (!devApiPort.ok) return devApiPort;
	const runnerKind = parseRunnerKind(env[RUNNER_KIND_ENV_VAR]);
	if (!runnerKind.ok) return runnerKind;
	return ok({
		mode,
		repoRoot,
		bunExe,
		prodPort: prodPort.value,
		prodDataDir: nonEmpty(env.RESEARCH_DATA_DIR, DEFAULT_PROD_DATA_DIR),
		devPort: devPort.value,
		devApiPort: devApiPort.value,
		devDataDir: nonEmpty(env.RESEARCH_DEV_DATA_DIR, DEFAULT_DEV_DATA_DIR),
		releaseDir: nonEmpty(env.RESEARCH_RELEASE_DIR, DEFAULT_RELEASE_DIR),
		previousReleaseDir: nonEmpty(env.RESEARCH_PREVIOUS_RELEASE_DIR, DEFAULT_PREVIOUS_RELEASE_DIR),
		runnerEnvFile: nonEmpty(env[RUNNER_ENV_FILE_ENV_VAR], RUNNER_ENV_FILE),
		runnerKind: runnerKind.value,
		cargoTargetDir: cargoTargetDirFromEnv(env, repoRoot),
		generationRunners,
	});
}

/** Joins path segments with forward slashes; inputs are already slash-separated. */
function joinPath(...segments: string[]): string {
	return segments.filter((segment) => segment !== "").join("/");
}

/**
 * Pure textual overlap: equal resolved paths, or one containing the other
 * (finding 1 — the parent/child case needs no file system to detect). Links,
 * case variants and other spellings the text cannot see are caught by the
 * canonical check in `releaseOps.validateDirectorySet`, which `launch.ts`
 * runs before ANY write; this pure check is the first of the two layers.
 */
export function describeOverlap(
	repoRoot: string,
	first: string,
	second: string,
): "equal" | "second-inside-first" | "first-inside-second" | null {
	const a = resolve(repoRoot, first);
	const b = resolve(repoRoot, second);
	if (a === b) return "equal";
	if (b.startsWith(`${a}${sep}`)) return "second-inside-first";
	if (a.startsWith(`${b}${sep}`)) return "first-inside-second";
	return null;
}

function planProduction(inputs: LaunchInputs, dataDir: string): LaunchPlan {
	const origin = `http://localhost:${inputs.prodPort}`;
	const releaseDir = inputs.releaseDir;
	// The runner file comes from what the generation contains (ADR-0030
	// transition): a generation built before the switch has only main.mjs and
	// keeps starting with node even when the rust runner is requested.
	const runnerKind: RunnerKind =
		inputs.runnerKind === "rust" && inputs.generationRunners.rust ? "rust" : "node";
	const runnerFellBack = inputs.runnerKind === "rust" && runnerKind === "node";
	const runnerBundle = joinPath(
		releaseDir,
		runnerKind === "rust" ? `runner/${RUST_RUNNER_BINARY}` : "runner/main.mjs",
	);
	const logDir = joinPath(dataDir, "logs");
	const stateDir = joinPath(dataDir, "d1");
	const processes: readonly PlannedProcess[] = [
		{
			name: "server",
			command: WRANGLER,
			args: [
				"dev",
				"--config",
				joinPath(releaseDir, "wrangler.jsonc"),
				"--port",
				String(inputs.prodPort),
				// Loopback only: there is no sign-in, so the app must not be
				// reachable from the network.
				"--ip",
				"127.0.0.1",
				"--local",
				"--persist-to",
				stateDir,
				"--show-interactive-dev-session=false",
				// The calendar subscription token travels in a URL path, and
				// wrangler's per-request info lines print the expanded path:
				// `warn` drops those lines (and the startup banner) while the
				// Worker's own console.error event lines still reach the log.
				// Readiness is an HTTP poll and failures are exit events, so
				// nothing the launcher waits for or greps is lost (SEC-005).
				"--log-level",
				"warn",
				// The entry is the prebuilt release bundle, not the source
				// tree: later edits and rebuilds cannot change what is served.
				"--no-bundle",
				// Belt and braces with the release configuration below: the
				// development relaxation must never be reachable here.
				"--var",
				"APP_ENV:production",
			],
			logFile: joinPath(logDir, "server.log"),
			extraEnv: {},
		},
		{
			name: "runner",
			// The Rust binary parses `--env-file-if-exists` itself with Node's
			// precedence (existing environment wins), so the launcher's
			// variables below still cannot be redirected by the file.
			command: runnerKind === "rust" ? runnerBundle : "node",
			args:
				runnerKind === "rust"
					? [`--env-file-if-exists=${inputs.runnerEnvFile}`]
					: [`--env-file-if-exists=${inputs.runnerEnvFile}`, runnerBundle],
			logFile: joinPath(logDir, "runner.log"),
			// Set here so they win over the same names in the env file: a
			// file written for a deployed Worker cannot point the local
			// runner somewhere else.
			extraEnv: {
				RESEARCH_API_URL: origin,
				RUNNER_PAGES_DIR: joinPath(dataDir, "pages"),
				GOOGLE_TOKEN_FILE: joinPath(dataDir, "google-token.json"),
			},
		},
	];
	return {
		mode: "production",
		origin,
		apiOrigin: origin,
		appEnv: "production",
		dataDir,
		stateDir,
		logDir,
		credentialFile: joinPath(dataDir, "runner-credential.json"),
		googleTokenFile: joinPath(dataDir, "google-token.json"),
		credentialLabel: "Local runner (bun run prod)",
		serverLog: joinPath(logDir, "server.log"),
		runnerLog: joinPath(logDir, "runner.log"),
		buildLog: joinPath(logDir, "build.log"),
		listenPorts: [{ port: inputs.prodPort, envVar: "RESEARCH_PORT" }],
		migrations: {
			config: joinPath(releaseDir, "wrangler.jsonc"),
			stateDir,
		},
		release: {
			dir: releaseDir,
			manifestFile: joinPath(releaseDir, "manifest.json"),
			wranglerConfig: joinPath(releaseDir, "wrangler.jsonc"),
			workerBundle: joinPath(releaseDir, "worker/worker.js"),
			runnerBundle,
			runnerKind,
			runnerFellBack,
		},
		devRunner: null,
		devWrangler: null,
		processes,
	};
}

/** Arguments shared by the one-shot and the supervising `scripts/runnerDev.ts` runs. */
function runnerDevArgs(inputs: LaunchInputs, logDir: string, binary: string): string[] {
	return [
		"--binary",
		binary,
		"--runner-env",
		inputs.runnerEnvFile,
		"--target-dir",
		inputs.cargoTargetDir,
		"--build-log",
		joinPath(logDir, "runner-build.log"),
	];
}

/**
 * Rust development runner: ONE supervising process (ADR-0030, amending
 * ADR-0011). It watches `crates/**`, `Cargo.toml` and `Cargo.lock`, runs the
 * Cargo build, copies the binary into the data directory through a temp file
 * and rename, and restarts the runner child on every new binary — and
 * survives the child's exit and waits for the next change, as `node --watch`
 * did. The child's output goes to `runner.log` (the launcher's crash watcher
 * reads it); the supervisor's own lines go to `runner-build.log`.
 */
function rustDevRunnerProcess(
	inputs: LaunchInputs,
	logDir: string,
	binary: string,
	runnerEnv: Readonly<Record<string, string>>,
): PlannedProcess {
	return {
		name: "runner",
		command: inputs.bunExe,
		args: [RUNNER_DEV_SCRIPT, ...runnerDevArgs(inputs, logDir, binary)],
		logFile: joinPath(logDir, "runner.log"),
		extraEnv: runnerEnv,
	};
}

/** Node development runner: a watching Bun build plus the bundle under `node --watch`. */
function nodeDevRunnerProcesses(
	inputs: LaunchInputs,
	logDir: string,
	runnerBundle: string,
	runnerEnv: Readonly<Record<string, string>>,
): PlannedProcess[] {
	return [
		{
			name: "runner-build",
			// Rebuilds the runner bundle whenever its sources (or the
			// workspace packages they import) change.
			command: inputs.bunExe,
			args: ["build", RUNNER_SOURCE, "--target=node", `--outfile=${runnerBundle}`, "--watch"],
			logFile: joinPath(logDir, "runner-build.log"),
			extraEnv: {},
		},
		{
			name: "runner",
			// Runs the rebuilt bundle under Node with restart on change:
			// edits to runner sources rebuild the bundle, and `node --watch`
			// restarts on the rebuilt file.
			command: NODE,
			args: [`--env-file-if-exists=${inputs.runnerEnvFile}`, "--watch", runnerBundle],
			logFile: joinPath(logDir, "runner.log"),
			extraEnv: runnerEnv,
		},
	];
}

function planDevelopment(inputs: LaunchInputs, dataDir: string): LaunchPlan {
	const viteOrigin = `http://localhost:${inputs.devPort}`;
	const apiOrigin = `http://localhost:${inputs.devApiPort}`;
	const logDir = joinPath(dataDir, "logs");
	const stateDir = joinPath(dataDir, "d1");
	// The dev server and migrations run against a generated configuration
	// that never reads dist/ (see devWranglerConfig): the SPA comes from
	// Vite, so the Worker's asset directory is an empty directory here.
	const wranglerFile = joinPath(dataDir, "dev.wrangler.jsonc");
	const webDir = joinPath(dataDir, "web");
	const devWrangler = {
		file: wranglerFile,
		webDir,
		content: devWranglerConfig({
			workerEntry: resolve(inputs.repoRoot, WORKER_SOURCE),
			webDir: resolve(inputs.repoRoot, webDir),
			migrationsDir: resolve(inputs.repoRoot, MIGRATIONS_DIR),
			viteOrigin,
		}),
	};
	// The runner bundle lives inside the development data directory: a real
	// file `node --watch` can restart on, rebuilt from source on every change.
	// The runner itself must run under Node — under Bun its pinned HTTPS
	// fetcher never completes (see apps/runner/src/runtime.ts).
	const runnerBundle = joinPath(dataDir, "runner/main.mjs");
	const runnerBinary = joinPath(dataDir, "runner", RUST_RUNNER_BINARY);
	const runnerEnv = {
		RESEARCH_API_URL: apiOrigin,
		RUNNER_PAGES_DIR: joinPath(dataDir, "pages"),
		GOOGLE_TOKEN_FILE: joinPath(dataDir, "google-token.json"),
	};
	const processes: readonly PlannedProcess[] = [
		{
			name: "vite",
			command: VITE,
			args: [
				"--config",
				"apps/web/vite.config.ts",
				"--port",
				String(inputs.devPort),
				"--strictPort",
			],
			logFile: joinPath(logDir, "vite.log"),
			// The SPA dev server proxies /api to this API (vite.config.ts).
			extraEnv: { RESEARCH_DEV_API_PORT: String(inputs.devApiPort) },
		},
		{
			name: "server",
			command: WRANGLER,
			args: [
				"dev",
				"--config",
				wranglerFile,
				"--port",
				String(inputs.devApiPort),
				// Loopback only, as in production.
				"--ip",
				"127.0.0.1",
				"--local",
				"--persist-to",
				stateDir,
				"--show-interactive-dev-session=false",
				// The calendar subscription token travels in a URL path, and
				// wrangler's per-request info lines print the expanded path:
				// `warn` drops those lines (and the startup banner) while the
				// Worker's own console.error event lines still reach the log.
				// Readiness is an HTTP poll and failures are exit events, so
				// nothing the launcher waits for or greps is lost (SEC-005).
				"--log-level",
				"warn",
			],
			logFile: joinPath(logDir, "server.log"),
			extraEnv: {},
		},
		...(inputs.runnerKind === "rust"
			? [rustDevRunnerProcess(inputs, logDir, runnerBinary, runnerEnv)]
			: nodeDevRunnerProcesses(inputs, logDir, runnerBundle, runnerEnv)),
	];
	return {
		mode: "development",
		origin: viteOrigin,
		apiOrigin,
		appEnv: "development",
		dataDir,
		stateDir,
		logDir,
		credentialFile: joinPath(dataDir, "runner-credential.json"),
		googleTokenFile: joinPath(dataDir, "google-token.json"),
		credentialLabel: "Local runner (bun run dev)",
		serverLog: joinPath(logDir, "server.log"),
		runnerLog: joinPath(logDir, "runner.log"),
		buildLog: joinPath(logDir, "build.log"),
		listenPorts: [
			{ port: inputs.devPort, envVar: "RESEARCH_DEV_PORT" },
			{ port: inputs.devApiPort, envVar: "RESEARCH_DEV_API_PORT" },
		],
		migrations: {
			config: wranglerFile,
			stateDir,
		},
		release: null,
		devRunner:
			inputs.runnerKind === "rust"
				? {
						kind: "rust",
						bunExe: inputs.bunExe,
						binaryDir: joinPath(dataDir, "runner"),
						binary: runnerBinary,
						cargoTargetDir: inputs.cargoTargetDir,
						prepare: {
							command: inputs.bunExe,
							args: [RUNNER_DEV_SCRIPT, ...runnerDevArgs(inputs, logDir, runnerBinary), "--once"],
						},
					}
				: { kind: "node", bunExe: inputs.bunExe, source: RUNNER_SOURCE, bundle: runnerBundle },
		devWrangler,
		processes,
	};
}

export function planLaunch(inputs: LaunchInputs): PlanResult<LaunchPlan> {
	const dataDir = inputs.mode === "production" ? inputs.prodDataDir : inputs.devDataDir;
	const otherDataDir = inputs.mode === "production" ? inputs.devDataDir : inputs.prodDataDir;
	const overlap = describeOverlap(inputs.repoRoot, dataDir, otherDataDir);
	if (overlap !== null) {
		const relation =
			overlap === "equal"
				? "is the same directory as"
				: overlap === "second-inside-first"
					? "contains"
					: "sits inside";
		return fail(
			"DATA_DIR_REFUSED",
			inputs.mode === "production"
				? `production refuses to run: its data directory (${dataDir}) ${relation} the development data directory (${otherDataDir}). Production data lives in ${dataDir}; check RESEARCH_DATA_DIR / RESEARCH_DEV_DATA_DIR.`
				: `development refuses to run: its data directory (${dataDir}) ${relation} the production data directory (${otherDataDir}). Development data lives in ${dataDir}; check RESEARCH_DEV_DATA_DIR / RESEARCH_DATA_DIR.`,
		);
	}
	return ok(
		inputs.mode === "production"
			? planProduction(inputs, dataDir)
			: planDevelopment(inputs, dataDir),
	);
}
