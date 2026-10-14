import { describe, expect, it } from "vitest";
import {
	formatHash,
	isValidCalendarDate,
	parseHash,
	type Route,
	watchlistCalendarHash,
} from "../src/router.ts";

function route(overrides: Partial<Route>): Route {
	return {
		view: "home",
		workspaceId: null,
		section: null,
		calendarDate: null,
		...overrides,
	};
}

describe("router", () => {
	it("parses every route", () => {
		expect(parseHash("#/home")).toEqual(route({ view: "home" }));
		expect(parseHash("#/chat")).toEqual(route({ view: "chat" }));
		expect(parseHash("#/chat/ws_1")).toEqual(route({ view: "chat", workspaceId: "ws_1" }));
		expect(parseHash("#/sources")).toEqual(route({ view: "sources" }));
		expect(parseHash("#/watchlist")).toEqual(route({ view: "watchlist" }));
		expect(parseHash("#/settings")).toEqual(route({ view: "settings" }));
	});

	it("parses the settings agent marker so chat notices can link to the control", () => {
		expect(parseHash("#/settings/agent")).toEqual(route({ view: "settings", section: "agent" }));
		// Unknown sub-sections are ignored rather than failing the route.
		expect(parseHash("#/settings/billing")).toEqual(route({ view: "settings" }));
	});

	it("parses the old canvas and workspace hashes as the chat view", () => {
		expect(parseHash("#/canvas/ws_1")).toEqual(route({ view: "chat", workspaceId: "ws_1" }));
		expect(parseHash("#/canvas")).toEqual(route({ view: "chat" }));
		expect(parseHash("#/workspace/ws_1")).toEqual(route({ view: "chat", workspaceId: "ws_1" }));
		expect(parseHash("#/workspace")).toEqual(route({ view: "chat" }));
	});

	it("treats an unknown or empty hash as the default home view", () => {
		expect(parseHash("")).toEqual(route({ view: "home" }));
		expect(parseHash("#")).toEqual(route({ view: "home" }));
		expect(parseHash("#/unknown")).toEqual(route({ view: "home" }));
		expect(parseHash("#/chat/")).toEqual(route({ view: "chat" }));
	});

	it("rejects invalid ids", () => {
		expect(parseHash("#/chat/..")).toEqual(route({ view: "chat" }));
		expect(parseHash("#/chat/")).toEqual(route({ view: "chat" }));
		expect(parseHash("#/canvas/not valid!")).toEqual(route({ view: "chat" }));
		expect(parseHash("#/canvas/ws_1/extra")).toEqual(route({ view: "chat", workspaceId: "ws_1" }));
	});

	it("parses the Watchlist calendar deep link with and without a date", () => {
		expect(parseHash("#/watchlist/calendar")).toEqual(
			route({ view: "watchlist", section: "calendar" }),
		);
		expect(parseHash("#/watchlist/calendar/2026-11-05")).toEqual(
			route({ view: "watchlist", section: "calendar", calendarDate: "2026-11-05" }),
		);
		// An invalid or missing date is the default month, never a failed route —
		// the calendar section is still the target.
		expect(parseHash("#/watchlist/calendar/not-a-date")).toEqual(
			route({ view: "watchlist", section: "calendar" }),
		);
		expect(parseHash("#/watchlist/calendar/2026-13-40")).toEqual(
			route({ view: "watchlist", section: "calendar" }),
		);
		expect(parseHash("#/watchlist/calendar/2026-02-30")).toEqual(
			route({ view: "watchlist", section: "calendar" }),
		);
		// Anything else below the watchlist stays the plain page.
		expect(parseHash("#/watchlist/other")).toEqual(route({ view: "watchlist" }));
	});

	it("validates deep-link dates as real civil days", () => {
		expect(isValidCalendarDate("2026-11-05")).toBe(true);
		expect(isValidCalendarDate("2024-02-29")).toBe(true);
		expect(isValidCalendarDate("2026-02-29")).toBe(false);
		expect(isValidCalendarDate("2026-13-01")).toBe(false);
		expect(isValidCalendarDate("1969-12-31")).toBe(false);
		expect(isValidCalendarDate("2026-1-5")).toBe(false);
		expect(isValidCalendarDate("tomorrow")).toBe(false);
	});

	it("round-trips every route", () => {
		const routes = [
			route({ view: "home" }),
			route({ view: "chat" }),
			route({ view: "chat", workspaceId: "ws_1" }),
			route({ view: "sources" }),
			route({ view: "watchlist" }),
			route({ view: "watchlist", section: "calendar" }),
			route({ view: "settings" }),
			route({ view: "settings", section: "agent" }),
			route({ view: "watchlist", section: "calendar", calendarDate: "2026-11-05" }),
		];
		for (const entry of routes) {
			expect(parseHash(formatHash(entry))).toEqual({ ...entry });
		}
	});

	it("formats the routes in the page map", () => {
		expect(formatHash(route({ view: "home" }))).toBe("#/home");
		expect(formatHash(route({ view: "chat" }))).toBe("#/chat");
		expect(formatHash(route({ view: "chat", workspaceId: "ws_1" }))).toBe("#/chat/ws_1");
		expect(formatHash(route({ view: "sources" }))).toBe("#/sources");
		expect(formatHash(route({ view: "watchlist" }))).toBe("#/watchlist");
		expect(formatHash(route({ view: "watchlist", section: "calendar" }))).toBe(
			"#/watchlist/calendar",
		);
		expect(formatHash(route({ view: "settings" }))).toBe("#/settings");
		expect(formatHash(route({ view: "settings", section: "agent" }))).toBe("#/settings/agent");
		expect(
			formatHash(route({ view: "watchlist", section: "calendar", calendarDate: "2026-11-05" })),
		).toBe("#/watchlist/calendar/2026-11-05");
	});

	it("builds the widget day links to the Watchlist calendar", () => {
		expect(watchlistCalendarHash("2026-11-05")).toBe("#/watchlist/calendar/2026-11-05");
		expect(watchlistCalendarHash(null)).toBe("#/watchlist/calendar");
	});
});
