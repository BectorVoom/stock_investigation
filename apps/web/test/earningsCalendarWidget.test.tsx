import type { WatchlistResponse } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { type Accessor, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api/client.ts";
import type { ApiFailure } from "../src/api/http.ts";
import { EarningsCalendarWidget } from "../src/home/widgets/EarningsCalendarWidget.tsx";

/**
 * A pinned "today" early in a month: the widget shows the current month's
 * grid, so a fixture date counted from the real clock fell into the next
 * month during the last 16 days of every month and the day-link tests failed.
 */
const NOW_MS = Date.parse("2026-10-05T12:00:00Z");
/** A UTC date `days` from the pinned today. */
function isoInDays(days: number): string {
	return new Date(NOW_MS + days * 86_400_000).toISOString().slice(0, 10);
}
/** The fixture's upcoming announcement date (the widget compares it to today). */
const AAPL_DATE = isoInDays(16);

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
			unavailable: {
				code: "NO_SCHEDULED_DATE",
				reason: "The source lists no upcoming date.",
				upstreamStatus: null,
			},
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
	const client = {} as unknown as ApiClient;
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

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW_MS);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("EarningsCalendarWidget", () => {
	it("shows the month grid with day links to the Watchlist page", () => {
		mount(WATCHLIST);
		const table = screen.getByRole("table");
		expect(table.textContent).toContain("earnings announcements");
		const day = screen.getByRole("link", { name: new RegExp(`${AAPL_DATE.slice(8, 10)} .*AAPL`) });
		expect(day.getAttribute("href")).toBe("#/watchlist");
	});

	it("lists at most 3 upcoming announcements with no per-row links", () => {
		mount(WATCHLIST);
		const next = screen.getByRole("heading", { name: "Next" });
		expect(next).toBeTruthy();
		const items = next.parentElement?.querySelectorAll("ul > li") ?? [];
		expect(items.length).toBeLessThanOrEqual(3);
		expect(screen.queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(screen.queryByRole("link", { name: "Add to Outlook" })).toBe(null);
	});

	it("caps the Next list at 3 when more dates fall in the window", () => {
		const first = WATCHLIST.stocks[0];
		if (first === undefined) throw new Error("expected the fixture stock");
		const stocks = [0, 1, 2, 3, 4].map((index) => ({
			...first,
			stockId: `us:SYM${index}`,
			symbol: `SYM${index}`,
			events: [
				{
					periodKey: `2026-q${index}`,
					announcementDate: isoInDays(10 + index),
					fiscalPeriodLabel: `Q${index} 2026`,
					fiscalPeriodEnd: null,
					timing: "after-close" as const,
				},
			],
		}));
		mount({ ...WATCHLIST, stocks });
		const next = screen.getByRole("heading", { name: "Next" });
		const items = next.parentElement?.querySelectorAll("ul > li") ?? [];
		expect(items).toHaveLength(3);
	});

	it("keeps one no-upcoming sentence linking to the Watchlist page, not a disclosure", () => {
		mount(WATCHLIST);
		expect(screen.getByText(/1 stock has no upcoming date/)).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "See them on the Watchlist page" }).getAttribute("href"),
		).toBe("#/watchlist");
		expect(screen.queryByText(/The source lists no upcoming date/)).toBe(null);
	});

	it("keeps one short provenance line with the publisher links and the retrieved date", () => {
		mount(WATCHLIST);
		expect(screen.getByText(/Sources:/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Finnhub" }).getAttribute("href")).toBe(
			"https://finnhub.io/",
		);
		expect(screen.getByText(/retrieved/)).toBeTruthy();
	});

	it("offers Refresh and Open Watchlist, and nothing else", () => {
		mount(WATCHLIST, 90, null, { onRefreshEarnings: () => {} });
		expect(screen.getByRole("button", { name: "Refresh earnings dates" })).toBeTruthy();
		expect(screen.getByRole("link", { name: "Open Watchlist" }).getAttribute("href")).toBe(
			"#/watchlist",
		);
		expect(screen.queryByRole("button", { name: "Download calendar file (.ics)" })).toBe(null);
		expect(screen.queryByRole("table", { name: /upcoming earnings announcements/ })).toBe(null);
	});

	it("tells the Google status on its single status line, never the auth URL", () => {
		mount({
			...WATCHLIST,
			googleCalendar: {
				...WATCHLIST.googleCalendar,
				status: "connecting",
				authUrl: "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=x",
				activeRunId: "run_google_1",
				activeRunState: "claimed",
				activeAction: "connect",
			},
		});
		expect(screen.getByText(/Google Calendar: connecting/)).toBeTruthy();
		expect(screen.queryByText(/accounts\.google\.com/)).toBe(null);
		expect(screen.queryByRole("link", { name: "Open Google sign-in" })).toBe(null);
	});

	it("names the Google sync time when connected and synced", () => {
		mount({
			...WATCHLIST,
			googleCalendar: {
				...WATCHLIST.googleCalendar,
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-10-12T10:00:00Z",
				lastSyncedAt: "2026-10-12T11:00:00Z",
				lastSync: { inserted: 1, updated: 0, deleted: 0, unchanged: 0 },
				inSync: true,
			},
		});
		expect(screen.getByText(/Google Calendar: synced/)).toBeTruthy();
	});

	it("points at Settings → Calendar when Google is not connected", () => {
		mount(WATCHLIST);
		expect(screen.getByText(/Google Calendar: not connected/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Connect it in Settings" }).getAttribute("href")).toBe(
			"#/settings/calendar",
		);
	});

	it("keeps only the window: past the fixture date the Next list is empty", () => {
		// 44 days past the fixture date: outside the 30-day window and
		// stated as passed, on any day the suite runs.
		const realNow = Date.now;
		try {
			Date.now = () => NOW_MS + 60 * 86_400_000;
			mount(WATCHLIST, 30);
			expect(screen.getByText("No announcement in the next 30 days.")).toBeTruthy();
			expect(screen.getByText(/2 stocks have no upcoming date/)).toBeTruthy();
			// The stored date has passed: stated as text, with no calendar links.
			expect(screen.queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
			expect(screen.queryByRole("link", { name: "Add to Outlook" })).toBe(null);
		} finally {
			Date.now = realNow;
		}
	});

	it("shows an empty state pointing at the Watchlist page when no stock is registered", () => {
		mount({ ...WATCHLIST, stocks: [] });
		expect(screen.getByText(/No stocks on the watchlist yet/)).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "Add one on the Watchlist page" }).getAttribute("href"),
		).toBe("#/watchlist");
		expect(screen.queryByRole("table")).toBe(null);
	});

	it("shows the load error with Try again when the watchlist read failed", () => {
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
		const client = {};
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

	it("stays reactive: replacing the watchlist value updates the grid", async () => {
		const { setCurrent } = mount(WATCHLIST);
		expect(screen.getByRole("table").textContent).toContain("earnings announcements");
		setCurrent({ ...WATCHLIST, stocks: [] });
		await waitFor(() => {
			expect(screen.queryByRole("table")).toBe(null);
		});
		expect(screen.getByText(/No stocks on the watchlist yet/)).toBeTruthy();
	});

	it("offers a Refresh button that calls back, disabled while busy or while a run is active", () => {
		const refreshed = vi.fn();
		mount(WATCHLIST, 90, null, { onRefreshEarnings: refreshed });
		const button = screen.getByRole("button", { name: "Refresh earnings dates" });
		expect(button.hasAttribute("disabled")).toBe(false);
		fireEvent.click(button);
		expect(refreshed).toHaveBeenCalledTimes(1);
	});

	it("disables the Refresh button while a queue request is in flight", () => {
		const { setBusy } = mount(WATCHLIST, 90, null, { onRefreshEarnings: () => {} });
		const button = screen.getByRole("button", { name: "Refresh earnings dates" });
		expect(button.hasAttribute("disabled")).toBe(false);
		setBusy(true);
		expect(
			screen.getByRole("button", { name: "Refresh earnings dates" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("shows the fetching status line and disables Refresh while a run is active", () => {
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
		expect(
			screen.getByRole("button", { name: "Refresh earnings dates" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("says not fetched yet for never-refreshed stocks, never no announcement", () => {
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
		expect(screen.queryByRole("heading", { name: "Next" })).toBe(null);
		expect(screen.getByText("Earnings dates have not been fetched yet.")).toBeTruthy();
		expect(screen.queryByText(/No announcement in the next/)).toBe(null);
	});

	it("says no announcement only when every stock was refreshed at least once", () => {
		const first = WATCHLIST.stocks[0];
		if (first === undefined) throw new Error("expected the fixture stock");
		mount({ ...WATCHLIST, stocks: [{ ...first, events: [] }] });
		expect(screen.queryByRole("heading", { name: "Next" })).toBe(null);
		expect(screen.getByText("No announcement in the next 90 days.")).toBeTruthy();
	});

	it("keeps widget targets large enough to hit with confidence", () => {
		mount(WATCHLIST, 90, null, { onRefreshEarnings: () => {} });
		const refresh = screen.getByRole("button", { name: "Refresh earnings dates" });
		expect(refresh.className).toContain("pointer-coarse:min-h-11");
		const open = screen.getByRole("link", { name: "Open Watchlist" });
		expect(open.className).toContain("pointer-coarse:min-h-11");
		const day = screen.getByRole("link", { name: new RegExp(`${AAPL_DATE.slice(8, 10)} .*AAPL`) });
		expect(day.className).toContain("pointer-coarse:min-h-11");
	});
});
