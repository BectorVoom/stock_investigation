import type { AgentEvent } from "@research/contracts";
import type { JsonValue } from "@research/domain";
import {
	isCommandNotFound,
	MAX_TERMINATION_MS,
	type ProcessExit,
	type ProcessHandle,
	type ProcessRunner,
} from "./processRunner.ts";
import {
	COMPLETED_EVENT,
	createTurnGuard,
	failedEvent,
	failureForStop,
	MAX_MALFORMED_LINES,
	MAX_OUTPUT_TEXT_CHARS,
	MAX_RAW_STREAM_CHARS,
	PROVIDER_FAILURES,
	type ProviderFailure,
	raceStop,
	settle,
	textDeltaEvent,
	usageEvent,
} from "./turn.ts";

/** What one stdout line means to the turn. */
export type LineVerdict =
	| { readonly kind: "ignored" }
	| { readonly kind: "malformed" }
	| { readonly kind: "text"; readonly text: string }
	/**
	 * A research-tool request for the orchestrator, which authorizes and runs
	 * it under its own policy (ADR-0003). Nothing ran inside the CLI.
	 */
	| {
			readonly kind: "tool.request";
			readonly toolId: string;
			readonly args: JsonValue;
			readonly callId: string;
	  }
	/** The turn is complete before the CLI exits: stop the process and report success. */
	| { readonly kind: "finished" }
	/** Ends the turn immediately and terminates the process (e.g. a tool was used). */
	| { readonly kind: "fatal"; readonly failure: ProviderFailure };

export const IGNORED: LineVerdict = { kind: "ignored" };
export const MALFORMED: LineVerdict = { kind: "malformed" };

export interface TurnConclusion {
	/** `null` means the turn succeeded. */
	readonly failure: ProviderFailure | null;
	/** Text the provider only delivered at the end (not streamed earlier). */
	readonly trailingText: string;
	readonly knownCostUsd: number | null;
}

/**
 * The provider-specific part of a CLI adapter: a small state machine over the
 * CLI's stdout lines. It performs no I/O, so it is tested with recorded output.
 */
export interface CliStreamInterpreter {
	interpretLine(line: string): LineVerdict;
	conclude(exit: ProcessExit, emittedTextChars: number): TurnConclusion;
}

export interface CliInvocation {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly stdin: string;
}

export interface CliTurnInput {
	readonly processRunner: ProcessRunner;
	readonly invocation: CliInvocation;
	readonly interpreter: CliStreamInterpreter;
	readonly externalSignal: AbortSignal;
	readonly deadlineEpochMs: number;
	readonly nowEpochMs: number;
}

function spawnFailure(error: unknown): ProviderFailure {
	return isCommandNotFound(error)
		? PROVIDER_FAILURES.PROVIDER_NOT_INSTALLED
		: PROVIDER_FAILURES.PROVIDER_SPAWN_FAILED;
}

type Spawned =
	| { readonly ok: true; readonly handle: ProcessHandle }
	| { readonly ok: false; readonly failure: ProviderFailure };

function spawnCli(input: CliTurnInput, signal: AbortSignal): Spawned {
	try {
		return { ok: true, handle: input.processRunner.run({ ...input.invocation, signal }) };
	} catch (error) {
		return { ok: false, failure: spawnFailure(error) };
	}
}

/**
 * How long a stopped turn waits for the runner to confirm the process tree is
 * gone before reporting its outcome anyway. It exceeds the Node runner's own
 * worst case, so the wait only ever expires for a runner that never settles.
 */
export const PROCESS_REAP_WAIT_MS = MAX_TERMINATION_MS + 1_000;

/** Resolves when `work` settles or after `timeoutMs`, whichever is first; leaves no timer behind. */
function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, timeoutMs);
		const done = (): void => {
			clearTimeout(timer);
			resolve();
		};
		work.then(done, done);
	});
}

/** Stops waiting on a stream whose outcome is already decided; its late result is irrelevant. */
function abandon(iterator: AsyncIterator<string>): void {
	const noLongerNeeded = (): void => undefined;
	iterator.return?.().then(noLongerNeeded, noLongerNeeded);
}

/**
 * Runs one CLI turn: spawn, stream stdout through the interpreter, enforce the
 * deadline, cancellation and output budget, and always end with exactly one
 * `completed` or `failed` event. Provider-side failures never throw.
 *
 * Once a process has been started, a `usage` event with an unknown cost is
 * emitted even on failure: plan quota may have been consumed and the amount is
 * not observable, which must not read as "nothing was spent".
 *
 * A turn that stops its process (cancellation, deadline, fatal line) reports
 * its terminal event only after the runner has confirmed the process tree is
 * gone, bounded by PROCESS_REAP_WAIT_MS. The caller may therefore discard the
 * scratch directory as soon as it sees the terminal event.
 */
export async function* runCliTurn(
	input: CliTurnInput,
): AsyncGenerator<AgentEvent, void, undefined> {
	const guard = createTurnGuard(input.externalSignal, input.deadlineEpochMs, input.nowEpochMs);
	const stoppedBeforeSpawn = guard.reason();
	if (stoppedBeforeSpawn !== null) {
		yield failedEvent(failureForStop(stoppedBeforeSpawn));
		return;
	}
	const spawned = spawnCli(input, guard.signal);
	if (!spawned.ok) {
		guard.stop("finished");
		yield failedEvent(spawned.failure);
		return;
	}
	const exitOutcome = settle(spawned.handle.exit);
	const lines = spawned.handle.stdoutLines[Symbol.asyncIterator]();
	let acceptedChars = 0;
	let emittedTextChars = 0;
	let malformedLines = 0;
	let fatal: ProviderFailure | null = null;
	let finishedEarly = false;
	let reaping: Promise<void> | null = null;
	const stopAndReap = (): Promise<void> => {
		guard.stop("finished");
		reaping ??= settledWithin(exitOutcome, PROCESS_REAP_WAIT_MS);
		return reaping;
	};
	try {
		while (fatal === null && !finishedEarly) {
			const next = await raceStop(guard, settle(lines.next()));
			if (next.kind === "stopped") break;
			// A stream that errors has simply ended; the exit status decides what that means.
			if (!next.value.ok || next.value.value.done === true) break;
			const line = next.value.value.value;
			acceptedChars += line.length + 1;
			if (acceptedChars > MAX_RAW_STREAM_CHARS) {
				fatal = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
				break;
			}
			if (line.trim() === "") continue;
			const verdict = input.interpreter.interpretLine(line);
			if (verdict.kind === "text") {
				if (verdict.text.length === 0) continue;
				emittedTextChars += verdict.text.length;
				if (emittedTextChars > MAX_OUTPUT_TEXT_CHARS) {
					fatal = PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE;
					break;
				}
				yield textDeltaEvent(verdict.text);
			} else if (verdict.kind === "tool.request") {
				yield {
					type: "tool.request",
					toolId: verdict.toolId,
					args: verdict.args,
					callId: verdict.callId,
				};
			} else if (verdict.kind === "finished") {
				finishedEarly = true;
			} else if (verdict.kind === "fatal") {
				fatal = verdict.failure;
			} else if (verdict.kind === "malformed") {
				malformedLines += 1;
				if (malformedLines > MAX_MALFORMED_LINES) fatal = PROVIDER_FAILURES.PROVIDER_OUTPUT_INVALID;
			}
		}

		if (fatal !== null) {
			await stopAndReap();
			yield usageEvent(null);
			yield failedEvent(fatal);
			return;
		}
		if (finishedEarly && guard.reason() === null) {
			// The interpreter has everything the turn needs; the CLI would only
			// start another model step. Its exit status no longer decides anything.
			await stopAndReap();
			yield usageEvent(null);
			yield COMPLETED_EVENT;
			return;
		}
		// Checked explicitly so a cancellation is never reported as whatever the dying process printed.
		const stopReason = guard.reason();
		if (stopReason !== null) {
			await stopAndReap();
			yield usageEvent(null);
			yield failedEvent(failureForStop(stopReason));
			return;
		}
		const exited = await raceStop(guard, exitOutcome);
		if (exited.kind === "stopped") {
			await stopAndReap();
			yield usageEvent(null);
			yield failedEvent(failureForStop(exited.reason));
			return;
		}
		if (!exited.value.ok) {
			yield failedEvent(spawnFailure(exited.value.error));
			return;
		}
		const conclusion = input.interpreter.conclude(exited.value.value, emittedTextChars);
		const failure =
			conclusion.failure === null && conclusion.trailingText.length > MAX_OUTPUT_TEXT_CHARS
				? PROVIDER_FAILURES.PROVIDER_OUTPUT_TOO_LARGE
				: conclusion.failure;
		if (failure === null && conclusion.trailingText.length > 0) {
			yield textDeltaEvent(conclusion.trailingText);
		}
		yield usageEvent(conclusion.knownCostUsd);
		yield failure === null ? COMPLETED_EVENT : failedEvent(failure);
	} finally {
		// Also reached when the consumer stops iterating early: never leave a CLI running,
		// and do not hand control back while its process tree is still being torn down.
		abandon(lines);
		await stopAndReap();
	}
}

/** Joins whole text segments (one per provider message) without gluing words together. */
export function createSegmentJoiner(): (segment: string) => string {
	let previousEndedWithNewline = true;
	return (segment) => {
		if (segment.length === 0) return "";
		const joined = previousEndedWithNewline ? segment : `\n${segment}`;
		previousEndedWithNewline = segment.endsWith("\n");
		return joined;
	};
}
