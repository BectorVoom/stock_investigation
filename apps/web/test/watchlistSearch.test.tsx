import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { formatInstant } from "../src/lib/format.ts";
import { WatchlistView } from "../src/watchlist/WatchlistView.tsx";
import { ALWAYS_VISIBLE, errorResponse, type FakeBackend } from "./fakeBackend.ts";
import {
	createWatchlistBackend,
	emptyDirectoryMarket,
	FRESH_STAMP,
	type WatchServer,
} from "./watchlistHarness.ts";

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createWatchlistBackend());
});

afterEach(cleanup);

const SEARCH = /^\/api\/v1\/watchlist\/directory\/search\?/;
const DIRECTORY_REFRESH = /^\/api\/v1\/watchlist\/directory\/refresh$/;
const TABLE_NAME = "Stocks you follow, with their next earnings announcement date";

async function mount(): Promise<HTMLInputElement> {
	render(() => (
		<WatchlistView api={createApiClient({ fetch: backend.fetch })} visibility={ALWAYS_VISIBLE} />
	));
	await screen.findByRole("table", { name: TABLE_NAME });
	const box = screen.getByRole("combobox", { name: "Search stocks" });
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

function selectedLine(): string {
	return document.querySelector('[data-field="selected-stock"]')?.textContent ?? "";
}

function searchedQueries(): string[] {
	return backend
		.requestsTo("GET", SEARCH)
		.map((request) => new URLSearchParams(request.path.split("?")[1]).get("q") ?? "");
}

describe("Watchlist stock search", () => {
	it("finds a stock by name, fills the form with the pick, and adds it", async () => {
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
		expect(box.getAttribute("aria-expanded")).toBe("false");
		expect(selectedLine()).toBe("Selected: 7203 TOYOTA MOTOR CORPORATION (Japan)");
		// The pick filled the manual fields too: market and symbol are what "Add stock" sends.
		expect(screen.getByLabelText<HTMLInputElement>("Symbol").value).toBe("7203");
		expect(screen.getByLabelText<HTMLSelectElement>("Market").value).toBe("JP");
		const add = screen.getByRole("button", { name: "Add stock" });
		expect(add.hasAttribute("disabled")).toBe(false);

		fireEvent.click(add);
		await waitFor(() => {
			expect(screen.getByRole("table", { name: TABLE_NAME }).textContent).toContain("7203");
		});
		const posted = backend.requestsTo("POST", /^\/api\/v1\/watchlist\/stocks$/);
		expect(posted.map((request) => request.body)).toEqual([{ market: "JP", symbol: "7203" }]);
		// The form is ready for the next stock.
		expect(box.value).toBe("");
		expect(selectedLine()).toBe("");
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
		expect(selectedLine()).toBe("Selected: 7205 HINO MOTORS,LTD. (Japan)");

		// ↓ reopens; the first Escape closes the list and keeps the text…
		fireEvent.keyDown(box, { key: "ArrowDown" });
		expect(screen.getByRole("listbox", { name: "Matching stocks" })).toBeTruthy();
		fireEvent.keyDown(box, { key: "Escape" });
		expect(screen.queryByRole("listbox")).toBe(null);
		expect(box.value).toBe("motor");
		// …the second clears it, and with it the pick.
		fireEvent.keyDown(box, { key: "Escape" });
		expect(box.value).toBe("");
		expect(selectedLine()).toBe("");
		expect(screen.getByLabelText<HTMLInputElement>("Symbol").value).toBe("");
	});

	it("marks a stock already on the watchlist as Added and does not pick it", async () => {
		const box = await mount();
		type(box, "apple");
		const [apple] = await options();
		if (apple === undefined) throw new Error("no AAPL option");
		expect(apple.getAttribute("data-stock-id")).toBe("us:AAPL");
		expect(apple.getAttribute("aria-disabled")).toBe("true");
		expect(within(apple).getByText("Added")).toBeTruthy();
		fireEvent.click(apple);
		fireEvent.keyDown(box, { key: "ArrowDown" });
		fireEvent.keyDown(box, { key: "Enter" });
		expect(selectedLine()).toBe("");
		expect(screen.getByLabelText<HTMLInputElement>("Symbol").value).toBe("");
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

	it("ends the pick when the search text changes, so Add never adds a stock no longer shown", async () => {
		const box = await mount();
		type(box, "sony");
		const [sony] = await options();
		if (sony === undefined) throw new Error("no 6758 option");
		fireEvent.click(sony);
		expect(selectedLine()).toBe("Selected: 6758 Sony Group Corporation (Japan)");
		type(box, "sonyx");
		expect(selectedLine()).toBe("");
		expect(screen.getByLabelText<HTMLInputElement>("Symbol").value).toBe("");
		expect(screen.getByRole("button", { name: "Add stock" }).hasAttribute("disabled")).toBe(true);
	});

	it("states a failed search in the live line", async () => {
		backend.on("GET", SEARCH, () => errorResponse(500, "INTERNAL", "boom"));
		const box = await mount();
		type(box, "toyota");
		expect(await screen.findByText(/^The search failed: /)).toBeTruthy();
	});

	it("still adds an exact symbol by hand when no list is downloaded", async () => {
		server.directory.rows = [];
		server.directory.US = emptyDirectoryMarket();
		server.directory.JP = emptyDirectoryMarket();
		const box = await mount();
		type(box, "msft");
		expect(
			await screen.findByText(
				"No stock list is downloaded yet. Enter the symbol under “Enter a symbol instead”.",
			),
		).toBeTruthy();
		fireEvent.click(screen.getByText("Enter a symbol instead"));
		fireEvent.input(screen.getByLabelText("Symbol"), { target: { value: "MSFT" } });
		fireEvent.click(screen.getByRole("button", { name: "Add stock" }));
		await waitFor(() => {
			expect(screen.getByRole("table", { name: TABLE_NAME }).textContent).toContain("MSFT");
		});
	});
});

describe("Watchlist stock lists", () => {
	function lines(): string[] {
		return [...document.querySelectorAll('[data-field="directory-status"] p')].map(
			(line) => line.textContent ?? "",
		);
	}

	it("states each market's list with its source, and queues nothing while both are fresh", async () => {
		await mount();
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
		await mount();
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
			lastFailure: { state: "failed", code: "DIRECTORY_NOT_CONFIGURED", at: FRESH_STAMP },
		};
		await mount();
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

	it("reports a queue the API refused", async () => {
		backend.on("POST", DIRECTORY_REFRESH, () => errorResponse(500, "INTERNAL", "boom"));
		await mount();
		await waitFor(() => {
			expect(lines()).toHaveLength(2);
		});
		fireEvent.click(screen.getByRole("button", { name: "Update stock list" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The stock list update was not queued.");
		expect(alert.textContent).toContain("INTERNAL");
	});
});
