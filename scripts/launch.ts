/**
 * Runs the whole workspace on this PC in one of two environments (ADR-0011):
 *
 *     bun run dev    # development: the working tree, live, against data-dev/
 *     bun run prod   # production: the built release in release/, against data/
 *
 * `bun run start` stays as the production spelling. Both modes share this
 * supervision code; what differs (processes, ports, directories, environment)
 * comes from the pure plan in `launchPlan.ts`. Everything the previous
 * `start.ts` guaranteed — loopback only, process-group shutdown, readiness,
 * credential reuse and re-issue, port-busy refusal — still holds.
 *
 * Settings (environment):
 *   RESEARCH_PORT          port of the production app (default 8787)
 *   RESEARCH_DATA_DIR      where production data lives (default "data")
 *   RESEARCH_DEV_PORT      port of the development SPA (default 3000)
 *   RESEARCH_DEV_API_PORT  port of the development API (default 8788)
 *   RESEARCH_DEV_DATA_DIR  where development data lives (default "data-dev")
 *   RESEARCH_RELEASE_DIR   the release area production serves (default "release")
 *   RESEARCH_PREVIOUS_RELEASE_DIR  legacy previous-release location, migrated once (default "release.previous")
 *   RESEARCH_RUNNER_ENV_FILE  env file the runner processes load (default "apps/runner/.env";
 *     tests point it at a file they wrote themselves, so the operational file is never read)
 *   RESEARCH_RUNNER        "rust" (default, the research-runner binary built by Cargo, ADR-0030) or "node"
 *     (the TypeScript runner, the rollback); a production generation without the binary still
 *     starts with node
 *   RESEARCH_CARGO_TARGET_DIR  shared Cargo build cache (default "target")
 * Optional runner settings (SEC_USER_AGENT, OPENCODE_MODEL, OPENROUTER_*, ANTHROPIC_API_KEY, …) are
 * read from that env file when it exists.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
	agentsResponseSchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	issuedRunnerCredentialSchema,
	runnerCredentialCheckResponseSchema,
	runnerCredentialListResponseSchema,
	sessionResponseSchema,
} from "@research/contracts";
import { z } from "zod";
import {
	type LaunchMode,
	type LaunchPlan,
	newMigrationFiles,
	type PlannedProcess,
	planLaunch,
	readLaunchInputs,
	VITE,
	WRANGLER,
} from "./launchPlan.ts";
import {
	CREDENTIAL_LIFETIME_DAYS,
	planCredential,
	type StoredCredential,
} from "./localCredential.ts";
import {
	ALLOW_NEWER_DB_ENV_VAR,
	checkMigrationCompatibility,
	generationLayout,
	readAppliedMigrations,
	readReleaseManifest,
	removeHolderMarker,
	resolveActiveGeneration,
	runnersInGeneration,
	validateDirectorySet,
	writeHolderMarker,
} from "./releaseOps.ts";
import {
	CrashLoop,
	lastRunnerErrorFromFile,
	RUNNER_ERROR_EVENTS,
	summarizeRunnerStartFailure,
} from "./supervision.ts";

const DATABASE_NAME = "research";
const SERVER_READY_TIMEOUT_MS = 60_000;
const RUNNER_READY_TIMEOUT_MS = 45_000;
const STOP_GRACE_MS = 8_000;
const KILL_WAIT_MS = 2_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** Process groups exist on POSIX only; elsewhere only the direct child can be signalled. */
const USE_PROCESS_GROUPS = process.platform !== "win32";

/** Wrangler runs fully offline here; it has no reason to report usage. */
const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false" };

/** Thrown to unwind start-up once a stop has been requested; never reported as a failure. */
class Stopped extends Error {}

interface Child {
	readonly name: string;
	readonly process: ChildProcess;
	/** Also the id of the child's process group, which outlives the child itself. */
	readonly pid: number;
}

const children: Child[] = [];
/** Aborted the moment a stop begins: cancels pending requests and forbids new children. */
const shutdown = new AbortController();
let stopPromise: Promise<void> | null = null;
let exitCode = 0;
/**
 * Runner exits without a successful report between them (finding 7): three
 * in a short window stop being retried. Reset on every successful report.
 */
const runnerCrashes = new CrashLoop();
/** How the runner process ended, when it did (finding 7 start-up summary). */
let runnerExitCode: number | null = null;
let runnerExitSignal: NodeJS.Signals | null = null;
/**
 * Parent-liveness guard (finding 8): pid of `scripts/guardian.ts`, started
 * once the launcher's directories exist and stopped before the children on
 * every exit path. When the launcher is SIGKILLed it survives and stops the
 * recorded process groups.
 */
let guardianPid: number | null = null;
/** JSON file of process group ids the launcher started; the guardian reads it. */
let guardianFile = "";
const guardianGroups: number[] = [];
/** Stops the development runner-log watcher; null outside development. */
let stopRunnerLogWatch: (() => void) | null = null;
/** Stops the development migrations watcher; null outside development. */
let stopMigrationWatch: (() => void) | null = null;
/**
 * The generation this production instance serves (finding 3). Written once
 * the generation is pinned, removed on every exit path below; a crash leaves
 * it for pruning to recognise as stale by pid and start time.
 */
let activeHolder: { readonly area: string; readonly generation: string } | null = null;

function clearHolder(): void {
	if (activeHolder === null) return;
	const held = activeHolder;
	activeHolder = null;
	try {
		removeHolderMarker(held.area, held.generation, process.pid);
	} catch {
		// Best effort on the way out; stale markers are recognised as such.
	}
}

function step(text: string): void {
	console.log(`  ▶ ${text}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Start-up calls this after every wait, so that it cannot carry on once a stop has begun. */
function checkpoint(): void {
	if (shutdown.signal.aborted) throw new Stopped();
}

/**
 * Signals the whole process group, not just the child: workerd and agent CLIs
 * are grandchildren, and they must stop even when their parent has already exited.
 */
function signalChild(child: Child, signal: NodeJS.Signals): void {
	try {
		if (USE_PROCESS_GROUPS) process.kill(-child.pid, signal);
		else child.process.kill(signal);
	} catch {
		// Nothing left to signal, which is the state being asked for.
	}
}

function childAlive(child: Child): boolean {
	if (!USE_PROCESS_GROUPS) {
		return child.process.exitCode === null && child.process.signalCode === null;
	}
	try {
		process.kill(-child.pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilGone(child: Child, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (childAlive(child)) {
		if (Date.now() >= deadline) return false;
		await sleep(50);
	}
	return true;
}

/**
 * The one shutdown path. Stops the log watcher and the parent-liveness guard
 * first (so neither can race the child shutdown), then the runner before the
 * API it talks to, escalating to SIGKILL for anything in a group that
 * outlives the grace period.
 */
function stopAll(): Promise<void> {
	if (stopPromise !== null) return stopPromise;
	shutdown.abort();
	stopPromise = (async () => {
		if (stopRunnerLogWatch !== null) {
			const stopWatch = stopRunnerLogWatch;
			stopRunnerLogWatch = null;
			stopWatch();
		}
		if (stopMigrationWatch !== null) {
			const stopWatch = stopMigrationWatch;
			stopMigrationWatch = null;
			stopWatch();
		}
		await stopGuardian();
		for (const child of [...children].reverse()) {
			signalChild(child, "SIGTERM");
			if (await waitUntilGone(child, STOP_GRACE_MS)) continue;
			signalChild(child, "SIGKILL");
			if (!(await waitUntilGone(child, KILL_WAIT_MS))) {
				console.error(
					`launch: the ${child.name} (process group ${child.pid}) could not be stopped.`,
				);
				exitCode = 1;
			}
		}
	})();
	return stopPromise;
}

/** Records a started process group for the parent-liveness guard (finding 8). */
function recordGroup(pid: number): void {
	if (guardianFile === "") return;
	guardianGroups.push(pid);
	try {
		writeFileSync(guardianFile, JSON.stringify(guardianGroups));
	} catch {
		// Best effort; the guardian reads whatever was recorded.
	}
}

/** Starts the parent-liveness guard; a start-up failure when it cannot start. */
function startGuardian(): void {
	checkpoint();
	try {
		const guard = spawn(
			process.execPath,
			["scripts/guardian.ts", String(process.pid), guardianFile],
			{
				stdio: "ignore",
				// Its own group, so terminal signals to the launcher's group never
				// reach it; the launcher stops it explicitly on every exit path.
				detached: USE_PROCESS_GROUPS,
			},
		);
		guard.once(
			"error",
			(error) => void fail(`could not start the parent-liveness guard: ${error.message}`),
		);
		guard.unref();
		if (guard.pid !== undefined) guardianPid = guard.pid;
	} catch (error) {
		throw new Error(
			`could not start the parent-liveness guard: ${error instanceof Error ? error.message : "unknown"}.`,
		);
	}
}

async function stopGuardian(): Promise<void> {
	if (guardianPid === null) return;
	const pid = guardianPid;
	guardianPid = null;
	try {
		if (USE_PROCESS_GROUPS) process.kill(-pid, "SIGTERM");
		else process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	const deadline = Date.now() + KILL_WAIT_MS;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return;
		}
		await sleep(50);
	}
	try {
		if (USE_PROCESS_GROUPS) process.kill(-pid, "SIGKILL");
		else process.kill(pid, "SIGKILL");
	} catch {
		// Gone already, which is the state being asked for.
	}
}

/**
 * Reports a runner problem the moment it is seen (finding 7): `node --watch`
 * stays alive when the program it runs exits, so in development a crash is
 * visible only as lines in the runner log. A crash loop stops being retried.
 */
function noteRunnerProblem(detail: string): void {
	if (shutdown.signal.aborted) return;
	console.error(`launch: the runner reported a problem: ${detail}`);
	if (runnerCrashes.recordExit(Date.now())) {
		void fail(`the runner keeps failing without reporting (${runnerCrashes.describe()})`);
	}
}

/** Watches the runner log for crash lines (development only; see noteRunnerProblem). */
function watchRunnerLog(logFile: string): () => void {
	let offset = 0;
	try {
		offset = readFileSync(logFile, "utf8").length;
	} catch {
		offset = 0;
	}
	const timer = setInterval(() => {
		if (shutdown.signal.aborted) return;
		let fresh = "";
		try {
			const text = readFileSync(logFile, "utf8");
			fresh = text.slice(offset);
			offset = text.length;
		} catch {
			return;
		}
		for (const line of fresh.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "") continue;
			if (RUNNER_ERROR_EVENTS.some((event) => trimmed.includes(event))) {
				noteRunnerProblem(trimmed.slice(-500));
			}
		}
	}, 1000);
	timer.unref();
	return () => clearInterval(timer);
}

/** How often development looks for migrations that arrived while it runs. */
const MIGRATION_POLL_MS = 2_000;

/** The Wrangler arguments that apply every pending migration to this plan's database. */
function migrationApplyArgs(plan: LaunchPlan): readonly string[] {
	return [
		"d1",
		"migrations",
		"apply",
		DATABASE_NAME,
		"--local",
		"--config",
		plan.migrations.config,
		"--persist-to",
		plan.migrations.stateDir,
	];
}

function listDirectory(dir: string): readonly string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/** Applies pending migrations without blocking the launcher; resolves whether Wrangler succeeded. */
function applyMigrationsInBackground(plan: LaunchPlan): Promise<boolean> {
	const args = migrationApplyArgs(plan);
	const record = (output: string): void => {
		writeFileSync(plan.buildLog, `$ ${WRANGLER} ${args.join(" ")}\n${output}\n`, { flag: "a" });
	};
	return new Promise((resolveApplied) => {
		let output = "";
		// stdin is closed so that Wrangler treats the step as non-interactive and never prompts.
		const child = spawn(WRANGLER, args, { stdio: ["ignore", "pipe", "pipe"], env: wranglerEnv });
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		child.on("error", (error) => {
			record(`${output}${error.name}: ${error.message}`);
			resolveApplied(false);
		});
		child.on("close", (code) => {
			record(output);
			resolveApplied(code === 0);
		});
	});
}

/**
 * Development only: applies migrations that appear while the instance runs.
 * The API reloads its code on change but the database keeps its schema, so a
 * migration arriving with a merge or pull left the new routes answering 500
 * ("INTERNAL") until `bun run dev` was restarted. One apply runs at a time;
 * a failed apply is reported once for those files and not retried (a restart
 * retries it through the start-up step).
 */
function watchMigrations(plan: LaunchPlan, dir: string): () => void {
	const known = new Set(listDirectory(dir));
	let applying = false;
	const timer = setInterval(() => {
		if (applying || shutdown.signal.aborted) return;
		const fresh = newMigrationFiles(known, listDirectory(dir));
		if (fresh.length === 0) return;
		for (const name of fresh) known.add(name);
		applying = true;
		void applyMigrationsInBackground(plan).then((applied) => {
			applying = false;
			if (shutdown.signal.aborted) return;
			const names = fresh.join(", ");
			if (applied) {
				console.log(`launch: applied new migrations to the running database: ${names}`);
			} else {
				console.error(
					`launch: new migrations ${names} could not be applied; see ${plan.buildLog}, then restart.`,
				);
			}
		});
	}, MIGRATION_POLL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

async function finish(code: number): Promise<never> {
	exitCode = Math.max(exitCode, code);
	await stopAll();
	clearHolder();
	process.exit(exitCode);
}

async function fail(message: string): Promise<never> {
	// A failure caused by the stop itself (an aborted request, a child being terminated) is not one.
	if (!shutdown.signal.aborted) console.error(`\nlaunch: ${message}`);
	return finish(shutdown.signal.aborted ? 0 : 1);
}

/** Runs a build step to completion with its output in the build log. */
async function runStep(
	buildLog: string,
	label: string,
	command: string,
	args: readonly string[],
): Promise<void> {
	// The step itself blocks, so yield first: a stop requested during the previous step is seen here.
	await sleep(0);
	checkpoint();
	step(label);
	// stdin is closed so that Wrangler treats the step as non-interactive and never prompts.
	const result = spawnSync(command, args, {
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		env: wranglerEnv,
	});
	writeFileSync(buildLog, `$ ${command} ${args.join(" ")}\n${result.stdout}${result.stderr}\n`, {
		flag: "a",
	});
	// Ctrl+C reaches the step as well as this script: that is a stop, not a build failure.
	if (result.signal !== null) throw new Stopped();
	if (result.status !== 0) throw new Error(`"${label}" failed. See ${buildLog}.`);
}

function startChild(
	name: string,
	command: string,
	args: readonly string[],
	logFile: string,
	env: NodeJS.ProcessEnv,
): void {
	checkpoint();
	const log = openSync(logFile, "w");
	const child = spawn(command, args, {
		stdio: ["ignore", log, log],
		env,
		// Its own process group, so that a stop reaches everything it spawns.
		detached: USE_PROCESS_GROUPS,
	});
	child.once("error", (error) => void fail(`could not start the ${name}: ${error.message}`));
	child.once("exit", (code, signal) => {
		const how = signal ?? `exit code ${code}`;
		if (name === "runner") {
			// Reported at once with its exit code (finding 7): in
			// development the bundle is rebuilt and rerun on the next source
			// change as now, but the exit itself is never silent. A crash
			// loop stops being retried and says so.
			runnerExitCode = code;
			runnerExitSignal = signal;
			const hint = lastRunnerErrorFromFile(logFile);
			if (!shutdown.signal.aborted) {
				console.error(
					`launch: the runner stopped unexpectedly (${how})${hint === null ? "" : ` — last error: ${hint}`}. See ${logFile}.`,
				);
			}
			if (runnerCrashes.recordExit(Date.now())) {
				void fail(`the runner keeps exiting without reporting (${runnerCrashes.describe()})`);
			} else {
				void fail(`the runner stopped unexpectedly (${how}). See ${logFile}.`);
			}
			return;
		}
		void fail(
			`the ${name} stopped unexpectedly (${signal ?? `exit code ${code}`}). See ${logFile}.`,
		);
	});
	// Without a pid the spawn failed; the "error" event above reports it.
	if (child.pid !== undefined) {
		children.push({ name, process: child, pid: child.pid });
		recordGroup(child.pid);
	}
}

function startPlanned(spec: PlannedProcess): void {
	step(`starting the ${spec.name}`);
	startChild(spec.name, spec.command, spec.args, spec.logFile, {
		...wranglerEnv,
		...spec.extraEnv,
	});
}

function portInUse(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ host: "127.0.0.1", port });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function request(plan: LaunchPlan, path: string, init: RequestInit) {
	const response = await fetch(`${plan.apiOrigin}/api/v1${path}`, {
		...init,
		signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
	});
	// Parsed as unknown: every caller validates it against a contract schema.
	const json: unknown = await response.json().catch(() => null);
	return { status: response.status, json };
}

/** A request the local API accepts as the owner: same origin, CSRF header, JSON. */
function ownerApi(
	plan: LaunchPlan,
	method: "GET" | "POST" | "DELETE",
	path: string,
	body?: unknown,
) {
	return request(plan, path, {
		method,
		headers: {
			Origin: plan.apiOrigin,
			[CSRF_HEADER]: CSRF_HEADER_VALUE,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function waitForServer(plan: LaunchPlan): Promise<void> {
	const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const response = await ownerApi(plan, "GET", "/session").catch(() => null);
		checkpoint();
		if (response !== null) {
			const session = sessionResponseSchema.safeParse(response.json);
			if (response.status === 200 && session.success && session.data.authMode === "local-dev") {
				if (session.data.environment !== plan.appEnv) {
					throw new Error(
						`the server reported environment "${session.data.environment}" but this is a ${plan.appEnv} start.`,
					);
				}
				return;
			}
			if (response.status === 401 || response.status === 403) {
				throw new Error(
					"the local API refused the owner. Remove any AUTH_MODE override in infra/.dev.vars: local operation needs AUTH_MODE=local-dev.",
				);
			}
		}
		await sleep(300);
	}
	throw new Error(`the server did not become ready in time. See ${plan.serverLog}.`);
}

const storedCredentialSchema = z.strictObject({
	credentialId: z.string().min(1),
	token: z.string().min(40),
}) satisfies z.ZodType<StoredCredential>;

/** An unreadable or malformed file is the same as no file: a new credential is issued. */
function readStoredCredential(credentialFile: string): StoredCredential | null {
	if (!existsSync(credentialFile)) return null;
	try {
		const parsed = storedCredentialSchema.safeParse(
			JSON.parse(readFileSync(credentialFile, "utf8")),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/** Asks the API, as the runner would, whether the stored token still belongs to its credential. */
async function tokenAccepted(plan: LaunchPlan, stored: StoredCredential): Promise<boolean> {
	// No Origin header: runner endpoints refuse anything that looks like a browser.
	const response = await request(plan, "/runner/credential", {
		headers: { Authorization: `Bearer ${stored.token}` },
	});
	const check = runnerCredentialCheckResponseSchema.safeParse(response.json);
	return (
		response.status === 200 && check.success && check.data.credentialId === stored.credentialId
	);
}

/** The token is written to a file only the owner can read and is never printed or logged. */
async function runnerToken(plan: LaunchPlan): Promise<string> {
	const list = await ownerApi(plan, "GET", "/runner-credentials");
	const listed = runnerCredentialListResponseSchema.safeParse(list.json);
	if (list.status !== 200 || !listed.success) {
		throw new Error(`could not list runner credentials (HTTP ${list.status}).`);
	}
	const stored = readStoredCredential(plan.credentialFile);
	const planDecision = planCredential(
		stored,
		listed.data.credentials,
		Date.now(),
		stored !== null && (await tokenAccepted(plan, stored)),
	);
	if (planDecision.kind === "reuse") return planDecision.token;

	const issue = await ownerApi(plan, "POST", "/runner-credentials", {
		label: plan.credentialLabel,
		expiresInDays: CREDENTIAL_LIFETIME_DAYS,
	});
	const issued = issuedRunnerCredentialSchema.safeParse(issue.json);
	if (!issued.success)
		throw new Error(`could not issue a runner credential (HTTP ${issue.status}).`);
	const replacement: StoredCredential = {
		credentialId: issued.data.credential.credentialId,
		token: issued.data.token,
	};
	writeFileSync(plan.credentialFile, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
	if (planDecision.revokeCredentialId !== null) {
		const revoke = await ownerApi(
			plan,
			"DELETE",
			`/runner-credentials/${planDecision.revokeCredentialId}`,
		);
		if (revoke.status >= 400) {
			console.warn(
				`  ⚠ could not revoke the replaced credential ${planDecision.revokeCredentialId}; revoke it under Settings.`,
			);
		}
	}
	return replacement.token;
}

/**
 * Returns a one-line summary of the agent backends once THIS runner has reported
 * in. The API keeps the last report for a minute, so after a quick restart an
 * "online" flag alone could still describe the previous process.
 *
 * Readiness means a report (finding 7): when none arrives within the timeout
 * the start-up FAILS with the runner's last error line — never a "ready"
 * with a dead runner. The throw below unwinds through `main` into `fail`,
 * which stops everything started so far.
 */
async function waitForRunner(plan: LaunchPlan, startedAtMs: number): Promise<string> {
	const deadline = Date.now() + RUNNER_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const response = await ownerApi(plan, "GET", "/agents").catch(() => null);
		checkpoint();
		const agents = response === null ? null : agentsResponseSchema.safeParse(response.json);
		if (agents?.success && agents.data.runnerLastSeenAt !== null) {
			const lastSeenMs = Date.parse(agents.data.runnerLastSeenAt);
			if (agents.data.runnerOnline && lastSeenMs >= startedAtMs) {
				runnerCrashes.reportSuccess();
				return agents.data.agents
					.map((agent) =>
						agent.availability.status === "available"
							? `${agent.agentId} available`
							: `${agent.agentId} unavailable (${agent.availability.reasonCode})`,
					)
					.join(", ");
			}
		}
		await sleep(500);
	}
	throw new Error(
		summarizeRunnerStartFailure({
			logFile: plan.runnerLog,
			exitCode: runnerExitCode,
			signal: runnerExitSignal,
			timeoutMs: RUNNER_READY_TIMEOUT_MS,
		}),
	);
}

/**
 * Production serves ONLY the release: the manifest must be readable and the
 * bundles present, otherwise there is nothing safe to run. The manifest is
 * written last by `prod:build`, so a half-finished build also refuses.
 */
function requireRelease(plan: LaunchPlan): void {
	if (plan.release === null) return;
	const manifest = readReleaseManifest(plan.release.manifestFile);
	const missing =
		manifest === null ||
		!existsSync(plan.release.wranglerConfig) ||
		!existsSync(plan.release.workerBundle) ||
		!existsSync(plan.release.runnerBundle);
	if (missing) {
		throw new Error(
			`no release found at ${plan.release.dir}/ (or its manifest is unreadable, or it has no ${plan.release.runnerKind} runner for RESEARCH_RUNNER=${plan.release.runnerKind}). Run \`bun run prod:build\` first.`,
		);
	}
	if (plan.release.runnerFellBack) {
		console.log(
			"  ⚠ RESEARCH_RUNNER=rust, but this generation was built before the Rust runner: starting its node runner. Run `bun run prod:build` to build the Rust one.",
		);
	}
}

/**
 * Refuses old code against a newer schema (finding 6): the generation's
 * manifest records the migrations it was built with, and the database must
 * not hold applied migrations the generation does not know. Runs AFTER the
 * apply step above — applying an older set is a no-op for unknown entries,
 * so a refusal here still starts nothing. The owner who has checked the
 * schema difference sets RESEARCH_ALLOW_NEWER_DB=1 to proceed.
 */
function requireMigrationCompatibility(plan: LaunchPlan): void {
	if (plan.release === null) return;
	const manifest = readReleaseManifest(plan.release.manifestFile);
	if (manifest === null) {
		throw new Error(
			`no release found at ${plan.release.dir}/ (or its manifest is unreadable). Run \`bun run prod:build\` first.`,
		);
	}
	let applied: string[];
	try {
		applied = readAppliedMigrations({
			wranglerBin: WRANGLER,
			database: DATABASE_NAME,
			config: plan.migrations.config,
			stateDir: plan.migrations.stateDir,
			env: wranglerEnv,
		});
	} catch (error) {
		throw new Error(
			error instanceof Error ? error.message : "could not read the applied migrations.",
		);
	}
	const compatible = checkMigrationCompatibility({
		generationMigrations: manifest.migrations,
		appliedMigrations: applied,
	});
	if (compatible.ok) return;
	if (process.env[ALLOW_NEWER_DB_ENV_VAR] === "1") {
		console.log(`  ⚠ ${compatible.error} Continuing because ${ALLOW_NEWER_DB_ENV_VAR}=1.`);
		return;
	}
	throw new Error(compatible.error);
}

async function main(plan: LaunchPlan): Promise<void> {
	console.log(
		plan.mode === "production"
			? "Research workspace (production, this PC)"
			: "Research workspace (development)",
	);
	if (!existsSync(WRANGLER)) {
		throw new Error("dependencies are missing. Run `bun install` first.");
	}
	if (plan.processes.some((spec) => spec.command === VITE) && !existsSync(VITE)) {
		throw new Error("dependencies are missing. Run `bun install` first.");
	}
	requireRelease(plan);
	for (const listen of plan.listenPorts) {
		if (await portInUse(listen.port)) {
			throw new Error(
				`port ${listen.port} is already in use. If the workspace is already running, open ${plan.origin}; otherwise set ${listen.envVar} to a free port.`,
			);
		}
	}
	mkdirSync(plan.logDir, { recursive: true, mode: 0o700 });
	writeFileSync(plan.buildLog, "");
	// The parent-liveness guard (finding 8) watches the launcher pid and, if
	// it disappears, stops the process groups recorded here. Every started
	// child is appended by `startChild` from its first spawn.
	guardianFile = join(plan.logDir, "guardian.json");
	writeFileSync(guardianFile, "[]");
	startGuardian();

	// Development serves through a generated configuration that never reads
	// dist/ (see devWranglerConfig): write it (and its empty asset
	// directory) before migrations run against it.
	if (plan.devWrangler !== null) {
		mkdirSync(plan.devWrangler.webDir, { recursive: true, mode: 0o700 });
		writeFileSync(plan.devWrangler.file, plan.devWrangler.content);
	}

	// Development runs the runner from a file inside the data directory, so
	// build it once before anything starts: the watching runner process below
	// needs a file to run and to watch, and rebuilds it afterwards.
	if (plan.devRunner !== null) {
		const devRunner = plan.devRunner;
		if (devRunner.kind === "node") {
			const { bunExe, source, bundle } = devRunner;
			mkdirSync(bundle.split("/").slice(0, -1).join("/"), { recursive: true, mode: 0o700 });
			await runStep(plan.buildLog, `building the development runner (${bundle})`, bunExe, [
				"build",
				source,
				"--target=node",
				`--outfile=${bundle}`,
			]);
		} else {
			mkdirSync(devRunner.binaryDir, { recursive: true, mode: 0o700 });
			await runStep(
				plan.buildLog,
				`building the development Rust runner (${devRunner.binary})`,
				devRunner.prepare.command,
				devRunner.prepare.args,
			);
		}
	}

	await runStep(
		plan.buildLog,
		`preparing the local database (${plan.stateDir})`,
		WRANGLER,
		migrationApplyArgs(plan),
	);
	requireMigrationCompatibility(plan);

	for (const spec of plan.processes) {
		if (spec.name === "runner") continue;
		startPlanned(spec);
	}
	await waitForServer(plan);

	step("starting the runner");
	const token = await runnerToken(plan);
	checkpoint();
	const runnerStartedAtMs = Date.now();
	const runner = plan.processes.find((spec) => spec.name === "runner");
	if (runner === undefined) throw new Error("the launch plan has no runner process.");
	startChild(runner.name, runner.command, runner.args, runner.logFile, {
		...wranglerEnv,
		...runner.extraEnv,
		RESEARCH_API_URL: runner.extraEnv.RESEARCH_API_URL ?? plan.apiOrigin,
		RUNNER_TOKEN: token,
	});
	if (plan.mode === "development") {
		// `node --watch` (and the Rust `scripts/runnerDev.ts`) survive the
		// program they run, so a later runner crash is visible only here
		// (finding 7); production runners exit, which the exit handler above
		// reports.
		stopRunnerLogWatch = watchRunnerLog(plan.runnerLog);
	}
	if (plan.migrations.watchDir !== null) {
		stopMigrationWatch = watchMigrations(plan, plan.migrations.watchDir);
	}
	const agents = await waitForRunner(plan, runnerStartedAtMs);

	console.log(`\n  ✔ ready: ${plan.origin}`);
	if (plan.mode === "development") console.log(`    api: ${plan.apiOrigin}`);
	console.log(`    agents: ${agents}`);
	console.log(`    data: ${plan.dataDir}/   logs: ${plan.logDir}/   stop: Ctrl+C`);
}

/** Runs one environment. Thin entries (`dev.ts`, `prodStart.ts`, `start.ts`) call this. */
export async function runMode(mode: LaunchMode): Promise<void> {
	const repoRoot = process.cwd();
	const parsed = readLaunchInputs(mode, process.env, repoRoot, process.execPath);
	if (!parsed.ok) {
		console.error(`launch: ${parsed.error.message}`);
		process.exit(2);
	}
	// Canonical directory check BEFORE any write (finding 1): symlinks, case
	// variants and parent/child overlaps between the two data directories are
	// caught here by file-system identity, beyond the pure textual check in
	// `planLaunch`. The same ONE validation guards every destructive path
	// (finding 2).
	const directories = validateDirectorySet(repoRoot, [
		{ label: "production data directory", dir: parsed.value.prodDataDir },
		{ label: "development data directory", dir: parsed.value.devDataDir },
		{ label: "release area", dir: parsed.value.releaseDir },
		{ label: "previous release directory", dir: parsed.value.previousReleaseDir },
	]);
	if (!directories.ok) {
		console.error(`launch: ${directories.error}`);
		process.exit(2);
	}
	let inputs = parsed.value;
	if (mode === "production") {
		// The pointer is read ONCE here; this instance serves that generation
		// for its whole life, whatever later builds or rollbacks do (finding 3).
		const active = resolveActiveGeneration(repoRoot, parsed.value.releaseDir);
		if (!active.ok) {
			console.error(`launch: ${active.error}`);
			process.exit(1);
		}
		try {
			writeHolderMarker(active.value.areaAbs, active.value.generation);
			activeHolder = { area: active.value.areaAbs, generation: active.value.generation };
		} catch (error) {
			console.error(
				`launch: could not record the generation in use: ${error instanceof Error ? error.message : "unknown"}.`,
			);
			process.exit(1);
		}
		inputs = {
			...parsed.value,
			releaseDir: active.value.generationDir,
			generationRunners: runnersInGeneration(
				generationLayout(active.value.areaAbs, active.value.generation),
			),
		};
	}
	const planned = planLaunch(inputs);
	if (!planned.ok) {
		clearHolder();
		console.error(`launch: ${planned.error.message}`);
		process.exit(2);
	}
	try {
		await main(planned.value);
	} catch (error) {
		// Whatever went wrong, nothing started here may be left running.
		if (error instanceof Stopped) await finish(0);
		else await fail(error instanceof Error ? error.message : "start-up failed unexpectedly.");
	}
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		if (!shutdown.signal.aborted) console.log("\n  ▶ stopping");
		void finish(0);
	});
}
