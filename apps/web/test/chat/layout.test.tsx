import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "../appHarness.tsx";
import { createFakeBackend, type FakeBackend } from "../fakeBackend.ts";
import { WORKSPACE_ID } from "../fixtures.ts";
import { makeNotebookResponse, makeNotebookWidget } from "./notebookFixtures.ts";

let backend: FakeBackend;
let server: ServerState;

function wideMatchMedia(matches: boolean): () => void {
	const original = window.matchMedia;
	const listeners = new Set<() => void>();
	window.matchMedia = ((query: string) => ({
		matches,
		media: query,
		addEventListener: (_type: string, listener: () => void) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: () => void) => {
			listeners.delete(listener);
		},
	})) as unknown as typeof window.matchMedia;
	return () => {
		window.matchMedia = original;
	};
}

beforeEach(() => {
	backend = createFakeBackend();
	server = initialServerState();
	installWorkspaceRoutes(backend, server);
	window.location.hash = `#/chat/${WORKSPACE_ID}`;
	window.localStorage.clear();
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	window.localStorage.clear();
});

function notebookGets(): number {
	return backend.requestsTo("GET", /\/notebook$/).length;
}

async function workspaceReady(): Promise<void> {
	await screen.findByRole("region", { name: "Conversation" });
	await screen.findByRole("article", { name: "Assistant message" });
	await screen.findByRole("region", { name: "Notebook" });
}

function gridTemplate(): string {
	const chat = document.querySelector('section[data-panel="chat"]');
	const grid = chat?.parentElement?.parentElement;
	return grid?.getAttribute("class") ?? "";
}

describe("two-state workspace layout", () => {
	it("opens Chat-first with the chat-dominant grid", async () => {
		const restore = wideMatchMedia(true);
		try {
			mountApp(backend);
			await workspaceReady();
			expect(gridTemplate()).toContain("minmax(0,3fr)_minmax(0,1fr)");
			const chat = document.querySelector('section[data-panel="chat"]');
			expect(chat?.className).not.toContain("hidden");
			// Both states offer the manual control in both headers.
			expect(screen.getAllByRole("button", { name: "Focus Notebook" })).toHaveLength(2);
			expect(screen.getAllByRole("button", { name: "Focus Chat" })).toHaveLength(2);
			expect(
				screen.getAllByRole("button", { name: "Focus Notebook" })[0]?.getAttribute("aria-pressed"),
			).toBe("false");
		} finally {
			restore();
		}
	});

	it("switches to Notebook-first and back, changing only the grid template", async () => {
		const restore = wideMatchMedia(true);
		try {
			mountApp(backend);
			await workspaceReady();
			fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
			await waitFor(() => expect(gridTemplate()).toContain("minmax(0,1fr)_minmax(0,3fr)"));
			expect(window.localStorage.getItem(`research.workspace-mode.${WORKSPACE_ID}`)).toBe(
				"notebook",
			);
			const chat = document.querySelector('section[data-panel="chat"]');
			expect(chat?.className).toContain("hidden");
			fireEvent.click(screen.getAllByRole("button", { name: "Focus Chat" })[0] as HTMLElement);
			await waitFor(() => expect(gridTemplate()).toContain("minmax(0,3fr)_minmax(0,1fr)"));
			expect(window.localStorage.getItem(`research.workspace-mode.${WORKSPACE_ID}`)).toBe("chat");
		} finally {
			restore();
		}
	});

	it("keeps the draft, thread, notebook and session across two switches (one factory call)", async () => {
		const restore = wideMatchMedia(true);
		try {
			server.notebook = makeNotebookResponse({
				notebook: {
					widgets: [makeNotebookWidget(), makeNotebookWidget({ widgetId: "nb_2", title: "Costs" })],
				},
				version: 2,
				undoAvailable: true,
			});
			mountApp(backend);
			await workspaceReady();
			const chat = document.querySelector('section[data-panel="chat"]');
			const notebook = document.querySelector('div[data-panel="notebook"]');
			const box = (await screen.findByRole("textbox", { name: "Question" })) as HTMLTextAreaElement;
			fireEvent.input(box, { target: { value: "draft for the next question" } });
			expect(screen.getByText("Where will storage demand grow?")).toBeDefined();

			fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
			await waitFor(() => expect(gridTemplate()).toContain("minmax(0,1fr)_minmax(0,3fr)"));
			fireEvent.click(screen.getAllByRole("button", { name: "Focus Chat" })[0] as HTMLElement);
			await waitFor(() => expect(gridTemplate()).toContain("minmax(0,3fr)_minmax(0,1fr)"));

			// The same DOM nodes: nothing was re-created by either switch.
			expect(screen.getByRole("textbox", { name: "Question" })).toBe(box);
			expect(box.value).toBe("draft for the next question");
			expect(document.querySelector('section[data-panel="chat"]')).toBe(chat);
			expect(document.querySelector('div[data-panel="notebook"]')).toBe(notebook);
			expect(screen.getByText("Where will storage demand grow?")).toBeDefined();
			expect(screen.getByText("Revenue")).toBeDefined();
			expect(screen.getByText("Costs")).toBeDefined();
			// The notebook session factory ran once: one initial load, no second poller.
			expect(notebookGets()).toBe(1);
		} finally {
			restore();
		}
	});

	it("remembers Notebook-first across a reload", async () => {
		const restore = wideMatchMedia(true);
		try {
			const first = mountApp(backend);
			await workspaceReady();
			fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
			await waitFor(() => expect(gridTemplate()).toContain("minmax(0,1fr)_minmax(0,3fr)"));
			first.unmount();
			cleanup();

			mountApp(backend);
			await workspaceReady();
			expect(gridTemplate()).toContain("minmax(0,1fr)_minmax(0,3fr)");
			const chat = document.querySelector('section[data-panel="chat"]');
			expect(chat?.className).toContain("hidden");
		} finally {
			restore();
		}
	});

	it("collapses the secondary panel to a rail and expands it again", async () => {
		const restore = wideMatchMedia(true);
		try {
			mountApp(backend);
			await workspaceReady();
			// Chat-first: the Notebook is secondary and collapsible.
			fireEvent.click(screen.getByRole("button", { name: "Collapse Notebook panel" }));
			const expand = await screen.findByRole("button", { name: "Expand Notebook panel" });
			expect(expand.getAttribute("aria-expanded")).toBe("false");
			expect(screen.queryByRole("region", { name: "Notebook" })).toBeNull();
			fireEvent.click(expand);
			await screen.findByRole("region", { name: "Notebook" });

			// Notebook-first: Chat is secondary and collapsible instead.
			fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
			await waitFor(() => expect(gridTemplate()).toContain("minmax(0,1fr)_minmax(0,3fr)"));
			fireEvent.click(screen.getByRole("button", { name: "Collapse Chat panel" }));
			await screen.findByRole("button", { name: "Expand Chat panel" });
			expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
		} finally {
			restore();
		}
	});

	it("suggests focusing the notebook once it holds three widgets, dismissably", async () => {
		const restore = wideMatchMedia(true);
		try {
			server.notebook = makeNotebookResponse({
				notebook: {
					widgets: [
						makeNotebookWidget(),
						makeNotebookWidget({ widgetId: "nb_2", title: "Costs" }),
						makeNotebookWidget({ widgetId: "nb_3", title: "Risks" }),
					],
				},
				version: 3,
			});
			mountApp(backend);
			await workspaceReady();
			const suggestion = await screen.findByText(/Your notebook is taking shape/);
			expect(suggestion.textContent).toContain("Focus Notebook");
			// The suggestion never switches by itself.
			expect(gridTemplate()).toContain("minmax(0,3fr)_minmax(0,1fr)");
			fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestion" }));
			expect(screen.queryByText(/Your notebook is taking shape/)).toBeNull();
			// Dismissal is remembered per workspace: a remount stays quiet.
			cleanup();
			mountApp(backend);
			await workspaceReady();
			expect(screen.queryByText(/Your notebook is taking shape/)).toBeNull();
		} finally {
			restore();
		}
	});

	it("stays quiet below three widgets", async () => {
		const restore = wideMatchMedia(true);
		try {
			server.notebook = makeNotebookResponse({
				notebook: { widgets: [makeNotebookWidget()] },
				version: 1,
			});
			mountApp(backend);
			await workspaceReady();
			expect(screen.queryByText(/Your notebook is taking shape/)).toBeNull();
		} finally {
			restore();
		}
	});
});

describe("two-tab switcher below lg", () => {
	it("switches the mode through Chat and Notebook tabs", async () => {
		const restore = wideMatchMedia(false);
		try {
			mountApp(backend);
			await workspaceReady();
			const tablist = await screen.findByRole("tablist", { name: "Chat or Notebook" });
			const chatTab = within(tablist).getByRole("tab", { name: "Chat" });
			const notebookTab = within(tablist).getByRole("tab", { name: "Notebook" });
			// The default tab follows the remembered mode (Chat-first here).
			expect(chatTab.getAttribute("aria-selected")).toBe("true");
			expect(notebookTab.getAttribute("aria-selected")).toBe("false");
			// Below `lg` visibility is classes (happy-dom applies no
			// stylesheet): the inactive panel carries `hidden`.
			const notebookWrap = (): string =>
				document.querySelector('div[data-panel="notebook"]')?.getAttribute("class") ?? "";
			const chatPanel = (): string =>
				document.querySelector('section[data-panel="chat"]')?.getAttribute("class") ?? "";
			expect(notebookWrap()).toContain("hidden");
			expect(chatPanel()).not.toContain("hidden");

			fireEvent.click(notebookTab);
			await waitFor(() => expect(notebookTab.getAttribute("aria-selected")).toBe("true"));
			expect(notebookWrap()).not.toContain("hidden");
			expect(chatPanel()).toContain("hidden");
			// The selected tab IS the mode: it persists.
			expect(window.localStorage.getItem(`research.workspace-mode.${WORKSPACE_ID}`)).toBe(
				"notebook",
			);

			fireEvent.click(chatTab);
			await waitFor(() => expect(chatTab.getAttribute("aria-selected")).toBe("true"));
			expect(chatPanel()).not.toContain("hidden");
		} finally {
			restore();
		}
	});

	it("opens on the remembered Notebook tab", async () => {
		const restore = wideMatchMedia(false);
		try {
			window.localStorage.setItem(`research.workspace-mode.${WORKSPACE_ID}`, "notebook");
			mountApp(backend);
			await screen.findByRole("region", { name: "Notebook" });
			const tablist = await screen.findByRole("tablist", { name: "Chat or Notebook" });
			expect(
				within(tablist).getByRole("tab", { name: "Notebook" }).getAttribute("aria-selected"),
			).toBe("true");
		} finally {
			restore();
		}
	});
});
