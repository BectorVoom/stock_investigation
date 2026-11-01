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
	isStockDirectoryRunActive,
	moveActiveOption,
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
			upstreamStatus: null,
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
			"No stock list is downloaded yet. The server downloads them when the local runner next takes work.",
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
