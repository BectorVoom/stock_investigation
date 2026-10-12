/**
 * Runner supervision (finding 7, task 23b): readiness means the runner has
 * actually reported to the API after THIS launch, a start-up that never sees
 * a report fails with the runner's last error line, a runner exit is
 * reported at once, and a crash loop stops being retried.
 *
 * This module holds the pure decisions so they are unit-tested in
 * `tests/local/supervision.test.ts`; `launch.ts` wires them to processes.
 */

import { readFileSync } from "node:fs";

/** Runner log events that explain why a runner never reported (ARCH-010). */
export const RUNNER_ERROR_EVENTS = [
	"invalid_configuration",
	"unsupported_runtime",
	"runner_crashed",
] as const;

/** How many runner exits without a successful report make a crash loop. */
export const CRASH_LOOP_EXITS = 3;
/** Window the crash-loop exits must fall in to count as a loop. */
export const CRASH_LOOP_WINDOW_MS = 120_000;

/**
 * The last error line in a runner log, or null when the log carries none.
 * WHY the last one: the runner logs once per failure (`invalid_configuration`
 * problems, `unsupported_runtime`, `runner_crashed`), so the tail names the
 * reason a start-up never saw a report. Bounded to one line.
 */
export function lastRunnerErrorLine(logText: string): string | null {
	let last: string | null = null;
	for (const line of logText.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		for (const event of RUNNER_ERROR_EVENTS) {
			if (trimmed.includes(`"${event}"`) || trimmed.includes(event)) {
				last = trimmed.slice(-500);
				break;
			}
		}
	}
	return last;
}

/** Reads a log file for the last error line; null when unreadable or empty. */
export function lastRunnerErrorFromFile(logFile: string): string | null {
	try {
		return lastRunnerErrorLine(readFileSync(logFile, "utf8"));
	} catch {
		return null;
	}
}

/**
 * What a failed start-up says: the exit code when the runner already exited
 * plus its last error line, so the owner sees WHY nothing reported instead
 * of a bare timeout (finding 7). Never throws.
 */
export function summarizeRunnerStartFailure(args: {
	readonly logFile: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly timeoutMs: number;
}): string {
	const lastError = lastRunnerErrorFromFile(args.logFile);
	const ended =
		args.exitCode !== null
			? `exited with code ${args.exitCode}`
			: args.signal !== null
				? `was killed by ${args.signal}`
				: "still running";
	return (
		`the runner did not report to the API within ${Math.round(args.timeoutMs / 1000)}s ` +
		`(runner ${ended}). ` +
		(lastError === null
			? `See ${args.logFile} for details.`
			: `Last runner error: ${lastError}. See ${args.logFile} for details.`)
	);
}

/**
 * Counts runner exits that had no successful report between them. Three
 * exits within a short window stop being retried: the launcher fails with a
 * message that says so instead of waiting for another restart that will
 * crash the same way (finding 7).
 */
export class CrashLoop {
	private exits: number[] = [];

	constructor(
		private readonly windowMs: number = CRASH_LOOP_WINDOW_MS,
		private readonly maxExits: number = CRASH_LOOP_EXITS,
	) {}

	/** Records a successful report: the loop counter starts over. */
	reportSuccess(): void {
		this.exits = [];
	}

	/**
	 * Records a runner exit (or crash line) at `nowMs`. Returns true when
	 * the launcher must stop retrying and say so.
	 */
	recordExit(nowMs: number): boolean {
		this.exits.push(nowMs);
		const cutoff = nowMs - this.windowMs;
		this.exits = this.exits.filter((at) => at >= cutoff);
		return this.exits.length >= this.maxExits;
	}

	/** One-line verdict for the failure message. */
	describe(): string {
		return (
			`the runner exited ${this.exits.length} times within ` +
			`${Math.round(this.windowMs / 1000)}s without a successful report ` +
			`(crash loop); not retrying. See the runner log for details.`
		);
	}
}
