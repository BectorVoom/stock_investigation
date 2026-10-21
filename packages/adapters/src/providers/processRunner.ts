import { spawn } from "node:child_process";
import { describeThrown } from "@research/domain";
import { splitLines } from "./lines.ts";

export interface ProcessSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	/** The COMPLETE environment of the child; nothing is inherited implicitly. */
	readonly env: Readonly<Record<string, string>>;
	readonly stdin?: string;
	readonly signal: AbortSignal;
}

export interface ProcessExit {
	readonly code: number | null;
	readonly signal: string | null;
	readonly stderrTail: string;
}

export interface ProcessHandle {
	/** stdout split into lines as they arrive */
	readonly stdoutLines: AsyncIterable<string>;
	/**
	 * Resolves when the process has exited; `stderrTail` is bounded. Rejects with
	 * the spawn error (e.g. `code: "ENOENT"`) when the process could not start.
	 */
	readonly exit: Promise<ProcessExit>;
}

/** Minimal process port so adapters are testable without real CLIs. */
export interface ProcessRunner {
	run(spec: ProcessSpec): ProcessHandle;
}

const STDERR_TAIL_CHARS = 4_096;
/**
 * Longest single stdout line kept in memory. Codex and OpenCode print a whole
 * message as one JSON line, so this must exceed the adapters' text budget
 * (2 MiB) even when every character is JSON-escaped.
 */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
/** Time a process tree gets to exit after SIGTERM before its group is SIGKILLed. */
const DEFAULT_KILL_GRACE_MS = 2_000;
/** How often the process group is probed while it is being terminated. */
const GROUP_POLL_MS = 25;
/** Time after SIGKILL to see the group disappear before giving up on confirming it. */
const KILL_CONFIRM_MS = 1_000;

/**
 * Upper bound on how long `exit` can stay pending after an abort with the
 * default grace period. Callers that must not outlive a stuck runner wait at
 * least this long.
 */
export const MAX_TERMINATION_MS = DEFAULT_KILL_GRACE_MS + KILL_CONFIRM_MS + 2 * GROUP_POLL_MS;

export type TerminationSignal = "SIGTERM" | "SIGKILL";

/** True for the error Node reports when the executable does not exist. */
export function isCommandNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * The slice of a child process the runner uses. It is a seam, so termination
 * (which is about timing and process groups) can be tested without real processes.
 */
export interface SpawnedChild {
	/** `undefined` when the process could not be started. */
	readonly pid: number | undefined;
	readonly stdout: AsyncIterable<Uint8Array | string>;
	/** Writes the whole input and closes stdin. */
	writeStdin(text: string, onError: (error: unknown) => void): void;
	onStderr(onChunk: (chunk: string) => void, onError: (error: unknown) => void): void;
	onSpawnError(listener: (error: unknown) => void): void;
	/** Fires once the direct child has exited and its stdio has closed. */
	onClose(listener: (code: number | null, signal: string | null) => void): void;
	/** Signals the direct child only; used where there are no process groups (Windows). */
	kill(signal: TerminationSignal): void;
}

export interface NodeProcessRunnerOptions {
	readonly spawnChild?: (spec: ProcessSpec, ownProcessGroup: boolean) => SpawnedChild;
	/**
	 * Sends `signal` to the process group led by `pid`; signal 0 only probes it.
	 * Throws like `process.kill` does (code "ESRCH" once no member is left).
	 */
	readonly signalProcessGroup?: (pid: number, signal: TerminationSignal | 0) => void;
	readonly killGraceMs?: number;
	/** False on Windows, where only the direct child can be signalled. */
	readonly hasProcessGroups?: boolean;
}

function spawnNodeChild(spec: ProcessSpec, ownProcessGroup: boolean): SpawnedChild {
	const child = spawn(spec.command, [...spec.args], {
		cwd: spec.cwd,
		env: { ...spec.env },
		shell: false,
		// The child leads a new process group, so the whole tree can be signalled at once.
		detached: ownProcessGroup,
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	return {
		pid: child.pid,
		stdout: child.stdout,
		writeStdin(text, onError) {
			child.stdin.on("error", onError);
			child.stdin.end(text);
		},
		onStderr(onChunk, onError) {
			child.stderr.setEncoding("utf8");
			child.stderr.on("data", onChunk);
			child.stderr.on("error", onError);
		},
		onSpawnError(listener) {
			child.on("error", listener);
		},
		onClose(listener) {
			child.once("close", listener);
		},
		kill(signal) {
			child.kill(signal);
		},
	};
}

function signalNodeProcessGroup(pid: number, signal: TerminationSignal | 0): void {
	process.kill(-pid, signal);
}

/**
 * `node:child_process` implementation: no shell, explicit environment, and the
 * child leads its own process group.
 *
 * On abort the whole GROUP gets SIGTERM and, if any member is still alive after
 * the grace period, SIGKILL. That escalation does not depend on the direct
 * child: a CLI that exits promptly while a descendant ignores SIGTERM does not
 * disarm it. After an abort, `exit` resolves only once the group is confirmed
 * gone (or confirmation has been given up after a bounded wait, which is noted
 * in `stderrTail`), so a caller that awaits `exit` never removes the scratch
 * directory from under a live descendant.
 *
 * Limits: a descendant that moves itself into another process group or session
 * escapes group signals. On Windows there are no process groups, so only the
 * direct child is killed.
 */
export function createNodeProcessRunner(options: NodeProcessRunnerOptions = {}): ProcessRunner {
	const resolved: ResolvedOptions = {
		spawnChild: options.spawnChild ?? spawnNodeChild,
		signalProcessGroup: options.signalProcessGroup ?? signalNodeProcessGroup,
		killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
		hasProcessGroups: options.hasProcessGroups ?? process.platform !== "win32",
	};
	return { run: (spec) => runProcess(spec, resolved) };
}

type ResolvedOptions = Required<NodeProcessRunnerOptions>;

function runProcess(spec: ProcessSpec, options: ResolvedOptions): ProcessHandle {
	const child = options.spawnChild(spec, options.hasProcessGroups);

	let stderrTail = "";
	const appendDiagnostic = (text: string): void => {
		stderrTail = `${stderrTail}${text}`.slice(-STDERR_TAIL_CHARS);
	};
	child.onStderr(appendDiagnostic, (error) =>
		appendDiagnostic(`\n[runner] stderr: ${describeThrown(error)}`),
	);

	let childClosed = false;

	const signalTree = (signal: TerminationSignal): void => {
		const pid = child.pid;
		if (pid === undefined) return;
		try {
			if (options.hasProcessGroups) options.signalProcessGroup(pid, signal);
			else child.kill(signal);
		} catch (error) {
			// ESRCH means the group is already gone, which is the state being asked for.
			if (describeThrown(error) !== "ESRCH") {
				appendDiagnostic(`\n[runner] ${signal}: ${describeThrown(error)}`);
			}
		}
	};

	const treeIsAlive = (): boolean => {
		const pid = child.pid;
		if (pid === undefined) return false;
		if (!options.hasProcessGroups) return !childClosed;
		try {
			options.signalProcessGroup(pid, 0);
			return true;
		} catch (error) {
			// ESRCH: no member is left. Anything else (e.g. EPERM) means something still is.
			return describeThrown(error) !== "ESRCH";
		}
	};

	/**
	 * SIGTERM now, SIGKILL after the grace period if anything in the group is
	 * still alive. Resolves when the group is gone, never rejects, and stops
	 * signalling as soon as the group is gone so a recycled pid is never hit.
	 */
	const terminateTree = (): Promise<void> =>
		new Promise((resolve) => {
			signalTree("SIGTERM");
			let waitedMs = 0;
			let forceKilled = false;
			const poll = setInterval(() => {
				waitedMs += GROUP_POLL_MS;
				if (!treeIsAlive()) {
					clearInterval(poll);
					resolve();
				} else if (!forceKilled && waitedMs >= options.killGraceMs) {
					forceKilled = true;
					signalTree("SIGKILL");
				} else if (forceKilled && waitedMs >= options.killGraceMs + KILL_CONFIRM_MS) {
					appendDiagnostic("\n[runner] process group still alive after SIGKILL");
					clearInterval(poll);
					resolve();
				}
			}, GROUP_POLL_MS);
		});

	let termination: Promise<void> | null = null;
	const onAbort = (): void => {
		termination ??= terminateTree();
	};

	const exit = new Promise<ProcessExit>((resolve, reject) => {
		child.onSpawnError((error) => {
			spec.signal.removeEventListener("abort", onAbort);
			reject(error);
		});
		child.onClose((code, signal) => {
			childClosed = true;
			// A run that ended on its own is not signalled later: its pid may be reused.
			spec.signal.removeEventListener("abort", onAbort);
			const settleExit = (): void => resolve({ code, signal, stderrTail });
			// The direct child closing does NOT end an escalation that is already under way.
			if (termination === null) settleExit();
			else termination.then(settleExit, settleExit);
		});
	});
	// Callers awaiting `exit` still observe the rejection; this only keeps a spawn
	// failure nobody awaited from crashing the runner as an unhandled rejection.
	exit.catch((error: unknown) => appendDiagnostic(`\n[runner] spawn: ${describeThrown(error)}`));

	if (spec.signal.aborted) onAbort();
	else spec.signal.addEventListener("abort", onAbort, { once: true });

	// A child that exits before reading its input closes the pipe (EPIPE); the exit
	// status reports that failure, so it is recorded rather than thrown.
	child.writeStdin(spec.stdin ?? "", (error) =>
		appendDiagnostic(`\n[runner] stdin: ${describeThrown(error)}`),
	);

	async function* stdoutLines(): AsyncGenerator<string, void, undefined> {
		try {
			yield* splitLines(child.stdout, MAX_LINE_CHARS);
		} catch (error) {
			// A killed or failed child tears its pipe down mid-read; `exit` carries the outcome.
			appendDiagnostic(`\n[runner] stdout: ${describeThrown(error)}`);
		}
	}

	return { stdoutLines: stdoutLines(), exit };
}
