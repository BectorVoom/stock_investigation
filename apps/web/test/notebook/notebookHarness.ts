import {
	type NotebookResponse,
	type NotebookWidget,
	notebookResponseSchema,
	notebookWidgetSchema,
	putNotebookRequestSchema,
	undoNotebookRequestSchema,
} from "@research/contracts";
import {
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "../fakeBackend.ts";

export const WORKSPACE_ID = "ws_1";
const NOW = "2026-10-12T12:00:00Z";

function widget(data: unknown): NotebookWidget {
	return notebookWidgetSchema.parse(data);
}

const OWNER = { kind: "owner", messageId: null, runId: null, componentId: null } as const;

/** One valid widget of each type, with fixed stamps for deterministic tests. */
export function notebookFixtures(): {
	readonly text: NotebookWidget;
	readonly metric: NotebookWidget;
	readonly chart: NotebookWidget;
	readonly table: NotebookWidget;
	readonly research: NotebookWidget;
} {
	return {
		text: widget({
			widgetId: "nb-text",
			type: "text",
			title: "Notes",
			size: "medium",
			text: "First paragraph.\n\nSecond paragraph.",
			createdAt: "2026-10-01T00:00:00Z",
			updatedAt: "2026-10-01T00:00:00Z",
			revision: 1,
			origin: OWNER,
		}),
		metric: widget({
			widgetId: "nb-metric",
			type: "metric",
			title: "Headline",
			size: "small",
			value: 42.5,
			unit: "GWh",
			change: 1.25,
			caption: "Storage demand",
			asOf: "2026-10-01",
			createdAt: "2026-10-01T00:00:00Z",
			updatedAt: "2026-10-01T00:00:00Z",
			revision: 1,
			origin: { kind: "assistant", messageId: null, runId: "run_1", componentId: null },
		}),
		chart: widget({
			widgetId: "nb-chart",
			type: "chart",
			title: "Demand",
			size: "medium",
			chartType: "line",
			unit: "GWh",
			series: [
				{
					name: "Base",
					points: [
						{ x: "2026", y: 120 },
						{ x: "2027", y: 140 },
					],
				},
				{
					name: "High",
					points: [
						{ x: "2026", y: 150 },
						{ x: "2027", y: 180 },
					],
				},
			],
			createdAt: "2026-10-01T00:00:00Z",
			updatedAt: "2026-10-01T00:00:00Z",
			revision: 1,
			origin: { kind: "chat", messageId: "msg_1", runId: null, componentId: null },
		}),
		table: widget({
			widgetId: "nb-table",
			type: "table",
			title: "Scenarios",
			size: "medium",
			columns: ["Year", "Base"],
			rows: [
				["2026", 120],
				["2027", 140],
			],
			createdAt: "2026-10-01T00:00:00Z",
			updatedAt: "2026-10-01T00:00:00Z",
			revision: 1,
			origin: OWNER,
		}),
		research: widget({
			widgetId: "nb-research",
			type: "research",
			title: "Demand scenarios",
			size: "large",
			componentId: "run_1_table",
			createdAt: "2026-10-01T00:00:00Z",
			updatedAt: "2026-10-01T00:00:00Z",
			revision: 1,
			origin: { kind: "chat", messageId: null, runId: "run_1", componentId: "run_1_table" },
		}),
	};
}

export interface NotebookServerState {
	widgets: NotebookWidget[];
	version: number;
	history: NotebookWidget[][];
	updatedAt: string | null;
}

export function initialNotebookServerState(
	widgets: readonly NotebookWidget[] = [],
): NotebookServerState {
	return { widgets: [...widgets], version: 0, history: [], updatedAt: null };
}

function coreJson(widget: NotebookWidget): string {
	const { createdAt: _c, updatedAt: _u, revision: _r, origin: _o, ...core } = widget;
	void _c;
	void _u;
	void _r;
	void _o;
	return JSON.stringify(core);
}

/** The server stamps revisions: unchanged widgets keep theirs, changed ones bump. */
function stamp(
	stored: readonly NotebookWidget[],
	incoming: readonly NotebookWidget[],
): NotebookWidget[] {
	const byId = new Map(stored.map((entry) => [entry.widgetId, entry] as const));
	return incoming.map((entry) => {
		const old = byId.get(entry.widgetId);
		if (old === undefined) {
			return notebookWidgetSchema.parse({ ...entry, createdAt: NOW, updatedAt: NOW, revision: 1 });
		}
		if (coreJson(old) === coreJson(entry)) return old;
		return notebookWidgetSchema.parse({
			...entry,
			createdAt: old.createdAt,
			updatedAt: NOW,
			revision: old.revision + 1,
			origin: old.origin,
		});
	});
}

function responseFor(server: NotebookServerState): NotebookResponse {
	return notebookResponseSchema.parse({
		workspaceId: WORKSPACE_ID,
		notebook: { widgets: server.widgets },
		version: server.version,
		updatedAt: server.updatedAt,
		undoAvailable: server.history.length > 0,
		turns: [],
	});
}

export function notebookResponseFor(server: NotebookServerState): NotebookResponse {
	return responseFor(server);
}

/** The compare-and-set PUT as a pure-ish step, so tests can gate or script it. */
export function applyNotebookPut(server: NotebookServerState, body: unknown): Response {
	const parsed = putNotebookRequestSchema.safeParse(body);
	if (!parsed.success) return errorResponse(400, "VALIDATION_FAILED", "notebook is required");
	if (parsed.data.expectedVersion !== server.version) {
		return errorResponse(409, "VERSION_CONFLICT", "The notebook changed; reload and try again.");
	}
	server.history = [...server.history, server.widgets].slice(-20);
	server.widgets = stamp(server.widgets, parsed.data.notebook.widgets);
	server.version += 1;
	server.updatedAt = NOW;
	return jsonResponse(responseFor(server));
}

/**
 * Notebook routes with compare-and-set and undo, backed by mutable `server`
 * state. Tests mutate `server` to simulate another writer; later
 * registrations win, so a test can override one route (e.g. a 500 PUT).
 */
export function installNotebookRoutes(backend: FakeBackend, server: NotebookServerState): void {
	backend.on("GET", /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/, () =>
		jsonResponse(responseFor(server)),
	);
	backend.on("PUT", /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/, (request) =>
		applyNotebookPut(server, request.body),
	);
	backend.on("POST", /^\/api\/v1\/workspaces\/([^/?]+)\/notebook\/undo$/, (request) => {
		const parsed = undoNotebookRequestSchema.safeParse(request.body);
		if (!parsed.success)
			return errorResponse(400, "VALIDATION_FAILED", "expectedVersion is required");
		if (parsed.data.expectedVersion !== server.version || server.history.length === 0) {
			return errorResponse(409, "VERSION_CONFLICT", "The notebook changed; reload and try again.");
		}
		const restored = server.history[server.history.length - 1];
		if (restored === undefined) {
			return errorResponse(409, "VERSION_CONFLICT", "The notebook changed; reload and try again.");
		}
		server.history = [...server.history.slice(0, -1), server.widgets];
		server.widgets = restored;
		server.version += 1;
		server.updatedAt = NOW;
		return jsonResponse(responseFor(server));
	});
}

export function createNotebookBackend(widgets: readonly NotebookWidget[] = []): {
	readonly backend: FakeBackend;
	readonly server: NotebookServerState;
} {
	const backend = createFakeBackend();
	const server = initialNotebookServerState(widgets);
	installNotebookRoutes(backend, server);
	return { backend, server };
}
