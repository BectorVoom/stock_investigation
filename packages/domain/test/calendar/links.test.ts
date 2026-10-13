import { describe, expect, it } from "vitest";
import type { EarningsCalendarEvent } from "../../src/calendar/ics.ts";
import { earningsCalendarTexts } from "../../src/calendar/ics.ts";
import { googleCalendarUrl, outlookCalendarUrl } from "../../src/calendar/links.ts";

const AAPL: EarningsCalendarEvent = {
	stockId: "us:AAPL",
	symbol: "AAPL",
	name: "Apple Inc",
	periodKey: "2026-q4",
	announcementDate: "2026-10-29",
	fiscalPeriodLabel: "Q4 2026",
	fiscalPeriodEnd: null,
	timing: "after-close",
	publisher: "Finnhub",
	sourceUrl: "https://finnhub.io/",
	retrievedAt: "2026-10-11T03:00:00.000Z",
};

describe("calendar links", () => {
	it("builds the Google template link with the shared text", () => {
		const { summary, description } = earningsCalendarTexts(AAPL);
		expect(googleCalendarUrl(AAPL)).toBe(
			`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(summary)}` +
				`&dates=20261029/20261030&details=${encodeURIComponent(description)}`,
		);
	});

	it("builds the Outlook compose link with the shared text", () => {
		const { summary, description } = earningsCalendarTexts(AAPL);
		expect(outlookCalendarUrl(AAPL)).toBe(
			"https://outlook.live.com/calendar/0/deeplink/compose" +
				"?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent" +
				`&subject=${encodeURIComponent(summary)}` +
				`&startdt=2026-10-29&enddt=2026-10-30&allday=true&body=${encodeURIComponent(description)}`,
		);
	});

	it("returns null for undecided events, which have no date to template", () => {
		const undecided: EarningsCalendarEvent = { ...AAPL, announcementDate: null };
		expect(googleCalendarUrl(undecided)).toBeNull();
		expect(outlookCalendarUrl(undecided)).toBeNull();
	});
});
