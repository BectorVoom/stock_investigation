import { mkdtempSync, rmSync } from "node:fs";
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
	ownerHeaders,
	type PristineCopy,
	startLauncher,
	TestResources,
} from "./helpers.ts";

/**
 * Production and development run at the same time, each with its own ports
 * and data, without disturbing each other (`bun run test:real`).
 */
test.describe.configure({ mode: "serial" });

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PROD_PORT = 8895;
const PROD_ORIGIN = `http://localhost:${PROD_PORT}`;
const VITE_PORT = 8896;
const API_PORT = 8897;
const API_ORIGIN = `http://localhost:${API_PORT}`;

let pristine: PristineCopy | null = null;
let prodData = "";
let devData = "";
let releaseRoot = "";
let extraRoot = "";
let runnerEnvFile = "";
const resources = new TestResources();

test.beforeAll(() => {
	test.setTimeout(300_000);
	pristine = makePristineCopy(REPO_ROOT);
	resources.add(() => pristine?.remove());
	prodData = mkdtempSync(join(tmpdir(), "research-real-side-prod-"));
	resources.add(() => rmSync(prodData, { recursive: true, force: true }));
	devData = mkdtempSync(join(tmpdir(), "research-real-side-dev-"));
	resources.add(() => rmSync(devData, { recursive: true, force: true }));
	releaseRoot = mkdtempSync(join(tmpdir(), "research-real-side-release-"));
	resources.add(() => {
		makeWritableTree(releaseRoot);
		rmSync(releaseRoot, { recursive: true, force: true });
	});
	extraRoot = mkdtempSync(join(tmpdir(), "research-real-side-extra-"));
	resources.add(() => rmSync(extraRoot, { recursive: true, force: true }));
	// Test-owned runner settings (finding 5): the operational
	// `apps/runner/.env` is neither copied nor read.
	runnerEnvFile = writeTestRunnerEnvFile(extraRoot, {});
});

test.afterAll(() => resources.close());

test("production and development run side by side with separate data", async () => {
	test.setTimeout(600_000);
	if (pristine === null) throw new Error("the pristine copy was not created");
	const pristineRoot = pristine.root;
	const releaseDir = join(releaseRoot, "release");
	const previousDir = join(releaseRoot, "release.previous");
	const base = {
		devDataDir: devData,
		releaseDir,
		previousDir,
		runnerEnvFile,
		scratchRoot: join(extraRoot, "scratch"),
		webOutDir: join(extraRoot, "web-out"),
	} as const;
	const built = buildRelease(
		pristineRoot,
		launcherEnv({
			...base,
			dataDir: prodData,
			prodPort: String(PROD_PORT),
			devPort: "18994",
			devApiPort: "18995",
		}),
	);
	expect(built.status, `prod:build failed:\n${built.output}`).toBe(0);

	const prod = await startLauncher({
		cwd: pristineRoot,
		args: ["prod:start"],
		env: launcherEnv({
			...base,
			dataDir: prodData,
			prodPort: String(PROD_PORT),
			devPort: "18994",
			devApiPort: "18995",
		}),
	});
	// Finding 9: registered at the moment it is created, so a failure
	// starting development below still stops production in `afterAll`.
	resources.add(async () => {
		await prod.stop();
	});
	const dev = await startLauncher({
		cwd: pristineRoot,
		args: ["dev"],
		env: launcherEnv({
			...base,
			dataDir: join(extraRoot, "prod-data"),
			prodPort: "18993",
			devPort: String(VITE_PORT),
			devApiPort: String(API_PORT),
		}),
	});
	resources.add(async () => {
		await dev.stop();
	});
	try {
		expect(prod.output()).toMatch(/agents: /);
		expect(dev.output()).toMatch(/agents: /);
		const prodSession = await (await fetch(`${PROD_ORIGIN}/api/v1/session`)).json();
		const devSession = await (await fetch(`${API_ORIGIN}/api/v1/session`)).json();
		expect(prodSession).toMatchObject({ environment: "production" });
		expect(devSession).toMatchObject({ environment: "development" });

		// Separate data: a workspace created in production is invisible in development.
		const created = await (
			await fetch(`${PROD_ORIGIN}/api/v1/workspaces`, {
				method: "POST",
				headers: ownerHeaders(PROD_ORIGIN),
				body: JSON.stringify({ title: "Side by side isolation" }),
			})
		).json();
		const devWorkspaces = await (await fetch(`${API_ORIGIN}/api/v1/workspaces`)).json();
		expect(
			devWorkspaces.workspaces.map((workspace: { workspaceId: string }) => workspace.workspaceId),
		).not.toContain(created.workspaceId);
		const prodWorkspaces = await (await fetch(`${PROD_ORIGIN}/api/v1/workspaces`)).json();
		expect(
			prodWorkspaces.workspaces.map((workspace: { workspaceId: string }) => workspace.workspaceId),
		).toContain(created.workspaceId);
	} finally {
		await dev.stop();
		await prod.stop();
	}
});
