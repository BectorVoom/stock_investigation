import type { RefreshScope, ResearchRun } from "@research/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import type { ApiFailure } from "../src/api/http.ts";
import { createEarningsRefreshQueue } from "../src/watchlist/earningsRefreshQueue.ts";
import { deferred } from "./fakeBackend.ts";
import { makeRun } from "./fixtures.ts";

type RefreshResult =
	| { readonly ok: true; readonly value: ResearchRun }
	| { readonly ok: false; readonly error: ApiFailure };

function networkError(): ApiFailure {
	return {
		kind: "network",
		code: "TIMEOUT",
		status: null,
		message: "the runner did not answer",
		detail: null,
		issues: [],
	};
}

function serverError(): ApiFailure {
	return {
		kind: "api",
		code: "RATE_LIMITED",
		status: 429,
		message: "too many requests",
		detail: null,
		issues: [],
		upstreamStatus: null,
	};
}

describe("createEarningsRefreshQueue", () => {
	let keys = 0;
	let calls: string[] = [];
	let answer: () => RefreshResult;

	beforeEach(() => {
		keys = 0;
		calls = [];
		answer = () => ({
			ok: true,
			value: makeRun({ runId: "run_earnings_1", kind: "earnings-refresh", state: "pending" }),
		});
	});

	const nextKey = (): string => {
		keys += 1;
		return `idem-${keys}`;
	};

	const api = () => ({
		newIdempotencyKey: nextKey,
		refreshEarnings: async (key: string): Promise<RefreshResult> => {
			calls.push(key);
			return answer();
		},
	});

	it("queues with a fresh key", async () => {
		const queue = createEarningsRefreshQueue(api());
		const result = await queue.queue("all");
		expect(result.kind).toBe("queued");
		expect(calls).toEqual(["idem-1"]);
		expect(queue.busy()).toBe(false);
	});

	it("reuses the key after a network failure, rotates it after a server answer", async () => {
		const queue = createEarningsRefreshQueue(api());
		// Network failure: the outcome is unknown, so the retry reuses the key.
		answer = () => ({ ok: false, error: networkError() });
		expect((await queue.queue("all")).kind).toBe("failed");
		answer = () => ({
			ok: true,
			value: makeRun({ runId: "run_earnings_1", kind: "earnings-refresh", state: "pending" }),
		});
		expect((await queue.queue("all")).kind).toBe("queued");
		expect(calls).toEqual(["idem-1", "idem-1"]);
		// Server answer: nothing is queued under the key anymore — fresh key next.
		answer = () => ({ ok: false, error: serverError() });
		expect((await queue.queue("all")).kind).toBe("failed");
		answer = () => ({
			ok: true,
			value: makeRun({ runId: "run_earnings_2", kind: "earnings-refresh", state: "pending" }),
		});
		expect((await queue.queue("all")).kind).toBe("queued");
		expect(calls).toEqual(["idem-1", "idem-1", "idem-2", "idem-3"]);
	});

	it("sends the scope, and never reuses a kept key for the other scope (ADR-0039)", async () => {
		const scopes: string[] = [];
		const local = {
			newIdempotencyKey: nextKey,
			refreshEarnings: async (key: string, scope: RefreshScope): Promise<RefreshResult> => {
				calls.push(key);
				scopes.push(scope);
				return answer();
			},
		};
		const queue = createEarningsRefreshQueue(local);
		// A network failure keeps the key for a retry of the SAME write...
		answer = () => ({ ok: false, error: networkError() });
		expect((await queue.queue("unrefreshed")).kind).toBe("failed");
		answer = () => ({
			ok: true,
			value: makeRun({ runId: "run_earnings_1", kind: "earnings-refresh", state: "pending" }),
		});
		// ...but a request for everything is another write: a fresh key, or
		// the API would refuse the reused key for a different request.
		expect((await queue.queue("all")).kind).toBe("queued");
		expect(calls).toEqual(["idem-1", "idem-2"]);
		expect(scopes).toEqual(["unrefreshed", "all"]);
	});

	it("retries once with a fresh key after a replayed terminal run", async () => {
		let seen = 0;
		const local = {
			newIdempotencyKey: nextKey,
			refreshEarnings: async (key: string): Promise<RefreshResult> => {
				seen += 1;
				calls.push(key);
				if (seen === 1) {
					return {
						ok: true,
						value: makeRun({
							runId: "run_old",
							kind: "earnings-refresh",
							state: "completed",
						}),
					};
				}
				return {
					ok: true,
					value: makeRun({
						runId: "run_earnings_new",
						kind: "earnings-refresh",
						state: "pending",
					}),
				};
			},
		};
		const retrying = createEarningsRefreshQueue(local);
		const result = await retrying.queue("all");
		expect(result.kind).toBe("queued");
		if (result.kind !== "queued") throw new Error("expected the retry to queue");
		expect(result.run.runId).toBe("run_earnings_new");
		expect(calls).toEqual(["idem-1", "idem-2"]);
		expect(seen).toBe(2);
	});

	it("answers busy to a concurrent call instead of sending twice", async () => {
		const gate = deferred<void>();
		const local = {
			newIdempotencyKey: nextKey,
			refreshEarnings: async (key: string): Promise<RefreshResult> => {
				calls.push(key);
				await gate.promise;
				return {
					ok: true,
					value: makeRun({ runId: "run_earnings_1", kind: "earnings-refresh", state: "pending" }),
				};
			},
		};
		const queue = createEarningsRefreshQueue(local);
		const first = queue.queue("all");
		expect(queue.busy()).toBe(true);
		const second = await queue.queue("all");
		expect(second).toEqual({ kind: "busy" });
		gate.resolve();
		expect((await first).kind).toBe("queued");
		expect(calls).toEqual(["idem-1"]);
		expect(queue.busy()).toBe(false);
	});
});
