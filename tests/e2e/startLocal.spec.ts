import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { baseChildEnv, buildChildEnv, writeTestRunnerEnvFile } from "../../scripts/testEnv.ts";
import { E2E_PORT } from "./fixtures.ts";

/**
 * Production on this PC (`bun run prod`, ADR-0011): build a release
 * generation, then start ONLY that generation — the prebuilt Worker bundle
 * with bundling disabled, the released SPA and the released runner — against
 * its own port and throwaway directories for the release area AND the data
 * (ADR-0011: the suite never creates, modifies or deletes the repository-root
 * `release/`, `release.previous/`, `data/` or `data-dev/`). The file name sorts
 * after research.spec.ts on purpose: the immutability test below rewrites
 * dist/web, which the other suite's Worker serves.
 *
 * The generation tests below (finding 13) prove the central guarantee: a
 * running instance serves the generation it started with while newer ones
 * are built, rolled back to, or pruned around it.
 */
// One below the E2E Worker's port, so an E2E_PORT override moves both.
const PORT = E2E_PORT - 1;
const ORIGIN = `http://localhost:${PORT}`;
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const OWNER_HEADERS = { Origin: ORIGIN, "X-Research-Csrf": "1" };
const WORKSPACE_TITLE = "Kept across a restart";

test.describe.configure({ mode: "serial" });

let dataDir: string;
let releaseDir: string;
let previousDir: string;
let devDataDir: string;
let runnerEnvFile: string;
let scratchRoot: string;
let webOutDir: string;
let launcher: ChildProcess | null = null;
let output = "";

/**
 * Fully explicit throwaway environment (finding 5): every path and port the
 * launcher or runner reads is set here — never inherited from the caller's
 * environment — and the operational `apps/runner/.env` is never read.
 */
function childEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
	return buildChildEnv({
		RESEARCH_PORT: String(PORT),
		RESEARCH_DATA_DIR: dataDir,
		RESEARCH_DEV_DATA_DIR: devDataDir,
		RESEARCH_RELEASE_DIR: releaseDir,
		RESEARCH_PREVIOUS_RELEASE_DIR: previousDir,
		RESEARCH_RUNNER_ENV_FILE: runnerEnvFile,
		RUNNER_SCRATCH_ROOT: scratchRoot,
		RESEARCH_WEB_OUT_DIR: webOutDir,
		RESEARCH_DEV_PORT: String(PORT - 20),
		RESEARCH_DEV_API_PORT: String(PORT - 21),
		...extraEnv,
	});
}

/**
 * Resolves once the launcher has printed its whole ready block; rejects if it
 * exits first. The "agents:" line is printed only after the runner started by
 * THIS launcher has reported in, so tests assert on it rather than on the API's
 * "online" flag, which still describes the previous runner for a minute.
 */
function start(extraEnv: Record<string, string> = {}): Promise<void> {
	output = "";
	const child = spawn("bun", ["run", "prod:start"], {
		cwd: REPO_ROOT,
		env: childEnv(extraEnv),
		stdio: ["ignore", "pipe", "pipe"],
	});
	launcher = child;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`launcher did not become ready in time:\n${output}`)),
			150_000,
		);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.includes("stop: Ctrl+C")) {
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`launcher exited with ${code}:\n${output}`));
		});
	});
}

function stop(): Promise<number | null> {
	const child = launcher;
	launcher = null;
	if (child === null || child.exitCode !== null) return Promise.resolve(child?.exitCode ?? null);
	const exited = new Promise<number | null>((resolve) =>
		child.once("exit", (code) => resolve(code)),
	);
	child.kill("SIGINT");
	return exited;
}

test.beforeAll(() => {
	dataDir = mkdtempSync(join(tmpdir(), "research-start-data-"));
	const releaseRoot = mkdtempSync(join(tmpdir(), "research-start-release-"));
	releaseDir = join(releaseRoot, "release");
	previousDir = join(releaseRoot, "release.previous");
	devDataDir = join(releaseRoot, "data-dev");
	scratchRoot = join(releaseRoot, "scratch");
	webOutDir = join(releaseRoot, "web-out");
	// Test-owned runner settings (finding 5): the operational
	// `apps/runner/.env` is never read by a test launcher.
	runnerEnvFile = writeTestRunnerEnvFile(releaseRoot, {});
	test.setTimeout(300_000);
	const build = spawnSync("bun", ["run", "prod:build"], {
		cwd: REPO_ROOT,
		env: childEnv(),
		stdio: "pipe",
		encoding: "utf8",
		timeout: 280_000,
	});
	expect(build.status, `bun run prod:build failed:\n${build.stdout}\n${build.stderr}`).toBe(0);
});

test.afterAll(async () => {
	await stop();
	// Finished generations are read-only: make every tree writable first so
	// the throwaway directories can be deleted.
	const makeWritable = (dir: string): void => {
		let entries: { name: string; isDir: boolean }[] = [];
		try {
			entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
				name: entry.name,
				isDir: entry.isDirectory(),
			}));
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDir) makeWritable(full);
			try {
				chmodSync(full, entry.isDir ? 0o755 : 0o644);
			} catch {
				// Best effort; the rm below reports the real failure.
			}
		}
		try {
			chmodSync(dir, 0o755);
		} catch {
			// Best effort.
		}
	};
	for (const dir of [dataDir, releaseDir, previousDir]) makeWritable(dir);
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(releaseDir, { recursive: true, force: true });
	rmSync(previousDir, { recursive: true, force: true });
});

test("`bun run prod` serves the app with the owner signed in and the runner online", async ({
	page,
	request,
}) => {
	test.setTimeout(180_000);
	await start();
	expect(output).toMatch(/agents: .*claude-code/);
	// The runner credential never appears in what the launcher prints.
	expect(output).not.toMatch(/rk_[0-9a-f]{8}/);
	expect(statSync(join(dataDir, "runner-credential.json")).mode & 0o077).toBe(0);

	await page.goto(ORIGIN);
	await expect(page.getByRole("heading", { level: 1, name: "Research workspace" })).toBeVisible();
	await expect(page.locator('[data-field="session-summary"]')).toContainText("owner@localhost");
	// Production serves the built release, not the Vite dev server.
	expect(await request.get(`${ORIGIN}/`).then((response) => response.text())).not.toContain(
		"/@vite/client",
	);
	// The API reports the production environment (so the SPA shows no badge).
	const session = await (await request.get(`${ORIGIN}/api/v1/session`)).json();
	expect(session).toMatchObject({ ownerId: "owner@localhost", environment: "production" });

	const created = await page.request.post(`${ORIGIN}/api/v1/workspaces`, {
		headers: OWNER_HEADERS,
		data: { title: WORKSPACE_TITLE },
	});
	expect(created.status()).toBe(201);
});

test("the served app does not change when the working tree build output changes", async ({
	request,
}) => {
	const distIndex = join(REPO_ROOT, "dist/web/index.html");
	const original = readFileSync(distIndex, "utf8");
	const before = await (await request.get(`${ORIGIN}/`)).text();
	expect(before).not.toContain("PROD_IMMUTABILITY_MARKER");
	// A later `bun run build`, `bun run test:e2e` or source edit must not change
	// what production serves: it reads only release/, never dist/.
	writeFileSync(distIndex, `${original}\n<!-- PROD_IMMUTABILITY_MARKER -->`);
	try {
		const during = await (await request.get(`${ORIGIN}/`)).text();
		expect(during).toBe(before);
		expect(during).not.toContain("PROD_IMMUTABILITY_MARKER");
	} finally {
		writeFileSync(distIndex, original);
	}
});

test("starting without a release fails with the documented message", async () => {
	const norelRoot = mkdtempSync(join(tmpdir(), "research-norel-"));
	try {
		const missing = spawnSync("bun", ["run", "prod:start"], {
			cwd: REPO_ROOT,
			env: buildChildEnv({
				RESEARCH_PORT: String(PORT - 2),
				RESEARCH_DATA_DIR: join(norelRoot, "data"),
				RESEARCH_DEV_DATA_DIR: join(norelRoot, "data-dev"),
				RESEARCH_RELEASE_DIR: join(norelRoot, "does-not-exist-release"),
				RESEARCH_PREVIOUS_RELEASE_DIR: join(norelRoot, "does-not-exist-previous"),
				RESEARCH_RUNNER_ENV_FILE: join(norelRoot, "test-runner.env"),
				RUNNER_SCRATCH_ROOT: join(norelRoot, "scratch"),
				RESEARCH_WEB_OUT_DIR: join(norelRoot, "web-out"),
				RESEARCH_DEV_PORT: String(PORT - 22),
				RESEARCH_DEV_API_PORT: String(PORT - 23),
			}),
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(missing.status).toBe(1);
		expect(`${missing.stdout}${missing.stderr}`).toContain("bun run prod:build");
	} finally {
		rmSync(norelRoot, { recursive: true, force: true });
	}
});

test("a second launcher on the same port refuses to start and leaves the first one running", async ({
	request,
}) => {
	const second = spawn("bun", ["run", "prod:start"], {
		cwd: REPO_ROOT,
		env: childEnv(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	let message = "";
	second.stderr?.on("data", (chunk: Buffer) => {
		message += chunk.toString("utf8");
	});
	const code = await new Promise<number | null>((resolve) => second.once("exit", resolve));
	expect(code).toBe(1);
	expect(message).toContain(`port ${PORT} is already in use`);
	expect((await request.get(`${ORIGIN}/api/v1/session`)).status()).toBe(200);
});

test("stopping ends the server and the runner; a restart keeps the data and reuses the credential", async ({
	request,
}) => {
	test.setTimeout(180_000);
	expect(await stop()).toBe(0);
	await expect(request.get(`${ORIGIN}/api/v1/session`, { timeout: 2_000 })).rejects.toThrow();

	await start();
	const workspaces = await (await request.get(`${ORIGIN}/api/v1/workspaces`)).json();
	expect(workspaces.workspaces.map((workspace: { title: string }) => workspace.title)).toContain(
		WORKSPACE_TITLE,
	);
	// One credential, still active: the restart did not issue another.
	const credentials = await (await request.get(`${ORIGIN}/api/v1/runner-credentials`)).json();
	expect(credentials.credentials).toHaveLength(1);
	expect(credentials.credentials[0].revokedAt).toBeNull();
	expect(output).toMatch(/agents: .*claude-code/);
});

test("a stored token the API no longer accepts is replaced, and its credential revoked", async ({
	request,
}) => {
	test.setTimeout(180_000);
	expect(await stop()).toBe(0);
	const file = join(dataDir, "runner-credential.json");
	const stored = JSON.parse(readFileSync(file, "utf8"));
	// Same credential id, well-formed token, but not the token that was issued for it.
	writeFileSync(file, JSON.stringify({ ...stored, token: `rk_${"0".repeat(64)}` }));

	await start();
	expect(output).toMatch(/agents: .*claude-code/);
	const credentials = await (await request.get(`${ORIGIN}/api/v1/runner-credentials`)).json();
	const active = credentials.credentials.filter(
		(credential: { revokedAt: string | null }) => credential.revokedAt === null,
	);
	expect(credentials.credentials).toHaveLength(2);
	expect(active).toHaveLength(1);
	expect(active[0].credentialId).not.toBe(stored.credentialId);
});

/** The generation the release pointer names right now. */
function activeGeneration(): string {
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

function generationIds(): string[] {
	return readdirSync(join(releaseDir, "generations")).sort();
}

function versionGeneration(payload: unknown): string | null {
	if (
		typeof payload === "object" &&
		payload !== null &&
		"generation" in payload &&
		typeof payload.generation === "string"
	) {
		return payload.generation;
	}
	return null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildEnv(marker: string, failAt: string): Record<string, string> {
	return childEnv({
		RESEARCH_DATA_DIR: dataDir,
		RESEARCH_RELEASE_MARKER: marker,
		...(failAt === "" ? {} : { RESEARCH_BUILD_FAIL_AT: failAt }),
	});
}

function buildGeneration(marker: string): void {
	const built = spawnSync("bun", ["run", "prod:build"], {
		cwd: REPO_ROOT,
		env: buildEnv(marker, ""),
		stdio: "pipe",
		encoding: "utf8",
		timeout: 280_000,
	});
	expect(built.status, `prod:build ${marker} failed:\n${built.stdout}\n${built.stderr}`).toBe(0);
}

function buildGenerationExpectingFailure(marker: string, failAt: string): void {
	const built = spawnSync("bun", ["run", "prod:build"], {
		cwd: REPO_ROOT,
		env: buildEnv(marker, failAt),
		stdio: "pipe",
		encoding: "utf8",
		timeout: 280_000,
	});
	expect(built.status, `prod:build ${marker} should have failed but exited 0`).not.toBe(0);
}

function rollback(): void {
	const rolled = spawnSync("bun", ["run", "prod:rollback"], {
		cwd: REPO_ROOT,
		env: childEnv(),
		stdio: "pipe",
		encoding: "utf8",
		timeout: 60_000,
	});
	expect(rolled.status, `prod:rollback failed:\n${rolled.stdout}\n${rolled.stderr}`).toBe(0);
}

test("a build while production runs leaves the running instance on its generation", async ({
	request,
}) => {
	test.setTimeout(300_000);
	const first = activeGeneration();
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(first);
	// Generation B is observably different: its marker is baked into the API
	// report (RELEASE_GENERATION) and into the served page.
	buildGeneration("GEN-B");
	const second = activeGeneration();
	expect(second).not.toBe(first);
	// A few seconds after the activation: watchers, had anything changed
	// under the running instance, would have fired by now.
	await sleep(5_000);
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(first);
	const page = await request.get(`${ORIGIN}/`).then((response) => response.text());
	expect(page).not.toContain("RESEARCH_RELEASE_MARKER:GEN-B");

	// A rollback while running moves the pointer only; the instance is unaffected.
	rollback();
	expect(activeGeneration()).toBe(first);
	await sleep(5_000);
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(first);
	expect(await request.get(`${ORIGIN}/`).then((response) => response.text())).not.toContain(
		"RESEARCH_RELEASE_MARKER:GEN-B",
	);
});

test("the active generation's files refuse writes", async ({ request }) => {
	// Finished generations are read-only (best effort): the running
	// instance's files cannot be edited under it. Read-only stops accidental
	// overwrites — not deletion, the superuser, or chmodding back — which is
	// why the guarantee ALSO rests on builds never touching generations.
	const generation = activeGeneration();
	for (const file of ["web/index.html", "worker/worker.js"]) {
		let refused = false;
		try {
			appendFileSync(join(releaseDir, "generations", generation, file), "<!-- SNEAK -->");
		} catch {
			refused = true;
		}
		expect(refused, `writing to the running generation (${file}) must be refused`).toBe(true);
	}
	// Untouched: the instance still serves its generation.
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(generation);
});

test("pruning spares the generation a live instance holds", async ({ request }) => {
	test.setTimeout(900_000);
	const held = activeGeneration();
	// Three more builds: five generations, but the running instance still
	// serves the oldest. Only the generation that is neither newest-three,
	// active, previous nor held is pruned — the held oldest must survive
	// even though it is older than the newest three.
	buildGeneration("GEN-C");
	expect(generationIds()).toHaveLength(3);
	buildGeneration("GEN-D");
	expect(generationIds()).toHaveLength(4);
	buildGeneration("GEN-E");
	const survivors = generationIds();
	expect(survivors).toContain(held);
	expect(survivors).toHaveLength(4);
	await sleep(5_000);
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(held);
});

test("only a restart moves the running instance to the pointer", async ({ request }) => {
	test.setTimeout(300_000);
	const target = activeGeneration();
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).not.toBe(target);
	expect(await stop()).toBe(0);
	await start();
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(target);
	const manifestText = readFileSync(
		join(releaseDir, "generations", target, "manifest.json"),
		"utf8",
	);
	expect(manifestText).toContain(target);
	const manifest: unknown = JSON.parse(manifestText);
	if (
		typeof manifest !== "object" ||
		manifest === null ||
		!("marker" in manifest) ||
		typeof manifest.marker !== "string" ||
		manifest.marker === ""
	) {
		throw new Error(`generation ${target} has no marker to look for in the page.`);
	}
	const page = await request.get(`${ORIGIN}/`).then((response) => response.text());
	expect(page).toContain(`RESEARCH_RELEASE_MARKER:${manifest.marker}`);
});

test("a failed build leaves the pointer and every generation untouched", async ({ request }) => {
	test.setTimeout(300_000);
	const before = activeGeneration();
	const generationsBefore = generationIds();
	buildGenerationExpectingFailure("GEN-FAIL", "worker");
	expect(activeGeneration()).toBe(before);
	expect(generationIds()).toEqual(generationsBefore);
	// The failed build released its lock: the next command is not wedged.
	expect(existsSync(join(releaseDir, "build.lock"))).toBe(false);
	// The last good generation still starts and serves.
	expect(await stop()).toBe(0);
	await start();
	expect(
		await request
			.get(`${ORIGIN}/api/v1/version`)
			.then((r) => r.json())
			.then(versionGeneration),
	).toBe(before);
});

test("a database newer than the release refuses to start", async () => {
	test.setTimeout(300_000);
	expect(await stop()).toBe(0);
	// A migration the running generation was never built or tested with.
	const futureDir = mkdtempSync(join(tmpdir(), "research-future-migrations-"));
	try {
		const generationMigrations = join(releaseDir, "generations", activeGeneration(), "migrations");
		for (const name of readdirSync(generationMigrations)) {
			writeFileSync(join(futureDir, name), readFileSync(join(generationMigrations, name)));
		}
		writeFileSync(
			join(futureDir, "0005_future_probe.sql"),
			"CREATE TABLE future_probe (id INTEGER PRIMARY KEY);\n",
		);
		const futureConfig = join(futureDir, "wrangler.jsonc");
		writeFileSync(
			futureConfig,
			JSON.stringify({
				name: "research-workspace",
				compatibility_date: "2026-09-01",
				d1_databases: [
					{
						binding: "DB",
						database_name: "research",
						database_id: "00000000-0000-0000-0000-0000000010ca",
						migrations_dir: futureDir,
					},
				],
			}),
		);
		const applied = spawnSync(
			"node_modules/.bin/wrangler",
			[
				"d1",
				"migrations",
				"apply",
				"research",
				"--local",
				"--config",
				futureConfig,
				"--persist-to",
				join(dataDir, "d1"),
			],
			{ cwd: REPO_ROOT, env: baseChildEnv(), encoding: "utf8", timeout: 120_000 },
		);
		expect(applied.status, `future migration failed:\n${applied.stdout}\n${applied.stderr}`).toBe(
			0,
		);

		// Starting now refuses: the database knows 0005_future_probe.sql and
		// the release does not — old code against a newer schema.
		const refused = spawnSync("bun", ["run", "prod:start"], {
			cwd: REPO_ROOT,
			env: childEnv(),
			encoding: "utf8",
			timeout: 120_000,
		});
		expect(refused.status).toBe(1);
		expect(`${refused.stdout}${refused.stderr}`).toContain("database is newer than this release");
		expect(`${refused.stdout}${refused.stderr}`).toContain("0005_future_probe.sql");

		// The owner who has checked the schema difference proceeds with the
		// documented override.
		await start({ RESEARCH_ALLOW_NEWER_DB: "1" });
		expect(output).toMatch(/agents: .*claude-code/);
	} finally {
		rmSync(futureDir, { recursive: true, force: true });
	}
});
