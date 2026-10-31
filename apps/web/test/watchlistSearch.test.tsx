import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatInstant } from "../src/lib/format.ts";
import { deferred, errorResponse, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import {
	createStocksBackend,
	type MountedStocks,
	mountRegistered,
	mountStocks,
	STOCKS_TABLE,
} from "./stocksHarness.tsx";
import { emptyDirectoryMarket, FRESH_STAMP, type WatchServer } from "./watchlistHarness.ts";

/**
 * The stock search box (ADR-0034) where it now lives as the page's own
 * search — the Stocks page's "Find a stock" (ADR-0050 §1), where a pick opens
 * the stock — and the Registered stocks page's "Market stock lists" section
 * (ADR-0050 §4). The Registered stocks page has no add form any more.
 */

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createStocksBackend());
});

afterEach(cleanup);

const SEARCH = /^\/api\/v1\/watchlist\/directory\/search\?/;
const DIRECTORY_REFRESH = /^\/api\/v1\/watchlist\/directory\/refresh$/;
const TABLE_NAME = STOCKS_TABLE;

let page: MountedStocks;

async function mount(): Promise<HTMLInputElement> {
	page = mountStocks(backend);
	const box = await screen.findByRole("combobox", { name: "Search stocks" });
	if (!(box instanceof HTMLInputElement)) throw new Error("the combobox is not an input");
	return box;
}

function type(box: HTMLInputElement, text: string): void {
	fireEvent.input(box, { target: { value: text } });
}

async function options(): Promise<HTMLElement[]> {
	const listbox = await screen.findByRole("listbox", { name: "Matching stocks" });
	return within(listbox).getAllByRole("option");
}

/** The stock the page was asked to open last, or null. */
function opened(): string | null {
	return page.navigations.at(-1)?.stock?.stockId ?? null;
}

function searchedQueries(): string[] {
	return backend
		.requestsTo("GET", SEARCH)
		.map((request) => new URLSearchParams(request.path.split("?")[1]).get("q") ?? "");
}

describe("Stock search box (the Stocks page's Find a stock)", () => {
	it("finds a stock by name and opens the one picked", async () => {
		const box = await mount();
		type(box, "toyota");
		const found = await options();
		// Ranked by the domain's reference: both name-prefix hits, the shorter symbol first.
		expect(found.map((option) => option.getAttribute("data-stock-id"))).toEqual([
			"us:TM",
			"jp:7203",
		]);
		const toyota = found[1];
		if (toyota === undefined) throw new Error("no 7203 option");
		expect(toyota.textContent).toContain("7203");
		expect(toyota.textContent).toContain("TOYOTA MOTOR CORPORATION");
		expect(toyota.textContent).toContain("トヨタ自動車");
		expect(toyota.textContent).toContain("Japan · Prime");
		expect(found[0]?.textContent).toContain("US · NYSE");
		expect(screen.getByText("2 results")).toBeTruthy();
		expect(box.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(toyota);
		expect(screen.queryByRole("listbox")).toBe(null);
		expect(opened()).toBe("jp:7203");
		expect(box.value).toBe("");
		// Searching adds nothing.
		expect(backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("drives the list from the keyboard: arrows, Enter, Escape twice", async () => {
		const box = await mount();
		type(box, "motor");
		const found = await options();
		expect(found).toHaveLength(3);
		expect(box.getAttribute("aria-activedescendant")).toBe(null);

		fireEvent.keyDown(box, { key: "ArrowDown" });
		expect(box.getAttribute("aria-activedescendant")).toBe(found[0]?.id);
		expect(found[0]?.getAttribute("aria-selected")).toBe("true");
		fireEvent.keyDown(box, { key: "ArrowDown" });
		expect(box.getAttribute("aria-activedescendant")).toBe(found[1]?.id);
		fireEvent.keyDown(box, { key: "ArrowUp" });
		fireEvent.keyDown(box, { key: "ArrowUp" });
		// Wraps from the first option to the last.
		expect(box.getAttribute("aria-activedescendant")).toBe(found[2]?.id);
		expect(found[2]?.getAttribute("data-stock-id")).toBe("jp:7205");

		fireEvent.keyDown(box, { key: "Enter" });
		expect(screen.queryByRole("listbox")).toBe(null);
		expect(opened()).toBe("jp:7205");

		// ↓ reopens; the first Escape closes the list and keeps the text…
		type(box, "motor");
		await options();
		fireEvent.keyDown(box, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBe(null);
		expect(box.value).toBe("motor");
		fireEvent.keyDown(box, { key: "ArrowDown" });
		expect(screen.getByRole("listbox", { name: "Matching stocks" })).toBeTruthy();
		fireEvent.keyDown(box, { key: "Escape" });
		// …the second clears it.
		fireEvent.keyDown(box, { key: "Escape" });
		expect(box.value).toBe("");
		// Enter with no active option opens nothing (there is no form to submit).
		type(box, "sony");
		await options();
		const navigations = page.navigations.length;
		fireEvent.keyDown(box, { key: "Enter" });
		expect(page.navigations).toHaveLength(navigations);
	});

	it("opens a stock already on the watchlist too, with no Added mark", async () => {
		const box = await mount();
		type(box, "apple");
		const [apple] = await options();
		if (apple === undefined) throw new Error("no AAPL option");
		expect(apple.getAttribute("data-stock-id")).toBe("us:AAPL");
		expect(apple.getAttribute("aria-disabled")).toBe(null);
		expect(within(apple).queryByText("Added")).toBe(null);
		fireEvent.click(apple);
		expect(opened()).toBe("us:AAPL");
	});

	it("finds Japanese names from hiragana and a code from full-width digits", async () => {
		const box = await mount();
		type(box, "とよた");
		expect((await options()).map((option) => option.getAttribute("data-stock-id"))).toEqual([
			"jp:7203",
		]);
		type(box, "７２０３");
		await waitFor(() => {
			expect(searchedQueries().at(-1)).toBe("７２０３");
		});
		await waitFor(async () => {
			expect((await options()).map((option) => option.getAttribute("data-stock-id"))).toEqual([
				"jp:7203",
			]);
		});
	});

	it("sends one search per typing pause and says when nothing matches", async () => {
		const box = await mount();
		type(box, "s");
		type(box, "so");
		type(box, "son");
		type(box, "sony");
		await screen.findByText("1 result");
		expect(searchedQueries()).toEqual(["sony"]);

		type(box, "zzzz");
		expect(await screen.findByText('No stock matches "zzzz".')).toBeTruthy();
		expect(screen.queryByRole("listbox")).toBe(null);
	});

	it("states a failed search in the live line", async () => {
		backend.on("GET", SEARCH, () => errorResponse(500, "INTERNAL", "boom"));
		const box = await mount();
		type(box, "toyota");
		expect(await screen.findByText(/^The search failed: /)).toBeTruthy();
	});

	it("points at Update stock list on Registered stocks when no list is downloaded", async () => {
		server.directory.rows = [];
		server.directory.US = emptyDirectoryMarket();
		server.directory.JP = emptyDirectoryMarket();
		const box = await mount();
		type(box, "msft");
		expect(
			await screen.findByText(
				"No stock list is downloaded yet. Download them with “Update stock list” on the Registered stocks page.",
			),
		).toBeTruthy();
		// A typed symbol is never added or opened from the box.
		expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
		expect(page.navigations).toEqual([]);
		expect(backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("ignores Enter while an IME composes: it neither picks nor opens", async () => {
		const box = await mount();
		type(box, "とよた");
		await options();
		fireEvent.keyDown(box, { key: "ArrowDown" });
		// Enter confirming the kana-to-kanji conversion (isComposing, keyCode 229).
		fireEvent.keyDown(box, { key: "Enter", isComposing: true, keyCode: 229 });
		fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
		expect(opened()).toBe(null);
		expect(screen.getByRole("listbox", { name: "Matching stocks" })).toBeTruthy();
		// The same Enter after the composition ends picks the active option.
		fireEvent.keyDown(box, { key: "Enter" });
		expect(opened()).toBe("jp:7203");
	});

	it("keeps the list and the active option open while the next search runs", async () => {
		const box = await mount();
		type(box, "toyota");
		await options();
		fireEvent.keyDown(box, { key: "ArrowDown" });
		fireEvent.keyDown(box, { key: "ArrowDown" });
		const activeStock = () =>
			document
				.getElementById(box.getAttribute("aria-activedescendant") ?? "")
				?.getAttribute("data-stock-id");
		expect(activeStock()).toBe("jp:7203");
		// The next answer is held back: the previous hits stay listed meanwhile.
		const held = deferred<Response>();
		backend.on("GET", SEARCH, () => held.promise);
		type(box, "toyota motor corporation");
		await screen.findByText("Searching…");
		expect(await options()).toHaveLength(2);
		expect(box.getAttribute("aria-expanded")).toBe("true");
		expect(activeStock()).toBe("jp:7203");
		held.resolve(
			jsonResponse({
				hits: [
					{
						stockId: "jp:7203",
						market: "JP",
						symbol: "7203",
						name: "TOYOTA MOTOR CORPORATION",
						localName: "トヨタ自動車",
						listing: "tse-prime",
						registered: false,
					},
				],
			}),
		);
		await screen.findByText("1 result");
		// 7203 is still in the new answer, so it stays the active option.
		expect(await options()).toHaveLength(1);
		expect(activeStock()).toBe("jp:7203");
	});

	it("says the search covered one market when the other list is missing", async () => {
		server.directory.JP = emptyDirectoryMarket();
		server.directory.rows = server.directory.rows.filter((row) => row.market === "US");
		const box = await mount();
		type(box, "とよた");
		expect(
			await screen.findByText(
				'No US stock matches "とよた". The Japanese stock list is not downloaded yet.',
			),
		).toBeTruthy();
	});
});

describe("Registered stocks has no add form", () => {
	it("shows the list and the Stock lists section, and no search box", async () => {
		mountRegistered(backend);
		await screen.findByRole("table", { name: TABLE_NAME });
		expect(screen.queryByRole("combobox", { name: "Search stocks" })).toBe(null);
		expect(screen.queryByRole("form", { name: "Add a stock" })).toBe(null);
		expect(screen.queryByRole("button", { name: "Add stock" })).toBe(null);
		const lists = screen.getByRole("region", { name: "Market stock lists" });
		expect(within(lists).getByRole("button", { name: "Update stock list" })).toBeTruthy();
	});
});

describe("Registered stocks: Stock lists section", () => {
	async function mountLists(): Promise<void> {
		mountRegistered(backend);
		await screen.findByRole("table", { name: TABLE_NAME });
	}

	function lines(): string[] {
		return [...document.querySelectorAll('[data-field="directory-status"] p')].map(
			(line) => line.textContent ?? "",
		);
	}

	it("states each market's list with its source, and queues nothing while both are fresh", async () => {
		await mountLists();
		await waitFor(() => {
			expect(lines()).toHaveLength(2);
		});
		expect(lines()[0]).toBe(
			`US list: 7,691 stocks, retrieved ${formatInstant(FRESH_STAMP)}. Source: U.S. Securities and Exchange Commission (SEC)`,
		);
		expect(lines()[1]).toBe(
			"Japan list: 3,707 stocks, as of 2026-09-30. Source: Japan Exchange Group (JPX)",
		);
		expect(
			screen.getByRole("link", { name: "Japan Exchange Group (JPX)" }).getAttribute("href"),
		).toBe("https://www.jpx.co.jp/markets/statistics-equities/misc/01.html");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(backend.requestsTo("POST", DIRECTORY_REFRESH)).toHaveLength(0);
	});

	it("queues one download on load for a missing list and polls until it arrives", async () => {
		server.directory.JP = emptyDirectoryMarket();
		await mountLists();
		await waitFor(() => {
			expect(backend.requestsTo("POST", DIRECTORY_REFRESH).map((request) => request.body)).toEqual([
				{ markets: ["JP"] },
			]);
		});
		const refresh = backend.requestsTo("POST", DIRECTORY_REFRESH)[0];
		expect(refresh?.headers["idempotency-key"]).toMatch(/^idem-/);
		await waitFor(() => {
			expect(lines()[1]).toBe(
				"Japan list: not downloaded yet. Updating (pending)… Source: Japan Exchange Group (JPX)",
			);
		});
		// The runner stores the list: the poller sees the run end.
		server.directory.JP = {
			...emptyDirectoryMarket(),
			entryCount: 3707,
			asOf: "2026-09-30",
			retrievedAt: FRESH_STAMP,
		};
		await waitFor(
			() => {
				expect(lines()[1]).toBe(
					"Japan list: 3,707 stocks, as of 2026-09-30. Source: Japan Exchange Group (JPX)",
				);
			},
			{ timeout: 30_000 },
		);
		expect(backend.requestsTo("POST", DIRECTORY_REFRESH)).toHaveLength(1);
	}, 60_000);

	it("names SEC_USER_AGENT after a configuration failure and never queues it by itself", async () => {
		server.directory.US = {
			...emptyDirectoryMarket(),
			lastFailure: {
				state: "failed",
				code: "DIRECTORY_NOT_CONFIGURED",
				upstreamStatus: null,
				at: FRESH_STAMP,
			},
		};
		await mountLists();
		await waitFor(() => {
			expect(lines()[0]).toContain("Set SEC_USER_AGENT in apps/runner/.env");
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(backend.requestsTo("POST", DIRECTORY_REFRESH)).toHaveLength(0);

		fireEvent.click(screen.getByRole("button", { name: "Update stock list" }));
		expect(await screen.findByText("Stock list update queued for the local runner.")).toBeTruthy();
		expect(backend.requestsTo("POST", DIRECTORY_REFRESH).map((request) => request.body)).toEqual([
			{ markets: ["US", "JP"] },
		]);
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: "Update stock list" }).hasAttribute("disabled"),
			).toBe(true);
		});
	});

	it("shows and polls a market queued by a refresh request that still failed", async () => {
		server.directory.US = emptyDirectoryMarket();
		server.directory.JP = emptyDirectoryMarket();
		// US is queued, then the request fails (e.g. JP hit the run limit).
		server.directory.refreshFailure = { status: 429, code: "RATE_LIMITED", queued: ["US"] };
		await mountLists();
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The stock list update was not queued.");
		expect(alert.textContent).toContain("RATE_LIMITED");
		await waitFor(() => {
			expect(lines()[0]).toBe(
				"US list: not downloaded yet. Updating (pending)… Source: U.S. Securities and Exchange Commission (SEC)",
			);
		});
		// The poller follows the US run to its end.
		server.directory.US = {
			...emptyDirectoryMarket(),
			entryCount: 7691,
			retrievedAt: FRESH_STAMP,
		};
		await waitFor(
			() => {
				expect(lines()[0]).toBe(
					`US list: 7,691 stocks, retrieved ${formatInstant(FRESH_STAMP)}. Source: U.S. Securities and Exchange Commission (SEC)`,
				);
			},
			{ timeout: 30_000 },
		);
	}, 60_000);

	it("reports a queue the API refused", async () => {
		backend.on("POST", DIRECTORY_REFRESH, () => errorResponse(500, "INTERNAL", "boom"));
		await mountLists();
		await waitFor(() => {
			expect(lines()).toHaveLength(2);
		});
		fireEvent.click(screen.getByRole("button", { name: "Update stock list" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The stock list update was not queued.");
		expect(alert.textContent).toContain("INTERNAL");
	});
});
