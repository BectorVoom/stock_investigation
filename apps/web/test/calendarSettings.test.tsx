import { GOOGLE_AUTH_URL_PREFIX } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import { CalendarSettingsSection } from "../src/settings/CalendarSettingsSection.tsx";
import { initialServerState, installWorkspaceRoutes, mountApp } from "./appHarness.tsx";
import { ALWAYS_VISIBLE, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import {
	createWatchlistBackend,
	DISCONNECTED_GOOGLE,
	FRESH_STAMP,
	type WatchServer,
} from "./watchlistHarness.ts";

/**
 * Settings → Calendar (ADR-0022): the Google Calendar card, the `.ics`
 * download and the subscription link, moved here from the Watchlist page.
 */

let backend: FakeBackend;
let server: WatchServer;

beforeEach(() => {
	({ backend, server } = createWatchlistBackend());
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(section: string | null = null) {
	render(() => (
		<CalendarSettingsSection
			api={createApiClient({ fetch: backend.fetch })}
			visibility={ALWAYS_VISIBLE}
			section={section}
		/>
	));
}

/** The section once the watchlist state has loaded (the Google card is its first sign). */
async function ready(): Promise<HTMLElement> {
	const section = await screen.findByRole("region", { name: "Calendar" });
	await within(section).findByText("Google Calendar");
	return section;
}

describe("Settings → Calendar", () => {
	it("explains where the dates come from and links to the Watchlist", async () => {
		mount();
		const section = await ready();
		const link = within(section).getByRole("link", { name: "Watchlist" });
		expect(link.getAttribute("href")).toBe("#/watchlist");
		expect(section.textContent).toContain(
			"Single dates can also be added from the Watchlist table.",
		);
	});

	it("downloads the calendar file through the shared download helper", async () => {
		const created: string[] = [];
		Object.defineProperty(URL, "createObjectURL", {
			value: () => {
				created.push("blob:fake");
				return "blob:fake";
			},
			configurable: true,
		});
		Object.defineProperty(URL, "revokeObjectURL", { value: () => {}, configurable: true });
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
		mount();
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Download calendar file (.ics)" }));
		await waitFor(() => expect(click).toHaveBeenCalled());
		expect(created).toEqual(["blob:fake"]);
		expect(backend.requestsTo("GET", /calendar\.ics$/)).toHaveLength(1);
	});

	it("disables the download with a reason when the watchlist is empty", async () => {
		server.stocks = [];
		mount();
		await ready();
		const button = screen.getByRole("button", { name: "Download calendar file (.ics)" });
		expect((button as HTMLButtonElement).disabled).toBe(true);
		expect(
			screen.getByText("Add a stock on the Watchlist page to download its dates."),
		).toBeTruthy();
	});

	it("creates the subscription link once, copies it, replaces and revokes it", async () => {
		const written: string[] = [];
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: (text: string) => written.push(text) },
			configurable: true,
		});
		mount();
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Create subscription link" }));
		const field = (await screen.findByLabelText(
			"Subscription link (shown once)",
		)) as HTMLInputElement;
		expect(field.value).toContain("/api/v1/calendar-feed/");
		expect(field.value).not.toContain("undefined");
		fireEvent.click(screen.getByRole("button", { name: "Copy" }));
		await waitFor(() => expect(written).toHaveLength(1));
		expect(await screen.findByText("Copied to the clipboard.")).toBeTruthy();

		fireEvent.click(await screen.findByRole("button", { name: "Replace link" }));
		const replaceDialog = await screen.findByRole("dialog");
		expect(replaceDialog.textContent).toContain("The old link stops working immediately.");
		fireEvent.click(within(replaceDialog).getByRole("button", { name: "Replace link" }));
		await waitFor(() => {
			expect(backend.requestsTo("POST", /^\/api\/v1\/watchlist\/feed$/)).toHaveLength(2);
		});
		// The dialog closes only once the issue response is processed.
		await waitFor(() => expect(screen.queryByRole("dialog")).toBe(null));

		fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));
		const revokeDialog = await screen.findByRole("dialog");
		fireEvent.click(within(revokeDialog).getByRole("button", { name: "Revoke link" }));
		expect(await screen.findByText("The subscription link was revoked.")).toBeTruthy();
	});

	it("queues a Google Calendar connect and shows the preparing state", async () => {
		mount();
		await ready();
		fireEvent.click(screen.getByRole("button", { name: "Connect Google Calendar" }));
		await waitFor(() => {
			expect(backend.requestsTo("POST", /google-calendar\/connect$/)).toHaveLength(1);
		});
		expect(await screen.findByText(/Preparing Google sign-in…/)).toBeTruthy();
	});

	it("shows the sign-in link while connecting with a URL", async () => {
		const authUrl = `${GOOGLE_AUTH_URL_PREFIX}response_type=code&client_id=e2e`;
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "connecting",
			authUrl,
			activeRunId: "run_google_connect",
			activeRunState: "claimed",
			activeAction: "connect",
		};
		mount();
		const link = await screen.findByRole("link", { name: "Open Google sign-in" });
		expect(link.getAttribute("href")).toBe(authUrl);
		expect(await screen.findByText(/Waiting for you to finish in Google/)).toBeTruthy();
	});

	it("states needs-reconnect with the fixed failure sentence", async () => {
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "needs-reconnect",
			lastFailure: {
				code: "GOOGLE_AUTH_EXPIRED",
				reason: "The Google connection expired; reconnect Google Calendar.",
				at: FRESH_STAMP,
			},
		};
		mount();
		expect(await screen.findByRole("button", { name: "Reconnect Google Calendar" })).toBeTruthy();
		expect((await screen.findAllByText(/The Google connection expired/)).length).toBeGreaterThan(0);
	});

	it("queues one automatic sync when connected and out of sync, and never loops after a failed run", async () => {
		server.google = {
			...DISCONNECTED_GOOGLE(),
			status: "connected",
			calendarId: "cal_1",
			connectedAt: FRESH_STAMP,
			inSync: false,
		};
		mount();
		await waitFor(
			() => expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(1),
			{ timeout: 30_000 },
		);
		// The queued run is active: the card says syncing.
		expect(await screen.findByText(/Syncing…/)).toBeTruthy();
		// The run fails server-side: the active run clears and the failure moves the ETag.
		server.google = {
			...server.google,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: {
				code: "GOOGLE_REQUEST_FAILED",
				reason: "The Google Calendar request failed.",
				at: FRESH_STAMP,
			},
		};
		await waitFor(() => expect(screen.queryByText(/Syncing…/)).toBe(null), { timeout: 30_000 });
		// No second sync is queued even though the ETag moved: no loops.
		await new Promise((resolve) => setTimeout(resolve, 3000));
		expect(backend.requestsTo("POST", /google-calendar\/sync$/)).toHaveLength(1);
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The Google Calendar request failed.");
	}, 90_000);

	it("focuses its heading for the #/settings/calendar link", async () => {
		mount("calendar");
		await ready();
		const heading = screen.getByRole("heading", { level: 3, name: "Calendar" });
		await waitFor(() => expect(document.activeElement).toBe(heading));
	});
});

describe("Settings → Calendar in the app", () => {
	function mountAt(hash: string) {
		installWorkspaceRoutes(backend, initialServerState());
		backend.on("GET", /runner-credentials$/, () => jsonResponse({ credentials: [] }));
		window.location.hash = hash;
		mountApp(backend);
	}

	afterEach(() => {
		window.location.hash = "";
	});

	it("opens Settings on the Calendar section from #/settings/calendar", async () => {
		mountAt("#/settings/calendar");
		await screen.findByRole("heading", { level: 2, name: "Settings" });
		const heading = await screen.findByRole("heading", { level: 3, name: "Calendar" });
		await waitFor(() => expect(document.activeElement).toBe(heading));
	});

	it("sends a legacy Watchlist calendar link to Settings → Calendar", async () => {
		mountAt("#/watchlist/calendar/2026-11-05");
		await screen.findByRole("heading", { level: 2, name: "Settings" });
		expect(await screen.findByRole("region", { name: "Calendar" })).toBeTruthy();
		expect(screen.queryByRole("heading", { level: 2, name: "Watchlist" })).toBe(null);
	});
});
