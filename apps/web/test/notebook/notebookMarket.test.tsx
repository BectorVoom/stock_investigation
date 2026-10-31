import {
	type MarketSeries,
	type NotebookWidget,
	notebookWidgetSchema,
	WIDGET_TYPE_META,
	watchlistResponseSchema,
} from "@research/contracts";
import { createBaselineUiRegistry } from "@research/ui-registry";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.ts";
import { ensureHomeIconLibraries } from "../../src/home/shoelace.ts";
import type { VisibilitySource } from "../../src/lib/polling.ts";
import { NotebookPanel } from "../../src/notebook/NotebookPanel.tsx";
import { notebookSessionMessages } from "../../src/notebook/notebook.messages.ts";
import { createNotebookMarketContext } from "../../src/notebook/notebookMarket.ts";
import { createNotebookSession, type NotebookSession } from "../../src/notebook/notebookSession.ts";
import type { WidgetMarketContext } from "../../src/widgets/marketContext.ts";
import { WidgetBody } from "../../src/widgets/WidgetBody.tsx";
import { defaultHomeSeries, HOME_CATALOG } from "../appHarness.tsx";
import {
	ALWAYS_VISIBLE,
	createControllableVisibility,
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "../fakeBackend.ts";
import { makeRun, WORKSPACE_VIEW } from "../fixtures.ts";
import { lastOpenMenu } from "../openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "../setup.ts";
import { createNotebookBackend, WORKSPACE_ID } from "./notebookHarness.ts";

const registry = createBaselineUiRegistry();
const NOTEBOOK_PUT = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/;
const MARKET_DATA = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook\/market-data$/;
const WATCHLIST_GET = /^\/api\/v1\/watchlist$/;
const REFRESH = /\/home\/refresh$/;

const OWNER = { kind: "owner", messageId: null, runId: null, componentId: null } as const;
const STAMP = {
	createdAt: "2026-10-01T00:00:00Z",
	updatedAt: "2026-10-01T00:00:00Z",
	revision: 1,
	origin: OWNER,
} as const;

function marketWidget(data: unknown): NotebookWidget {
	return notebookWidgetSchema.parse(data);
}

/** One valid widget of each market type, with fixed stamps for deterministic tests. */
function marketFixtures(): {
	readonly metric: NotebookWidget;
	readonly chart: NotebookWidget;
	readonly stocks: NotebookWidget;
	readonly indicators: NotebookWidget;
	readonly calendar: NotebookWidget;
} {
	return {
		metric: marketWidget({
			widgetId: "nb-metric",
			type: "market-metric",
			title: "VIX",
			size: "small",
			seriesId: "fred:VIXCLS",
			...STAMP,
		}),
		chart: marketWidget({
			widgetId: "nb-chart",
			type: "line-chart",
			title: "VIX chart",
			size: "medium",
			seriesIds: ["fred:VIXCLS"],
			range: "1y",
			...STAMP,
		}),
		stocks: marketWidget({
			widgetId: "nb-stocks",
			type: "stock-table",
			title: "Watchlist",
			size: "medium",
			seriesIds: ["twelve-data:AAPL"],
			...STAMP,
		}),
		indicators: marketWidget({
			widgetId: "nb-indicators",
			type: "indicator-table",
			title: "US economy",
			size: "large",
			seriesIds: ["fred:CPIAUCSL"],
			...STAMP,
		}),
		calendar: marketWidget({
			widgetId: "nb-calendar",
			type: "earnings-calendar",
			title: "Earnings",
			size: "large",
			daysAhead: 90,
			...STAMP,
		}),
	};
}

function inDays(days: number): string {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function watchlistWithAapl() {
	return watchlistResponseSchema.parse({
		stocks: [
			{
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
				events: [
					{
						periodKey: "2026-q4",
						announcementDate: inDays(16),
						fiscalPeriodLabel: "Q4 2026",
						fiscalPeriodEnd: null,
						timing: "after-close",
					},
				],
			},
		],
		lists: [],
		refresh: {
			activeRunId: null,
			activeRunState: null,
			lastSucceededAt: "2026-10-12T11:50:00Z",
			lastFailure: null,
		},
		feed: { enabled: false, createdAt: null },
		googleCalendar: {
			status: "disconnected",
			authUrl: null,
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			lastSync: null,
			inSync: null,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: null,
		},
	});
}

/** The notebook market-data shape, backed by mutable state the test drives. */
interface MarketServerState {
	series: MarketSeries[];
	activeRunId: string | null;
	runState: string;
	lastSucceededAt: string | null;
	refreshCount: number;
	dataFailures: number;
}

function installNotebookMarketRoutes(backend: FakeBackend, market: MarketServerState): void {
	const etag = () =>
		`"nb-${market.activeRunId ?? "idle"}-${market.series.map((entry) => `${entry.seriesId}:${entry.lastRefreshedAt ?? "never"}:${entry.observations.length}`).join(",")}"`;
	backend.on("GET", MARKET_DATA, (request) => {
		if (market.dataFailures > 0) {
			market.dataFailures -= 1;
			return errorResponse(500, "INTERNAL", "boom (notebook market fixture)");
		}
		if (request.headers["if-none-match"] === etag()) return new Response(null, { status: 304 });
		return jsonResponse(
			{
				series: market.series,
				refresh: {
					activeRunId: market.activeRunId,
					activeRunState: market.activeRunId === null ? null : market.runState,
					lastSucceededAt: market.lastSucceededAt,
					lastFailure: null,
				},
			},
			{ headers: { ETag: etag() } },
		);
	});
	backend.on("POST", /^\/api\/v1\/home\/refresh$/, () => {
		market.refreshCount += 1;
		if (market.activeRunId === null) {
			market.activeRunId = `run_market_${market.refreshCount}`;
			market.runState = "pending";
		}
		return jsonResponse(
			{
				run: makeRun({
					runId: market.activeRunId,
					kind: "market-refresh",
					request: null,
					workspaceId: null,
					state: market.runState as "pending",
				}),
			},
			{ status: 202 },
		);
	});
	backend.on("GET", /^\/api\/v1\/home\/catalog$/, () => jsonResponse({ entries: HOME_CATALOG }));
}

interface WatchServerState {
	response: ReturnType<typeof watchlistWithAapl>;
	failures: number;
	count: number;
}

function installNotebookWatchlistRoutes(backend: FakeBackend, watch: WatchServerState): void {
	backend.on("GET", WATCHLIST_GET, (request) => {
		watch.count += 1;
		if (watch.failures > 0) {
			watch.failures -= 1;
			return errorResponse(500, "INTERNAL", "boom (notebook watchlist fixture)");
		}
		const tag = `"nb-watch-${watch.response.stocks.length}"`;
		if (request.headers["if-none-match"] === tag) return new Response(null, { status: 304 });
		return jsonResponse(watch.response, { headers: { ETag: tag } });
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/refresh$/, () =>
		jsonResponse(
			{
				run: makeRun({
					runId: "run_earnings_1",
					kind: "earnings-refresh",
					request: null,
					workspaceId: null,
					state: "pending",
				}),
			},
			{ status: 202 },
		),
	);
}

function stubMarket(
	series: readonly MarketSeries[],
	watchlist: ReturnType<typeof watchlistWithAapl> | null,
	api: ReturnType<typeof createApiClient>,
): WidgetMarketContext {
	const byId = new Map(series.map((entry) => [entry.seriesId, entry] as const));
	const served: ReadonlySet<string> = new Set(byId.keys());
	return {
		seriesById: () => byId,
		pageSeries: () => served,
		watchlist: () => watchlist,
		watchlistError: () => null,
		onRetryWatchlist: () => {},
		onRefreshEarnings: () => {},
		earningsRefreshBusy: () => false,
		api,
	};
}

const BODY_DEFAULTS = {
	// No widget here loads tasks; the client only satisfies the body's props.
	api: createApiClient({ fetch: createFakeBackend().fetch }),
	visibility: ALWAYS_VISIBLE,
	editingDisabled: false,
	onSaveText: () => Promise.resolve(true),
	onSaveMarketWidget: () => {},
} as const;

let backend: FakeBackend;
const rootDisposers: (() => void)[] = [];

/** A Notebook panel backed by the notebook fake server plus market-data, catalog and watchlist routes. */
function mountPanel(
	widgets: readonly NotebookWidget[],
	market: MarketServerState,
	watch: WatchServerState | null,
	visibility?: VisibilitySource,
): NotebookSession {
	const created = createNotebookBackend(widgets);
	backend = created.backend;
	installNotebookMarketRoutes(backend, market);
	if (watch !== null) installNotebookWatchlistRoutes(backend, watch);
	const api = createApiClient({ fetch: backend.fetch });
	let session!: NotebookSession;
	rootDisposers.push(
		createRoot((dispose) => {
			session = createNotebookSession(
				api,
				WORKSPACE_ID,
				ALWAYS_VISIBLE,
				() => notebookSessionMessages.en,
			);
			return dispose;
		}),
	);
	render(() => (
		<NotebookPanel
			session={session}
			api={api}
			registry={registry}
			view={WORKSPACE_VIEW}
			mode="notebook"
			onAskAssistant={() => {}}
			visibility={visibility}
		/>
	));
	return session;
}

function freshMarket(series: MarketSeries[]): MarketServerState {
	return {
		series,
		activeRunId: null,
		runState: "pending",
		lastSucceededAt: "2026-10-12T11:50:00Z",
		refreshCount: 0,
		dataFailures: 0,
	};
}

function articles(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

function articleById(id: string): HTMLElement {
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

function dialogControl(dialog: HTMLElement, tag: string, label: string): HTMLElement {
	const controls = [...dialog.querySelectorAll(tag)];
	const found = controls.find((control) => control.getAttribute("label") === label);
	if (!(found instanceof HTMLElement)) throw new Error(`dialog has no ${tag} labelled ${label}`);
	return found;
}

/** The visit time the fixtures are written for: their fresh stamps (2026-10-12T11:50) are 10 minutes old. */
const VISIT_AT = Date.parse("2026-10-12T12:00:00Z");

beforeEach(() => {
	// ADR-0044 §4: the Notebook judges staleness by the clock, so pin it to
	// the fixtures' day (a real clock would make every fixture stamp stale).
	vi.spyOn(Date, "now").mockReturnValue(VISIT_AT);
	resetGlobalFetchCalls();
	backend = createFakeBackend();
	// Shoelace controls (the chart range select, the market form) resolve
	// their icons from the shipped SVGs in production (NotebookPanel calls
	// this too); without it the kit fetches `data:` URIs that trip the
	// network guard.
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	while (rootDisposers.length > 0) rootDisposers.pop()?.();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("notebook market widget bodies", () => {
	it("renders each market type through its Home component with fixture series", () => {
		const api = createApiClient({ fetch: backend.fetch });
		const fixtures = marketFixtures();
		const series = defaultHomeSeries(false);
		const watchlist = watchlistWithAapl();
		const market = stubMarket(series, watchlist, api);

		const { unmount: unmountMetric } = render(() => (
			<WidgetBody
				widget={fixtures.metric}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// Home's metric: latest value with unit, change and source.
		expect(document.body.textContent).toContain("15.41");
		expect(document.body.textContent).toContain("Index");
		expect(document.body.textContent).toContain("Federal Reserve Bank of St. Louis (FRED)");
		unmountMetric();
		cleanup();

		render(() => (
			<WidgetBody
				widget={fixtures.chart}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// Home's line chart: the svg plus its data-table twin.
		const svg = document.querySelector("svg[role='img']");
		if (!(svg instanceof SVGElement)) throw new Error("no Home line-chart svg");
		expect(svg.getAttribute("aria-label")).toContain("Line chart: VIX chart");
		expect(document.body.textContent).toContain("Data table: VIX chart");
		cleanup();

		render(() => (
			<WidgetBody
				widget={fixtures.stocks}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// Home's stock table: one row per series with the fixture close.
		expect(document.body.textContent).toContain("336.64");
		expect(document.body.textContent).toContain("AAPL");
		cleanup();

		render(() => (
			<WidgetBody
				widget={fixtures.indicators}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// Home's indicator table names the indicator.
		expect(document.body.textContent).toContain("Consumer Price Index");
		cleanup();

		render(() => (
			<WidgetBody
				widget={fixtures.calendar}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// Home's earnings calendar: the Next list with the fixture stock.
		expect(document.body.textContent).toContain("Next");
		expect(document.body.textContent).toContain("AAPL");
		expect(document.body.textContent).toContain("Open Watchlist");
		cleanup();
	});

	it("opens the chart viewer from a notebook market widget, like on Home (ADR-0025)", async () => {
		const api = createApiClient({ fetch: backend.fetch });
		const fixtures = marketFixtures();
		const market = stubMarket(defaultHomeSeries(false), null, api);

		render(() => (
			<WidgetBody
				widget={fixtures.chart}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// The same Home component, so the same opener with the widget title.
		const open = screen.getByRole("button", { name: /^Open chart: Line chart: VIX chart\./ });
		fireEvent.click(open);
		// The viewer is its own lazy chunk: it renders once the chunk loads.
		const dialog = await waitFor(() => {
			const found = document.querySelector("sl-dialog.chart-viewer");
			if (!(found instanceof HTMLElement)) throw new Error("the chart viewer did not open");
			return found;
		});
		expect(dialog.textContent).toContain("CBOE Volatility Index: VIX");
		// The 1y opening preset over the three fixture days.
		const dates = [...dialog.querySelectorAll('input[type="date"]')].filter(
			(input): input is HTMLInputElement => input instanceof HTMLInputElement,
		);
		expect(dates.map((input) => input.value)).toEqual(["2026-10-06", "2026-10-08"]);
		// Closing unmounts the viewer.
		fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull());

		cleanup();
		render(() => (
			<WidgetBody
				widget={fixtures.stocks}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		// The stock-table row opens its own series only.
		fireEvent.click(screen.getByRole("button", { name: /^Open chart: AAPL \(NASDAQ\)/ }));
		const rowDialog = await waitFor(() => {
			const found = document.querySelector("sl-dialog.chart-viewer");
			if (!(found instanceof HTMLElement)) throw new Error("the row viewer did not open");
			return found;
		});
		expect(rowDialog.textContent).toContain("AAPL (NASDAQ)");
		expect(rowDialog.textContent).not.toContain("MSFT (NASDAQ)");
	});

	it("shows Home's own unavailable and loading states without data", () => {
		const api = createApiClient({ fetch: backend.fetch });
		const fixtures = marketFixtures();
		const market = stubMarket([], null, api);

		const { unmount } = render(() => (
			<WidgetBody
				widget={fixtures.metric}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		expect(document.body.textContent).toContain("unavailable");
		expect(document.body.textContent).not.toContain("15.41");
		unmount();
		cleanup();

		render(() => (
			<WidgetBody
				widget={fixtures.calendar}
				view={null}
				registry={registry}
				market={market}
				{...BODY_DEFAULTS}
			/>
		));
		expect(document.body.textContent).toContain("Loading earnings dates…");
		cleanup();

		// No market context at all: the notebook's loading state, never a crash.
		render(() => (
			<WidgetBody
				widget={fixtures.chart}
				view={null}
				registry={registry}
				market={null}
				{...BODY_DEFAULTS}
			/>
		));
		expect(document.body.textContent).toContain("Loading market data…");
	});

	it("saves a line-chart range change through onSaveMarketWidget", async () => {
		const api = createApiClient({ fetch: backend.fetch });
		const fixtures = marketFixtures();
		const saved: unknown[] = [];
		render(() => (
			<WidgetBody
				widget={fixtures.chart}
				view={null}
				registry={registry}
				market={stubMarket(defaultHomeSeries(false), null, api)}
				{...BODY_DEFAULTS}
				onSaveMarketWidget={(widget) => {
					saved.push(widget);
				}}
			/>
		));
		const select = document.querySelector('sl-select[label="Range"]');
		if (!(select instanceof HTMLElement)) throw new Error("no Range select");
		Object.assign(select, { value: "3m" });
		select.dispatchEvent(new Event("sl-change", { bubbles: true }));
		await waitFor(() => expect(saved).toHaveLength(1));
		expect(saved[0]).toMatchObject({ type: "line-chart", range: "3m" });
	});
});

describe("notebook market data context", () => {
	it("loads market data only while the notebook has market widgets", async () => {
		const fixtures = marketFixtures();
		const market = freshMarket(defaultHomeSeries(false));
		mountPanel([fixtures.metric], market, null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		// The Home metric renders the fixture numbers through the live context.
		await waitFor(() => expect(articleById("nb-metric").textContent).toContain("15.41"), {
			timeout: 10_000,
		});
		expect(backend.requestsTo("GET", MARKET_DATA)).not.toHaveLength(0);
		cleanup();

		const plain: NotebookWidget[] = [
			marketWidget({
				widgetId: "nb-text",
				type: "text",
				title: "Notes",
				size: "medium",
				text: "Just notes.",
				...STAMP,
			}),
		];
		mountPanel(plain, freshMarket(defaultHomeSeries(false)), null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		// A notebook without market widgets loads nothing.
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(backend.requestsTo("GET", MARKET_DATA)).toHaveLength(0);
	});

	it("reloads when the series set changes, not on every edit", async () => {
		const fixtures = marketFixtures();
		const session = mountPanel([fixtures.chart], freshMarket(defaultHomeSeries(false)), null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		await waitFor(() => expect(backend.requestsTo("GET", MARKET_DATA)).toHaveLength(1), {
			timeout: 10_000,
		});

		// A title edit keeps the series set: no reload.
		await session.edit((current) =>
			current.map((entry) =>
				entry.widgetId === "nb-chart" ? { ...entry, title: "Renamed" } : entry,
			),
		);
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(backend.requestsTo("GET", MARKET_DATA)).toHaveLength(1);

		// A new series reloads.
		await session.edit((current) =>
			current.map((entry) =>
				entry.widgetId === "nb-chart" && entry.type === "line-chart"
					? { ...entry, seriesIds: ["fred:SP500"] }
					: entry,
			),
		);
		await waitFor(() => expect(backend.requestsTo("GET", MARKET_DATA)).toHaveLength(2), {
			timeout: 10_000,
		});
	});

	it("queues one refresh for a never-refreshed series, once per series set", async () => {
		const fixtures = marketFixtures();
		const series = defaultHomeSeries(false).map((entry): MarketSeries => {
			if (entry.seriesId !== "fred:VIXCLS") return entry;
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
		});
		const market = freshMarket(series);
		const session = mountPanel([fixtures.metric], market, null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		// One automatic refresh for the never-refreshed series…
		await waitFor(() => expect(backend.requestsTo("POST", /\/home\/refresh$/)).toHaveLength(1), {
			timeout: 10_000,
		});
		// ADR-0039: it fetches only the series without data.
		expect(backend.requestsTo("POST", /\/home\/refresh$/)[0]?.body).toEqual({
			scope: "unrefreshed",
		});
		// …and never a second one for the same set, even across further loads.
		await session.edit((current) =>
			current.map((entry) =>
				entry.widgetId === "nb-metric" ? { ...entry, title: "VIX again" } : entry,
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(backend.requestsTo("POST", /\/home\/refresh$/)).toHaveLength(1);
		// The widget shows Home's own unavailable state until the refresh lands.
		expect(articleById("nb-metric").textContent).toContain("unavailable");
	});

	it("asks for everything when a series the notebook shows is stale (ADR-0039)", async () => {
		// At the pinned visit time the stale fixture stamps (2026-10-10) are two days old.
		const fixtures = marketFixtures();
		const series = defaultHomeSeries(true).map((entry): MarketSeries => {
			if (entry.seriesId !== "fred:VIXCLS") return entry;
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
		});
		mountPanel([fixtures.metric, fixtures.stocks], freshMarket(series), null);
		await waitFor(() => expect(articles()).toHaveLength(2), { timeout: 10_000 });
		await waitFor(() => expect(backend.requestsTo("POST", /\/home\/refresh$/)).toHaveLength(1), {
			timeout: 10_000,
		});
		// One job for everything, instead of a narrow one followed by Home's full one.
		expect(backend.requestsTo("POST", /\/home\/refresh$/)[0]?.body).toEqual({ scope: "all" });
	});

	it("queues a refresh of everything when a shown series is stale, as Home does (ADR-0044 §4)", async () => {
		const fixtures = marketFixtures();
		// Every series has data, refreshed two days before the pinned visit.
		mountPanel([fixtures.metric], freshMarket(defaultHomeSeries(true)), null);
		await waitFor(() => expect(backend.requestsTo("POST", REFRESH)).toHaveLength(1), {
			timeout: 10_000,
		});
		expect(backend.requestsTo("POST", REFRESH)[0]?.body).toEqual({ scope: "all" });
		// The stale widget keeps showing its stored numbers meanwhile.
		expect(articleById("nb-metric").textContent).toContain("15.41");
	});

	it("queues nothing while every series shown is fresh", async () => {
		const fixtures = marketFixtures();
		mountPanel([fixtures.metric, fixtures.stocks], freshMarket(defaultHomeSeries(false)), null);
		await waitFor(() => expect(backend.requestsTo("GET", MARKET_DATA)).toHaveLength(1), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(backend.requestsTo("POST", REFRESH)).toHaveLength(0);
	});

	it("never queues while a refresh is active, even with stale data", async () => {
		const fixtures = marketFixtures();
		const market = freshMarket(defaultHomeSeries(true));
		market.activeRunId = "run_market_elsewhere";
		market.runState = "running";
		mountPanel([fixtures.metric], market, null);
		await waitFor(() => expect(backend.requestsTo("GET", MARKET_DATA)).not.toHaveLength(0), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(backend.requestsTo("POST", REFRESH)).toHaveLength(0);
	});

	it("re-checks on every return to the page, at most once per stamp set (ADR-0044 §4)", async () => {
		const fixtures = marketFixtures();
		const market = freshMarket(defaultHomeSeries(false));
		const visibility = createControllableVisibility();
		const returnToPage = (): void => {
			visibility.setVisible(false);
			visibility.setVisible(true);
		};
		const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
		mountPanel([fixtures.metric], market, null, visibility);
		await waitFor(() => expect(backend.requestsTo("GET", MARKET_DATA)).toHaveLength(1), {
			timeout: 10_000,
		});
		await settle();
		expect(backend.requestsTo("POST", REFRESH)).toHaveLength(0);
		// A queued refresh that stamps nothing (it ended before the next read
		// without storing anything, as a failing provider would leave it).
		backend.on("POST", REFRESH, () => {
			market.refreshCount += 1;
			return jsonResponse(
				{
					run: makeRun({
						runId: `run_market_${market.refreshCount}`,
						kind: "market-refresh",
						request: null,
						workspaceId: null,
						state: "pending",
					}),
				},
				{ status: 202 },
			);
		});

		// Forty minutes on, the 11:50 stamps are stale: the return re-reads and queues.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:40:00Z"));
		returnToPage();
		await waitFor(() => expect(backend.requestsTo("POST", REFRESH)).toHaveLength(1), {
			timeout: 10_000,
		});
		expect(backend.requestsTo("POST", REFRESH)[0]?.body).toEqual({ scope: "all" });

		// The same stale stamps — after the queue's own re-read and on another
		// return — never queue twice: the provider is not asked in a loop.
		const readsBefore = backend.requestsTo("GET", MARKET_DATA).length;
		returnToPage();
		await waitFor(
			() => expect(backend.requestsTo("GET", MARKET_DATA).length).toBeGreaterThan(readsBefore),
			{ timeout: 10_000 },
		);
		await settle();
		expect(backend.requestsTo("POST", REFRESH)).toHaveLength(1);

		// The refresh lands (every series stamped): fresh, nothing to do.
		market.series = market.series.map((entry) => ({
			...entry,
			lastRefreshedAt: "2026-10-12T12:41:00Z",
		}));
		returnToPage();
		await settle();
		expect(backend.requestsTo("POST", REFRESH)).toHaveLength(1);

		// Forty minutes later that new stamp set is stale in turn: one more refresh.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T13:21:00Z"));
		returnToPage();
		await waitFor(() => expect(backend.requestsTo("POST", REFRESH)).toHaveLength(2), {
			timeout: 10_000,
		});
		// A hidden page never re-checks.
		visibility.setVisible(false);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T15:00:00Z"));
		await settle();
		expect(backend.requestsTo("POST", REFRESH)).toHaveLength(2);
	});

	/**
	 * The notebook market context alone over a scripted market-data route:
	 * each refresh "runs" until the next read, then stamps only the series
	 * `stampedByRefresh` names — as a runner does for a series past its claim
	 * limit, which the page is still served.
	 */
	function scriptedNotebook(options: {
		readonly series: MarketSeries[];
		readonly stampedByRefresh: readonly string[];
		readonly visibility?: VisibilitySource;
		readonly failPosts?: number;
		/** How old the stamp a run writes is (a run outlasting 30 minutes writes a stale one). */
		readonly stampAgeMs?: number;
		/** The notebook's widgets, live (default: the metric and the stock table). */
		readonly widgets?: () => readonly NotebookWidget[];
	}) {
		const state = {
			series: options.series,
			active: null as string | null,
			posts: [] as unknown[],
			failPosts: options.failPosts ?? 0,
		};
		const fake = createFakeBackend();
		const etag = () =>
			`"s-${state.active ?? "idle"}-${state.series.map((entry) => entry.lastRefreshedAt).join(",")}"`;
		fake.on("GET", MARKET_DATA, (request) => {
			if (state.active !== null) {
				state.active = null;
				// Distinct per run, as every real run writes its own fetch time.
				const at = new Date(
					Date.now() - (options.stampAgeMs ?? 60_000) + state.posts.length,
				).toISOString();
				state.series = state.series.map((entry) =>
					options.stampedByRefresh.includes(entry.seriesId)
						? { ...entry, lastRefreshedAt: at }
						: entry,
				);
			}
			if (request.headers["if-none-match"] === etag()) return new Response(null, { status: 304 });
			return jsonResponse(
				{
					series: state.series,
					refresh: {
						activeRunId: state.active,
						activeRunState: state.active === null ? null : "running",
						lastSucceededAt: null,
						lastFailure: null,
					},
				},
				{ headers: { ETag: etag() } },
			);
		});
		fake.on("POST", REFRESH, (request) => {
			state.posts.push(request.body);
			if (state.failPosts > 0) {
				state.failPosts -= 1;
				return errorResponse(500, "INTERNAL", "boom (refresh fixture)");
			}
			state.active = `run_${state.posts.length}`;
			return jsonResponse(
				{
					run: makeRun({
						runId: state.active,
						kind: "market-refresh",
						request: null,
						workspaceId: null,
						state: "pending",
					}),
				},
				{ status: 202 },
			);
		});
		const fixtures = marketFixtures();
		const api = createApiClient({ fetch: fake.fetch });
		rootDisposers.push(
			createRoot((dispose) => {
				createNotebookMarketContext({
					api,
					workspaceId: () => WORKSPACE_ID,
					widgets: options.widgets ?? (() => [fixtures.metric, fixtures.stocks]),
					visibility: options.visibility ?? ALWAYS_VISIBLE,
				});
				return dispose;
			}),
		);
		return { state, fake };
	}

	/** Every fixture series fresh at the pinned visit, AAPL stamped two days before. */
	const withStaleAapl = (): MarketSeries[] =>
		defaultHomeSeries(false).map((entry) =>
			entry.seriesId === "twelve-data:AAPL"
				? { ...entry, lastRefreshedAt: "2026-10-10T00:00:00Z" }
				: entry,
		);

	it("never loops on a stale stamp no refresh updates: one refresh, not one per read (ADR-0044 §4)", async () => {
		// The review probe: the refresh restamps VIX (and the rest) but never
		// AAPL; keyed on every stamp, each read after a run queued again.
		const { state } = scriptedNotebook({
			series: withStaleAapl(),
			stampedByRefresh: ["fred:VIXCLS"],
		});
		await waitFor(() => expect(state.posts).toHaveLength(1), { timeout: 10_000 });
		expect(state.posts[0]).toEqual({ scope: "all" });
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		expect(state.posts).toHaveLength(1);
		expect(state.active).toBeNull();
	});

	it("asks again for a stamp a failed job left stale, but only after 30 minutes", async () => {
		// The review probe: the queued job fails as a whole and stamps nothing.
		const visibility = createControllableVisibility();
		const returnToPage = (): void => {
			visibility.setVisible(false);
			visibility.setVisible(true);
		};
		const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
		// AAPL is stale; VIX was stamped "12:20" (fresh until 12:50), so only
		// AAPL motivates refreshes here.
		const { state } = scriptedNotebook({
			series: withStaleAapl().map((entry) =>
				entry.seriesId === "fred:VIXCLS"
					? { ...entry, lastRefreshedAt: "2026-10-12T12:20:00Z" }
					: entry,
			),
			stampedByRefresh: [],
			visibility,
		});
		await waitFor(() => expect(state.posts).toHaveLength(1), { timeout: 10_000 });
		await settle();
		// 12:29: the same stale stamp, asked for at 12:00 — quiet.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:29:00Z"));
		returnToPage();
		await settle();
		expect(state.posts).toHaveLength(1);
		// 12:31: that ask has expired, so the page asks once more…
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:31:00Z"));
		returnToPage();
		await waitFor(() => expect(state.posts).toHaveLength(2), { timeout: 10_000 });
		// …and not again within the next 30 minutes (no loop; VIX is still fresh at 12:49).
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:49:00Z"));
		returnToPage();
		await settle();
		expect(state.posts).toHaveLength(2);
	});

	it("spaces staleness refreshes 30 minutes apart when every run writes an already-stale stamp", async () => {
		// The review probe: runs outlasting 30 minutes stamp VIX 40 minutes in
		// the past — a new, already stale stamp after every run.
		const visibility = createControllableVisibility();
		const returnToPage = (): void => {
			visibility.setVisible(false);
			visibility.setVisible(true);
		};
		const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
		const { state } = scriptedNotebook({
			series: withStaleAapl(),
			stampedByRefresh: ["fred:VIXCLS"],
			stampAgeMs: 40 * 60_000,
			visibility,
		});
		await waitFor(() => expect(state.posts).toHaveLength(1), { timeout: 10_000 });
		await settle();
		returnToPage();
		await settle();
		// No time passed: one refresh, not one per run.
		expect(state.posts).toHaveLength(1);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:30:00Z"));
		returnToPage();
		await settle();
		expect(state.posts).toHaveLength(1);
		// Past 30 minutes since that queue: the next one.
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-12T12:31:00Z"));
		returnToPage();
		await waitFor(() => expect(state.posts).toHaveLength(2), { timeout: 10_000 });
		await settle();
		returnToPage();
		await settle();
		expect(state.posts).toHaveLength(2);
	});

	it("still queues a never-refreshed series at once while staleness refreshes are spaced", async () => {
		const fixtures = marketFixtures();
		const [widgets, setWidgets] = createSignal<readonly NotebookWidget[]>([fixtures.metric]);
		const { state } = scriptedNotebook({
			series: withStaleAapl().map((entry) =>
				entry.seriesId === "fred:VIXCLS"
					? { ...entry, lastRefreshedAt: "2026-10-12T11:00:00Z" }
					: entry,
			),
			stampedByRefresh: [],
			widgets,
		});
		// The stale VIX: one staleness refresh, then spacing holds the next.
		await waitFor(() => expect(state.posts).toHaveLength(1), { timeout: 10_000 });
		expect(state.posts[0]).toEqual({ scope: "all" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		// The assistant adds a widget for a series the data does not hold yet.
		setWidgets([
			fixtures.metric,
			marketWidget({
				widgetId: "nb-new",
				type: "market-metric",
				title: "New",
				size: "small",
				seriesId: "fred:NBNEWSERIES1",
				...STAMP,
			}),
		]);
		await waitFor(() => expect(state.posts).toHaveLength(2), { timeout: 10_000 });
		// Only the series without data, at once.
		expect(state.posts[1]).toEqual({ scope: "unrefreshed" });
	});

	it("asks again after a refresh request that failed", async () => {
		const visibility = createControllableVisibility();
		const { state, fake } = scriptedNotebook({
			series: withStaleAapl(),
			stampedByRefresh: ["twelve-data:AAPL"],
			visibility,
			failPosts: 1,
		});
		await waitFor(() => expect(state.posts).toHaveLength(1), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 300));
		// The failed request was never queued, so the stale stamp is not "asked":
		// the next check (a return to the page) asks again.
		const readsBefore = fake.requestsTo("GET", MARKET_DATA).length;
		visibility.setVisible(false);
		visibility.setVisible(true);
		await waitFor(() => expect(state.posts).toHaveLength(2), { timeout: 10_000 });
		expect(fake.requestsTo("GET", MARKET_DATA).length).toBeGreaterThan(readsBefore);
		expect(state.posts[1]).toEqual({ scope: "all" });
	});

	it("refreshes nothing while the panel is not shown, and checks the moment it is", async () => {
		const tab = createControllableVisibility();
		let panelShown = false;
		const panel: VisibilitySource = {
			isVisible: () => tab.isVisible() && panelShown,
			subscribe: tab.subscribe,
		};
		const { state, fake } = scriptedNotebook({
			series: withStaleAapl(),
			stampedByRefresh: ["twelve-data:AAPL"],
			visibility: panel,
		});
		// The data still loads (the widgets render), but no refresh is asked for.
		await waitFor(() => expect(fake.requestsTo("GET", MARKET_DATA)).not.toHaveLength(0), {
			timeout: 10_000,
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(state.posts).toHaveLength(0);
		panelShown = true;
		tab.setVisible(true);
		await waitFor(() => expect(state.posts).toHaveLength(1), { timeout: 10_000 });
	});

	it("saves a line-chart range change from the Home chart in the notebook", async () => {
		const fixtures = marketFixtures();
		mountPanel([fixtures.chart], freshMarket(defaultHomeSeries(false)), null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		const chart = articleById("nb-chart");
		await waitFor(() => expect(chart.querySelector("svg[role='img']")).not.toBeNull(), {
			timeout: 10_000,
		});
		const range = chart.querySelector('sl-select[label="Range"]');
		if (!(range instanceof HTMLElement)) throw new Error("no Range select in the notebook chart");
		setShoelaceValue(range, "3m", "sl-change");
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1), {
			timeout: 10_000,
		});
		const body = backend.requestsTo("PUT", NOTEBOOK_PUT)[0]?.body as {
			notebook: { widgets: { widgetId: string; range: string }[] };
		};
		expect(body.notebook.widgets.find((entry) => entry.widgetId === "nb-chart")?.range).toBe("3m");
	});

	it("loads the watchlist only with an earnings calendar, with Try again on failure", async () => {
		const fixtures = marketFixtures();
		const watch: WatchServerState = { response: watchlistWithAapl(), failures: 1, count: 0 };
		mountPanel([fixtures.calendar], freshMarket(defaultHomeSeries(false)), watch);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		// The first watchlist load fails: Home's own error state with "Try again".
		await waitFor(
			() => expect(articleById("nb-calendar").textContent).toContain("Could not load"),
			{
				timeout: 10_000,
			},
		);
		fireEvent.click(within(articleById("nb-calendar")).getByRole("button", { name: "Try again" }));
		// Retried: the calendar renders the fixture announcement.
		await waitFor(() => expect(articleById("nb-calendar").textContent).toContain("AAPL"), {
			timeout: 10_000,
		});
		expect(watch.count).toBeGreaterThanOrEqual(2);
		cleanup();

		// No calendar widget: the watchlist is never loaded.
		const watch2: WatchServerState = { response: watchlistWithAapl(), failures: 0, count: 0 };
		mountPanel([fixtures.metric], freshMarket(defaultHomeSeries(false)), watch2);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(backend.requestsTo("GET", WATCHLIST_GET)).toHaveLength(0);
	});

	it("the calendar's Refresh button asks for every stock (ADR-0039)", async () => {
		const fixtures = marketFixtures();
		const watch: WatchServerState = { response: watchlistWithAapl(), failures: 0, count: 0 };
		mountPanel([fixtures.calendar], freshMarket(defaultHomeSeries(false)), watch);
		const button = await waitFor(
			() =>
				within(articleById("nb-calendar")).getByRole("button", { name: "Refresh earnings dates" }),
			{ timeout: 10_000 },
		);
		fireEvent.click(button);
		await waitFor(() =>
			expect(backend.requestsTo("POST", /\/watchlist\/refresh$/)).toHaveLength(1),
		);
		expect(backend.requestsTo("POST", /\/watchlist\/refresh$/)[0]?.body).toEqual({
			scope: "all",
		});
	});
});

describe("notebook market add and edit", () => {
	it("lists the six market types after the existing four, opening Home's form", async () => {
		const fixtures = marketFixtures();
		mountPanel([fixtures.metric], freshMarket(defaultHomeSeries(false)), null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
		for (const type of ["text", "metric", "chart", "table"] as const) {
			await waitFor(() =>
				expect(screen.getByRole("menuitem", { name: WIDGET_TYPE_META[type].label })).toBeDefined(),
			);
		}
		const marketLabels = [
			"Market metric",
			"Line chart",
			"Stock table",
			"Indicator table",
			"Earnings calendar",
			"Watchlist prices",
		];
		for (const label of marketLabels) {
			await waitFor(() => expect(screen.getByRole("menuitem", { name: label })).toBeDefined());
		}
		// The market entries read their labels from the contract's one table.
		expect(WIDGET_TYPE_META["market-metric"].label).toBe("Market metric");
		expect(WIDGET_TYPE_META["earnings-calendar"].label).toBe("Earnings calendar");

		// Adding a line chart opens Home's form with the type preset.
		fireEvent.click(screen.getByRole("menuitem", { name: "Line chart" }));
		const dialog = await waitFor(() => {
			const found = document.querySelector("sl-dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no market dialog yet");
			return found;
		});
		expect(dialogControl(dialog, "sl-select", "Series")).toBeDefined();
		expect(dialogControl(dialog, "sl-select", "Range")).toBeDefined();
		// The form saves through the notebook: title plus one fixture series.
		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "Notebook VIX", "sl-input");
		setShoelaceValue(dialogControl(dialog, "sl-select", "Series"), ["fred:VIXCLS"], "sl-change");
		await waitFor(() => {
			if (dialog.querySelector('ul[aria-label="Before you can save this widget"]') !== null) {
				throw new Error("problems are still listed");
			}
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Add widget" }));
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1), {
			timeout: 10_000,
		});
		const body = backend.requestsTo("PUT", NOTEBOOK_PUT)[0]?.body as {
			notebook: { widgets: NotebookWidget[] };
		};
		const added = body.notebook.widgets.find((entry) => entry.title === "Notebook VIX");
		if (added === undefined) throw new Error("the added widget was not saved");
		expect(added.type).toBe("line-chart");
		expect(added.origin.kind).toBe("owner");
		await waitFor(() => expect(articles()).toHaveLength(2), { timeout: 10_000 });
	});

	it("opens the same form on Edit of a market widget", async () => {
		const fixtures = marketFixtures();
		mountPanel([fixtures.metric], freshMarket(defaultHomeSeries(false)), null);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		const article = articleById("nb-metric");
		const actions = article.querySelector("button[data-widget-actions]");
		if (!(actions instanceof HTMLElement)) throw new Error("no widget actions button");
		fireEvent.click(actions);
		const edit = await waitFor(() =>
			within(lastOpenMenu()).getByRole("menuitem", { name: "Edit…" }),
		);
		fireEvent.click(edit);
		const dialog = await waitFor(() => {
			const found = document.querySelector("sl-dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no market edit dialog yet");
			return found;
		});
		// Home's form with the widget's series, saving back to the notebook.
		expect(dialogControl(dialog, "sl-select", "Series")).toBeDefined();
		setShoelaceValue(dialogControl(dialog, "sl-input", "Title"), "VIX edited", "sl-input");
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1), {
			timeout: 10_000,
		});
		await waitFor(() => expect(articleById("nb-metric").textContent).toContain("15.41"), {
			timeout: 10_000,
		});
	});
});

/** The AAPL watchlist with one list holding AAPL (ADR-0040). */
function watchlistWithAaplList() {
	return watchlistResponseSchema.parse({
		...watchlistWithAapl(),
		lists: [
			{
				listId: "list_tech",
				title: "Tech",
				stockIds: ["us:AAPL"],
				version: 1,
				createdAt: "2026-10-12T00:00:00Z",
				updatedAt: "2026-10-12T00:00:00Z",
			},
		],
	});
}

describe("notebook Watchlist prices widget (ADR-0040)", () => {
	const pricesWidget = (): NotebookWidget =>
		marketWidget({
			widgetId: "nb-prices",
			type: "watchlist-prices",
			title: "Tech",
			size: "medium",
			listId: "list_tech",
			...STAMP,
		});

	it("loads the watchlist before the market data, and its list's series join the one automatic refresh", async () => {
		const series = defaultHomeSeries(false).map((entry): MarketSeries => {
			if (entry.seriesId !== "twelve-data:AAPL") return entry;
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
		});
		const watch: WatchServerState = { response: watchlistWithAaplList(), failures: 0, count: 0 };
		mountPanel([pricesWidget()], freshMarket(series), watch);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		await waitFor(() => expect(backend.requestsTo("POST", /\/home\/refresh$/)).toHaveLength(1), {
			timeout: 10_000,
		});
		expect(backend.requestsTo("POST", /\/home\/refresh$/)[0]?.body).toEqual({
			scope: "unrefreshed",
		});
		// The market read waited for the lists: the watchlist came first.
		const paths = backend.requests.map((request) => request.path);
		const firstWatch = paths.findIndex((path) => WATCHLIST_GET.test(path));
		const firstMarket = paths.findIndex((path) => MARKET_DATA.test(path));
		expect(firstWatch).toBeGreaterThanOrEqual(0);
		expect(firstWatch).toBeLessThan(firstMarket);
		await waitFor(() => expect(articleById("nb-prices").textContent).toContain("Tech"));
		expect(articleById("nb-prices").textContent).toContain("AAPL");
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(backend.requestsTo("POST", /\/home\/refresh$/)).toHaveLength(1);
	});

	it("adds one from the add menu's list dialog, with no Edit… afterwards", async () => {
		const fixtures = marketFixtures();
		const watch: WatchServerState = { response: watchlistWithAaplList(), failures: 0, count: 0 };
		mountPanel([fixtures.metric], freshMarket(defaultHomeSeries(false)), watch);
		await waitFor(() => expect(articles()).toHaveLength(1), { timeout: 10_000 });
		fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
		fireEvent.click(within(lastOpenMenu()).getByRole("menuitem", { name: "Watchlist prices" }));
		const dialog = await screen.findByRole("dialog", { name: "Choose a list" });
		const list = await within(dialog).findByRole("list", { name: "Your Watchlist lists" });
		const choice = within(list).getByRole("button");
		expect(choice.textContent).toBe("Tech1 stock");
		fireEvent.click(choice);
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1), {
			timeout: 10_000,
		});
		const body = backend.requestsTo("PUT", NOTEBOOK_PUT)[0]?.body as {
			notebook: { widgets: NotebookWidget[] };
		};
		expect(body.notebook.widgets.at(-1)).toMatchObject({
			type: "watchlist-prices",
			listId: "list_tech",
			title: "Tech",
			size: "medium",
			origin: { kind: "owner" },
		});
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		await waitFor(() => expect(articles()).toHaveLength(2), { timeout: 10_000 });
		const added = articles().at(-1);
		if (added === undefined) throw new Error("no new widget");
		await waitFor(() => expect(added.textContent).toContain("1 stock"));
		const actions = added.querySelector("button[data-widget-actions]");
		if (!(actions instanceof HTMLElement)) throw new Error("no widget actions button");
		fireEvent.click(actions);
		const names = within(lastOpenMenu())
			.getAllByRole("menuitem")
			.map((item) => item.textContent?.trim());
		expect(names).not.toContain("Edit…");
	});
});
