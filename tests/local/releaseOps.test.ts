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
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireReleaseLock,
	activateGeneration,
	adoptLegacyRelease,
	buildWranglerConfig,
	canonicalizeDir,
	checkInsideArea,
	checkMigrationCompatibility,
	checkReleaseMarker,
	chooseGenerationsToPrune,
	choosePreviousGeneration,
	copyMigrationFiles,
	defaultLockProbe,
	GENERATIONS_DIR_NAME,
	generationLayout,
	type HolderMarker,
	isLiveLock,
	type LockProbe,
	legacyReleasePresent,
	listGenerationIds,
	liveHeldGenerations,
	makeGenerationReadOnly,
	parseAppliedMigrations,
	previousDirFromEnv,
	type ReleaseLock,
	readAppliedMigrations,
	readLegacyReleaseManifest,
	readReleaseManifest,
	readReleasePointer,
	releaseDirFromEnv,
	releaseReleaseLock,
	releaseWranglerConfig,
	removeHolderMarker,
	resolveActiveGeneration,
	rollbackRelease,
	runnersInGeneration,
	safeRemoveDir,
	safeRename,
	validateDirectorySet,
	validateGeneration,
	writeHolderMarker,
} from "../../scripts/releaseOps.ts";

let root = "";

afterEach(() => {
	if (root !== "") {
		makeWritableTree(root);
		rmSync(root, { recursive: true, force: true });
	}
	root = "";
});

function freshRoot(): string {
	root = mkdtempSync(join(tmpdir(), "research-release-"));
	return root;
}

/** Undo read-only permissions so the teardown can delete the tree. */
function makeWritableTree(dir: string): void {
	const entries: string[] = [dir];
	try {
		const walk = (current: string): void => {
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				const full = join(current, entry.name);
				entries.push(full);
				if (entry.isDirectory()) walk(full);
			}
		};
		walk(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		try {
			chmodSync(entry, statSync(entry).isDirectory() ? 0o755 : 0o644);
		} catch {
			// Best effort; the rm below reports the real failure.
		}
	}
}

function manifestBody(
	generation: string,
	migrations: string[] = ["0001_initial.sql"],
	versions: { bun: string; node: string; rustc?: string } = { bun: "1.3.0", node: "v23.6.0" },
) {
	return {
		builtAt: "2026-10-12T00:00:00.000Z",
		revision: null,
		versions,
		generation,
		migrations,
		marker: "",
	};
}

/** A complete on-disk generation: every file validateGeneration requires. */
function writeGeneration(
	area: string,
	id: string,
	migrations: string[] = ["0001_initial.sql"],
	runners: "node" | "rust" | "both" = "node",
): void {
	const layout = generationLayout(area, id);
	mkdirSync(layout.workerDir, { recursive: true });
	mkdirSync(layout.runnerDir, { recursive: true });
	mkdirSync(layout.migrationsDir, { recursive: true });
	mkdirSync(layout.webDir, { recursive: true });
	writeFileSync(layout.workerBundle, "worker");
	if (runners !== "rust") writeFileSync(layout.runnerBundle, "runner");
	if (runners !== "node") {
		writeFileSync(layout.rustRunnerBinary, "#!/bin/sh\n", { mode: 0o755 });
		chmodSync(layout.rustRunnerBinary, 0o755);
		// Both binaries of `cargo build -p research-runner` are required (ADR-0030).
		const spawnHelper = join(layout.runnerDir, "research-provider-spawn");
		writeFileSync(spawnHelper, "#!/bin/sh\n", { mode: 0o755 });
		chmodSync(spawnHelper, 0o755);
	}
	writeFileSync(layout.indexFile, "<html></html>");
	writeFileSync(layout.wranglerConfig, "{}");
	for (const name of migrations) writeFileSync(join(layout.migrationsDir, name), "select 1;");
	writeFileSync(
		layout.manifestFile,
		JSON.stringify(
			manifestBody(
				id,
				migrations,
				runners === "node"
					? undefined
					: { bun: "1.3.0", node: "v23.6.0", rustc: "rustc 1.97.1 (8bab26f4f 2026-07-14)" },
			),
		),
	);
}

function stubProbe(overrides: Partial<LockProbe> = {}): LockProbe {
	const logged: string[] = [];
	const probe: LockProbe = {
		nowMs: () => 1_760_000_000_000,
		isProcessAlive: () => false,
		processStartTimeMs: () => null,
		log: (line) => {
			logged.push(line);
		},
		...overrides,
	};
	return probe;
}

describe("readReleaseManifest", () => {
	it("reads a valid generation manifest and refuses a missing or invalid one", () => {
		const repo = freshRoot();
		const body = manifestBody("gen-a");
		expect(readReleaseManifest(join(repo, "release/manifest.json"))).toBeNull();
		mkdirSync(join(repo, "release"), { recursive: true });
		writeFileSync(join(repo, "release/manifest.json"), JSON.stringify(body));
		expect(readReleaseManifest(join(repo, "release/manifest.json"))).toEqual(body);
		writeFileSync(join(repo, "release/manifest.json"), JSON.stringify({ ...body, revision: 42 }));
		expect(readReleaseManifest(join(repo, "release/manifest.json"))).toBeNull();
		writeFileSync(join(repo, "release/manifest.json"), "not json");
		expect(readReleaseManifest(join(repo, "release/manifest.json"))).toBeNull();
	});

	it("refuses the pre-generations shape: legacy releases migrate, never validate", () => {
		const repo = freshRoot();
		mkdirSync(join(repo, "release"), { recursive: true });
		writeFileSync(
			join(repo, "release/manifest.json"),
			JSON.stringify({
				builtAt: "2026-10-12T00:00:00.000Z",
				revision: null,
				versions: { bun: "1.3.0", node: "v23.6.0" },
			}),
		);
		expect(readReleaseManifest(join(repo, "release/manifest.json"))).toBeNull();
		expect(readLegacyReleaseManifest(join(repo, "release/manifest.json"))).toEqual({
			builtAt: "2026-10-12T00:00:00.000Z",
			revision: null,
			versions: { bun: "1.3.0", node: "v23.6.0" },
		});
	});
});

describe("releaseDirFromEnv", () => {
	it("defaults to release/ and honours RESEARCH_RELEASE_DIR", () => {
		expect(releaseDirFromEnv({})).toBe("release");
		expect(releaseDirFromEnv({ RESEARCH_RELEASE_DIR: "" })).toBe("release");
		expect(releaseDirFromEnv({ RESEARCH_RELEASE_DIR: "custom" })).toBe("custom");
	});

	it("defaults the previous release dir and honours RESEARCH_PREVIOUS_RELEASE_DIR", () => {
		expect(previousDirFromEnv({})).toBe("release.previous");
		expect(previousDirFromEnv({ RESEARCH_PREVIOUS_RELEASE_DIR: "" })).toBe("release.previous");
		expect(previousDirFromEnv({ RESEARCH_PREVIOUS_RELEASE_DIR: "/tmp/prev" })).toBe("/tmp/prev");
	});
});

describe("releaseWranglerConfig", () => {
	it("serves a prebuilt bundle with watching irrelevant, production vars and generation identity", () => {
		const parsed: unknown = JSON.parse(
			releaseWranglerConfig({
				migrationsDir: "/area/generations/gen-a/migrations",
				generation: "gen-a",
				builtAt: "2026-10-12T00:00:00.000Z",
			}),
		);
		expect(parsed).toMatchObject({
			main: "./worker/worker.js",
			no_bundle: true,
			assets: { directory: "./web" },
			vars: {
				AUTH_MODE: "local-dev",
				OWNER_EMAIL: "owner@localhost",
				APP_ENV: "production",
				RELEASE_GENERATION: "gen-a",
				RELEASE_BUILT_AT: "2026-10-12T00:00:00.000Z",
			},
		});
		const databases = (parsed as { d1_databases: { migrations_dir: string }[] }).d1_databases;
		// The generation's own migration copy, never the working tree.
		expect(databases[0]?.migrations_dir).toBe("/area/generations/gen-a/migrations");
		expect(JSON.stringify(parsed)).not.toMatch(/apps\/|packages\/|dist\/|infra\/migrations/);
	});
});

describe("buildWranglerConfig", () => {
	it("bundles only the generation being built, with no environment to choose", () => {
		const parsed: unknown = JSON.parse(
			buildWranglerConfig({
				workerEntry: "/repo/apps/api/src/worker.ts",
				webDir: "/tmp/research-abs-release/release/web",
				migrationsDir: "/repo/infra/migrations",
			}),
		);
		expect(parsed).toMatchObject({
			main: "/repo/apps/api/src/worker.ts",
			assets: { directory: "/tmp/research-abs-release/release/web" },
		});
		// Never reads the working tree's build output, and never prompts for an environment.
		expect(JSON.stringify(parsed)).not.toContain("dist/");
		expect(JSON.stringify(parsed)).not.toContain('"env"');
	});
});

describe("canonicalizeDir and validateDirectorySet (findings 1, 2)", () => {
	it("accepts four disjoint directories", () => {
		const repo = freshRoot();
		const checked = validateDirectorySet(repo, [
			{ label: "production data directory", dir: "data" },
			{ label: "development data directory", dir: "data-dev" },
			{ label: "release area", dir: "release" },
			{ label: "previous release directory", dir: "release.previous" },
		]);
		expect(checked.ok).toBe(true);
	});

	it("refuses identical directories, however they are spelled", () => {
		const repo = freshRoot();
		for (const pair of [
			["data", "data"],
			["data", "./data/"],
		] as const) {
			const checked = validateDirectorySet(repo, [
				{ label: "production data directory", dir: pair[0] },
				{ label: "development data directory", dir: pair[1] },
				{ label: "release area", dir: "release" },
				{ label: "previous release directory", dir: "release.previous" },
			]);
			expect(checked.ok).toBe(false);
			if (checked.ok) continue;
			expect(checked.error).toContain(pair[0]);
			expect(checked.error).toContain(pair[1]);
			expect(checked.error).toContain("same directory");
		}
	});

	it("refuses a symlink alias: data-dev pointing at data is the same directory", () => {
		const repo = freshRoot();
		mkdirSync(join(repo, "data"), { recursive: true });
		symlinkSync(join(repo, "data"), join(repo, "linked-dev"));
		const checked = validateDirectorySet(repo, [
			{ label: "production data directory", dir: "data" },
			{ label: "development data directory", dir: "linked-dev" },
			{ label: "release area", dir: "release" },
			{ label: "previous release directory", dir: "release.previous" },
		]);
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.error).toContain("data");
		expect(checked.error).toContain("linked-dev");
	});

	it("refuses a parent/child overlap in either direction", () => {
		const repo = freshRoot();
		for (const pair of [
			["data", "data/dev"],
			["data/dev", "data"],
		] as const) {
			const checked = validateDirectorySet(repo, [
				{ label: "production data directory", dir: pair[0] },
				{ label: "development data directory", dir: pair[1] },
				{ label: "release area", dir: "release" },
				{ label: "previous release directory", dir: "release.previous" },
			]);
			expect(checked.ok).toBe(false);
			if (checked.ok) continue;
			expect(checked.error).toContain(pair[0]);
			expect(checked.error).toContain(pair[1]);
		}
	});

	it("refuses RESEARCH_PREVIOUS_RELEASE_DIR=data: the build would delete production data", () => {
		const repo = freshRoot();
		mkdirSync(join(repo, "data"), { recursive: true });
		mkdirSync(join(repo, "release"), { recursive: true });
		const checked = validateDirectorySet(repo, [
			{ label: "production data directory", dir: "data" },
			{ label: "development data directory", dir: "data-dev" },
			{ label: "release area", dir: "release" },
			{ label: "previous release directory", dir: "data" },
		]);
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.error).toContain("data");
	});

	it("refuses both release settings naming the same directory", () => {
		const repo = freshRoot();
		const checked = validateDirectorySet(repo, [
			{ label: "production data directory", dir: "data" },
			{ label: "development data directory", dir: "data-dev" },
			{ label: "release area", dir: "shared" },
			{ label: "previous release directory", dir: "shared" },
		]);
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.error).toContain("shared");
	});

	it("refuses the release area inside a data directory", () => {
		const repo = freshRoot();
		const checked = validateDirectorySet(repo, [
			{ label: "production data directory", dir: "data" },
			{ label: "development data directory", dir: "data-dev" },
			{ label: "release area", dir: "data/release" },
			{ label: "previous release directory", dir: "release.previous" },
		]);
		expect(checked.ok).toBe(false);
	});

	it("refuses the repository root, its parents, the file-system root and home", () => {
		const repo = freshRoot();
		for (const dir of [".", "..", "/", homedir()]) {
			const checked = validateDirectorySet(repo, [
				{ label: "production data directory", dir: "data" },
				{ label: "development data directory", dir: "data-dev" },
				{ label: "release area", dir },
				{ label: "previous release directory", dir: "release.previous" },
			]);
			expect(checked.ok, dir).toBe(false);
		}
	});

	it("compares by device and inode where both directories exist", () => {
		const repo = freshRoot();
		mkdirSync(join(repo, "data"), { recursive: true });
		const canonical = canonicalizeDir(repo, "data");
		expect(canonical.dev).not.toBeNull();
		expect(canonical.ino).not.toBeNull();
		const missing = canonicalizeDir(repo, "not-created-yet");
		expect(missing.dev).toBeNull();
		// The longest existing ancestor (/var/… → /private/var/… on macOS) is
		// followed, then the not-yet-existing rest is appended.
		expect(missing.canonical).toBe(join(canonicalizeDir(repo, ".").canonical, "not-created-yet"));
	});
});

describe("checkInsideArea, safeRemoveDir, safeRename (finding 2)", () => {
	it("removes and renames inside the release area", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		mkdirSync(join(area, GENERATIONS_DIR_NAME, "old"), { recursive: true });
		writeFileSync(join(area, GENERATIONS_DIR_NAME, "old", "f"), "x");
		expect(
			safeRename(area, join(area, GENERATIONS_DIR_NAME, "old"), join(area, "renamed")).ok,
		).toBe(true);
		expect(existsSync(join(area, "renamed", "f"))).toBe(true);
		expect(safeRemoveDir(area, join(area, "renamed")).ok).toBe(true);
		expect(existsSync(join(area, "renamed"))).toBe(false);
	});

	it("refuses targets outside the release area and the area itself", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		mkdirSync(area, { recursive: true });
		mkdirSync(join(repo, "data"), { recursive: true });
		writeFileSync(join(repo, "data", "keep"), "production");
		expect(safeRemoveDir(area, join(repo, "data")).ok).toBe(false);
		expect(safeRemoveDir(area, area).ok).toBe(false);
		expect(safeRename(area, join(repo, "data"), join(area, "stolen")).ok).toBe(false);
		expect(checkInsideArea(area, join(repo, "data")).ok).toBe(false);
		// Nothing was touched.
		expect(readFileSync(join(repo, "data", "keep"), "utf8")).toBe("production");
		expect(existsSync(join(area, "stolen"))).toBe(false);
	});

	it("deletes a read-only generation tree (the prune path)", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-old");
		makeGenerationReadOnly(generationLayout(area, "gen-old").dir);
		expect(safeRemoveDir(area, generationLayout(area, "gen-old").dir)).toEqual({ ok: true });
		expect(existsSync(generationLayout(area, "gen-old").dir)).toBe(false);
	});
});

describe("pointer handling (findings 3, 4)", () => {
	it("activates generations and keeps a bounded history", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		activateGeneration(area, "gen-a", "2026-10-12T00:00:00.000Z");
		activateGeneration(area, "gen-b", "2026-10-12T01:00:00.000Z");
		const pointer = readReleasePointer(area);
		expect(pointer?.active).toBe("gen-b");
		expect(pointer?.history).toEqual([
			{ generation: "gen-a", activatedAt: "2026-10-12T00:00:00.000Z" },
			{ generation: "gen-b", activatedAt: "2026-10-12T01:00:00.000Z" },
		]);
	});

	it("finds the previous generation across pruned history entries", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		for (const id of ["gen-a", "gen-b", "gen-c"]) {
			activateGeneration(area, id, "2026-10-12T00:00:00.000Z");
		}
		const pointer = readReleasePointer(area);
		if (pointer === null) throw new Error("expected a pointer");
		// gen-b was pruned: rollback skips it and lands on gen-a.
		expect(choosePreviousGeneration(pointer, new Set(["gen-a", "gen-c"]))).toBe("gen-a");
		expect(choosePreviousGeneration(pointer, new Set(["gen-c"]))).toBeNull();
	});

	it("resolves the active generation once, refusing without a build", () => {
		const repo = freshRoot();
		const missing = resolveActiveGeneration(repo, "release");
		expect(missing.ok).toBe(false);
		if (missing.ok) return;
		expect(missing.error).toContain("bun run prod:build");
	});

	it("resolves a complete generation to its directory", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		activateGeneration(area, "gen-a", "2026-10-12T00:00:00.000Z");
		const resolved = resolveActiveGeneration(repo, "release");
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.value.generation).toBe("gen-a");
		expect(resolved.value.generationDir).toBe(generationLayout(area, "gen-a").dir);
		expect(resolved.value.manifest.generation).toBe("gen-a");
	});
});

describe("validateGeneration (finding 4)", () => {
	it("accepts a complete generation", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		const checked = validateGeneration(generationLayout(area, "gen-a"));
		expect(checked.ok).toBe(true);
	});

	it("refuses an unfinished generation: each missing piece fails", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		const layout = generationLayout(area, "gen-a");
		rmSync(layout.workerBundle);
		expect(validateGeneration(layout).ok).toBe(false);
		writeFileSync(layout.workerBundle, "worker");
		rmSync(layout.indexFile);
		expect(validateGeneration(layout).ok).toBe(false);
	});

	it("refuses a manifest naming another generation and a migration mismatch", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		const layout = generationLayout(area, "gen-a");
		writeFileSync(layout.manifestFile, JSON.stringify(manifestBody("gen-b")));
		const renamed = validateGeneration(layout);
		expect(renamed.ok).toBe(false);
		writeFileSync(layout.manifestFile, JSON.stringify(manifestBody("gen-a", ["0001_initial.sql"])));
		writeFileSync(join(layout.migrationsDir, "0002_extra.sql"), "select 2;");
		expect(validateGeneration(layout).ok).toBe(false);
	});
});

describe("validateGeneration with the Rust runner (ADR-0030)", () => {
	it("accepts a generation with only the executable binary and records rustc", () => {
		const area = join(freshRoot(), "release");
		writeGeneration(area, "gen-rust", ["0001_initial.sql"], "rust");
		const layout = generationLayout(area, "gen-rust");
		const checked = validateGeneration(layout);
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.value.versions.rustc).toBe("rustc 1.97.1 (8bab26f4f 2026-07-14)");
		expect(runnersInGeneration(layout)).toEqual({ node: false, rust: true });
	});

	it("tells which runners a generation holds (transition: old generations have only node)", () => {
		const area = join(freshRoot(), "release");
		writeGeneration(area, "gen-old", ["0001_initial.sql"], "node");
		writeGeneration(area, "gen-both", ["0001_initial.sql"], "both");
		expect(runnersInGeneration(generationLayout(area, "gen-old"))).toEqual({
			node: true,
			rust: false,
		});
		expect(runnersInGeneration(generationLayout(area, "gen-both"))).toEqual({
			node: true,
			rust: true,
		});
	});

	it("refuses a binary without the execute bit and a generation with no runner at all", () => {
		const area = join(freshRoot(), "release");
		writeGeneration(area, "gen-rust", ["0001_initial.sql"], "rust");
		const layout = generationLayout(area, "gen-rust");
		chmodSync(layout.rustRunnerBinary, 0o644);
		const refused = validateGeneration(layout);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error).toContain("research-runner");
		rmSync(layout.rustRunnerBinary);
		expect(validateGeneration(layout).ok).toBe(false);
	});

	it("refuses a companion binary that is present but not executable", () => {
		const area = join(freshRoot(), "release");
		writeGeneration(area, "gen-rust", ["0001_initial.sql"], "rust");
		const layout = generationLayout(area, "gen-rust");
		const spawnHelper = join(layout.runnerDir, "research-provider-spawn");
		writeFileSync(spawnHelper, "x", { mode: 0o644 });
		chmodSync(spawnHelper, 0o644);
		const refused = validateGeneration(layout);
		expect(refused.ok).toBe(false);
		if (!refused.ok) expect(refused.error).toContain("research-provider-spawn");
	});

	it("still reads manifests written before rustc existed", () => {
		const repo = freshRoot();
		mkdirSync(join(repo, "release"), { recursive: true });
		writeFileSync(join(repo, "release/manifest.json"), JSON.stringify(manifestBody("gen-a")));
		expect(readReleaseManifest(join(repo, "release/manifest.json"))?.versions).toEqual({
			bun: "1.3.0",
			node: "v23.6.0",
		});
	});
});

describe("rollbackRelease (finding 4)", () => {
	it("moves the pointer to the previous generation and deletes nothing", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		writeGeneration(area, "gen-b");
		activateGeneration(area, "gen-a", "2026-10-12T00:00:00.000Z");
		activateGeneration(area, "gen-b", "2026-10-12T01:00:00.000Z");
		const result = rollbackRelease(repo, "release");
		expect(result).toEqual({ ok: true, value: { activated: "gen-a", previous: "gen-b" } });
		expect(readReleasePointer(area)?.active).toBe("gen-a");
		// Both generations are still on disk: rollback deletes nothing.
		expect(listGenerationIds(area)).toEqual(["gen-a", "gen-b"]);
	});

	it("refuses without a pointer, without history and without the target", () => {
		const repo = freshRoot();
		expect(rollbackRelease(repo, "release").ok).toBe(false);

		const area = join(repo, "release");
		writeGeneration(area, "only");
		activateGeneration(area, "only", "2026-10-12T00:00:00.000Z");
		const lonely = rollbackRelease(repo, "release");
		expect(lonely.ok).toBe(false);
		if (lonely.ok) return;
		expect(lonely.error).toContain("only activation");
	});

	it("refuses when the pointer names a generation that does not exist", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		activateGeneration(area, "gen-a", "2026-10-12T00:00:00.000Z");
		rmSync(generationLayout(area, "gen-a").dir, { recursive: true });
		const result = rollbackRelease(repo, "release");
		expect(result.ok).toBe(false);
		// The pointer still names gen-a: rollback never leaves it dangling.
		expect(readReleasePointer(area)?.active).toBe("gen-a");
	});

	it("refuses a previous generation whose manifest is broken, leaving the pointer", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		writeGeneration(area, "gen-b");
		activateGeneration(area, "gen-a", "2026-10-12T00:00:00.000Z");
		activateGeneration(area, "gen-b", "2026-10-12T01:00:00.000Z");
		writeFileSync(generationLayout(area, "gen-a").manifestFile, "not json");
		const result = rollbackRelease(repo, "release");
		expect(result.ok).toBe(false);
		expect(readReleasePointer(area)?.active).toBe("gen-b");
	});
});

describe("chooseGenerationsToPrune (finding 3)", () => {
	const generations = [
		{ id: "gen-a", builtAt: "2026-10-10T00:00:00.000Z" },
		{ id: "gen-b", builtAt: "2026-10-11T00:00:00.000Z" },
		{ id: "gen-c", builtAt: "2026-10-12T00:00:00.000Z" },
		{ id: "gen-d", builtAt: "2026-10-13T00:00:00.000Z" },
		{ id: "gen-e", builtAt: "2026-10-14T00:00:00.000Z" },
	];

	it("keeps the newest three and prunes oldest-first", () => {
		expect(
			chooseGenerationsToPrune({
				generations,
				active: "gen-e",
				previous: "gen-d",
				liveHeld: new Set(),
			}),
		).toEqual(["gen-a", "gen-b"]);
	});

	it("never prunes the active, previous or live-held generations", () => {
		const six = [...generations, { id: "gen-f", builtAt: "2026-10-15T00:00:00.000Z" }];
		// Newest three are d, e, f; a is live-held, so only b and c go.
		expect(
			chooseGenerationsToPrune({
				generations: six,
				active: "gen-f",
				previous: "gen-e",
				liveHeld: new Set(["gen-a"]),
			}),
		).toEqual(["gen-b", "gen-c"]);
		// Everything protected: nothing is pruned.
		expect(
			chooseGenerationsToPrune({
				generations: generations.slice(0, 3),
				active: "gen-a",
				previous: "gen-b",
				liveHeld: new Set(["gen-c"]),
			}),
		).toEqual([]);
	});
});

describe("release lock (finding 4)", () => {
	it("is held by one process and refused to a second", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		const probe = stubProbe({
			isProcessAlive: () => true,
			processStartTimeMs: () => 1_760_000_000_000,
		});
		expect(acquireReleaseLock(area, probe)).toEqual({ ok: true, value: { tookOver: false } });
		const second = acquireReleaseLock(area, probe);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.error).toContain("holds the release lock");
		releaseReleaseLock(area, probe);
		expect(acquireReleaseLock(area, probe).ok).toBe(true);
	});

	it("takes over a stale lock from a dead process with a log line", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		const dead: ReleaseLock = {
			pid: 400_000_000,
			startedAtMs: 1_750_000_000_000,
			hostname: "old",
			acquiredAt: "2026-10-01T00:00:00.000Z",
		};
		mkdirSync(area, { recursive: true });
		writeFileSync(join(area, "build.lock"), JSON.stringify(dead));
		const logged: string[] = [];
		const probe = stubProbe({
			isProcessAlive: (pid) => pid !== dead.pid,
			log: (line) => {
				logged.push(line);
			},
		});
		expect(acquireReleaseLock(area, probe)).toEqual({ ok: true, value: { tookOver: true } });
		expect(logged.join("\n")).toContain("stale lock");
	});

	it("does not mistake a reused pid for the holder: the start time must match", () => {
		const lock: ReleaseLock = {
			pid: 1234,
			startedAtMs: 1_750_000_000_000,
			hostname: "old",
			acquiredAt: "2026-10-01T00:00:00.000Z",
		};
		expect(isLiveLock(lock, stubProbe({ isProcessAlive: () => false }))).toBe(false);
		// Alive but started long after the lock was written: a different process.
		expect(
			isLiveLock(
				lock,
				stubProbe({ isProcessAlive: () => true, processStartTimeMs: () => 1_760_000_000_000 }),
			),
		).toBe(false);
		// Alive with a matching start time: the holder.
		expect(
			isLiveLock(
				lock,
				stubProbe({ isProcessAlive: () => true, processStartTimeMs: () => 1_750_000_000_100 }),
			),
		).toBe(true);
	});

	it("takes over a corrupt lock file", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		mkdirSync(area, { recursive: true });
		writeFileSync(join(area, "build.lock"), "not json");
		expect(acquireReleaseLock(area, stubProbe()).ok).toBe(true);
	});
});

describe("holder markers (finding 3)", () => {
	it("records a live instance and forgets it when it stops", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		const probe = defaultLockProbe();
		writeHolderMarker(area, "gen-a", probe);
		expect(liveHeldGenerations(area, probe).has("gen-a")).toBe(true);
		removeHolderMarker(area, "gen-a", process.pid);
		expect(liveHeldGenerations(area, probe).has("gen-a")).toBe(false);
	});

	it("ignores markers from dead processes", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		mkdirSync(join(area, "holders", "gen-old"), { recursive: true });
		const stale: HolderMarker = {
			pid: 400_000_001,
			startedAtMs: 1,
			startedAt: "2026-01-01T00:00:00.000Z",
		};
		writeFileSync(join(area, "holders", "gen-old", "400000001.json"), JSON.stringify(stale));
		expect(liveHeldGenerations(area, stubProbe()).has("gen-old")).toBe(false);
	});
});

describe("checkMigrationCompatibility (finding 6)", () => {
	it("accepts a generation that knows every applied migration", () => {
		expect(
			checkMigrationCompatibility({
				generationMigrations: ["0001_initial.sql", "0002_owner_settings.sql"],
				appliedMigrations: ["0001_initial.sql"],
			}),
		).toEqual({ ok: true });
		expect(
			checkMigrationCompatibility({
				generationMigrations: ["0001_initial.sql"],
				appliedMigrations: [],
			}),
		).toEqual({ ok: true });
	});

	it("refuses old code against a newer schema, naming the missing migrations", () => {
		const checked = checkMigrationCompatibility({
			generationMigrations: ["0001_initial.sql"],
			appliedMigrations: ["0001_initial.sql", "0002_owner_settings.sql"],
		});
		expect(checked.ok).toBe(false);
		if (checked.ok) return;
		expect(checked.newerThanRelease).toEqual(["0002_owner_settings.sql"]);
		expect(checked.error).toContain("database is newer than this release");
		expect(checked.error).toContain("0002_owner_settings.sql");
		expect(checked.error).toContain("RESEARCH_ALLOW_NEWER_DB");
	});
});

describe("parseAppliedMigrations and readAppliedMigrations (finding 6)", () => {
	it("parses the wrangler d1 execute --json success shape", () => {
		expect(
			parseAppliedMigrations(
				JSON.stringify([
					{ results: [{ name: "0001_initial.sql" }, { name: "0002_x.sql" }], success: true },
				]),
			),
		).toEqual({ ok: true, value: ["0001_initial.sql", "0002_x.sql"] });
	});

	it("reads a fresh database as no applied migrations", () => {
		expect(
			parseAppliedMigrations(
				JSON.stringify({ error: { text: "no such table: d1_migrations: SQLITE_ERROR" } }),
			),
		).toEqual({ ok: true, value: [] });
	});

	it("refuses garbage and unexpected shapes", () => {
		expect(parseAppliedMigrations("not json").ok).toBe(false);
		expect(parseAppliedMigrations(JSON.stringify({ error: { text: "boom" } })).ok).toBe(false);
		expect(parseAppliedMigrations(JSON.stringify({})).ok).toBe(false);
	});

	it("reads through a runner and throws fail-closed", () => {
		const runner = {
			run: () => ({
				status: 0,
				stdout: JSON.stringify([{ results: [{ name: "0001_initial.sql" }] }]),
				stderr: "",
			}),
		};
		expect(
			readAppliedMigrations({
				wranglerBin: "wrangler",
				database: "research",
				config: "wrangler.jsonc",
				stateDir: "state",
				env: {},
				runner,
			}),
		).toEqual(["0001_initial.sql"]);
		expect(() =>
			readAppliedMigrations({
				wranglerBin: "wrangler",
				database: "research",
				config: "wrangler.jsonc",
				stateDir: "state",
				env: {},
				runner: { run: () => ({ status: 1, stdout: "", stderr: "nope" }) },
			}),
		).toThrow(/could not read the applied migrations/);
	});
});

describe("makeGenerationReadOnly (finding 3)", () => {
	it("removes write permission from served files, best effort", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		writeGeneration(area, "gen-a");
		const layout = generationLayout(area, "gen-a");
		makeGenerationReadOnly(layout.dir);
		expect(statSync(layout.workerBundle).mode & 0o222).toBe(0);
		expect(statSync(layout.indexFile).mode & 0o222).toBe(0);
		expect(statSync(layout.workerDir).mode & 0o222).toBe(0);
		// The root stays writable: wrangler dev creates .wrangler/tmp next
		// to the served configuration on every start (EACCES otherwise).
		expect(statSync(layout.dir).mode & 0o222).not.toBe(0);
		// Still a valid generation: read-only changes no content.
		expect(validateGeneration(layout).ok).toBe(true);
	});
});

describe("makeGenerationReadOnly keeps executables executable (ADR-0030)", () => {
	it("locks the Rust binaries to 0555 and everything else to 0444", () => {
		const area = join(freshRoot(), "release");
		writeGeneration(area, "gen-rust", ["0001_initial.sql"], "rust");
		const layout = generationLayout(area, "gen-rust");
		writeFileSync(join(layout.runnerDir, "research-provider-spawn"), "#!/bin/sh\n", {
			mode: 0o755,
		});
		makeGenerationReadOnly(layout.dir);
		expect(statSync(layout.rustRunnerBinary).mode & 0o777).toBe(0o555);
		expect(statSync(join(layout.runnerDir, "research-provider-spawn")).mode & 0o777).toBe(0o555);
		expect(statSync(layout.workerBundle).mode & 0o777).toBe(0o444);
		expect(statSync(layout.manifestFile).mode & 0o777).toBe(0o444);
		// A read-only generation is still servable: validation checks the exec bit.
		expect(validateGeneration(layout).ok).toBe(true);
	});
});

describe("legacyReleasePresent and checkReleaseMarker", () => {
	it("detects an old-layout release and ignores the generations layout", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		expect(legacyReleasePresent(area)).toBe(false);
		mkdirSync(area, { recursive: true });
		writeFileSync(join(area, "manifest.json"), "{}");
		expect(legacyReleasePresent(area)).toBe(true);
		mkdirSync(join(area, GENERATIONS_DIR_NAME), { recursive: true });
		expect(legacyReleasePresent(area)).toBe(false);
	});

	it("accepts an empty marker and safe values, refuses the rest", () => {
		expect(checkReleaseMarker("").ok).toBe(true);
		expect(checkReleaseMarker("gen-B_42").ok).toBe(true);
		expect(checkReleaseMarker("has space").ok).toBe(false);
		expect(checkReleaseMarker("a<!--b").ok).toBe(false);
	});
});

function writeLegacyTree(
	dir: string,
	builtAt: string,
	page: string,
	manifest: unknown = {
		builtAt,
		revision: null,
		versions: { bun: "1.3.0", node: "v23.6.0" },
	},
): void {
	mkdirSync(join(dir, "web"), { recursive: true });
	mkdirSync(join(dir, "worker"), { recursive: true });
	mkdirSync(join(dir, "runner"), { recursive: true });
	writeFileSync(join(dir, "web", "index.html"), page);
	writeFileSync(join(dir, "worker", "worker.js"), "worker");
	writeFileSync(join(dir, "runner", "main.mjs"), "runner");
	writeFileSync(join(dir, "wrangler.jsonc"), "{}");
	writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
}

function migrationSource(repo: string): string {
	const from = join(repo, "migrations-src");
	mkdirSync(from, { recursive: true });
	writeFileSync(join(from, "0001_initial.sql"), "select 1;");
	writeFileSync(join(from, "0002_second.sql"), "select 2;");
	return from;
}

describe("adoptLegacyRelease (finding 3)", () => {
	it("does nothing when there is no legacy release", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		mkdirSync(area, { recursive: true });
		const adopted = adoptLegacyRelease({
			areaAbs: area,
			previousAbs: join(repo, "release.previous"),
			workingMigrationsDir: migrationSource(repo),
			nowIso: "2026-10-12T00:00:00.000Z",
			nodeVersion: "v23.6.0",
			randomHex: () => "aaaaaa",
		});
		expect(adopted).toEqual({ ok: true, value: { migrated: [], active: "" } });
		expect(readReleasePointer(area)).toBeNull();
	});

	it("migrates the release and its previous into generations, deleting nothing", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		const previous = join(repo, "release.previous");
		writeLegacyTree(area, "2026-10-11T00:00:00.000Z", "<html>current</html>");
		writeLegacyTree(previous, "2026-10-10T00:00:00.000Z", "<html>previous</html>");
		const adopted = adoptLegacyRelease({
			areaAbs: area,
			previousAbs: previous,
			workingMigrationsDir: migrationSource(repo),
			nowIso: "2026-10-12T00:00:00.000Z",
			nodeVersion: "v23.6.0",
			randomHex: () => "bbbbbb",
		});
		expect(adopted.ok).toBe(true);
		if (!adopted.ok) return;
		expect(adopted.value.migrated).toHaveLength(2);
		// The current release is active; the previous one is its history.
		const pointer = readReleasePointer(area);
		expect(pointer?.active).toBe(adopted.value.active);
		expect(pointer?.history.map((entry) => entry.generation)).toEqual([...adopted.value.migrated]);
		// Content survived the move, and both generations validate.
		for (const id of adopted.value.migrated) {
			expect(validateGeneration(generationLayout(area, id)).ok).toBe(true);
		}
		const pages = adopted.value.migrated.map((id) =>
			readFileSync(join(area, GENERATIONS_DIR_NAME, id, "web", "index.html"), "utf8"),
		);
		expect(pages.sort()).toEqual(["<html>current</html>", "<html>previous</html>"]);
		// The legacy manifests are gone from the area root, the husk removed.
		expect(existsSync(join(area, "manifest.json"))).toBe(false);
		expect(existsSync(previous)).toBe(false);
		// Rolling back reaches the adopted previous release.
		expect(rollbackRelease(repo, "release").ok).toBe(true);
	});

	it("refuses mixed state and unreadable manifests with instructions", () => {
		const repo = freshRoot();
		const area = join(repo, "release");
		mkdirSync(join(area, GENERATIONS_DIR_NAME), { recursive: true });
		writeFileSync(join(area, "manifest.json"), "{}");
		const args = {
			areaAbs: area,
			previousAbs: join(repo, "release.previous"),
			workingMigrationsDir: migrationSource(repo),
			nowIso: "2026-10-12T00:00:00.000Z",
			nodeVersion: "v23.6.0",
			randomHex: () => "cccccc",
		};
		const mixed = adoptLegacyRelease(args);
		expect(mixed.ok).toBe(false);
		if (mixed.ok) return;
		expect(mixed.error).toContain("Move one of them aside");

		rmSync(join(area, GENERATIONS_DIR_NAME), { recursive: true, force: true });
		writeFileSync(join(area, "manifest.json"), "not json");
		const broken = adoptLegacyRelease(args);
		expect(broken.ok).toBe(false);
		if (broken.ok) return;
		expect(broken.error).toContain("Move it aside");
		// Nothing was adopted or deleted.
		expect(listGenerationIds(area)).toEqual([]);
		expect(existsSync(join(area, "manifest.json"))).toBe(true);
	});
});

describe("copyMigrationFiles", () => {
	it("copies the set and returns its sorted basenames", () => {
		const repo = freshRoot();
		const from = migrationSource(repo);
		const into = join(repo, "into");
		const copied = copyMigrationFiles(from, into);
		expect(copied).toEqual({ ok: true, value: ["0001_initial.sql", "0002_second.sql"] });
		expect(readFileSync(join(into, "0001_initial.sql"), "utf8")).toBe("select 1;");
		expect(copyMigrationFiles(join(repo, "missing"), into).ok).toBe(false);
	});
});
