import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CalendarDayEvent,
	EarningsMonthCalendar,
	formatLongDayDate,
} from "../src/watchlist/EarningsMonthCalendar.tsx";

/**
 * Hand-worked month: `today` is Monday 2026-11-02, so November 2026 opens
 * with Sunday 2026-11-01 in the first column. 2026-11-05 carries two
 * announcements (7203 sorts before AAPL), 2026-12-03 one.
 */
const TODAY = "2026-11-02";

function event(
	overrides: Partial<CalendarDayEvent> & { readonly announcementDate: string },
): CalendarDayEvent {
	return {
		stockId: "us:AAPL",
		symbol: "AAPL",
		name: "Apple Inc",
		fiscalPeriodLabel: "Q4 2026",
		timing: "after-close",
		periodKey: "2026-q4",
		fiscalPeriodEnd: null,
		publisher: "Finnhub",
		sourceUrl: "https://finnhub.io/",
		retrievedAt: "2026-11-01T12:00:00Z",
		...overrides,
	};
}

const EVENTS: readonly CalendarDayEvent[] = [
	event({
		announcementDate: "2026-11-05",
		stockId: "jp:7203",
		symbol: "7203",
		name: null,
		fiscalPeriodLabel: "Second quarter",
		fiscalPeriodEnd: "2027-03-31",
		timing: "unknown",
		periodKey: "fy2027-03-31-second-quarter",
		publisher: "Japan Exchange Group (JPX)",
		sourceUrl: "https://www.jpx.co.jp/",
	}),
	event({ announcementDate: "2026-11-05" }),
	event({
		announcementDate: "2026-12-03",
		stockId: "us:MSFT",
		symbol: "MSFT",
		name: "Microsoft Corp",
		fiscalPeriodLabel: "Q1 2027",
		periodKey: "2027-q1",
	}),
];

function mountFull(
	events: readonly CalendarDayEvent[] = EVENTS,
	initialSelected: string | null = null,
) {
	const [selected, setSelected] = createSignal<string | null>(initialSelected);
	render(() => (
		<EarningsMonthCalendar
			events={events}
			variant="full"
			selectedDate={selected()}
			onSelectDate={setSelected}
			today={TODAY}
		/>
	));
	return { selected, setSelected };
}

function mountCompact(events: readonly CalendarDayEvent[] = EVENTS) {
	render(() => (
		<EarningsMonthCalendar
			events={events}
			variant="compact"
			selectedDate={null}
			onSelectDate={() => {}}
			today={TODAY}
		/>
	));
}

afterEach(cleanup);

describe("formatLongDayDate", () => {
	it("reads without a leading zero", () => {
		expect(formatLongDayDate("2026-11-05")).toBe("5 November 2026");
		expect(formatLongDayDate("2026-01-01")).toBe("1 January 2026");
	});
});

describe("EarningsMonthCalendar (full)", () => {
	it("opens on the month of the first upcoming announcement", () => {
		mountFull();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		expect(table).toBeTruthy();
		// Sunday first: the first header names Sunday.
		const headers = within(table).getAllByRole("columnheader");
		expect(headers[0]?.textContent).toBe("Sun");
		expect(headers.map((entry) => entry.textContent)).toEqual([
			"Sun",
			"Mon",
			"Tue",
			"Wed",
			"Thu",
			"Fri",
			"Sat",
		]);
	});

	it("opens on the current month when nothing is upcoming", () => {
		mountFull([]);
		expect(
			screen.getByRole("table", { name: "November 2026: earnings announcements" }),
		).toBeTruthy();
	});

	it("navigates months locally and returns with Today", () => {
		mountFull();
		fireEvent.click(screen.getByRole("button", { name: "Next month" }));
		expect(
			screen.getByRole("table", { name: "December 2026: earnings announcements" }),
		).toBeTruthy();
		// The December event is now on the grid.
		expect(
			screen.getByRole("button", { name: "3 December 2026: 1 announcement, MSFT" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
		fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
		expect(
			screen.getByRole("table", { name: "October 2026: earnings announcements" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Today" }));
		expect(
			screen.getByRole("table", { name: "November 2026: earnings announcements" }),
		).toBeTruthy();
	});

	it("marks today with aria-current", () => {
		mountFull();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		const todayCell = table.querySelector('td[aria-current="date"]');
		expect(todayCell?.textContent).toContain("2");
		// Marked for the eye too, by shape (an outlined, bold number) — and
		// only on today's cell.
		expect(todayCell?.querySelector(".ring-2.font-bold")?.textContent).toBe("2");
		expect(table.querySelectorAll(".ring-2")).toHaveLength(1);
	});

	it("names an announcement day with its count and symbols, and shows chips plus overflow", () => {
		mountFull();
		const day = screen.getByRole("button", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.getAttribute("aria-pressed")).toBe("false");
		expect(day.textContent).toContain("7203");
		expect(day.textContent).toContain("AAPL");
	});

	it("selects a day into a details panel with the announcement facts and links", () => {
		mountFull();
		fireEvent.click(
			screen.getByRole("button", { name: "5 November 2026: 2 announcements, 7203, AAPL" }),
		);
		expect(
			screen
				.getByRole("button", { name: "5 November 2026: 2 announcements, 7203, AAPL" })
				.getAttribute("aria-pressed"),
		).toBe("true");
		const panel = screen.getByRole("region", { name: "Announcements on 5 November 2026" });
		expect(panel.textContent).toContain("7203");
		expect(panel.textContent).toContain("Apple Inc");
		expect(panel.textContent).toContain("Q4 2026");
		expect(panel.textContent).toContain("after market close");
		expect(panel.textContent).toContain("Second quarter");
		const google = within(panel).getAllByRole("link", { name: "Add to Google Calendar" });
		expect(google).toHaveLength(2);
		expect(google[0]?.getAttribute("href")).toContain("calendar.google.com");
		expect(
			within(panel).getAllByRole("link", { name: "Add to Outlook" })[0]?.getAttribute("href"),
		).toContain("outlook.live.com");
		// Selecting again clears the details.
		fireEvent.click(
			screen.getByRole("button", { name: "5 November 2026: 2 announcements, 7203, AAPL" }),
		);
		expect(screen.queryByRole("region", { name: "Announcements on 5 November 2026" })).toBe(null);
	});

	it("offers no calendar links for a past date, even with a retrieved stamp", () => {
		mountFull([event({ announcementDate: "2026-10-29" })], "2026-10-29");
		const panel = screen.getByRole("region", { name: "Announcements on 29 October 2026" });
		expect(panel.textContent).toContain("AAPL");
		expect(within(panel).queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(within(panel).queryByRole("link", { name: "Add to Outlook" })).toBe(null);
	});

	it("offers no calendar links for announcements without a retrieved stamp", () => {
		mountFull([event({ announcementDate: "2026-11-05", retrievedAt: null })], "2026-11-05");
		const panel = screen.getByRole("region", { name: "Announcements on 5 November 2026" });
		expect(within(panel).queryByRole("link", { name: "Add to Google Calendar" })).toBe(null);
		expect(within(panel).queryByRole("link", { name: "Add to Outlook" })).toBe(null);
	});

	it("states an empty selected day as text", () => {
		mountFull([], "2026-11-06");
		expect(screen.getByText("No announcement on 6 November 2026.")).toBeTruthy();
	});

	it("leaves days without announcements as plain text (not focusable)", () => {
		mountFull();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		const dayButtons = within(table).getAllByRole("button");
		// Only announcement days are buttons: 5 November in-month and
		// 3 December as a muted out-of-month day. Every other day is text.
		expect(dayButtons).toHaveLength(2);
	});

	it("is keyboard reachable: every day control is a native button with a name", () => {
		mountFull();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		for (const button of within(table).getAllByRole("button")) {
			expect(button.tagName).toBe("BUTTON");
			expect((button.getAttribute("aria-label") ?? "").length).toBeGreaterThan(0);
		}
		for (const name of ["Previous month", "Today", "Next month"]) {
			expect(screen.getByRole("button", { name }).tagName).toBe("BUTTON");
		}
	});

	it("does not snap back after navigating away from a deep-linked month", () => {
		const [selected, setSelected] = createSignal<string | null>("2026-11-05");
		render(() => (
			<EarningsMonthCalendar
				events={EVENTS}
				variant="full"
				selectedDate={selected()}
				onSelectDate={setSelected}
				initialMonth="2026-11"
				today={TODAY}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Next month" }));
		expect(
			screen.getByRole("table", { name: "December 2026: earnings announcements" }),
		).toBeTruthy();
		// Selecting a day in the new month keeps the navigated month.
		fireEvent.click(screen.getByRole("button", { name: "3 December 2026: 1 announcement, MSFT" }));
		expect(
			screen.getByRole("table", { name: "December 2026: earnings announcements" }),
		).toBeTruthy();
		expect(screen.getByRole("region", { name: "Announcements on 3 December 2026" })).toBeTruthy();
	});

	it("keeps every interactive target at the 24 px floor via classes", () => {
		mountFull();
		for (const button of screen.getAllByRole("button")) {
			expect(button.className).toContain("min-h-6");
		}
	});
});

describe("EarningsMonthCalendar (compact)", () => {
	it("links announcement days to the Watchlist calendar instead of selecting", () => {
		mountCompact();
		const day = screen.getByRole("link", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.getAttribute("href")).toBe("#/watchlist/calendar/2026-11-05");
		// No in-widget details panel exists in the compact variant.
		fireEvent.click(day);
		expect(screen.queryByRole("region")).toBe(null);
		expect(screen.queryByRole("button", { name: "Today" })).toBe(null);
	});

	it("marks the count on multi-announcement days", () => {
		mountCompact();
		const day = screen.getByRole("link", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.textContent).toContain("2");
		const single = screen.getByRole("link", { name: "3 December 2026: 1 announcement, MSFT" });
		expect(single.textContent).not.toContain("2");
	});

	it("keeps compact targets large enough to hit with confidence", () => {
		mountCompact();
		const day = screen.getByRole("link", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.className).toContain("min-h-6");
		expect(day.className).toContain("pointer-coarse:min-h-11");
		// Month navigation on Home is the shared icon-only button (28 px, 44 px
		// under a coarse pointer): no visible text, the words as name and tooltip.
		for (const name of ["Previous month", "Next month"]) {
			const button = screen.getByRole("button", { name });
			expect(button.className).toContain("min-h-7");
			expect(button.className).toContain("pointer-coarse:min-h-11");
			expect(button.textContent).toBe("");
			expect(button.getAttribute("title")).toBe(name);
		}
		expect(screen.queryByRole("button", { name: "Today" })).toBe(null);
	});
});

describe("EarningsMonthCalendar: dates that arrive after the grid is shown", () => {
	function december(): CalendarDayEvent {
		const first = EVENTS[0];
		if (first === undefined) throw new Error("the fixture has no event");
		return { ...first, announcementDate: "2026-12-10" };
	}

	it("moves an untouched grid to the first announcement, as a reload would", () => {
		const [events, setEvents] = createSignal<readonly CalendarDayEvent[]>([]);
		render(() => (
			<EarningsMonthCalendar
				events={events()}
				variant="compact"
				selectedDate={null}
				onSelectDate={() => {}}
				today={TODAY}
			/>
		));
		// Nothing fetched yet: today's month.
		expect(screen.getByRole("table", { name: /^November 2026/ })).toBeTruthy();
		setEvents([december()]);
		expect(screen.getByRole("table", { name: /^December 2026/ })).toBeTruthy();
		expect(document.querySelector('a[href="#/watchlist/calendar/2026-12-10"]')).not.toBe(null);
	});

	it("leaves the grid where the owner navigated", () => {
		const [events, setEvents] = createSignal<readonly CalendarDayEvent[]>([]);
		render(() => (
			<EarningsMonthCalendar
				events={events()}
				variant="compact"
				selectedDate={null}
				onSelectDate={() => {}}
				today={TODAY}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
		expect(screen.getByRole("table", { name: /^October 2026/ })).toBeTruthy();
		setEvents([december()]);
		expect(screen.getByRole("table", { name: /^October 2026/ })).toBeTruthy();
	});
});
