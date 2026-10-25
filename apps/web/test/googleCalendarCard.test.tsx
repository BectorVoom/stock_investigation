import type { GoogleCalendarState } from "@research/contracts";
import { GOOGLE_AUTH_URL_PREFIX } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api/client.ts";
import { GoogleCalendarCard } from "../src/settings/GoogleCalendarCard.tsx";
import { createFakeBackend, errorResponse, type FakeBackend, jsonResponse } from "./fakeBackend.ts";
import { makeRun } from "./fixtures.ts";

const AUTH_URL = `${GOOGLE_AUTH_URL_PREFIX}response_type=code&client_id=e2e`;

function state(overrides: Partial<GoogleCalendarState> = {}): GoogleCalendarState {
	return {
		status: "disconnected",
		authUrl: null,
		calendarId: null,
		connectedAt: null,
		lastSyncedAt: null,
		lastSync: null,
		inSync: null,
		activeRunId: null,
		activeRunState: null,
		activeAction: null,
		lastFailure: null,
		...overrides,
	};
}

let backend: FakeBackend;

function googleRun(action: string) {
	return makeRun({ runId: `run_google_${action}`, kind: "google-calendar", state: "pending" });
}

function mount(
	current: GoogleCalendarState,
	hooks: { readonly onQueued?: () => void; readonly onQueueFailed?: () => void } = {},
) {
	const onQueued = hooks.onQueued ?? vi.fn();
	const onQueueFailed = hooks.onQueueFailed ?? vi.fn();
	backend.on("POST", /^\/api\/v1\/google-calendar\/(connect|sync|disconnect)$/, () =>
		jsonResponse({ run: googleRun("x") }, { status: 202 }),
	);
	backend.on("POST", /^\/api\/v1\/research-runs\/.+\/cancel$/, () =>
		jsonResponse({ run: googleRun("cancelled") }),
	);
	const client = {
		newIdempotencyKey: () => "idem-0000000001",
		connectGoogleCalendar: async () => {
			const response = await backend.fetch("/api/v1/google-calendar/connect", {
				method: "POST",
				headers: { "Idempotency-Key": "idem-0000000001" },
			});
			if (!response.ok)
				return {
					ok: false as const,
					error: {
						kind: "api" as const,
						code: "INTERNAL" as const,
						status: response.status,
						message: "boom",
						detail: null,
						issues: [],
						upstreamStatus: null,
					},
				};
			return { ok: true as const, value: googleRun("connect") };
		},
		syncGoogleCalendar: async () => ({ ok: true as const, value: googleRun("sync") }),
		disconnectGoogleCalendar: async () => ({ ok: true as const, value: googleRun("disconnect") }),
		cancelResearchRun: async (runId: string) => {
			await backend.fetch(`/api/v1/research-runs/${runId}/cancel`, { method: "POST" });
			return { ok: true as const, value: googleRun("cancelled") };
		},
	} as unknown as ApiClient;
	render(() => (
		<GoogleCalendarCard
			state={current}
			api={client}
			busy={false}
			onQueued={onQueued}
			onQueueFailed={onQueueFailed}
		/>
	));
	return { onQueued, onQueueFailed };
}

afterEach(cleanup);

describe("GoogleCalendarCard", () => {
	it("states the disconnected explanation with a Connect button that queues", async () => {
		backend = createFakeBackend();
		const onQueued = vi.fn();
		mount(state(), { onQueued });
		expect(screen.getByText(/can only see and change calendars it created itself/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Connect Google Calendar" }));
		await waitFor(() => {
			expect(onQueued).toHaveBeenCalledTimes(1);
		});
		expect(backend.requestsTo("POST", /google-calendar\/connect$/)).toHaveLength(1);
	});

	it("says it is preparing while connecting without a URL", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connecting",
				activeRunId: "run_google_connect",
				activeRunState: "pending",
				activeAction: "connect",
			}),
		);
		expect(screen.getByText(/Preparing Google sign-in…/)).toBeTruthy();
		expect(screen.queryByRole("link", { name: "Open Google sign-in" })).toBe(null);
	});

	it("offers Cancel while the sign-in is still being prepared (runner offline)", async () => {
		backend = createFakeBackend();
		const onQueued = vi.fn();
		mount(
			state({
				status: "connecting",
				activeRunId: "run_google_connect",
				activeRunState: "pending",
				activeAction: "connect",
			}),
			{ onQueued },
		);
		expect(
			screen.getByText(/if the runner is offline this waits until it reconnects/),
		).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(onQueued).toHaveBeenCalledTimes(1);
		});
		expect(backend.requestsTo("POST", /research-runs\/run_google_connect\/cancel$/)).toHaveLength(
			1,
		);
	});

	it("shows the sign-in link, the wait note and Cancel while connecting with a URL", async () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connecting",
				authUrl: AUTH_URL,
				activeRunId: "run_google_connect",
				activeRunState: "claimed",
				activeAction: "connect",
			}),
		);
		const link = screen.getByRole("link", { name: "Open Google sign-in" });
		expect(link.getAttribute("href")).toBe(AUTH_URL);
		expect(link.getAttribute("target")).toBe("_blank");
		expect(link.getAttribute("rel")).toContain("noopener");
		expect(screen.getByText(/Waiting for you to finish in Google \(5 minutes\)/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => {
			expect(backend.requestsTo("POST", /cancel$/)).toHaveLength(1);
		});
	});

	it("states a fresh connection as not synced yet, with Sync and Disconnect", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				inSync: false,
			}),
		);
		expect(screen.getByText(/Connected since/)).toBeTruthy();
		expect(screen.getByText(/Not synced yet/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sync now" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
	});

	it("states the last sync counts after a sync", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				lastSyncedAt: "2026-11-02T11:00:00Z",
				lastSync: { inserted: 3, updated: 0, deleted: 1, unchanged: 4 },
				inSync: true,
			}),
		);
		expect(screen.getByText(/Last synced/)).toBeTruthy();
		expect(screen.getByText(/3 added, 0 changed, 1 removed/)).toBeTruthy();
	});

	it("states syncing while a sync run is active and disables Sync now", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				inSync: false,
				activeRunId: "run_google_sync",
				activeRunState: "claimed",
				activeAction: "sync",
			}),
		);
		expect(screen.getByText(/Syncing…/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(true);
		// One step at a time: Disconnect waits for the running step too.
		expect(screen.getByRole("button", { name: "Disconnect" }).hasAttribute("disabled")).toBe(true);
	});

	it("says the calendar is behind and that automatic syncing is paused after a failed sync", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				lastSyncedAt: "2026-11-02T11:00:00Z",
				lastSync: { inserted: 2, updated: 0, deleted: 0, unchanged: 0 },
				inSync: false,
				lastFailure: {
					code: "GOOGLE_RATE_LIMITED",
					upstreamStatus: null,
					reason: "Google is limiting requests right now; try again later.",
					at: "2026-11-03T11:00:00Z",
				},
			}),
		);
		expect(screen.getByText(/The dates here have changed since; use Sync now/)).toBeTruthy();
		expect(screen.getByText(/Automatic syncing is paused until a sync succeeds/)).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false);
	});

	it("states the needs-reconnect reason once, not a second time as an error", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "needs-reconnect",
				calendarId: "cal_1",
				lastFailure: {
					code: "GOOGLE_AUTH_EXPIRED",
					upstreamStatus: null,
					reason: "x",
					at: "2026-11-03T11:00:00Z",
				},
			}),
		);
		expect(screen.getByRole("button", { name: "Reconnect Google Calendar" })).toBeTruthy();
		expect(screen.queryByRole("alert")).toBe(null);
		expect(screen.queryByText(/Automatic syncing is paused/)).toBe(null);
	});

	it("disconnects only after a confirmation that names what stays in Google", async () => {
		backend = createFakeBackend();
		const onQueued = vi.fn();
		mount(
			state({
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				inSync: true,
			}),
			{ onQueued },
		);
		fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("The calendar stays in your Google account");
		fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
		await waitFor(() => {
			expect(onQueued).toHaveBeenCalledTimes(1);
		});
	});

	it("states needs-reconnect with the reason and a Reconnect button", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "needs-reconnect",
				calendarId: "cal_1",
				lastFailure: {
					code: "GOOGLE_AUTH_EXPIRED",
					upstreamStatus: null,
					reason: "The Google connection expired; reconnect Google Calendar.",
					at: "2026-11-02T11:00:00Z",
				},
			}),
		);
		// The reason is stated both in the reconnect sentence and the failure notice.
		expect(screen.getAllByText(/The Google connection expired/).length).toBeGreaterThan(0);
		expect(screen.getByRole("button", { name: "Reconnect Google Calendar" })).toBeTruthy();
	});

	it("states the fixed reason sentence for every failure code", () => {
		backend = createFakeBackend();
		mount(
			state({
				lastFailure: {
					code: "GOOGLE_NOT_CONFIGURED",
					upstreamStatus: null,
					reason:
						"Google Calendar is not configured; set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in apps/runner/.env.",
					at: "2026-11-02T11:00:00Z",
				},
			}),
		);
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("GOOGLE_NOT_CONFIGURED");
		expect(alert.textContent).toContain("GOOGLE_OAUTH_CLIENT_ID");
	});

	it("states Google's answer status beside a failure Google caused, and none otherwise", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "connected",
				calendarId: "cal_1",
				connectedAt: "2026-11-02T10:00:00Z",
				lastFailure: {
					code: "GOOGLE_RATE_LIMITED",
					upstreamStatus: 429,
					reason: "Google is limiting requests right now; try again later.",
					at: "2026-11-03T11:00:00Z",
				},
			}),
		);
		expect(screen.getByRole("alert").textContent).toContain(
			"GOOGLE_RATE_LIMITED: The Google Calendar rate limit was reached; try again later. (service answered HTTP 429)",
		);
		cleanup();

		mount(
			state({
				lastFailure: {
					code: "GOOGLE_AUTH_TIMEOUT",
					upstreamStatus: null,
					reason: "x",
					at: "2026-11-03T11:00:00Z",
				},
			}),
		);
		expect(screen.getByRole("alert").textContent).not.toContain("service answered");
	});

	it("adds Google's answer status to the needs-reconnect reason", () => {
		backend = createFakeBackend();
		mount(
			state({
				status: "needs-reconnect",
				calendarId: "cal_1",
				lastFailure: {
					code: "GOOGLE_AUTH_EXPIRED",
					upstreamStatus: 401,
					reason: "x",
					at: "2026-11-03T11:00:00Z",
				},
			}),
		);
		expect(
			screen.getByText(
				"The Google connection expired; reconnect Google Calendar. The service answered HTTP 401. Reconnect to keep the calendar in step.",
			),
		).toBeTruthy();
	});

	it("maps an unknown stored failure code to the generic reason", () => {
		backend = createFakeBackend();
		mount(
			state({
				lastFailure: {
					code: "GOOGLE_REQUEST_FAILED",
					upstreamStatus: null,
					reason: "The Google Calendar request failed.",
					at: "2026-11-02T11:00:00Z",
				},
			}),
		);
		expect(screen.getByRole("alert").textContent).toContain("The Google Calendar request failed.");
	});

	it("reports a failed queue through onQueueFailed with the action title", async () => {
		backend = createFakeBackend();
		const onQueueFailed = vi.fn();
		mount(state(), { onQueueFailed });
		backend.on("POST", /^\/api\/v1\/google-calendar\/(connect|sync|disconnect)$/, () =>
			errorResponse(500, "INTERNAL", "boom"),
		);
		fireEvent.click(screen.getByRole("button", { name: "Connect Google Calendar" }));
		await waitFor(() => {
			expect(onQueueFailed).toHaveBeenCalledTimes(1);
		});
		expect(onQueueFailed.mock.calls[0]?.[0]).toBe("The Google Calendar connection was not queued.");
	});
});
