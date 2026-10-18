import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cargoTargetDirFromEnv } from "../../scripts/launchPlan.ts";

/**
 * Isolation of the E2E seams in the Rust workspace (ADR-0030, rr-spec-shell-wire
 * section 10.2). The production binary `research-runner` must be unable to
 * contain the test seams of `research-runner-testkit`, by construction:
 *
 * 1. no path of normal or build dependencies leads from `research-runner` to
 *    `research-runner-testkit`, whatever features are enabled;
 * 2. no dependency of the production closure turns on a `test-seams` feature;
 * 3. nobody but the testkit's own binary depends on the testkit;
 * 4. the release `research-runner` binary contains none of the testkit's marker
 *    strings (mirrors the CI "no secrets in built assets" grep).
 *
 * Plus the dependency direction of the pure core (domain, js, contracts).
 */
const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUNNER = "research-runner";
const TESTKIT = "research-runner-testkit";

const dependencySchema = z.object({
	name: z.string(),
	kind: z.enum(["dev", "build"]).nullable(),
	features: z.array(z.string()),
	path: z.string().optional(),
});
const packageSchema = z.object({
	id: z.string(),
	name: z.string(),
	dependencies: z.array(dependencySchema),
});
const metadataSchema = z.object({
	packages: z.array(packageSchema),
	workspace_members: z.array(z.string()),
	resolve: z.object({
		nodes: z.array(
			z.object({
				id: z.string(),
				deps: z.array(
					z.object({
						pkg: z.string(),
						dep_kinds: z.array(z.object({ kind: z.string().nullable() })),
					}),
				),
			}),
		),
	}),
});
type Metadata = z.infer<typeof metadataSchema>;

function run(command: string, args: readonly string[]): string {
	return execFileSync(command, [...args], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * `cargo metadata` with every feature of every workspace crate on ("any
 * feature set"), restricted to the host platform so an offline machine does
 * not need the registry sources of other targets.
 */
function loadMetadata(): Metadata {
	const host = /^host: (.+)$/m.exec(run("rustc", ["-vV"]))?.[1];
	if (host === undefined) throw new Error("rustc -vV names no host triple");
	const text = run("cargo", [
		"metadata",
		"--format-version",
		"1",
		"--offline",
		"--locked",
		"--all-features",
		"--filter-platform",
		host,
	]);
	return metadataSchema.parse(JSON.parse(text));
}

const metadata = loadMetadata();
const nameOf = new Map(metadata.packages.map((entry) => [entry.id, entry.name]));

/** Package names reachable from `root` over normal (and build) edges only. */
function productionClosure(root: string): Set<string> {
	const rootId = metadata.packages.find((entry) => entry.name === root)?.id;
	if (rootId === undefined) throw new Error(`${root} is not in the workspace`);
	const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
	const seen = new Set<string>([rootId]);
	const queue = [rootId];
	for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
		for (const dep of nodes.get(id)?.deps ?? []) {
			// `kind: null` is a normal dependency; "dev" edges never ship.
			const ships = dep.dep_kinds.some((kind) => kind.kind !== "dev");
			if (ships && !seen.has(dep.pkg)) {
				seen.add(dep.pkg);
				queue.push(dep.pkg);
			}
		}
	}
	return new Set([...seen].map((id) => nameOf.get(id) ?? id));
}

function workspaceDependencies(name: string): string[] {
	const members = new Set(metadata.workspace_members);
	const workspaceNames = new Set(
		metadata.packages.filter((entry) => members.has(entry.id)).map((entry) => entry.name),
	);
	const entry = metadata.packages.find((candidate) => candidate.name === name);
	return (entry?.dependencies ?? [])
		.filter((dep) => dep.kind === null && workspaceNames.has(dep.name))
		.map((dep) => dep.name)
		.sort();
}

describe("test seams cannot reach the production runner (ADR-0030)", () => {
	const closure = productionClosure(RUNNER);

	it("the production runner reaches the whole pipeline but never the testkit", () => {
		expect(closure.has("research-providers")).toBe(true);
		expect(closure.has(TESTKIT)).toBe(false);
	});

	it("no production dependency enables a test-seams feature", () => {
		const offenders = metadata.packages
			.filter((entry) => closure.has(entry.name))
			.flatMap((entry) =>
				entry.dependencies
					.filter((dep) => dep.kind === null && dep.features.some((f) => f.includes("test-seams")))
					.map((dep) => `${entry.name} -> ${dep.name} [${dep.features.join(",")}]`),
			);
		expect(offenders).toEqual([]);
	});

	it("the runner declares no test-seams feature of its own", () => {
		const manifest = readFileSync(join(REPO_ROOT, "crates", RUNNER, "Cargo.toml"), "utf8");
		expect(manifest).not.toMatch(/test-seams/);
	});

	it("nothing depends on the testkit", () => {
		const dependents = metadata.packages
			.filter((entry) => entry.dependencies.some((dep) => dep.name === TESTKIT))
			.map((entry) => entry.name);
		expect(dependents).toEqual([]);
	});

	it("the testkit depends on the runner library, not the other way round", () => {
		expect(workspaceDependencies(TESTKIT)).toContain(RUNNER);
		expect(workspaceDependencies(RUNNER)).not.toContain(TESTKIT);
	});
});

describe("the pure core keeps its dependency direction", () => {
	it("research-js depends on no workspace crate", () => {
		expect(workspaceDependencies("research-js")).toEqual([]);
	});
	it("research-domain depends only on research-js", () => {
		expect(workspaceDependencies("research-domain")).toEqual(["research-js"]);
	});
	it("research-contracts depends only on domain and js", () => {
		expect(workspaceDependencies("research-contracts")).toEqual(["research-domain", "research-js"]);
	});
	it("only the runner and the testkit compose the provider adapters", () => {
		const users = metadata.packages
			.filter((entry) =>
				entry.dependencies.some((dep) => dep.kind === null && dep.name === "research-providers"),
			)
			.map((entry) => entry.name)
			.sort();
		expect(users).toEqual([RUNNER, TESTKIT]);
	});
});

/** Strings that exist only because of the E2E seams. */
const TESTKIT_MARKERS = [
	"X-E2E-Owner",
	"E2E_RUNNER_OWNER",
	"e2e-google-unconfigured",
	"scripted/alpha",
] as const;

/** The markers found in `binary` (searched as raw bytes, like `grep -a`). */
function findMarkers(binary: Buffer): string[] {
	return TESTKIT_MARKERS.filter((marker) => binary.includes(marker));
}

describe("the marker scan", () => {
	it("finds each marker in bytes and reports nothing in clean bytes", () => {
		const dirty = Buffer.from(`\0\0${TESTKIT_MARKERS.join("\0")}\0`);
		expect(findMarkers(dirty)).toEqual([...TESTKIT_MARKERS]);
		expect(findMarkers(Buffer.from("research-runner is clean"))).toEqual([]);
	});

	const targetDir = cargoTargetDirFromEnv(process.env, REPO_ROOT);
	const e2eBinary = join(targetDir, "debug", "research-runner-e2e");
	const releaseBinary = join(targetDir, "release", RUNNER);

	// Proves the scan can see Rust string literals at all: a clean release
	// result would otherwise prove nothing.
	it.skipIf(!existsSync(e2eBinary))("sees the markers in the E2E runner binary", () => {
		const found = findMarkers(readFileSync(e2eBinary));
		expect(found).toContain("X-E2E-Owner");
		expect(found).toContain("E2E_RUNNER_OWNER");
		expect(found).toContain("e2e-google-unconfigured");
	});

	// Needs `cargo build --release --locked -p research-runner` first (minutes
	// and gigabytes of target/, so it is not built by the unit-test run).
	it.skipIf(!existsSync(releaseBinary))(
		"the release research-runner binary contains no testkit marker",
		() => {
			expect(findMarkers(readFileSync(releaseBinary))).toEqual([]);
		},
	);
});
