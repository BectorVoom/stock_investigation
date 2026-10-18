/**
 * File operations for releases (ADR-0011): release generations under the
 * release area, the pointer naming the active one, the build lock that
 * serialises builds/rollbacks/pruning, holder markers recording which
 * generation a live instance serves, canonical path validation (findings 1,
 * 2), per-generation migration copies (finding 6), and rollback by pointer
 * move. `prodBuild.ts` and `prodRollback.ts` are thin entries over these
 * functions so that the behaviour is unit-tested here
 * (`tests/local/releaseOps.test.ts`) instead of only through slow
 * end-to-end builds.
 *
 * A running instance's files cannot change because a build NEVER touches an
 * existing generation: it writes a new, uniquely named directory under
 * `<area>/generations/`, validates it, makes it read-only, and only then
 * moves the atomic pointer (`current.json`, temp file + rename) to it.
 * `prod:start` reads the pointer once and serves that generation for its
 * whole life. There is deliberately NO Wrangler flag to turn watching off:
 * the installed Wrangler (4.149.0) offers none (`wrangler dev --help` lists
 * no watch flag), and its `dev.watch` configuration key is rejected with
 * "Unexpected fields found in dev field" and — verified by experiment —
 * does not stop the `--no-bundle` file watcher anyway. The guarantee rests
 * on generations never being modified, which the launcher specs prove.
 */
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import {
	DEFAULT_PREVIOUS_RELEASE_DIR,
	DEFAULT_RELEASE_DIR,
	RUST_OPTIONAL_BINARIES,
	RUST_REQUIRED_BINARIES,
	RUST_RUNNER_BINARY,
} from "./launchPlan.ts";

/** Subdirectory of the release area holding one directory per generation. */
export const GENERATIONS_DIR_NAME = "generations";
/** Pointer file in the release area naming the active generation (atomic replace). */
export const RELEASE_POINTER_FILE = "current.json";
/** Lock file in the release area serialising builds, rollbacks and pruning. */
export const RELEASE_LOCK_FILE = "build.lock";
/** Directory in the release area holding one marker per live instance. */
export const RELEASE_HOLDERS_DIR = "holders";
/** Directory inside each generation carrying the migrations it was built with. */
export const GENERATION_MIGRATIONS_DIR = "migrations";
/** How many of the newest generations a successful build keeps (ARCH-011). */
export const KEEP_GENERATIONS = 3;
/** How many activation records the pointer file keeps. */
export const POINTER_HISTORY_LIMIT = 20;
/**
 * Override flag for the owner who has checked that an older release is safe
 * against a newer database (finding 6). Named, documented, never set by code.
 */
export const ALLOW_NEWER_DB_ENV_VAR = "RESEARCH_ALLOW_NEWER_DB";
/** Build-time marker the launcher specs control (finding 13); a test hook. */
export const RELEASE_MARKER_ENV_VAR = "RESEARCH_RELEASE_MARKER";
/** Test-only hook: fail the build at the named step (`spa`, `runner`, `worker`, `finalize`). */
export const BUILD_FAIL_AT_ENV_VAR = "RESEARCH_BUILD_FAIL_AT";
/** Markers are appended to the served HTML, so only plain safe characters. */
const MARKER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * `rustc` is recorded only by a build with RESEARCH_RUNNER=rust (`rustc -V`),
 * so manifests of older generations still read (ADR-0030).
 */
const versionsSchema = z.strictObject({
	bun: z.string().min(1),
	node: z.string().min(1),
	rustc: z.string().min(1).optional(),
});

export const releaseManifestSchema = z.strictObject({
	/** ISO timestamp of `bun run prod:build`. */
	builtAt: z.string().min(1),
	/** Source revision (`git rev-parse HEAD`), or null when git could not give one. */
	revision: z.string().nullable(),
	versions: versionsSchema,
	/** Generation id: the directory name under `generations/`. */
	generation: z.string().min(1),
	/** Sorted basenames of the migration files this generation was built with. */
	migrations: z.array(z.string().min(1)),
	/** Build-time marker (finding 13); empty in normal builds. */
	marker: z.string(),
});
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

/** The pre-generations manifest shape, read only when migrating a legacy release. */
const legacyReleaseManifestSchema = z.strictObject({
	builtAt: z.string().min(1),
	revision: z.string().nullable(),
	versions: versionsSchema,
});
export type LegacyReleaseManifest = z.infer<typeof legacyReleaseManifestSchema>;

/** An unreadable or invalid manifest is the same as no release: null. */
export function readReleaseManifest(manifestFile: string): ReleaseManifest | null {
	if (!existsSync(manifestFile)) return null;
	try {
		const parsed = releaseManifestSchema.safeParse(JSON.parse(readFileSync(manifestFile, "utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Reads a pre-generations manifest; null when absent or invalid. */
export function readLegacyReleaseManifest(manifestFile: string): LegacyReleaseManifest | null {
	if (!existsSync(manifestFile)) return null;
	try {
		const parsed = legacyReleaseManifestSchema.safeParse(
			JSON.parse(readFileSync(manifestFile, "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** `RESEARCH_RELEASE_DIR` names the release area production serves (default `release/`). */
export function releaseDirFromEnv(env: Readonly<Record<string, string | undefined>>): string {
	const raw = env.RESEARCH_RELEASE_DIR?.trim() ?? "";
	return raw === "" ? DEFAULT_RELEASE_DIR : raw;
}

/**
 * `RESEARCH_PREVIOUS_RELEASE_DIR` named where the previous release was kept
 * before generations (default `release.previous/`). Kept as a setting so old
 * environments keep working: it is validated with the other directories and
 * is the legacy location `prod:build` migrates from, but nothing is ever
 * written to it anymore. Tests point it at the OS temp directory so the
 * suite never creates, modifies or deletes the repository-root
 * `release.previous/`.
 */
export function previousDirFromEnv(env: Readonly<Record<string, string | undefined>>): string {
	const raw = env.RESEARCH_PREVIOUS_RELEASE_DIR?.trim() ?? "";
	return raw === "" ? DEFAULT_PREVIOUS_RELEASE_DIR : raw;
}

export interface GenerationLayout {
	readonly id: string;
	readonly dir: string;
	readonly webDir: string;
	readonly indexFile: string;
	readonly workerDir: string;
	readonly workerBundle: string;
	readonly runnerDir: string;
	/** The Node runner bundle (`runner/main.mjs`). */
	readonly runnerBundle: string;
	/** The Rust runner binary (`runner/research-runner`). */
	readonly rustRunnerBinary: string;
	readonly wranglerConfig: string;
	readonly manifestFile: string;
	readonly migrationsDir: string;
}

/** Every path one generation writes and one running instance reads. All absolute. */
export function generationLayout(areaAbs: string, id: string): GenerationLayout {
	const dir = join(areaAbs, GENERATIONS_DIR_NAME, id);
	return {
		id,
		dir,
		webDir: join(dir, "web"),
		indexFile: join(dir, "web", "index.html"),
		workerDir: join(dir, "worker"),
		workerBundle: join(dir, "worker", "worker.js"),
		runnerDir: join(dir, "runner"),
		runnerBundle: join(dir, "runner", "main.mjs"),
		rustRunnerBinary: join(dir, "runner", RUST_RUNNER_BINARY),
		wranglerConfig: join(dir, "wrangler.jsonc"),
		manifestFile: join(dir, "manifest.json"),
		migrationsDir: join(dir, GENERATION_MIGRATIONS_DIR),
	};
}

export function generationsDir(areaAbs: string): string {
	return join(areaAbs, GENERATIONS_DIR_NAME);
}

export function pointerFile(areaAbs: string): string {
	return join(areaAbs, RELEASE_POINTER_FILE);
}

export function lockFile(areaAbs: string): string {
	return join(areaAbs, RELEASE_LOCK_FILE);
}

export const releasePointerSchema = z.strictObject({
	active: z.string().min(1),
	history: z.array(
		z.strictObject({ generation: z.string().min(1), activatedAt: z.string().min(1) }),
	),
});
export type ReleasePointer = z.infer<typeof releasePointerSchema>;

/** An unreadable or invalid pointer is the same as no release: null. */
export function readReleasePointer(areaAbs: string): ReleasePointer | null {
	const file = pointerFile(areaAbs);
	if (!existsSync(file)) return null;
	try {
		const parsed = releasePointerSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Replaces the pointer atomically: temp file in the same directory, then
 * rename (finding 4 — a crash between the two leaves the old pointer).
 */
export function writeReleasePointer(areaAbs: string, pointer: ReleasePointer): void {
	mkdirSync(areaAbs, { recursive: true });
	const tmp = join(areaAbs, `${RELEASE_POINTER_FILE}.tmp-${process.pid}`);
	writeFileSync(tmp, `${JSON.stringify(pointer, null, "\t")}\n`);
	renameSync(tmp, pointerFile(areaAbs));
}

/**
 * Names a generation active and records the activation, so "previous" stays
 * well defined for `prod:rollback`. Returns the new pointer.
 */
export function activateGeneration(
	areaAbs: string,
	generation: string,
	nowIso: string,
): ReleasePointer {
	const previous = readReleasePointer(areaAbs);
	const history = [...(previous?.history ?? []), { generation, activatedAt: nowIso }];
	const pointer: ReleasePointer = {
		active: generation,
		history: history.slice(Math.max(0, history.length - POINTER_HISTORY_LIMIT)),
	};
	writeReleasePointer(areaAbs, pointer);
	return pointer;
}

/**
 * The generation `prod:rollback` moves the pointer to: the most recent
 * activation that still exists and is not the active one. Null when there is
 * nothing to roll back to.
 */
export function choosePreviousGeneration(
	pointer: ReleasePointer,
	existing: ReadonlySet<string>,
): string | null {
	for (let index = pointer.history.length - 1; index >= 0; index -= 1) {
		const entry = pointer.history[index];
		if (entry === undefined) continue;
		if (entry.generation !== pointer.active && existing.has(entry.generation)) {
			return entry.generation;
		}
	}
	return null;
}

/** Directory names under `generations/`, sorted; empty when there are none. */
export function listGenerationIds(areaAbs: string): string[] {
	const dir = generationsDir(areaAbs);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function nonEmptyFile(file: string): boolean {
	try {
		return statSync(file).size > 0;
	} catch {
		return false;
	}
}

/** A non-empty regular file with an execute bit: what a served Rust runner must be. */
function executableFile(file: string): boolean {
	try {
		const stat = statSync(file);
		return stat.isFile() && stat.size > 0 && (stat.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * Which runners a generation contains. A generation built before the Rust
 * runner has only `runner/main.mjs`; one built with RESEARCH_RUNNER=rust only
 * the binaries. The launcher starts whatever exists (ADR-0030 transition).
 */
export function runnersInGeneration(layout: GenerationLayout): {
	readonly node: boolean;
	readonly rust: boolean;
} {
	return {
		node: nonEmptyFile(layout.runnerBundle),
		rust: RUST_REQUIRED_BINARIES.every((name) => executableFile(join(layout.runnerDir, name))),
	};
}

/** Sorted basenames of the `.sql` files in a directory; empty when unreadable. */
export function listMigrationFiles(dir: string): string[] {
	try {
		return readdirSync(dir)
			.filter((name) => name.endsWith(".sql"))
			.sort();
	} catch {
		return [];
	}
}

export type CopyMigrationsResult =
	| { readonly ok: true; readonly value: string[] }
	| { readonly ok: false; readonly error: string };

/** Copies a migration set; returns the sorted basenames the manifest records. */
export function copyMigrationFiles(fromDir: string, intoDir: string): CopyMigrationsResult {
	const names = listMigrationFiles(fromDir);
	if (names.length === 0) return { ok: false, error: `no migrations found in ${fromDir}/.` };
	try {
		mkdirSync(intoDir, { recursive: true });
		for (const name of names) copyFileSync(join(fromDir, name), join(intoDir, name));
	} catch (error) {
		return {
			ok: false,
			error: `could not copy migrations to ${intoDir}: ${error instanceof Error ? error.message : "unknown"}.`,
		};
	}
	return { ok: true, value: names };
}

export type GenerationCheck =
	| { readonly ok: true; readonly value: ReleaseManifest }
	| { readonly ok: false; readonly error: string };

/**
 * A generation counts only when it is complete (finding 4): manifest present
 * and naming this generation, Worker bundle, assets, runner bundle and the
 * manifest's migrations all present and non-empty.
 */
export function validateGeneration(layout: GenerationLayout): GenerationCheck {
	const manifest = readReleaseManifest(layout.manifestFile);
	if (manifest === null) {
		return {
			ok: false,
			error: `generation ${layout.id} has no readable manifest at ${layout.manifestFile}.`,
		};
	}
	if (manifest.generation !== layout.id) {
		return {
			ok: false,
			error: `generation ${layout.id} manifest names generation ${manifest.generation}.`,
		};
	}
	for (const file of [layout.workerBundle, layout.indexFile]) {
		if (!nonEmptyFile(file)) {
			return { ok: false, error: `generation ${layout.id} is incomplete: ${file} is missing.` };
		}
	}
	// One runner is enough: the node bundle (built by default) or the Rust
	// binaries (built with RESEARCH_RUNNER=rust). A binary that cannot be
	// executed would only fail at start, so the exec bit is checked here.
	const runners = runnersInGeneration(layout);
	if (!runners.node && !runners.rust) {
		const rustMissing = RUST_REQUIRED_BINARIES.map((name) => join(layout.runnerDir, name));
		return {
			ok: false,
			error: `generation ${layout.id} is incomplete: ${layout.runnerBundle} (or the executable ${rustMissing.join(", ")}) is missing.`,
		};
	}
	for (const name of RUST_OPTIONAL_BINARIES) {
		const file = join(layout.runnerDir, name);
		if (existsSync(file) && !executableFile(file)) {
			return {
				ok: false,
				error: `generation ${layout.id} is incomplete: ${file} is not an executable file.`,
			};
		}
	}
	if (!existsSync(layout.wranglerConfig)) {
		return {
			ok: false,
			error: `generation ${layout.id} is incomplete: ${layout.wranglerConfig} is missing.`,
		};
	}
	const onDisk = listMigrationFiles(layout.migrationsDir);
	const recorded = [...manifest.migrations].sort();
	if (onDisk.length === 0 || onDisk.join("\n") !== recorded.join("\n")) {
		return {
			ok: false,
			error:
				`generation ${layout.id} migrations do not match its manifest ` +
				`(manifest: ${recorded.join(", ") || "none"}; on disk: ${onDisk.join(", ") || "none"}).`,
		};
	}
	for (const name of recorded) {
		if (!nonEmptyFile(join(layout.migrationsDir, name))) {
			return {
				ok: false,
				error: `generation ${layout.id} is incomplete: migration ${name} is missing.`,
			};
		}
	}
	return { ok: true, value: manifest };
}

/**
 * The Wrangler configuration a running instance serves. It points at the
 * prebuilt Worker bundle with bundling disabled and at the released static
 * assets, so at run time nothing is read from `apps/`, `packages/` or
 * `dist/`. The D1 database id is the local placeholder (never a real
 * database) and migrations resolve to THIS generation's migration copy —
 * never the working tree (finding 6). `vars` restates the local operation
 * settings plus APP_ENV and the generation identity reported by
 * GET /api/v1/version.
 *
 * There is no `dev.watch: false` here on purpose: the installed Wrangler
 * rejects that key with "Unexpected fields found in dev field" and reloads
 * on file change anyway (verified by experiment), so it would only add a
 * warning. Watching stays on; the guarantee rests on generations never being
 * modified after completion (read-only below + pointer moves only).
 */
export function releaseWranglerConfig(args: {
	readonly migrationsDir: string;
	readonly generation: string;
	readonly builtAt: string;
}): string {
	const config = {
		$schema: "../node_modules/wrangler/config-schema.json",
		name: "research-workspace",
		main: "./worker/worker.js",
		compatibility_date: "2026-09-01",
		no_bundle: true,
		assets: {
			directory: "./web",
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
			APP_ENV: "production",
			RELEASE_GENERATION: args.generation,
			RELEASE_BUILT_AT: args.builtAt,
		},
	};
	return `${JSON.stringify(config, null, "\t")}\n`;
}

/**
 * The Wrangler configuration `prod:build` bundles through. Unlike
 * `infra/wrangler.jsonc` it has no `env` section — so Wrangler never warns
 * about an unspecified environment — and its `assets.directory` is the
 * generation's own web directory (just built), never `dist/web`, so a clean
 * checkout with no `dist/` builds. Absolute paths keep it correct when the
 * release area lives outside the repository (ADR-0011 test hook
 * `RESEARCH_RELEASE_DIR`). Bundling stays enabled: this config produces the
 * Worker bundle; the generation serves it with `no_bundle: true` (see
 * `releaseWranglerConfig`).
 */
export function buildWranglerConfig(args: {
	readonly workerEntry: string;
	readonly webDir: string;
	readonly migrationsDir: string;
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
		vars: { AUTH_MODE: "local-dev", OWNER_EMAIL: "owner@localhost", APP_ENV: "production" },
	};
	return `${JSON.stringify(config, null, "\t")}\n`;
}

/* ---------- Canonical paths (findings 1, 2) ---------- */

export interface CanonicalDir {
	/** The directory as given (setting value or default). */
	readonly input: string;
	/** Absolute, textually normalised path. */
	readonly absolute: string;
	/**
	 * Canonical path: symlinks on the longest existing ancestor followed
	 * (`realpath`), then the not-yet-existing rest appended. On a
	 * case-insensitive file system `realpath` returns the on-disk spelling,
	 * so case variants canonicalise equal; where the directory exists its
	 * device + inode below catch links `realpath` cannot see.
	 */
	readonly canonical: string;
	/** File-system identity where the directory exists; null otherwise. */
	readonly dev: number | null;
	readonly ino: number | null;
}

/**
 * Follows symlinks on the longest existing ancestor, then appends the
 * not-yet-existing rest (finding 1). Never throws: an unreadable ancestor
 * falls back to the normalised absolute path.
 */
export function canonicalizeDir(repoRoot: string, dir: string): CanonicalDir {
	const absolute = resolve(repoRoot, dir);
	let ancestor = absolute;
	const rest: string[] = [];
	while (!existsSync(ancestor)) {
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		rest.unshift(basename(ancestor));
		ancestor = parent;
	}
	let base: string;
	try {
		base = realpathSync(ancestor);
	} catch {
		base = ancestor;
	}
	const canonical = rest.length === 0 ? base : join(base, ...rest);
	let dev: number | null = null;
	let ino: number | null = null;
	try {
		const stat = statSync(absolute);
		dev = stat.dev;
		ino = stat.ino;
	} catch {
		dev = null;
		ino = null;
	}
	return { input: dir, absolute, canonical, dev, ino };
}

function isWithinOrEqualPath(parent: string, child: string): boolean {
	return child === parent || child.startsWith(`${parent}${sep}`);
}

export interface DirectoryEntry {
	/** Human name used in refusal messages, e.g. "production data directory". */
	readonly label: string;
	readonly dir: string;
}

export type DirectorySetCheck =
	| { readonly ok: true; readonly value: { readonly canonical: readonly CanonicalDir[] } }
	| { readonly ok: false; readonly error: string };

function directorySetFail(message: string): DirectorySetCheck {
	return { ok: false, error: message };
}

/**
 * ONE function validating the whole set of directories before any
 * destructive operation in any command (finding 2): production data,
 * development data, the release area, and the legacy previous-release
 * location. Every entry is canonicalised as in finding 1; then:
 * pairwise disjoint (no equality — by canonical spelling OR by device +
 * inode where both exist — and no containment either direction), none equal
 * to or an ancestor of the repository root, none the file-system root, none
 * the user's home directory. Every refusal names both paths.
 */
export function validateDirectorySet(
	repoRoot: string,
	entries: readonly DirectoryEntry[],
): DirectorySetCheck {
	const canonical = entries.map((entry) => canonicalizeDir(repoRoot, entry.dir));
	const repoCanonical = canonicalizeDir(repoRoot, ".").canonical;
	const homeCanonical = canonicalizeDir(repoRoot, process.env.HOME ?? "").canonical;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		const dir = canonical[index];
		if (entry === undefined || dir === undefined) continue;
		if (dir.canonical === parse(dir.canonical).root) {
			return directorySetFail(`${entry.label} (${entry.dir}) must not be the file-system root.`);
		}
		if (process.env.HOME !== undefined && dir.canonical === homeCanonical) {
			return directorySetFail(
				`${entry.label} (${entry.dir}) must not be the user's home directory (${process.env.HOME}).`,
			);
		}
		if (dir.canonical === repoCanonical || repoCanonical.startsWith(`${dir.canonical}${sep}`)) {
			return directorySetFail(
				`${entry.label} (${entry.dir}) must not be the repository root or one of its parents.`,
			);
		}
	}
	for (let first = 0; first < entries.length; first += 1) {
		for (let second = first + 1; second < entries.length; second += 1) {
			const aEntry = entries[first];
			const bEntry = entries[second];
			const a = canonical[first];
			const b = canonical[second];
			if (aEntry === undefined || bEntry === undefined || a === undefined || b === undefined) {
				continue;
			}
			const sameSpelling = a.canonical === b.canonical;
			const sameIdentity =
				a.dev !== null &&
				a.ino !== null &&
				b.dev !== null &&
				b.ino !== null &&
				a.dev === b.dev &&
				a.ino === b.ino;
			if (sameSpelling || sameIdentity) {
				return directorySetFail(
					`${aEntry.label} (${aEntry.dir}) and ${bEntry.label} (${bEntry.dir}) ` +
						`resolve to the same directory (${a.canonical}).`,
				);
			}
			if (isWithinOrEqualPath(a.canonical, b.canonical)) {
				return directorySetFail(
					`${bEntry.label} (${bEntry.dir}) must not sit inside ${aEntry.label} (${aEntry.dir}).`,
				);
			}
			if (isWithinOrEqualPath(b.canonical, a.canonical)) {
				return directorySetFail(
					`${aEntry.label} (${aEntry.dir}) must not sit inside ${bEntry.label} (${bEntry.dir}).`,
				);
			}
		}
	}
	return { ok: true, value: { canonical } };
}

/**
 * Re-checks that a destructive target is inside the validated release area
 * (finding 2). Every `rm`/`rename` in these scripts goes through the helpers
 * below, which call this first — a validated setting cannot drift into
 * deleting production data between validation and use.
 */
export function checkInsideArea(
	areaAbs: string,
	targetAbs: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
	const area = canonicalizeDir(areaAbs, ".").canonical;
	const target = canonicalizeDir(areaAbs, targetAbs).canonical;
	if (target === area || target.startsWith(`${area}${sep}`)) {
		return { ok: true, value: target };
	}
	return {
		ok: false,
		error: `refusing to touch ${targetAbs}: it is outside the release area (${areaAbs}).`,
	};
}

export type DestructiveResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: string };

/** Removes a directory strictly inside the release area (never the area itself). */
export function safeRemoveDir(areaAbs: string, targetAbs: string): DestructiveResult {
	const checked = checkInsideArea(areaAbs, targetAbs);
	if (!checked.ok) return checked;
	const area = canonicalizeDir(areaAbs, ".").canonical;
	if (checked.value === area) {
		return { ok: false, error: `refusing to delete the release area itself (${areaAbs}).` };
	}
	makeWritableBestEffort(targetAbs);
	try {
		rmSync(targetAbs, { recursive: true, force: true });
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `could not delete ${targetAbs}: ${error instanceof Error ? error.message : "unknown"}.`,
		};
	}
}

/** Renames strictly inside the release area (atomic on one file system). */
export function safeRename(areaAbs: string, fromAbs: string, toAbs: string): DestructiveResult {
	for (const target of [fromAbs, toAbs]) {
		const checked = checkInsideArea(areaAbs, target);
		if (!checked.ok) return checked;
		if (checked.value === canonicalizeDir(areaAbs, ".").canonical) {
			return { ok: false, error: `refusing to rename the release area itself (${areaAbs}).` };
		}
	}
	try {
		renameSync(fromAbs, toAbs);
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: `could not rename ${fromAbs} to ${toAbs}: ${error instanceof Error ? error.message : "unknown"}.`,
		};
	}
}

/** Best effort: make a read-only tree writable again so pruning can delete it. */
function makeWritableBestEffort(root: string): void {
	try {
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = join(dir, entry.name);
				try {
					if (entry.isDirectory()) {
						walk(full);
						chmodSync(full, 0o755);
					} else {
						chmodSync(full, 0o644);
					}
				} catch {
					// Best effort only; the delete below reports the real failure.
				}
			}
		};
		if (existsSync(root)) walk(root);
		try {
			chmodSync(root, 0o755);
		} catch {
			// Best effort only.
		}
	} catch {
		// Unreadable trees are left for the delete below to report.
	}
}

/**
 * Makes a finished generation's FILES read-only (best effort, finding 3);
 * a file that was executable (the Rust runner binaries) becomes 0555 instead
 * of 0444, which would make it unrunnable.
 * This stops accidental overwrites — a later build writing into the wrong
 * directory, an editor, a stray script — from changing what a running
 * instance serves: every served file (Worker bundle, assets, configuration,
 * manifest, migrations) loses its write bits, as do the subdirectories
 * holding them. The generation root itself stays writable on purpose:
 * `wrangler dev` creates its `.wrangler/tmp` scratch next to the served
 * configuration on every start, and a fully locked tree makes the server
 * fail with EACCES instead of serving.
 *
 * What this does NOT do: it does not stop deletion (the parent stays
 * writable, so pruning still works and `rm -rf` still deletes), it does not
 * stop the superuser (who bypasses permission checks), and it does not stop
 * the owner from chmodding the tree back. Those stay possible, which is why
 * the guarantee ALSO rests on builds never touching existing generations —
 * the pointer is the only thing that moves.
 */
export function makeGenerationReadOnly(dir: string): void {
	const isExecutable = (file: string): boolean => {
		try {
			return (statSync(file).mode & 0o111) !== 0;
		} catch {
			return false;
		}
	};
	const files: string[] = [];
	const dirs: string[] = [];
	try {
		const walk = (current: string): void => {
			dirs.push(current);
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const full = join(current, entry.name);
				if (entry.isDirectory()) walk(full);
				else files.push(full);
			}
		};
		walk(dir);
	} catch {
		return;
	}
	for (const file of files) {
		try {
			// The Rust runner binaries must stay executable (0555); everything
			// else is data (0444).
			chmodSync(file, isExecutable(file) ? 0o555 : 0o444);
		} catch {
			// Best effort only; the generation still validates.
		}
	}
	for (let index = dirs.length - 1; index >= 0; index -= 1) {
		const current = dirs[index];
		if (current === undefined || current === dir) continue;
		try {
			chmodSync(current, 0o555);
		} catch {
			// Best effort only.
		}
	}
	try {
		chmodSync(dir, 0o755);
	} catch {
		// Best effort only.
	}
}

/* ---------- Build lock (finding 4) ---------- */

const releaseLockSchema = z.strictObject({
	pid: z.number().int().positive(),
	startedAtMs: z.number(),
	hostname: z.string().min(1),
	acquiredAt: z.string().min(1),
});
export type ReleaseLock = z.infer<typeof releaseLockSchema>;

/** Injected for unit tests; the default probes the real process table. */
export interface LockProbe {
	readonly nowMs: () => number;
	readonly isProcessAlive: (pid: number) => boolean;
	readonly processStartTimeMs: (pid: number) => number | null;
	readonly log: (line: string) => void;
}

/** Start time of a process, or null when it cannot be told (fail open to liveness). */
export function realProcessStartTimeMs(pid: number): number | null {
	try {
		const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
		if (out.status !== 0) return null;
		const parsed = Date.parse(out.stdout.trim());
		return Number.isNaN(parsed) ? null : parsed;
	} catch {
		return null;
	}
}

function realIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM means the process exists but belongs to another user: alive.
		if (typeof error === "object" && error !== null && "code" in error) {
			return error.code === "EPERM";
		}
		return false;
	}
}

export function defaultLockProbe(): LockProbe {
	return {
		nowMs: () => Date.now(),
		isProcessAlive: realIsProcessAlive,
		processStartTimeMs: realProcessStartTimeMs,
		log: (line) => console.log(line),
	};
}

/** Pids can be reused: a lock is live only when its pid is alive AND its start matches. */
const LOCK_START_SKEW_MS = 120_000;

export function isLiveLock(lock: ReleaseLock, probe: LockProbe): boolean {
	if (!probe.isProcessAlive(lock.pid)) return false;
	const started = probe.processStartTimeMs(lock.pid);
	if (started === null) return true;
	return Math.abs(started - lock.startedAtMs) <= LOCK_START_SKEW_MS;
}

export type AcquireLockResult =
	| { readonly ok: true; readonly value: { readonly tookOver: boolean } }
	| { readonly ok: false; readonly error: string };

/**
 * Serialises `prod:build`, `prod:rollback` and pruning (finding 4). A lock
 * whose process is dead — recognised by pid and start time, so a reused pid
 * is not mistaken for the holder — is taken over with a log line; a live
 * holder makes the newcomer refuse.
 */
export function acquireReleaseLock(
	areaAbs: string,
	probe: LockProbe = defaultLockProbe(),
): AcquireLockResult {
	const file = lockFile(areaAbs);
	let tookOver = false;
	if (existsSync(file)) {
		try {
			const parsed = releaseLockSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
			if (parsed.success && isLiveLock(parsed.data, probe)) {
				return {
					ok: false,
					error:
						`another release operation (process ${parsed.data.pid} on ${parsed.data.hostname}, ` +
						`started ${parsed.data.acquiredAt}) holds the release lock. ` +
						`Wait for it to finish, then try again.`,
				};
			}
		} catch {
			// Unreadable locks are stale by definition; taken over below.
		}
		tookOver = true;
		probe.log("release lock: taking over a stale lock from a dead process.");
	}
	const body: ReleaseLock = {
		pid: process.pid,
		startedAtMs: probe.processStartTimeMs(process.pid) ?? probe.nowMs(),
		hostname: hostname(),
		acquiredAt: new Date(probe.nowMs()).toISOString(),
	};
	try {
		mkdirSync(areaAbs, { recursive: true });
		const tmp = join(areaAbs, `${RELEASE_LOCK_FILE}.tmp-${process.pid}`);
		writeFileSync(tmp, `${JSON.stringify(body)}\n`);
		renameSync(tmp, file);
	} catch (error) {
		return {
			ok: false,
			error: `could not take the release lock: ${error instanceof Error ? error.message : "unknown"}.`,
		};
	}
	return { ok: true, value: { tookOver } };
}

/** Releases the lock, but only when it is still ours. */
export function releaseReleaseLock(areaAbs: string, probe: LockProbe = defaultLockProbe()): void {
	const file = lockFile(areaAbs);
	if (!existsSync(file)) return;
	try {
		const parsed = releaseLockSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
		if (parsed.success && parsed.data.pid === process.pid) {
			rmSync(file, { force: true });
		} else {
			probe.log("release lock: not releasing a lock owned by another process.");
		}
	} catch {
		// Best effort: a lock file that cannot even be read is left for takeover.
	}
}

/* ---------- Holder markers (finding 3) ---------- */

const holderSchema = z.strictObject({
	pid: z.number().int().positive(),
	startedAtMs: z.number(),
	startedAt: z.string().min(1),
});
export type HolderMarker = z.infer<typeof holderSchema>;

/** Records that this process serves a generation; removed when it stops. */
export function writeHolderMarker(
	areaAbs: string,
	generation: string,
	probe: LockProbe = defaultLockProbe(),
): string {
	const dir = join(areaAbs, RELEASE_HOLDERS_DIR, generation);
	mkdirSync(dir, { recursive: true });
	const body: HolderMarker = {
		pid: process.pid,
		startedAtMs: probe.processStartTimeMs(process.pid) ?? probe.nowMs(),
		startedAt: new Date(probe.nowMs()).toISOString(),
	};
	const file = join(dir, `${process.pid}.json`);
	const tmp = join(dir, `${process.pid}.json.tmp`);
	writeFileSync(tmp, `${JSON.stringify(body)}\n`);
	renameSync(tmp, file);
	return file;
}

/** Removes this process's marker; missing markers are fine (never started / already gone). */
export function removeHolderMarker(areaAbs: string, generation: string, pid: number): void {
	rmSync(join(areaAbs, RELEASE_HOLDERS_DIR, generation, `${pid}.json`), { force: true });
	try {
		rmdirSync(join(areaAbs, RELEASE_HOLDERS_DIR, generation));
	} catch {
		// Other holders still use this generation; the directory stays.
	}
}

/** Generations with at least one marker belonging to a live process. */
export function liveHeldGenerations(
	areaAbs: string,
	probe: LockProbe = defaultLockProbe(),
): Set<string> {
	const held = new Set<string>();
	const root = join(areaAbs, RELEASE_HOLDERS_DIR);
	let generations: string[] = [];
	try {
		generations = readdirSync(root);
	} catch {
		return held;
	}
	for (const generation of generations) {
		let files: string[] = [];
		try {
			files = readdirSync(join(root, generation));
		} catch {
			continue;
		}
		for (const file of files) {
			try {
				const parsed = holderSchema.safeParse(
					JSON.parse(readFileSync(join(root, generation, file), "utf8")),
				);
				if (
					parsed.success &&
					isLiveLock(
						{
							pid: parsed.data.pid,
							startedAtMs: parsed.data.startedAtMs,
							hostname: "",
							acquiredAt: parsed.data.startedAt,
						},
						probe,
					)
				) {
					held.add(generation);
					break;
				}
			} catch {
				// Unreadable markers are ignored (a concurrent stop may remove them).
			}
		}
	}
	return held;
}

/* ---------- Pruning choice (finding 3) ---------- */

export interface PruneCandidate {
	readonly id: string;
	readonly builtAt: string;
}

/**
 * Which generations pruning may delete (pure, unit-tested): everything older
 * than the newest KEEP_GENERATIONS — but never the active one, never the
 * previous one (rollback target), never one a live instance holds. Returns
 * ids oldest-first so deletion order is deterministic.
 */
export function chooseGenerationsToPrune(args: {
	readonly generations: readonly PruneCandidate[];
	readonly active: string;
	readonly previous: string | null;
	readonly liveHeld: ReadonlySet<string>;
	readonly keep?: number;
}): readonly string[] {
	const keep = args.keep ?? KEEP_GENERATIONS;
	const sorted = [...args.generations].sort((a, b) => {
		if (a.builtAt !== b.builtAt) return a.builtAt < b.builtAt ? -1 : 1;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
	const newest = keep <= 0 ? [] : sorted.slice(Math.max(0, sorted.length - keep));
	const keepIds = new Set(newest.map((candidate) => candidate.id));
	return sorted
		.filter(
			(candidate) =>
				!keepIds.has(candidate.id) &&
				candidate.id !== args.active &&
				candidate.id !== args.previous &&
				!args.liveHeld.has(candidate.id),
		)
		.map((candidate) => candidate.id);
}

/* ---------- Migration compatibility (finding 6) ---------- */

export type MigrationCheck =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: string; readonly newerThanRelease: string[] };

/**
 * Refuses old code against a newer schema (the rollback case): every
 * migration the database already has applied must be known to this
 * generation. Additive-only migrations would often work, but the launcher
 * cannot know that, so refusing is the safe default — the owner who has
 * checked sets RESEARCH_ALLOW_NEWER_DB=1.
 */
export function checkMigrationCompatibility(args: {
	readonly generationMigrations: readonly string[];
	readonly appliedMigrations: readonly string[];
}): MigrationCheck {
	const known = new Set(args.generationMigrations);
	const newer = [...new Set(args.appliedMigrations)].filter((name) => !known.has(name)).sort();
	if (newer.length === 0) return { ok: true };
	return {
		ok: false,
		newerThanRelease: newer,
		error:
			`the database is newer than this release: it has applied migration(s) this release ` +
			`does not know (${newer.join(", ")}). Starting it could run old code against a newer ` +
			`schema. Rolling back the code does not roll back the schema — restore a backup of ` +
			`the data directory, or, only if you have checked the schema difference is safe, ` +
			`start with ${ALLOW_NEWER_DB_ENV_VAR}=1.`,
	};
}

/* ---------- Legacy releases and rollback ---------- */

/** An old-layout release: a manifest directly in the area, with no generations yet. */
export function legacyReleasePresent(areaAbs: string): boolean {
	return existsSync(join(areaAbs, "manifest.json")) && !existsSync(generationsDir(areaAbs));
}

/** UTC timestamp plus randomness: unique even for two builds in one second. */
export function newGenerationId(now: Date, randomHex: string): string {
	const stamp = now.toISOString().replaceAll("-", "").replaceAll(":", "").split(".")[0] ?? "";
	return `${stamp}Z-${randomHex}`;
}

export interface AdoptLegacyArgs {
	readonly areaAbs: string;
	/** Legacy previous-release location; adopted when it holds a manifest. */
	readonly previousAbs: string;
	/** Migration set recorded for adopted generations (they carry no copy). */
	readonly workingMigrationsDir: string;
	readonly nowIso: string;
	readonly nodeVersion: string;
	readonly randomHex: () => string;
}

export type AdoptLegacyResult =
	| {
			readonly ok: true;
			readonly value: { readonly migrated: readonly string[]; readonly active: string };
	  }
	| { readonly ok: false; readonly error: string };

/**
 * Adopts an old-layout release area into the generations model (finding 3):
 * its content moves into the first generation(s) — the legacy previous
 * release becomes the older generation so rollback history survives — and
 * the pointer is written. Nothing is ever deleted; anything ambiguous
 * refuses with instructions instead of guessing. No generations exist yet
 * when this runs; `migrated` is empty when there was no legacy release.
 */
export function adoptLegacyRelease(args: AdoptLegacyArgs): AdoptLegacyResult {
	const legacyManifest = join(args.areaAbs, "manifest.json");
	if (!existsSync(legacyManifest)) return { ok: true, value: { migrated: [], active: "" } };
	if (existsSync(join(args.areaAbs, GENERATIONS_DIR_NAME))) {
		return {
			ok: false,
			error:
				`the release area holds both generations and an old-layout release (${legacyManifest}). ` +
				`Move one of them aside by hand, then run \`bun run prod:build\` again.`,
		};
	}
	const parsed = readLegacyReleaseManifest(legacyManifest);
	if (parsed === null) {
		return {
			ok: false,
			error:
				`the release area holds an old-layout release whose manifest is unreadable ` +
				`(${legacyManifest}). Move it aside by hand, then run \`bun run prod:build\` again.`,
		};
	}
	const migrated: string[] = [];
	if (existsSync(join(args.previousAbs, "manifest.json"))) {
		const previousManifest = readLegacyReleaseManifest(join(args.previousAbs, "manifest.json"));
		if (previousManifest === null) {
			return {
				ok: false,
				error:
					`the legacy previous release has an unreadable manifest. ` +
					`Move it aside by hand, then run \`bun run prod:build\` again.`,
			};
		}
		const adopted = adoptLegacyTree({ ...args, sourceAbs: args.previousAbs, kind: "previous" });
		if (!adopted.ok) return adopted;
		migrated.push(adopted.value);
		// Only adopted content ever sat inside; drop the husk when it is empty.
		try {
			if (readdirSync(args.previousAbs).length === 0) rmdirSync(args.previousAbs);
		} catch {
			// Gone or not empty: left in place rather than risk deleting more.
		}
	}
	const adopted = adoptLegacyTree({ ...args, sourceAbs: args.areaAbs, kind: "current" });
	if (!adopted.ok) return adopted;
	migrated.push(adopted.value);
	writeReleasePointer(args.areaAbs, {
		active: adopted.value,
		history: migrated.map((generation) => ({ generation, activatedAt: args.nowIso })),
	});
	return { ok: true, value: { migrated, active: adopted.value } };
}

/** Moves an old-layout tree into a new generation directory; returns its id. */
function adoptLegacyTree(
	args: AdoptLegacyArgs & { readonly sourceAbs: string; readonly kind: string },
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: string } {
	const id = `migrated-${args.kind}-${newGenerationId(new Date(), args.randomHex()).toLowerCase()}`;
	const layout = generationLayout(args.areaAbs, id);
	try {
		mkdirSync(layout.dir, { recursive: true });
		for (const name of ["web", "worker", "runner", "wrangler.jsonc", "manifest.json"]) {
			const from = join(args.sourceAbs, name);
			if (!existsSync(from)) continue;
			renameSync(from, join(layout.dir, name));
		}
	} catch (error) {
		return {
			ok: false,
			error: `could not adopt the legacy ${args.kind} release: ${error instanceof Error ? error.message : "unknown"}.`,
		};
	}
	// A legacy release carries no migration copy: record the migrations
	// present at adoption time and copy them, so the generation validates.
	const copied = copyMigrationFiles(args.workingMigrationsDir, layout.migrationsDir);
	if (!copied.ok) return copied;
	const legacy = readLegacyReleaseManifest(layout.manifestFile);
	const manifest = {
		builtAt: legacy?.builtAt ?? args.nowIso,
		revision: legacy?.revision ?? null,
		versions: legacy?.versions ?? { bun: "unknown", node: args.nodeVersion },
		generation: id,
		migrations: copied.value,
		marker: "",
	};
	try {
		writeFileSync(layout.manifestFile, `${JSON.stringify(manifest, null, "\t")}\n`);
	} catch (error) {
		return {
			ok: false,
			error: `could not adopt the legacy ${args.kind} release: ${error instanceof Error ? error.message : "unknown"}.`,
		};
	}
	const checked = validateGeneration(layout);
	if (!checked.ok) {
		return {
			ok: false,
			error: `could not adopt the legacy ${args.kind} release: ${checked.error}`,
		};
	}
	makeGenerationReadOnly(layout.dir);
	return { ok: true, value: id };
}

export type RollbackResult =
	| { readonly ok: true; readonly value: { readonly activated: string; readonly previous: string } }
	| { readonly ok: false; readonly error: string };

/**
 * Moves the pointer to the previous generation (finding 4). Deletes nothing,
 * and never leaves the pointer naming something that does not exist: the
 * target must exist and validate first, and the pointer replace is atomic.
 */
export function rollbackRelease(repoRoot: string, releaseDir: string): RollbackResult {
	const area = resolve(repoRoot, releaseDir);
	const pointer = readReleasePointer(area);
	if (pointer === null) {
		return {
			ok: false,
			error: `no release pointer found at ${releaseDir}/${RELEASE_POINTER_FILE} (or it is unreadable). Run \`bun run prod:build\` first.`,
		};
	}
	const existing = new Set(listGenerationIds(area));
	if (!existing.has(pointer.active)) {
		return {
			ok: false,
			error:
				`the release pointer names generation ${pointer.active}, which does not exist under ` +
				`${releaseDir}/${GENERATIONS_DIR_NAME}/. Run \`bun run prod:build\` to build a fresh release.`,
		};
	}
	const previous = choosePreviousGeneration(pointer, existing);
	if (previous === null) {
		return {
			ok: false,
			error: `no previous generation found: ${pointer.active} is the only activation on record.`,
		};
	}
	const validated = validateGeneration(generationLayout(area, previous));
	if (!validated.ok) {
		return {
			ok: false,
			error: `cannot roll back to generation ${previous}: ${validated.error}`,
		};
	}
	activateGeneration(area, previous, new Date().toISOString());
	return { ok: true, value: { activated: previous, previous: pointer.active } };
}

/** Validates a build-time marker before it is appended to the served HTML. */
export function checkReleaseMarker(
	marker: string,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
	if (marker === "") return { ok: true };
	if (!MARKER_PATTERN.test(marker)) {
		return {
			ok: false,
			error: `${RELEASE_MARKER_ENV_VAR} must match ${MARKER_PATTERN} (got ${JSON.stringify(marker)}).`,
		};
	}
	return { ok: true };
}

/** Appends the build-time marker to the generation's served page (finding 13). */
export function markerHtmlComment(marker: string): string {
	return `<!-- RESEARCH_RELEASE_MARKER:${marker} -->`;
}

export type ActiveGeneration =
	| {
			readonly ok: true;
			readonly value: {
				readonly areaAbs: string;
				readonly generation: string;
				readonly generationDir: string;
				readonly manifest: ReleaseManifest;
			};
	  }
	| { readonly ok: false; readonly error: string };

/**
 * Reads the pointer ONCE and pins the generation one instance serves for its
 * whole life (finding 3). The generation must exist and validate; anything
 * else refuses with the documented "run `bun run prod:build`" message.
 */
export function resolveActiveGeneration(repoRoot: string, releaseDir: string): ActiveGeneration {
	const area = resolve(repoRoot, releaseDir);
	const pointer = readReleasePointer(area);
	if (pointer === null) {
		return {
			ok: false,
			error:
				`no release found at ${releaseDir}/ (or its pointer is unreadable). ` +
				`Run \`bun run prod:build\` first.`,
		};
	}
	if (!listGenerationIds(area).includes(pointer.active)) {
		return {
			ok: false,
			error:
				`the release pointer names generation ${pointer.active}, which does not exist under ` +
				`${releaseDir}/${GENERATIONS_DIR_NAME}/. Run \`bun run prod:build\` to build a fresh release.`,
		};
	}
	const layout = generationLayout(area, pointer.active);
	const validated = validateGeneration(layout);
	if (!validated.ok) {
		return {
			ok: false,
			error:
				`no release found at ${releaseDir}/ (generation ${pointer.active} is incomplete: ` +
				`${validated.error} Run \`bun run prod:build\` to build a fresh release.`,
		};
	}
	return {
		ok: true,
		value: {
			areaAbs: area,
			generation: pointer.active,
			generationDir: layout.dir,
			manifest: validated.value,
		},
	};
}

export type AppliedMigrationsParse =
	| { readonly ok: true; readonly value: string[] }
	| { readonly ok: false; readonly error: string };

/**
 * Parses `wrangler d1 execute … --json` for the applied-migration names
 * (finding 6). Success is `[{results: [{name}], …}]`; a database that never
 * ran a migration has no `d1_migrations` table, which parses as an empty
 * list; anything else is an error. Pure, so the odd shapes are unit-tested.
 */
export function parseAppliedMigrations(stdout: string): AppliedMigrationsParse {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout) as unknown;
	} catch {
		return { ok: false, error: "the applied-migration query did not return JSON." };
	}
	if (Array.isArray(parsed)) {
		const names: string[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "object" || entry === null || !("results" in entry)) continue;
			const results: unknown = entry.results;
			if (!Array.isArray(results)) continue;
			for (const row of results) {
				if (typeof row !== "object" || row === null || !("name" in row)) continue;
				const name: unknown = row.name;
				if (typeof name === "string" && name !== "") names.push(name);
			}
		}
		return { ok: true, value: names };
	}
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		const details: unknown = parsed.error;
		const text =
			typeof details === "object" &&
			details !== null &&
			"text" in details &&
			typeof details.text === "string"
				? details.text
				: "";
		if (text.includes("d1_migrations")) return { ok: true, value: [] };
		return {
			ok: false,
			error: `the applied-migration query failed${text === "" ? "" : `: ${text}`}.`,
		};
	}
	return { ok: false, error: "the applied-migration query returned an unexpected shape." };
}

export interface ExecuteRunner {
	readonly run: (
		command: string,
		args: readonly string[],
	) => {
		readonly status: number | null;
		readonly stdout: string;
		readonly stderr: string;
	};
}

function defaultExecuteRunner(env: NodeJS.ProcessEnv): ExecuteRunner {
	return {
		run: (command, args) => {
			const result = spawnSync(command, args, { encoding: "utf8", env });
			return {
				status: result.status,
				stdout: typeof result.stdout === "string" ? result.stdout : "",
				stderr: typeof result.stderr === "string" ? result.stderr : "",
			};
		},
	};
}

/**
 * Reads the migrations a local D1 database already has applied, through the
 * installed Wrangler: `d1 execute` against the generation's configuration
 * and the instance's state directory, selecting from the `d1_migrations`
 * journal table. Throws on anything but a readable answer (fail closed).
 */
export function readAppliedMigrations(args: {
	readonly wranglerBin: string;
	readonly database: string;
	readonly config: string;
	readonly stateDir: string;
	readonly env: NodeJS.ProcessEnv;
	readonly runner?: ExecuteRunner;
}): string[] {
	const runner = args.runner ?? defaultExecuteRunner(args.env);
	const result = runner.run(args.wranglerBin, [
		"d1",
		"execute",
		args.database,
		"--local",
		"--config",
		args.config,
		"--persist-to",
		args.stateDir,
		"--command",
		"SELECT name FROM d1_migrations ORDER BY rowid;",
		"--json",
	]);
	if (result.status !== 0) {
		throw new Error(
			`could not read the applied migrations (${result.stderr.trim() || "wrangler failed"}).`,
		);
	}
	const parsed = parseAppliedMigrations(result.stdout);
	if (!parsed.ok) throw new Error(`could not read the applied migrations (${parsed.error})`);
	return parsed.value;
}
