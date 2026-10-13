import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CSRF_HEADER, CSRF_HEADER_VALUE } from "@research/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { planLaunch, readLaunchInputs } from "../../scripts/launchPlan.ts";
import { buildChildEnv, newTestDirs } from "../../scripts/testEnv.ts";

/**
 * FR-018 item 1: the calendar subscription token travels in a URL path, and
 * `wrangler dev` (which serves the API in both launch plans) prints one line
 * per request with the expanded path. Both plans therefore run wrangler with
 * `--log-level warn`, which drops those per-request info lines while the
 * Worker's own console.error event lines still reach the server log.
 *
 * This test starts the PLANNED server command on a throwaway port and data
 * directory, issues a feed token, fetches the feed, and asserts the token
 * string is absent from every file under the log directory — while a forced
 * Worker log event proves worker-side logging still works.
 */
const children: ChildProcess[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode !== null) continue;
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		try {
			if (process.platform !== "win32" && child.pid !== undefined) {
				process.kill(-child.pid, "SIGTERM");
			} else {
				child.kill("SIGTERM");
			}
		} catch {
			// Already gone; the wait below observes it.
		}
		const done = await Promise.race([
			exited.then(() => true),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8_000)),
		]);
		if (!done) {
			try {
				if (process.platform !== "win32" && child.pid !== undefined) {
					process.kill(-child.pid, "SIGKILL");
				} else {
					child.kill("SIGKILL");
				}
			} catch {
				// Best effort; the test run ends regardless.
			}
			await exited;
		}
	}
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function listFilesRecursive(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full));
		else out.push(full);
	}
	return out;
}

describe("calendar feed token never reaches the server log (FR-018 item 1)", () => {
	it("serves the feed from the planned command with no token in any log file", async () => {
		const repoRoot = process.cwd();
		const dirs = newTestDirs("research-feedlog-");
		const prodPort = "18921";
		const devPort = "13922";
		const devApiPort = "18923";
		const childEnv = buildChildEnv({
			RESEARCH_DATA_DIR: dirs.dataDir,
			RESEARCH_DEV_DATA_DIR: dirs.devDataDir,
			RESEARCH_RELEASE_DIR: dirs.releaseDir,
			RESEARCH_PREVIOUS_RELEASE_DIR: dirs.previousDir,
			RESEARCH_RUNNER_ENV_FILE: dirs.runnerEnvFile,
			RUNNER_SCRATCH_ROOT: dirs.scratchRoot,
			RESEARCH_WEB_OUT_DIR: dirs.webOutDir,
			RESEARCH_PORT: prodPort,
			RESEARCH_DEV_PORT: devPort,
			RESEARCH_DEV_API_PORT: devApiPort,
		});
		const parsed = readLaunchInputs("development", childEnv, repoRoot, process.execPath);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const planned = planLaunch(parsed.value);
		expect(planned.ok).toBe(true);
		if (!planned.ok) return;
		const plan = planned.value;
		// Never the owner's ports or data directories.
		for (const listen of plan.listenPorts) {
			expect([8787, 8788, 3000]).not.toContain(listen.port);
		}
		expect(plan.dataDir.startsWith(dirs.root)).toBe(true);
		expect(["/data", "/data-dev"]).not.toContain(plan.dataDir);
		const server = plan.processes.find((process) => process.name === "server");
		expect(server).toBeDefined();
		if (server === undefined) return;
		// The mechanism under test: wrangler runs below info level.
		expect(server.args).toContain("--log-level");
		const levelIndex = server.args.indexOf("--log-level");
		expect(server.args[levelIndex + 1]).toBe("warn");

		mkdirSync(plan.logDir, { recursive: true });
		if (plan.devWrangler !== null) {
			mkdirSync(plan.devWrangler.webDir, { recursive: true });
			writeFileSync(plan.devWrangler.file, plan.devWrangler.content);
		}
		const migrated = spawnSync(
			server.command,
			[
				"d1",
				"migrations",
				"apply",
				"research",
				"--local",
				"--config",
				plan.migrations.config,
				"--persist-to",
				plan.migrations.stateDir,
			],
			{ cwd: repoRoot, env: childEnv, encoding: "utf8", timeout: 120_000 },
		);
		writeFileSync(plan.buildLog, `$ migrate\n${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}\n`);
		expect(migrated.status).toBe(0);

		const logFd = openSync(server.logFile, "w");
		const child = spawn(server.command, [...server.args], {
			cwd: repoRoot,
			stdio: ["ignore", logFd, logFd],
			env: { ...childEnv, ...server.extraEnv },
			detached: process.platform !== "win32",
		});
		children.push(child);

		const apiOrigin = plan.apiOrigin;
		const sessionDeadline = Date.now() + 60_000;
		let ready = false;
		while (Date.now() < sessionDeadline) {
			if (child.exitCode !== null) {
				throw new Error(`planned server exited early:\n${readFileSync(server.logFile, "utf8")}`);
			}
			try {
				const response = await fetch(`${apiOrigin}/api/v1/session`);
				const json: unknown = await response.json().catch(() => null);
				if (
					response.status === 200 &&
					typeof json === "object" &&
					json !== null &&
					(json as { authMode?: unknown }).authMode === "local-dev"
				) {
					ready = true;
					break;
				}
			} catch {
				// Not listening yet.
			}
			await sleep(300);
		}
		expect(ready).toBe(true);

		const ownerHeaders = {
			Origin: apiOrigin,
			[CSRF_HEADER]: CSRF_HEADER_VALUE,
			"Content-Type": "application/json",
		};
		const added = await fetch(`${apiOrigin}/api/v1/watchlist/stocks`, {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({ market: "US", symbol: "AAPL" }),
		});
		expect(added.status).toBe(200);
		const issueResponse = await fetch(`${apiOrigin}/api/v1/watchlist/feed`, {
			method: "POST",
			headers: ownerHeaders,
		});
		expect(issueResponse.status).toBe(201);
		const issued = (await issueResponse.json()) as { token?: unknown; path?: unknown };
		expect(typeof issued.token).toBe("string");
		const token = issued.token as string;
		expect(token.length).toBeGreaterThanOrEqual(40);

		const feed = await fetch(`${apiOrigin}/api/v1/calendar-feed/${token}/earnings.ics`);
		expect(feed.status).toBe(200);
		const missing = await fetch(
			`${apiOrigin}/api/v1/calendar-feed/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/earnings.ics`,
		);
		expect(missing.status).toBe(404);

		for (const file of listFilesRecursive(plan.logDir)) {
			expect(readFileSync(file, "utf8")).not.toContain(token);
		}

		// Force a Worker-side log event: with the feed table gone the
		// lookup throws, the error boundary logs `unhandled_error` with
		// the route pattern, and answers 500. This proves worker
		// console.error lines still reach the server log at warn level.
		const dropped = spawnSync(
			server.command,
			[
				"d1",
				"execute",
				"research",
				"--local",
				"--config",
				plan.migrations.config,
				"--persist-to",
				plan.migrations.stateDir,
				"--command",
				"DROP TABLE calendar_feeds",
			],
			{ cwd: repoRoot, env: childEnv, encoding: "utf8", timeout: 120_000 },
		);
		expect(dropped.status).toBe(0);
		const failing = await fetch(`${apiOrigin}/api/v1/calendar-feed/${token}/earnings.ics`);
		expect(failing.status).toBe(500);
		let logged = "";
		const logDeadline = Date.now() + 15_000;
		while (Date.now() < logDeadline) {
			logged = readFileSync(server.logFile, "utf8");
			if (logged.includes("unhandled_error")) break;
			await sleep(250);
		}
		// The Worker's own event is present, with the unexpanded route
		// pattern — and the token is still nowhere in the log directory.
		expect(logged).toContain("unhandled_error");
		expect(logged).toContain("/api/v1/calendar-feed/:token/earnings.ics");
		for (const file of listFilesRecursive(plan.logDir)) {
			expect(readFileSync(file, "utf8")).not.toContain(token);
		}
	}, 180_000);
});
