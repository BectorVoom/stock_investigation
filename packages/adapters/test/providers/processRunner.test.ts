import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createNodeProcessRunner,
	type ProcessExit,
	type ProcessHandle,
	type SpawnedChild,
	type TerminationSignal,
} from "../../src/providers/index.ts";

/** These tests run the real runner against `node` itself, the one binary guaranteed to exist. */
const NODE = process.execPath;
const runner = createNodeProcessRunner();
const isWindows = process.platform === "win32";

function runNode(
	script: string,
	options: {
		env?: Record<string, string>;
		stdin?: string;
		signal?: AbortSignal;
		args?: string[];
	} = {},
): ProcessHandle {
	return runner.run({
		command: NODE,
		args: ["-e", script, ...(options.args ?? [])],
		cwd: process.cwd(),
		env: options.env ?? {},
		stdin: options.stdin,
		signal: options.signal ?? new AbortController().signal,
	});
}

async function linesOf(handle: ProcessHandle): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of handle.stdoutLines) lines.push(line);
	return lines;
}

const pidsSchema = z.object({ child: z.number().int(), grandchild: z.number().int() });

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		// ESRCH: no such process, which is exactly what the caller is asking about.
		return false;
	}
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

describe("createNodeProcessRunner", () => {
	it("streams stdout as lines, feeds stdin and reports the exit code and stderr tail", async () => {
		const handle = runNode(
			`let input = "";
			process.stdin.on("data", (chunk) => { input += chunk; });
			process.stdin.on("end", () => {
				process.stdout.write("first\\nsecond:" + input + "\\n");
				process.stderr.write("warning text");
				process.exitCode = 3;
			});`,
			{ stdin: "from-stdin" },
		);
		expect(await linesOf(handle)).toEqual(["first", "second:from-stdin"]);
		expect(await handle.exit).toEqual({ code: 3, signal: null, stderrTail: "warning text" });
	});

	it("gives the child exactly the environment it was handed, nothing inherited", async () => {
		const handle = runNode(
			`const keys = Object.keys(process.env).filter((key) => !key.startsWith("__CF"));
			console.log(JSON.stringify(keys.sort()));`,
			{ env: { ONLY_THIS: "1", AND_THIS: "2" } },
		);
		const [keysJson] = await linesOf(handle);
		expect(JSON.parse(keysJson ?? "null")).toEqual(["AND_THIS", "ONLY_THIS"]);
		expect((await handle.exit).code).toBe(0);
	});

	it("passes arguments literally, without a shell", async () => {
		const handle = runNode("console.log(process.argv.slice(1).join('|'))", {
			args: ["$(echo injected)", "; touch /tmp/should-not-exist", "`id`"],
		});
		expect(await linesOf(handle)).toEqual(["$(echo injected)|; touch /tmp/should-not-exist|`id`"]);
	});

	it("rejects `exit` with ENOENT and ends stdout when the command does not exist", async () => {
		const handle = runner.run({
			command: "/nonexistent/definitely-not-a-binary",
			args: [],
			cwd: process.cwd(),
			env: {},
			signal: new AbortController().signal,
		});
		await expect(handle.exit).rejects.toMatchObject({ code: "ENOENT" });
		expect(await linesOf(handle)).toEqual([]);
	});

	it("bounds the stderr it keeps to a tail", async () => {
		const handle = runNode(`process.stderr.write("a".repeat(50000) + "TAIL-MARKER")`);
		await linesOf(handle);
		const exit = await handle.exit;
		expect(exit.stderrTail.length).toBeLessThanOrEqual(4_096);
		expect(exit.stderrTail.endsWith("TAIL-MARKER")).toBe(true);
	});

	it.skipIf(isWindows)(
		"terminates the whole process group on abort, including a grandchild",
		async () => {
			const controller = new AbortController();
			const handle = runNode(
				`const { spawn } = require("node:child_process");
				const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
				console.log(JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
				setInterval(() => {}, 1000);`,
				{ signal: controller.signal },
			);
			const lines = handle.stdoutLines[Symbol.asyncIterator]();
			const first = await lines.next();
			const { child, grandchild } = pidsSchema.parse(
				JSON.parse(first.done === true ? "null" : first.value),
			);

			controller.abort();
			const exit = await handle.exit;

			expect(exit.signal).toBe("SIGTERM");
			expect(await waitUntilDead(child, 3_000)).toBe(true);
			expect(await waitUntilDead(grandchild, 3_000)).toBe(true);
		},
	);

	it.skipIf(isWindows)("kills immediately when the signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const handle = runNode("setInterval(() => {}, 1000)", { signal: controller.signal });
		await linesOf(handle);
		expect((await handle.exit).signal).toBe("SIGTERM");
	});
});

describe.skipIf(isWindows)(
	"createNodeProcessRunner with real processes that resist SIGTERM",
	() => {
		it("SIGKILLs a descendant that ignores SIGTERM after its parent has already exited, before `exit` resolves", async () => {
			const graceMs = 200;
			const fastRunner = createNodeProcessRunner({ killGraceMs: graceMs });
			const controller = new AbortController();
			// The grandchild ignores SIGTERM and holds none of the parent's pipes, so the parent's
			// `close` fires as soon as the parent dies from SIGTERM, long before the grace period ends.
			const handle = fastRunner.run({
				command: NODE,
				args: [
					"-e",
					`const { spawn } = require("node:child_process");
				const grandchild = spawn(
					process.execPath,
					["-e", "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000);"],
					{ stdio: ["ignore", "ignore", "ignore", "ipc"] },
				);
				grandchild.on("message", () => {
					console.log(JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
				});
				setInterval(() => {}, 1000);`,
				],
				cwd: process.cwd(),
				env: {},
				signal: controller.signal,
			});
			const lines = handle.stdoutLines[Symbol.asyncIterator]();
			const first = await lines.next();
			const { child, grandchild } = pidsSchema.parse(
				JSON.parse(first.done === true ? "null" : first.value),
			);

			const abortedAt = Date.now();
			controller.abort();
			const exit = await handle.exit;

			// No waiting here: when `exit` resolves, the whole group must already be gone.
			expect(isAlive(grandchild)).toBe(false);
			expect(isAlive(child)).toBe(false);
			expect(exit.signal).toBe("SIGTERM");
			// It took the escalation (not the parent's own prompt exit) to get there.
			expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(graceMs - 30);
		});
	},
);

interface FakeChild {
	readonly child: SpawnedChild;
	/** Signals sent to the direct child only (the Windows path). */
	readonly directKills: TerminationSignal[];
	close(code: number | null, signal: string | null): void;
	failSpawn(error: unknown): void;
}

function createFakeChild(pid: number | undefined): FakeChild {
	let closeListener: ((code: number | null, signal: string | null) => void) | undefined;
	let spawnErrorListener: ((error: unknown) => void) | undefined;
	let endStdout: () => void = () => undefined;
	const stdoutEnded = new Promise<void>((resolve) => {
		endStdout = resolve;
	});
	const directKills: TerminationSignal[] = [];
	const stdout: AsyncIterable<string> = {
		[Symbol.asyncIterator]: () => ({
			next: () => stdoutEnded.then(() => ({ done: true, value: undefined })),
		}),
	};
	return {
		directKills,
		child: {
			pid,
			stdout,
			writeStdin: () => undefined,
			onStderr: () => undefined,
			onSpawnError: (listener) => {
				spawnErrorListener = listener;
			},
			onClose: (listener) => {
				closeListener = listener;
			},
			kill: (signal) => {
				directKills.push(signal);
			},
		},
		close(code, signal) {
			endStdout();
			closeListener?.(code, signal);
		},
		failSpawn(error) {
			endStdout();
			spawnErrorListener?.(error);
		},
	};
}

interface FakeGroup {
	/** Every real (non-probe) signal sent to the group, in order. */
	readonly sent: { pid: number; signal: TerminationSignal }[];
	readonly signalProcessGroup: (pid: number, signal: TerminationSignal | 0) => void;
}

/** A process group that stays alive until it receives one of `diesOn` (never, if empty). */
function createFakeGroup(diesOn: readonly TerminationSignal[]): FakeGroup {
	let alive = true;
	const sent: { pid: number; signal: TerminationSignal }[] = [];
	return {
		sent,
		signalProcessGroup(pid, signal) {
			if (signal !== 0) sent.push({ pid, signal });
			if (!alive) throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			if (signal !== 0 && diesOn.includes(signal)) alive = false;
		},
	};
}

describe("createNodeProcessRunner termination escalation (fake child, fake clock)", () => {
	const PID = 4242;
	const GRACE_MS = 2_000;

	function start(options: {
		diesOn: readonly TerminationSignal[];
		pid?: number | undefined;
		hasProcessGroups?: boolean;
		preAborted?: boolean;
	}) {
		const fakeChild = createFakeChild("pid" in options ? options.pid : PID);
		const group = createFakeGroup(options.diesOn);
		const controller = new AbortController();
		if (options.preAborted === true) controller.abort();
		const handle = createNodeProcessRunner({
			spawnChild: () => fakeChild.child,
			signalProcessGroup: group.signalProcessGroup,
			killGraceMs: GRACE_MS,
			hasProcessGroups: options.hasProcessGroups ?? true,
		}).run({ command: "fake", args: [], cwd: "/", env: {}, signal: controller.signal });
		const outcome: { exit: ProcessExit | null; error: unknown } = { exit: null, error: null };
		handle.exit.then(
			(exit) => {
				outcome.exit = exit;
			},
			(error: unknown) => {
				outcome.error = error;
			},
		);
		return { fakeChild, group, controller, outcome };
	}

	async function withFakeClock(body: () => Promise<void>): Promise<void> {
		vi.useFakeTimers();
		try {
			await body();
		} finally {
			vi.useRealTimers();
		}
	}

	it("still SIGKILLs the group after the grace period when the direct child closed long before it", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({ diesOn: ["SIGKILL"] });

			controller.abort();
			expect(group.sent).toEqual([{ pid: PID, signal: "SIGTERM" }]);

			// The CLI itself exits at once; a descendant in its group ignores SIGTERM.
			fakeChild.close(null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
			expect(group.sent).toEqual([{ pid: PID, signal: "SIGTERM" }]);
			// `exit` is held back: the scratch directory must not be removed under the survivor.
			expect(outcome.exit).toBeNull();

			await vi.advanceTimersByTimeAsync(100);
			expect(group.sent).toEqual([
				{ pid: PID, signal: "SIGTERM" },
				{ pid: PID, signal: "SIGKILL" },
			]);

			await vi.advanceTimersByTimeAsync(50);
			expect(outcome.exit).toEqual({ code: null, signal: "SIGTERM", stderrTail: "" });
			expect(vi.getTimerCount()).toBe(0);
		}));

	it("resolves promptly and sends no SIGKILL when SIGTERM emptied the group", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({ diesOn: ["SIGTERM"] });

			controller.abort();
			fakeChild.close(null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(50);

			expect(outcome.exit).toEqual({ code: null, signal: "SIGTERM", stderrTail: "" });
			await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
			// Nothing is signalled once the group is gone: its pid could belong to someone else by then.
			expect(group.sent).toEqual([{ pid: PID, signal: "SIGTERM" }]);
			expect(vi.getTimerCount()).toBe(0);
		}));

	it("SIGKILLs a group whose leader never closes on SIGTERM, then resolves once it has", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({ diesOn: ["SIGKILL"] });

			controller.abort();
			await vi.advanceTimersByTimeAsync(GRACE_MS);
			expect(group.sent.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
			expect(outcome.exit).toBeNull();

			fakeChild.close(null, "SIGKILL");
			await vi.advanceTimersByTimeAsync(50);
			expect(outcome.exit).toEqual({ code: null, signal: "SIGKILL", stderrTail: "" });
		}));

	it("gives up confirming after a bounded wait when the group cannot be killed, and says so", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({ diesOn: [] });

			controller.abort();
			fakeChild.close(null, "SIGTERM");
			await vi.advanceTimersByTimeAsync(GRACE_MS + 900);
			expect(outcome.exit).toBeNull();

			await vi.advanceTimersByTimeAsync(200);
			expect(group.sent.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
			expect(outcome.exit?.stderrTail).toContain("process group still alive after SIGKILL");
			expect(vi.getTimerCount()).toBe(0);
		}));

	it("resolves at close without signalling when nothing was aborted, and ignores a later abort", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({ diesOn: [] });

			fakeChild.close(0, null);
			await vi.advanceTimersByTimeAsync(0);
			expect(outcome.exit).toEqual({ code: 0, signal: null, stderrTail: "" });

			// The run is over; its pid may be reused, so a late abort must not signal anything.
			controller.abort();
			await vi.advanceTimersByTimeAsync(GRACE_MS * 2);
			expect(group.sent).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		}));

	it("starts terminating at once when the signal was aborted before the spawn", () =>
		withFakeClock(async () => {
			const { group } = start({ diesOn: ["SIGTERM"], preAborted: true });

			expect(group.sent).toEqual([{ pid: PID, signal: "SIGTERM" }]);
			await vi.advanceTimersByTimeAsync(50);
			expect(vi.getTimerCount()).toBe(0);
		}));

	it("rejects `exit` and signals nothing when the process never started", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({ diesOn: [], pid: undefined });

			controller.abort();
			fakeChild.failSpawn(Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
			await vi.advanceTimersByTimeAsync(50);

			expect(outcome.error).toMatchObject({ code: "ENOENT" });
			expect(group.sent).toEqual([]);
			expect(fakeChild.directKills).toEqual([]);
			expect(vi.getTimerCount()).toBe(0);
		}));

	it("without process groups, signals only the direct child and escalates until it closes", () =>
		withFakeClock(async () => {
			const { fakeChild, group, controller, outcome } = start({
				diesOn: [],
				hasProcessGroups: false,
			});

			controller.abort();
			expect(fakeChild.directKills).toEqual(["SIGTERM"]);
			await vi.advanceTimersByTimeAsync(GRACE_MS);
			expect(fakeChild.directKills).toEqual(["SIGTERM", "SIGKILL"]);

			fakeChild.close(null, "SIGKILL");
			await vi.advanceTimersByTimeAsync(50);
			expect(outcome.exit).toEqual({ code: null, signal: "SIGKILL", stderrTail: "" });
			expect(group.sent).toEqual([]);
		}));
});
