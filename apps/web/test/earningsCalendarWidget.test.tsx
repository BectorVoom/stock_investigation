import type { WatchlistResponse } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { type Accessor, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api/client.ts";
import type { ApiFailure } from "../src/api/http.ts";
import { EarningsCalendarWidget } from "../src/home/widgets/EarningsCalendarWidget.tsx";
import { createFakeBackend, type FakeBackend } from "./fakeBackend.ts";

const NOW_MS = Date.now();
/** A UTC date `days` from today, so fixtures stay upcoming on any day. */
function isoInDays(days: number): string {
	return new Date(NOW_MS + days * 86_400_000).toISOString().slice(0, 10);
}
/** The fixture's upcoming announcement date (the widget compares it to today). */
const AAPL_DATE = isoInDays(16);
const AAPL_COMPACT = AAPL_DATE.replaceAll("-", "");
const AAPL_NEXT_COMPACT = isoInDays(17).replaceAll("-", "");

const WATCHLIST: WatchlistResponse = {
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
			lastRefreshedAt: "2026-10-12T12:00:00Z",
			retrievedAt: "2026-10-12T12:00:00Z",
			unavailable: null,
			events: [
				{
					periodKey: "2026-q4",
					announcementDate: AAPL_DATE,
					fiscalPeriodLabel: "Q4 2026",
					fiscalPeriodEnd: null,
					timing: "after-close",
				},
				{
					periodKey: "fy2027-03-31-second-quarter",
					announcementDate: null,
					fiscalPeriodLabel: "Second quarter",
					fiscalPeriodEnd: "2027-03-31",
					timing: "unknown",
				},
			],
		},
		{
			stockId: "jp:7203",
			market: "JP",
			symbol: "7203",
			name: null,
			addedAt: "2026-10-12T00:00:00Z",
			source: "jpx",
			publisher: "Japan Exchange Group (JPX)",
			sourceUrl: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
			lastRefreshedAt: "2026-10-12T12:00:00Z",
			retrievedAt: "2026-10-12T12:00:00Z",
			unavailable: { code: "NO_SCHEDULED_DATE", reason: "The source lists no upcoming date." },
			events: [],
		},
	],
	refresh: {
		activeRunId: null,
		activeRunState: null,
		lastSucceededAt: "2026-10-12T12:00:00Z",
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
};

let backend: FakeBackend;

function mount(
	watchlist: WatchlistResponse | null,
	daysAhead: 30 | 60 | 90 | 180 = 90,
	error: { code: string; message: string } | null = null,
	hooks: {
		readonly onRefreshEarnings?: () => void;
		readonly earningsRefreshBusy?: Accessor<boolean>;
	} = {},
) {
	const onRefreshEarnings =
		hooks.onRefreshEarnings ??
		(() => {
			throw new Error("refresh was not expected in this test");
		});
	const [busy, setBusy] = createSignal(false);
	const earningsRefreshBusy = hooks.earningsRefreshBusy ?? busy;
	const client = {
		downloadWatchlistIcs: async () => {
			const response = await backend.fetch("/api/v1/watchlist/calendar.ics", { method: "GET" });
			if (!response.ok) {
				return {
					ok: false as const,
					error: {
						kind: "api" as const,
						code: "INTERNAL" as const,
						status: response.status,
						message: "boom",
						detail: null,
						issues: [],
					},
				};
			}
			return { ok: true as const, value: await response.text() };
		},
	} as unknown as ApiClient;
	const [current, setCurrent] = createSignal(watchlist);
	const [failure, setFailure] = createSignal<ApiFailure | null>(
		error === null
			? null
			: {
					kind: "api",
					code: "INTERNAL",
					status: 500,
					message: error.message,
					detail: null,
					issues: [],
				},
	);
	render(() => (
		<EarningsCalendarWidget
			widget={{
				type: "earnings-calendar",
				widgetId: "w-cal",
				title: "Earnings",
				size: "large",
				daysAhead,
			}}
			watchlist={current}
			watchlistError={failure}
			onRetryWatchlist={() => setFailure(null)}
			onRefreshEarnings={onRefreshEarnings}
			earningsRefreshBusy={earningsRefreshBusy}
			api={client}
		/>
	));
	return { setCurrent, setBusy };
}

afterEach(cleanup);

describe("EarningsCalendarWidget", () => {
	it("tables the upcoming dates with calendar links and the provenance line", () => {
		backend = createFakeBackend();
		mount(WATCHLIST);
		const table = screen.getByRole("table", { name: "Earnings: upcoming earnings announcements" });
		const row = within(table).getByRole("row", { name: /AAPL/ });
		expect(row.textContent).toContain(AAPL_DATE);
		expect(row.textContent).toContain("Q4 2026");
		expect(row.textContent).toContain("after market close");
		expect(
			within(row).getByRole("link", { name: "Add to Google Calendar" }).getAttribute("href"),
		).toContain(`${AAPL_COMPACT}/${AAPL_NEXT_COMPACT}`);
		expect(
			within(row).getByRole("link", { name: "Add to Outlook" }).getAttribute("href"),
		).toContain(`startdt=${AAPL_DATE}`);
		expect(screen.getByText(/1 stock with no upcoming date/)).toBeTruthy();
		expect(screen.getByText(/7203/)).toBeTruthy();
		expect(screen.getByText(/The source lists no upcoming date/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Finnhub" }).getAttribute("href")).toBe(
			"https://finnhub.io/",
		);
		expect(screen.getByText(/retrieved/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Manage watchlist" }).getAttribute("href")).toBe(
			"#/watchlist",
		);
	});

	it("keeps only the window: past the fixture date the table is empty", () => {
		backend = createFakeBackend();
		vi.useFakeTimers();
		try {
			// 44 days past the fixture date: outside the 30-day window and
			// stated as passed, on any day the suite runs.
			vi.setSystemTime(new Date(NOW_MS + 60 * 86_400_000));
			mount(WATCHLIST, 30);
			expect(screen.queryByRole("table")).toBe(null);
			expect(screen.getByText("No announcement in the next 30 days.")).toBeTruthy();
			expect(screen.getByText(/2 stocks with no upcoming date/)).toBeTruthy();
			// The stored date has passed: stated as text, with no calendar links.
			expect(screen.getByText(/the stored dates have passed/)).toBeTruthy();
			expect(screen.queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
			expect(screen.queryByRole("link", { name: "Add to Outlook" })).toBe(null);
		} finally {
			vi.useRealTimers();
		}
	});

	it("offers no calendar links for events without a retrieved stamp", () => {
		backend = createFakeBackend();
		const first = WATCHLIST.stocks[0];
		if (first === undefined) throw new Error("expected the fixture stock");
		mount({
			...WATCHLIST,
			stocks: [{ ...first, retrievedAt: null, lastRefreshedAt: null }],
		});
		const table = screen.getByRole("table", {
			name: "Earnings: upcoming earnings announcements",
		});
		expect(within(table).getByRole("row", { name: /AAPL/ }).textContent).toContain(AAPL_DATE);
		expect(screen.queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(screen.queryByRole("link", { name: "Add to Outlook" })).toBe(null);
	});

	it("shows an empty state pointing at the Watchlist page when no stock is registered", () => {
		backend = createFakeBackend();
		mount({ ...WATCHLIST, stocks: [] });
		expect(screen.getByText(/No stocks on the watchlist yet/)).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Add one on the Watchlist page" }).getAttribute("href"),
		).toBe("#/watchlist");
		expect(screen.queryByRole("table")).toBe(null);
	});

	it("shows the load error with Try again when the watchlist read failed", () => {
		backend = createFakeBackend();
		const retry = vi.fn();
		const [current, setCurrent] = createSignal<WatchlistResponse | null>(null);
		const [failure, setFailure] = createSignal<ApiFailure | null>({
			kind: "api",
			code: "INTERNAL",
			status: 500,
			message: "boom",
			detail: null,
			issues: [],
		});
		const client = { downloadWatchlistIcs: async () => ({ ok: true as const, value: "" }) };
		render(() => (
			<EarningsCalendarWidget
				widget={{
					type: "earnings-calendar",
					widgetId: "w-cal",
					title: "Earnings",
					size: "large",
					daysAhead: 90,
				}}
				watchlist={current}
				watchlistError={failure}
				onRetryWatchlist={() => {
					retry();
					setFailure(null);
					setCurrent(WATCHLIST);
				}}
				onRefreshEarnings={() => {}}
				earningsRefreshBusy={() => false}
				api={client as unknown as ApiClient}
			/>
		));
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("Could not load earnings dates.");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(retry).toHaveBeenCalled();
		expect(screen.getByRole("table")).toBeTruthy();
	});

	it("downloads the .ics through the API client", async () => {
		backend = createFakeBackend();
		backend.on(
			"GET",
			/^\/api\/v1\/watchlist\/calendar\.ics$/,
			() =>
				new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
					status: 200,
					headers: { "Content-Type": "text/calendar; charset=utf-8" },
				}),
		);
		Object.defineProperty(URL, "createObjectURL", {
			value: () => "blob:fake",
			configurable: true,
		});
		Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		try {
			mount(WATCHLIST);
			fireEvent.click(screen.getByRole("button", { name: "Download calendar file (.ics)" }));
			await waitFor(() => {
				expect(click).toHaveBeenCalled();
			});
			expect(backend.requestsTo("GET", /^\/api\/v1\/watchlist\/calendar\.ics$/)).toHaveLength(1);
		} finally {
			click.mockRestore();
		}
	});

	it("stays reactive: replacing the watchlist value updates the rows", async () => {
		backend = createFakeBackend();
		const { setCurrent } = mount(WATCHLIST);
		expect(screen.getByRole("table").textContent).toContain(AAPL_DATE);
		setCurrent({ ...WATCHLIST, stocks: [] });
		await waitFor(() => {
			expect(screen.queryByRole("table")).toBe(null);
		});
		expect(screen.getByText(/No stocks on the watchlist yet/)).toBeTruthy();
	});

	it("offers a Refresh button that calls back, disabled while busy or while a run is active", () => {
		backend = createFakeBackend();
		const refreshed = vi.fn();
		mount(WATCHLIST, 90, null, { onRefreshEarnings: refreshed });
		const button = screen.getByRole("button", { name: "Refresh earnings dates" });
		expect(button.hasAttribute("disabled")).toBe(false);
		fireEvent.click(button);
		expect(refreshed).toHaveBeenCalledTimes(1);
	});

	it("disables the Refresh button while a queue request is in flight", () => {
		backend = createFakeBackend();
		const { setBusy } = mount(WATCHLIST, 90, null, { onRefreshEarnings: () => {} });
		const button = screen.getByRole("button", { name: "Refresh earnings dates" });
		expect(button.hasAttribute("disabled")).toBe(false);
		setBusy(true);
		expect(
			screen.getByRole("button", { name: "Refresh earnings dates" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("shows the fetching status line and disables Refresh while a run is active", () => {
		backend = createFakeBackend();
		mount({
			...WATCHLIST,
			refresh: {
				activeRunId: "run_earnings_1",
				activeRunState: "claimed",
				lastSucceededAt: null,
				lastFailure: null,
			},
		});
		expect(screen.getByText(/Fetching earnings dates…/)).toBeTruthy();
		expect(screen.getByText(/claimed/)).toBeTruthy();
		expect(screen.getByText(/stays queued until it reconnects/)).toBeTruthy();
		expect(
			screen.getByRole("button", { name: "Refresh earnings dates" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("says not fetched yet for never-refreshed stocks, never no announcement", () => {
		backend = createFakeBackend();
		const first = WATCHLIST.stocks[0];
		if (first === undefined) throw new Error("expected the fixture stock");
		mount({
			...WATCHLIST,
			stocks: [
				{
					...first,
					lastRefreshedAt: null,
					retrievedAt: null,
					unavailable: null,
					events: [],
				},
			],
		});
		expect(screen.queryByRole("table")).toBe(null);
		expect(screen.getByText("Earnings dates have not been fetched yet.")).toBeTruthy();
		expect(screen.queryByText(/No announcement in the next/)).toBe(null);
	});

	it("says no announcement only when every stock was refreshed at least once", () => {
		backend = createFakeBackend();
		const first = WATCHLIST.stocks[0];
		if (first === undefined) throw new Error("expected the fixture stock");
		mount({ ...WATCHLIST, stocks: [{ ...first, events: [] }] });
		expect(screen.queryByRole("table")).toBe(null);
		expect(screen.getByText("No announcement in the next 90 days.")).toBeTruthy();
	});
});
