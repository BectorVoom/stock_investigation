import {
	STOCK_DIRECTORY_SOURCES,
	type StockDirectoryHit,
	type StockDirectoryMarketStatus,
	type StockDirectoryStatusResponse,
	type WatchMarket,
} from "@research/contracts";
import { describe, expect, it } from "vitest";
import type { ApiFailure } from "../src/api/http.ts";
import { watchlistModelMessages } from "../src/watchlist/watchlistModel.messages.ts";
import {
	addTargetText,
	directoryAutoRefreshMarkets,
	directoryStatusLine,
	isDirectoryListStale,
	isStockDirectoryRunActive,
	moveActiveOption,
	pickedStockFor,
	STOCK_DIRECTORY_STALE_MS,
	selectedStockText,
	stockDirectoryPollSignal,
	stockHitNames,
	stockHitPlace,
	stockSearchHits,
	stockSearchQuery,
	stockSearchStatusText,
	storedDirectoryMarkets,
} from "../src/watchlist/watchlistModel.ts";

const EN = watchlistModelMessages.en;
const JA = watchlistModelMessages.ja;

/** Every expectation below is worked by hand from this clock reading. */
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

function market(
	which: WatchMarket,
	overrides: Partial<StockDirectoryMarketStatus> = {},
): StockDirectoryMarketStatus {
	return {
		market: which,
		...STOCK_DIRECTORY_SOURCES[which],
		entryCount: which === "US" ? 7691 : 3707,
		asOf: which === "US" ? null : "2026-09-30",
		retrievedAt: "2026-10-24T09:30:00.000Z",
		activeRunId: null,
		activeRunState: null,
		lastFailure: null,
		...overrides,
	};
}

function status(
	us: Partial<StockDirectoryMarketStatus> = {},
	jp: Partial<StockDirectoryMarketStatus> = {},
): StockDirectoryStatusResponse {
	return { markets: [market("US", us), market("JP", jp)] };
}

const MISSING: Partial<StockDirectoryMarketStatus> = {
	entryCount: 0,
	asOf: null,
	retrievedAt: null,
};

const TOYOTA: StockDirectoryHit = {
	stockId: "jp:7203",
	market: "JP",
	symbol: "7203",
	name: "TOYOTA MOTOR CORPORATION",
	localName: "トヨタ自動車",
	listing: "tse-prime",
	registered: false,
};

const TOYOTA_US: StockDirectoryHit = {
	stockId: "us:TM",
	market: "US",
	symbol: "TM",
	name: "TOYOTA MOTOR CORP/",
	localName: null,
	listing: "nyse",
	registered: false,
};

describe("the stock-list staleness rule", () => {
	it("is seven days, compared strictly", () => {
		expect(STOCK_DIRECTORY_STALE_MS).toBe(604_800_000);
		// 2026-10-17T12:00:00Z is exactly 7 days before NOW: not yet stale.
		expect(
			isDirectoryListStale(market("JP", { retrievedAt: "2026-10-17T12:00:00.000Z" }), NOW),
		).toBe(false);
		// One second older: stale.
		expect(
			isDirectoryListStale(market("JP", { retrievedAt: "2026-10-17T11:59:59.000Z" }), NOW),
		).toBe(true);
	});

	it("counts a list with no rows or no download stamp as missing", () => {
		expect(isDirectoryListStale(market("US", MISSING), NOW)).toBe(true);
		expect(isDirectoryListStale(market("US", { entryCount: 0 }), NOW)).toBe(true);
		expect(isDirectoryListStale(market("US", { retrievedAt: null }), NOW)).toBe(true);
	});
});

describe("directoryAutoRefreshMarkets", () => {
	it("queues nothing while both lists are fresh", () => {
		expect(directoryAutoRefreshMarkets(status(), NOW)).toEqual([]);
	});

	it("queues each market whose list is missing or older than seven days", () => {
		expect(directoryAutoRefreshMarkets(status(MISSING), NOW)).toEqual(["US"]);
		expect(
			directoryAutoRefreshMarkets(status({}, { retrievedAt: "2026-10-17T11:59:59.000Z" }), NOW),
		).toEqual(["JP"]);
		expect(directoryAutoRefreshMarkets(status(MISSING, MISSING), NOW)).toEqual(["US", "JP"]);
	});

	it("skips a market whose download is already active", () => {
		expect(
			directoryAutoRefreshMarkets(
				status({ ...MISSING, activeRunId: "run_1", activeRunState: "pending" }, MISSING),
				NOW,
			),
		).toEqual(["JP"]);
	});

	it("never queues after DIRECTORY_NOT_CONFIGURED, but retries other failures once", () => {
		const notConfigured = {
			state: "failed",
			code: "DIRECTORY_NOT_CONFIGURED",
			at: "2026-10-24T10:00:00.000Z",
		};
		expect(
			directoryAutoRefreshMarkets(status({ ...MISSING, lastFailure: notConfigured }), NOW),
		).toEqual([]);
		expect(
			directoryAutoRefreshMarkets(
				status({ ...MISSING, lastFailure: { ...notConfigured, code: "DIRECTORY_SOURCE_FAILED" } }),
				NOW,
			),
		).toEqual(["US"]);
	});

	it("trusts the API's lastFailure: a failure beside a stored list still blocks the retry", () => {
		// The API clears lastFailure once a later download succeeds, so a failure it
		// reports stands even beside an older stored list (here 22 days old).
		const stale = { retrievedAt: "2026-10-02T00:00:00.000Z" };
		const notConfigured = {
			state: "failed",
			code: "DIRECTORY_NOT_CONFIGURED",
			at: "2026-10-01T00:00:00.000Z",
		};
		expect(directoryAutoRefreshMarkets(status(stale), NOW)).toEqual(["US"]);
		expect(
			directoryAutoRefreshMarkets(status({ ...stale, lastFailure: notConfigured }), NOW),
		).toEqual([]);
	});
});

describe("directory run state", () => {
	it("is active only for a loaded status with an active run", () => {
		expect(isStockDirectoryRunActive(null)).toBe(false);
		expect(isStockDirectoryRunActive(undefined)).toBe(false);
		expect(isStockDirectoryRunActive(status())).toBe(false);
		expect(isStockDirectoryRunActive(status({}, { activeRunId: "run_jp" }))).toBe(true);
	});

	it("polls slowly while every active download waits for a runner", () => {
		expect(stockDirectoryPollSignal(status())).toBe("unchanged");
		expect(
			stockDirectoryPollSignal(status({ activeRunId: "run_us", activeRunState: "pending" })),
		).toBe("queued");
		expect(
			stockDirectoryPollSignal(
				status(
					{ activeRunId: "run_us", activeRunState: "pending" },
					{ activeRunId: "run_jp", activeRunState: "claimed" },
				),
			),
		).toBe("active");
	});

	it("knows whether any list is stored", () => {
		expect(storedDirectoryMarkets(null)).toBe(null);
		expect(storedDirectoryMarkets(status(MISSING, MISSING))).toEqual([]);
		expect(storedDirectoryMarkets(status(MISSING))).toEqual(["JP"]);
		expect(storedDirectoryMarkets(status())).toEqual(["US", "JP"]);
	});
});

describe("directoryStatusLine", () => {
	it("states the count with the download time, or the source's as-of date", () => {
		expect(directoryStatusLine(market("US"), EN)).toBe(
			"US list: 7,691 stocks, retrieved 2026-10-24 09:30 UTC.",
		);
		expect(directoryStatusLine(market("JP"), EN)).toBe(
			"Japan list: 3,707 stocks, as of 2026-09-30.",
		);
		expect(directoryStatusLine(market("US", MISSING), EN)).toBe("US list: not downloaded yet.");
	});

	it("adds the active download and the failure that still stands", () => {
		expect(
			directoryStatusLine(
				market("US", { ...MISSING, activeRunId: "run_us", activeRunState: "pending" }),
				EN,
			),
		).toBe("US list: not downloaded yet. Updating (pending)…");
		expect(
			directoryStatusLine(
				market("US", {
					...MISSING,
					lastFailure: {
						state: "failed",
						code: "DIRECTORY_NOT_CONFIGURED",
						at: "2026-10-24T10:00:00.000Z",
					},
				}),
				EN,
			),
		).toBe(
			"US list: not downloaded yet. The last update failed: Set SEC_USER_AGENT in apps/runner/.env (the name and contact e-mail address SEC asks for) to download the US list.",
		);
		expect(
			directoryStatusLine(
				market("JP", {
					lastFailure: {
						state: "failed",
						code: "DIRECTORY_PARSE_FAILED",
						at: "2026-10-24T11:00:00.000Z",
					},
				}),
				EN,
			),
		).toBe(
			"Japan list: 3,707 stocks, as of 2026-09-30. The last update failed: The downloaded list could not be read, so the stored list was kept.",
		);
	});

	it("words an unknown code without provider text, and shows the API's failure as is", () => {
		const at = "2026-10-24T11:00:00.000Z";
		expect(
			directoryStatusLine(
				market("US", { lastFailure: { state: "failed", code: "RUNNER_LOST", at } }),
				EN,
			),
		).toBe(
			"US list: 7,691 stocks, retrieved 2026-10-24 09:30 UTC. The last update failed: The update failed (RUNNER_LOST).",
		);
		// No client-side comparison with retrievedAt: a failure the API reports is shown.
		expect(
			directoryStatusLine(
				market("US", {
					retrievedAt: "2026-10-24T11:30:00.000Z",
					lastFailure: { state: "failed", code: "DIRECTORY_RATE_LIMITED", at },
				}),
				EN,
			),
		).toBe(
			"US list: 7,691 stocks, retrieved 2026-10-24 11:30 UTC. The last update failed: The source limited requests; try again later.",
		);
	});

	it("reads in Japanese with no space between sentences", () => {
		expect(directoryStatusLine(market("JP"), JA)).toBe(
			"日本の銘柄一覧: 3,707 銘柄、2026-09-30 時点。",
		);
		expect(
			directoryStatusLine(
				market("US", { ...MISSING, activeRunId: "run_us", activeRunState: "pending" }),
				JA,
			),
		).toBe("米国の銘柄一覧: まだ取得していません。更新中（待機中）…");
	});
});

describe("search text", () => {
	it("trims the query and cuts it to the contract's length; blank asks nothing", () => {
		expect(stockSearchQuery("  toyota  ")).toBe("toyota");
		expect(stockSearchQuery("   ")).toBe(null);
		expect(stockSearchQuery("a".repeat(70))).toBe("a".repeat(64));
	});

	it("states the search in the live line", () => {
		const failure: ApiFailure = {
			kind: "api",
			code: "INTERNAL",
			status: 500,
			message: "boom",
			detail: null,
			issues: [],
		};
		const reason = (error: ApiFailure) => error.message;
		const both = ["US", "JP"] as const;
		const results = (hits: readonly StockDirectoryHit[]) =>
			({ kind: "results", query: "zzz", hits }) as const;
		expect(stockSearchStatusText({ kind: "idle" }, both, EN, reason)).toBe("");
		expect(
			stockSearchStatusText({ kind: "searching", query: "t", hits: [] }, both, EN, reason),
		).toBe("Searching…");
		expect(stockSearchStatusText(results([TOYOTA]), both, EN, reason)).toBe("1 result");
		expect(stockSearchStatusText(results([TOYOTA, TOYOTA_US]), both, EN, reason)).toBe("2 results");
		expect(stockSearchStatusText(results([]), both, EN, reason)).toBe('No stock matches "zzz".');
		expect(stockSearchStatusText(results([]), null, EN, reason)).toBe('No stock matches "zzz".');
		expect(stockSearchStatusText(results([]), [], EN, reason)).toBe(
			"No stock list is downloaded yet. Enter the symbol under “Enter a symbol instead”.",
		);
		expect(
			stockSearchStatusText({ kind: "failed", query: "t", error: failure }, both, EN, reason),
		).toBe("The search failed: boom");
		expect(stockSearchStatusText(results([]), both, JA, reason)).toBe(
			"「zzz」に一致する銘柄はありません。",
		);
	});

	it("says the search covered one market when only its list is stored", () => {
		const reason = (error: ApiFailure) => error.message;
		const results = (hits: readonly StockDirectoryHit[]) =>
			({ kind: "results", query: "zzz", hits }) as const;
		expect(stockSearchStatusText(results([]), ["US"], EN, reason)).toBe(
			'No US stock matches "zzz". The Japanese stock list is not downloaded yet.',
		);
		expect(stockSearchStatusText(results([TOYOTA]), ["JP"], EN, reason)).toBe(
			"1 Japanese result. The US stock list is not downloaded yet.",
		);
		expect(stockSearchStatusText(results([TOYOTA, TOYOTA]), ["JP"], EN, reason)).toBe(
			"2 Japanese results. The US stock list is not downloaded yet.",
		);
		expect(stockSearchStatusText(results([]), ["US"], JA, reason)).toBe(
			"「zzz」に一致する米国の銘柄はありません。日本の銘柄一覧はまだ取得されていません。",
		);
		expect(stockSearchStatusText(results([TOYOTA]), ["JP"], JA, reason)).toBe(
			"日本の銘柄 1 件。米国の銘柄一覧はまだ取得されていません。",
		);
	});

	it("keeps the previous hits on screen while the next search runs", () => {
		expect(stockSearchHits({ kind: "results", query: "t", hits: [TOYOTA] })).toEqual([TOYOTA]);
		expect(stockSearchHits({ kind: "searching", query: "to", hits: [TOYOTA] })).toEqual([TOYOTA]);
		expect(stockSearchHits({ kind: "idle" })).toEqual([]);
	});
});

describe("addTargetText", () => {
	it("names the market and symbol Add stock will add, however they were set", () => {
		expect(addTargetText("US", " msft ", EN)).toBe("To add: MSFT (US)");
		expect(addTargetText("JP", "7203", EN)).toBe("To add: 7203 (Japan)");
		expect(addTargetText("JP", "7203", JA)).toBe("追加する銘柄: 7203（日本）");
		expect(addTargetText("US", "   ", EN)).toBe("");
	});
});

describe("search hits", () => {
	it("lead with the UI language's name and keep the other one secondary", () => {
		expect(stockHitNames(TOYOTA, "en")).toEqual({
			primary: "TOYOTA MOTOR CORPORATION",
			secondary: "トヨタ自動車",
		});
		expect(stockHitNames(TOYOTA, "ja")).toEqual({
			primary: "トヨタ自動車",
			secondary: "TOYOTA MOTOR CORPORATION",
		});
		expect(stockHitNames(TOYOTA_US, "ja")).toEqual({
			primary: "TOYOTA MOTOR CORP/",
			secondary: null,
		});
	});

	it("name the market and the listing in the UI language", () => {
		expect(stockHitPlace(TOYOTA, EN)).toBe("Japan · Prime");
		expect(stockHitPlace(TOYOTA, JA)).toBe("日本・プライム");
		expect(stockHitPlace(TOYOTA_US, EN)).toBe("US · NYSE");
		expect(stockHitPlace({ ...TOYOTA, listing: "tse-growth" }, JA)).toBe("日本・グロース");
	});

	it("say what is selected", () => {
		expect(selectedStockText(TOYOTA, "en", EN)).toBe(
			"Selected: 7203 TOYOTA MOTOR CORPORATION (Japan)",
		);
		expect(selectedStockText(TOYOTA, "ja", JA)).toBe("選択中: 7203 トヨタ自動車（日本）");
	});

	it("stay picked only while the form holds their market and symbol", () => {
		expect(pickedStockFor(TOYOTA, "JP", "7203")).toBe(TOYOTA);
		expect(pickedStockFor(TOYOTA, "JP", " 7203 ")).toBe(TOYOTA);
		expect(pickedStockFor(TOYOTA, "US", "7203")).toBe(null);
		expect(pickedStockFor(TOYOTA, "JP", "7205")).toBe(null);
		expect(pickedStockFor(null, "JP", "7203")).toBe(null);
	});
});

describe("moveActiveOption", () => {
	it("enters the list at either end and wraps", () => {
		expect(moveActiveOption(-1, 3, "next")).toBe(0);
		expect(moveActiveOption(0, 3, "next")).toBe(1);
		expect(moveActiveOption(2, 3, "next")).toBe(0);
		expect(moveActiveOption(-1, 3, "previous")).toBe(2);
		expect(moveActiveOption(0, 3, "previous")).toBe(2);
		expect(moveActiveOption(2, 3, "previous")).toBe(1);
		expect(moveActiveOption(0, 0, "next")).toBe(-1);
	});
});
