import { createBaselineUiRegistry } from "@research/ui-registry";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.ts";
import { NotebookPanel } from "../../src/notebook/NotebookPanel.tsx";
import { notebookSessionMessages } from "../../src/notebook/notebook.messages.ts";
import { createNotebookSession, type NotebookSession } from "../../src/notebook/notebookSession.ts";
import {
	createWidgetClipboardStore,
	parseWidgetClipboardJson,
	WIDGET_CLIPBOARD_STORAGE_KEY,
	type WidgetClipboardStore,
} from "../../src/widgets/widgetClipboard.ts";
import type { FakeBackend } from "../fakeBackend.ts";
import { ALWAYS_VISIBLE } from "../fakeBackend.ts";
import { WORKSPACE_VIEW } from "../fixtures.ts";
import { lastOpenMenu } from "../openMenu.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "../setup.ts";
import {
	createNotebookBackend,
	type NotebookServerState,
	notebookFixtures,
	WORKSPACE_ID,
} from "./notebookHarness.ts";

const registry = createBaselineUiRegistry();
const NOTEBOOK_PUT = /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/;

let backend: FakeBackend;
let server: NotebookServerState;
let session!: NotebookSession;
let origins: unknown[];
const rootDisposers: (() => void)[] = [];

function createSession(clipboard?: WidgetClipboardStore): void {
	const api = createApiClient({ fetch: backend.fetch });
	origins = [];
	// The session lives in its own root, next to where OpenWorkspace will
	// keep it: creating it inside `render` would re-create it on every
	// render-effect re-run (Solid's `render` is reactive), fetching forever.
	const release = createRoot((dispose) => {
		session = createNotebookSession(
			api,
			WORKSPACE_ID,
			ALWAYS_VISIBLE,
			() => notebookSessionMessages.en,
		);
		return dispose;
	});
	rootDisposers.push(release);
	render(() => (
		<NotebookPanel
			session={session}
			api={api}
			registry={registry}
			view={WORKSPACE_VIEW}
			mode="notebook"
			clipboard={clipboard}
			onOpenOrigin={(origin) => {
				origins.push(origin);
			}}
		/>
	));
}

/** A clipboard backed by a plain map, so no test leaks through `localStorage`. */
function createMemoryClipboard(): {
	readonly store: WidgetClipboardStore;
	readonly map: Map<string, string>;
} {
	const map = new Map<string, string>();
	let store!: WidgetClipboardStore;
	const release = createRoot((dispose) => {
		store = createWidgetClipboardStore({
			getItem: (key) => map.get(key) ?? null,
			setItem: (key, value) => {
				map.set(key, value);
			},
			removeItem: (key) => {
				map.delete(key);
			},
		});
		return dispose;
	});
	rootDisposers.push(release);
	return { store, map };
}

function actionLiveRegion(): HTMLElement {
	const live = document.querySelector("output.sr-only[aria-live='polite']");
	if (!(live instanceof HTMLElement)) throw new Error("no action live region");
	return live;
}

function articles(): HTMLElement[] {
	return [...document.querySelectorAll("article[data-widget-id]")].filter(
		(article): article is HTMLElement => article instanceof HTMLElement,
	);
}

function articleById(id: string): HTMLElement {
	const article = document.querySelector(`article[data-widget-id="${id}"]`);
	if (!(article instanceof HTMLElement)) throw new Error(`widget ${id} is missing`);
	return article;
}

function actionsButton(article: HTMLElement): HTMLElement {
	const button = article.querySelector("button[data-widget-actions]");
	if (!(button instanceof HTMLElement)) throw new Error("no widget actions button");
	return button;
}

async function chooseMenuItem(widgetId: string, itemName: string): Promise<void> {
	const article = articleById(widgetId);
	fireEvent.click(actionsButton(article));
	// The open menu renders in a portal on <body>, not inside the article.
	const item = await waitFor(() =>
		within(lastOpenMenu()).getByRole("menuitem", { name: itemName }),
	);
	fireEvent.click(item);
}

beforeEach(() => {
	resetGlobalFetchCalls();
	origins = [];
	const fixtures = notebookFixtures();
	({ backend, server } = createNotebookBackend([
		fixtures.text,
		fixtures.metric,
		fixtures.chart,
		fixtures.table,
		fixtures.research,
	]));
});

afterEach(() => {
	cleanup();
	while (rootDisposers.length > 0) rootDisposers.pop()?.();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("notebook panel", () => {
	it("shows the title with a quiet count and every widget type", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		expect(screen.getByRole("heading", { level: 3, name: /Notebook/ }).textContent).toContain(
			"(5)",
		);
		// Text, metric, chart (svg), table, and the research component's own table.
		expect(articleById("nb-text").textContent).toContain("First paragraph.");
		expect(articleById("nb-metric").textContent).toContain("42.5");
		expect(articleById("nb-chart").querySelector("svg[role='img']")).not.toBeNull();
		expect(within(articleById("nb-table")).getByRole("table")).toBeDefined();
		expect(articleById("nb-research").textContent).toContain("Grid storage demand by year");
		expect(document.querySelector('section[data-panel="notebook"]')).not.toBeNull();
		expect(document.querySelector('section[data-mode="notebook"]')).not.toBeNull();
	});

	it("shows the empty state when nothing is saved", async () => {
		const { backend: emptyBackend } = createNotebookBackend([]);
		backend = emptyBackend;
		createSession();
		await waitFor(() =>
			expect(document.body.textContent).toContain(
				"Save answers, charts and tables from Chat to build your notebook.",
			),
		);
		expect(articles()).toHaveLength(0);
	});

	it("offers no widget selection: no select toggle, no selection bar, no Ask AI", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		// Widget selection was removed (2026-11-02).
		expect(document.querySelector(".wg-select-toggle")).toBeNull();
		const grip = articleById("nb-text").querySelector(".wg-grip");
		if (!(grip instanceof Element)) throw new Error("no widget grip");
		fireEvent.click(grip);
		expect(articleById("nb-text").getAttribute("data-widget-selected")).toBeNull();
		expect(screen.queryByRole("toolbar", { name: "Selected widgets" })).toBeNull();
		fireEvent.click(actionsButton(articleById("nb-text")));
		const menu = await waitFor(() => lastOpenMenu());
		expect(within(menu).queryByRole("menuitem", { name: "Ask AI" })).toBeNull();
	});

	it("changes a widget size through its menu", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		expect(articleById("nb-text").getAttribute("data-widget-size")).toBe("medium");
		await chooseMenuItem("nb-text", "Size: Large");
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() =>
			expect(articleById("nb-text").getAttribute("data-widget-size")).toBe("large"),
		);
	});

	it("moves a widget earlier and announces it", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-metric", "Move earlier");
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() =>
			expect(articles().map((article) => article.getAttribute("data-widget-id"))[0]).toBe(
				"nb-metric",
			),
		);
		const live = document.querySelector("output[aria-live='polite']");
		if (!(live instanceof HTMLElement)) throw new Error("no polite live region");
		await waitFor(() => expect(live.textContent).toBe("Moved “Headline” to position 1 of 5."));
	});

	it("removes one widget from its menu without a dialog and announces it", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-metric", "Remove");
		await waitFor(() => expect(articles()).toHaveLength(4));
		expect(document.querySelector("dialog")).toBeNull();
		expect(document.querySelector('article[data-widget-id="nb-metric"]')).toBeNull();
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1);
		await waitFor(() =>
			expect(actionLiveRegion().textContent).toBe("Removed 1 widget. Undo restores it."),
		);
	});

	it("adds a starter widget and opens its editor", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		fireEvent.click(screen.getByRole("button", { name: "Add widget" }));
		const addItem = await waitFor(() => screen.getByRole("menuitem", { name: "Text" }));
		fireEvent.click(addItem);
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no editor yet");
			return found;
		});
		expect(dialog.textContent).toContain("Edit text widget");
		await waitFor(() => expect(articles()).toHaveLength(6));
	});

	it("never saves an invalid widget from the editor", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-text", "Edit…");
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no editor yet");
			return found;
		});
		const textarea = within(dialog).getByLabelText("Text (Markdown)");
		if (!(textarea instanceof HTMLTextAreaElement)) throw new Error("no text field");
		fireEvent.input(textarea, { target: { value: "" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(within(dialog).getByLabelText("Problems")).toBeDefined());
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
		// Fixing it saves.
		fireEvent.input(textarea, { target: { value: "Revised notes." } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(document.querySelector("dialog")).toBeNull());
		expect(articleById("nb-text").textContent).toContain("Revised notes.");
	});

	it("shows chart parse errors inline without saving", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-chart", "Edit…");
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no editor yet");
			return found;
		});
		const series = within(dialog).getByLabelText(/Series/);
		if (!(series instanceof HTMLTextAreaElement)) throw new Error("no series field");
		fireEvent.input(series, { target: { value: "Base\nnot a point line" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(within(dialog).getByLabelText("Problems")).toBeDefined());
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
	});

	it("shows table shape errors inline without saving", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-table", "Edit…");
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no editor yet");
			return found;
		});
		const rows = within(dialog).getByLabelText(/Rows/);
		if (!(rows instanceof HTMLTextAreaElement)) throw new Error("no rows field");
		fireEvent.input(rows, { target: { value: "only-one-cell" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(within(dialog).getByLabelText("Problems")).toBeDefined());
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
	});

	it("edits a metric and keeps its identity, size and position", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		const orderBefore = articles().map((article) => article.getAttribute("data-widget-id"));
		await chooseMenuItem("nb-metric", "Edit…");
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no editor yet");
			return found;
		});
		const value = within(dialog).getByLabelText(/Value/);
		if (!(value instanceof HTMLInputElement)) throw new Error("no value field");
		fireEvent.input(value, { target: { value: "not-a-number" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(within(dialog).getByLabelText("Problems")).toBeDefined());
		fireEvent.input(value, { target: { value: "44" } });
		fireEvent.click(within(dialog).getByRole("button", { name: "Save widget" }));
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(articleById("nb-metric").textContent).toContain("44"));
		expect(articles().map((article) => article.getAttribute("data-widget-id"))).toEqual(
			orderBefore,
		);
		expect(articleById("nb-metric").getAttribute("data-widget-size")).toBe("small");
	});

	it("duplicates a widget directly after its original", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-text", "Duplicate");
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(articles()).toHaveLength(6));
		const ids = articles().map((article) => article.getAttribute("data-widget-id"));
		expect(ids[0]).toBe("nb-text");
		expect(ids[1]).not.toBe("nb-text");
		expect(articles()[1]?.textContent).toContain("First paragraph.");
	});

	it("cuts a widget through its menu and offers paste in the header", async () => {
		const { store: clipboard } = createMemoryClipboard();
		createSession(clipboard);
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		const paste = screen.getByRole("button", { name: "Paste widgets" });
		expect(paste.hasAttribute("disabled")).toBe(true);
		await chooseMenuItem("nb-text", "Cut");
		// One save removes the widget; the clipboard still holds it.
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(articles()).toHaveLength(4));
		expect(document.querySelector('article[data-widget-id="nb-text"]')).toBeNull();
		expect(clipboard.content()?.entries.map((item) => item.core.widgetId)).toEqual(["nb-text"]);
		await waitFor(() => expect(paste.hasAttribute("disabled")).toBe(false));
		await waitFor(() => expect(actionLiveRegion().textContent).toBe("Cut 1 widget."), {
			timeout: 10_000,
		});
	});

	it("persists a cut so a reloaded page reads it back", async () => {
		const { store: clipboard, map } = createMemoryClipboard();
		createSession(clipboard);
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-text", "Cut");
		await waitFor(() => expect(articles()).toHaveLength(4));
		// The stored JSON re-parses (no metadata stows away inside `core`,
		// which the strict contract schema would reject): a reloaded page
		// sees the same clipboard.
		const raw = map.get(WIDGET_CLIPBOARD_STORAGE_KEY) ?? null;
		const reread = parseWidgetClipboardJson(raw);
		expect(reread?.sourceWorkspaceId).toBe(WORKSPACE_ID);
		expect(reread?.entries.map((item) => item.core.widgetId)).toEqual(["nb-text"]);
		expect(reread).toEqual(clipboard.content());
	});

	it("pastes a copy after another widget", async () => {
		const { store: clipboard } = createMemoryClipboard();
		createSession(clipboard);
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-text", "Copy");
		// Copy saves nothing.
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
		expect(clipboard.content()?.entries.map((item) => item.core.widgetId)).toEqual(["nb-text"]);
		await chooseMenuItem("nb-metric", "Paste after");
		// Paste is one save inserting after the anchored widget.
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(articles()).toHaveLength(6));
		const ids = articles().map((article) => article.getAttribute("data-widget-id"));
		expect(ids.slice(0, 2)).toEqual(["nb-text", "nb-metric"]);
		expect(ids.slice(3)).toEqual(["nb-chart", "nb-table", "nb-research"]);
		const pasted = ids[2];
		if (pasted === null || pasted === undefined || ["nb-text", "nb-metric"].includes(pasted))
			throw new Error("the pasted widget has no fresh id");
		expect(articles()[2]?.textContent).toContain("First paragraph.");
		await waitFor(() => expect(actionLiveRegion().textContent).toBe("Pasted 1 widget."), {
			timeout: 10_000,
		});
	});

	it("says when research widgets stay in their own chat", async () => {
		const { store: clipboard } = createMemoryClipboard();
		clipboard.set("ws_other", [
			{
				core: {
					widgetId: "nb-research",
					type: "research",
					title: "Demand scenarios",
					size: "large",
					componentId: "run_1_table",
				},
				origin: { kind: "chat", messageId: null, runId: "run_1", componentId: "run_1_table" },
			},
		]);
		createSession(clipboard);
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		fireEvent.click(screen.getByRole("button", { name: "Paste widgets" }));
		await waitFor(() =>
			expect(document.body.textContent).toContain(
				"1 research result stays in its own chat and was not pasted.",
			),
		);
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
		expect(articles()).toHaveLength(5);
	});

	it("pastes with Ctrl+V at the end; Ctrl+C copies no widget", async () => {
		const { store: clipboard } = createMemoryClipboard();
		createSession(clipboard);
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		const panel = document.querySelector('section[data-panel="notebook"]');
		if (!(panel instanceof HTMLElement)) throw new Error("no notebook panel");
		// With no selection, Ctrl+C has no widgets to copy: it stays the browser's.
		fireEvent.keyDown(panel, { key: "c", ctrlKey: true });
		expect(clipboard.content()).toBeNull();
		await chooseMenuItem("nb-chart", "Copy");
		expect(clipboard.content()?.entries.map((item) => item.core.widgetId)).toEqual(["nb-chart"]);
		fireEvent.keyDown(panel, { key: "v", ctrlKey: true });
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(articles()).toHaveLength(6));
		const pastedIds = articles().map((article) => article.getAttribute("data-widget-id"));
		expect(pastedIds.slice(0, 5)).toEqual([
			"nb-text",
			"nb-metric",
			"nb-chart",
			"nb-table",
			"nb-research",
		]);
		expect(pastedIds[5]).not.toBe("nb-chart");
		expect(articles()[5]?.textContent).toContain("Demand");
	});

	it("leaves Ctrl+V inside a text field to the browser", async () => {
		const { store: clipboard } = createMemoryClipboard();
		createSession(clipboard);
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		const panel = document.querySelector('section[data-panel="notebook"]');
		if (!(panel instanceof HTMLElement)) throw new Error("no notebook panel");
		await chooseMenuItem("nb-text", "Copy");
		const field = document.createElement("textarea");
		panel.appendChild(field);
		fireEvent.keyDown(field, { key: "v", ctrlKey: true });
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
		field.remove();
	});

	it("navigates to a widget's source only when it has one", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		// The chart was saved from a chat message: the menu offers the source.
		const chart = articleById("nb-chart");
		fireEvent.click(actionsButton(chart));
		const source = await waitFor(() =>
			within(lastOpenMenu()).getByRole("menuitem", { name: "Go to source" }),
		);
		fireEvent.click(source);
		expect(origins).toHaveLength(1);
		// The text widget is owner-made: no source item.
		const text = articleById("nb-text");
		fireEvent.click(actionsButton(text));
		const textMenu = await waitFor(() => screen.getByRole("menu", { name: /Actions for/ }));
		within(textMenu).getByRole("menuitem", { name: "Edit…" });
		expect(within(textMenu).queryByRole("menuitem", { name: "Go to source" })).toBeNull();
	});

	it("undoes through the header button when an undo is available", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		const undo = screen.getByRole("button", { name: "Undo" });
		expect(undo.hasAttribute("disabled")).toBe(true);
		await chooseMenuItem("nb-text", "Remove");
		await waitFor(() => expect(articles()).toHaveLength(4));
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "Undo" }).hasAttribute("disabled")).toBe(false),
		);
		fireEvent.click(screen.getByRole("button", { name: "Undo" }));
		await waitFor(() => expect(articles()).toHaveLength(5));
		expect(server.version).toBe(2);
	});

	it("renders as the narrow chat panel with everything working", async () => {
		const api = createApiClient({ fetch: backend.fetch });
		rootDisposers.push(
			createRoot((dispose) => {
				session = createNotebookSession(
					api,
					WORKSPACE_ID,
					ALWAYS_VISIBLE,
					() => notebookSessionMessages.en,
				);
				return dispose;
			}),
		);
		render(() => (
			<NotebookPanel
				session={session}
				api={api}
				registry={registry}
				view={WORKSPACE_VIEW}
				mode="chat"
			/>
		));
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		expect(document.querySelector('section[data-mode="chat"]')).not.toBeNull();
		await chooseMenuItem("nb-text", "Size: Small");
		await waitFor(() =>
			expect(articleById("nb-text").getAttribute("data-widget-size")).toBe("small"),
		);
	});
});
