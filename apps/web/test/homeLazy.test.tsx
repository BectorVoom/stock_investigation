import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api/client.ts";
import type { VisibilitySource } from "../src/lib/polling.ts";
import {
	initialHomeServerState,
	initialServerState,
	installHomeRoutes,
	mountApp,
	type ServerState,
} from "./appHarness.tsx";
import { createFakeBackend, type FakeBackend } from "./fakeBackend.ts";
import { assertOnlyIconFetches, globalFetchCalls, resetGlobalFetchCalls } from "./setup.ts";

let backend: FakeBackend;
let server: ServerState;

vi.mock("../src/home/HomeView.tsx", async () => {
	const actual = await vi.importActual<typeof import("../src/home/HomeView.tsx")>(
		"../src/home/HomeView.tsx",
	);
	// Render-time modes (the mocked module is evaluated once per file, so the
	// mode is read on every render, not at import time).
	let slowElapsed = false;
	return {
		HomeView: (props: { readonly api: ApiClient; readonly visibility: VisibilitySource }) => {
			const mode = (globalThis as { __homeLazyMode?: string }).__homeLazyMode;
			if (mode === "fail") throw new Error("chunk failed to load (V10 fixture)");
			if (mode === "slow" && !slowElapsed) {
				slowElapsed = true;
				throw new Promise((resolve) => setTimeout(resolve, 300));
			}
			return actual.HomeView(props);
		},
	};
});

beforeEach(() => {
	(globalThis as { __homeLazyMode?: string }).__homeLazyMode = undefined;
	resetGlobalFetchCalls();
	backend = createFakeBackend();
	server = initialServerState();
	installHomeRoutes(backend, server, initialHomeServerState(false));
	window.location.hash = "#/home";
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	vi.restoreAllMocks();
	// No global fetch may leave the process: icons come from the local stub,
	// everything else must go through the injected fake backend.
	assertOnlyIconFetches();
});

describe("V10: lazy Home loading and error states", () => {
	it("shows a designed loading state while the chunk loads", async () => {
		(globalThis as { __homeLazyMode?: string }).__homeLazyMode = "slow";
		mountApp(backend);
		await waitFor(() => expect(screen.getByText("Loading Home…")).toBeDefined());
		await screen.findByRole("heading", { level: 2, name: "Home" }, { timeout: 10_000 });
	});

	it("shows an error state with Try again when the chunk fails", async () => {
		(globalThis as { __homeLazyMode?: string }).__homeLazyMode = "fail";
		mountApp(backend);
		const alert = await screen.findByRole("alert", undefined, { timeout: 10_000 });
		expect(alert.textContent).toContain("Home could not be loaded.");
		const retry = screen.getByRole("button", { name: "Try again" });
		expect(retry).toBeDefined();
		// Retry re-renders; the chunk still fails, so the designed error
		// state (not a blank page) remains.
		fireEvent.click(retry);
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toContain("Home could not be loaded."),
		);
		expect(document.querySelector("article[data-widget-id]")).toBeNull();
	});

	it("serves sl-icon requests from the local stub, never the network", async () => {
		const response = await fetch("/icons/chevron-down.svg");
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("image/svg+xml");
		const text = await response.text();
		expect(text).toContain("<svg");
		expect(globalFetchCalls()).toEqual(["/icons/chevron-down.svg"]);
	});
});
