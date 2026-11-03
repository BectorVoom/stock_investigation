import {
	HOME_WIDGET_TYPES,
	type HomeDashboard,
	type MarketSeries,
	WIDGET_TYPE_META,
} from "@research/contracts";
import { WIDGET_BODY_CLASS, WidgetFrame } from "@research/widget-grid";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { MetricWidget } from "../src/home/widgets/MetricWidget.tsx";
import { resetWidgetClipboard, widgetClipboard } from "../src/widgets/widgetClipboard.ts";
import {
	HOME_CATALOG,
	type HomeServerState,
	initialHomeServerState,
	initialServerState,
	initialWatchlistServerState,
	installHomeRoutes,
	installWatchlistRoutes,
	mountApp,
	type ServerState,
	type WatchlistServerState,
} from "./appHarness.tsx";
import {
	createControllableVisibility,
	createFakeBackend,
	deferred,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import { lastOpenMenu } from "./openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import { makeTask } from "./tasks/tasksHarness.ts";

let backend: FakeBackend;
let server: ServerState;
let home: HomeServerState;
let watch: WatchlistServerState;

function freshBackend(stale: boolean): void {
	backend = createFakeBackend();
	server = initialServerState();
	home = initialHomeServerState(stale);
	installHomeRoutes(backend, server, home);
	watch = initialWatchlistServerState();
	installWatchlistRoutes(backend, watch);
	window.location.hash = "#/home";
}

/** One watchlist stock; fresh stamps unless overridden (fresh queues no auto-refresh). */
function watchStock(
	overrides: Partial<WatchlistServerState["stocks"][number]> = {},
): WatchlistServerState["stocks"][number] {
	return {
		stockId: "us:AAPL",
		market: "US",
		symbol: "AAPL",
		name: "Apple Inc",
		addedAt: "2026-10-12T00:00:00Z",
		source: "finnhub",
		publisher: "Finnhub",
		sourceUrl: "https://finnhub.io/",
		lastRefreshedAt: "2026-10-12T11:50:00Z",
		retrievedAt: "2026-10-12T11:50:00Z",
		unavailable: null,
		events: [],
		...overrides,
	};
}

/** The default dashboard plus one earnings-calendar widget. */
function withCalendarWidget(): void {
	home.dashboard = {
		schemaVersion: 2,
		widgets: [
			...home.dashboard.widgets,
			{
				type: "earnings-calendar",
				widgetId: "w-cal",
				title: "Earnings",
				size: "large",
				daysAhead: 90,
			},
		],
	};
}

beforeEach(() => {
	// Pinned visit time: the fresh fixtures (11:50) are 10 minutes old, so no
	// auto-refresh fires unless the test asks for stale data.
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:00:00Z"));
	resetGlobalFetchCalls();
	freshBackend(false);
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	vi.restoreAllMocks();
	vi.useRealTimers();
	// The API client always goes through the injected fake backend: any other
	// global fetch (e.g. a component reaching the network, or happy-dom's
	// default localhost:3000 origin) fails here instead of silently.
	assertOnlyIconFetches();
});

/**
 * Advances fake time until `ready()` holds. The poller, the client timeout
 * race and Lit all run on `setTimeout`, so fake timers make poll-driven
 * behaviour deterministic instead of wall-clock driven. Throws instead of
 * hanging when the condition never holds.
 */
async function settleUntil(ready: () => boolean, label: string, maxMs = 30_000): Promise<void> {
	let elapsed = 0;
	const stepMs = 250;
	while (elapsed < maxMs) {
		if (ready()) return;
		await vi.advanceTimersByTimeAsync(stepMs);
		elapsed += stepMs;
	}
	if (ready()) return;
	throw new Error(`gave up waiting: ${label}`);
}

/** Fake timers for poll-driven tests. `Date` stays real (pinned by `beforeEach`). */
function usePollTimers(): void {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
}

function homeStatus(): string {
	return document.querySelector('[data-field="home-status"]')?.textContent ?? "";
}

function widgets(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

function widgetById(id: string): HTMLElement {
	const article = document.querySelector(`article[data-widget-id="${id}"]`);
	if (!(article instanceof HTMLElement)) throw new Error(`widget ${id} is missing`);
	return article;
}

/** Sets a Shoelace control's value and notifies its `sl-*` listener, without touching shadow DOM. */
function setShoelaceValue(
	element: Element,
	value: string | readonly string[],
	event: string,
): void {
	Object.assign(element, { value });
	element.dispatchEvent(new Event(event, { bubbles: true }));
}

function dialogOrThrow(): HTMLElement {
	const dialog = document.querySelector("sl-dialog");
	if (!(dialog instanceof HTMLElement)) throw new Error("the widget dialog did not open");
	return dialog;
}

function dialogControl(dialog: HTMLElement, tag: string, label: string): HTMLElement {
	const controls = [...dialog.querySelectorAll(tag)];
	const found = controls.find((control) => control.getAttribute("label") === label);
	if (!(found instanceof HTMLElement)) throw new Error(`dialog has no ${tag} labelled ${label}`);
	return found;
}

/** The widget's icon-only actions button ("<title> actions"). */
function widgetActionsButton(article: HTMLElement): HTMLElement {
	const button = article.querySelector("button[data-widget-actions]");
	if (!(button instanceof HTMLElement)) throw new Error("no widget actions button");
	return button;
}

/** Opens the widget menu and clicks the named menuitem. */
async function chooseWidgetMenuItem(widgetId: string, itemName: string): Promise<void> {
	const article = widgetById(widgetId);
	fireEvent.click(widgetActionsButton(article));
	const item = await waitFor(() =>
		within(lastOpenMenu()).getByRole("menuitem", { name: itemName }),
	);
	fireEvent.click(item);
}

/** Opens the widget menu and returns the named menuitem without clicking it. */
async function openWidgetMenuItem(widgetId: string, itemName: string): Promise<HTMLElement> {
	const article = widgetById(widgetId);
	fireEvent.click(widgetActionsButton(article));
	return waitFor(() => within(lastOpenMenu()).getByRole("menuitem", { name: itemName }));
}

/** A native footer button of the widget dialog, found by its accessible name. */
function dialogButton(dialog: HTMLElement, name: string): HTMLElement {
	return within(dialog).getByRole("button", { name });
}

/** Opens the add menu and picks a type; synchronous, so it also runs under fake timers. */
function chooseAddType(typeLabel = "Market metric"): void {
	fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
	fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: typeLabel }));
}

/** The add menu (ADR-0024): the type is chosen there, then its dialog opens. */
async function openAddDialog(typeLabel = "Market metric"): Promise<HTMLElement> {
	fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
	const item = await waitFor(() =>
		within(lastOpenMenu()).getByRole("menuitem", { name: typeLabel }),
	);
	fireEvent.click(item);
	await waitFor(() => {
		if (document.querySelector("sl-dialog") === null) throw new Error("dialog is not open yet");
	});
	return dialogOrThrow();
}

const homePuts = () => backend.requestsTo("PUT", /\/home\/dashboard$/);
const homeDataGets = () => backend.requestsTo("GET", /\/home\/data/);

/** The calendar widget's text, empty until it renders. */
function calendarText(): string {
	return document.querySelector('article[data-widget-id="w-cal"]')?.textContent ?? "";
}

/** Every refresh the SPA could ask for: the server syncs on its own, so there must be none. */
const refreshPosts = () => backend.requestsTo("POST", /\/(home|watchlist)\/refresh$/);

/** The server started a market sync of its own (the runner claimed it). */
function startServerSync(runId = "run_market_1", state = "leased"): void {
	home.activeRunId = runId;
	home.runState = state;
}

/** The server's market sync ended well at `at`. */
function endServerSync(at = "2026-10-12T12:05:00Z"): void {
	home.activeRunId = null;
	home.lastSucceededAt = at;
}

describe("home view", () => {
	it("is the default landing page with every default widget showing unit, as-of and source", async () => {
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });

		const vix = widgetById("w-vix");
		expect(vix.textContent).toContain("15.41");
		expect(vix.textContent).toContain("Index");
		expect(vix.textContent).toContain("2026-10-08");
		expect(vix.textContent).toContain("Federal Reserve Bank of St. Louis (FRED)");
		// Three days of history: no value a month earlier, so no 前月比 (ADR-0069)
		// rather than a 1-day change (home.ja.test.tsx shows one with a base).
		expect(vix.textContent).toContain("1-month change: unavailable (needs more history)");
		expect(vix.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");

		const gold = widgetById("w-gold");
		expect(gold.textContent).toContain("4,168.44");
		expect(gold.textContent).toContain("$ per XAU (troy ounce of gold)");

		const dgs10 = widgetById("w-dgs10");
		expect(dgs10.textContent).toContain("4.18 %");

		const watchlist = widgetById("w-watchlist");
		const table = within(watchlist).getByRole("table", { name: /Watchlist/ });
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain("336.64");
		expect(within(table).getByRole("columnheader", { name: "1-day change %" })).toBeDefined();
		expect(table.querySelector("th[scope='row']")).not.toBeNull();
		// AAPL fell (340.42 → 336.64): its signed change and percent are red.
		const aaplFall = within(within(table).getByRole("row", { name: /AAPL/ }))
			.getAllByRole("cell")
			.flatMap((cell) => [...cell.querySelectorAll("span")])
			.filter((span) => span.textContent?.startsWith("-"));
		expect(aaplFall.map((span) => [span.textContent, span.className])).toEqual([
			["-3.78 $", "text-red-700"],
			["-1.11%", "text-red-700"],
		]);

		const economy = widgetById("w-us-economy");
		expect(within(economy).getByRole("table", { name: /US economy/ }).textContent).toContain(
			"Unemployment Rate",
		);

		const chart = widgetById("w-vix-chart");
		expect(chart.querySelector("svg[role='img']")?.getAttribute("aria-label")).toContain(
			"Line chart: VIX",
		);
		// One series needs no legend; multi-series charts name every series (see below).

		expect(document.body.textContent).toContain(
			"This product uses the FRED® API but is not endorsed or certified",
		);
		expect(homeStatus()).toContain("No market-data refresh has completed yet.");
		expect(refreshPosts()).toHaveLength(0);
	});

	it("D1: a month-earlier value of 0 renders as 0, not as unavailable", async () => {
		const t10y2y = home.series.find((entry) => entry.seriesId === "fred:T10Y2Y");
		if (t10y2y === undefined) throw new Error("T10Y2Y fixture is missing");
		// The 1-month change's base is the newest observation on or before
		// 2026-09-08 (2026-10-08 − 1 month): the 0 of that day.
		t10y2y.observations = [
			["2026-09-08", 0],
			["2026-10-07", 0.02],
			["2026-10-08", 0.05],
		];
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const economy = widgetById("w-us-economy");
		const table = within(economy).getByRole("table", { name: /US economy/ });
		const row = within(table).getByRole("row", { name: /10-Year Treasury Minus/ });
		// Cells: th, Latest value, As of, 1 month earlier, 1-month change, 1-year change, Trend, Source.
		const cells = within(row).getAllByRole("cell");
		expect(cells).toHaveLength(7);
		// Each value carries its unit; the 1 month earlier column holds the real 0
		// (formatValue(0) is "0"), never "unavailable (...)".
		expect(cells[0]?.textContent).toBe("0.05 %");
		expect(cells[2]?.textContent).toBe("0 %");
		expect(cells[2]?.textContent).not.toContain("unavailable");
	});

	it("D3: the chart data-table twin shows the bare date under the Date header", async () => {
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const chart = widgetById("w-vix-chart");
		const twin = within(chart).getByRole("table", { name: /Values plotted/ });
		const rowHeaders = twin.querySelectorAll("tbody th[scope='row']");
		expect(rowHeaders.length).toBeGreaterThan(0);
		for (const header of rowHeaders) {
			expect(header.textContent).not.toContain("as of");
			expect(header.querySelector("time")).not.toBeNull();
		}
	});

	it("shows no unfinished-session note on Twelve Data widgets", async () => {
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const watchlist = widgetById("w-watchlist");
		expect(within(watchlist).getByRole("columnheader", { name: "Last close" })).toBeDefined();
		expect(watchlist.textContent).not.toContain("unfinished session");
		expect(widgetById("w-gold").textContent).not.toContain("unfinished session");
	});

	it("has no composer, message list, run status or canvas region", async () => {
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		expect(screen.queryByRole("form", { name: "Research composer" })).toBeNull();
		expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Canvas" })).toBeNull();
		expect(document.querySelector("[data-run-state]")).toBeNull();
	});

	it("opens Home for an empty hash", async () => {
		window.location.hash = "";
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
	});

	it("re-reads idle data every minute and follows a sync the server started until it ends", async () => {
		usePollTimers();
		try {
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			const getsAtLoad = homeDataGets().length;
			// Nothing runs: no data GET until the minute is up.
			await vi.advanceTimersByTimeAsync(59_000);
			expect(homeDataGets()).toHaveLength(getsAtLoad);
			// Meanwhile the server started a sync of its own.
			startServerSync();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(homeDataGets().length).toBeGreaterThan(getsAtLoad);
			// A conditional re-read: it sends the ETag it holds.
			expect(homeDataGets()[getsAtLoad]?.headers["if-none-match"]).toMatch(/^"home-/);
			await settleUntil(() => homeStatus().includes("Refreshing market data…"), "sync shown");
			expect(homeStatus()).toContain("run_market_1");
			expect(homeStatus()).toContain("stays queued until the runner reconnects");

			// The fast poller follows the sync to its end and the new numbers show.
			const vix = home.series.find((entry) => entry.seriesId === "fred:VIXCLS");
			if (vix === undefined) throw new Error("VIX fixture is missing");
			vix.observations = [...vix.observations, ["2026-10-09", 17.25]];
			vix.lastRefreshedAt = "2026-10-12T12:05:00Z";
			endServerSync();
			await settleUntil(
				() => homeStatus().includes("Last successful refresh: 2026-10-12 12:05 UTC"),
				"sync end observed",
			);
			expect(widgetById("w-vix").textContent).toContain("17.25");
			// Stopped means stopped: only the next minute's re-read follows.
			const getsAfterEnd = homeDataGets().length;
			await vi.advanceTimersByTimeAsync(55_000);
			expect(homeDataGets()).toHaveLength(getsAfterEnd);
			await vi.advanceTimersByTimeAsync(6_000);
			expect(homeDataGets()).toHaveLength(getsAfterEnd + 1);
			expect(refreshPosts()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a hidden page re-reads nothing and re-reads at once when it becomes visible", async () => {
		usePollTimers();
		try {
			const visibility = createControllableVisibility();
			mountApp(backend, visibility);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			visibility.setVisible(false);
			const getsHidden = homeDataGets().length;
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			expect(homeDataGets()).toHaveLength(getsHidden);
			startServerSync();
			visibility.setVisible(true);
			await settleUntil(() => homeDataGets().length > getsHidden, "re-read on return");
			await settleUntil(() => homeStatus().includes("run_market_1"), "sync shown on return");
		} finally {
			vi.useRealTimers();
		}
	});

	it("never asks for a refresh: stale, never-fetched and ended-run data wait for the server", async () => {
		usePollTimers();
		try {
			freshBackend(true);
			home.series = home.series.map(
				(entry): MarketSeries =>
					entry.seriesId === "fred:DGS10"
						? {
								...entry,
								observations: [],
								lastRefreshedAt: null,
								retrievedAt: null,
								unavailable: {
									code: "NEVER_REFRESHED",
									upstreamStatus: null,
									reason: "No data has been refreshed yet; queue a refresh.",
								},
							}
						: entry,
			);
			withCalendarWidget();
			watch.stocks = [watchStock({ lastRefreshedAt: null, retrievedAt: null })];
			startServerSync("run_market_0", "leased");
			mountApp(backend);
			await settleUntil(() => widgets().length === 8, "initial widgets");
			await settleUntil(() => homeStatus().includes("run_market_0"), "sync shown");
			// The run ends with the data still stale and one series still empty.
			home.activeRunId = null;
			await settleUntil(() => !homeStatus().includes("run_market_0"), "run end observed");
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			expect(refreshPosts()).toHaveLength(0);
			// The re-reads keep coming, and they are only GETs.
			expect(homeDataGets().length).toBeGreaterThan(10);
		} finally {
			vi.useRealTimers();
		}
	});

	it("V1: one failed poll neither stops polling nor wedges the status", async () => {
		usePollTimers();
		try {
			startServerSync();
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			await settleUntil(() => homeStatus().includes("run_market_1"), "run id in status");
			const getsDuringRun = homeDataGets().length;
			// The next poll 500s while the run is still active.
			home.dataFailures = 1;
			await settleUntil(() => homeDataGets().length > getsDuringRun, "failed poll went out");
			// Still refreshing (not wedged, not stopped): later polls continue…
			expect(homeStatus()).toContain("Refreshing market data…");
			await settleUntil(
				() => homeDataGets().length > getsDuringRun + 1,
				"polling continued after the failure",
			);
			// …until the run really ends.
			endServerSync();
			await settleUntil(
				() => homeStatus().includes("Last successful refresh:"),
				"run end observed",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("V2: an unreadable dashboard shows the error state, and Reset is the way out", async () => {
		home.dashboardUnreadable = true;
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() =>
			expect(document.body.textContent ?? "").toContain("Could not load the dashboard."),
		);
		expect(document.body.textContent).toContain("STORED_DASHBOARD_UNREADABLE");
		expect(document.body.textContent).not.toContain("Loading market widgets…");
		// The error state's own Reset (the toolbar one is disabled without a dashboard).
		const errorSection = document.querySelector('section[aria-label="Dashboard error"]');
		if (!(errorSection instanceof HTMLElement)) throw new Error("no dashboard error section");
		fireEvent.click(
			within(errorSection).getByRole("button", { name: "Reset to default arrangement" }),
		);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		expect(document.body.textContent).toContain("reset to the default arrangement");
	});

	it("V2: a failed data GET with no data is an error state, not a skeleton", async () => {
		home.dataFailures = 1;
		mountApp(backend);
		await screen.findByRole("heading", { level: 2, name: "Home" });
		await waitFor(() =>
			expect(document.body.textContent ?? "").toContain("Could not load market data."),
		);
		expect(document.body.textContent).not.toContain("Loading market data…");
		// Try again reloads: the failure is spent, so the widgets appear.
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
	});

	it("V3: an empty dashboard asks for nothing", async () => {
		usePollTimers();
		try {
			home.dashboard = { schemaVersion: 2, widgets: [] };
			home.series = [];
			mountApp(backend);
			expect(screen.getByRole("heading", { level: 2, name: "Home" })).toBeDefined();
			await settleUntil(
				() => (document.body.textContent ?? "").includes("No widgets yet."),
				"empty state",
			);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(refreshPosts()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("V5: navigating away stops the poller", async () => {
		usePollTimers();
		try {
			startServerSync();
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			await settleUntil(() => homeStatus().includes("run_market_1"), "run id in status");
			cleanup();
			const getsAtUnmount = homeDataGets().length;
			await vi.advanceTimersByTimeAsync(120_000);
			expect(homeDataGets()).toHaveLength(getsAtUnmount);
		} finally {
			vi.useRealTimers();
		}
	});

	it("V6: a pending run polls at the slow cadence, not every 2.5 s", async () => {
		usePollTimers();
		try {
			home.activeRunId = "run_market_9";
			home.runState = "pending";
			mountApp(backend);
			await settleUntil(() => homeStatus().includes("run_market_9"), "pending run in status");
			const getsAfterLoad = homeDataGets().length;
			// Fast cadence would poll again at 2.5 s; queued backoff waits longer.
			await vi.advanceTimersByTimeAsync(2_500);
			expect(homeDataGets()).toHaveLength(getsAfterLoad);
			await settleUntil(() => homeDataGets().length > getsAfterLoad, "slow poll went out");
		} finally {
			vi.useRealTimers();
		}
	});

	it("V7: the status line needs no extra run GET", async () => {
		usePollTimers();
		try {
			startServerSync("run_market_1", "pending");
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			await settleUntil(() => homeStatus().includes("run_market_1"), "run id in status");
			home.runState = "claimed";
			await settleUntil(
				() => homeStatus().includes("(claimed, run run_market_1)"),
				"claimed state in status",
			);
			expect(backend.requestsTo("GET", /\/research-runs\//)).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows unavailable with the fixed reason, naming the key to set", async () => {
		home.series = home.series.map((entry): MarketSeries => {
			if (entry.seriesId === "twelve-data:XAU/USD") {
				return {
					...entry,
					observations: [],
					lastRefreshedAt: "2026-10-12T11:50:00Z",
					retrievedAt: "2026-10-12T11:50:00Z",
					unavailable: {
						code: "SOURCE_NOT_CONFIGURED",
						upstreamStatus: null,
						reason:
							"The Twelve Data source is not configured; set TWELVE_DATA_API_KEY in apps/runner/.env.",
					},
				};
			}
			if (entry.seriesId === "fred:DGS10") {
				return {
					...entry,
					observations: [],
					lastRefreshedAt: null,
					retrievedAt: null,
					unavailable: {
						code: "NEVER_REFRESHED",
						upstreamStatus: null,
						reason: "No data has been refreshed yet; queue a refresh.",
					},
				};
			}
			return entry;
		});
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const gold = widgetById("w-gold");
		expect(gold.textContent).toContain("unavailable (The Twelve Data source is not configured");
		expect(gold.textContent).toContain("TWELVE_DATA_API_KEY");
		const dgs10 = widgetById("w-dgs10");
		// A never-fetched series says when its data comes, not to queue a refresh.
		expect(dgs10.textContent).toContain(
			"unavailable (No data yet; it appears after the next automatic refresh.",
		);
		expect(dgs10.textContent).not.toContain("queue a refresh");
	});

	it("adds a widget: the PUT carries the version and the page re-renders from the server copy", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const dialog = await openAddDialog();
		// The type was chosen in the add menu; the dialog names it and has no type select.
		expect(dialog.getAttribute("label")).toBe("Add market metric widget");
		expect(dialog.querySelector('sl-select[label="Widget type"]')).toBeNull();

		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Apple watch", "sl-input");
		expect(
			dialog.querySelector('ul[aria-label="Before you can save this widget"]')?.textContent,
		).toContain("Choose a series.");
		setShoelaceValue(dialogControl(dialog, "sl-select", "Series"), "twelve-data:AAPL", "sl-change");
		await waitFor(() => {
			if (dialog.querySelector('ul[aria-label="Before you can save this widget"]') !== null) {
				throw new Error("problems are still listed");
			}
		});
		fireEvent.click(dialogButton(dialog, "Add widget"));

		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(homePuts()[0]?.body).toEqual({
			dashboard: home.dashboard,
			expectedVersion: 0,
		});
		await waitFor(() => expect(widgets()).toHaveLength(8));
		expect(widgetById(home.dashboard.widgets[7]?.widgetId ?? "").textContent).toContain(
			"Apple watch",
		);
		await waitFor(() => expect(document.querySelector("sl-dialog")).toBeNull());
	});

	it("names sizes Small / Medium / Large and states each shape in the size help", async () => {
		const { WIDGET_SIZE_SHAPES } = await import("@research/widget-grid/core");
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const dialog = await openAddDialog();
		const size = dialogControl(dialog, "sl-select", "Size");
		expect(
			[...size.querySelectorAll("sl-option")].map((option) => option.textContent?.trim()),
		).toEqual(["Small", "Medium", "Large"]);
		const help = size.getAttribute("help-text") ?? "";
		expect(help).toContain(WIDGET_SIZE_SHAPES.small);
		expect(help).toContain(WIDGET_SIZE_SHAPES.medium);
		expect(help).toContain(WIDGET_SIZE_SHAPES.large);
	});

	it("F3: an untouched dialog explains itself in neutral tones, turning red after the first edit", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const dialog = await openAddDialog();
		const list = dialog.querySelector('ul[aria-label="Before you can save this widget"]');
		if (!(list instanceof HTMLElement)) throw new Error("no problems list on the fresh dialog");
		expect(list.textContent).toContain("Enter a title.");
		expect(list.textContent).toContain("Choose a series.");
		const box = list.parentElement;
		if (!(box instanceof HTMLElement)) throw new Error("no problems box");
		// Pristine: neutral slate notice with the "To add" lead.
		expect(box.textContent).toContain("To add this widget:");
		expect(box.className).toContain("bg-slate-50");
		expect(box.className).not.toContain("bg-red-50");
		// The save button still points at the list.
		const save = dialogButton(dialog, "Add widget");
		expect(save.getAttribute("aria-describedby")).toBe(list.id);
		// After the first edit the remaining problems turn red with the "Fix" lead.
		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Almost", "sl-input");
		await waitFor(() => expect(box.textContent).toContain("Fix before saving:"));
		expect(box.textContent).toContain("Choose a series.");
		expect(box.className).toContain("bg-red-50");
		expect(box.className).not.toContain("bg-slate-50");
		expect(save.getAttribute("aria-describedby")).toBe(list.id);
	});

	it("H1: a bubbling sl-after-hide from a nested select does not close the dialog", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const dialog = await openAddDialog();
		const nested = dialogControl(dialog, "sl-select", "Series");
		// A real browser bubbles the select listbox's sl-after-hide (composed)
		// up to the sl-dialog when an option is picked; the dialog must ignore it.
		nested.dispatchEvent(new Event("sl-after-hide", { bubbles: true, composed: true }));
		nested.dispatchEvent(new Event("sl-after-show", { bubbles: true, composed: true }));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(document.querySelector("sl-dialog")).not.toBeNull();
		// The dialog still works: setting values programmatically saves.
		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Still here", "sl-input");
		setShoelaceValue(dialogControl(dialog, "sl-select", "Series"), "twelve-data:AAPL", "sl-change");
		await waitFor(() => {
			if (dialog.querySelector('ul[aria-label="Before you can save this widget"]') !== null) {
				throw new Error("problems are still listed");
			}
		});
	});

	it("shows a legend naming every series on a multi-series chart", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const dialog = await openAddDialog("Line chart");
		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Two indices", "sl-input");
		setShoelaceValue(
			dialogControl(dialog, "sl-select", "Series"),
			["fred:VIXCLS", "fred:SP500"],
			"sl-change",
		);
		await waitFor(() => {
			if (dialog.querySelector('ul[aria-label="Before you can save this widget"]') !== null) {
				throw new Error("problems are still listed");
			}
		});
		fireEvent.click(dialogButton(dialog, "Add widget"));
		await waitFor(() => expect(widgets()).toHaveLength(8));
		const chart = widgetById(home.dashboard.widgets[7]?.widgetId ?? "");
		const legend = chart.querySelector('ul[aria-label="Legend"]');
		if (!(legend instanceof HTMLElement)) throw new Error("no chart legend");
		expect(legend.textContent).toContain("CBOE Volatility Index: VIX");
		expect(legend.textContent).toContain("S&P 500");
		expect(chart.querySelector("details")?.textContent).toContain("Data table: Two indices");
	});

	it("rejects a line chart whose series do not share one unit", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const dialog = await openAddDialog("Line chart");
		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Mixed", "sl-input");
		setShoelaceValue(
			dialogControl(dialog, "sl-select", "Series"),
			["fred:VIXCLS", "fred:DGS10"],
			"sl-change",
		);
		await screen.findByText(/must share one unit \(found: Index, Percent\)/);
		expect(dialogButton(dialog, "Add widget").hasAttribute("disabled")).toBe(true);
		expect(homePuts()).toHaveLength(0);
	});

	it("edits a widget title through the dialog", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await chooseWidgetMenuItem("w-vix", "Edit…");
		const dialog = await waitFor(() => dialogOrThrow());
		const title = dialogControl(dialog, "sl-input", "Title");
		setShoelaceValue(title, "Volatility gauge", "sl-input");
		fireEvent.click(dialogButton(dialog, "Save widget"));
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		await waitFor(() => expect(widgetById("w-vix").textContent).toContain("Volatility gauge"));
	});

	it("moves a widget earlier and later, with the ends disabled", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const order = () => widgets().map((article) => article.getAttribute("data-widget-id"));
		expect(order()[0]).toBe("w-vix");
		expect(await openWidgetMenuItem("w-vix", "Move earlier")).toHaveProperty("disabled", true);
		await chooseWidgetMenuItem("w-gold", "Move earlier");
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		await waitFor(() => expect(order()[0]).toBe("w-gold"));
		expect(order()[1]).toBe("w-vix");
	});

	it("removes a widget and persists it", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await chooseWidgetMenuItem("w-gold", "Remove");
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		await waitFor(() => expect(widgets()).toHaveLength(6));
		expect(document.querySelector('article[data-widget-id="w-gold"]')).toBeNull();
	});

	it("resets to the default arrangement only after confirmation", async () => {
		home.dashboard = {
			schemaVersion: 2,
			widgets: [home.dashboard.widgets[0]].filter(
				(widget): widget is (typeof home.dashboard.widgets)[number] => widget !== undefined,
			),
		};
		home.saved = true;
		home.version = 3;
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(1));
		fireEvent.click(screen.getByRole("button", { name: "Reset to default arrangement" }));
		const dialog = await waitFor(() => dialogOrThrow());
		expect(dialog.textContent).toContain("Undo restores the widgets you had");
		fireEvent.click(dialogButton(dialog, "Reset widgets"));
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(homePuts()[0]?.body).toMatchObject({ expectedVersion: 3 });
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
	});

	it("reloads and tells the owner on a version conflict", async () => {
		backend.on("PUT", /^\/api\/v1\/home\/dashboard$/, () =>
			errorResponse(409, "VERSION_CONFLICT", "The dashboard changed; reload and try again."),
		);
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await chooseWidgetMenuItem("w-gold", "Remove");
		await screen.findByText(/changed elsewhere; it was reloaded/);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
	});

	it("tables are semantic with captions and row headers", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		for (const id of ["w-watchlist", "w-us-economy"]) {
			const article = widgetById(id);
			const table = article.querySelector("table");
			if (!(table instanceof HTMLElement)) throw new Error(`no table in ${id}`);
			expect(table.querySelector("caption")).not.toBeNull();
			expect(table.querySelectorAll("th[scope='col']").length).toBeGreaterThan(0);
			expect(table.querySelector("th[scope='row']")).not.toBeNull();
		}
	});

	it("heads each table row with the series name and the symbol in monospace", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const watchlist = widgetById("w-watchlist");
		const table = within(watchlist).getByRole("table", { name: /Watchlist/ });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		const header = row.querySelector("th[scope='row']");
		if (!(header instanceof HTMLElement)) throw new Error("the AAPL row has no row header");
		expect(header.textContent).toContain("AAPL (NASDAQ)");
		expect(header.querySelector(".font-mono")?.textContent).toBe("AAPL");
		const economy = widgetById("w-us-economy");
		const economyTable = within(economy).getByRole("table", { name: /US economy/ });
		const cpiRow = within(economyTable).getByRole("row", { name: /Consumer Price Index/ });
		const cpiHeader = cpiRow.querySelector("th[scope='row']");
		if (!(cpiHeader instanceof HTMLElement)) throw new Error("the CPI row has no row header");
		expect(cpiHeader.textContent).toContain("Consumer Price Index");
		expect(cpiHeader.querySelector(".font-mono")?.textContent).toBe("CPIAUCSL");
	});

	it("heads each table row with the series name and the symbol in monospace", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const watchlist = widgetById("w-watchlist");
		const table = within(watchlist).getByRole("table", { name: /Watchlist/ });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		const header = row.querySelector("th[scope='row']");
		if (!(header instanceof HTMLElement)) throw new Error("the AAPL row has no row header");
		expect(header.textContent).toContain("AAPL (NASDAQ)");
		expect(header.querySelector(".font-mono")?.textContent).toBe("AAPL");
		const economy = widgetById("w-us-economy");
		const economyTable = within(economy).getByRole("table", { name: /US economy/ });
		const cpiRow = within(economyTable).getByRole("row", { name: /Consumer Price Index/ });
		const cpiHeader = cpiRow.querySelector("th[scope='row']");
		if (!(cpiHeader instanceof HTMLElement)) throw new Error("the CPI row has no row header");
		expect(cpiHeader.textContent).toContain("Consumer Price Index");
		expect(cpiHeader.querySelector(".font-mono")?.textContent).toBe("CPIAUCSL");
	});

	it("renders icon-only buttons: every toolbar and frame button has an accessible name and no visible text", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const main = document.querySelector("main");
		if (!(main instanceof HTMLElement)) throw new Error("no main content");
		const buttons = [...main.querySelectorAll("button")].filter(
			(button): button is HTMLButtonElement => button instanceof HTMLButtonElement,
		);
		expect(buttons.length).toBeGreaterThan(0);
		for (const button of buttons) {
			// The chart-viewer openers (ADR-0025) wrap real content — the plot,
			// the value block, a row name — so they are the exception to the
			// icon-only rule: their name is computed from that content after a
			// visually hidden "Open chart: " prefix, with no aria-label.
			if ((button.textContent ?? "").startsWith("Open chart:")) {
				expect(button.hasAttribute("aria-label")).toBe(false);
				continue;
			}
			expect(button.getAttribute("aria-label") ?? "").not.toBe("");
			expect(button.textContent?.trim() ?? "").toBe("");
		}
		// The former visible labels survive as accessible names.
		for (const name of ["Add widget", "Reset to default arrangement", "VIX actions"]) {
			expect(main.querySelector(`button[aria-label="${name}"]`)).not.toBeNull();
		}
		// The server syncs the data on its own: there is no Refresh button.
		expect(main.querySelector('button[aria-label="Refresh market data"]')).toBeNull();
	});

	it("scrolls tall bodies inside the frame in a keyboard-focusable container labelled by the widget title", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		for (const article of widgets()) {
			const title = article.querySelector("h3");
			if (!(title instanceof HTMLElement)) throw new Error("a widget has no title");
			expect(title.id).not.toBe("");
			const scroller = article.querySelector('div[tabindex="0"]');
			if (!(scroller instanceof HTMLElement)) throw new Error("a widget body is not focusable");
			expect(scroller.getAttribute("aria-labelledby")).toBe(title.id);
			// The scroll container is now styled by the package stylesheet
			// (`wg-body`), not the Tailwind `overflow-y-auto` utility: assert
			// the package class instead of the removed class name.
			expect(scroller.className).toContain("wg-body");
		}
	});

	it("V4: a saved edit reloads data, so new observations appear", async () => {
		usePollTimers();
		try {
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			// The server gains an observation the page has not loaded yet.
			const vix = home.series.find((entry) => entry.seriesId === "fred:VIXCLS");
			if (vix === undefined) throw new Error("no VIX series");
			vix.observations = [...vix.observations, ["2026-10-09", 16.02]];
			// Any save (here: moving a widget) reloads /home/data afterwards.
			await chooseWidgetMenuItem("w-gold", "Move earlier");
			await settleUntil(() => homePuts().length === 1, "PUT went out");
			const putIndex = backend.requests.length;
			await settleUntil(
				() => widgetById("w-vix").textContent?.includes("16.02") ?? false,
				"reloaded observation rendered",
			);
			expect(
				backend.requests.slice(putIndex).some((request) => /\/home\/data/.test(request.path)),
			).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("a widget added without data asks for nothing and is re-read within seconds until the server has it", async () => {
		usePollTimers();
		try {
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			const dialog = await (async () => {
				chooseAddType();
				await settleUntil(() => document.querySelector("sl-dialog") !== null, "dialog open");
				return dialogOrThrow();
			})();
			setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Extra", "sl-input");
			setShoelaceValue(dialogControl(dialog, "sl-select", "Series"), "fred:NEWFRED1", "sl-change");
			fireEvent.click(dialogButton(dialog, "Add widget"));
			await settleUntil(() => document.querySelector("sl-dialog") === null, "dialog saved");
			const putIndex = backend.requests.findIndex(
				(request) => request.method === "PUT" && /\/home\/dashboard$/.test(request.path),
			);
			await settleUntil(
				() => backend.requests.slice(putIndex).some((request) => /\/home\/data/.test(request.path)),
				"save reloaded data",
			);
			const getsAfterSave = homeDataGets().length;
			// The server fetches the new series at the runner's next claim: the
			// page looks again after about 5 seconds, not after a minute.
			await vi.advanceTimersByTimeAsync(4_000);
			expect(homeDataGets()).toHaveLength(getsAfterSave);
			await vi.advanceTimersByTimeAsync(1_500);
			expect(homeDataGets()).toHaveLength(getsAfterSave + 1);
			// The server's sync stores it; the next re-read shows it.
			const vix = home.series.find((entry) => entry.seriesId === "fred:VIXCLS");
			if (vix === undefined) throw new Error("no VIX series");
			home.series = [
				...home.series,
				{
					...vix,
					seriesId: "fred:NEWFRED1",
					symbol: "NEWFRED1",
					title: "New FRED series",
					observations: [
						["2026-10-08", 41.5],
						["2026-10-09", 42.42],
					],
					lastRefreshedAt: "2026-10-12T12:00:30Z",
				},
			];
			await settleUntil(
				() => (document.body.textContent ?? "").includes("42.42"),
				"new series rendered",
				20_000,
			);
			expect(refreshPosts()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("V8: while busy every action is impossible, and a dialog save waits for the save in flight", async () => {
		usePollTimers();
		try {
			// The PUT handler holds the request until the test releases it,
			// applying the sent dashboard like the default route would.
			const gate = deferred<Response>();
			let putBody: { dashboard: HomeDashboard; expectedVersion: number } | null = null;
			let released = false;
			backend.on("PUT", /^\/api\/v1\/home\/dashboard$/, (request) => {
				const sent = request.body as { dashboard: HomeDashboard; expectedVersion: number };
				if (!released) {
					putBody = sent;
					return gate.promise;
				}
				// Later PUTs (the queued dialog save) answer like the default route.
				home.dashboard = sent.dashboard;
				home.version += 1;
				return jsonResponse({
					dashboard: home.dashboard,
					version: home.version,
					updatedAt: home.updatedAt,
					origin: "saved",
				});
			});
			const releasePut = () => {
				if (putBody === null) throw new Error("PUT never arrived");
				released = true;
				home.dashboard = putBody.dashboard;
				home.version += 1;
				home.updatedAt = "2026-10-12T12:00:00Z";
				home.saved = true;
				gate.resolve(
					jsonResponse({
						dashboard: home.dashboard,
						version: home.version,
						updatedAt: home.updatedAt,
						origin: "saved",
					}),
				);
			};
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			// The Add dialog is opened BEFORE anything is busy…
			chooseAddType();
			await settleUntil(() => document.querySelector("sl-dialog") !== null, "dialog open");
			const dialog = dialogOrThrow();
			setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Busy", "sl-input");
			setShoelaceValue(
				dialogControl(dialog, "sl-select", "Series"),
				"twelve-data:AAPL",
				"sl-change",
			);
			// …then a save from a widget menu holds the busy flag…
			await chooseWidgetMenuItem("w-gold", "Remove");
			await settleUntil(
				() => backend.requestsTo("PUT", /\/home\/dashboard$/).length === 1,
				"PUT in flight",
			);
			// …and the menus and toolbar are impossible; the range select stays
			// enabled, because a range change waits for the save in flight.
			expect(widgetActionsButton(widgetById("w-gold")).hasAttribute("disabled")).toBe(true);
			expect(
				widgetById("w-vix-chart")
					.querySelector('sl-select[label="Range"]')
					?.hasAttribute("disabled"),
			).toBe(false);
			expect(
				screen
					.getByRole("button", { name: "Reset to default arrangement" })
					.hasAttribute("disabled"),
			).toBe(true);
			// A dialog save made meanwhile waits for the save in flight (the
			// Notebook's rule, ADR-0024): the dialog stays open with the
			// owner's input until it is applied to the saved result.
			fireEvent.click(dialogButton(dialog, "Add widget"));
			await vi.advanceTimersByTimeAsync(250);
			expect(document.querySelector("sl-dialog")).not.toBeNull();
			expect(backend.requestsTo("PUT", /\/home\/dashboard$/)).toHaveLength(1);
			releasePut();
			await settleUntil(
				() => document.querySelector('article[data-widget-id="w-gold"]') === null,
				"removed",
			);
			await settleUntil(() => document.querySelector("sl-dialog") === null, "queued save applied");
			const second = backend.requestsTo("PUT", /\/home\/dashboard$/)[1]?.body as
				| { dashboard: HomeDashboard }
				| undefined;
			// Applied on top of the removal: gold stays removed, Busy is added.
			expect(second?.dashboard.widgets.map((widget) => widget.title)).toContain("Busy");
			expect(second?.dashboard.widgets.some((widget) => widget.widgetId === "w-gold")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps each widget's DOM node, open disclosures and UI state across a server sync", async () => {
		// Fake timers: the poller follows the server's sync deterministically.
		usePollTimers();
		try {
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			const before = widgets();
			const chart = widgetById("w-vix-chart");
			const details = chart.querySelector("details");
			if (!(details instanceof HTMLDetailsElement)) throw new Error("no chart data table");
			details.open = true;

			// The server syncs and stores new data: one more VIX observation, a
			// new as-of date and a new retrieved stamp; the idle re-read sees it.
			startServerSync();
			const vix = home.series.find((entry) => entry.seriesId === "fred:VIXCLS");
			if (vix === undefined) throw new Error("no VIX series");
			vix.observations = [...vix.observations, ["2026-10-09", 16.02]];
			vix.lastRefreshedAt = "2026-10-12T12:05:00Z";
			vix.retrievedAt = "2026-10-12T12:05:00Z";
			await settleUntil(
				() => widgetById("w-vix").textContent?.includes("16.02") ?? false,
				"new observation rendered",
				90_000,
			);
			endServerSync();
			await settleUntil(
				() => homeStatus().includes("Last successful refresh:"),
				"run end observed",
			);

			// Every widget is the SAME DOM node as before: no teardown, so UI
			// state (the open data table, focus, hover) survives the refresh.
			const after = widgets();
			expect(after).toHaveLength(before.length);
			for (const [index, article] of after.entries()) {
				expect(article).toBe(before[index]);
			}
			const sameDetails = widgetById("w-vix-chart").querySelector("details");
			expect(sameDetails).toBe(details);
			expect((sameDetails as HTMLDetailsElement).open).toBe(true);
			// …and the numbers and provenance show the new data.
			const updated = widgetById("w-vix");
			expect(updated.textContent).toContain("16.02");
			expect(updated.textContent).toContain("2026-10-09");
			expect(updated.textContent).toContain("12:05");
			expect(widgetById("w-vix-chart").textContent).toContain("2026-10-09");
		} finally {
			vi.useRealTimers();
		}
	});

	it("shows stored values with a last-refresh-failed note, hiding nothing behind unavailable", async () => {
		home.series = home.series.map((entry): MarketSeries => {
			if (entry.seriesId === "fred:VIXCLS" || entry.seriesId === "twelve-data:AAPL") {
				return {
					...entry,
					lastRefreshedAt: "2026-10-12T11:55:00Z",
					unavailable: {
						code: "SOURCE_FAILED",
						upstreamStatus: null,
						reason: "The data source request failed.",
					},
				};
			}
			if (entry.seriesId === "twelve-data:NVDA") {
				return {
					...entry,
					observations: [],
					lastRefreshedAt: "2026-10-12T11:55:00Z",
					retrievedAt: "2026-10-12T11:55:00Z",
					unavailable: {
						code: "SERIES_NOT_FOUND",
						upstreamStatus: null,
						reason: "The provider has no data for this symbol on the configured plan.",
					},
				};
			}
			return entry;
		});
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });

		// The metric keeps its stored value with its as-of date, plus the amber note.
		const vix = widgetById("w-vix");
		expect(vix.textContent).toContain("15.41");
		expect(vix.textContent).toContain("2026-10-08");
		expect(vix.textContent).toContain("last refresh failed (The data source request failed.)");

		// The stock table keeps the stored close, with a note row beneath it…
		const watchlist = widgetById("w-watchlist");
		const table = within(watchlist).getByRole("table", { name: /Watchlist/ });
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain("336.64");
		expect(table.textContent).toContain("last refresh failed (The data source request failed.)");
		// …while a series with no observations at all is unavailable.
		expect(within(table).getByRole("row", { name: /NVDA/ }).textContent).toContain(
			"unavailable (The provider has no data for this symbol on the configured plan.)",
		);
	});

	it("adds the provider's answer status to a series' reason only when the provider caused it", async () => {
		home.series = home.series.map((entry): MarketSeries => {
			if (entry.seriesId === "fred:VIXCLS") {
				return {
					...entry,
					lastRefreshedAt: "2026-10-12T11:55:00Z",
					unavailable: {
						code: "SOURCE_FAILED",
						upstreamStatus: 503,
						reason: "The data source request failed.",
					},
				};
			}
			if (entry.seriesId === "twelve-data:NVDA" || entry.seriesId === "twelve-data:AAPL") {
				return {
					...entry,
					observations: [],
					lastRefreshedAt: "2026-10-12T11:55:00Z",
					retrievedAt: "2026-10-12T11:55:00Z",
					unavailable:
						entry.seriesId === "twelve-data:NVDA"
							? {
									code: "RATE_LIMITED",
									upstreamStatus: 429,
									reason: "The provider rate limit was reached.",
								}
							: {
									code: "SERIES_NOT_FOUND",
									upstreamStatus: null,
									reason: "The provider has no data for this symbol on the configured plan.",
								},
				};
			}
			return entry;
		});
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });

		expect(widgetById("w-vix").textContent).toContain(
			"last refresh failed (The data source request failed. The service answered HTTP 503.)",
		);
		const table = within(widgetById("w-watchlist")).getByRole("table", { name: /Watchlist/ });
		expect(within(table).getByRole("row", { name: /NVDA/ }).textContent).toContain(
			"unavailable (The provider rate limit was reached. The service answered HTTP 429.)",
		);
		const aapl = within(table).getByRole("row", { name: /AAPL/ }).textContent ?? "";
		expect(aapl).toContain(
			"unavailable (The provider has no data for this symbol on the configured plan.)",
		);
		expect(aapl).not.toContain("service answered");
	});

	it("states the provider's answer status in the last-refresh-failed line, and none without one", async () => {
		home.lastFailure = {
			state: "failed",
			code: "RATE_LIMITED",
			upstreamStatus: 429,
			at: "2026-10-12T12:00:00Z",
		};
		mountApp(backend);
		await waitFor(() =>
			expect(homeStatus()).toContain(
				"Last refresh failed (RATE_LIMITED, service answered HTTP 429) at 2026-10-12 12:00 UTC.",
			),
		);
		cleanup();

		home.lastFailure = {
			state: "failed",
			code: "RUNNER_LOST",
			upstreamStatus: null,
			at: "2026-10-12T12:00:00Z",
		};
		mountApp(backend);
		await waitFor(() =>
			expect(homeStatus()).toContain("Last refresh failed (RUNNER_LOST) at 2026-10-12 12:00 UTC."),
		);
		expect(homeStatus()).not.toContain("service answered");
	});

	it("announces a completed menu move in the polite live region", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await chooseWidgetMenuItem("w-gold", "Move earlier");
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		await waitFor(() =>
			expect(widgets().map((article) => article.getAttribute("data-widget-id"))[0]).toBe("w-gold"),
		);
		// The live region is now styled by the package stylesheet
		// (`wg-visually-hidden`), not the Tailwind `sr-only` utility: assert
		// the observable polite region instead of the class name.
		const live = document.querySelector("output[aria-live='polite']");
		if (!(live instanceof HTMLElement)) throw new Error("no polite live region");
		// The announcement clears first and sets on a later task (so a
		// repeated sentence announces again): wait for the message.
		await waitFor(() => expect(live.textContent).toBe("Moved “Gold” to position 1 of 7."));
	});

	it("announces a repeated sentence again: the same position twice still announces", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const live = (): string =>
			document.querySelector("output[aria-live='polite']")?.textContent ?? "missing live region";
		await chooseWidgetMenuItem("w-gold", "Move earlier");
		await waitFor(() => expect(live()).toBe("Moved “Gold” to position 1 of 7."));
		await chooseWidgetMenuItem("w-gold", "Move later");
		await waitFor(() => expect(live()).toBe("Moved “Gold” to position 2 of 7."));
		// The same sentence as the first move: a live region set to the
		// identical text twice in a row announces nothing, so the move
		// clears first and sets on a later task.
		await chooseWidgetMenuItem("w-gold", "Move earlier");
		await waitFor(() => expect(live()).toBe("Moved “Gold” to position 1 of 7."));
	});

	it("saves a drag reorder with exactly one PUT and announces it", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const serverIds = widgets().map((article) => article.getAttribute("data-widget-id"));
		// Dynamic layout: each position stacks vertically (300×100 with a
		// 20 px gap), reading the CSS `order` the drag preview writes, so the
		// mocked boxes track reflows like a real grid.
		const boxFor = (element: HTMLElement, fallback: number): DOMRect => {
			const raw = element.style.order;
			const parsed = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
			const position = Number.isInteger(parsed) ? parsed : fallback;
			return new DOMRect(0, position * 120, 300, 100);
		};
		for (const [index, article] of widgets().entries()) {
			article.getBoundingClientRect = () => boxFor(article, index);
		}
		const first = widgetById("w-vix");
		const handle = first.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		// Press on the header (150,50), drag past the midpoint of the third
		// widget (center 150,290) to (150,320), then release.
		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				clientX: 150,
				clientY: 50,
				button: 0,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		window.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				clientX: 150,
				clientY: 320,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		const placeholder = document.querySelector("[data-widget-placeholder]");
		if (!(placeholder instanceof HTMLElement)) throw new Error("no drag placeholder");
		placeholder.getBoundingClientRect = () => boxFor(placeholder, 0);
		await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
		window.dispatchEvent(
			new PointerEvent("pointerup", {
				bubbles: true,
				clientX: 150,
				clientY: 320,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		const body = homePuts()[0]?.body as {
			dashboard: HomeDashboard;
			expectedVersion: number;
		};
		expect(body.dashboard.widgets.map((entry) => entry.widgetId)).toEqual([
			...serverIds.filter((id) => id !== "w-vix").slice(0, 2),
			"w-vix",
			...serverIds.filter((id) => id !== "w-vix").slice(2),
		]);
		const live = document.querySelector("output[aria-live='polite']");
		if (!(live instanceof HTMLElement)) throw new Error("no polite live region");
		await waitFor(() => expect(live.textContent).toBe("Moved “VIX” to position 3 of 7."));
	});

	it("a calendar with never-fetched dates asks for nothing and shows the server's earnings sync", async () => {
		usePollTimers();
		try {
			withCalendarWidget();
			watch.stocks = [watchStock({ lastRefreshedAt: null, retrievedAt: null })];
			mountApp(backend);
			await settleUntil(
				() =>
					calendarText().includes(
						"No earnings dates yet; they appear after the next automatic refresh.",
					),
				"not-fetched state",
			);
			const watchGets = () => backend.requestsTo("GET", /\/watchlist$/);
			const getsAtLoad = watchGets().length;
			// The server queues the never-fetched stock at the runner's next
			// claim; the page's idle re-read — seconds away while dates were
			// never fetched, not a minute — sees the run and follows it.
			watch.activeRunId = "run_earnings_1";
			watch.runState = "leased";
			await vi.advanceTimersByTimeAsync(5_500);
			expect(watchGets().length).toBeGreaterThan(getsAtLoad);
			await settleUntil(
				() => calendarText().includes("Earnings dates: refreshing…"),
				"fetching shown",
			);
			watch.activeRunId = null;
			watch.lastSucceededAt = "2026-10-12T12:05:00Z";
			watch.stocks = [watchStock({ lastRefreshedAt: "2026-10-12T12:05:00Z" })];
			await settleUntil(
				() => calendarText().includes("Earnings dates: refreshed 2026-10-12 12:05 UTC"),
				"sync end shown",
			);
			expect(refreshPosts()).toHaveLength(0);
			expect(document.body.textContent).not.toContain("refresh was queued");
		} finally {
			vi.useRealTimers();
		}
	});

	it("reads no watchlist when no calendar widget is shown", async () => {
		watch.stocks = [watchStock({ lastRefreshedAt: null, retrievedAt: null })];
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(refreshPosts()).toHaveLength(0);
		expect(backend.requestsTo("GET", /\/watchlist$/)).toHaveLength(0);
	});

	it("never queues a Google sync for a connected out-of-sync calendar: the server does (ADR-0054)", async () => {
		withCalendarWidget();
		watch.stocks = [watchStock()];
		watch.google = {
			...watch.google,
			status: "connected",
			calendarId: "cal_1",
			connectedAt: "2026-10-12T11:55:00Z",
			inSync: false,
		};
		mountApp(backend);
		await waitFor(
			() =>
				expect(widgetById("w-cal").textContent).toContain(
					"Google Calendar: connected, not synced yet.",
				),
			{ timeout: 10_000 },
		);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(backend.requestsTo("POST", /google-calendar\//)).toHaveLength(0);
		expect(refreshPosts()).toHaveLength(0);
	}, 30_000);

	it("offers no earnings Refresh button: the server syncs the dates", async () => {
		withCalendarWidget();
		watch.stocks = [watchStock()];
		mountApp(backend);
		await waitFor(
			() => expect(widgetById("w-cal").textContent).toContain("Open Registered stocks"),
			{
				timeout: 10_000,
			},
		);
		expect(
			within(widgetById("w-cal")).queryByRole("button", { name: "Refresh earnings dates" }),
		).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(refreshPosts()).toHaveLength(0);
	});
});

describe("home follows edits made elsewhere", () => {
	const dashboardGets = () => backend.requestsTo("GET", /\/home\/dashboard$/);

	/** Another writer (an agent) moves the first widget last and bumps the version. */
	function externalReorder(): void {
		const first = home.dashboard.widgets[0];
		if (first === undefined) throw new Error("no widgets on the fake backend");
		home.dashboard = { schemaVersion: 2, widgets: [...home.dashboard.widgets.slice(1), first] };
		home.version += 1;
	}

	it("adopts a changed dashboard when the tab becomes visible, without a reload", async () => {
		const visibility = createControllableVisibility();
		mountApp(backend, visibility);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		expect(widgets()[0]?.getAttribute("data-widget-id")).toBe("w-vix");
		const getsBefore = dashboardGets().length;
		externalReorder();
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(widgets()[6]?.getAttribute("data-widget-id")).toBe("w-vix"), {
			timeout: 10_000,
		});
		expect(dashboardGets().length).toBeGreaterThan(getsBefore);
		// Quiet: no skeleton, no notice.
		expect(document.body.textContent).not.toContain("Loading market widgets");
		expect(document.body.textContent).not.toContain("changed elsewhere");
	});

	it("fetches nothing while a dialog is open", async () => {
		const visibility = createControllableVisibility();
		mountApp(backend, visibility);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await openAddDialog();
		const getsBefore = dashboardGets().length;
		externalReorder();
		visibility.setVisible(false);
		visibility.setVisible(true);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(dashboardGets()).toHaveLength(getsBefore);
		expect(document.querySelector("sl-dialog")).not.toBeNull();
		expect(widgets()[0]?.getAttribute("data-widget-id")).toBe("w-vix");
	});

	it("fetches nothing while a save is in flight", async () => {
		usePollTimers();
		try {
			const gate = deferred<Response>();
			let putBody: { dashboard: HomeDashboard; expectedVersion: number } | null = null;
			backend.on("PUT", /^\/api\/v1\/home\/dashboard$/, (request) => {
				putBody = request.body as typeof putBody;
				return gate.promise;
			});
			const visibility = createControllableVisibility();
			mountApp(backend, visibility);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			const getsBefore = dashboardGets().length;
			await chooseWidgetMenuItem("w-gold", "Remove");
			await settleUntil(
				() => backend.requestsTo("PUT", /\/home\/dashboard$/).length === 1,
				"PUT in flight",
			);
			visibility.setVisible(false);
			visibility.setVisible(true);
			await vi.advanceTimersByTimeAsync(1000);
			expect(dashboardGets()).toHaveLength(getsBefore);
			const releasePut = () => {
				if (putBody === null) throw new Error("PUT never arrived");
				home.dashboard = putBody.dashboard;
				home.version += 1;
				home.saved = true;
				gate.resolve(
					jsonResponse({
						dashboard: home.dashboard,
						version: home.version,
						updatedAt: "2026-10-12T12:00:00Z",
						origin: "saved",
					}),
				);
			};
			releasePut();
			await settleUntil(
				() => document.querySelector('article[data-widget-id="w-gold"]') === null,
				"removed",
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it("drops a re-read answer older than a save made while the GET was in flight", async () => {
		const visibility = createControllableVisibility();
		mountApp(backend, visibility);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const getsBefore = dashboardGets().length;
		// Hold the re-read's GET open; the released answer will be older than
		// the save made meanwhile (same version number, pre-save content).
		const gate = deferred<Response>();
		backend.on("GET", /^\/api\/v1\/home\/dashboard$/, () => gate.promise);
		const first = home.dashboard.widgets[0];
		if (first === undefined) throw new Error("no widgets on the fake backend");
		const staleDashboard = {
			schemaVersion: 2 as const,
			widgets: [...home.dashboard.widgets.slice(1), first],
		};
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(dashboardGets()).toHaveLength(getsBefore + 1), {
			timeout: 10_000,
		});
		// The owner's own save lands while the GET is in flight.
		await chooseWidgetMenuItem("w-gold", "Remove");
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		await waitFor(
			() => expect(document.querySelector('article[data-widget-id="w-gold"]')).toBeNull(),
			{ timeout: 10_000 },
		);
		const savedOrder = widgets().map((article) => article.getAttribute("data-widget-id"));
		expect(savedOrder).toHaveLength(6);
		// Release the GET with the older arrangement: it must be dropped, so
		// the page still shows the saved arrangement.
		gate.resolve(
			jsonResponse({
				dashboard: staleDashboard,
				version: home.version,
				updatedAt: home.updatedAt,
				origin: "saved",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(widgets().map((article) => article.getAttribute("data-widget-id"))).toEqual(savedOrder);
		expect(document.querySelector('article[data-widget-id="w-gold"]')).toBeNull();
		// The version on screen still tracks the server, so the next save is
		// not refused with "changed elsewhere".
		await chooseWidgetMenuItem("w-vix", "Remove");
		await waitFor(() => expect(homePuts()).toHaveLength(2));
		await waitFor(
			() => expect(document.querySelector('article[data-widget-id="w-vix"]')).toBeNull(),
			{ timeout: 10_000 },
		);
		expect(document.body.textContent).not.toContain("changed elsewhere");
	});

	it("drops a re-read answer when a dialog was opened while the GET was in flight", async () => {
		const visibility = createControllableVisibility();
		mountApp(backend, visibility);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const getsBefore = dashboardGets().length;
		const gate = deferred<Response>();
		backend.on("GET", /^\/api\/v1\/home\/dashboard$/, () => gate.promise);
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(dashboardGets()).toHaveLength(getsBefore + 1), {
			timeout: 10_000,
		});
		// A dialog opens while the GET is in flight; the answer must not disturb it.
		chooseAddType();
		await waitFor(() => expect(document.querySelector("sl-dialog")).not.toBeNull(), {
			timeout: 10_000,
		});
		externalReorder();
		gate.resolve(
			jsonResponse({
				dashboard: home.dashboard,
				version: home.version,
				updatedAt: "2026-10-12T12:00:00Z",
				origin: "saved",
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(document.querySelector("sl-dialog")).not.toBeNull();
		expect(widgets()).toHaveLength(7);
		expect(widgets()[0]?.getAttribute("data-widget-id")).toBe("w-vix");
	});

	it("re-renders nothing when the version is unchanged", async () => {
		const visibility = createControllableVisibility();
		mountApp(backend, visibility);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const before = widgets();
		const getsBefore = dashboardGets().length;
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(dashboardGets().length).toBe(getsBefore + 1), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		const after = widgets();
		expect(after).toHaveLength(before.length);
		for (const [index, article] of after.entries()) {
			expect(article).toBe(before[index]);
		}
	});
});

describe("Home keeps its data current while open", () => {
	// Home is a lazy chunk; load it on real time so fake-timer settling never
	// races its first import (this block may run alone).
	beforeAll(async () => {
		await import("../src/home/HomeView.tsx");
	});

	it("never re-reads idle while a sync is followed: only the poller reads, and nothing is asked for", async () => {
		usePollTimers();
		try {
			startServerSync("run_market_elsewhere", "pending");
			const visibility = createControllableVisibility();
			mountApp(backend, visibility);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			await settleUntil(() => homeStatus().includes("run_market_elsewhere"), "sync shown");
			// A pending run: the poller backs off to at most one read per 15 s;
			// the idle re-read adds none on top.
			const getsAtLoad = homeDataGets().length;
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			const reads = homeDataGets().length - getsAtLoad;
			expect(reads).toBeGreaterThan(30);
			expect(reads).toBeLessThanOrEqual(45);
			visibility.setVisible(false);
			visibility.setVisible(true);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(refreshPosts()).toHaveLength(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("warns when a re-read fails with numbers on screen, and the next answered read takes it down", async () => {
		usePollTimers();
		try {
			mountApp(backend);
			await settleUntil(() => widgets().length === 7, "initial widgets");
			home.dataFailures = 1;
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(
				() =>
					(document.body.textContent ?? "").includes(
						"Market data could not be re-read; the numbers shown may be out of date.",
					),
				"stale warning",
			);
			// The numbers stay on screen.
			expect(widgetById("w-vix").textContent).toContain("15.41");
			await vi.advanceTimersByTimeAsync(60_000);
			await settleUntil(
				() => !(document.body.textContent ?? "").includes("Market data could not be re-read"),
				"warning cleared",
			);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("home api client", () => {
	it("reads and writes the dashboard, data and catalog", async () => {
		const local = createFakeBackend();
		const state = initialHomeServerState(false);
		installHomeRoutes(local, initialServerState(), state);
		const api = createApiClient({ fetch: local.fetch });

		const dashboard = await api.getHomeDashboard();
		if (!dashboard.ok) throw new Error("dashboard did not load");
		expect(dashboard.value.dashboard.widgets).toHaveLength(7);
		expect(dashboard.value.origin).toBe("defaults");

		const data = await api.getHomeData(null);
		if (!data.ok || !data.value.changed) throw new Error("data did not load");
		expect(data.value.value.series.length).toBeGreaterThan(0);
		const etag = data.value.etag;
		const cached = await api.getHomeData(etag);
		if (!cached.ok) throw new Error("conditional read failed");
		expect(cached.value.changed).toBe(false);

		const catalog = await api.listMarketCatalog();
		if (!catalog.ok) throw new Error("catalog did not load");
		expect(catalog.value.map((entry) => entry.seriesId)).toContain("fred:VIXCLS");
		expect(HOME_CATALOG.map((entry) => entry.seriesId)).toContain("twelve-data:AAPL");
	});
});

describe("Home follows the one widget specification (ADR-0024)", () => {
	beforeEach(() => {
		// One app clipboard: start each case empty, whatever an earlier case copied.
		window.localStorage.clear();
		resetWidgetClipboard();
	});

	const ids = () => widgets().map((article) => article.getAttribute("data-widget-id"));
	const lastPut = () => homePuts().at(-1)?.body as { dashboard: HomeDashboard } | undefined;

	it("shows no widget titles; the title names each frame for assistive tech, and a metric names its series", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		for (const article of widgets()) {
			expect(article.hasAttribute("data-widget-title-hidden")).toBe(true);
			expect(article.querySelector("h3")?.className).toContain("wg-visually-hidden");
		}
		expect(screen.getAllByRole("article", { name: "VIX" })).toContain(widgetById("w-vix"));
		// Without a visible title the metric body says what it measures.
		expect(widgetById("w-vix").querySelector('[data-field="metric-series"]')?.textContent).toBe(
			home.series.find((entry) => entry.seriesId === "fred:VIXCLS")?.title,
		);
	});

	it("offers every Home type in the add menu, and never a research result", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).toEqual(HOME_WIDGET_TYPES.map((type) => WIDGET_TYPE_META[type].label));
		expect(names).not.toContain("Research result");
	});

	it("adds a Text widget on Home and opens its editor", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		chooseAddType("Text");
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		expect(lastPut()?.dashboard.widgets.at(-1)).toMatchObject({ type: "text", text: "New note" });
		await waitFor(() => expect(widgets()).toHaveLength(8));
		await waitFor(() => expect(document.querySelector("dialog[open]")).not.toBeNull());
		expect(document.querySelector("dialog[open]")?.textContent).toContain("Edit text widget");
	});

	it("places a Scheduled tasks widget at once (no fields, no dialog) whose menu has no Edit…", async () => {
		backend.on("GET", /^\/api\/v1\/scheduled-tasks$/, () =>
			jsonResponse({
				tasks: [makeTask()],
				limits: { maxActive: 10, maxTasks: 30 },
			}),
		);
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		chooseAddType("Scheduled tasks");
		await waitFor(() => expect(homePuts()).toHaveLength(1));
		const added = lastPut()?.dashboard.widgets.at(-1);
		expect(added).toMatchObject({
			type: "scheduled-tasks",
			title: "Scheduled tasks",
			size: "medium",
		});
		await waitFor(() => expect(widgets()).toHaveLength(8));
		expect(document.querySelector("dialog[open]")).toBeNull();
		const frame = widgets().at(-1);
		if (frame === undefined) throw new Error("expected the new widget");
		await waitFor(() => expect(frame.textContent).toContain("Morning storage brief"));
		fireEvent.click(widgetActionsButton(frame));
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).not.toContain("Edit…");
		expect(names).toContain("Size: Large");
	});

	it("has the Notebook's menu: Edit…, Size, Cut, Copy, Paste after, Duplicate, Move, Remove", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		fireEvent.click(widgetActionsButton(widgetById("w-vix")));
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).toEqual([
			"Edit…",
			"Size: Small",
			"Size: Medium",
			"Size: Large",
			"Cut",
			"Copy",
			"Paste after",
			"Duplicate",
			"Move earlier",
			"Move later",
			"Remove",
		]);
	});

	it("resizes and duplicates in one save each, and Undo restores the earlier arrangement", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const undo = screen.getByRole("button", { name: "Undo" });
		expect(undo.hasAttribute("disabled")).toBe(true);

		await chooseWidgetMenuItem("w-vix", "Size: Large");
		await waitFor(() => expect(widgetById("w-vix").getAttribute("data-widget-size")).toBe("large"));
		expect(homePuts()).toHaveLength(1);

		await chooseWidgetMenuItem("w-vix", "Duplicate");
		await waitFor(() => expect(widgets()).toHaveLength(8));
		expect(homePuts()).toHaveLength(2);
		// The copy lands directly after its original, under a fresh id.
		expect(ids()[0]).toBe("w-vix");
		expect(ids()[1]).not.toBe("w-vix");
		expect(lastPut()?.dashboard.widgets[1]).toMatchObject({
			type: "market-metric",
			seriesId: "fred:VIXCLS",
		});

		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(widgets()).toHaveLength(7));
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(widgetById("w-vix").getAttribute("data-widget-size")).toBe("small"));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(true),
		);
	});

	it("removes at once with no dialog, says so, and Undo brings it back", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await chooseWidgetMenuItem("w-gold", "Remove");
		await waitFor(() => expect(widgets()).toHaveLength(6));
		expect(document.querySelector("sl-dialog, dialog[open]")).toBeNull();
		const live = document.querySelector("output.sr-only[aria-live='polite']");
		await waitFor(() => expect(live?.textContent).toBe("Removed 1 widget. Undo restores it."));
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(widgets()).toHaveLength(7));
		expect(ids()[1]).toBe("w-gold");
	});

	it("gives each widget header one button, its actions menu: no select toggle or selection bar", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		// Widget selection was removed (2026-11-02).
		for (const widget of widgets()) {
			const header = widget.querySelector(".wg-header");
			if (!(header instanceof HTMLElement)) throw new Error("no widget header");
			// The top edge is a drag handle too (ADR-0062).
			expect(widget.querySelector(".wg-drag-strip")?.getAttribute("data-widget-drag-handle")).toBe(
				widget.getAttribute("data-widget-id"),
			);
			const buttons = [...header.querySelectorAll("button")];
			expect(buttons).toHaveLength(1);
			expect(buttons[0]?.getAttribute("aria-label") ?? buttons[0]?.textContent).toMatch(/actions$/);
			fireEvent.click(header);
			expect(widget.hasAttribute("data-widget-selected")).toBe(false);
		}
		expect(screen.queryByRole("toolbar", { name: "Selected widgets" })).toBeNull();
	});

	it("copies a Home widget and pastes it after another, through the app's one clipboard", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		await chooseWidgetMenuItem("w-vix-chart", "Copy");
		await chooseWidgetMenuItem("w-vix", "Paste after");
		await waitFor(() => expect(widgets()).toHaveLength(8));
		expect(lastPut()?.dashboard.widgets[1]).toMatchObject({
			type: "line-chart",
			seriesIds: ["fred:VIXCLS"],
		});
		// The clipboard says where it came from, so a notebook can take it too.
		expect(widgetClipboard().content()?.sourceWorkspaceId).toBe("home");
	});
});

describe("chart viewer entry points (ADR-0025)", () => {
	/** The open viewer's dialog, or an error naming what is missing. */
	function viewerDialog(): HTMLElement {
		const dialog = document.querySelector("sl-dialog.chart-viewer");
		if (!(dialog instanceof HTMLElement)) throw new Error("the chart viewer did not open");
		return dialog;
	}

	/** The From/To date inputs of the open viewer, in order. */
	function viewerRange(): { readonly from: HTMLInputElement; readonly to: HTMLInputElement } {
		const dialog = viewerDialog();
		const inputs = [...dialog.querySelectorAll('input[type="date"]')].filter(
			(input): input is HTMLInputElement => input instanceof HTMLInputElement,
		);
		const [from, to] = [inputs[0], inputs[1]];
		if (from === undefined || to === undefined) throw new Error("the viewer has no From/To inputs");
		return { from, to };
	}

	/** The viewer's dialog once its lazy chunk has loaded and rendered. */
	async function openedDialog(): Promise<HTMLElement> {
		return waitFor(() => viewerDialog(), { timeout: 5000 });
	}

	/** Closes the viewer through its Close button and waits until it unmounts. */
	async function closeViewer(): Promise<void> {
		fireEvent.click(within(viewerDialog()).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull());
	}

	it("opens the line chart's plot with every usable series at the widget's range", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		// w-vix-chart holds fred:VIXCLS at range 1y over 2026-10-06…2026-10-08.
		const open = within(widgetById("w-vix-chart")).getByRole("button", {
			name: /^Open chart: Line chart: VIX\./,
		});
		open.focus();
		fireEvent.click(open);
		const dialog = await openedDialog();
		// Solid sets the Shoelace `label` as a property on the custom
		// element, not as an attribute.
		expect((dialog as unknown as { readonly label: string }).label).toBe("VIX");
		expect(dialog.textContent).toContain("CBOE Volatility Index: VIX");
		// The 1y preset cannot be filled by three days, so the window starts
		// at the first held observation.
		expect(viewerRange().from.value).toBe("2026-10-06");
		expect(viewerRange().to.value).toBe("2026-10-08");
		// The viewer mounts only while open: closing unmounts it and focus
		// returns to the button that opened it.
		await closeViewer();
		expect(document.activeElement).toBe(open);
	});

	it("keeps the line chart's hover readout working inside the opener", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const chart = widgetById("w-vix-chart");
		const svg = chart.querySelector("svg[role='img']");
		if (!(svg instanceof SVGSVGElement)) throw new Error("no line-chart svg");
		// Happy-dom reports zero-size boxes; the frame ignores those, so the
		// plot is given a real size like a laid-out page would.
		svg.getBoundingClientRect = () =>
			new DOMRect(0, 0, 640, 320) as unknown as ReturnType<SVGSVGElement["getBoundingClientRect"]>;
		const readout = chart.querySelector('[data-chart-part="readout"]');
		if (!(readout instanceof HTMLElement)) throw new Error("no widget readout");
		expect(readout.textContent).toContain("Point at the chart");
		// The plot's right edge holds the last row (2026-10-08).
		fireEvent.pointerMove(svg, { clientX: 600 });
		await waitFor(() => expect(readout.textContent).toContain("2026-10-08"));
		// Hovering never opened the viewer by itself.
		expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull();
	});

	it("opens a metric's value block with its series at the 1y preset", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const open = within(widgetById("w-vix")).getByRole("button", {
			name: /^Open chart: CBOE Volatility Index: VIX, /,
		});
		open.focus();
		fireEvent.click(open);
		const dialog = await openedDialog();
		expect(dialog.textContent).toContain("CBOE Volatility Index: VIX");
		expect(viewerRange().from.value).toBe("2026-10-06");
		expect(viewerRange().to.value).toBe("2026-10-08");
		await closeViewer();
		expect(document.activeElement).toBe(open);
	});

	it("opens a stock-table row with that row's series only, at the 1y preset", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const table = within(widgetById("w-watchlist")).getByRole("table", { name: /Watchlist/ });
		const open = within(table).getByRole("button", { name: /^Open chart: AAPL \(NASDAQ\)/ });
		fireEvent.click(open);
		const dialog = await openedDialog();
		expect(dialog.textContent).toContain("AAPL (NASDAQ)");
		expect(dialog.textContent).not.toContain("MSFT (NASDAQ)");
		expect(viewerRange().from.value).toBe("2026-10-07");
		expect(viewerRange().to.value).toBe("2026-10-09");
		await closeViewer();
	});

	it("offers no opener for a series without observations", async () => {
		const aapl = home.series.find((entry) => entry.seriesId === "twelve-data:AAPL");
		if (aapl === undefined) throw new Error("AAPL fixture is missing");
		aapl.observations = [];
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const table = within(widgetById("w-watchlist")).getByRole("table", { name: /Watchlist/ });
		expect(
			within(table).queryByRole("button", { name: /^Open chart: AAPL \(NASDAQ\)/ }),
		).toBeNull();
		// The row itself still states the reason, never a blank.
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain("unavailable (");
	});

	it("a press that turns into a widget drag never opens the viewer", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const article = widgetById("w-vix-chart");
		const handle = article.querySelector("[data-widget-drag-handle]");
		if (!(handle instanceof HTMLElement)) throw new Error("no drag handle");
		const open = within(article).getByRole("button", { name: /^Open chart: Line chart: VIX\./ });
		// A press on the top-edge strip that moves past the 4 px drag threshold starts
		// a drag; releasing it arms the engine's one-shot click guard, which
		// swallows the release click inside the grid.
		handle.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				clientX: 150,
				clientY: 50,
				button: 0,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		window.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				clientX: 150,
				clientY: 60,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		window.dispatchEvent(
			new PointerEvent("pointerup", {
				bubbles: true,
				clientX: 150,
				clientY: 60,
				pointerId: 1,
				isPrimary: true,
			}),
		);
		fireEvent.click(open);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull();
		// The guard is one-shot: the next click is a real press and opens.
		fireEvent.click(open);
		await openedDialog();
		await closeViewer();
	});

	it("names each opener from its visible content, with no aria-label (fix round 6)", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		// The metric's value block: value, unit and both change lines are in
		// the name (WCAG 2.5.3), after the hidden "Open chart: <title>, ".
		const metric = within(widgetById("w-vix")).getByRole("button", { name: /^Open chart: / });
		expect(metric.hasAttribute("aria-label")).toBe(false);
		const metricName = metric.textContent ?? "";
		expect(metricName).toMatch(/^Open chart: CBOE Volatility Index: VIX, 15\.41 Index/);
		expect(metricName).toContain("1-month change:");
		expect(metricName).not.toContain("Change:");
		expect(metricName).toContain("1-year change:");
		// Phrasing content only inside a button: no div or p.
		expect(metric.querySelector("div, p")).toBeNull();
		// The stock-table row header keeps the symbol in its name.
		const table = within(widgetById("w-watchlist")).getByRole("table", { name: /Watchlist/ });
		const rowButton = within(table).getByRole("button", { name: /^Open chart: AAPL \(NASDAQ\)/ });
		expect(rowButton.hasAttribute("aria-label")).toBe(false);
		expect(rowButton.closest("th")?.textContent).toContain("AAPL");
		expect(rowButton.textContent).toMatch(/AAPL \(NASDAQ\)\s*AAPL$/);
		// The line chart keeps its image name ("Line chart: VIX. … by date.").
		const plot = within(widgetById("w-vix-chart")).getByRole("button", { name: /^Open chart: / });
		expect(plot.hasAttribute("aria-label")).toBe(false);
		expect(plot.querySelector("svg[role='img']")?.getAttribute("aria-label")).toMatch(
			/^Line chart: VIX\. .+ by date\.$/,
		);
	});

	it("returns focus to an opener that a mouse click never focused (fix round 6)", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const open = within(widgetById("w-vix")).getByRole("button", { name: /^Open chart: / });
		// Safari and Firefox on macOS do not focus a button on click: the
		// opener is handed over by the click, not read from activeElement.
		expect(document.activeElement).not.toBe(open);
		fireEvent.click(open);
		await openedDialog();
		await closeViewer();
		expect(document.activeElement).toBe(open);
	});

	it("ignores a press that moved 4 px or more before its release (fix round 6)", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const table = within(widgetById("w-watchlist")).getByRole("table", { name: /Watchlist/ });
		const open = within(table).getByRole("button", { name: /^Open chart: AAPL \(NASDAQ\)/ });
		// Selecting "AAPL" with the mouse: pressed, moved 20 px, released on it.
		fireEvent.pointerDown(open, {
			clientX: 10,
			clientY: 10,
			isPrimary: true,
			pointerType: "mouse",
		});
		fireEvent.click(open, { clientX: 30, clientY: 10, detail: 1 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull();
		// A mouse press that moved 6 px is still a selection, not a click.
		fireEvent.pointerDown(open, {
			clientX: 10,
			clientY: 10,
			isPrimary: true,
			pointerType: "mouse",
		});
		fireEvent.click(open, { clientX: 16, clientY: 10, detail: 1 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull();
		// A click that stays within 4 px opens.
		fireEvent.pointerDown(open, {
			clientX: 10,
			clientY: 10,
			isPrimary: true,
			pointerType: "mouse",
		});
		fireEvent.click(open, { clientX: 12, clientY: 11, detail: 1 });
		await openedDialog();
		await closeViewer();
		// A keyboard activation (click detail 0) always opens.
		fireEvent.click(open, { detail: 0 });
		await openedDialog();
		await closeViewer();
	});

	it("opens on a touch or pen tap that drifted a few px: the press slop is for the mouse only (fix round 7)", async () => {
		mountApp(backend);
		await waitFor(() => expect(widgets()).toHaveLength(7), { timeout: 10_000 });
		const table = within(widgetById("w-watchlist")).getByRole("table", { name: /Watchlist/ });
		const open = within(table).getByRole("button", { name: /^Open chart: AAPL \(NASDAQ\)/ });
		// A finger lands, drifts 6 px and lifts: a tap, since touch selects no text.
		fireEvent.pointerDown(open, {
			clientX: 10,
			clientY: 10,
			isPrimary: true,
			pointerType: "touch",
		});
		fireEvent.click(open, { clientX: 16, clientY: 10, detail: 1 });
		await openedDialog();
		await closeViewer();
		fireEvent.pointerDown(open, { clientX: 10, clientY: 10, isPrimary: true, pointerType: "pen" });
		fireEvent.click(open, { clientX: 10, clientY: 16, detail: 1 });
		await openedDialog();
		await closeViewer();
	});

	it("keeps an open viewer when a reload drops the series, and never reopens it by itself (fix round 6)", async () => {
		const series = (observations: [string, number][]): MarketSeries => ({
			seriesId: "fred:VIXCLS",
			provider: "fred",
			symbol: "VIXCLS",
			title: "CBOE Volatility Index: VIX",
			unit: "Index",
			frequency: "daily",
			publisher: "Federal Reserve Bank of St. Louis",
			sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
			lastRefreshedAt: "2026-10-12T11:50:00Z",
			retrievedAt: "2026-10-12T11:50:00Z",
			unavailable: null,
			observations,
		});
		const held = series([
			["2026-10-06", 15.01],
			["2026-10-07", 15.08],
			["2026-10-08", 15.41],
		]);
		const [byId, setById] = createSignal<ReadonlyMap<string, MarketSeries>>(
			new Map([[held.seriesId, held]]),
		);
		const widget = {
			type: "market-metric",
			widgetId: "w-metric",
			title: "VIX",
			size: "small",
			seriesId: "fred:VIXCLS",
		} as const;
		render(() => (
			<WidgetFrame widget={widget}>
				<MetricWidget widget={widget} seriesById={byId} />
			</WidgetFrame>
		));
		const body = document.querySelector(`.${WIDGET_BODY_CLASS}`);
		if (!(body instanceof HTMLElement)) throw new Error("no widget body");
		fireEvent.click(screen.getByRole("button", { name: /^Open chart: / }));
		const dialog = await openedDialog();
		// A reload drops the observations: the viewer stays, saying why.
		setById(new Map([[held.seriesId, series([])]]));
		expect(document.querySelector("sl-dialog.chart-viewer")).toBe(dialog);
		expect(dialog.textContent).toContain("unavailable (this widget holds no observations)");
		expect(screen.queryByRole("button", { name: /^Open chart: / })).toBeNull();
		await closeViewer();
		// The opener is gone: focus lands on the widget's body, never <body>.
		expect(document.activeElement).toBe(body);
		// Data returning later never reopens a viewer the user closed.
		setById(new Map([[held.seriesId, held]]));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull();
	});

	it("returns focus to the new opener when the data came back while the viewer was open (fix round 7)", async () => {
		const held: MarketSeries = {
			seriesId: "fred:VIXCLS",
			provider: "fred",
			symbol: "VIXCLS",
			title: "CBOE Volatility Index: VIX",
			unit: "Index",
			frequency: "daily",
			publisher: "Federal Reserve Bank of St. Louis",
			sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
			lastRefreshedAt: "2026-10-12T11:50:00Z",
			retrievedAt: "2026-10-12T11:50:00Z",
			unavailable: null,
			observations: [
				["2026-10-06", 15.01],
				["2026-10-07", 15.08],
				["2026-10-08", 15.41],
			],
		};
		const [byId, setById] = createSignal<ReadonlyMap<string, MarketSeries>>(
			new Map([[held.seriesId, held]]),
		);
		const widget = {
			type: "market-metric",
			widgetId: "w-metric",
			title: "VIX",
			size: "small",
			seriesId: "fred:VIXCLS",
		} as const;
		render(() => (
			<WidgetFrame widget={widget}>
				<MetricWidget widget={widget} seriesById={byId} />
			</WidgetFrame>
		));
		const first = screen.getByRole("button", { name: /^Open chart: / });
		fireEvent.click(first);
		await openedDialog();
		// One reload drops the series, the next brings it back: the widget
		// renders a new opener button while the viewer is still open.
		setById(new Map([[held.seriesId, { ...held, observations: [] }]]));
		setById(new Map([[held.seriesId, held]]));
		const second = screen.getByRole("button", { name: /^Open chart: / });
		expect(second).not.toBe(first);
		expect(first.isConnected).toBe(false);
		await closeViewer();
		expect(document.activeElement).toBe(second);
	});
});
