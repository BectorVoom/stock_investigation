import { describe, expect, it } from "vitest";
import {
	isJobState,
	isLeasedJobState,
	isTerminalJobState,
	JOB_STATES,
	JOB_TRANSITIONS,
	type JobState,
	LEASED_JOB_STATES,
	TERMINAL_JOB_STATES,
	transitionJob,
} from "../../src/jobs/stateMachine.ts";

/** Section 6.3 of the architecture document, written out independently of the implementation. */
const HAPPY_PATH: readonly JobState[] = [
	"pending",
	"claimed",
	"planning",
	"collecting",
	"analyzing",
	"verifying",
	"publishing",
	"completed",
];

describe("job state sets", () => {
	it("contains exactly the documented lifecycle and exception states", () => {
		expect([...JOB_STATES].sort()).toEqual(
			[...HAPPY_PATH, "failed", "cancelled", "partial", "waiting_approval"].sort(),
		);
		expect(new Set(JOB_STATES).size).toBe(JOB_STATES.length);
	});

	it("defines a transition row for every state and only targets known states", () => {
		expect(Object.keys(JOB_TRANSITIONS).sort()).toEqual([...JOB_STATES].sort());
		for (const state of JOB_STATES) {
			for (const target of JOB_TRANSITIONS[state]) expect(JOB_STATES).toContain(target);
			expect(new Set(JOB_TRANSITIONS[state]).size).toBe(JOB_TRANSITIONS[state].length);
		}
	});

	it("treats completed, failed, cancelled and partial as terminal", () => {
		expect([...TERMINAL_JOB_STATES].sort()).toEqual([
			"cancelled",
			"completed",
			"failed",
			"partial",
		]);
		for (const state of JOB_STATES) {
			expect(isTerminalJobState(state)).toBe(
				["cancelled", "completed", "failed", "partial"].includes(state),
			);
		}
	});

	it("treats exactly the in-flight states as leased", () => {
		const leased = ["claimed", "planning", "collecting", "analyzing", "verifying", "publishing"];
		expect([...LEASED_JOB_STATES].sort()).toEqual([...leased].sort());
		for (const state of JOB_STATES) expect(isLeasedJobState(state)).toBe(leased.includes(state));
	});

	it("keeps pending and waiting_approval neither leased nor terminal", () => {
		for (const state of ["pending", "waiting_approval"] as const) {
			expect(isLeasedJobState(state)).toBe(false);
			expect(isTerminalJobState(state)).toBe(false);
		}
	});

	it("recognizes state names at runtime", () => {
		for (const state of JOB_STATES) expect(isJobState(state)).toBe(true);
		for (const text of ["", "PENDING", "done", "running", "constructor", "toString"]) {
			expect(isJobState(text)).toBe(false);
		}
	});
});

describe("transitionJob", () => {
	it("allows each step of the happy path", () => {
		for (let index = 0; index + 1 < HAPPY_PATH.length; index += 1) {
			const from = HAPPY_PATH[index];
			const to = HAPPY_PATH[index + 1];
			if (from === undefined || to === undefined) throw new Error("unreachable");
			expect(transitionJob(from, to)).toEqual({ ok: true, value: to });
		}
	});

	it("does not allow skipping a happy-path step", () => {
		for (let index = 0; index + 2 < HAPPY_PATH.length; index += 1) {
			const from = HAPPY_PATH[index];
			const skipped = HAPPY_PATH[index + 2];
			if (from === undefined || skipped === undefined) throw new Error("unreachable");
			expect(transitionJob(from, skipped)).toEqual({
				ok: false,
				error: { code: "ILLEGAL_TRANSITION", from, to: skipped },
			});
		}
	});

	it("never leaves a terminal state", () => {
		for (const terminal of TERMINAL_JOB_STATES) {
			expect(JOB_TRANSITIONS[terminal]).toEqual([]);
			for (const target of JOB_STATES) {
				expect(transitionJob(terminal, target)).toEqual({
					ok: false,
					error: { code: "ILLEGAL_TRANSITION", from: terminal, to: target },
				});
			}
		}
	});

	it("has no self-transitions", () => {
		for (const state of JOB_STATES) expect(transitionJob(state, state).ok).toBe(false);
	});

	it("lets every leased state fall back to pending when its runner disappears (AGT-011)", () => {
		for (const state of LEASED_JOB_STATES) {
			expect(transitionJob(state, "pending")).toEqual({ ok: true, value: "pending" });
		}
	});

	it("lets every non-terminal state fail or be cancelled", () => {
		for (const state of JOB_STATES) {
			if (isTerminalJobState(state)) continue;
			expect(transitionJob(state, "failed").ok).toBe(true);
			expect(transitionJob(state, "cancelled").ok).toBe(true);
		}
	});

	it("only reaches completed from publishing", () => {
		for (const state of JOB_STATES) {
			expect(transitionJob(state, "completed").ok).toBe(state === "publishing");
		}
	});

	it("only allows a partial result once collection has started", () => {
		const mayBePartial = ["collecting", "analyzing", "verifying", "publishing"];
		for (const state of JOB_STATES) {
			expect(transitionJob(state, "partial").ok).toBe(mayBePartial.includes(state));
		}
	});

	it("resumes a job waiting for approval only through pending", () => {
		expect([...JOB_TRANSITIONS.waiting_approval].sort()).toEqual([
			"cancelled",
			"failed",
			"pending",
		]);
		expect(transitionJob("waiting_approval", "planning").ok).toBe(false);
		expect(transitionJob("waiting_approval", "completed").ok).toBe(false);
	});

	it("can only be claimed from pending", () => {
		for (const state of JOB_STATES) {
			expect(transitionJob(state, "claimed").ok).toBe(state === "pending");
		}
	});

	it("never moves backwards along the happy path except to pending", () => {
		for (let later = 2; later < HAPPY_PATH.length; later += 1) {
			for (let earlier = 1; earlier < later; earlier += 1) {
				const from = HAPPY_PATH[later];
				const to = HAPPY_PATH[earlier];
				if (from === undefined || to === undefined) throw new Error("unreachable");
				expect(transitionJob(from, to).ok).toBe(false);
			}
		}
	});
});
