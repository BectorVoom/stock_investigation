import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	buildEarningsCalendar,
	type EarningsCalendarEvent,
	earningsCalendarTexts,
	escapeIcsText,
	escapeIcsUri,
	foldIcsLine,
} from "../../src/calendar/ics.ts";
import "../support/seededProperties.ts";

function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

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

const TOYOTA_UNDECIDED: EarningsCalendarEvent = {
	stockId: "jp:7203",
	symbol: "7203",
	name: "Toyota Motor Corp.",
	periodKey: "fy2027-03-31-second-quarter",
	announcementDate: null,
	fiscalPeriodLabel: "Second quarter",
	fiscalPeriodEnd: "2027-03-31",
	timing: "unknown",
	publisher: "Japan Exchange Group (JPX)",
	sourceUrl: "https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html",
	retrievedAt: "2026-10-11T03:00:00.000Z",
};

describe("escapeIcsText", () => {
	it("escapes backslash, semicolon, comma and newlines, and strips other controls", () => {
		expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
		expect(escapeIcsText("line1\r\nline2\nline3\rline4")).toBe("line1\\nline2\\nline3\\nline4");
		expect(escapeIcsText("a\x00b\x07c\x1fd\x7fe")).toBe("abcde");
		expect(escapeIcsText("plain text médaille 日本語")).toBe("plain text médaille 日本語");
	});
});

describe("escapeIcsUri", () => {
	it("leaves URI characters alone and strips control characters only", () => {
		// `;` and `,` are legal in a URI and must NOT gain TEXT backslashes.
		expect(escapeIcsUri("https://example.com/a;b,c?d=e&f=g")).toBe(
			"https://example.com/a;b,c?d=e&f=g",
		);
		expect(escapeIcsUri("https://example.com/a\x00b\x1fc")).toBe("https://example.com/abc");
	});
});

describe("foldIcsLine", () => {
	it("leaves short lines alone", () => {
		expect(foldIcsLine("SUMMARY:hello")).toBe("SUMMARY:hello");
	});

	it("folds a 76-octet line into 75 + space + 1", () => {
		const line = `X:${"a".repeat(73)}`;
		expect(utf8Bytes(line)).toBe(75);
		expect(foldIcsLine(line)).toBe(line);
		const longer = `X:${"a".repeat(74)}`;
		expect(foldIcsLine(longer)).toBe(`X:${"a".repeat(73)}\r\n a`);
	});

	it("never splits a multi-byte character and counts octets, not chars", () => {
		// "é" is 2 octets: 35 of them plus "X:" fill exactly 72 octets, so the
		// 36th would overflow — it must move whole to the continuation line.
		const line = `X:${"é".repeat(40)}`;
		const folded = foldIcsLine(line);
		for (const piece of folded.split("\r\n")) {
			const content = piece.startsWith(" ") ? piece.slice(1) : piece;
			expect(utf8Bytes(piece) <= 75).toBe(true);
			expect(content).not.toMatch(/�/);
		}
		expect(folded.split("\r\n ").join("")).toBe(line);
	});

	it("round-trips: removing each CRLF + space yields the input exactly", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 400 }).filter((text) => !/[\r\n]/.test(text)),
				(line) => {
					const folded = foldIcsLine(line);
					expect(folded.split("\r\n ").join("")).toBe(line);
					for (const piece of folded.split("\r\n")) {
						expect(utf8Bytes(piece)).toBeLessThanOrEqual(75);
					}
				},
			),
			{ numRuns: 500 },
		);
	});
});

describe("earningsCalendarTexts", () => {
	it("builds the shared summary and description", () => {
		expect(earningsCalendarTexts(AAPL)).toEqual({
			summary: "AAPL Apple Inc earnings (Q4 2026)",
			description: [
				"Scheduled earnings announcement for AAPL (Q4 2026).",
				"The date can change; check the source before acting on it.",
				"Expected timing: after market close.",
				"Source: Finnhub, retrieved 2026-10-11.",
			].join("\n"),
		});
	});

	it("falls back to the symbol for a missing name and omits unknown timing", () => {
		const { summary, description } = earningsCalendarTexts({
			symbol: "7203",
			name: null,
			fiscalPeriodLabel: "Second quarter",
			timing: "unknown",
			publisher: "Japan Exchange Group (JPX)",
			retrievedAt: "2026-10-11T03:00:00.000Z",
		});
		expect(summary).toBe("7203 7203 earnings (Second quarter)");
		expect(description).not.toContain("timing");
		expect(description).toContain("Source: Japan Exchange Group (JPX), retrieved 2026-10-11.");
	});
});

describe("buildEarningsCalendar", () => {
	it("writes a deterministic document with one all-day VEVENT", () => {
		const first = buildEarningsCalendar({ calendarName: "Earnings", events: [AAPL] });
		const second = buildEarningsCalendar({ calendarName: "Earnings", events: [AAPL] });
		expect(second).toBe(first);
		expect(first).toBe(
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//stock-investigation//Earnings Calendar//EN",
				"CALSCALE:GREGORIAN",
				"METHOD:PUBLISH",
				"X-WR-CALNAME:Earnings",
				"BEGIN:VEVENT",
				"UID:earnings-us-AAPL-2026-q4@research-workspace",
				"DTSTAMP:20261011T030000Z",
				"DTSTART;VALUE=DATE:20261029",
				"DTEND;VALUE=DATE:20261030",
				"SUMMARY:AAPL Apple Inc earnings (Q4 2026)",
				"DESCRIPTION:Scheduled earnings announcement for AAPL (Q4 2026).\\nThe date c",
				" an change\\; check the source before acting on it.\\nExpected timing: after ",
				" market close.\\nSource: Finnhub\\, retrieved 2026-10-11.",
				"URL:https://finnhub.io/",
				"TRANSP:TRANSPARENT",
				"END:VEVENT",
				"END:VCALENDAR",
				"",
			].join("\r\n"),
		);
	});

	it("omits undecided events and orders by date then stockId", () => {
		const msft: EarningsCalendarEvent = {
			...AAPL,
			stockId: "us:MSFT",
			symbol: "MSFT",
			name: null,
			periodKey: "2026-q4",
		};
		const calendar = buildEarningsCalendar({
			calendarName: "Earnings",
			events: [TOYOTA_UNDECIDED, msft, AAPL],
		});
		expect(calendar).not.toContain("7203");
		const aaplAt = calendar.indexOf("UID:earnings-us-AAPL");
		const msftAt = calendar.indexOf("UID:earnings-us-MSFT");
		expect(aaplAt).toBeGreaterThanOrEqual(0);
		expect(msftAt).toBeGreaterThan(aaplAt);
	});

	it("uses CRLF everywhere and folds every long line to 75 octets", () => {
		const calendar = buildEarningsCalendar({ calendarName: "Earnings", events: [AAPL] });
		expect(calendar).not.toMatch(/[^\r]\n/);
		for (const line of calendar.split("\r\n")) {
			expect(utf8Bytes(line)).toBeLessThanOrEqual(75);
		}
	});

	it("leaves URI characters in URL unescaped", () => {
		const event: EarningsCalendarEvent = {
			...AAPL,
			sourceUrl: "https://example.com/cal;a,b",
		};
		const calendar = buildEarningsCalendar({ calendarName: "Earnings", events: [event] });
		expect(calendar).toContain("URL:https://example.com/cal;a,b");
		expect(calendar).not.toContain("URL:https://example.com/cal\\;a\\,b");
	});
});
