import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { makeWritableTree } from "./cleanup.ts";
import {
	buildRelease,
	launcherEnv,
	makePristineCopy,
	type PristineCopy,
	refreshRealFeed,
	runReleaseCommand,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Real-environment positive-path checks (`bun run test:real`). Everything
 * here needs the real outbound network and spends no model quota: one real,
 * stable, public catalog feed (EIA Today in Energy, overridable through
 * RESEARCH_REAL_FEED_URL) is subscribed and refreshed through the runner's
 * real network path — `POST /api/v1/sources/refresh` must complete with at
 * least one article and no fetch error.
 *
 * Ports and directories are throwaway; the owner's port 8787 and data/ are
 * never touched. A pristine copy of the working tree (no `dist/`) proves the
 * clean-checkout case for every build below.
 *
 * The generation checks (finding 13) assert generation ids, not just
 * `environment: "production"`: an instance that reloaded a rebuilt release
 * under the old test would still have passed; here it fails.
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROD_PORT = 8891;
const PROD_ORIGIN = `http://localhost:${PROD_PORT}`;
const ABS_PORT = 8894;
const ABS_ORIGIN = `http://localhost:${ABS_PORT}`;

let pristine: PristineCopy | null = null;
let dataDir = "";
let releaseRoot = "";
let extraRoot = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	dataDir = mkdtempSync(join(tmpdir(), "research-real-data-"));
	resources.add(() => {
		makeWritableTree(dataDir);
		rmSync(dataDir, { recursive: true, force: true });
	});
	releaseRoot = mkdtempSync(join(tmpdir(), "research-real-release-"));
	resources.add(() => {
		makeWritableTree(releaseRoot);
		rmSync(releaseRoot, { recursive: true, force: true });
	});
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-prod-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	// Test-owned runner settings (finding 5): the operational
	// `apps/runner/.env` is neither copied nor read.
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
});

test.afterAll(() => resources.close());

/** Fully explicit throwaway environment for prod launcher/build spawns (finding 5). */
function prodEnv(parts: {
	readonly releaseDir: string;
	readonly previousDir: string;
	readonly port: number;
	readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
	return launcherEnv({
		dataDir,
		devDataDir: join(extraRoot, "data-dev"),
		releaseDir: parts.releaseDir,
		previousDir: parts.previousDir,
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
		prodPort: String(parts.port),
		devPort: "18996",
		devApiPort: "18997",
		extra: parts.extra,
	});
}

/** The generation id the API reports; null when the Worker is not from a release. */
async function apiGeneration(origin: string): Promise<string | null> {
	const version: unknown = await (await fetch(`${origin}/api/v1/version`)).json();
	if (
		typeof version === "object" &&
		version !== null &&
		"generation" in version &&
		typeof version.generation === "string"
	) {
		return version.generation;
	}
	return null;
}

function activeGeneration(releaseDir: string): string {
	const pointer: unknown = JSON.parse(readFileSync(join(releaseDir, "current.json"), "utf8"));
	if (
		typeof pointer === "object" &&
		pointer !== null &&
		"active" in pointer &&
		typeof pointer.active === "string"
	) {
		return pointer.active;
	}
	throw new Error("the release pointer has no active generation.");
}

test("clean-checkout prod:build succeeds with no dist/ and serves a real feed refresh", async () => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const pristineRoot = pristine.root;
	const releaseDir = join(releaseRoot, "release");
	const previousDir = join(releaseRoot, "release.previous");
	const env = prodEnv({ releaseDir, previousDir, port: PROD_PORT });
	const built = buildRelease(pristineRoot, env);
	expect(built.status, `prod:build failed:\n${built.output}`).toBe(0);

	const service = await startLauncher({
		cwd: pristineRoot,
		args: ["prod:start"],
		env,
	});
	resources.add(async () => {
		await service.stop();
	});
	try {
		expect(service.output()).toMatch(/agents: /);
		const session = await (await fetch(`${PROD_ORIGIN}/api/v1/session`)).json();
		expect(session).toMatchObject({ environment: "production" });
		// The instance reports the generation it was started from.
		expect(await apiGeneration(PROD_ORIGIN)).toBe(activeGeneration(releaseDir));

		const refreshed = await refreshRealFeed(PROD_ORIGIN);
		expect(refreshed.finalState).toBe("completed");
		expect(refreshed.articleCount).toBeGreaterThanOrEqual(1);
		expect(refreshed.lastErrorCode).toBeNull();
	} finally {
		await service.stop();
	}
});

test("a running instance keeps its generation through a rebuild and a rollback", async () => {
	test.setTimeout(900_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const pristineRoot = pristine.root;
	const absRelease = join(releaseRoot, "abs", "release");
	const absPrevious = join(releaseRoot, "abs", "release.previous");
	const env = prodEnv({
		releaseDir: absRelease,
		previousDir: absPrevious,
		port: ABS_PORT,
		extra: { RESEARCH_RELEASE_MARKER: "ABS-A" },
	});
	const first = buildRelease(pristineRoot, env);
	expect(first.status, `first prod:build failed:\n${first.output}`).toBe(0);
	const generationA = activeGeneration(absRelease);

	const service = await startLauncher({ cwd: pristineRoot, args: ["prod:start"], env });
	resources.add(async () => {
		await service.stop();
	});
	try {
		expect(await apiGeneration(ABS_ORIGIN)).toBe(generationA);

		// A second, observably different build activates while running: the
		// instance keeps answering with A's id for the API and the page.
		const second = buildRelease(pristineRoot, { ...env, RESEARCH_RELEASE_MARKER: "ABS-B" });
		expect(second.status, `second prod:build failed:\n${second.output}`).toBe(0);
		const generationB = activeGeneration(absRelease);
		expect(generationB).not.toBe(generationA);
		expect(await apiGeneration(ABS_ORIGIN)).toBe(generationA);
		const page = await (await fetch(`${ABS_ORIGIN}/`)).text();
		expect(page).toContain("RESEARCH_RELEASE_MARKER:ABS-A");
		expect(page).not.toContain("RESEARCH_RELEASE_MARKER:ABS-B");
	} finally {
		await service.stop();
	}

	const rollback = runReleaseCommand(pristineRoot, "prod:rollback", env);
	expect(rollback.status, `prod:rollback failed:\n${rollback.output}`).toBe(0);
	expect(activeGeneration(absRelease)).toBe(generationA);

	// The restored generation starts again and reports itself.
	const again = await startLauncher({ cwd: pristineRoot, args: ["prod:start"], env });
	resources.add(async () => {
		await again.stop();
	});
	try {
		expect(await apiGeneration(ABS_ORIGIN)).toBe(generationA);
		const page = await (await fetch(`${ABS_ORIGIN}/`)).text();
		expect(page).toContain("RESEARCH_RELEASE_MARKER:ABS-A");
	} finally {
		await again.stop();
	}

	// And rolling forward again reaches B after a restart.
	const forward = runReleaseCommand(pristineRoot, "prod:rollback", env);
	expect(forward.status, `second prod:rollback failed:\n${forward.output}`).toBe(0);
	const last = await startLauncher({ cwd: pristineRoot, args: ["prod:start"], env });
	resources.add(async () => {
		await last.stop();
	});
	try {
		expect(await apiGeneration(ABS_ORIGIN)).not.toBe(generationA);
		const page = await (await fetch(`${ABS_ORIGIN}/`)).text();
		expect(page).toContain("RESEARCH_RELEASE_MARKER:ABS-B");
	} finally {
		await last.stop();
	}
});
