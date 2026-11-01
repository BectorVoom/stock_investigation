import type {
	StockDirectoryHit,
	StockDirectoryMarketStatus,
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

	/** The status endpoint only: the page has no way to queue a download (ADR-0053). */
	function fakeApi(initial: StockDirectoryStatusResponse) {
		let current = initial;
		const loads: number[] = [];
		return {
			loads,
			set: (next: StockDirectoryStatusResponse) => {
				current = next;
			},
			api: {
				getStockDirectory: async (): Promise<ApiResult<StockDirectoryStatusResponse>> => {
					loads.push(Date.now());
					return ok(current);
				},
			},
		};
	}

	it("queues nothing, and re-reads within seconds while a list is missing until the server's download shows", async () => {
		const fake = fakeApi({ markets: [market("US", MISSING), market("JP")] });
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.status()?.markets.map((entry) => entry.entryCount)).toEqual([0, 5000]);
		expect("refreshStockDirectory" in fake.api).toBe(false);
		// The server stores the list at the runner's next claim; the page sees it in 5 s.
		fake.set({ markets: [market("US"), market("JP")] });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.loads).toHaveLength(2);
		expect(state.status()?.markets.map((entry) => entry.entryCount)).toEqual([5000, 5000]);
		// With every list stored, it re-reads once a minute while visible.
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.loads).toHaveLength(4);
		state.dispose();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.loads).toHaveLength(4);
	});

	it("does not hurry a missing list whose download failed: the server retries it later", async () => {
		const fake = fakeApi({
			markets: [
				market("US", {
					...MISSING,
					lastFailure: {
						state: "failed",
						code: "DIRECTORY_NOT_CONFIGURED",
						upstreamStatus: null,
						at: new Date().toISOString(),
					},
				}),
				market("JP"),
			],
		});
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.loads).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(fake.loads).toHaveLength(2);
		state.dispose();
	});

	it("follows a download the server queued until it ends", async () => {
		const fake = fakeApi({
			markets: [
				market("US", { ...MISSING, activeRunId: "run_US", activeRunState: "claimed" }),
				market("JP"),
			],
		});
		const state = createStockDirectoryState({ api: fake.api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		const afterFirst = fake.loads.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fake.loads.length).toBeGreaterThan(afterFirst);
		fake.set({ markets: [market("US"), market("JP")] });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(state.status()?.markets[0]?.activeRunId).toBe(null);
		// The fast poll has stopped: only the minute's idle re-read is left.
		const settled = fake.loads.length;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(fake.loads.length - settled).toBeLessThanOrEqual(3);
		state.dispose();
	});

	it("reports a failed first load, and a retry loads it", async () => {
		const fake = fakeApi({ markets: [market("US"), market("JP")] });
		const getOk = fake.api.getStockDirectory;
		let fail = true;
		const api = {
			getStockDirectory: async (): Promise<ApiResult<StockDirectoryStatusResponse>> =>
				fail ? { ok: false, error: SERVER_FAILURE } : getOk(),
		};
		const state = createStockDirectoryState({ api, visibility: ALWAYS_VISIBLE });
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.failure()).toEqual(SERVER_FAILURE);
		fail = false;
		state.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(state.failure()).toBe(null);
		expect(state.status()?.markets).toHaveLength(2);
		state.dispose();
	});
});
