/**
 * Builds an immutable production release generation (ADR-0011):
 *
 *     bun run prod:build
 *
 * The build NEVER touches an existing generation. It writes a new, uniquely
 * named directory under `<area>/generations/<UTC timestamp>-<random>/` — the
 * SPA, the runner bundle, the Worker bundle (via `wrangler deploy --dry-run`
 * through a generated configuration that refers only to this generation,
 * never `dist/`), a copy of the migrations it was built with (finding 6),
 * the generation's Wrangler configuration and its manifest written LAST —
 * then validates the generation, makes it read-only, and only then moves the
 * atomic pointer (`current.json`) to it. A failed build leaves the pointer
 * and every existing generation untouched and removes only its own
 * unfinished directory (finding 4). Pruning keeps the newest
 * KEEP_GENERATIONS generations plus the active, previous and live-held ones.
 *
 * The previous release, if any, is NOT rotated aside anymore: generations
 * replace `release.previous/` (that setting is now only the legacy location
 * migrated from, once). An old-layout `release/` (a single release directly
 * in the area) is migrated into the first generation, never destroyed.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	CARGO_RELEASE_BUILD_ARGS,
	cargoBuildEnv,
	cargoTargetDirFromEnv,
	DEFAULT_DEV_DATA_DIR,
	DEFAULT_PROD_DATA_DIR,
	parseRunnerKind,
	RUNNER_KIND_ENV_VAR,
	RUST_OPTIONAL_BINARIES,
	RUST_REQUIRED_BINARIES,
} from "./launchPlan.ts";
import {
	acquireReleaseLock,
	activateGeneration,
	adoptLegacyRelease,
	BUILD_FAIL_AT_ENV_VAR,
	buildWranglerConfig,
	checkReleaseMarker,
	chooseGenerationsToPrune,
	choosePreviousGeneration,
	copyMigrationFiles,
	generationLayout,
	listGenerationIds,
	liveHeldGenerations,
	makeGenerationReadOnly,
	markerHtmlComment,
	newGenerationId,
	previousDirFromEnv,
	RELEASE_MARKER_ENV_VAR,
	readReleaseManifest,
	readReleasePointer,
	releaseDirFromEnv,
	releaseReleaseLock,
	releaseWranglerConfig,
	safeRemoveDir,
	validateDirectorySet,
	validateGeneration,
} from "./releaseOps.ts";

const VITE = "node_modules/.bin/vite";
const WRANGLER = "node_modules/.bin/wrangler";
const WORKER_SOURCE = "apps/api/src/worker.ts";
const WORKING_MIGRATIONS = "infra/migrations";

function fail(message: string): never {
	console.error(`prod:build: ${message}`);
	process.exit(1);
}

function run(
	label: string,
	command: string,
	args: readonly string[],
	env?: NodeJS.ProcessEnv,
): void {
	console.log(`\n▶ ${label}`);
	const result = spawnSync(command, args, { stdio: "inherit", env });
	// Throws (never exits): the outer catch removes the unfinished generation
	// and releases the lock, and `finally` only runs when nothing exits first.
	if (result.status !== 0) throw new Error(`step failed: ${label}`);
}

function failAtStep(step: string): void {
	const hook = process.env[BUILD_FAIL_AT_ENV_VAR]?.trim() ?? "";
	if (hook !== "" && hook === step) {
		throw new Error(`test hook ${BUILD_FAIL_AT_ENV_VAR}=${hook}: failing at step ${step}.`);
	}
}

function gitRevision(): string | null {
	try {
		const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
		if (result.status !== 0) return null;
		const revision = result.stdout.trim();
		return /^[0-9a-f]{40}$/.test(revision) ? revision : null;
	} catch {
		return null;
	}
}

function toolVersion(command: string, args: readonly string[]): string {
	try {
		const result = spawnSync(command, args, { encoding: "utf8" });
		const version = result.status === 0 ? result.stdout.trim() : "";
		return version === "" ? "unknown" : version;
	} catch {
		return "unknown";
	}
}

/** UTC timestamp plus randomness: unique even for two builds in one second. */
function newBuildGenerationId(now: Date): string {
	return newGenerationId(now, randomBytes(3).toString("hex"));
}

function nonEmptyEnv(name: string, fallback: string): string {
	const raw = process.env[name]?.trim() ?? "";
	return raw === "" ? fallback : raw;
}

const repoRoot = process.cwd();
const releaseDir = releaseDirFromEnv(process.env);
const previousDir = previousDirFromEnv(process.env);
const prodDataDir = nonEmptyEnv("RESEARCH_DATA_DIR", DEFAULT_PROD_DATA_DIR);
const devDataDir = nonEmptyEnv("RESEARCH_DEV_DATA_DIR", DEFAULT_DEV_DATA_DIR);
const marker = process.env[RELEASE_MARKER_ENV_VAR]?.trim() ?? "";
// RESEARCH_RUNNER=rust builds the Rust runner binaries into the generation
// INSTEAD of the Node bundle (ADR-0030); the default stays node.
const parsedRunnerKind = parseRunnerKind(process.env[RUNNER_KIND_ENV_VAR]);
if (!parsedRunnerKind.ok) fail(parsedRunnerKind.error.message);
const runnerKind = parsedRunnerKind.value;
const cargoTargetDir = cargoTargetDirFromEnv(process.env, repoRoot);

const markerCheck = checkReleaseMarker(marker);
if (!markerCheck.ok) fail(markerCheck.error);

// ONE validation of the whole directory set before ANY write (finding 2):
// with an existing release, RESEARCH_PREVIOUS_RELEASE_DIR=data must refuse
// here instead of deleting the production database.
const validated = validateDirectorySet(repoRoot, [
	{ label: "production data directory", dir: prodDataDir },
	{ label: "development data directory", dir: devDataDir },
	{ label: "release area", dir: releaseDir },
	{ label: "previous release directory", dir: previousDir },
]);
if (!validated.ok) fail(validated.error);
const areaAbs = validated.value.canonical[2]?.canonical ?? resolve(repoRoot, releaseDir);

if (!existsSync(WRANGLER) || !existsSync(VITE)) {
	fail("dependencies are missing. Run `bun install` first.");
}

const locked = acquireReleaseLock(areaAbs);
if (!locked.ok) fail(locked.error);
if (locked.value.tookOver) console.log("  (took over a stale release lock; see above)");

let unfinished: string | null = null;
// The catch records the failure and lets `finally` release the lock first:
// exiting inside `try` would skip `finally` and wedge the release lock.
let buildError: string | null = null;
try {
	migrateLegacyRelease();
	const generation = buildGeneration();
	activateGeneration(areaAbs, generation, new Date().toISOString());
	pruneGenerations();
	const pointer = readReleasePointer(areaAbs);
	console.log(`\n✔ release generation ${generation} built and activated.`);
	const manifest = readReleaseManifest(generationLayout(areaAbs, generation).manifestFile);
	console.log(
		`  revision: ${manifest?.revision ?? "(git unavailable)"}   built at: ${manifest?.builtAt ?? "unknown"}`,
	);
	console.log(`  history: ${pointer?.history.length ?? 0} activation(s) on record.`);
	console.log("  promote it by restarting production: Ctrl+C, then `bun run prod:start`.");
} catch (error) {
	if (unfinished !== null) {
		const removed = safeRemoveDir(areaAbs, unfinished);
		if (!removed.ok) console.error(`prod:build: ${removed.error}`);
		else console.log(`  (removed the unfinished generation directory)`);
	}
	buildError = error instanceof Error ? error.message : "build failed unexpectedly.";
} finally {
	releaseReleaseLock(areaAbs);
}
if (buildError !== null) fail(buildError);

/**
 * An old-layout area (a manifest directly in the area, no generations) is
 * adopted, never destroyed (finding 3): its content moves into the first
 * generation, and a legacy previous release (RESEARCH_PREVIOUS_RELEASE_DIR)
 * becomes an older generation. Anything ambiguous refuses with instructions.
 */
function migrateLegacyRelease(): void {
	const adopted = adoptLegacyRelease({
		areaAbs,
		previousAbs: resolve(repoRoot, previousDir),
		workingMigrationsDir: resolve(repoRoot, WORKING_MIGRATIONS),
		nowIso: new Date().toISOString(),
		nodeVersion: process.version,
		randomHex: () => randomBytes(3).toString("hex"),
	});
	if (!adopted.ok) throw new Error(adopted.error);
	if (adopted.value.migrated.length > 0) {
		console.log(
			`\n▶ adopted the old-layout release as generation ${adopted.value.active} (nothing deleted).`,
		);
	}
}

/** Copies the working tree's migrations; returns their sorted basenames. */
function copyWorkingMigrations(into: string): string[] {
	const copied = copyMigrationFiles(resolve(repoRoot, WORKING_MIGRATIONS), into);
	if (!copied.ok) throw new Error(copied.error);
	return copied.value;
}

/**
 * Builds the release binaries and COPIES them into the generation (never a
 * hard link: a later Cargo build must not change a generation that is being
 * served). The copy goes through a temp file and a rename, mode 0755 here and
 * 0555 once the generation is made read-only. `RUSTFLAGS` and `CARGO_BUILD_*`
 * from the caller never reach Cargo (see `cargoBuildEnv`).
 */
function buildRustRunner(runnerDir: string): void {
	run(
		"build the Rust runner (release)",
		"cargo",
		CARGO_RELEASE_BUILD_ARGS,
		cargoBuildEnv(process.env, cargoTargetDir),
	);
	const releaseDir = join(cargoTargetDir, "release");
	for (const name of [...RUST_REQUIRED_BINARIES, ...RUST_OPTIONAL_BINARIES]) {
		const built = join(releaseDir, name);
		if (!existsSync(built)) {
			if (RUST_REQUIRED_BINARIES.includes(name)) {
				throw new Error(`the Rust build did not produce ${built}.`);
			}
			continue;
		}
		const target = join(runnerDir, name);
		const temp = `${target}.tmp-${process.pid}`;
		copyFileSync(built, temp);
		chmodSync(temp, 0o755);
		renameSync(temp, target);
	}
}

function buildGeneration(): string {
	const builtAt = new Date().toISOString();
	const id = newBuildGenerationId(new Date());
	const layout = generationLayout(areaAbs, id);
	unfinished = layout.dir;
	mkdirSync(layout.workerDir, { recursive: true });
	mkdirSync(layout.runnerDir, { recursive: true });

	failAtStep("spa");
	run("build the SPA", VITE, ["build", "--config", "apps/web/vite.config.ts"], {
		...process.env,
		RESEARCH_WEB_OUT_DIR: layout.webDir,
	});
	failAtStep("runner");
	if (runnerKind === "rust") buildRustRunner(layout.runnerDir);
	else {
		run("build the runner", process.execPath, [
			"build",
			"apps/runner/src/main.ts",
			"--target=node",
			`--outfile=${join(layout.runnerDir, "main.mjs")}`,
		]);
	}
	// The Worker is bundled through a generated configuration that refers only to
	// this generation: its `assets.directory` is the generation's own `web/` (just
	// built above), never `dist/web`, so a clean checkout with no `dist/`
	// builds. It has no `env` section, so Wrangler never warns about an
	// unspecified environment: this bundle is the local production-on-this-PC
	// Worker, not the Cloudflare deployment.
	const buildConfigFile = join(layout.dir, "build.wrangler.jsonc");
	writeFileSync(
		buildConfigFile,
		buildWranglerConfig({
			workerEntry: resolve(repoRoot, WORKER_SOURCE),
			webDir: layout.webDir,
			migrationsDir: resolve(repoRoot, WORKING_MIGRATIONS),
		}),
	);
	failAtStep("worker");
	run("bundle the Worker", WRANGLER, [
		"deploy",
		"--dry-run",
		"--config",
		buildConfigFile,
		// Absolute: Wrangler resolves a relative --outdir against the configuration
		// file's directory, not the working directory.
		"--outdir",
		layout.workerDir,
	]);
	rmSync(buildConfigFile, { force: true });
	if (!existsSync(join(layout.workerDir, "worker.js"))) {
		throw new Error(`the Worker bundle was not written to ${layout.workerDir}/worker.js.`);
	}
	// The dry-run leaves its `.wrangler/` scratch next to the build
	// configuration: build residue that must not ship in the release (and
	// would be locked read-only below). The running server recreates its own
	// `.wrangler/tmp` under the writable generation root on every start.
	const dryRunScratch = join(layout.dir, ".wrangler");
	if (existsSync(dryRunScratch)) {
		const removed = safeRemoveDir(areaAbs, dryRunScratch);
		if (!removed.ok) throw new Error(removed.error);
	}

	failAtStep("finalize");
	// Each generation carries the migrations it was built with (finding 6).
	const migrations = copyWorkingMigrations(layout.migrationsDir);
	writeFileSync(
		layout.wranglerConfig,
		releaseWranglerConfig({ migrationsDir: layout.migrationsDir, generation: id, builtAt }),
	);
	if (marker !== "") {
		writeFileSync(join(layout.webDir, "index.html"), markerHtmlComment(marker), { flag: "a" });
	}
	// The manifest goes last: only a finished build counts as a release.
	const manifest = {
		builtAt,
		revision: gitRevision(),
		versions: {
			bun: toolVersion(process.execPath, ["--version"]),
			node: process.version,
			...(runnerKind === "rust" ? { rustc: toolVersion("rustc", ["-V"]) } : {}),
		},
		generation: id,
		migrations,
		marker,
	};
	writeFileSync(layout.manifestFile, `${JSON.stringify(manifest, null, "\t")}\n`);

	const checked = validateGeneration(layout);
	if (!checked.ok) throw new Error(`the new generation is incomplete: ${checked.error}`);
	makeGenerationReadOnly(layout.dir);
	unfinished = null;
	return id;
}

/** Prunes old generations after a successful activation (finding 3). */
function pruneGenerations(): void {
	const pointer = readReleasePointer(areaAbs);
	if (pointer === null) return;
	const ids = listGenerationIds(areaAbs);
	const candidates = ids.flatMap((id) => {
		const manifest = readReleaseManifest(generationLayout(areaAbs, id).manifestFile);
		return manifest === null ? [] : [{ id, builtAt: manifest.builtAt }];
	});
	// This build holds no generation itself; every live marker belongs to a
	// running instance that pruning must spare. `prod:start` writes its
	// marker once it serves a generation.
	const previous = choosePreviousGeneration(pointer, new Set(ids));
	const doomed = chooseGenerationsToPrune({
		generations: candidates,
		active: pointer.active,
		previous,
		liveHeld: liveHeldGenerations(areaAbs),
	});
	for (const id of doomed) {
		const removed = safeRemoveDir(areaAbs, generationLayout(areaAbs, id).dir);
		if (!removed.ok) {
			console.warn(`  ⚠ ${removed.error} (kept)`);
			continue;
		}
		console.log(`  pruned generation ${id}`);
	}
}
