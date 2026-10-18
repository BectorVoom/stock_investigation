/**
 * The development Rust runner: ONE supervising process (ADR-0030, amending
 * ADR-0011). `bun run dev` (the default runner) starts it instead of
 * the Bun bundle watcher plus `node --watch`:
 *
 *     bun scripts/runnerDev.ts --binary data-dev/runner/research-runner \
 *       --runner-env apps/runner/.env --target-dir target --build-log data-dev/logs/runner-build.log
 *
 * It (a) watches `crates/**`, `Cargo.toml` and `Cargo.lock` (recursive
 * `fs.watch`, debounced), (b) runs `cargo build --locked -p research-runner`
 * (dev profile) and on success copies the binaries beside `--binary` through a
 * temp file and a rename (never an in-place write: appending to a running
 * Mach-O invalidates its code signature and the kernel kills it), (c) watches
 * the installed binary (inode, mtime, size) and restarts the runner child
 * whenever it changes — whoever replaced it — with SIGTERM to the child's
 * process group, a grace period, then SIGKILL, and (d) survives the child's
 * exit and waits for the next change, which is the `node --watch` behaviour
 * the launcher relies on (a crash is visible only as lines in `runner.log`).
 *
 * The child's stdout and stderr ARE this process's (the launcher opened
 * `runner.log` for it), so the crash watcher keeps working; this process's own
 * lines go to `--build-log` (`runner-build.log`).
 *
 * `--once` builds and installs the binaries and exits: the launcher runs it
 * before anything starts so the file to run exists.
 *
 * The runner env file flag is `--runner-env`, not `--env-file`: Node scans the
 * whole command line for `--env-file` even after the script name and would
 * try to load it itself.
 *
 * Environment: the child inherits this process's environment (the launcher
 * sets RESEARCH_API_URL, RUNNER_TOKEN, RUNNER_PAGES_DIR, GOOGLE_TOKEN_FILE).
 * Cargo gets it without RUSTFLAGS/CARGO_BUILD_* and with the shared target dir.
 */
import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	statSync,
	watch,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	CARGO_DEV_BUILD_ARGS,
	cargoBuildEnv,
	RUST_OPTIONAL_BINARIES,
	RUST_REQUIRED_BINARIES,
} from "./launchPlan.ts";

/** Quiet period after the last change before a build starts. */
export const DEFAULT_DEBOUNCE_MS = 300;
/** How often the installed binary is compared with the one the child runs. */
export const DEFAULT_POLL_MS = 250;
/** Grace between SIGTERM and SIGKILL when restarting the child (as the launcher's). */
export const RESTART_GRACE_MS = 8_000;
/**
 * Grace when this process itself is stopping: shorter than the launcher's own
 * 8 s so that the launcher never has to SIGKILL us with a live child group.
 */
export const SHUTDOWN_GRACE_MS = 5_500;

export interface RunnerDevOptions {
	readonly binary: string;
	readonly envFile: string;
	readonly targetDir: string;
	readonly buildLog: string;
	readonly once: boolean;
	readonly cargo: string;
	readonly root: string;
	readonly debounceMs: number;
	readonly pollMs: number;
	readonly restartGraceMs: number;
	readonly shutdownGraceMs: number;
}

export type ParsedArgs =
	| { readonly ok: true; readonly value: RunnerDevOptions }
	| { readonly ok: false; readonly error: string };

const VALUE_FLAGS = [
	"binary",
	"runner-env",
	"target-dir",
	"build-log",
	"cargo",
	"root",
	"debounce-ms",
	"poll-ms",
	"restart-grace-ms",
	"shutdown-grace-ms",
] as const;

type MsResult =
	| { readonly ok: true; readonly value: number }
	| { readonly ok: false; readonly error: string };

function parseMs(raw: string | undefined, fallback: number, flag: string): MsResult {
	if (raw === undefined) return { ok: true, value: fallback };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 0) {
		return { ok: false, error: `--${flag} must be a non-negative integer.` };
	}
	return { ok: true, value };
}

/** Parses the command line; every problem is a message, never a throw. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const values = new Map<string, string>();
	let once = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg === "--once") {
			once = true;
			continue;
		}
		const flag = VALUE_FLAGS.find((candidate) => arg === `--${candidate}`);
		const value = argv[index + 1];
		if (flag === undefined || value === undefined) {
			return { ok: false, error: `unexpected or incomplete argument ${JSON.stringify(arg)}.` };
		}
		values.set(flag, value);
		index += 1;
	}
	for (const required of ["binary", "runner-env", "target-dir", "build-log"]) {
		if ((values.get(required) ?? "") === "") {
			return { ok: false, error: `--${required} is required.` };
		}
	}
	const debounceMs = parseMs(values.get("debounce-ms"), DEFAULT_DEBOUNCE_MS, "debounce-ms");
	const pollMs = parseMs(values.get("poll-ms"), DEFAULT_POLL_MS, "poll-ms");
	const restartGraceMs = parseMs(
		values.get("restart-grace-ms"),
		RESTART_GRACE_MS,
		"restart-grace-ms",
	);
	const shutdownGraceMs = parseMs(
		values.get("shutdown-grace-ms"),
		SHUTDOWN_GRACE_MS,
		"shutdown-grace-ms",
	);
	for (const parsed of [debounceMs, pollMs, restartGraceMs, shutdownGraceMs]) {
		if (!parsed.ok) return parsed;
	}
	if (!(debounceMs.ok && pollMs.ok && restartGraceMs.ok && shutdownGraceMs.ok)) {
		return { ok: false, error: "invalid millisecond setting." };
	}
	return {
		ok: true,
		value: {
			binary: resolve(values.get("binary") ?? ""),
			envFile: values.get("runner-env") ?? "",
			targetDir: resolve(values.get("target-dir") ?? ""),
			buildLog: resolve(values.get("build-log") ?? ""),
			once,
			cargo: values.get("cargo") ?? "cargo",
			root: resolve(values.get("root") ?? process.cwd()),
			debounceMs: debounceMs.value,
			pollMs: pollMs.value,
			restartGraceMs: restartGraceMs.value,
			shutdownGraceMs: shutdownGraceMs.value,
		},
	};
}

/**
 * Whether a change at this repository-relative path can alter the runner
 * binary. Editor swap/backup files and build output are noise: reacting to
 * them would rebuild in a loop (a build writes under `target/`).
 */
export function isRelevantChange(relativePath: string): boolean {
	const parts = relativePath.split(sep).filter((part) => part !== "");
	if (parts.length === 0) return false;
	if (parts.some((part) => part === "target" || part === ".git" || part === "node_modules")) {
		return false;
	}
	const name = parts[parts.length - 1] ?? "";
	if (name.startsWith(".#") || name.startsWith("#") || name.endsWith("~")) return false;
	if (/\.(swp|swx|tmp|bak)$/.test(name) || /^\d+$/.test(name)) return false;
	if (parts.length === 1) return name === "Cargo.toml" || name === "Cargo.lock";
	return parts[0] === "crates";
}

/** Identity of the installed binary: changes on any replacement, even with equal bytes. */
export function fileSignature(file: string): string | null {
	try {
		const stat = statSync(file);
		return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return null;
	}
}

/** Names of the binaries a build installs beside `--binary`, in a stable order. */
function installedNames(): readonly string[] {
	return [...RUST_REQUIRED_BINARIES, ...RUST_OPTIONAL_BINARIES];
}

export class Log {
	// No parameter property: this file also runs under Node's type stripping.
	private readonly file: string;

	constructor(file: string) {
		this.file = file;
		mkdirSync(dirname(file), { recursive: true });
	}

	line(text: string): void {
		try {
			appendFileSync(this.file, `${new Date().toISOString()} runner-dev: ${text}\n`);
		} catch {
			// The log is a convenience; losing a line must not stop the supervisor.
		}
	}

	/** An append-mode descriptor for a child's stdout/stderr (cargo's output). */
	open(): number {
		return openSync(this.file, "a");
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Copies a file next to its destination, then renames over it: readers never see half a file. */
export function installFile(source: string, destination: string): void {
	const temp = `${destination}.tmp-${process.pid}`;
	try {
		copyFileSync(source, temp);
		chmodSync(temp, 0o755);
		renameSync(temp, destination);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * Runs the Cargo build and installs the binaries. Resolves true on success;
 * a failed build leaves the installed binaries (and the running child) alone.
 */
export async function buildAndInstall(options: RunnerDevOptions, log: Log): Promise<boolean> {
	log.line(`building: ${options.cargo} ${CARGO_DEV_BUILD_ARGS.join(" ")}`);
	const fd = log.open();
	const code = await new Promise<number | string>((resolveBuild) => {
		const child = spawn(options.cargo, [...CARGO_DEV_BUILD_ARGS], {
			cwd: options.root,
			env: cargoBuildEnv(process.env, options.targetDir),
			stdio: ["ignore", fd, fd],
		});
		child.once("error", (error) => resolveBuild(`could not start cargo: ${error.message}`));
		child.once("exit", (exitCode, signal) => resolveBuild(exitCode ?? `signal ${signal}`));
	});
	closeSync(fd);
	if (code !== 0) {
		log.line(`build failed (${code}); keeping the previous binary`);
		return false;
	}
	const built = join(options.targetDir, "debug");
	const destinationDir = dirname(options.binary);
	try {
		mkdirSync(destinationDir, { recursive: true });
		for (const name of installedNames()) {
			const from = join(built, name);
			if (!existsSync(from)) {
				if (RUST_REQUIRED_BINARIES.includes(name)) {
					log.line(`build failed: cargo did not produce ${from}`);
					return false;
				}
				continue;
			}
			// The runner is installed under the name --binary gives it.
			const to = name === RUST_REQUIRED_BINARIES[0] ? options.binary : join(destinationDir, name);
			installFile(from, to);
		}
	} catch (error) {
		log.line(`install failed: ${error instanceof Error ? error.message : "unknown"}`);
		return false;
	}
	log.line(`installed ${options.binary}`);
	return true;
}

/** Signals a whole process group (agent CLIs are grandchildren); false when it is gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

function groupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** The supervising loop; resolves when stopped by a signal. */
async function supervise(options: RunnerDevOptions, log: Log): Promise<void> {
	let child: ChildProcess | null = null;
	let childPid: number | null = null;
	let stopping = false;
	let building = false;
	let dirty = false;
	let installedSignature = fileSignature(options.binary);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	// Starts and stops of the child are serialised so a restart never overlaps another.
	let lifecycle: Promise<void> = Promise.resolve();

	const stopChild = async (graceMs: number): Promise<void> => {
		const pid = childPid;
		if (pid === null) return;
		childPid = null;
		child = null;
		if (!signalGroup(pid, "SIGTERM")) return;
		const deadline = Date.now() + graceMs;
		while (groupAlive(pid) && Date.now() < deadline) await sleep(50);
		if (groupAlive(pid)) {
			log.line(`the runner did not stop within ${graceMs} ms; sending SIGKILL`);
			signalGroup(pid, "SIGKILL");
			const killDeadline = Date.now() + 2_000;
			while (groupAlive(pid) && Date.now() < killDeadline) await sleep(50);
		}
	};

	const startChild = (): void => {
		if (!existsSync(options.binary)) {
			log.line(`no runner binary at ${options.binary}; waiting for a build`);
			return;
		}
		const spawned = spawn(options.binary, [`--env-file-if-exists=${options.envFile}`], {
			cwd: options.root,
			env: process.env,
			// Its own group: a restart or a stop reaches everything it spawned.
			detached: true,
			stdio: ["ignore", "inherit", "inherit"],
		});
		child = spawned;
		childPid = spawned.pid ?? null;
		spawned.once("error", (error) => {
			log.line(`could not start the runner: ${error.message}; waiting for the next change`);
			if (child === spawned) {
				child = null;
				childPid = null;
			}
		});
		spawned.once("exit", (code, signal) => {
			if (child === spawned) {
				child = null;
				childPid = null;
				if (!stopping) {
					log.line(
						`the runner exited (${signal ?? `exit code ${code}`}); waiting for the next change`,
					);
				}
			}
		});
		log.line(`started the runner (pid ${spawned.pid ?? "unknown"})`);
	};

	const restart = (reason: string): void => {
		lifecycle = lifecycle.then(async () => {
			if (stopping) return;
			log.line(`restarting the runner: ${reason}`);
			await stopChild(options.restartGraceMs);
			if (!stopping) startChild();
		});
	};

	const rebuild = async (): Promise<void> => {
		if (building) {
			dirty = true;
			return;
		}
		building = true;
		try {
			do {
				dirty = false;
				// A successful install changes the binary's signature; the poller below
				// restarts the child, exactly as for a replacement from outside.
				await buildAndInstall(options, log);
			} while (dirty && !stopping);
		} finally {
			building = false;
		}
	};

	const onChange = (relativePath: string): void => {
		if (stopping || !isRelevantChange(relativePath)) return;
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void rebuild();
		}, options.debounceMs);
	};

	const watchers = [
		watch(join(options.root, "crates"), { recursive: true }, (_event, name) => {
			onChange(join("crates", name ?? ""));
		}),
		watch(options.root, { recursive: false }, (_event, name) => {
			onChange(name ?? "");
		}),
	];
	for (const watcher of watchers)
		watcher.on("error", (error) => log.line(`watch: ${error.message}`));

	const poller = setInterval(() => {
		if (stopping) return;
		const signature = fileSignature(options.binary);
		if (signature === null || signature === installedSignature) return;
		installedSignature = signature;
		restart("the runner binary changed");
	}, options.pollMs);

	if (installedSignature === null) {
		log.line("no runner binary yet; building");
		await rebuild();
		installedSignature = fileSignature(options.binary);
	}
	lifecycle = lifecycle.then(() => {
		if (!stopping) startChild();
	});

	await new Promise<void>((resolveStop) => {
		const stop = (signal: string): void => {
			if (stopping) return;
			stopping = true;
			log.line(`stopping (${signal})`);
			clearInterval(poller);
			if (debounceTimer !== null) clearTimeout(debounceTimer);
			for (const watcher of watchers) watcher.close();
			void lifecycle.then(() => stopChild(options.shutdownGraceMs)).finally(() => resolveStop());
		};
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.on(signal, () => stop(signal));
		}
	});
}

/** CLI entry: returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		console.error(`runnerDev: ${parsed.error}`);
		return 2;
	}
	const options = parsed.value;
	const log = new Log(options.buildLog);
	if (options.once) {
		const built = await buildAndInstall(options, log);
		if (!built) {
			console.error(`runnerDev: the Rust runner build failed. See ${options.buildLog}.`);
			return 1;
		}
		return 0;
	}
	await supervise(options, log);
	return 0;
}

// Runs only when started as a script (not when a test imports the helpers).
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
	void main(process.argv.slice(2)).then((code) => process.exit(code));
}
