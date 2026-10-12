import { describe, expect, it } from "vitest";
import { formatHash, parseHash } from "../src/router.ts";

describe("router", () => {
	it("parses every route", () => {
		expect(parseHash("#/chat")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/chat/ws_1")).toEqual({ view: "chat", workspaceId: "ws_1", section: null });
		expect(parseHash("#/canvas/ws_1")).toEqual({
			view: "canvas",
			workspaceId: "ws_1",
			section: null,
		});
		expect(parseHash("#/canvas")).toEqual({ view: "canvas", workspaceId: null, section: null });
		expect(parseHash("#/sources")).toEqual({ view: "sources", workspaceId: null, section: null });
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

	it("parses the legacy workspace alias as the canvas view", () => {
		expect(parseHash("#/workspace/ws_1")).toEqual({
			view: "canvas",
			workspaceId: "ws_1",
			section: null,
		});
		expect(parseHash("#/workspace")).toEqual({
			view: "canvas",
			workspaceId: null,
			section: null,
		});
	});

	it("treats an unknown or empty hash as the default chat view", () => {
		expect(parseHash("")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/unknown")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/chat/")).toEqual({ view: "chat", workspaceId: null, section: null });
	});

	it("rejects invalid ids", () => {
		expect(parseHash("#/chat/..")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/chat/")).toEqual({ view: "chat", workspaceId: null, section: null });
		expect(parseHash("#/canvas/not valid!")).toEqual({
			view: "canvas",
			workspaceId: null,
			section: null,
		});
		expect(parseHash("#/canvas/ws_1/extra")).toEqual({
			view: "canvas",
			workspaceId: "ws_1",
			section: null,
		});
	});

	it("round-trips every route", () => {
		const routes = [
			{ view: "chat" as const, workspaceId: null, section: null },
			{ view: "chat" as const, workspaceId: "ws_1", section: null },
			{ view: "canvas" as const, workspaceId: null, section: null },
			{ view: "canvas" as const, workspaceId: "ws_1", section: null },
			{ view: "sources" as const, workspaceId: null, section: null },
			{ view: "settings" as const, workspaceId: null, section: null },
			{ view: "settings" as const, workspaceId: null, section: "agent" },
		];
		for (const route of routes) {
			expect(parseHash(formatHash(route))).toEqual({ ...route });
		}
	});

	it("formats the routes in the page map", () => {
		expect(formatHash({ view: "chat", workspaceId: null, section: null })).toBe("#/chat");
		expect(formatHash({ view: "chat", workspaceId: "ws_1", section: null })).toBe("#/chat/ws_1");
		expect(formatHash({ view: "canvas", workspaceId: "ws_1", section: null })).toBe(
			"#/canvas/ws_1",
		);
		expect(formatHash({ view: "canvas", workspaceId: null, section: null })).toBe("#/canvas");
		expect(formatHash({ view: "sources", workspaceId: null, section: null })).toBe("#/sources");
		expect(formatHash({ view: "settings", workspaceId: null, section: null })).toBe("#/settings");
		expect(formatHash({ view: "settings", workspaceId: null, section: "agent" })).toBe(
			"#/settings/agent",
		);
	});
});
