import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CalendarDayEvent,
	EarningsMonthCalendar,
	formatLongDayDate,
} from "../src/home/widgets/EarningsMonthCalendar.tsx";
import { earningsCalendarMessages } from "../src/home/widgets/earnings.messages.tsx";

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

function mount(events: readonly CalendarDayEvent[] = EVENTS) {
	render(() => <EarningsMonthCalendar events={events} today={TODAY} />);
}

afterEach(cleanup);

describe("formatLongDayDate", () => {
	it("reads without a leading zero", () => {
		expect(formatLongDayDate("2026-11-05", earningsCalendarMessages.en)).toBe("5 November 2026");
		expect(formatLongDayDate("2026-01-01", earningsCalendarMessages.en)).toBe("1 January 2026");
	});
});

describe("EarningsMonthCalendar", () => {
	it("opens on the month of the first upcoming announcement, Sunday first", () => {
		mount();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		const headers = within(table).getAllByRole("columnheader");
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
		mount([]);
		expect(
			screen.getByRole("table", { name: "November 2026: earnings announcements" }),
		).toBeTruthy();
	});

	it("navigates months locally with icon-only buttons and no Today button", () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: "Next month" }));
		expect(
			screen.getByRole("table", { name: "December 2026: earnings announcements" }),
		).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "3 December 2026: 1 announcement, MSFT" }),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
		fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
		expect(
			screen.getByRole("table", { name: "October 2026: earnings announcements" }),
		).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Today" })).toBe(null);
	});

	it("marks today with aria-current and an outlined bold number", () => {
		mount();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		const todayCell = table.querySelector('td[aria-current="date"]');
		expect(todayCell?.querySelector(".ring-2.font-bold")?.textContent).toBe("2");
		expect(table.querySelectorAll(".ring-2")).toHaveLength(1);
	});

	it("links announcement days to the Watchlist page, with no in-widget details", () => {
		mount();
		const day = screen.getByRole("link", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.getAttribute("href")).toBe("#/watchlist");
		fireEvent.click(day);
		expect(screen.queryByRole("region")).toBe(null);
	});

	it("leaves days without announcements as plain text (not focusable)", () => {
		mount();
		const table = screen.getByRole("table", { name: "November 2026: earnings announcements" });
		// Only announcement days are links: 5 November in-month and
		// 3 December as a muted out-of-month day. Every other day is text.
		expect(within(table).getAllByRole("link")).toHaveLength(2);
		expect(within(table).queryAllByRole("button")).toHaveLength(0);
	});

	it("marks the count on multi-announcement days", () => {
		mount();
		const day = screen.getByRole("link", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.textContent).toContain("2");
		const single = screen.getByRole("link", { name: "3 December 2026: 1 announcement, MSFT" });
		expect(single.textContent).not.toContain("2");
	});

	it("keeps targets large enough to hit with confidence", () => {
		mount();
		const day = screen.getByRole("link", {
			name: "5 November 2026: 2 announcements, 7203, AAPL",
		});
		expect(day.className).toContain("min-h-6");
		expect(day.className).toContain("pointer-coarse:min-h-11");
		// Month navigation is the shared icon-only button (28 px, 44 px under a
		// coarse pointer): no visible text, the words as name and tooltip.
		for (const name of ["Previous month", "Next month"]) {
			const button = screen.getByRole("button", { name });
			expect(button.className).toContain("min-h-7");
			expect(button.className).toContain("pointer-coarse:min-h-11");
			expect(button.textContent).toBe("");
			expect(button.getAttribute("title")).toBe(name);
		}
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
		render(() => <EarningsMonthCalendar events={events()} today={TODAY} />);
		// Nothing fetched yet: today's month.
		expect(screen.getByRole("table", { name: /^November 2026/ })).toBeTruthy();
		setEvents([december()]);
		expect(screen.getByRole("table", { name: /^December 2026/ })).toBeTruthy();
		expect(
			screen.getByRole("link", { name: "10 December 2026: 1 announcement, 7203" }),
		).toBeTruthy();
	});

	it("leaves the grid where the owner navigated", () => {
		const [events, setEvents] = createSignal<readonly CalendarDayEvent[]>([]);
		render(() => <EarningsMonthCalendar events={events()} today={TODAY} />);
		fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
		expect(screen.getByRole("table", { name: /^October 2026/ })).toBeTruthy();
		setEvents([december()]);
		expect(screen.getByRole("table", { name: /^October 2026/ })).toBeTruthy();
	});
});
