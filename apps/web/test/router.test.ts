import { describe, expect, it } from "vitest";
import {
	chatHash,
	formatHash,
	parseHash,
	REGISTERED_STOCKS_HASH,
	type Route,
	SETTINGS_AGENT_HASH,
	SETTINGS_CALENDAR_HASH,
	stockHash,
	TASKS_HASH,
} from "../src/router.ts";

function route(overrides: Partial<Route>): Route {
	return {
		view: "home",
		workspaceId: null,
		section: null,
		stock: null,
		...overrides,
	};
}

describe("router", () => {
	it("parses every route", () => {
		expect(parseHash("#/home")).toEqual(route({ view: "home" }));
		expect(parseHash("#/chat")).toEqual(route({ view: "chat" }));
		expect(parseHash("#/chat/ws_1")).toEqual(route({ view: "chat", workspaceId: "ws_1" }));
		expect(parseHash("#/sources")).toEqual(route({ view: "sources" }));
		expect(parseHash("#/registered")).toEqual(route({ view: "registered" }));
		expect(parseHash("#/stocks")).toEqual(route({ view: "stocks" }));
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
		// Anything else below the watchlist opens the Stocks list (ADR-0049).
		expect(parseHash("#/watchlist/other")).toEqual(route({ view: "registered" }));
	});

	it("opens the Registered stocks page for the old Watchlist and Equities links (ADR-0049)", () => {
		expect(parseHash("#/watchlist")).toEqual(route({ view: "registered" }));
		expect(parseHash("#/equities")).toEqual(route({ view: "registered" }));
		expect(parseHash(REGISTERED_STOCKS_HASH)).toEqual(route({ view: "registered" }));
		// Anything after it is ignored: the page has no sub-routes.
		expect(parseHash("#/registered/us:AAPL")).toEqual(route({ view: "registered" }));
	});

	it("parses a selected stock and its tab, falling back on bad parts", () => {
		expect(parseHash("#/stocks/us:AAPL")).toEqual(
			route({ view: "stocks", stock: { stockId: "us:AAPL", tab: "chart" } }),
		);
		expect(parseHash("#/stocks/jp:7974/news")).toEqual(
			route({ view: "stocks", stock: { stockId: "jp:7974", tab: "news" } }),
		);
		expect(parseHash("#/stocks/us%3AMSFT/financials")).toEqual(
			route({ view: "stocks", stock: { stockId: "us:MSFT", tab: "financials" } }),
		);
		// A bad tab opens the stock's Chart tab; a bad stock id the page with no stock.
		expect(parseHash("#/stocks/us:AAPL/bogus")).toEqual(
			route({ view: "stocks", stock: { stockId: "us:AAPL", tab: "chart" } }),
		);
		expect(parseHash("#/stocks/us:aapl")).toEqual(route({ view: "stocks" }));
		expect(parseHash("#/stocks/xx:1")).toEqual(route({ view: "stocks" }));
		expect(parseHash("#/stocks/%E0%A4%A")).toEqual(route({ view: "stocks" }));
	});

	it("builds stock links with a readable id, omitting the default tab", () => {
		expect(stockHash("us:AAPL")).toBe("#/stocks/us:AAPL");
		expect(stockHash("jp:7974", "company")).toBe("#/stocks/jp:7974/company");
		expect(stockHash("us:BRK.B", "news")).toBe("#/stocks/us:BRK.B/news");
	});

	it("round-trips every route", () => {
		const routes = [
			route({ view: "home" }),
			route({ view: "chat" }),
			route({ view: "chat", workspaceId: "ws_1" }),
			route({ view: "sources" }),
			route({ view: "registered" }),
			route({ view: "stocks" }),
			route({ view: "stocks", stock: { stockId: "us:AAPL", tab: "chart" } }),
			route({ view: "stocks", stock: { stockId: "jp:130A", tab: "financials" } }),
			route({ view: "stocks", stock: { stockId: "us:BRK-B", tab: "news" } }),
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
		expect(formatHash(route({ view: "registered" }))).toBe("#/registered");
		expect(formatHash(route({ view: "stocks" }))).toBe("#/stocks");
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
