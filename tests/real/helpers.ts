import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@research/contracts";
import { baseChildEnv, buildChildEnv } from "../../scripts/testEnv.ts";

/**
 * Shared scaffolding for the real-environment suite (`bun run test:real`):
 * a pristine copy of the working tree (tracked files with the change under
 * test, no `dist/`), throwaway data/release directories, and helpers that
 * start the real launchers and drive one real feed refresh through the real
 * runner's network path. No model quota is spent: news ingest uses only the
 * feed fetcher and parser.
 *
 * Isolation (finding 5): child environments are built with `buildChildEnv`
 * (explicit allowlist + throwaway values, never `{ ...process.env }`), and
 * the pristine copy excludes the operational `apps/runner/.env`, so neither
 * the caller's environment nor the owner's runner settings can reach a test
 * launcher. Suites pass EVERY path and port setting explicitly.
 *
 * Leaks (finding 9): `startLauncher` stops what it started before rejecting
 * (a readiness timeout kills the child first, so the caller — who never gets
 * a handle — leaks nothing), `makePristineCopy` removes its directory when
 * archiving or installing fails, and `TestResources` lets each spec register
 * clean-up at the moment a resource is created, run in `afterAll` and after
 * failures.
 */

/**
 * One registry per spec: every resource registers its clean-up at the moment
 * it is created; `close` runs them LIFO in `afterAll`, so a failure before a
 * `try/finally` (e.g. development failing to start while production runs)
 * still stops everything.
 */
export class TestResources {
	private readonly cleanups: (() => Promise<void>)[] = [];

	/** Registers clean-up at the moment the resource is created. */
	add(cleanup: () => Promise<void> | void): void {
		this.cleanups.unshift(async () => {
			await cleanup();
		});
	}

	/** Runs every registered clean-up, LIFO; one failure never skips the rest. */
	async close(): Promise<void> {
		while (this.cleanups.length > 0) {
			const next = this.cleanups.shift();
			try {
				await next?.();
			} catch (error) {
				console.error(`test cleanup failed: ${error instanceof Error ? error.message : "unknown"}`);
			}
		}
	}
}

export const REAL_FEED_URL =
	process.env.RESEARCH_REAL_FEED_URL ?? "https://www.eia.gov/rss/todayinenergy.xml";

export interface PristineCopy {
	readonly root: string;
	readonly remove: () => void;
}

/** Copies the working tree (without build output, data or dependencies) and installs. */
export function makePristineCopy(repoRoot: string): PristineCopy {
	const root = mkdtempSync(join(tmpdir(), "research-real-pristine-"));
	try {
		return archiveAndInstall(repoRoot, root);
	} catch (error) {
		// A failed archive/install leaves nothing behind (finding 9).
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function archiveAndInstall(repoRoot: string, root: string): PristineCopy {
	const args = ["-cf", "-", "."];
	for (const pattern of [
		"./dist",
		"./release",
		"./release.previous",
		"./data",
		"./data-dev",
		"./node_modules",
		"./.git",
		"./test-results",
		"./.wrangler",
		// Operational runner settings never reach a test launcher (finding 5):
		// a test that needs runner settings writes its own env file.
		"./apps/runner/.env",
	]) {
		args.unshift("--exclude", pattern);
	}
	const tar = spawnSync("tar", args, {
		cwd: repoRoot,
		encoding: "buffer",
		maxBuffer: 1_024 * 1_024 * 1_024,
		env: baseChildEnv(),
	});
	if (tar.status !== 0) throw new Error("could not archive the working tree");
	const untar = spawnSync("tar", ["-xf", "-", "-C", root], {
		input: tar.stdout,
		encoding: "buffer",
		env: baseChildEnv(),
	});
	if (untar.status !== 0) throw new Error("could not unpack the pristine copy");
	const install = spawnSync("bun", ["install"], {
		cwd: root,
		encoding: "utf8",
		timeout: 300_000,
		env: baseChildEnv(),
	});
	if (install.status !== 0) {
		throw new Error(
			`bun install failed in the pristine copy:\n${install.stdout}\n${install.stderr}`,
		);
	}
	if (existsSync(join(root, "dist"))) throw new Error("the pristine copy must have no dist/");
	if (existsSync(join(root, "apps", "runner", ".env"))) {
		throw new Error("the pristine copy must not contain the operational runner env file");
	}
	return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

export interface LaunchedService {
	readonly child: ChildProcess;
	readonly output: () => string;
	readonly stop: () => Promise<number | null>;
}

/**
 * Assembles the complete explicit environment one launcher/build spawn
 * needs: every path and port setting from a throwaway value, plus any
 * per-spawn extras (markers, overrides). `startLauncher`/`buildRelease`
 * still validate it through `buildChildEnv`, so a missing key fails fast
 * instead of falling back to an operational default.
 */
export function launcherEnv(parts: {
	readonly dataDir: string;
	readonly devDataDir: string;
	readonly releaseDir: string;
	readonly previousDir: string;
	readonly runnerEnvFile: string;
	readonly scratchRoot: string;
	readonly webOutDir: string;
	readonly prodPort: string;
	readonly devPort: string;
	readonly devApiPort: string;
	readonly extra?: Readonly<Record<string, string>>;
}): Record<string, string> {
	return {
		RESEARCH_DATA_DIR: parts.dataDir,
		RESEARCH_DEV_DATA_DIR: parts.devDataDir,
		RESEARCH_RELEASE_DIR: parts.releaseDir,
		RESEARCH_PREVIOUS_RELEASE_DIR: parts.previousDir,
		RESEARCH_RUNNER_ENV_FILE: parts.runnerEnvFile,
		RUNNER_SCRATCH_ROOT: parts.scratchRoot,
		RESEARCH_WEB_OUT_DIR: parts.webOutDir,
		RESEARCH_PORT: parts.prodPort,
		RESEARCH_DEV_PORT: parts.devPort,
		RESEARCH_DEV_API_PORT: parts.devApiPort,
		...parts.extra,
	};
}

/** Starts a launcher command and resolves once its whole ready block printed. */
export function startLauncher(options: {
	cwd: string;
	args: readonly string[];
	env: Record<string, string>;
	readyTimeoutMs?: number;
}): Promise<LaunchedService> {
	let output = "";
	const child = spawn("bun", ["run", ...options.args], {
		cwd: options.cwd,
		// Isolated by construction (finding 5): the allowlist plus the
		// suite's throwaway values, never the caller's environment.
		env: buildChildEnv(options.env),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stopChild = async (): Promise<void> => {
		if (child.exitCode !== null) return;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGINT");
		const killed = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
		]);
		if (!killed) child.kill("SIGKILL");
		await exited;
	};
	const ready = new Promise<void>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			// Finding 9: stop what was started before rejecting — the caller
			// never gets the handle, so this is the only clean-up it gets.
			// The `exit` handler below is disarmed first: the stop itself
			// must not be reported as an unexpected exit.
			void stopChild().then(() =>
				reject(new Error(`launcher did not become ready in time:\n${output}`)),
			);
		}, options.readyTimeoutMs ?? 240_000);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (!settled && output.includes("stop: Ctrl+C")) {
				settled = true;
				clearTimeout(timer);
				resolve();
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// An early exit leaves no process behind; report its output.
			reject(new Error(`launcher exited with ${code ?? signal}:\n${output}`));
		});
	});
	return ready.then(() => ({
		child,
		output: () => output,
		stop: () => {
			if (child.exitCode !== null) return Promise.resolve(child.exitCode);
			const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
			child.kill("SIGINT");
			return exited;
		},
	}));
}

/** Builds a release inside the pristine copy with a fully explicit environment. */
export function buildRelease(
	pristineRoot: string,
	env: Record<string, string>,
): { status: number | null; output: string } {
	const built = spawnSync("bun", ["run", "prod:build"], {
		cwd: pristineRoot,
		env: buildChildEnv(env),
		encoding: "utf8",
		timeout: 420_000,
	});
	return { status: built.status, output: `${built.stdout}\n${built.stderr}` };
}

/** Runs a release command (`prod:rollback`) with an isolated environment. */
export function runReleaseCommand(
	pristineRoot: string,
	script: "prod:rollback",
	env: Record<string, string>,
): { status: number | null; output: string } {
	const result = spawnSync("bun", ["run", script], {
		cwd: pristineRoot,
		env: buildChildEnv(env),
		encoding: "utf8",
		timeout: 120_000,
	});
	return { status: result.status, output: `${result.stdout}\n${result.stderr}` };
}

export function ownerHeaders(origin: string): Record<string, string> {
	return { Origin: origin, [CSRF_HEADER]: CSRF_HEADER_VALUE, "Content-Type": "application/json" };
}

export function idempotencyKey(): string {
	return `rk${crypto.randomUUID().replaceAll("-", "").slice(0, 30)}`;
}

interface ApiError extends Error {
	readonly status: number;
	readonly body: string;
}

async function api<T>(method: string, url: string, body?: unknown, key?: string): Promise<T> {
	const headers: Record<string, string> = { ...ownerHeaders(new URL(url).origin) };
	if (key !== undefined) headers["Idempotency-Key"] = key;
	const response = await fetch(url, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await response.text();
	if (response.status >= 400) {
		const error = new Error(`${method} ${url} -> ${response.status}: ${text}`) as ApiError;
		(error as { status?: number }).status = response.status;
		(error as { body?: string }).body = text;
		throw error;
	}
	return (text === "" ? null : JSON.parse(text)) as T;
}

export interface RefreshResult {
	readonly runId: string;
	readonly finalState: string;
	readonly articleCount: number;
	readonly lastErrorCode: string | null;
}

/**
 * Subscribes one real feed, triggers "Refresh news now" and waits for the
 * ingest job to finish. Resolves with the terminal state, the article count
 * and the source's stored fetch error (null when every fetch succeeded).
 */
export async function refreshRealFeed(
	origin: string,
	feedUrl: string = REAL_FEED_URL,
): Promise<RefreshResult> {
	const registered = await api<{ sourceId: string }>("POST", `${origin}/api/v1/sources`, {
		url: feedUrl,
		licensePolicy: "short-excerpt-permitted",
		trustClassification: "official",
	});
	const created = await api<{ run: { runId: string } }>(
		"POST",
		`${origin}/api/v1/sources/refresh`,
		{},
		idempotencyKey(),
	);
	const runId = created.run.runId;
	const deadline = Date.now() + 300_000;
	let state = "";
	for (;;) {
		const run = await api<{ run: { state: string } }>(
			"GET",
			`${origin}/api/v1/research-runs/${runId}`,
		);
		state = run.run.state;
		if (state === "completed" || state === "failed" || state === "cancelled") break;
		if (Date.now() > deadline) throw new Error(`ingest ${runId} did not finish in time`);
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
	const articles = await api<{ articles: readonly unknown[] }>(
		"GET",
		`${origin}/api/v1/articles?sourceId=${encodeURIComponent(registered.sourceId)}`,
	);
	const sources = await api<{ sources: { sourceId: string; lastErrorCode: string | null }[] }>(
		"GET",
		`${origin}/api/v1/sources`,
	);
	const source = sources.sources.find((entry) => entry.sourceId === registered.sourceId);
	// "SOURCE_MISSING" is the test's own sentinel for "the source is gone
	// from the list" (never a server value); a null error code is success.
	const lastErrorCode = source === undefined ? "SOURCE_MISSING" : source.lastErrorCode;
	return {
		runId,
		finalState: state,
		articleCount: articles.articles.length,
		lastErrorCode,
	};
}
