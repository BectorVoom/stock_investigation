import { describe, expect, it } from "vitest";
import {
	chatHash,
	formatHash,
	parseHash,
	type Route,
	SETTINGS_AGENT_HASH,
	SETTINGS_CALENDAR_HASH,
	TASKS_HASH,
} from "../src/router.ts";

function route(overrides: Partial<Route>): Route {
	return {
		view: "home",
		workspaceId: null,
		section: null,
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
		expect(parseHash("#/tasks")).toEqual(route({ view: "tasks" }));
		expect(parseHash("#/settings")).toEqual(route({ view: "settings" }));
	});

	it("links the Tasks page, a task's chat and the AI agent settings (ADR-0033)", () => {
		expect(parseHash(TASKS_HASH)).toEqual(route({ view: "tasks" }));
		expect(parseHash(chatHash("ws_task"))).toEqual(route({ view: "chat", workspaceId: "ws_task" }));
		expect(parseHash(SETTINGS_AGENT_HASH)).toEqual(route({ view: "settings", section: "agent" }));
		// The Tasks page has no sub-routes: anything after it opens the list.
		expect(parseHash("#/tasks/task_1")).toEqual(route({ view: "tasks" }));
	});

	it("parses the settings agent and calendar markers so other pages can link to them", () => {
		expect(parseHash("#/settings/agent")).toEqual(route({ view: "settings", section: "agent" }));
		expect(parseHash("#/settings/calendar")).toEqual(
			route({ view: "settings", section: "calendar" }),
		);
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

	it("parses the legacy Watchlist calendar links as Settings → Calendar", () => {
		// The calendar settings moved to Settings (ADR-0022); old bookmarks and
		// day links land there, whatever date they carry.
		for (const hash of [
			"#/watchlist/calendar",
			"#/watchlist/calendar/2026-11-05",
			"#/watchlist/calendar/not-a-date",
		]) {
			expect(parseHash(hash)).toEqual(route({ view: "settings", section: "calendar" }));
		}
		// Anything else below the watchlist stays the plain page.
		expect(parseHash("#/watchlist/other")).toEqual(route({ view: "watchlist" }));
	});

	it("round-trips every route", () => {
		const routes = [
			route({ view: "home" }),
			route({ view: "chat" }),
			route({ view: "chat", workspaceId: "ws_1" }),
			route({ view: "sources" }),
			route({ view: "watchlist" }),
			route({ view: "settings" }),
			route({ view: "settings", section: "agent" }),
			route({ view: "settings", section: "calendar" }),
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
		expect(formatHash(route({ view: "settings" }))).toBe("#/settings");
		expect(formatHash(route({ view: "settings", section: "agent" }))).toBe("#/settings/agent");
		expect(formatHash(route({ view: "settings", section: "calendar" }))).toBe(
			"#/settings/calendar",
		);
	});

	it("names the Settings calendar section for the widget's connect link", () => {
		expect(SETTINGS_CALENDAR_HASH).toBe("#/settings/calendar");
	});
});
