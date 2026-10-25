import { describe, expect, it } from "vitest";
import {
	checkLease,
	decideClaim,
	decideRelease,
	type JobLeaseView,
	leaseExpiryIso,
} from "../../src/jobs/lease.ts";
import { JOB_STATES, LEASED_JOB_STATES, TERMINAL_JOB_STATES } from "../../src/jobs/stateMachine.ts";

// 2026-10-11T00:00:00Z (20_737 days x 86_400_000 ms).
const NOW_MS = 1_791_676_800_000;
const ONE_MINUTE_MS = 60_000;

function job(overrides: Partial<JobLeaseView> = {}): JobLeaseView {
	return {
		state: "pending",
		leaseGeneration: 0,
		leaseOwnerId: null,
		leaseExpiresAt: null,
		attempt: 0,
		maxAttempts: 3,
		cancelRequested: false,
		...overrides,
	};
}

function leased(overrides: Partial<JobLeaseView> = {}): JobLeaseView {
	return job({
		state: "collecting",
		leaseGeneration: 4,
		leaseOwnerId: "runner_a",
		leaseExpiresAt: "2026-10-11T00:01:00.000Z",
		attempt: 1,
		...overrides,
	});
}

describe("decideClaim", () => {
	it("claims a fresh pending job with the next attempt and lease generation", () => {
		expect(decideClaim(job(), NOW_MS)).toEqual({
			kind: "claim",
			reason: "fresh",
			nextAttempt: 1,
			nextLeaseGeneration: 1,
		});
	});

	it("claims a pending job that was previously attempted", () => {
		expect(decideClaim(job({ attempt: 2, leaseGeneration: 7 }), NOW_MS)).toEqual({
			kind: "claim",
			reason: "fresh",
			nextAttempt: 3,
			nextLeaseGeneration: 8,
		});
	});

	it("does not grant a second lease while the current one is live", () => {
		expect(decideClaim(leased(), NOW_MS)).toEqual({ kind: "not-eligible" });
		expect(decideClaim(leased(), NOW_MS + ONE_MINUTE_MS - 1)).toEqual({ kind: "not-eligible" });
	});

	it.each(LEASED_JOB_STATES)("recovers a %s job whose lease has expired", (state) => {
		expect(decideClaim(leased({ state }), NOW_MS + ONE_MINUTE_MS + 1)).toEqual({
			kind: "claim",
			reason: "lease-expired",
			nextAttempt: 2,
			nextLeaseGeneration: 5,
		});
	});

	it("treats a lease as expired at exactly its expiry instant", () => {
		expect(decideClaim(leased(), NOW_MS + ONE_MINUTE_MS).kind).toBe("claim");
	});

	it("treats a missing or unreadable expiry as expired so a corrupt row cannot pin a job", () => {
		expect(decideClaim(leased({ leaseExpiresAt: null }), NOW_MS).kind).toBe("claim");
		expect(decideClaim(leased({ leaseExpiresAt: "not-a-date" }), NOW_MS).kind).toBe("claim");
	});

	it("reports exhaustion instead of claiming past the retry ceiling", () => {
		expect(decideClaim(job({ attempt: 3, maxAttempts: 3 }), NOW_MS)).toEqual({ kind: "exhausted" });
		expect(decideClaim(leased({ attempt: 3, maxAttempts: 3 }), NOW_MS + 2 * ONE_MINUTE_MS)).toEqual(
			{ kind: "exhausted" },
		);
		expect(decideClaim(job({ attempt: 9, maxAttempts: 3 }), NOW_MS)).toEqual({ kind: "exhausted" });
	});

	it("allows the final attempt", () => {
		expect(decideClaim(job({ attempt: 2, maxAttempts: 3 }), NOW_MS)).toMatchObject({
			kind: "claim",
			nextAttempt: 3,
		});
	});

	it("does not report a live lease as exhausted", () => {
		expect(decideClaim(leased({ attempt: 3, maxAttempts: 3 }), NOW_MS)).toEqual({
			kind: "not-eligible",
		});
	});

	it("never claims a job whose cancellation was requested", () => {
		expect(decideClaim(job({ cancelRequested: true }), NOW_MS)).toEqual({ kind: "not-eligible" });
		expect(decideClaim(leased({ cancelRequested: true }), NOW_MS + 2 * ONE_MINUTE_MS)).toEqual({
			kind: "not-eligible",
		});
	});

	it.each([
		...TERMINAL_JOB_STATES,
		"waiting_approval",
	] as const)("never claims a %s job, even with an expired lease", (state) => {
		expect(
			decideClaim(leased({ state, leaseExpiresAt: "2020-01-01T00:00:00.000Z" }), NOW_MS),
		).toEqual({ kind: "not-eligible" });
	});
});

describe("checkLease (lease fencing, AGT-011)", () => {
	const current = leased();

	it("accepts the owner presenting the current generation", () => {
		expect(checkLease(current, { runnerId: "runner_a", leaseGeneration: 4 })).toEqual({
			ok: true,
			value: undefined,
		});
	});

	it("rejects a superseded generation as stale", () => {
		expect(checkLease(current, { runnerId: "runner_a", leaseGeneration: 3 })).toEqual({
			ok: false,
			error: "STALE_LEASE",
		});
	});

	it("rejects a generation from the future", () => {
		expect(checkLease(current, { runnerId: "runner_a", leaseGeneration: 5 })).toEqual({
			ok: false,
			error: "STALE_LEASE",
		});
	});

	it("rejects another runner presenting the current generation", () => {
		expect(checkLease(current, { runnerId: "runner_b", leaseGeneration: 4 })).toEqual({
			ok: false,
			error: "WRONG_RUNNER",
		});
	});

	it("reports a stale generation ahead of a runner mismatch", () => {
		expect(checkLease(current, { runnerId: "runner_b", leaseGeneration: 3 })).toEqual({
			ok: false,
			error: "STALE_LEASE",
		});
	});

	it("rejects any proof once the job is no longer in a leased state", () => {
		for (const state of JOB_STATES) {
			if ((LEASED_JOB_STATES as readonly string[]).includes(state)) continue;
			expect(checkLease(leased({ state }), { runnerId: "runner_a", leaseGeneration: 4 })).toEqual({
				ok: false,
				error: "NOT_LEASED",
			});
		}
	});

	it("rejects any proof when the job has no owner", () => {
		expect(
			checkLease(leased({ leaseOwnerId: null }), { runnerId: "runner_a", leaseGeneration: 4 }),
		).toEqual({ ok: false, error: "NOT_LEASED" });
	});

	it("does not depend on the clock: an expired but unsuperseded lease is still owned", () => {
		const expired = leased({ leaseExpiresAt: "2020-01-01T00:00:00.000Z" });
		expect(checkLease(expired, { runnerId: "runner_a", leaseGeneration: 4 }).ok).toBe(true);
	});

	it("fences out the previous runner once an expired lease is re-claimed", () => {
		const decision = decideClaim(current, NOW_MS + 2 * ONE_MINUTE_MS);
		if (decision.kind !== "claim") throw new Error("expected the expired lease to be claimable");
		const reclaimed = leased({
			state: "claimed",
			leaseOwnerId: "runner_b",
			leaseGeneration: decision.nextLeaseGeneration,
			attempt: decision.nextAttempt,
			leaseExpiresAt: leaseExpiryIso(NOW_MS + 2 * ONE_MINUTE_MS, ONE_MINUTE_MS),
		});
		expect(checkLease(reclaimed, { runnerId: "runner_a", leaseGeneration: 4 })).toEqual({
			ok: false,
			error: "STALE_LEASE",
		});
		expect(
			checkLease(reclaimed, { runnerId: "runner_b", leaseGeneration: decision.nextLeaseGeneration })
				.ok,
		).toBe(true);
	});

	it("fences out the previous runner even when the same runner re-claims its own job", () => {
		const reclaimed = leased({ state: "claimed", leaseGeneration: 5, attempt: 2 });
		expect(checkLease(reclaimed, { runnerId: "runner_a", leaseGeneration: 4 })).toEqual({
			ok: false,
			error: "STALE_LEASE",
		});
	});
});

describe("decideRelease (lease hand-back on shutdown, ADR-0036)", () => {
	const holder = { runnerId: "runner_a", leaseGeneration: 4 };

	it.each(LEASED_JOB_STATES)("requeues a %s job and refunds its claim", (state) => {
		expect(decideRelease(leased({ state, attempt: 2 }), holder)).toEqual({
			ok: true,
			value: { kind: "requeue", nextAttempt: 1 },
		});
	});

	it("never refunds below zero attempts", () => {
		expect(decideRelease(leased({ attempt: 0 }), holder)).toEqual({
			ok: true,
			value: { kind: "requeue", nextAttempt: 0 },
		});
	});

	it("cancels instead of requeueing when the owner asked to cancel", () => {
		expect(decideRelease(leased({ cancelRequested: true }), holder)).toEqual({
			ok: true,
			value: { kind: "cancel" },
		});
	});

	it("is refused for anyone but the current holder, with the lease check's code", () => {
		expect(decideRelease(leased(), { runnerId: "runner_a", leaseGeneration: 3 })).toEqual({
			ok: false,
			error: "STALE_LEASE",
		});
		expect(decideRelease(leased(), { runnerId: "runner_b", leaseGeneration: 4 })).toEqual({
			ok: false,
			error: "WRONG_RUNNER",
		});
		expect(decideRelease(leased({ state: "pending" }), holder)).toEqual({
			ok: false,
			error: "NOT_LEASED",
		});
	});

	it("leaves a job the next claim takes fresh, and the released proof dead", () => {
		const released = leased({
			state: "pending",
			attempt: 0,
			leaseOwnerId: null,
			leaseExpiresAt: null,
		});
		expect(checkLease(released, holder)).toEqual({ ok: false, error: "NOT_LEASED" });
		expect(decideRelease(released, holder)).toEqual({ ok: false, error: "NOT_LEASED" });
		expect(decideClaim(released, NOW_MS)).toEqual({
			kind: "claim",
			reason: "fresh",
			nextAttempt: 1,
			nextLeaseGeneration: 5,
		});
	});
});

describe("leaseExpiryIso", () => {
	it("adds the lease duration to the current instant", () => {
		// 00:00:00 + 90_000 ms = 00:01:30
		expect(leaseExpiryIso(NOW_MS, 90_000)).toBe("2026-10-11T00:01:30.000Z");
	});

	it("produces an expiry that decideClaim honours", () => {
		const view = leased({ leaseExpiresAt: leaseExpiryIso(NOW_MS, ONE_MINUTE_MS) });
		expect(decideClaim(view, NOW_MS + ONE_MINUTE_MS - 1).kind).toBe("not-eligible");
		expect(decideClaim(view, NOW_MS + ONE_MINUTE_MS).kind).toBe("claim");
	});
});
