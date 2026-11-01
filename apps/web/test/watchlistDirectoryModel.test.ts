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
	directoryStatusLine,
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
						upstreamStatus: null,
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
						upstreamStatus: null,
						at: "2026-10-24T11:00:00.000Z",
					},
				}),
				EN,
			),
		).toBe(
			"Japan list: 3,707 stocks, as of 2026-09-30. The last update failed: The downloaded list could not be read, so the stored list was kept.",
		);
	});

	it("adds the source's own answer status after the reason, unchanged (ADR-0037)", () => {
		expect(
			directoryStatusLine(
				market("US", {
					...MISSING,
					lastFailure: {
						state: "failed",
						code: "DIRECTORY_SOURCE_FAILED",
						upstreamStatus: 503,
						at: "2026-10-24T10:00:00.000Z",
					},
				}),
				EN,
			),
		).toBe(
			"US list: not downloaded yet. The last update failed: The source could not be reached. The service answered HTTP 503.",
		);
	});

	it("words an unknown code without provider text, and shows the API's failure as is", () => {
		const at = "2026-10-24T11:00:00.000Z";
		expect(
			directoryStatusLine(
				market("US", {
					lastFailure: { state: "failed", code: "RUNNER_LOST", upstreamStatus: null, at },
				}),
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
					lastFailure: {
						state: "failed",
						code: "DIRECTORY_RATE_LIMITED",
						upstreamStatus: null,
						at,
					},
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
			"No stock list is downloaded yet. Download them with “Update stock list” on the Registered stocks page.",
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
