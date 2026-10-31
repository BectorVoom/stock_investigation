import { cleanup, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PAGES } from "../src/pages.ts";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "./appHarness.tsx";
import { createFakeBackend, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import { WORKSPACE_ID } from "./fixtures.ts";

let backend: FakeBackend;
let server: ServerState;

beforeEach(() => {
	backend = createFakeBackend();
	server = initialServerState();
	installWorkspaceRoutes(backend, server);
	window.location.hash = `#/chat/${WORKSPACE_ID}`;
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
});

/** ADR-0011: the header tells the two local environments apart. */
describe("environment badge", () => {
	it("shows a Development badge with text when the API reports development", async () => {
		backend.on("GET", /^\/api\/v1\/session$/, () =>
			jsonResponse({ ownerId: "owner-1", authMode: "local-dev", environment: "development" }),
		);
		mountApp(backend);
		const badge = await screen.findByText("Development");
		expect(badge.getAttribute("data-field")).toBe("environment-badge");
	});

	it("shows no badge when the API reports production", async () => {
		mountApp(backend);
		await screen.findByText(/Signed in as/);
		expect(document.querySelector('[data-field="environment-badge"]')).toBeNull();
	});
});

describe("owner ID", () => {
	it("opens Settings when clicked", async () => {
		mountApp(backend);
		const link = await screen.findByRole("link", { name: /Signed in as/ });
		expect(link.getAttribute("href")).toBe("#/settings");
		link.click();
		expect(await screen.findByRole("heading", { level: 2, name: "Settings" })).toBeDefined();
	});

	it("is the only way to Settings: the navigation has no Settings item", async () => {
		mountApp(backend);
		const nav = await screen.findByRole("navigation", { name: "Views" });
		const names = [...nav.querySelectorAll("a")].map((link) => link.textContent);
		expect(names).toEqual(["Home", "Watchlist", "Equities", "Tasks", "Chat", "Sources"]);
	});
});

describe("page header", () => {
	const purposeOf = (view: string) => PAGES.find((page) => page.view === view)?.purpose ?? "";

	it("shows the Chat page's title without its purpose sentence", async () => {
		mountApp(backend);
		expect(await screen.findByRole("heading", { level: 2, name: "Chat" })).toBeDefined();
		expect(purposeOf("chat")).not.toBe("");
		expect(screen.queryByText(purposeOf("chat"))).toBeNull();
	});

	it("keeps the purpose sentence on the other pages", async () => {
		window.location.hash = "#/sources";
		mountApp(backend);
		expect(await screen.findByRole("heading", { level: 2, name: "Sources" })).toBeDefined();
		expect(screen.getByText(purposeOf("sources"))).toBeDefined();
	});
});
