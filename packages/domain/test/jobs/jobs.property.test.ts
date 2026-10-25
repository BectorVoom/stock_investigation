import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	addUsage,
	checkBudget,
	EMPTY_USAGE,
	type ResearchBudget,
	type ResourceUsage,
	summarizeCost,
	type UsageDelta,
} from "../../src/jobs/budget.ts";
import {
	checkLease,
	decideClaim,
	type JobLeaseView,
	leaseExpiryIso,
} from "../../src/jobs/lease.ts";
import {
	isLeasedJobState,
	isTerminalJobState,
	JOB_STATES,
	JOB_TRANSITIONS,
	type JobState,
	transitionJob,
} from "../../src/jobs/stateMachine.ts";

const jobState = fc.constantFrom<JobState>(...JOB_STATES);

describe("job state machine properties (ARCH-015)", () => {
	it("random walks over the transition matrix never leave a terminal state", () => {
		fc.assert(
			fc.property(jobState, fc.array(fc.nat(), { maxLength: 40 }), (start, choices) => {
				let state = start;
				let reachedTerminal = false;
				for (const choice of choices) {
					const options = JOB_TRANSITIONS[state];
					if (isTerminalJobState(state)) {
						reachedTerminal = true;
						expect(options).toEqual([]);
					}
					const next = options[choice % Math.max(1, options.length)];
					if (next === undefined) break;
					// A legal move must be accepted by transitionJob, and must not escape a terminal state.
					expect(reachedTerminal).toBe(false);
					expect(transitionJob(state, next)).toEqual({ ok: true, value: next });
					state = next;
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("arbitrary transition attempts never move a job out of a terminal state", () => {
		fc.assert(
			fc.property(jobState, fc.array(jobState, { maxLength: 40 }), (start, attempts) => {
				let state = start;
				let terminalState: JobState | null = null;
				for (const target of attempts) {
					const result = transitionJob(state, target);
					if (result.ok) state = result.value;
					else
						expect(result.error).toEqual({ code: "ILLEGAL_TRANSITION", from: state, to: target });
					if (terminalState !== null) expect(state).toBe(terminalState);
					else if (isTerminalJobState(state)) terminalState = state;
				}
			}),
			{ numRuns: 500 },
		);
	});

	it("transitionJob accepts exactly the pairs listed in the matrix", () => {
		fc.assert(
			fc.property(jobState, jobState, (from, to) => {
				expect(transitionJob(from, to).ok).toBe(JOB_TRANSITIONS[from].includes(to));
			}),
			{ numRuns: 300 },
		);
	});

	it("every non-terminal state can reach a terminal state, and completed is reachable from pending", () => {
		function reachable(start: JobState): ReadonlySet<JobState> {
			const seen = new Set<JobState>([start]);
			const queue: JobState[] = [start];
			for (let state = queue.shift(); state !== undefined; state = queue.shift()) {
				for (const next of JOB_TRANSITIONS[state]) {
					if (!seen.has(next)) {
						seen.add(next);
						queue.push(next);
					}
				}
			}
			return seen;
		}
		for (const state of JOB_STATES) {
			if (isTerminalJobState(state)) continue;
			expect([...reachable(state)].some(isTerminalJobState)).toBe(true);
		}
		expect(reachable("pending").has("completed")).toBe(true);
		// No state is orphaned: everything is reachable from the initial state.
		expect([...reachable("pending")].sort()).toEqual([...JOB_STATES].sort());
	});
});

const NOW_MS = 1_791_676_800_000;

const leaseView: fc.Arbitrary<JobLeaseView> = fc.record({
	state: jobState,
	leaseGeneration: fc.nat({ max: 1000 }),
	leaseOwnerId: fc.option(fc.constantFrom("runner_a", "runner_b"), { nil: null }),
	leaseExpiresAt: fc.option(
		fc.oneof(
			fc
				.integer({ min: -3_600_000, max: 3_600_000 })
				.map((offset) => leaseExpiryIso(NOW_MS, offset)),
			fc.constant("corrupt"),
		),
		{ nil: null },
	),
	attempt: fc.nat({ max: 6 }),
	maxAttempts: fc.integer({ min: 1, max: 5 }),
	cancelRequested: fc.boolean(),
});

describe("lease properties (AGT-011)", () => {
	it("a granted claim never exceeds the retry ceiling and always advances the generation", () => {
		fc.assert(
			fc.property(leaseView, (job) => {
				const decision = decideClaim(job, NOW_MS);
				if (decision.kind !== "claim") return;
				expect(decision.nextAttempt).toBe(job.attempt + 1);
				expect(decision.nextAttempt).toBeLessThanOrEqual(job.maxAttempts);
				expect(decision.nextLeaseGeneration).toBe(job.leaseGeneration + 1);
				expect(job.cancelRequested).toBe(false);
				expect(job.state === "pending" || isLeasedJobState(job.state)).toBe(true);
				expect(decision.reason).toBe(job.state === "pending" ? "fresh" : "lease-expired");
			}),
			{ numRuns: 1000 },
		);
	});

	it("after a claim, a proof with the superseded generation fails against the new lease", () => {
		fc.assert(
			fc.property(
				leaseView,
				fc.constantFrom("runner_a", "runner_b"),
				fc.constantFrom("runner_a", "runner_b"),
				(job, oldRunner, newRunner) => {
					const decision = decideClaim(job, NOW_MS);
					if (decision.kind !== "claim") return;
					const afterClaim: JobLeaseView = {
						...job,
						state: "claimed",
						leaseOwnerId: newRunner,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseExpiresAt: leaseExpiryIso(NOW_MS, 60_000),
						attempt: decision.nextAttempt,
					};
					expect(
						checkLease(afterClaim, { runnerId: oldRunner, leaseGeneration: job.leaseGeneration }),
					).toEqual({ ok: false, error: "STALE_LEASE" });
					expect(
						checkLease(afterClaim, {
							runnerId: newRunner,
							leaseGeneration: decision.nextLeaseGeneration,
						}),
					).toEqual({ ok: true, value: undefined });
					// The new lease is live, so no second runner can be granted the same job.
					expect(decideClaim(afterClaim, NOW_MS)).toEqual({ kind: "not-eligible" });
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("repeated crash-and-reclaim cycles stop at maxAttempts with strictly increasing generations", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: 1, max: 20 }),
				(maxAttempts, cycles) => {
					let job: JobLeaseView = {
						state: "pending",
						leaseGeneration: 0,
						leaseOwnerId: null,
						leaseExpiresAt: null,
						attempt: 0,
						maxAttempts,
						cancelRequested: false,
					};
					let now = NOW_MS;
					let granted = 0;
					const generations: number[] = [];
					for (let cycle = 0; cycle < cycles; cycle += 1) {
						const decision = decideClaim(job, now);
						if (decision.kind === "exhausted") {
							expect(job.attempt).toBe(maxAttempts);
							break;
						}
						if (decision.kind !== "claim") throw new Error("an expired lease must be claimable");
						granted += 1;
						generations.push(decision.nextLeaseGeneration);
						job = {
							...job,
							state: "collecting",
							leaseOwnerId: `runner_${cycle}`,
							leaseGeneration: decision.nextLeaseGeneration,
							leaseExpiresAt: leaseExpiryIso(now, 60_000),
							attempt: decision.nextAttempt,
						};
						expect(job.attempt).toBeLessThanOrEqual(maxAttempts);
						// The runner dies; time passes beyond the lease.
						now += 120_000;
					}
					expect(granted).toBeLessThanOrEqual(maxAttempts);
					expect(generations).toEqual(generations.map((_generation, index) => index + 1));
				},
			),
			{ numRuns: 300 },
		);
	});

	it("checkLease succeeds only for the current owner and generation of a leased job", () => {
		fc.assert(
			fc.property(
				leaseView,
				fc.constantFrom("runner_a", "runner_b", "runner_c"),
				fc.nat({ max: 1000 }),
				(job, runnerId, leaseGeneration) => {
					const result = checkLease(job, { runnerId, leaseGeneration });
					expect(result.ok).toBe(
						isLeasedJobState(job.state) &&
							job.leaseOwnerId === runnerId &&
							job.leaseGeneration === leaseGeneration,
					);
				},
			),
			{ numRuns: 1000 },
		);
	});
});

const cost = fc.double({ min: 0, max: 5, noNaN: true });
const delta: fc.Arbitrary<UsageDelta> = fc.record(
	{
		agentSteps: fc.nat({ max: 3 }),
		toolCalls: fc.nat({ max: 10 }),
		inputBytes: fc.nat({ max: 100_000 }),
		costUsd: fc.option(cost, { nil: null }),
	},
	{ requiredKeys: [] },
);

function fold(deltas: readonly UsageDelta[]): ResourceUsage {
	return deltas.reduce(addUsage, EMPTY_USAGE);
}

describe("budget properties (AGT-008)", () => {
	it("addUsage is monotone: no counter ever decreases and the unmetered flag never clears", () => {
		fc.assert(
			fc.property(fc.array(delta, { maxLength: 20 }), (deltas) => {
				let usage = EMPTY_USAGE;
				for (const step of deltas) {
					const next = addUsage(usage, step);
					expect(next.agentSteps).toBeGreaterThanOrEqual(usage.agentSteps);
					expect(next.toolCalls).toBeGreaterThanOrEqual(usage.toolCalls);
					expect(next.inputBytes).toBeGreaterThanOrEqual(usage.inputBytes);
					expect(next.knownCostUsd).toBeGreaterThanOrEqual(usage.knownCostUsd);
					if (usage.hasUnmeteredUsage) expect(next.hasUnmeteredUsage).toBe(true);
					usage = next;
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("addUsage totals equal the sums of the deltas", () => {
		fc.assert(
			fc.property(fc.array(delta, { maxLength: 20 }), (deltas) => {
				const usage = fold(deltas);
				const sum = (pick: (step: UsageDelta) => number) =>
					deltas.reduce((total, step) => total + pick(step), 0);
				expect(usage.agentSteps).toBe(sum((step) => step.agentSteps ?? 0));
				expect(usage.toolCalls).toBe(sum((step) => step.toolCalls ?? 0));
				expect(usage.inputBytes).toBe(sum((step) => step.inputBytes ?? 0));
				expect(usage.knownCostUsd).toBeCloseTo(
					sum((step) => step.costUsd ?? 0),
					9,
				);
				expect(usage.hasUnmeteredUsage).toBe(deltas.some((step) => step.costUsd === null));
			}),
			{ numRuns: 300 },
		);
	});

	it("an unknown cost is never summarized as a numeric total", () => {
		fc.assert(
			fc.property(fc.array(delta, { maxLength: 20 }), fc.nat({ max: 20 }), (deltas, position) => {
				const withUnknown = [...deltas];
				withUnknown.splice(Math.min(position, withUnknown.length), 0, {
					agentSteps: 1,
					costUsd: null,
				});
				const summary = summarizeCost(fold(withUnknown));
				expect(summary.totalCostUsd).toBeNull();
				expect(summary.status).toBe("unknown-plan-limited");
			}),
			{ numRuns: 300 },
		);
	});

	it("summarizes a numeric total exactly when every step was metered", () => {
		fc.assert(
			fc.property(fc.array(delta, { maxLength: 20 }), (deltas) => {
				const usage = fold(deltas);
				const summary = summarizeCost(usage);
				expect(summary.totalCostUsd === null).toBe(usage.hasUnmeteredUsage);
				expect(summary.status === "unknown-plan-limited").toBe(usage.hasUnmeteredUsage);
				expect(summary.meteredPortionUsd).toBe(usage.knownCostUsd);
				if (summary.totalCostUsd !== null) expect(summary.totalCostUsd).toBe(usage.knownCostUsd);
			}),
			{ numRuns: 300 },
		);
	});

	it("a run that checks the budget before every step never exceeds any ceiling", () => {
		const budgetArb: fc.Arbitrary<ResearchBudget> = fc.record({
			maxAgentSteps: fc.integer({ min: 1, max: 12 }),
			maxToolCalls: fc.nat({ max: 60 }),
			maxWallClockMs: fc.integer({ min: 30_000, max: 1_800_000 }),
			maxInputBytes: fc.integer({ min: 10_000, max: 2_000_000 }),
			maxSpendUsd: fc.option(fc.double({ min: 0, max: 50, noNaN: true }), { nil: null }),
		});
		fc.assert(
			fc.property(budgetArb, fc.array(delta, { maxLength: 30 }), (budget, plannedSteps) => {
				let usage = EMPTY_USAGE;
				for (const step of plannedSteps) {
					if (!checkBudget(budget, usage, 0, step).ok) continue;
					usage = addUsage(usage, step);
				}
				expect(usage.agentSteps).toBeLessThanOrEqual(budget.maxAgentSteps);
				expect(usage.toolCalls).toBeLessThanOrEqual(budget.maxToolCalls);
				expect(usage.inputBytes).toBeLessThanOrEqual(budget.maxInputBytes);
				if (budget.maxSpendUsd !== null) {
					expect(usage.knownCostUsd).toBeLessThanOrEqual(budget.maxSpendUsd);
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("checkBudget is antitone: if a larger usage passes, so does a smaller one", () => {
		fc.assert(
			fc.property(
				fc.array(delta, { maxLength: 10 }),
				fc.array(delta, { maxLength: 10 }),
				fc.nat({ max: 2_000_000 }),
				(first, more, elapsedMs) => {
					const budget: ResearchBudget = {
						maxAgentSteps: 8,
						maxToolCalls: 30,
						maxWallClockMs: 600_000,
						maxInputBytes: 400_000,
						maxSpendUsd: 10,
					};
					const smaller = fold(first);
					const larger = fold([...first, ...more]);
					if (checkBudget(budget, larger, elapsedMs).ok) {
						expect(checkBudget(budget, smaller, elapsedMs).ok).toBe(true);
					}
				},
			),
			{ numRuns: 300 },
		);
	});
});
