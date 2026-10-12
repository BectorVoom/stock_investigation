import { err, ok, type Result } from "../result.ts";

/**
 * Research job lifecycle (ARCH-015). The happy path is
 * pending -> claimed -> planning -> collecting -> analyzing -> verifying -> publishing -> completed.
 */
export const JOB_STATES = [
	"pending",
	"claimed",
	"planning",
	"collecting",
	"analyzing",
	"verifying",
	"publishing",
	"completed",
	"failed",
	"cancelled",
	"partial",
	"waiting_approval",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** States in which a runner holds (or held) a lease and is expected to heartbeat. */
export const LEASED_JOB_STATES = [
	"claimed",
	"planning",
	"collecting",
	"analyzing",
	"verifying",
	"publishing",
] as const satisfies readonly JobState[];

export const TERMINAL_JOB_STATES = [
	"completed",
	"failed",
	"cancelled",
	"partial",
] as const satisfies readonly JobState[];

/**
 * Legal transition matrix. `pending` is reachable from every leased state so a
 * job whose runner disappeared becomes eligible again; `partial` is only
 * reachable once collection has produced something worth keeping.
 */
export const JOB_TRANSITIONS: { readonly [S in JobState]: readonly JobState[] } = {
	pending: ["claimed", "cancelled", "failed"],
	claimed: ["planning", "pending", "waiting_approval", "failed", "cancelled"],
	planning: ["collecting", "pending", "waiting_approval", "failed", "cancelled"],
	collecting: ["analyzing", "pending", "waiting_approval", "partial", "failed", "cancelled"],
	analyzing: ["verifying", "pending", "waiting_approval", "partial", "failed", "cancelled"],
	verifying: ["publishing", "pending", "waiting_approval", "partial", "failed", "cancelled"],
	publishing: ["completed", "pending", "partial", "failed", "cancelled"],
	waiting_approval: ["pending", "cancelled", "failed"],
	completed: [],
	failed: [],
	cancelled: [],
	partial: [],
};

export function isJobState(value: string): value is JobState {
	return (JOB_STATES as readonly string[]).includes(value);
}

export function isLeasedJobState(state: JobState): boolean {
	return (LEASED_JOB_STATES as readonly JobState[]).includes(state);
}

export function isTerminalJobState(state: JobState): boolean {
	return (TERMINAL_JOB_STATES as readonly JobState[]).includes(state);
}

export interface IllegalTransition {
	readonly code: "ILLEGAL_TRANSITION";
	readonly from: JobState;
	readonly to: JobState;
}

export function transitionJob(from: JobState, to: JobState): Result<JobState, IllegalTransition> {
	return JOB_TRANSITIONS[from].includes(to)
		? ok(to)
		: err({ code: "ILLEGAL_TRANSITION", from, to });
}
