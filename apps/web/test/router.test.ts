import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "../src/router.ts";

describe("router", () => {
	it("parses every route", () => {
		expect(parseHash("#/home")).toEqual({ view: "home", workspaceId: null, section: null });
		expect(parseHash("#/chat")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/chat/ws_1")).toEqual({ view: "chat", workspaceId: "ws_1", section: null });
		expect(parseHash("#/sources")).toEqual({ view: "sources", workspaceId: null, section: null });
		expect(parseHash("#/watchlist")).toEqual({
			view: "watchlist",
			workspaceId: null,
			section: null,
		});
		expect(parseHash("#/settings")).toEqual({
			view: "settings",
			workspaceId: null,
			section: null,
		});
	});

	it("parses the settings agent marker so chat notices can link to the control", () => {
		expect(parseHash("#/settings/agent")).toEqual({
			view: "settings",
			workspaceId: null,
			section: "agent",
		});
		// Unknown sub-sections are ignored rather than failing the route.
		expect(parseHash("#/settings/billing")).toEqual({
			view: "settings",
			workspaceId: null,
			section: null,
		});
	});

	it("parses the old canvas and workspace hashes as the chat view", () => {
		expect(parseHash("#/canvas/ws_1")).toEqual({
			view: "chat",
			workspaceId: "ws_1",
			section: null,
		});
		expect(parseHash("#/canvas")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/workspace/ws_1")).toEqual({
			view: "chat",
			workspaceId: "ws_1",
			section: null,
		});
		expect(parseHash("#/workspace")).toEqual({
			view: "chat",
			workspaceId: null,
			section: null,
		});
	});

	it("treats an unknown or empty hash as the default home view", () => {
		expect(parseHash("")).toEqual({ view: "home", workspaceId: null, section: null });
		expect(parseHash("#")).toEqual({ view: "home", workspaceId: null, section: null });
		expect(parseHash("#/unknown")).toEqual({ view: "home", workspaceId: null, section: null });
		expect(parseHash("#/chat/")).toEqual({ view: "chat", workspaceId: null, section: null });
	});

	it("rejects invalid ids", () => {
		expect(parseHash("#/chat/..")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/chat/")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/canvas/not valid!")).toEqual({
			view: "chat",
			workspaceId: null,
			section: null,
		});
		expect(parseHash("#/canvas/ws_1/extra")).toEqual({
			view: "chat",
			workspaceId: "ws_1",
			section: null,
		});
	});

	it("round-trips every route", () => {
		const routes = [
			{ view: "home" as const, workspaceId: null, section: null },
			{ view: "chat" as const, workspaceId: null, section: null },
			{ view: "chat" as const, workspaceId: "ws_1", section: null },
			{ view: "sources" as const, workspaceId: null, section: null },
			{ view: "watchlist" as const, workspaceId: null, section: null },
			{ view: "settings" as const, workspaceId: null, section: null },
			{ view: "settings" as const, workspaceId: null, section: "agent" },
		];
		for (const route of routes) {
			expect(parseHash(formatHash(route))).toEqual({ ...route });
		}
	});

	it("formats the routes in the page map", () => {
		expect(formatHash({ view: "home", workspaceId: null, section: null })).toBe("#/home");
		expect(formatHash({ view: "chat", workspaceId: null, section: null })).toBe("#/chat");
		expect(formatHash({ view: "chat", workspaceId: "ws_1", section: null })).toBe("#/chat/ws_1");
		expect(formatHash({ view: "sources", workspaceId: null, section: null })).toBe("#/sources");
		expect(formatHash({ view: "watchlist", workspaceId: null, section: null })).toBe("#/watchlist");
		expect(formatHash({ view: "settings", workspaceId: null, section: null })).toBe("#/settings");
		expect(formatHash({ view: "settings", workspaceId: null, section: "agent" })).toBe(
			"#/settings/agent",
		);
	});
});
