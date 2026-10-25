import { putHomeDashboardRequestSchema, type WatchlistList } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { WatchlistView } from "../src/watchlist/WatchlistView.tsx";
import {
	type HomeServerState,
	initialHomeServerState,
	initialServerState,
	installHomeRoutes,
} from "./appHarness.tsx";
import { ALWAYS_VISIBLE, errorResponse, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { createWatchlistBackend, makeStock, type WatchServer } from "./watchlistHarness.ts";

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createWatchlistBackend());
	server.stocks = [
		makeStock(),
		makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" }),
	];
});

afterEach(cleanup);

const TABLE_NAME = "Stocks you follow, with their next earnings announcement date";

/** The watchlist the fake serves, for a route a test overrides. */
function watchlistBody() {
	return {
		stocks: server.stocks,
		lists: server.lists,
		refresh: {
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: null,
			lastFailure: null,
		},
		feed: { enabled: false, createdAt: null },
		googleCalendar: { ...server.google, activeRunState: null },
	};
}

function list(overrides: Partial<WatchlistList> = {}): WatchlistList {
	return {
		listId: "list_a",
		title: "Semis",
		stockIds: [],
		version: 1,
		createdAt: "2026-10-25T00:00:00Z",
		updatedAt: "2026-10-25T00:00:00Z",
		...overrides,
	};
}

async function mount(locale: "en" | "ja" = "en"): Promise<HTMLElement> {
	const api = createApiClient({ fetch: backend.fetch });
	render(() => (
		<LocaleProvider locale={() => locale}>
			<WatchlistView api={api} visibility={ALWAYS_VISIBLE} />
		</LocaleProvider>
	));
	await screen.findByRole("table", { name: locale === "en" ? TABLE_NAME : /./ });
	return screen.getByRole("region", { name: locale === "en" ? "Lists" : "リスト" });
}

function card(title: string): HTMLElement {
	return screen.getByRole("listitem", { name: `List: ${title}` });
}

function openListMenu(title: string, item: string): void {
	fireEvent.click(screen.getByRole("button", { name: `Actions for ${title}` }));
	fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: item }));
}

function status(): string {
	return document.querySelector('[data-field="lists-status"]')?.textContent ?? "";
}

describe("Watchlist lists (ADR-0040 §7)", () => {
	it("makes a list, renames it, and deletes it after confirmation", async () => {
		const section = await mount();
		expect(within(section).getByText("No lists yet. Make one with New list.")).toBeTruthy();

		fireEvent.click(within(section).getByRole("button", { name: "New list" }));
		const create = await screen.findByRole("dialog", { name: "New list" });
		const title = within(create).getByRole("textbox", { name: "Title" });
		expect(document.activeElement).toBe(title);
		const submit = within(create).getByRole("button", { name: "Create list" });
		// An empty title cannot be sent.
		expect(submit.hasAttribute("disabled")).toBe(true);
		fireEvent.input(title, { target: { value: "  Semis  " } });
		fireEvent.click(submit);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(backend.requestsTo("POST", /\/watchlist\/lists$/).map((r) => r.body)).toEqual([
			{ title: "Semis" },
		]);
		await waitFor(() => expect(card("Semis").textContent).toContain("0 of 12 stocks"));
		expect(within(card("Semis")).getByText("No stocks in this list yet.")).toBeTruthy();
		expect(status()).toBe("Created Semis.");

		openListMenu("Semis", "Rename…");
		const rename = await screen.findByRole("dialog", { name: "Rename Semis" });
		const field = within(rename).getByRole("textbox", { name: "Title" });
		expect((field as HTMLInputElement).value).toBe("Semis");
		fireEvent.input(field, { target: { value: "Chips" } });
		fireEvent.click(within(rename).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(card("Chips")).toBeTruthy());
		expect(backend.requestsTo("PATCH", /\/watchlist\/lists\/list_1$/)[0]?.body).toEqual({
			title: "Chips",
		});

		openListMenu("Chips", "Delete…");
		const confirm = await screen.findByRole("dialog");
		expect(confirm.textContent).toContain("Delete Chips?");
		expect(confirm.textContent).toContain("its stocks stay on the watchlist");
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete list" }));
		await waitFor(() =>
			expect(within(section).getByText("No lists yet. Make one with New list.")).toBeTruthy(),
		);
		expect(backend.requestsTo("DELETE", /\/watchlist\/lists\/list_1$/)).toHaveLength(1);
		expect(status()).toBe("Deleted Chips.");
	});

	it("adds a watched stock by its checkbox and a new one by search, queueing the new stock's dates", async () => {
		server.lists = [list()];
		await mount();
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Add stocks to Semis" }));
		const dialog = await screen.findByRole("dialog", { name: "Add stocks to Semis" });
		expect(dialog.textContent).toContain("Room for 12 more stocks.");
		expect(dialog.textContent).toContain("also adds it to the watchlist");
		const boxes = within(dialog).getAllByRole("checkbox");
		expect(boxes.map((box) => box.getAttribute("data-stock-id"))).toEqual(["us:AAPL", "us:MSFT"]);
		expect(document.activeElement).toBe(boxes[0]);
		fireEvent.click(boxes[1] ?? dialog);

		const search = within(dialog).getByRole("combobox", { name: "Search stocks" });
		fireEvent.input(search, { target: { value: "toyota" } });
		const listbox = await within(dialog).findByRole("listbox", { name: "Matching stocks" });
		const toyota = within(listbox)
			.getAllByRole("option")
			.find((option) => option.getAttribute("data-stock-id") === "jp:7203");
		if (toyota === undefined) throw new Error("no 7203 option");
		fireEvent.click(toyota);
		expect(dialog.querySelector('[data-field="list-add-found"]')?.textContent).toBe(
			"Selected: 7203 TOYOTA MOTOR CORPORATION (Japan)",
		);

		fireEvent.click(within(dialog).getByRole("button", { name: "Add 2 stocks to list" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// One request per stock, in the order shown: the watched one, then the found one.
		expect(
			backend.requestsTo("POST", /\/watchlist\/lists\/list_a\/stocks$/).map((r) => r.body),
		).toEqual([
			{ market: "US", symbol: "MSFT" },
			{ market: "JP", symbol: "7203" },
		]);
		// The new stock's earnings dates are fetched as after the page's plain add (ADR-0039).
		await waitFor(() =>
			expect(backend.requestsTo("POST", /\/watchlist\/refresh$/).map((r) => r.body)).toEqual([
				{ scope: "unrefreshed" },
			]),
		);
		expect(
			await screen.findByText(
				"Added 7203 to Semis and to the watchlist. Its earnings dates are being fetched by the local runner.",
			),
		).toBeTruthy();
		expect(status()).toBe("Added MSFT to Semis.");
		const members = within(card("Semis")).getByRole("list", { name: "Stocks in Semis" });
		expect(
			within(members)
				.getAllByRole("listitem")
				.map((item) => item.getAttribute("data-stock-id")),
		).toEqual(["us:MSFT", "jp:7203"]);
		// The stock table names the lists each stock is in.
		const table = screen.getByRole("table", { name: TABLE_NAME });
		expect(within(table).getByRole("row", { name: /7203/ }).textContent).toContain(
			"In lists: Semis",
		);
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).not.toContain("In lists");
	});

	it("removes a stock from a list, keeping it on the watchlist", async () => {
		server.lists = [list({ stockIds: ["us:AAPL"] })];
		await mount();
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Remove AAPL from Semis" }));
		await waitFor(() =>
			expect(within(card("Semis")).getByText("No stocks in this list yet.")).toBeTruthy(),
		);
		expect(backend.requestsTo("DELETE", /\/lists\/list_a\/stocks\/us%3AAAPL$/)).toHaveLength(1);
		expect(status()).toBe("Removed AAPL from Semis.");
		expect(server.stocks.map((stock) => stock.stockId)).toContain("us:AAPL");
	});

	it("moves focus to the next row's Remove, then to Add stock, and to New list after a delete", async () => {
		server.lists = [list({ stockIds: ["us:AAPL", "us:MSFT"] })];
		const section = await mount();
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Remove AAPL from Semis" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				within(card("Semis")).getByRole("button", { name: "Remove MSFT from Semis" }),
			),
		);
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Remove MSFT from Semis" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				within(card("Semis")).getByRole("button", { name: "Add stocks to Semis" }),
			),
		);
		openListMenu("Semis", "Delete…");
		const confirm = await screen.findByRole("dialog");
		fireEvent.click(within(confirm).getByRole("button", { name: "Delete list" }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				within(section).getByRole("button", { name: "New list" }),
			),
		);
	});

	it("re-reads the lists after any refused write, so counts and controls are current", async () => {
		server.lists = [list()];
		await mount();
		// Another tab fills the list to 12 before this page's add.
		const many = Array.from({ length: 12 }, (_, index) =>
			makeStock({ stockId: `us:S${index}`, symbol: `S${index}`, name: `Stock ${index}` }),
		);
		server.stocks = [...server.stocks, ...many];
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Add stocks to Semis" }));
		const dialog = await screen.findByRole("dialog", { name: "Add stocks to Semis" });
		fireEvent.click(within(dialog).getAllByRole("checkbox")[0] ?? dialog);
		server.lists = [list({ stockIds: many.map((stock) => stock.stockId), version: 2 })];
		fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 stock to list" }));
		const alert = await within(dialog).findByRole("alert");
		expect(alert.textContent).toContain(
			"AAPL was not added to the list. This list is full: a list holds at most 12 stocks.",
		);
		await waitFor(() => expect(card("Semis").textContent).toContain("12 of 12 stocks"));
		expect(
			within(card("Semis"))
				.getByRole("button", { name: "Add stocks to Semis" })
				.hasAttribute("disabled"),
		).toBe(true);
	});

	it("names the stock a partial add stopped at and announces the ones added", async () => {
		server.stocks = [
			...server.stocks,
			makeStock({ stockId: "us:NVDA", symbol: "NVDA", name: "NVIDIA Corp" }),
		];
		server.lists = [list()];
		backend.on("POST", /^\/api\/v1\/watchlist\/lists\/list_a\/stocks$/, (request) => {
			const symbol = (request.body as { symbol?: unknown }).symbol;
			if (symbol === "MSFT") {
				return errorResponse(500, "INTERNAL", "boom");
			}
			server.lists = server.lists.map((entry) => ({
				...entry,
				stockIds: [...entry.stockIds, `us:${String(symbol)}`],
				version: entry.version + 1,
			}));
			return jsonResponse(watchlistBody());
		});
		await mount();
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Add stocks to Semis" }));
		const dialog = await screen.findByRole("dialog", { name: "Add stocks to Semis" });
		for (const box of within(dialog).getAllByRole("checkbox")) fireEvent.click(box);
		fireEvent.click(within(dialog).getByRole("button", { name: "Add 3 stocks to list" }));
		const alert = await within(dialog).findByRole("alert");
		expect(alert.textContent).toContain("MSFT was not added to the list.");
		await waitFor(() => expect(status()).toBe("Added AAPL to Semis."));
		// The dialog stays open and offers only what is not in the list now.
		await waitFor(() =>
			expect(
				within(dialog)
					.getAllByRole("checkbox")
					.map((box) => box.getAttribute("data-stock-id")),
			).toEqual(["us:MSFT", "us:NVDA"]),
		);
	});

	it("queues the earnings dates of a searched stock the watchlist took although its list insert was refused", async () => {
		server.lists = [list()];
		backend.on("POST", /^\/api\/v1\/watchlist\/lists\/list_a\/stocks$/, () => {
			// A lost race: the stock reached the watchlist, then the list was full.
			server.stocks = [
				...server.stocks,
				makeStock({
					stockId: "jp:7203",
					market: "JP",
					symbol: "7203",
					lastRefreshedAt: null,
					retrievedAt: null,
					events: [],
				}),
			];
			return errorResponse(
				400,
				"VALIDATION_FAILED",
				"At most 12 stocks per list.",
				"WATCHLIST_LIST_FULL",
			);
		});
		await mount();
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Add stocks to Semis" }));
		const dialog = await screen.findByRole("dialog", { name: "Add stocks to Semis" });
		fireEvent.input(within(dialog).getByRole("combobox", { name: "Search stocks" }), {
			target: { value: "toyota" },
		});
		const listbox = await within(dialog).findByRole("listbox", { name: "Matching stocks" });
		const toyota = within(listbox)
			.getAllByRole("option")
			.find((option) => option.getAttribute("data-stock-id") === "jp:7203");
		if (toyota === undefined) throw new Error("no 7203 option");
		fireEvent.click(toyota);
		fireEvent.click(within(dialog).getByRole("button", { name: "Add 1 stock to list" }));
		expect((await within(dialog).findByRole("alert")).textContent).toContain(
			"7203 was not added to the list. This list is full",
		);
		await waitFor(() =>
			expect(backend.requestsTo("POST", /\/watchlist\/refresh$/).map((r) => r.body)).toEqual([
				{ scope: "unrefreshed" },
			]),
		);
		expect(
			await screen.findByText(
				"7203 was added to the watchlist but not to Semis. Its earnings dates are being fetched by the local runner.",
			),
		).toBeTruthy();
	});

	it("sends nothing when a rename keeps the title", async () => {
		server.lists = [list()];
		await mount();
		openListMenu("Semis", "Rename…");
		const rename = await screen.findByRole("dialog", { name: "Rename Semis" });
		fireEvent.click(within(rename).getByRole("button", { name: "Save" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(backend.requestsTo("PATCH", /\/watchlist\/lists\//)).toHaveLength(0);
	});

	it("disables Add stock on a full list and New list at 20 lists, and says why", async () => {
		const many = Array.from({ length: 12 }, (_, index) =>
			makeStock({ stockId: `us:S${index}`, symbol: `S${index}`, name: `Stock ${index}` }),
		);
		server.stocks = many;
		server.lists = Array.from({ length: 20 }, (_, index) =>
			list({
				listId: `list_${index}`,
				title: `List ${index}`,
				stockIds: index === 0 ? many.map((stock) => stock.stockId) : [],
			}),
		);
		const section = await mount();
		const add = within(card("List 0")).getByRole("button", { name: "Add stocks to List 0" });
		expect(add.hasAttribute("disabled")).toBe(true);
		expect(card("List 0").textContent).toContain(
			"This list is full: a list holds at most 12 stocks.",
		);
		expect(card("List 0").textContent).toContain("12 of 12 stocks");
		const newList = within(section).getByRole("button", { name: "New list" });
		expect(newList.hasAttribute("disabled")).toBe(true);
		expect(section.textContent).toContain(
			"You have 20 lists, the most there can be. Delete one to make another.",
		);
	});

	it("words a refused write by its stable reason and keeps the dialog's text", async () => {
		backend.on("POST", /^\/api\/v1\/watchlist\/lists$/, () =>
			errorResponse(400, "VALIDATION_FAILED", "At most 20 lists.", "WATCHLIST_LISTS_FULL"),
		);
		const section = await mount();
		fireEvent.click(within(section).getByRole("button", { name: "New list" }));
		const dialog = await screen.findByRole("dialog", { name: "New list" });
		const title = within(dialog).getByRole("textbox", { name: "Title" });
		fireEvent.input(title, { target: { value: "Banks" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Create list" }));
		const alert = await within(dialog).findByRole("alert");
		expect(alert.textContent).toContain(
			"You have 20 lists, the most there can be. Delete one to make another.",
		);
		expect(alert.textContent).toContain("WATCHLIST_LISTS_FULL");
		expect((title as HTMLInputElement).value).toBe("Banks");
	});

	it("re-reads the lists when one changed elsewhere", async () => {
		server.lists = [list({ stockIds: ["us:AAPL"] })];
		await mount();
		// Another tab deleted the list.
		server.lists = [];
		fireEvent.click(within(card("Semis")).getByRole("button", { name: "Remove AAPL from Semis" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain(
			"The list or the stock changed elsewhere, so the page now shows the current lists.",
		);
		await waitFor(() => expect(screen.queryByRole("listitem", { name: "List: Semis" })).toBeNull());
	});

	it("says how many lists a stock leaves when it is removed from the watchlist", async () => {
		server.lists = [
			list({ stockIds: ["us:AAPL"] }),
			list({ listId: "list_b", title: "Big tech", stockIds: ["us:MSFT", "us:AAPL"] }),
		];
		await mount();
		const table = screen.getByRole("table", { name: TABLE_NAME });
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain(
			"In lists: Semis and Big tech",
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove AAPL" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Also removes it from 2 lists.");
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove stock" }));
		await waitFor(() =>
			expect(within(card("Semis")).getByText("No stocks in this list yet.")).toBeTruthy(),
		);
		expect(card("Big tech").textContent).toContain("1 of 12 stocks");
		// One list: the singular.
		fireEvent.click(screen.getByRole("button", { name: "Remove MSFT" }));
		const second = await screen.findByRole("dialog");
		expect(second.textContent).toContain("Also removes it from 1 list.");
		fireEvent.click(within(second).getByRole("button", { name: "Cancel" }));
		// A stock in no list says nothing about lists.
		server.stocks = [...server.stocks, makeStock({ stockId: "us:NVDA", symbol: "NVDA" })];
		fireEvent.click(screen.getByRole("button", { name: "Refresh earnings dates" }));
		fireEvent.click(await screen.findByRole("button", { name: "Remove NVDA" }));
		const third = await screen.findByRole("dialog");
		expect(third.querySelector('[data-field="remove-leaves-lists"]')).toBeNull();
	});

	describe("Show on Home (ADR-0040 §6)", () => {
		let home: HomeServerState;
		beforeEach(() => {
			home = initialHomeServerState(false);
			installHomeRoutes(backend, initialServerState(), home);
		});

		it("appends a Watchlist prices widget once, then says it is already there", async () => {
			server.lists = [list()];
			await mount();
			const before = home.dashboard.widgets.length;
			openListMenu("Semis", "Show on Home");
			await waitFor(() => expect(status()).toBe("Added Semis to Home."));
			const puts = backend.requestsTo("PUT", /\/home\/dashboard$/);
			expect(puts).toHaveLength(1);
			const saved = putHomeDashboardRequestSchema.parse(puts[0]?.body).dashboard.widgets;
			expect(saved).toHaveLength(before + 1);
			expect(saved.at(-1)).toMatchObject({
				type: "watchlist-prices",
				listId: "list_a",
				title: "Semis",
				size: "medium",
			});

			openListMenu("Semis", "Show on Home");
			await waitFor(() => expect(status()).toBe("Semis is already on Home."));
			expect(backend.requestsTo("PUT", /\/home\/dashboard$/)).toHaveLength(1);
		});

		it("says when Home holds no more widgets", async () => {
			server.lists = [list()];
			home.dashboard = {
				schemaVersion: 2,
				widgets: Array.from({ length: 24 }, (_, index) => ({
					widgetId: `w-${index}`,
					type: "text" as const,
					title: `Note ${index}`,
					size: "small" as const,
					text: "x",
				})),
			};
			await mount();
			openListMenu("Semis", "Show on Home");
			await waitFor(() => expect(status()).toMatch(/^Home already holds \d+ widgets/));
			expect(backend.requestsTo("PUT", /\/home\/dashboard$/)).toHaveLength(0);
		});
	});

	it("speaks Japanese", async () => {
		server.lists = [
			list({ stockIds: ["us:AAPL"] }),
			list({ listId: "list_b", title: "Big tech", stockIds: ["us:MSFT"] }),
			list({ listId: "list_c", title: "Mega", stockIds: ["us:MSFT"] }),
		];
		const section = await mount("ja");
		expect(within(section).getByRole("button", { name: "新しいリスト" })).toBeTruthy();
		const item = screen.getByRole("listitem", { name: "リスト：Semis" });
		expect(item.textContent).toContain("1 / 12 銘柄");
		expect(within(item).getByRole("button", { name: "AAPL を Semis から外す" })).toBeTruthy();
		expect(within(item).getByRole("button", { name: "Semis に銘柄を追加" })).toBeTruthy();
		const inLists = [...document.querySelectorAll('[data-field="stock-in-lists"]')].map(
			(element) => element.textContent,
		);
		// Joined the Japanese way.
		expect(inLists).toEqual(["リスト：Semis", "リスト：Big tech、Mega"]);
	});
});
