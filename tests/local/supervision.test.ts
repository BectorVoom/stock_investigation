import { describe, expect, it } from "vitest";
import {
	CRASH_LOOP_EXITS,
	CrashLoop,
	lastRunnerErrorLine,
	summarizeRunnerStartFailure,
} from "../../scripts/supervision.ts";

/**
 * Finding 7 (task 23b): readiness means a post-launch report; a start-up
 * that never sees one fails with the runner's last error line; a crash loop
 * stops being retried. Each test fails before the fix (free-text passthrough
 * / warn-and-continue / unbounded retries).
 */
describe("runner supervision (finding 7, task 23b)", () => {
	it("finds the last runner error line in a log", () => {
		const log = [
			'{"event":"runner_started","runtime":"node"}',
			'{"event":"invalid_configuration","problem":"RESEARCH_API_URL must be https"}',
			'{"event":"heartbeat_failed","code":"TIMEOUT"}',
			'{"event":"runner_crashed","error":"TypeError"}',
		].join("\n");
		expect(lastRunnerErrorLine(log)).toContain("runner_crashed");
		expect(
			lastRunnerErrorLine('{"event":"runner_started"}\n{"event":"job_finished"}\n'),
		).toBeNull();
		expect(lastRunnerErrorLine("")).toBeNull();
	});

	it("summarizes a failed start with the exit code and the last error line", () => {
		const message = summarizeRunnerStartFailure({
			logFile: "/nonexistent/runner.log",
			exitCode: 1,
			signal: null,
			timeoutMs: 45_000,
		});
		expect(message).toContain("did not report");
		expect(message).toContain("exited with code 1");
		const running = summarizeRunnerStartFailure({
			logFile: "/nonexistent/runner.log",
			exitCode: null,
			signal: null,
			timeoutMs: 45_000,
		});
		expect(running).toContain("still running");
		const killed = summarizeRunnerStartFailure({
			logFile: "/nonexistent/runner.log",
			exitCode: null,
			signal: "SIGTERM",
			timeoutMs: 45_000,
		});
		expect(killed).toContain("was killed by SIGTERM");
	});

	it("stops retrying after three exits in the window without a report", () => {
		const loop = new CrashLoop(120_000, CRASH_LOOP_EXITS);
		const start = 1_000_000;
		expect(loop.recordExit(start)).toBe(false);
		expect(loop.recordExit(start + 10_000)).toBe(false);
		expect(loop.recordExit(start + 20_000)).toBe(true);
		expect(loop.describe()).toContain("crash loop");
	});

	it("a successful report resets the crash counter", () => {
		const loop = new CrashLoop(120_000, CRASH_LOOP_EXITS);
		const start = 2_000_000;
		expect(loop.recordExit(start)).toBe(false);
		expect(loop.recordExit(start + 10_000)).toBe(false);
		loop.reportSuccess();
		expect(loop.recordExit(start + 20_000)).toBe(false);
		expect(loop.recordExit(start + 30_000)).toBe(false);
		expect(loop.recordExit(start + 40_000)).toBe(true);
	});

	it("old exits age out of the window", () => {
		const loop = new CrashLoop(60_000, CRASH_LOOP_EXITS);
		expect(loop.recordExit(0)).toBe(false);
		expect(loop.recordExit(10_000)).toBe(false);
		// Both earlier exits are outside the window now: no loop.
		expect(loop.recordExit(200_000)).toBe(false);
	});
});
