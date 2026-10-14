import { createBaselineUiRegistry } from "@research/ui-registry";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../../src/api/client.ts";
import { NotebookPanel } from "../../src/notebook/NotebookPanel.tsx";
import { createNotebookSession, type NotebookSession } from "../../src/notebook/notebookSession.ts";
import type { FakeBackend } from "../fakeBackend.ts";
import { ALWAYS_VISIBLE } from "../fakeBackend.ts";
import { WORKSPACE_VIEW } from "../fixtures.ts";
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
let asked: string[][];
let origins: unknown[];
const rootDisposers: (() => void)[] = [];

function createSession(): void {
	const api = createApiClient({ fetch: backend.fetch });
	asked = [];
	origins = [];
	// The session lives in its own root, next to where OpenWorkspace will
	// keep it: creating it inside `render` would re-create it on every
	// render-effect re-run (Solid's `render` is reactive), fetching forever.
	const release = createRoot((dispose) => {
		session = createNotebookSession(api, WORKSPACE_ID, ALWAYS_VISIBLE);
		return dispose;
	});
	rootDisposers.push(release);
	render(() => (
		<NotebookPanel
			session={session}
			registry={registry}
			view={WORKSPACE_VIEW}
			mode="notebook"
			onAskAssistant={(ids) => {
				asked.push([...ids]);
			}}
			onOpenOrigin={(origin) => {
				origins.push(origin);
			}}
		/>
	));
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
	const item = await waitFor(() => within(article).getByRole("menuitem", { name: itemName }));
	fireEvent.click(item);
}

beforeEach(() => {
	resetGlobalFetchCalls();
	asked = [];
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

	it("marks selected frames and shows the contextual bar", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		session.select("nb-text", "replace");
		await waitFor(() => expect(screen.queryByText("1 selected")).not.toBeNull());
		expect(articleById("nb-text").getAttribute("data-widget-selected")).not.toBeNull();
		expect(articleById("nb-metric").getAttribute("data-widget-selected")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
		await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
		expect(articleById("nb-text").getAttribute("data-widget-selected")).toBeNull();
	});

	it("clears the selection on Escape with focus inside the panel", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		session.select("nb-text", "replace");
		await waitFor(() => expect(screen.queryByText("1 selected")).not.toBeNull());
		const panel = document.querySelector('section[data-panel="notebook"]');
		if (!(panel instanceof HTMLElement)) throw new Error("no notebook panel");
		fireEvent.keyDown(panel, { key: "Escape" });
		await waitFor(() => expect(screen.queryByText("1 selected")).toBeNull());
	});

	it("asks the assistant about the selection from the bar", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		session.select("nb-text", "replace");
		session.select("nb-metric", "toggle");
		await waitFor(() => expect(screen.queryByText("2 selected")).not.toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Ask AI about the selected widgets" }));
		expect(asked).toEqual([["nb-text", "nb-metric"]]);
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

	it("confirms once when removing several selected widgets", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		session.select("nb-text", "replace");
		session.select("nb-table", "toggle");
		await waitFor(() => expect(screen.queryByText("2 selected")).not.toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Remove selected widgets" }));
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no remove dialog yet");
			return found;
		});
		expect(dialog.textContent).toContain("Remove 2 widgets?");
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
		await waitFor(() => expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(1));
		await waitFor(() => expect(articles()).toHaveLength(3));
		expect(document.querySelector('article[data-widget-id="nb-text"]')).toBeNull();
		expect(document.querySelector('article[data-widget-id="nb-table"]')).toBeNull();
	});

	it("names the widget in a single remove confirmation", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		await chooseMenuItem("nb-metric", "Remove…");
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no remove dialog yet");
			return found;
		});
		expect(dialog.textContent).toContain("Remove “Headline”?");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(document.querySelector("dialog")).toBeNull());
		expect(articles()).toHaveLength(5);
		expect(backend.requestsTo("PUT", NOTEBOOK_PUT)).toHaveLength(0);
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
		const textarea = within(dialog).getByLabelText("Text");
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

	it("navigates to a widget's source only when it has one", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		// The chart was saved from a chat message: the menu offers the source.
		const chart = articleById("nb-chart");
		fireEvent.click(actionsButton(chart));
		const source = await waitFor(() =>
			within(chart).getByRole("menuitem", { name: "Go to source" }),
		);
		fireEvent.click(source);
		expect(origins).toHaveLength(1);
		// The text widget is owner-made: no source item.
		const text = articleById("nb-text");
		fireEvent.click(actionsButton(text));
		await waitFor(() => within(text).getByRole("menuitem", { name: "Edit…" }));
		expect(within(text).queryByRole("menuitem", { name: "Go to source" })).toBeNull();
	});

	it("undoes through the header button when an undo is available", async () => {
		createSession();
		await waitFor(() => expect(articles()).toHaveLength(5), { timeout: 10_000 });
		const undo = screen.getByRole("button", { name: "Undo" });
		expect(undo.hasAttribute("disabled")).toBe(true);
		await chooseMenuItem("nb-text", "Remove…");
		const dialog = await waitFor(() => {
			const found = document.querySelector("dialog");
			if (!(found instanceof HTMLElement)) throw new Error("no remove dialog yet");
			return found;
		});
		fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
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
				session = createNotebookSession(api, WORKSPACE_ID, ALWAYS_VISIBLE);
				return dispose;
			}),
		);
		render(() => (
			<NotebookPanel
				session={session}
				registry={registry}
				view={WORKSPACE_VIEW}
				mode="chat"
				onAskAssistant={(ids) => {
					asked.push([...ids]);
				}}
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
