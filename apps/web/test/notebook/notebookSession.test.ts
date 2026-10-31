import { NOTEBOOK_LIMITS, type NotebookWidget } from "@research/contracts";
import { cleanup } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../src/api/client.ts";
import { notebookSessionMessages } from "../../src/notebook/notebook.messages.ts";
import { createNotebookSession, type NotebookSession } from "../../src/notebook/notebookSession.ts";
import type { FakeBackend } from "../fakeBackend.ts";
import {
	ALWAYS_VISIBLE,
	createControllableVisibility,
	deferred,
	errorResponse,
	jsonResponse,
} from "../fakeBackend.ts";
import {
	applyNotebookPut,
	createNotebookBackend,
	type NotebookServerState,
	notebookFixtures,
	WORKSPACE_ID,
} from "./notebookHarness.ts";

const NOTEBOOK_PUT = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/;
const NOTEBOOK_GET = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/;

interface Setup {
	readonly backend: FakeBackend;
	readonly server: NotebookServerState;
	readonly session: NotebookSession;
	readonly dispose: () => void;
}

function setup(widgets: readonly NotebookWidget[] = [], visibility = ALWAYS_VISIBLE): Setup {
	const { backend, server } = createNotebookBackend(widgets);
	const api = createApiClient({ fetch: backend.fetch });
	let session!: NotebookSession;
	const dispose = createRoot((release) => {
		session = createNotebookSession(
			api,
			WORKSPACE_ID,
			visibility,
			() => notebookSessionMessages.en,
		);
		return release;
	});
	return { backend, server, session, dispose };
}

async function waitForLoaded(session: NotebookSession): Promise<void> {
	for (let step = 0; step < 200; step += 1) {
		if (session.state() !== null) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("the notebook never loaded");
}

afterEach(() => {
	cleanup();
});

describe("notebook session", () => {
	it("loads the notebook on creation", async () => {
		const fixtures = notebookFixtures();
		const { session, dispose } = setup([fixtures.text, fixtures.metric]);
		try {
			await waitForLoaded(session);
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-text", "nb-metric"]);
			expect(session.loadError()).toBeNull();
			expect(session.pending()).toBe(false);
			expect(session.turns()).toEqual([]);
		} finally {
			dispose();
		}
	});

	it("saves an edit with the confirmed version", async () => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			const saved = await session.edit((widgets) =>
				widgets.filter((widget) => widget.widgetId !== "nb-text"),
			);
			expect(saved).toBe(true);
			// The saved response supplies the displayed state.
			expect(session.widgets()).toEqual([]);
			expect(session.state()?.version).toBe(1);
			const puts = backend.requestsTo("PUT", NOTEBOOK_PUT);
			expect(puts).toHaveLength(1);
			expect(puts[0]?.body).toMatchObject({ expectedVersion: 0 });
			expect(session.notice()).toBeNull();
		} finally {
			dispose();
		}
	});

	it("rolls back with a notice when the save fails", async () => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			backend.on("PUT", NOTEBOOK_PUT, () => {
				throw new Error("runner down (fixture)");
			});
			const saved = await session.edit((widgets) =>
				widgets.filter((widget) => widget.widgetId !== "nb-text"),
			);
			expect(saved).toBe(false);
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-text"]);
			expect(session.notice()?.text).toContain("was not saved");
			expect(session.pending()).toBe(false);
			session.dismissNotice();
			expect(session.notice()).toBeNull();
		} finally {
			dispose();
		}
	});

	it("adopts the latest server state with a notice on version conflict", async () => {
		const fixtures = notebookFixtures();
		const { session, server, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			// Another writer moves the server on while the save is away.
			server.widgets = [fixtures.text, fixtures.metric];
			server.version = 1;
			const saved = await session.edit((widgets) =>
				widgets.filter((widget) => widget.widgetId !== "nb-text"),
			);
			expect(saved).toBe(false);
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-text", "nb-metric"]);
			expect(session.notice()?.text).toBe(
				"The notebook changed elsewhere; showing the latest version.",
			);
		} finally {
			dispose();
		}
	});

	it("queues edits made while a save is in flight and sends them in order", async () => {
		const fixtures = notebookFixtures();
		const { backend, server, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			const gate = deferred<Response>();
			let calls = 0;
			backend.on("PUT", NOTEBOOK_PUT, (request) => {
				calls += 1;
				if (calls === 1) return gate.promise;
				return applyNotebookPut(server, request.body);
			});
			const first = session.edit((widgets) =>
				widgets.map((widget) =>
					widget.widgetId === "nb-text" && widget.type === "text"
						? { ...widget, text: "First edit" }
						: widget,
				),
			);
			// While the write is held, only the previous database readback is displayed.
			expect(session.widgets()[0]?.type === "text" ? session.widgets()[0] : null).toMatchObject({
				text: fixtures.text.type === "text" ? fixtures.text.text : "",
			});
			const second = session.edit((widgets) => [...widgets, fixtures.metric]);
			expect(session.widgets()).toEqual([fixtures.text]);
			expect(session.pending()).toBe(true);
			// Releases the held save with the real compare-and-set step.
			gate.resolve(applyNotebookPut(server, backend.requestsTo("PUT", NOTEBOOK_PUT)[0]?.body));
			expect(await first).toBe(true);
			expect(await second).toBe(true);
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(2);
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)[1]?.body).toMatchObject({
				expectedVersion: 1,
			});
			const ids = session.widgets().map((widget) => widget.widgetId);
			expect(ids).toEqual(["nb-text", "nb-metric"]);
			expect(session.pending()).toBe(false);
		} finally {
			dispose();
		}
	});

	it.each([
		"text",
		"metric",
		"chart",
		"table",
		"research",
	] as const)("does not display a %s widget from an uncommitted paste or failed save", async (type) => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup();
		try {
			await waitForLoaded(session);
			const gate = deferred<Response>();
			backend.on("PUT", NOTEBOOK_PUT, () => gate.promise);
			const saving = session.edit((widgets) => [...widgets, fixtures[type]]);
			expect(session.pending()).toBe(true);
			expect(session.widgets()).toEqual([]);
			gate.resolve(new Response(null, { status: 503 }));
			expect(await saving).toBe(false);
			expect(session.widgets()).toEqual([]);
			expect(session.notice()).not.toBeNull();
		} finally {
			dispose();
		}
	});

	it("renders the server readback instead of the submitted draft", async () => {
		const fixtures = notebookFixtures();
		const { backend, server, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			const gate = deferred<Response>();
			backend.on("PUT", NOTEBOOK_PUT, () => gate.promise);
			const saving = session.edit(() => [fixtures.metric]);
			expect(session.widgets()).toEqual([fixtures.text]);
			// A canonical response may contain changes made by another writer.
			gate.resolve(
				applyNotebookPut(server, {
					expectedVersion: 0,
					notebook: { widgets: [fixtures.chart] },
				}),
			);
			expect(await saving).toBe(true);
			expect(session.widgets()).toEqual(server.widgets);
			expect(session.widgets()[0]?.type).toBe("chart");
		} finally {
			dispose();
		}
	});

	it.each([
		"save",
		"undo",
	] as const)("ignores a reload sent before a newer %s", async (operation) => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			await session.edit((widgets) => [...widgets, fixtures.metric]);
			const older = session.state();
			const gate = deferred<Response>();
			backend.on("GET", NOTEBOOK_GET, () => gate.promise);
			const reading = session.reload();
			if (operation === "undo") expect(await session.undo()).toBe(true);
			else expect(await session.edit((widgets) => [...widgets, fixtures.chart])).toBe(true);
			const confirmed = session.state();
			expect(confirmed?.version).toBe(2);
			gate.resolve(jsonResponse(older));
			await reading;
			expect(session.state()).toBe(confirmed);
			expect(session.widgets()).toEqual(confirmed?.notebook.widgets);
		} finally {
			dispose();
		}
	});

	it("refuses queued edits explicitly when the conflict read fails", async () => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			const gate = deferred<Response>();
			backend.on("PUT", NOTEBOOK_PUT, () => gate.promise);
			backend.on("GET", NOTEBOOK_GET, () => errorResponse(503, "INTERNAL", "Read unavailable"));
			const first = session.edit(() => [fixtures.metric]);
			const queued = session.edit((widgets) => [...widgets, fixtures.chart]);
			gate.resolve(errorResponse(409, "VERSION_CONFLICT", "Changed"));
			expect(await first).toBe(false);
			expect(await queued).toBe(false);
			expect(session.pending()).toBe(false);
			expect(session.widgets()).toEqual([fixtures.text]);
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1);
			expect(session.notice()?.text).toContain("was not saved");
		} finally {
			dispose();
		}
	});

	it("reuses unchanged widget objects so the grid keeps its DOM", async () => {
		const fixtures = notebookFixtures();
		const { session, dispose } = setup([fixtures.text, fixtures.metric]);
		try {
			await waitForLoaded(session);
			const before = session.widgets();
			const untouched = before[1];
			await session.edit((widgets) =>
				widgets.map((widget) =>
					widget.widgetId === "nb-text" && widget.type === "text"
						? { ...widget, text: "Changed" }
						: widget,
				),
			);
			const after = session.widgets();
			expect(after[1]).toBe(untouched);
			expect(after[0]).not.toBe(before[0]);
			// A visibility reload with no server change keeps every object.
			await session.reload();
			const reloaded = session.widgets();
			expect(reloaded[0]).toBe(after[0]);
			expect(reloaded[1]).toBe(after[1]);
		} finally {
			dispose();
		}
	});

	it("adds a widget with placeholder metadata at the requested index", async () => {
		const fixtures = notebookFixtures();
		const { session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			const id = await session.addWidget(
				{
					widgetId: "nb-added",
					type: "text",
					title: "Added",
					size: "small",
					text: "Hello",
				},
				{ kind: "owner", messageId: null, runId: null, componentId: null },
				0,
			);
			expect(id).toBe("nb-added");
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-added", "nb-text"]);
		} finally {
			dispose();
		}
	});

	it("refuses an add past the widget maximum with a notice and no save", async () => {
		const fixtures = notebookFixtures();
		const full = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets }, (_, index) => ({
			...fixtures.text,
			widgetId: `nb-${index}`,
		}));
		const { backend, session, dispose } = setup(full);
		try {
			await waitForLoaded(session);
			const id = await session.addWidget(
				{ widgetId: "nb-over", type: "text", title: "One more", size: "small", text: "Hello" },
				{ kind: "owner", messageId: null, runId: null, componentId: null },
			);
			expect(id).toBeNull();
			expect(session.widgets()).toHaveLength(NOTEBOOK_LIMITS.maxWidgets);
			expect(session.notice()?.text).toBe(
				"A notebook holds at most 200 widgets. Remove one before adding another.",
			);
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toEqual([]);
			// Removing one makes room again.
			expect(await session.removeWidgets(["nb-0"])).toBe(true);
			expect(
				await session.addWidget(
					{ widgetId: "nb-over", type: "text", title: "One more", size: "small", text: "Hello" },
					{ kind: "owner", messageId: null, runId: null, componentId: null },
				),
			).toBe("nb-over");
		} finally {
			dispose();
		}
	});

	it("adds several widgets in one save, in entry order", async () => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			const ids = await session.addWidgets(
				[
					{
						core: {
							widgetId: "nb-added-a",
							type: "text",
							title: "First",
							size: "small",
							text: "Hello",
						},
						origin: { kind: "owner", messageId: null, runId: null, componentId: null },
					},
					{
						core: {
							widgetId: "nb-added-b",
							type: "text",
							title: "Second",
							size: "small",
							text: "World",
						},
						origin: { kind: "owner", messageId: null, runId: null, componentId: null },
					},
				],
				0,
			);
			expect(ids).toEqual(["nb-added-a", "nb-added-b"]);
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual([
				"nb-added-a",
				"nb-added-b",
				"nb-text",
			]);
			// One save, not N parallel saves.
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1);
		} finally {
			dispose();
		}
	});

	it("resolves null without saving when a multi-add would exceed the maximum", async () => {
		const fixtures = notebookFixtures();
		const full = Array.from({ length: NOTEBOOK_LIMITS.maxWidgets - 1 }, (_, index) => ({
			...fixtures.text,
			widgetId: `nb-${index}`,
		}));
		const { backend, session, dispose } = setup(full);
		try {
			await waitForLoaded(session);
			const ids = await session.addWidgets([
				{
					core: { widgetId: "nb-a", type: "text", title: "A", size: "small", text: "A" },
					origin: { kind: "owner", messageId: null, runId: null, componentId: null },
				},
				{
					core: { widgetId: "nb-b", type: "text", title: "B", size: "small", text: "B" },
					origin: { kind: "owner", messageId: null, runId: null, componentId: null },
				},
			]);
			expect(ids).toBeNull();
			expect(session.widgets()).toHaveLength(NOTEBOOK_LIMITS.maxWidgets - 1);
			expect(session.notice()?.text).toContain("at most 200 widgets");
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toEqual([]);
		} finally {
			dispose();
		}
	});

	it("resolves an empty multi-add without saving", async () => {
		const fixtures = notebookFixtures();
		const { backend, session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			expect(await session.addWidgets([])).toEqual([]);
			expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toEqual([]);
		} finally {
			dispose();
		}
	});

	it("removes widgets and prunes the selection", async () => {
		const fixtures = notebookFixtures();
		const { session, dispose } = setup([fixtures.text, fixtures.metric]);
		try {
			await waitForLoaded(session);
			session.select("nb-text", "replace");
			session.select("nb-metric", "toggle");
			expect(session.selection()).toEqual(["nb-text", "nb-metric"]);
			const saved = await session.removeWidgets(["nb-text"]);
			expect(saved).toBe(true);
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-metric"]);
			expect(session.selection()).toEqual(["nb-metric"]);
		} finally {
			dispose();
		}
	});

	it("keeps the selection in notebook order", async () => {
		const fixtures = notebookFixtures();
		const { session, dispose } = setup([fixtures.text, fixtures.metric]);
		try {
			await waitForLoaded(session);
			session.select("nb-metric", "replace");
			session.select("nb-text", "toggle");
			expect(session.selection()).toEqual(["nb-text", "nb-metric"]);
			session.select(null, "replace");
			expect(session.selection()).toEqual([]);
		} finally {
			dispose();
		}
	});

	it("undoes the last save as a new version", async () => {
		const fixtures = notebookFixtures();
		const { session, dispose } = setup([fixtures.text]);
		try {
			await waitForLoaded(session);
			expect(session.state()?.undoAvailable).toBe(false);
			await session.edit((widgets) => widgets.filter((widget) => widget.widgetId !== "nb-text"));
			expect(session.state()?.undoAvailable).toBe(true);
			const undone = await session.undo();
			expect(undone).toBe(true);
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-text"]);
			expect(session.state()?.version).toBe(2);
		} finally {
			dispose();
		}
	});

	it("re-reads when the tab becomes visible again", async () => {
		const fixtures = notebookFixtures();
		const visibility = createControllableVisibility();
		const { backend, server, session, dispose } = setup([fixtures.text], visibility);
		try {
			await waitForLoaded(session);
			const getsBefore = backend.requestsTo("GET", NOTEBOOK_GET).length;
			server.widgets = [fixtures.text, fixtures.chart];
			server.version = 1;
			server.updatedAt = "2026-10-12T12:00:00Z";
			visibility.setVisible(false);
			visibility.setVisible(true);
			for (let step = 0; step < 200; step += 1) {
				if (backend.requestsTo("GET", NOTEBOOK_GET).length > getsBefore) break;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(backend.requestsTo("GET", NOTEBOOK_GET).length).toBeGreaterThan(getsBefore);
			for (let step = 0; step < 200; step += 1) {
				if (session.widgets().length === 2) break;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(session.widgets().map((widget) => widget.widgetId)).toEqual(["nb-text", "nb-chart"]);
		} finally {
			dispose();
		}
	});
});
