import type {
	StockDirectoryHit,
	StockDirectoryMarketStatus,
	StockDirectoryRefreshResponse,
	StockDirectorySearchResponse,
	StockDirectoryStatusResponse,
	WatchMarket,
} from "@research/contracts";
import { STOCK_DIRECTORY_SOURCES } from "@research/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApiFailure, type ApiResult, ok } from "../src/api/http.ts";
import { createStockDirectoryState } from "../src/watchlist/stockDirectory.ts";
import { createStockSearch, STOCK_SEARCH_DEBOUNCE_MS } from "../src/watchlist/stockSearch.ts";
import type { StockSearchState } from "../src/watchlist/watchlistModel.ts";
import { ALWAYS_VISIBLE, deferred } from "./fakeBackend.ts";

const TOYOTA: StockDirectoryHit = {
	stockId: "jp:7203",
	market: "JP",
	symbol: "7203",
	name: "TOYOTA MOTOR CORPORATION",
	localName: "トヨタ自動車",
	listing: "tse-prime",
	registered: false,
};

const SERVER_FAILURE: ApiFailure = {
	kind: "api",
	code: "INTERNAL",
	status: 500,
	message: "boom",
	detail: null,
	issues: [],
	upstreamStatus: null,
};

const NETWORK_FAILURE: ApiFailure = {
	kind: "network",
	code: "NETWORK_ERROR",
	status: null,
	message: "offline",
	detail: null,
	issues: [],
};

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("createStockSearch", () => {
	interface Call {
		readonly query: string;
		readonly signal: AbortSignal;
		readonly answer: (result: ApiResult<StockDirectorySearchResponse>) => void;
	}

	function harness() {
		const calls: Call[] = [];
		const states: StockSearchState[] = [];
		const search = createStockSearch({
			search: (query, signal) => {
				const pending = deferred<ApiResult<StockDirectorySearchResponse>>();
				calls.push({ query, signal, answer: pending.resolve });
				return pending.promise;
			},
			onState: (state) => states.push(state),
		});
		return { calls, states, search };
	}

	it("sends one request per typing pause, for the latest text", async () => {
		const { calls, states, search } = harness();
		search.input("t");
		search.input("to");
		search.input("toy");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS - 1);
		expect(calls).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(calls.map((call) => call.query)).toEqual(["toy"]);
		expect(states).toEqual([{ kind: "searching", query: "toy", hits: [] }]);
		calls[0]?.answer(ok({ hits: [TOYOTA] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)).toEqual({ kind: "results", query: "toy", hits: [TOYOTA] });
	});

	it("aborts the request in flight on a newer keystroke and drops its late answer", async () => {
		const { calls, states, search } = harness();
		search.input("toy");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		const first = calls[0];
		expect(first?.signal.aborted).toBe(false);
		search.input("toyota");
		// The keystroke itself aborts the older request: at most one is ever outstanding.
		expect(first?.signal.aborted).toBe(true);
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		expect(calls.map((call) => call.query)).toEqual(["toy", "toyota"]);
		expect(calls.filter((call) => !call.signal.aborted)).toHaveLength(1);
		// A fetch that ignored its abort still answers: the answer is stale and dropped.
		first?.answer(ok({ hits: [] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(states.some((state) => state.kind === "results")).toBe(false);
		calls[1]?.answer(ok({ hits: [TOYOTA] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)).toEqual({ kind: "results", query: "toyota", hits: [TOYOTA] });
	});

	it("returns to idle on blank text without sending, and ignores a repeated query", async () => {
		const { calls, states, search } = harness();
		search.input("sony");
		search.input("   ");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS * 2);
		expect(calls).toHaveLength(0);
		expect(states).toEqual([{ kind: "idle" }]);
		search.input("sony");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		search.input("sony ");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		expect(calls.map((call) => call.query)).toEqual(["sony"]);
		expect(calls[0]?.signal.aborted).toBe(false);
	});

	it("keeps the previous hits while the next search (or a refresh) runs", async () => {
		const { calls, states, search } = harness();
		search.input("toy");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		calls[0]?.answer(ok({ hits: [TOYOTA] }));
		await vi.advanceTimersByTimeAsync(0);
		search.input("toyo");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		expect(states.at(-1)).toEqual({ kind: "searching", query: "toyo", hits: [TOYOTA] });
		calls[1]?.answer(ok({ hits: [] }));
		await vi.advanceTimersByTimeAsync(0);
		search.refresh();
		await vi.advanceTimersByTimeAsync(0);
		// The latest answer (empty) is what stays on screen now.
		expect(states.at(-1)).toEqual({ kind: "searching", query: "toyo", hits: [] });
		search.input("");
		expect(states.at(-1)).toEqual({ kind: "idle" });
	});

	it("retries the same query after a failure when the owner types it again", async () => {
		const { calls, states, search } = harness();
		search.input("sony");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		calls[0]?.answer({ ok: false, error: SERVER_FAILURE });
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)?.kind).toBe("failed");
		// "sony " asks the same question; after a failure it is sent again.
		search.input("sony ");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		expect(calls.map((call) => call.query)).toEqual(["sony", "sony"]);
		calls[1]?.answer(ok({ hits: [TOYOTA] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)).toEqual({ kind: "results", query: "sony", hits: [TOYOTA] });
		// After a success the repeat is ignored again.
		search.input("sony");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		expect(calls).toHaveLength(2);
	});

	it("reports a failed search, re-sends on refresh, and goes quiet once disposed", async () => {
		const { calls, states, search } = harness();
		search.input("7203");
		await vi.advanceTimersByTimeAsync(STOCK_SEARCH_DEBOUNCE_MS);
		calls[0]?.answer({ ok: false, error: SERVER_FAILURE });
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)).toEqual({ kind: "failed", query: "7203", error: SERVER_FAILURE });
		search.refresh();
		await vi.advanceTimersByTimeAsync(0);
		expect(calls.map((call) => call.query)).toEqual(["7203", "7203"]);
		search.dispose();
		expect(calls[1]?.signal.aborted).toBe(true);
		calls[1]?.answer(ok({ hits: [TOYOTA] }));
		await vi.advanceTimersByTimeAsync(0);
		expect(states.at(-1)?.kind).toBe("searching");
	});
});

describe("createStockDirectoryState", () => {
	function market(
		which: WatchMarket,
		overrides: Partial<StockDirectoryMarketStatus> = {},
	): StockDirectoryMarketStatus {
		return {
			market: which,
			...STOCK_DIRECTORY_SOURCES[which],
			entryCount: 5000,
			asOf: null,
			retrievedAt: new Date(Date.now() - 3_600_000).toISOString(),
			activeRunId: null,
			activeRunState: null,
			lastFailure: null,
			...overrides,
		};
	}

	const MISSING = { entryCount: 0, retrievedAt: null } as const;

	function fakeApi(initial: StockDirectoryStatusResponse) {
		let current = initial;
		let keyCount = 0;
		const loads: number[] = [];
		const queued: { markets: readonly WatchMarket[]; key: string }[] = [];
		// Like the API: a queued market reports its active run at once.
		let queueAnswer: (markets: readonly WatchMarket[]) => ApiResult<StockDirectoryRefreshResponse> =
			(markets) => {
				current = {
					markets: current.markets.map((entry) =>
						markets.includes(entry.market)
							? { ...entry, activeRunId: `run_${entry.market}`, activeRunState: "pending" }
							: entry,
					),
				};
				return ok({ runs: markets.map((entry) => ({ market: entry, runId: `run_${entry}` })) });
			};
		return {
			loads,
			queued,
			set: (next: StockDirectoryStatusResponse) => {
				current = next;
			},
			answerQueueWith: (
				answer: (markets: readonly WatchMarket[]) => ApiResult<StockDirectoryRefreshResponse>,
			) => {
				queueAnswer = answer;
			},
			api: {
				newIdempotencyKey: () => {
					keyCount += 1;
					return `idem-key-${keyCount}`;
				},
				getStockDirectory: async () => {
					loads.push(Date.now());
					return ok(current);
				},
				refreshStockDirectory: async (markets: readonly WatchMarket[], key: string) => {
					queued.push({ markets, key });
					return queueAnswer(markets);
				},
			},
		};
	}

	it("queues one download for the missing market once per visit, then polls until it ends", async () => {
		const fake = fakeApi({ markets: [market("US", MISSING), market("JP")] });
		const changed = vi.fn();
		const state = createStockDirectoryState({
			api: fake.api,
			visibility: ALWAYS_VISIBLE,
			onListsChanged: changed,
		});
		fake.answerQueueWith((markets) => {
			fake.set({
				markets: [
					market("US", { ...MISSING, activeRunId: "run_US", activeRunState: "claimed" }),
					market("JP"),
				],
			});
			return ok({ runs: markets.map((entry) => ({ market: entry, runId: `run_${entry}` })) });
		});
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.queued.map((entry) => entry.markets)).toEqual([["US"]]);
		expect(state.status()?.markets[0]?.activeRunId).toBe("run_US");
		expect(state.queuedByOwner()).toBe(false);

		// The download completes: the poller reads it, stops, and reports the new list.
		fake.set({ markets: [market("US", { entryCount: 7691 }), market("JP")] });
		await vi.advanceTimersByTimeAsync(3_000);
		expect(state.status()?.markets[0]?.entryCount).toBe(7691);
		expect(changed).toHaveBeenCalledTimes(1);
		const loadsAfterEnd = fake.loads.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.loads).toHaveLength(loadsAfterEnd);

		// A second start (a retry) never queues again in the same visit.
		fake.set({ markets: [market("US", MISSING), market("JP")] });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.queued).toHaveLength(1);
		state.dispose();
	});

	it("never queues automatically after DIRECTORY_NOT_CONFIGURED", async () => {
		const fake = fakeApi({
			markets: [
				market("US", {
					...MISSING,
					lastFailure: {
						state: "failed",
						code: "DIRECTORY_NOT_CONFIGURED",
						upstreamStatus: null,
						at: new Date(Date.now() - 60_000).toISOString(),
					},
				}),
				market("JP"),
			],
		});
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.queued).toHaveLength(0);
		// The owner's button still can.
		state.update();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.queued.map((entry) => entry.markets)).toEqual([["US", "JP"]]);
		expect(state.queuedByOwner()).toBe(true);
		state.dispose();
	});

	it("keeps the idempotency key only after a network failure", async () => {
		const fake = fakeApi({ markets: [market("US"), market("JP")] });
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(fake.queued).toHaveLength(0);

		fake.answerQueueWith(() => ({ ok: false, error: NETWORK_FAILURE }));
		state.update();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.failure()).toEqual({ action: "queue", error: NETWORK_FAILURE });
		state.update();
		await vi.advanceTimersByTimeAsync(0);
		// Unknown outcome: the same write is re-sent under the same key.
		expect(fake.queued.map((entry) => entry.key)).toEqual(["idem-key-1", "idem-key-1"]);

		fake.answerQueueWith(() => ({ ok: false, error: SERVER_FAILURE }));
		state.update();
		await vi.advanceTimersByTimeAsync(0);
		state.update();
		await vi.advanceTimersByTimeAsync(0);
		// A server answer retires the key.
		expect(fake.queued.map((entry) => entry.key)).toEqual([
			"idem-key-1",
			"idem-key-1",
			"idem-key-1",
			"idem-key-2",
		]);
		state.dispose();
	});

	it("after a failed queue request, reloads once and polls a market queued anyway", async () => {
		const fake = fakeApi({ markets: [market("US"), market("JP")] });
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		const loadsBefore = fake.loads.length;
		// US was queued, then JP failed: the API answers an error.
		fake.answerQueueWith(() => {
			fake.set({
				markets: [market("US", { activeRunId: "run_US", activeRunState: "pending" }), market("JP")],
			});
			return { ok: false, error: SERVER_FAILURE };
		});
		state.update();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.failure()).toEqual({ action: "queue", error: SERVER_FAILURE });
		expect(state.status()?.markets[0]?.activeRunId).toBe("run_US");
		expect(fake.loads.length).toBeGreaterThan(loadsBefore);
		// The US run is polled to its end.
		fake.set({ markets: [market("US", { entryCount: 7691 }), market("JP")] });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(state.status()?.markets[0]?.entryCount).toBe(7691);
		const loadsAfterEnd = fake.loads.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.loads).toHaveLength(loadsAfterEnd);
		state.dispose();
	});

	it("after a failed queue request with nothing queued, reloads once and does not poll", async () => {
		const fake = fakeApi({ markets: [market("US"), market("JP")] });
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		fake.answerQueueWith(() => ({ ok: false, error: SERVER_FAILURE }));
		const loadsBefore = fake.loads.length;
		state.update();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fake.loads).toHaveLength(loadsBefore + 1);
		state.dispose();
	});

	it("reports a failed first load, and a retry loads and applies the rule", async () => {
		const fake = fakeApi({ markets: [market("US", MISSING), market("JP")] });
		const getOk = fake.api.getStockDirectory;
		let fail = true;
		const api = {
			...fake.api,
			getStockDirectory: async (): Promise<ApiResult<StockDirectoryStatusResponse>> =>
				fail ? { ok: false, error: SERVER_FAILURE } : getOk(),
		};
		const state = createStockDirectoryState({ api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.failure()).toEqual({ action: "load", error: SERVER_FAILURE });
		expect(fake.queued).toHaveLength(0);
		fail = false;
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.failure()).toBe(null);
		expect(fake.queued.map((entry) => entry.markets)).toEqual([["US"]]);
		state.dispose();
	});
});
