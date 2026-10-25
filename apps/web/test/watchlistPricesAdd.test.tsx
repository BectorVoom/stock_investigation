import { type HomeWidget, putHomeDashboardRequestSchema } from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type HomeServerState,
	initialHomeServerState,
	initialServerState,
	initialWatchlistServerState,
	installHomeRoutes,
	installWatchlistRoutes,
	mountApp,
	type WatchlistServerState,
} from "./appHarness.tsx";
import { createFakeBackend, type FakeBackend } from "./fakeBackend.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import { makeStock } from "./watchlistHarness.ts";

let backend: FakeBackend;
let home: HomeServerState;
let watch: WatchlistServerState;

/** AAPL and MSFT have Home fixture series; AMD has none yet. */
function freshBackend(lists = true): void {
	backend = createFakeBackend();
	home = initialHomeServerState(false);
	installHomeRoutes(backend, initialServerState(), home);
	watch = initialWatchlistServerState();
	watch.stocks = [
		makeStock(),
		makeStock({ stockId: "us:MSFT", symbol: "MSFT", name: "Microsoft Corp" }),
		makeStock({ stockId: "us:AMD", symbol: "AMD", name: "Advanced Micro Devices" }),
	];
	watch.lists = lists
		? [
				{
					listId: "list_big",
					title: "Big tech",
					stockIds: ["us:AAPL", "us:MSFT"],
					version: 1,
					createdAt: "2026-10-12T00:00:00Z",
					updatedAt: "2026-10-12T00:00:00Z",
				},
				{
					listId: "list_chips",
					title: "Chips",
					stockIds: ["us:AMD"],
					version: 1,
					createdAt: "2026-10-12T00:00:00Z",
					updatedAt: "2026-10-12T00:00:00Z",
				},
			]
		: [];
	installWatchlistRoutes(backend, watch);
	window.location.hash = "#/home";
}

beforeEach(() => {
	// Home's fixtures are fresh at this time, so Home queues no auto-refresh of its own.
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:00:00Z"));
	resetGlobalFetchCalls();
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

const homePuts = () => backend.requestsTo("PUT", /\/home\/dashboard$/);
const refreshes = () => backend.requestsTo("POST", /\/home\/refresh$/);

function lastSavedWidgets(): readonly HomeWidget[] {
	const put = homePuts().at(-1);
	if (put === undefined) throw new Error("nothing was saved");
	return putHomeDashboardRequestSchema.parse(put.body).dashboard.widgets;
}

function frames(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

async function openListDialog(): Promise<HTMLElement> {
	await waitFor(() => expect(frames()).toHaveLength(7), { timeout: 10_000 });
	fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
	fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: "Watchlist prices" }));
	return screen.findByRole("dialog", { name: "Choose a list" });
}

describe("adding a Watchlist prices widget on Home (ADR-0040 §6)", () => {
	it("lists the lists with their counts and places the chosen one, with no Edit…", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openListDialog();
		const list = await within(dialog).findByRole("list", { name: "Your Watchlist lists" });
		const choices = within(list).getAllByRole("button");
		expect(choices.map((choice) => choice.textContent)).toEqual([
			"Big tech2 stocks",
			"Chips1 stock",
		]);
		await waitFor(() => expect(document.activeElement).toBe(choices[0]));
		fireEvent.click(choices[0] ?? list);
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(lastSavedWidgets().at(-1)).toMatchObject({
			type: "watchlist-prices",
			listId: "list_big",
			title: "Big tech",
			size: "medium",
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(frames()).toHaveLength(8));
		const frame = frames().at(-1);
		if (frame === undefined) throw new Error("expected the new widget");
		// The rows read Home's series: AAPL's and MSFT's fixture closes.
		await waitFor(() => expect(frame.textContent).toContain("336.64"));
		expect(frame.textContent).toContain("535.07");
		// Both series have data: nothing is queued.
		expect(refreshes()).toHaveLength(0);
		const actions = frame.querySelector("button[data-widget-actions]");
		if (!(actions instanceof HTMLElement)) throw new Error("no widget actions button");
		fireEvent.click(actions);
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).not.toContain("Edit…");
	});

	it("queues one refresh of the unrefreshed series when the chosen list's stock has no data", async () => {
		freshBackend();
		mountApp(backend);
		const dialog = await openListDialog();
		const list = await within(dialog).findByRole("list", { name: "Your Watchlist lists" });
		fireEvent.click(within(list).getByRole("button", { name: /^Chips/ }));
		await waitFor(() => expect(refreshes()).toHaveLength(1));
		expect(refreshes()[0]?.body).toEqual({ scope: "unrefreshed" });
	});

	it("asks nothing for a list stock whose series the provider refused", async () => {
		freshBackend();
		const aapl = home.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		if (aapl === undefined) throw new Error("no AAPL fixture");
		// AMD's series is stored, refused by the provider: it has its answer.
		home.series = [
			...home.series,
			{
				...aapl,
				seriesId: "twelve-data:AMD",
				symbol: "AMD",
				title: "AMD",
				observations: [],
				unavailable: {
					code: "SERIES_NOT_FOUND",
					reason: "The provider has no data for this symbol.",
					upstreamStatus: 404,
				},
			},
		];
		mountApp(backend);
		const dialog = await openListDialog();
		const list = await within(dialog).findByRole("list", { name: "Your Watchlist lists" });
		fireEvent.click(within(list).getByRole("button", { name: /^Chips/ }));
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		await waitFor(() => expect(frames()).toHaveLength(8));
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(refreshes()).toHaveLength(0);
		expect(frames().at(-1)?.textContent).toContain("unavailable");
	});

	it("with no lists, says so and links to the Watchlist page", async () => {
		freshBackend(false);
		mountApp(backend);
		const dialog = await openListDialog();
		expect(await within(dialog).findByText("You have no Watchlist lists yet.")).toBeTruthy();
		expect(
			within(dialog)
				.getByRole("link", { name: "Make one on the Watchlist page" })
				.getAttribute("href"),
		).toBe("#/watchlist");
		expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
	});
});

describe("Home with a Watchlist prices widget (ADR-0040 §4)", () => {
	it("loads the watchlist, and its first automatic refresh includes the list's series", async () => {
		freshBackend();
		home.dashboard = {
			schemaVersion: 2,
			widgets: [
				...home.dashboard.widgets,
				{
					widgetId: "w-chips",
					type: "watchlist-prices",
					title: "Chips",
					size: "medium",
					listId: "list_chips",
				},
			],
		};
		mountApp(backend);
		await waitFor(() => expect(frames()).toHaveLength(8), { timeout: 10_000 });
		// Every named series is fresh; AMD (in the list) was never refreshed.
		await waitFor(() => expect(refreshes()).toHaveLength(1));
		expect(refreshes()[0]?.body).toEqual({ scope: "unrefreshed" });
		expect(backend.requestsTo("GET", /^\/api\/v1\/watchlist$/).length).toBeGreaterThan(0);
		const frame = frames().at(-1);
		if (frame === undefined) throw new Error("expected the widget");
		expect(frame.textContent).toContain("Chips");
		expect(frame.textContent).toContain("AMD");
	});
});

describe("Home follows a list changed elsewhere (ADR-0040 §4)", () => {
	it("re-reads its data once when the watchlist poll shows a list stock the data does not name", async () => {
		freshBackend();
		watch.lists = watch.lists.map((entry) =>
			entry.listId === "list_big" ? { ...entry, stockIds: ["us:AAPL"] } : entry,
		);
		// An earnings run keeps Home polling the watchlist (2.5 s while leased).
		watch.activeRunId = "run_earnings_0";
		watch.runState = "leased";
		home.dashboard = {
			schemaVersion: 2,
			widgets: [
				...home.dashboard.widgets,
				{
					widgetId: "w-big",
					type: "watchlist-prices",
					title: "Big tech",
					size: "medium",
					listId: "list_big",
				},
			],
		};
		mountApp(backend);
		await waitFor(() => expect(frames()).toHaveLength(8), { timeout: 10_000 });
		await waitFor(() => expect(frames().at(-1)?.textContent).toContain("336.64"));
		const dataReads = () => backend.requestsTo("GET", /^\/api\/v1\/home\/data/).length;
		await new Promise((resolve) => setTimeout(resolve, 300));
		const before = dataReads();
		// Another tab adds INTC (no Home series yet) to the list.
		watch.stocks = [
			...watch.stocks,
			makeStock({ stockId: "us:INTC", symbol: "INTC", name: "Intel Corp" }),
		];
		watch.lists = watch.lists.map((entry) =>
			entry.listId === "list_big"
				? { ...entry, stockIds: [...entry.stockIds, "us:INTC"], version: entry.version + 1 }
				: entry,
		);
		await waitFor(() => expect(frames().at(-1)?.textContent).toContain("INTC"), {
			timeout: 10_000,
		});
		await waitFor(() => expect(dataReads()).toBe(before + 1));
		// The data still does not name INTC: no second read for the same series set.
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		expect(dataReads()).toBe(before + 1);
	}, 20_000);
});
