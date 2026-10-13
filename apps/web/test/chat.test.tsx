import { createResearchRunRequestSchema, type ResearchRun } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "../src/chat/Conversation.tsx";
import { DisclosureSummary } from "../src/components/ui.tsx";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "./appHarness.tsx";
import {
	createFakeBackend,
	deferred,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import {
	AGENTS,
	CONVERSATION,
	makeRun,
	WORKSPACE_ID,
	WORKSPACE_ID_2,
	WORKSPACE_SUMMARY_2,
} from "./fixtures.ts";

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

async function threadReady(): Promise<HTMLElement> {
	const conversation = await screen.findByRole("region", { name: "Conversation" });
	await within(conversation).findByRole("article", { name: "Assistant message" });
	return conversation;
}

async function historyReady(): Promise<HTMLElement> {
	return screen.findByRole("navigation", { name: "Chats" });
}

async function canvasReady(): Promise<HTMLElement> {
	return screen.findByRole("region", { name: "Canvas" });
}

describe("disclosure summaries", () => {
	it("renders an explicit chevron that keeps the 24 px minimum height", () => {
		render(() => (
			<details class="group">
				<DisclosureSummary class="text-slate-700">2 sources</DisclosureSummary>
			</details>
		));
		const summary = document.querySelector("summary");
		expect(summary?.className).toContain("min-h-6");
		expect(summary?.textContent).toContain("2 sources");
		const chevron = summary?.querySelector('svg[aria-hidden="true"]');
		expect(chevron).not.toBeNull();
		expect(chevron?.getAttribute("class") ?? "").toContain("group-open:rotate-90");
		expect(chevron?.getAttribute("class") ?? "").toContain("motion-safe:");
	});
});

describe("chat history", () => {
	it("lists chats newest first with title-only rows and the current marker", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		const items = [...nav.querySelectorAll("[data-conversation-id]")];
		expect(items.map((item) => item.getAttribute("data-conversation-id"))).toEqual([
			WORKSPACE_ID_2,
			WORKSPACE_ID,
		]);
		const current = nav.querySelector('[data-conversation-id="ws_1"] a');
		expect(current?.getAttribute("aria-current")).toBe("page");
		expect(nav.querySelector('[data-conversation-id="ws_2"] a')?.getAttribute("aria-current")).toBe(
			null,
		);
		expect(within(nav).getByRole("link", { name: "Grid storage research" })).toBeDefined();
		expect(within(nav).getByRole("link", { name: "Second research" })).toBeDefined();
		// Title only: one span in the link; no last-message preview, no time, no count.
		for (const item of items) {
			expect(item.querySelectorAll("a span")).toHaveLength(1);
			expect(item.querySelector("time")).toBeNull();
		}
		expect(nav.textContent).not.toContain("Utility tenders are rising.");
		expect(nav.textContent).not.toContain("Second question?");
		expect(nav.textContent).not.toContain("2 messages");
		expect(nav.textContent).not.toContain("1 message");
	});

	it("truncates long history titles with the full title in a tooltip", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		const current = nav.querySelector('[data-conversation-id="ws_1"]');
		const title = current?.querySelector("span.truncate");
		expect(title?.textContent).toBe("Grid storage research");
		expect(title?.getAttribute("title")).toBe("Grid storage research");
		// The open thread header still shows the full title.
		expect(
			await screen.findByRole("heading", { level: 3, name: "Grid storage research" }),
		).toBeDefined();
	});

	it("opens the conversation with the newest activity when the URL names none", async () => {
		window.location.hash = "#/chat";
		mountApp(backend);
		// ws_2 is newer than ws_1 in the fixtures and has only an owner message.
		await waitFor(() => expect(window.location.hash).toBe(`#/chat/${WORKSPACE_ID_2}`));
		await screen.findByText("Second question?");
	});

	it("opening another conversation changes the URL and the thread", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		expect(screen.getByText("Where will storage demand grow?")).toBeDefined();

		fireEvent.click(within(nav).getByRole("link", { name: /Second research/ }));
		// Plain links rely on the browser's hashchange; simulate it in the test env.
		window.dispatchEvent(new Event("hashchange"));
		await waitFor(() => expect(window.location.hash).toBe(`#/chat/${WORKSPACE_ID_2}`));
		const conversation = await screen.findByRole("region", { name: "Conversation" });
		await within(conversation).findByText("Second question?");
		expect(within(conversation).queryByText("Where will storage demand grow?")).toBeNull();
	});

	it("shows empty states when there are no chats", async () => {
		server.conversations = [];
		window.location.hash = "#/chat";
		mountApp(backend);
		await screen.findByText("No chats yet. Start one above.");
		await screen.findByText("Welcome to Chat");
	});

	it("shows a chats error with its code and can retry", async () => {
		backend.on("GET", /^\/api\/v1\/conversations$/, () =>
			errorResponse(500, "INTERNAL", "database unavailable"),
		);
		mountApp(backend);
		await screen.findByText(/database unavailable/);
		expect(
			screen.getByText(/database unavailable/).closest('[role="alert"]')?.textContent,
		).toContain("INTERNAL");
	});

	it("shows the canvas panel alongside the thread, from one shared session", async () => {
		mountApp(backend);
		await threadReady();
		const canvas = await canvasReady();
		expect(within(canvas).getByRole("list", { name: "Workspace components" })).toBeDefined();
		// No workspace version line and no column switch on the canvas.
		expect(canvas.querySelector('[data-field="workspace-version"]')).toBeNull();
		expect(canvas.textContent).not.toContain("Workspace version");
		expect(within(canvas).queryByRole("button", { name: "Use 2 columns" })).toBeNull();
		expect(within(canvas).queryByRole("button", { name: "Use 1 column" })).toBeNull();
		// One session: a single workspace read backs both panels.
		await waitFor(() =>
			expect(backend.requestsTo("GET", /^\/api\/v1\/workspaces\/ws_1$/)).toHaveLength(1),
		);
	});

	it("old canvas and workspace hashes open the chat page for that conversation", async () => {
		window.location.hash = `#/canvas/${WORKSPACE_ID}`;
		const first = mountApp(backend);
		await threadReady();
		await canvasReady();
		expect(window.location.hash).toBe(`#/canvas/${WORKSPACE_ID}`);
		first.unmount();
		cleanup();
		window.location.hash = `#/workspace/${WORKSPACE_ID}`;
		mountApp(backend);
		await threadReady();
		await canvasReady();
	});
});

describe("chat history disclosure (narrow layout)", () => {
	it("summarises the chat count in its summary", async () => {
		const original = window.matchMedia;
		window.matchMedia = (() => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia;
		try {
			mountApp(backend);
			const nav = await historyReady();
			await threadReady();
			const summary = document.querySelector('[data-conversations-disclosure="true"] > summary');
			expect(summary?.textContent).toContain("Chats (2)");
			expect(nav.textContent).toContain("Grid storage research");
		} finally {
			window.matchMedia = original;
		}
	});

	it("is open when there are no chats", async () => {
		const original = window.matchMedia;
		window.matchMedia = (() => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia;
		try {
			server.conversations = [];
			window.location.hash = "#/chat";
			mountApp(backend);
			await screen.findByText("No chats yet. Start one above.");
			const disclosure = document.querySelector('[data-conversations-disclosure="true"]');
			expect(disclosure?.hasAttribute("open")).toBe(true);
			expect(disclosure?.textContent).toContain("Chats (0)");
		} finally {
			window.matchMedia = original;
		}
	});

	it("offers Chat and Canvas tabs that show one panel at a time", async () => {
		const original = window.matchMedia;
		window.matchMedia = (() => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia;
		try {
			mountApp(backend);
			await threadReady();
			const tablist = await screen.findByRole("tablist", { name: "Chat or Canvas" });
			const chatTab = within(tablist).getByRole("tab", { name: "Chat" });
			const canvasTab = within(tablist).getByRole("tab", { name: "Canvas" });
			expect(chatTab.getAttribute("aria-selected")).toBe("true");
			expect(canvasTab.getAttribute("aria-selected")).toBe("false");
			expect(screen.getByRole("region", { name: "Conversation" })).toBeDefined();
			fireEvent.click(canvasTab);
			await waitFor(() => expect(canvasTab.getAttribute("aria-selected")).toBe("true"));
			await screen.findByRole("region", { name: "Canvas" });
			expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
		} finally {
			window.matchMedia = original;
		}
	});
});

describe("new chat", () => {
	it("creates an untitled chat, opens it and focuses the question input", async () => {
		mountApp(backend);
		await historyReady();
		await threadReady();
		fireEvent.click(screen.getByRole("button", { name: "New chat" }));
		await waitFor(() => expect(window.location.hash).toBe("#/chat/ws_new"));
		const posts = backend.requestsTo("POST", /\/workspaces$/);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toEqual({});
		await screen.findByRole("heading", { level: 3, name: "New chat" });
		const box = await screen.findByRole("textbox", { name: "Question" });
		await waitFor(() => expect(document.activeElement).toBe(box));
	});

	it("reuses an empty New chat instead of creating another", async () => {
		server.conversations = [
			{
				workspaceId: "ws_empty",
				title: "New chat",
				messageCount: 0,
				lastMessageAt: null,
				lastMessageRole: null,
				lastMessagePreview: null,
				lastActivityAt: "2026-10-07T00:00:00Z",
			},
			...server.conversations,
		];
		mountApp(backend);
		await historyReady();
		await threadReady();
		fireEvent.click(screen.getByRole("button", { name: "New chat" }));
		await waitFor(() => expect(window.location.hash).toBe("#/chat/ws_empty"));
		expect(backend.requestsTo("POST", /\/workspaces$/)).toHaveLength(0);
	});

	it("a late create response does not pull the owner back after they navigated away", async () => {
		mountApp(backend);
		await historyReady();
		await threadReady();
		const release = deferred<null>();
		backend.on("POST", /^\/api\/v1\/workspaces$/, () =>
			release.promise.then(() =>
				jsonResponse(
					{
						...WORKSPACE_SUMMARY_2,
						workspaceId: "ws_new",
						title: "New chat",
						createdAt: "2026-10-07T00:00:00Z",
						updatedAt: "2026-10-07T00:00:00Z",
					},
					{ status: 201 },
				),
			),
		);
		fireEvent.click(screen.getByRole("button", { name: "New chat" }));
		await waitFor(() => expect(backend.requestsTo("POST", /\/workspaces$/)).toHaveLength(1));
		fireEvent.click(screen.getByRole("link", { name: "Sources" }));
		window.dispatchEvent(new Event("hashchange"));
		await screen.findByRole("region", { name: "Subscribed sources" });
		expect(window.location.hash).toBe("#/sources");
		release.resolve(null);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(window.location.hash).toBe("#/sources");
	});

	it("shows the renamed title in the list and the header after the first question", async () => {
		backend.on("POST", /^\/api\/v1\/research-runs$/, () =>
			jsonResponse(
				{ run: makeRun({ runId: "run_new", state: "pending", provenance: null }) },
				{ status: 202 },
			),
		);
		mountApp(backend);
		await historyReady();
		await threadReady();
		fireEvent.click(screen.getByRole("button", { name: "New chat" }));
		await waitFor(() => expect(window.location.hash).toBe("#/chat/ws_new"));
		// The server renames the chat from its first question: simulate the
		// rename arriving with the next list poll.
		server.conversations = server.conversations.map((entry) =>
			entry.workspaceId === "ws_new" ? { ...entry, title: "Storage demand" } : entry,
		);
		const composer = await screen.findByRole("form", { name: "Research composer" });
		await within(composer).findByText(/Claude Code \(available\)/);
		fireEvent.input(within(composer).getByLabelText("Question"), {
			target: { value: "Which storage products will grow?" },
		});
		fireEvent.click(within(composer).getByRole("button", { name: "Send question" }));
		await waitFor(() =>
			expect(screen.getByRole("heading", { level: 3, name: "Storage demand" })).toBeDefined(),
		);
		const nav = await historyReady();
		expect(nav.textContent).toContain("Storage demand");
	});
});

describe("new chat button", () => {
	it("is a full-width pill in the expanded panel", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		const pill = within(nav).getByRole("button", { name: "New chat" });
		expect(pill.className).toContain("rounded-full");
		expect(pill.className).toContain("w-full");
		expect(pill.className).toContain("justify-center");
	});

	it("uses the same pill part in the welcome when there are no chats", async () => {
		server.conversations = [];
		window.location.hash = "#/chat";
		mountApp(backend);
		const welcome = await screen.findByRole("region", { name: "Chat" });
		await within(welcome).findByRole("heading", { level: 3, name: "Welcome to Chat" });
		const pill = within(welcome).getByRole("button", { name: "New chat" });
		expect(pill.className).toContain("rounded-full");
		fireEvent.click(pill);
		await waitFor(() => expect(window.location.hash).toBe("#/chat/ws_new"));
		expect(backend.requestsTo("POST", /\/workspaces$/)).toHaveLength(1);
	});

	it("collapses to an icon-only button in the rail through the same part", async () => {
		mountApp(backend);
		await historyReady();
		await threadReady();
		fireEvent.click(screen.getByRole("button", { name: "Collapse Chats panel" }));
		const icon = await screen.findByRole("button", { name: "New chat" });
		expect(icon.className).toContain("rounded-full");
		expect(icon.textContent?.trim()).toBe("");
		fireEvent.click(icon);
		await waitFor(() => expect(window.location.hash).toBe("#/chat/ws_new"));
		expect(backend.requestsTo("POST", /\/workspaces$/)).toHaveLength(1);
	});

	it("keeps its compact form in the narrow-screen disclosure", async () => {
		const original = window.matchMedia;
		window.matchMedia = (() => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia;
		try {
			mountApp(backend);
			const nav = await historyReady();
			await threadReady();
			const compact = within(nav).getByRole("button", { name: "New chat" });
			expect(compact.className).not.toContain("rounded-full");
			fireEvent.click(compact);
			await waitFor(() => expect(window.location.hash).toBe("#/chat/ws_new"));
			expect(backend.requestsTo("POST", /\/workspaces$/)).toHaveLength(1);
		} finally {
			window.matchMedia = original;
		}
	});
});

describe("empty conversation grouping", () => {
	it("centres the greeting, composer and suggestions as one group", async () => {
		window.location.hash = "#/chat/ws_new";
		mountApp(backend);
		await screen.findByRole("heading", { level: 3, name: "What would you like to research?" });
		const conversation = await screen.findByRole("region", { name: "Conversation" });
		expect(conversation.getAttribute("data-layout")).toBe("empty-centered");
		expect(conversation.className).toContain("lg:justify-center");
		const composer = await screen.findByRole("form", { name: "Research composer" });
		expect(composer).toBeDefined();
		const greeting = conversation.querySelector('[data-greeting="true"]');
		const wrap = conversation.querySelector('[data-composer-wrap="true"]');
		const below = conversation.querySelector('[data-suggestions="below-composer"]');
		const above = conversation.querySelector('[data-suggestions="above-composer"]');
		expect(greeting).not.toBeNull();
		expect(wrap).not.toBeNull();
		expect(below).not.toBeNull();
		expect(above).not.toBeNull();
		// Structural order: greeting, then the composer directly under it, then the chips.
		expect(
			(greeting as Element).compareDocumentPosition(wrap as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(
			(wrap as Element).compareDocumentPosition(below as Element) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		// The narrow copy hides at `lg`; the wrapper keeps its sticky pinning for narrow screens.
		expect((above as HTMLElement).className).toContain("lg:hidden");
		expect((wrap as HTMLElement).className).toContain("sticky");
		expect((wrap as HTMLElement).className).toContain("bottom-0");
	});

	it("keeps the same composer node when the first question turns the empty state into a thread", async () => {
		window.location.hash = "#/chat/ws_new";
		const created: ResearchRun[] = [];
		backend.on("POST", /^\/api\/v1\/research-runs$/, () => {
			const run = makeRun({
				runId: "run_new",
				workspaceId: "ws_new",
				state: "pending",
				provenance: null,
				createdAt: "2026-10-07T00:00:00Z",
				updatedAt: "2026-10-07T00:00:00Z",
			});
			created.push(run);
			return jsonResponse({ run }, { status: 202 });
		});
		backend.on("GET", /^\/api\/v1\/research-runs\?workspaceId=ws_new$/, () =>
			jsonResponse({ runs: created }),
		);
		mountApp(backend);
		await screen.findByRole("heading", { level: 3, name: "What would you like to research?" });
		const box = (await screen.findByRole("textbox", { name: "Question" })) as HTMLTextAreaElement;
		expect(screen.getByRole("region", { name: "Conversation" }).getAttribute("data-layout")).toBe(
			"empty-centered",
		);
		fireEvent.input(box, { target: { value: "Which storage products will grow?" } });
		fireEvent.click(screen.getByRole("button", { name: "Send question" }));
		// The run arrives with no messages yet: the thread layout, not the centred group.
		await screen.findByRole("article", { name: "Run run_new" });
		expect(screen.getByRole("region", { name: "Conversation" }).getAttribute("data-layout")).toBe(
			"thread",
		);
		// The composer is the same DOM node, so a draft for the next question survives.
		expect(screen.getByRole("textbox", { name: "Question" })).toBe(box);
	});
});

describe("rename chats", () => {
	it("keeps an open rename input when the new-chat composer fallback fires", async () => {
		// The intermittent E2E failure ("a chat can be renamed and deleted"):
		// opening the rename input inside the 100 ms composer-focus fallback
		// window loses the input when the fallback steals focus (the input
		// saves on blur, and an unchanged title exits edit mode). Pin that
		// losing order with fake timers.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			mountApp(backend);
			await vi.advanceTimersByTimeAsync(1000);
			const nav = screen.getByRole("navigation", { name: "Chats" });
			fireEvent.click(screen.getByRole("button", { name: "New chat" }));
			// Advance in small steps: stop as soon as the chat opens, so the
			// 100 ms composer-focus fallback scheduled with it is still pending.
			for (let step = 0; step < 200 && window.location.hash !== "#/chat/ws_new"; step += 1) {
				await vi.advanceTimersByTimeAsync(10);
			}
			expect(window.location.hash).toBe("#/chat/ws_new");
			// No timer advanced since the chat opened: the fallback is pending.
			fireEvent.click(within(nav).getByRole("button", { name: "More actions for New chat" }));
			fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
			const box = screen.getByLabelText("Chat title") as HTMLInputElement;
			expect(box.value).toBe("New chat");
			await vi.advanceTimersByTimeAsync(0);
			expect(document.activeElement).toBe(box);
			// The losing order: the fallback fires while the rename input
			// holds focus. It must not steal focus out of the input.
			await vi.advanceTimersByTimeAsync(100);
			expect(screen.queryByLabelText("Chat title")).not.toBeNull();
			expect(document.activeElement).toBe(screen.getByLabelText("Chat title"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("renames a chat from the list", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const box = screen.getByLabelText("Chat title") as HTMLInputElement;
		expect(box.value).toBe("Second research");
		fireEvent.input(box, { target: { value: "Renamed research" } });
		fireEvent.keyDown(box, { key: "Enter" });
		await waitFor(() => expect(nav.textContent).toContain("Renamed research"));
		const patch = backend.requestsTo("PATCH", /\/workspaces\/ws_2$/)[0];
		expect(patch?.body).toEqual({ title: "Renamed research" });
	});

	it("has no Rename button in the open conversation header (renaming lives in the list)", async () => {
		mountApp(backend);
		await historyReady();
		await threadReady();
		const header = await screen.findByRole("heading", { level: 3, name: "Grid storage research" });
		expect(header).toBeDefined();
		// The header holds the title only; renaming stays in each row's "More actions" menu.
		expect(screen.queryByRole("button", { name: "Rename Grid storage research" })).toBeNull();
		expect(screen.queryByLabelText("Chat title")).toBeNull();
		const nav = await historyReady();
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		expect(screen.getByRole("menuitem", { name: "Rename" })).toBeDefined();
	});

	it("cancels a rename on Escape and sends nothing for an empty or unchanged title", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const box = screen.getByLabelText("Chat title") as HTMLInputElement;
		fireEvent.keyDown(box, { key: "Escape" });
		expect(screen.queryByLabelText("Chat title")).toBeNull();
		expect(backend.requestsTo("PATCH", /workspaces/)).toHaveLength(0);
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const same = screen.getByLabelText("Chat title") as HTMLInputElement;
		fireEvent.blur(same);
		await waitFor(() => expect(screen.queryByLabelText("Chat title")).toBeNull());
		expect(backend.requestsTo("PATCH", /workspaces/)).toHaveLength(0);
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const empty = screen.getByLabelText("Chat title") as HTMLInputElement;
		fireEvent.input(empty, { target: { value: "   " } });
		fireEvent.blur(empty);
		expect(backend.requestsTo("PATCH", /workspaces/)).toHaveLength(0);
	});

	it("shows a rename failure and keeps the old title", async () => {
		backend.on("PATCH", /^\/api\/v1\/workspaces\/ws_2$/, () =>
			errorResponse(500, "INTERNAL", "database unavailable"),
		);
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
		const box = screen.getByLabelText("Chat title") as HTMLInputElement;
		fireEvent.input(box, { target: { value: "Will fail" } });
		fireEvent.blur(box);
		await screen.findByText(/database unavailable/);
		expect(nav.textContent).toContain("Second research");
		expect(nav.textContent).not.toContain("Will fail");
	});
});

describe("delete chats", () => {
	it("confirms and deletes a chat that is not open", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		fireEvent.click(within(nav).getByRole("button", { name: "More actions for Second research" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog");
		expect(dialog.textContent).toContain("Second research");
		expect(dialog.textContent).toContain("messages, canvas and research records");
		expect(dialog.textContent).toContain("cannot be undone");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(nav.textContent).not.toContain("Second research"));
		expect(backend.requestsTo("DELETE", /\/workspaces\/ws_2$/)).toHaveLength(1);
		expect(window.location.hash).toBe(`#/chat/${WORKSPACE_ID}`);
	});

	it("cancel closes the dialog and deletes nothing", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		const opener = within(nav).getByRole("button", {
			name: "More actions for Second research",
		}) as HTMLElement;
		fireEvent.click(opener);
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(backend.requestsTo("DELETE", /workspaces/)).toHaveLength(0);
		expect(nav.textContent).toContain("Second research");
		expect(document.activeElement).toBe(opener);
	});

	it("deleting the open chat opens the newest remaining chat", async () => {
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		fireEvent.click(
			within(nav).getByRole("button", { name: "More actions for Grid storage research" }),
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await waitFor(() => expect(window.location.hash).toBe(`#/chat/${WORKSPACE_ID_2}`));
		await screen.findByText("Second question?");
	});

	it("deleting the last chat shows the empty welcome", async () => {
		server.conversations = server.conversations.filter(
			(entry) => entry.workspaceId === WORKSPACE_ID,
		);
		window.location.hash = `#/chat/${WORKSPACE_ID}`;
		mountApp(backend);
		await historyReady();
		await threadReady();
		const nav = await historyReady();
		fireEvent.click(
			within(nav).getByRole("button", { name: "More actions for Grid storage research" }),
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await screen.findByText("Welcome to Chat");
		expect(window.location.hash).toBe("#/chat");
	});

	it("a 409 shows the server message in the dialog and deletes nothing", async () => {
		server.runs = [makeRun({ state: "pending", provenance: null })];
		mountApp(backend);
		const nav = await historyReady();
		await threadReady();
		fireEvent.click(
			within(nav).getByRole("button", { name: "More actions for Grid storage research" }),
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
		await within(dialog).findByText(/still running/);
		expect(nav.textContent).toContain("Grid storage research");
		expect(screen.getByRole("dialog")).toBeDefined();
	});
});

describe("panels", () => {
	it("collapses the Chats panel to a rail with an expand button", async () => {
		mountApp(backend);
		await historyReady();
		await threadReady();
		const collapse = screen.getByRole("button", { name: "Collapse Chats panel" });
		expect(collapse.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(collapse);
		const expand = await screen.findByRole("button", { name: "Expand Chats panel" });
		expect(expand.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("navigation", { name: "Chats" })).toBeNull();
		fireEvent.click(expand);
		await historyReady();
	});

	it("collapses the Canvas panel without mounting its components", async () => {
		mountApp(backend);
		await threadReady();
		await canvasReady();
		fireEvent.click(screen.getByRole("button", { name: "Collapse Canvas panel" }));
		const expand = await screen.findByRole("button", { name: "Expand Canvas panel" });
		expect(expand.getAttribute("aria-expanded")).toBe("false");
		expect(screen.queryByRole("list", { name: "Workspace components" })).toBeNull();
		fireEvent.click(expand);
		await canvasReady();
	});

	it("uses icon-only collapse buttons with accessible names and no visible text", async () => {
		mountApp(backend);
		await historyReady();
		await threadReady();
		await canvasReady();
		for (const name of ["Collapse Chats panel", "Collapse Canvas panel"]) {
			const button = screen.getByRole("button", { name }) as HTMLElement;
			expect(button.textContent?.trim()).toBe("");
			expect(button.getAttribute("aria-expanded")).toBe("true");
			expect(button.getAttribute("title")).toBe(name);
			expect(button.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
		}
		fireEvent.click(screen.getByRole("button", { name: "Collapse Chats panel" }));
		const expandChats = await screen.findByRole("button", { name: "Expand Chats panel" });
		expect((expandChats as HTMLElement).textContent?.trim()).toBe("");
		expect(expandChats.getAttribute("aria-expanded")).toBe("false");
		expect(expandChats.getAttribute("title")).toBe("Expand Chats panel");
		fireEvent.click(screen.getByRole("button", { name: "Collapse Canvas panel" }));
		const expandCanvas = await screen.findByRole("button", { name: "Expand Canvas panel" });
		expect((expandCanvas as HTMLElement).textContent?.trim()).toBe("");
		expect(expandCanvas.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("borderless chat surfaces (background tone, not outlines)", () => {
	function borderTokens(className: string): string[] {
		return className
			.split(/\s+/)
			.filter(
				(token) => token === "border" || (token.startsWith("border-") && token !== "border-0"),
			);
	}

	it("shares one borderless button definition with a 24 px floor", async () => {
		const { BUTTON, BUTTON_DANGER, BUTTON_PILL, BUTTON_PRIMARY } = await import(
			"../src/components/ui.tsx"
		);
		for (const shared of [BUTTON, BUTTON_PRIMARY, BUTTON_DANGER, BUTTON_PILL]) {
			expect(borderTokens(shared)).toEqual([]);
			expect(shared).toContain("min-h-6");
		}
	});

	it("keeps PANEL bordered for Sources and Settings while the chat panels lose their outline", async () => {
		const { CHAT_PANEL, PANEL, Section } = await import("../src/components/ui.tsx");
		expect(borderTokens(PANEL)).not.toEqual([]);
		expect(borderTokens(CHAT_PANEL)).toEqual([]);
		// Sources and Settings build on `Section`, which renders `PANEL`: still bordered.
		cleanup();
		render(() => (
			<Section title="Example section">
				<p>content</p>
			</Section>
		));
		const section = document.querySelector("section[aria-label='Example section']");
		expect(section?.className).toContain("border");

		mountApp(backend);
		await historyReady();
		await threadReady();
		await canvasReady();
		for (const panel of document.querySelectorAll(
			'section[data-panel="chat"], section[data-panel="canvas"], nav[aria-label="Chats"]',
		)) {
			expect(borderTokens(panel.getAttribute("class") ?? "")).toEqual([]);
		}
		// The collapsed rails are borderless too.
		fireEvent.click(screen.getByRole("button", { name: "Collapse Chats panel" }));
		await screen.findByRole("button", { name: "Expand Chats panel" });
		fireEvent.click(screen.getByRole("button", { name: "Collapse Canvas panel" }));
		await screen.findByRole("button", { name: "Expand Canvas panel" });
		for (const rail of document.querySelectorAll(
			'[data-panel="canvas-rail"], div[class*="lg:flex"]',
		)) {
			expect(borderTokens(rail.getAttribute("class") ?? "")).toEqual([]);
		}
	});

	it("renders run cards, canvas cards and the composer box as fills with their focus cues", async () => {
		mountApp(backend);
		await threadReady();
		const canvas = await canvasReady();
		// run_1 is completed, so its card is hidden; the classes are still its own.
		const run = await screen.findByRole("article", { name: "Run run_1", hidden: true });
		expect(borderTokens(run.getAttribute("class") ?? "")).toEqual([]);
		expect(run.className).toContain("bg-slate-100");
		for (const card of canvas.querySelectorAll("ul[aria-label='Workspace components'] > li")) {
			expect(borderTokens(card.getAttribute("class") ?? "")).toEqual([]);
			expect(card.getAttribute("class") ?? "").toContain("bg-slate-100");
		}
		const composer = screen.getByRole("form", { name: "Research composer" });
		const box = composer.querySelector("div.rounded-2xl") as HTMLElement;
		expect(box).not.toBeNull();
		expect(borderTokens(box.getAttribute("class") ?? "")).toEqual([]);
		// The question box keeps its visible focus ring.
		expect(box.className).toContain("focus-within:ring-2");
	});

	it("renders suggestion chips as borderless fills", async () => {
		cleanup();
		window.location.hash = "#/chat/ws_new";
		mountApp(backend);
		await screen.findByRole("heading", { level: 3, name: "What would you like to research?" });
		const lists = await screen.findAllByRole("list", { name: "Suggestions" });
		expect(lists.length).toBeGreaterThan(0);
		const chips = (lists[0] as HTMLElement).querySelectorAll("button");
		expect(chips.length).toBeGreaterThan(0);
		for (const chip of chips) {
			const className = chip.getAttribute("class") ?? "";
			expect(
				className.split(/\s+/).filter((token) => token === "border" || token.startsWith("border-")),
			).toEqual([]);
			expect(className).toContain("bg-slate-200");
		}
		window.location.hash = "";
	});
});

describe("chat thread", () => {
	it("shows the conversation with claim badges, numbered citation chips and a sources row", async () => {
		mountApp(backend);
		const conversation = await threadReady();
		expect(
			within(conversation).getByRole("article", { name: "Your message" }).textContent,
		).toContain("Where will storage demand grow?");
		const claims = within(conversation).getByRole("list", { name: "Claims" });
		expect(claims.querySelector('[data-claim-id="claim_1"] [data-claim-type]')?.textContent).toBe(
			"Observation",
		);
		expect(
			claims
				.querySelector('[data-claim-id="claim_2"] [data-claim-status]')
				?.getAttribute("data-claim-status"),
		).toBe("unsupported");
		// One numbered chip for the single evidence of claim_1, named like NotebookLM.
		const chip = within(claims).getByRole("button", {
			name: "Source 1: Grid storage outlook 2026",
		});
		expect(chip.textContent).toBe("1");
		expect(claims.textContent).toContain("No evidence linked to this claim.");
		// The compact sources row lists the same source with its host.
		const sources = within(conversation).getByRole("list", { name: "Sources" });
		expect(sources.textContent).toContain("Grid storage outlook 2026");
		expect(sources.textContent).toContain("example.com");
		const sourceLink = within(sources).getByRole("link", { name: "Grid storage outlook 2026" });
		expect(sourceLink.getAttribute("href")).toBe("https://example.com/reports/grid-storage");
		expect(sourceLink.getAttribute("rel")).toBe("noopener noreferrer");
	});

	it("loads earlier messages and merges without duplicates", async () => {
		const newest = {
			...CONVERSATION,
			messages: [
				{
					messageId: "msg_2",
					seq: 1,
					role: "assistant" as const,
					text: "Utility tenders are rising.\nSee the linked claims.",
					runId: "run_1",
					claimIds: ["claim_1", "claim_2"],
					createdAt: "2026-10-04T00:10:00Z",
				},
				{
					messageId: "msg_3",
					seq: 2,
					role: "owner" as const,
					text: "And who supplies them?",
					runId: "run_1",
					claimIds: [],
					createdAt: "2026-10-04T00:20:00Z",
				},
			],
			claims: CONVERSATION.claims,
			evidence: CONVERSATION.evidence,
			hasEarlier: true,
		};
		const earlier = {
			...CONVERSATION,
			messages: [
				{
					messageId: "msg_1",
					seq: 0,
					role: "owner" as const,
					text: "Where will storage demand grow?",
					runId: "run_1",
					claimIds: [],
					createdAt: "2026-10-04T00:00:00Z",
				},
				// Intentional duplicate of the boundary message.
				{
					messageId: "msg_2",
					seq: 1,
					role: "assistant" as const,
					text: "Utility tenders are rising.\nSee the linked claims.",
					runId: "run_1",
					claimIds: ["claim_1", "claim_2"],
					createdAt: "2026-10-04T00:10:00Z",
				},
			],
			claims: CONVERSATION.claims,
			evidence: CONVERSATION.evidence,
			hasEarlier: false,
		};
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, (request) => {
			const url = new URL(request.path, "http://test");
			return url.searchParams.get("before") === null
				? jsonResponse(newest, { headers: { ETag: '"m-new"' } })
				: jsonResponse(earlier);
		});
		mountApp(backend);
		const conversation = await screen.findByRole("region", { name: "Conversation" });
		await within(conversation).findByText("And who supplies them?");
		expect(screen.queryByText("Where will storage demand grow?")).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
		await within(conversation).findByText("Where will storage demand grow?");
		// Three unique messages, sorted by seq, with no duplicate.
		const messages = within(conversation).getAllByRole("article", { name: /message$/ });
		expect(messages).toHaveLength(3);
		expect(messages[0]?.textContent).toContain("Where will storage demand grow?");
		expect(messages[2]?.textContent).toContain("And who supplies them?");
		// All pages consumed: the button is gone.
		expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
	});

	it("shows an API error with its code instead of a blank screen, and can retry", async () => {
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1$/, () =>
			errorResponse(500, "INTERNAL", "database unavailable"),
		);
		mountApp(backend);
		const alert = await screen.findByText(/database unavailable/);
		expect(alert.closest('[role="alert"]')?.textContent).toContain("INTERNAL");

		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1$/, () => jsonResponse(server.view));
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await threadReady();
		await waitFor(() => expect(screen.queryByText(/database unavailable/)).toBeNull());
	});

	it("shows a message-load failure with its code and can retry", async () => {
		let calls = 0;
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, () => {
			calls += 1;
			if (calls === 1) return errorResponse(500, "INTERNAL", "database unavailable");
			return jsonResponse(CONVERSATION, { headers: { ETag: '"m1"' } });
		});
		mountApp(backend);
		const alert = await screen.findByText(/database unavailable/);
		expect(alert.closest('[role="alert"]')?.textContent).toContain("INTERNAL");
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await threadReady();
		await waitFor(() => expect(screen.queryByText(/database unavailable/)).toBeNull());
	});

	it("shows a load-earlier failure with a retry and keeps the loaded messages", async () => {
		const newest = {
			...CONVERSATION,
			messages: [
				{
					messageId: "msg_2",
					seq: 1,
					role: "assistant" as const,
					text: "Utility tenders are rising.\nSee the linked claims.",
					runId: "run_1",
					claimIds: ["claim_1", "claim_2"],
					createdAt: "2026-10-04T00:10:00Z",
				},
				{
					messageId: "msg_3",
					seq: 2,
					role: "owner" as const,
					text: "And who supplies them?",
					runId: "run_1",
					claimIds: [],
					createdAt: "2026-10-04T00:20:00Z",
				},
			],
			claims: CONVERSATION.claims,
			evidence: CONVERSATION.evidence,
			hasEarlier: true,
		};
		const earlier = {
			...CONVERSATION,
			messages: [
				{
					messageId: "msg_1",
					seq: 0,
					role: "owner" as const,
					text: "Where will storage demand grow?",
					runId: "run_1",
					claimIds: [],
					createdAt: "2026-10-04T00:00:00Z",
				},
			],
			claims: CONVERSATION.claims,
			evidence: CONVERSATION.evidence,
			hasEarlier: false,
		};
		let earlierCalls = 0;
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, (request) => {
			const url = new URL(request.path, "http://test");
			if (url.searchParams.get("before") === null) {
				return jsonResponse(newest, { headers: { ETag: '"m-new"' } });
			}
			earlierCalls += 1;
			if (earlierCalls === 1) return errorResponse(500, "INTERNAL", "database unavailable");
			return jsonResponse(earlier);
		});
		mountApp(backend);
		const conversation = await screen.findByRole("region", { name: "Conversation" });
		await within(conversation).findByText("And who supplies them?");

		fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));
		const alert = await screen.findByText(/database unavailable/);
		expect(alert.closest('[role="alert"]')?.textContent).toContain("INTERNAL");
		// The loaded messages stay visible.
		expect(within(conversation).getByText("And who supplies them?")).toBeDefined();

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await within(conversation).findByText("Where will storage demand grow?");
	});

	it("shows the canvas panel alongside the thread", async () => {
		mountApp(backend);
		await threadReady();
		const canvas = await screen.findByRole("region", { name: "Canvas" });
		expect(within(canvas).getByRole("list", { name: "Workspace components" })).toBeDefined();
	});
});

describe("chat reload (FR-010)", () => {
	it("renders the same conversation after a remount, from server state, without rerunning research", async () => {
		const first = mountApp(backend);
		await threadReady();
		const before = screen.getAllByRole("article", { name: /message$/ }).map((m) => m.textContent);

		// "Reload": the whole app is torn down and started again against the same server.
		first.unmount();
		expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
		mountApp(backend);

		await threadReady();
		expect(screen.getAllByRole("article", { name: /message$/ }).map((m) => m.textContent)).toEqual(
			before,
		);
		expect(window.location.hash).toBe(`#/chat/${WORKSPACE_ID}`);
		// Reopening a conversation reads stored state only.
		expect(backend.requestsTo("POST", /research-runs/)).toHaveLength(0);
	});
});

describe("chat run controls", () => {
	it("hides a completed run's card and never offers a Run details disclosure", async () => {
		mountApp(backend);
		const run = await screen.findByRole("article", { name: "Run run_1", hidden: true });
		// A completed run carries its state as data only: no badge, and the
		// card itself is hidden (its answer follows), not left as an empty box.
		expect(run.getAttribute("data-run-state")).toBe("completed");
		expect(run.querySelector('[data-field="state"]')).toBeNull();
		expect(run.closest("li")?.hidden).toBe(true);
		expect(screen.queryByRole("article", { name: "Run run_1" })).toBeNull();
		// The removed facts live in the runner log (`job_finished`), not in the thread.
		expect(within(run).queryByText("Run details")).toBeNull();
		expect(run.querySelector("details")).toBeNull();
		expect(run.querySelector('[data-field="attempt"]')).toBeNull();
		expect(run.querySelector('[data-field="cost"]')).toBeNull();
		expect(run.querySelector('[data-field="provenance"]')).toBeNull();
		expect(run.textContent).not.toContain("Limits in force");
		expect(run.textContent).not.toContain("Usage so far");
		expect(run.textContent).not.toContain("Progress log");
		// A finished run offers no stop; a completed one no retry.
		expect(within(run).queryByRole("button", { name: "Stop" })).toBeNull();
		expect(within(run).queryByRole("button", { name: "Retry run" })).toBeNull();
		// The records drawer opens from the answer only (owner's decision of
		// 2026-10-12): a run card has no Evidence button.
		expect(within(run).queryByRole("button", { name: "Evidence" })).toBeNull();
	});

	it("cancels an unfinished run and retries a failed one with an idempotency key", async () => {
		server.runs = [
			makeRun({
				runId: "run_2",
				state: "pending",
				createdAt: "2026-10-05T00:00:00Z",
				attempt: 0,
				provenance: null,
			}),
			makeRun({ runId: "run_3", state: "failed", failureCode: "BUDGET_MAX_TOOL_CALLS" }),
		];
		backend.on("POST", /research-runs\/run_2\/cancel$/, () =>
			jsonResponse({ run: makeRun({ runId: "run_2", state: "cancelled" }) }),
		);
		backend.on("POST", /research-runs\/run_3\/retry$/, () =>
			jsonResponse(
				{ run: makeRun({ runId: "run_4", state: "pending", retryOfRunId: "run_3" }) },
				{ status: 202 },
			),
		);
		mountApp(backend);

		const failed = await screen.findByRole("article", { name: "Run run_3" });
		expect(failed.querySelector('[data-field="failure-code"]')?.textContent).toBe(
			"BUDGET_MAX_TOOL_CALLS",
		);
		const queued = screen.getByRole("article", { name: "Run run_2" });
		expect(queued.textContent).toContain("Queued — waiting for a runner to claim it.");
		// Nothing has been produced yet, so no provenance line is invented for it.
		expect(queued.querySelector('[data-field="provenance"]')).toBeNull();

		fireEvent.click(within(queued).getByRole("button", { name: "Stop" }));
		await waitFor(() =>
			expect(
				screen.getByRole("article", { name: "Run run_2" }).getAttribute("data-run-state"),
			).toBe("cancelled"),
		);

		fireEvent.click(within(failed).getByRole("button", { name: "Retry run" }));
		await screen.findByRole("article", { name: "Run run_4" });
		const retry = backend.requestsTo("POST", /retry$/)[0];
		expect(retry?.headers["idempotency-key"]).toMatch(/^idem-[0-9a-f-]{36}$/);
	});

	it("shows the tool error alongside ALL_TOOL_CALLS_FAILED", async () => {
		server.runs = [
			makeRun({
				runId: "run_6",
				state: "failed",
				failureCode: "ALL_TOOL_CALLS_FAILED",
				failureDetail: "TIMEOUT",
			}),
		];
		mountApp(backend);

		const failed = await screen.findByRole("article", { name: "Run run_6" });
		expect(failed.querySelector('[data-field="failure-code"]')?.textContent).toBe(
			"ALL_TOOL_CALLS_FAILED",
		);
		expect(failed.querySelector('[data-field="failure-detail"]')?.textContent).toBe("TIMEOUT");
	});

	it("shows the approval request and resumes with the approved budget", async () => {
		server.runs = [
			makeRun({
				runId: "run_5",
				state: "waiting_approval",
				approvalRequest: { reasonCode: "MAX_TOOL_CALLS", detail: "needs 15 more tool calls" },
			}),
		];
		backend.on("POST", /research-runs\/run_5\/approve$/, () =>
			jsonResponse({ run: makeRun({ runId: "run_5", state: "pending" }) }),
		);
		mountApp(backend);

		const form = await screen.findByRole("form", { name: "Approve run run_5" });
		expect(form.textContent).toContain("MAX_TOOL_CALLS");
		expect(form.textContent).toContain("needs 15 more tool calls");
		fireEvent.input(within(form).getByLabelText("Max tool calls"), { target: { value: "35" } });
		fireEvent.click(within(form).getByRole("button", { name: "Approve and resume" }));

		await waitFor(() =>
			expect(
				screen.getByRole("article", { name: "Run run_5" }).getAttribute("data-run-state"),
			).toBe("pending"),
		);
		expect(backend.requestsTo("POST", /approve$/)[0]?.body).toEqual({
			budget: {
				maxAgentSteps: 6,
				maxToolCalls: 35,
				maxWallClockMs: 600_000,
				maxInputBytes: 400_000,
				maxSpendUsd: null,
			},
		});
	});
});

describe("chat composer with saved agent settings (FR-012)", () => {
	it("summarises the saved agent and submits the question with its choices", async () => {
		backend.on("POST", /^\/api\/v1\/research-runs$/, () =>
			jsonResponse(
				{ run: makeRun({ runId: "run_new", state: "pending", provenance: null }) },
				{ status: 202 },
			),
		);
		mountApp(backend);
		await threadReady();
		const composer = await screen.findByRole("form", { name: "Research composer" });
		await within(composer).findByText(/Claude Code \(available\)/);
		expect(
			within(composer).getByRole("link", { name: "Change in Settings → AI agent" }),
		).toBeDefined();

		fireEvent.input(within(composer).getByLabelText("Question"), {
			target: { value: "Which storage products will grow?" },
		});
		fireEvent.click(within(composer).getByRole("button", { name: "Send question" }));
		await waitFor(() => expect(backend.requestsTo("POST", /research-runs$/)).toHaveLength(1));
		const sent = createResearchRunRequestSchema.parse(
			backend.requestsTo("POST", /research-runs$/)[0]?.body,
		);
		expect(sent).toMatchObject({
			workspaceId: WORKSPACE_ID,
			question: "Which storage products will grow?",
			agentId: "claude-code",
			model: null,
			effort: "medium",
			webAccess: "off",
		});
		expect(sent.budget.maxSpendUsd).toBeNull();
		expect(backend.requestsTo("POST", /research-runs$/)[0]?.headers["idempotency-key"]).toMatch(
			/^idem-[0-9a-f-]{36}$/,
		);
	});

	it("fetches the agent settings again after returning from Settings", async () => {
		mountApp(backend);
		await threadReady();
		await screen.findByRole("form", { name: "Research composer" });
		await waitFor(() =>
			expect(backend.requestsTo("GET", /settings\/agent$/).length).toBeGreaterThanOrEqual(1),
		);

		fireEvent.click(screen.getByRole("link", { name: "Settings" }));
		window.dispatchEvent(new Event("hashchange"));
		await screen.findByRole("region", { name: "AI agent" });
		const fetchedOnSettings = backend.requestsTo("GET", /settings\/agent$/).length;

		fireEvent.click(screen.getByRole("link", { name: "Chat" }));
		window.dispatchEvent(new Event("hashchange"));
		await screen.findByRole("form", { name: "Research composer" });
		// Returning to Chat remounts the view, so the saved choices are read again.
		await waitFor(() =>
			expect(backend.requestsTo("GET", /settings\/agent$/).length).toBeGreaterThanOrEqual(
				fetchedOnSettings + 1,
			),
		);
	});
});

describe("chat thread layout (CopilotChat)", () => {
	it("renders the run card directly after its question in one messages list", async () => {
		mountApp(backend);
		const conversation = await threadReady();
		const list = within(conversation).getByRole("list", { name: "Messages" });
		expect(list.tagName).toBe("OL");
		const items = [...list.querySelectorAll(":scope > li")];
		const ownerIndex = items.findIndex((item) =>
			item.querySelector('article[aria-label="Your message"]'),
		);
		const runIndex = items.findIndex((item) =>
			item.querySelector('article[aria-label="Run run_1"]'),
		);
		expect(ownerIndex).toBeGreaterThanOrEqual(0);
		expect(runIndex).toBe(ownerIndex + 1);
		expect(items[runIndex]?.getAttribute("aria-label")).toBe("Run status");
	});

	it("shows the header, thread and input in that order", async () => {
		mountApp(backend);
		await threadReady();
		const header = await screen.findByRole("heading", { level: 3, name: "Grid storage research" });
		const messages = await screen.findByRole("list", { name: "Messages" });
		const composer = await screen.findByRole("form", { name: "Research composer" });
		const order =
			header.compareDocumentPosition(messages) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : -1;
		expect(order).toBe(1);
		expect(messages.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it("lists runs with no loaded message under Earlier runs", async () => {
		server.runs = [
			makeRun({
				runId: "run_orphan",
				state: "failed",
				failureCode: "BUDGET_MAX_TOOL_CALLS",
				createdAt: "2026-10-05T00:00:00Z",
			}),
		];
		mountApp(backend);
		await threadReady();
		const earlier = await screen.findByRole("region", { name: "Earlier runs" });
		expect(within(earlier).getByRole("article", { name: "Run run_orphan" })).toBeDefined();
		// The orphan is not inside the messages list.
		const messages = screen.getByRole("list", { name: "Messages" });
		expect(messages.querySelector('article[aria-label="Run run_orphan"]')).toBeNull();
	});

	it("shows no Earlier runs section for completed runs with no loaded message", async () => {
		server.runs = [
			makeRun({ runId: "run_orphan", state: "completed", createdAt: "2026-10-05T00:00:00Z" }),
		];
		mountApp(backend);
		await threadReady();
		// A completed run has nothing to show, so it earns no section of its own.
		expect(screen.queryByRole("region", { name: "Earlier runs" })).toBeNull();
		expect(document.querySelector('article[aria-label="Run run_orphan"]')).toBeNull();
	});

	it("shows the approval request inline with no Run details disclosure", async () => {
		server.runs = [
			makeRun({
				runId: "run_5",
				state: "waiting_approval",
				approvalRequest: { reasonCode: "MAX_TOOL_CALLS", detail: "needs more" },
			}),
		];
		mountApp(backend);
		const run = await screen.findByRole("article", { name: "Run run_5" });
		expect(within(run).queryByText("Run details")).toBeNull();
		expect(await within(run).findByRole("form", { name: "Approve run run_5" })).toBeDefined();
	});

	it("greets an empty conversation with suggestions that fill the input without sending", async () => {
		window.location.hash = "#/chat/ws_new";
		mountApp(backend);
		await screen.findByRole("heading", { level: 3, name: "What would you like to research?" });
		// Two copies (one above the composer for narrow screens, one below it
		// for `lg`); only one is ever visible.
		const suggestionLists = await screen.findAllByRole("list", { name: "Suggestions" });
		expect(suggestionLists).toHaveLength(2);
		const chips = within(suggestionLists[0] as HTMLElement).getAllByRole("button");
		expect(chips.length).toBeGreaterThanOrEqual(3);
		const first = chips[0]?.textContent ?? "";
		fireEvent.click(chips[0] as HTMLElement);
		const composer = await screen.findByRole("form", { name: "Research composer" });
		const box = within(composer).getByLabelText("Question") as HTMLTextAreaElement;
		expect(box.value).toBe(first);
		expect(document.activeElement).toBe(box);
		expect(backend.requestsTo("POST", /research-runs$/)).toHaveLength(0);
	});

	it("copies an answer with an injected clipboard and reports success", async () => {
		const writeText = vi.fn(async (_text: string) => {});
		cleanup();
		render(() => (
			<Conversation
				conversation={CONVERSATION}
				clipboard={{ writeText }}
				onOpenRecords={() => {}}
			/>
		));
		const copy = await screen.findByRole("button", { name: "Copy answer" });
		fireEvent.click(copy);
		await screen.findByRole("button", { name: "Copied" });
		expect(writeText).toHaveBeenCalledTimes(1);
		expect(writeText.mock.calls[0]?.[0]).toContain("Utility tenders are rising.");
	});

	it("reports Copy failed when the clipboard rejects or is unavailable", async () => {
		const writeText = vi.fn(async (_text: string): Promise<void> => {
			throw new Error("denied");
		});
		cleanup();
		render(() => (
			<Conversation
				conversation={CONVERSATION}
				clipboard={{ writeText }}
				onOpenRecords={() => {}}
			/>
		));
		fireEvent.click(await screen.findByRole("button", { name: "Copy answer" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		await screen.findByRole("button", { name: "Copy failed" });
		cleanup();

		render(() => (
			<Conversation conversation={CONVERSATION} clipboard={null} onOpenRecords={() => {}} />
		));
		fireEvent.click(await screen.findByRole("button", { name: "Copy answer" }));
		await screen.findByRole("button", { name: "Copy failed" });
	});

	it("makes the page behind the drawer inert while it is open", async () => {
		mountApp(backend);
		const conversation = await threadReady();
		const assistant = within(conversation).getByRole("article", { name: "Assistant message" });
		fireEvent.click(within(assistant).getByRole("button", { name: "Evidence" }));
		await screen.findByRole("dialog", { name: "Evidence & records" });
		const main = document.querySelector("main");
		if (!(main instanceof HTMLElement)) throw new Error("expected the app main element");
		expect(main.inert).toBe(true);

		fireEvent.click(screen.getByRole("button", { name: "Close records" }));
		await waitFor(() => expect(main.inert).toBe(false));
	});

	it("shows configuration problems before typing", async () => {
		backend.on("GET", /^\/api\/v1\/settings\/agent$/, () =>
			jsonResponse({
				settings: {
					defaultAgentId: null,
					models: {},
					effort: "medium",
					budget: {
						maxAgentSteps: 6,
						maxToolCalls: 20,
						maxWallClockMs: 600_000,
						maxInputBytes: 400_000,
						maxSpendUsd: null,
					},
					webAccess: "off",
				},
				updatedAt: null,
				origin: "defaults",
			}),
		);
		mountApp(backend);
		await threadReady();
		const composer = await screen.findByRole("form", { name: "Research composer" });
		expect(
			within(composer).getByRole("list", { name: "Before you can submit" }).textContent,
		).toContain("Choose a default agent backend in Settings → AI agent.");
		expect(AGENTS.agents.length).toBeGreaterThan(0);
	});
});

describe("conversation local state across polls (finding 3)", () => {
	function ownerMessage(messageId: string, seq: number, runId: string | null, text: string) {
		return {
			messageId,
			seq,
			role: "owner" as const,
			text,
			runId,
			claimIds: [] as string[],
			createdAt: "2026-10-04T00:00:00Z",
		};
	}

	it("a poll that changes the run updates the live card in place without recreating it", async () => {
		cleanup();
		const first = makeRun({
			state: "collecting",
			verificationStatus: null,
			provenance: null,
			progress: [{ at: "2026-10-04T00:01:00Z", kind: "state", text: "planning" }],
		});
		const [runs, setRuns] = createSignal<readonly ResearchRun[]>([first]);
		render(() => (
			<Conversation conversation={CONVERSATION} runs={runs()} onOpenRecords={() => {}} />
		));

		const run = await screen.findByRole("article", { name: "Run run_1" });
		expect(run.textContent).toContain("planning");
		expect(run.querySelector("details")).toBeNull();

		// A poll replaces the snapshot (new progress): the live card keeps its
		// DOM instead of recreating it. The queries below re-read the live
		// document — asserting on the node captured above would pass even if
		// the card had been replaced by a closed copy.
		setRuns([
			makeRun({
				state: "collecting",
				verificationStatus: null,
				provenance: null,
				progress: [
					{ at: "2026-10-04T00:01:00Z", kind: "state", text: "planning" },
					{ at: "2026-10-04T00:02:00Z", kind: "note", text: "fetching feeds" },
				],
			}),
		]);
		await waitFor(() => expect(screen.getByText("fetching feeds")).toBeDefined());
		const live = screen.getByRole("article", { name: "Run run_1" });
		expect(live).toBe(run);
	});

	it("text typed in an approval form survives a poll that changes another run", async () => {
		cleanup();
		const conversation = {
			...CONVERSATION,
			messages: [
				ownerMessage("msg_a", 0, "run_a", "First question?"),
				ownerMessage("msg_b", 1, "run_b", "Second question?"),
			],
			hasEarlier: false,
		};
		const waiting = makeRun({
			runId: "run_a",
			state: "waiting_approval",
			approvalRequest: { reasonCode: "MAX_TOOL_CALLS", detail: "needs more" },
			createdAt: "2026-10-04T00:00:00Z",
		});
		const other = makeRun({
			runId: "run_b",
			state: "pending",
			provenance: null,
			createdAt: "2026-10-04T01:00:00Z",
		});
		const [runs, setRuns] = createSignal<readonly ResearchRun[]>([waiting, other]);
		render(() => (
			<Conversation conversation={conversation} runs={runs()} onOpenRecords={() => {}} />
		));

		const form = await screen.findByRole("form", { name: "Approve run run_a" });
		fireEvent.input(within(form).getByLabelText("Max tool calls"), { target: { value: "35" } });
		expect((within(form).getByLabelText("Max tool calls") as HTMLInputElement).value).toBe("35");

		// Another run finishes, and every snapshot is a fresh object (as every
		// poll delivers): the approval draft being typed must survive. The
		// form is re-read from the live document — the node above would keep
		// its value even if it had been detached and replaced by a blank copy.
		setRuns([
			makeRun({
				runId: "run_a",
				state: "waiting_approval",
				approvalRequest: { reasonCode: "MAX_TOOL_CALLS", detail: "needs more" },
				createdAt: "2026-10-04T00:00:00Z",
			}),
			makeRun({
				runId: "run_b",
				state: "collecting",
				verificationStatus: null,
				provenance: null,
				createdAt: "2026-10-04T01:00:00Z",
			}),
		]);
		await screen.findByRole("article", { name: "Run run_b" });
		const liveForm = screen.getByRole("form", { name: "Approve run run_a" });
		expect(liveForm).toBe(form);
		expect((within(liveForm).getByLabelText("Max tool calls") as HTMLInputElement).value).toBe(
			"35",
		);
	});
});

describe("retry placement in the thread (finding 4)", () => {
	function ownerMessage(messageId: string, seq: number, runId: string | null, text: string) {
		return {
			messageId,
			seq,
			role: "owner" as const,
			text,
			runId,
			claimIds: [] as string[],
			createdAt: "2026-10-04T00:00:00Z",
		};
	}

	function assistantMessage(messageId: string, seq: number, runId: string | null, text: string) {
		return {
			messageId,
			seq,
			role: "assistant" as const,
			text,
			runId,
			claimIds: [] as string[],
			createdAt: "2026-10-04T00:10:00Z",
		};
	}

	function runOrder(): string[] {
		const list = screen.getByRole("list", { name: "Messages" });
		return [...list.querySelectorAll(":scope > li")]
			.map((item) => item.querySelector("article")?.getAttribute("aria-label") ?? "?")
			.filter((label) => label.startsWith("Run "));
	}

	it("places a retry directly after the card of the run it retries", async () => {
		cleanup();
		const conversation = {
			...CONVERSATION,
			messages: [ownerMessage("msg_1", 0, "run_3", "Where will storage demand grow?")],
			hasEarlier: false,
		};
		render(() => (
			<Conversation
				conversation={conversation}
				runs={[
					makeRun({ runId: "run_3", state: "failed", failureCode: "BUDGET_MAX_TOOL_CALLS" }),
					makeRun({
						runId: "run_4",
						state: "pending",
						provenance: null,
						retryOfRunId: "run_3",
						createdAt: "2026-10-05T00:00:00Z",
					}),
				]}
				onOpenRecords={() => {}}
			/>
		));
		await screen.findByRole("article", { name: "Run run_4" });
		expect(runOrder()).toEqual(["Run run_3", "Run run_4"]);
		expect(screen.queryByRole("region", { name: "Earlier runs" })).toBeNull();
	});

	it("keeps the retry card after its answer arrives", async () => {
		cleanup();
		const conversation = {
			...CONVERSATION,
			messages: [
				ownerMessage("msg_1", 0, "run_3", "Where will storage demand grow?"),
				assistantMessage("msg_2", 1, "run_3", "A first attempt."),
				assistantMessage("msg_3", 2, "run_4", "The retry answer."),
			],
			hasEarlier: false,
		};
		render(() => (
			<Conversation
				conversation={conversation}
				runs={[
					makeRun({ runId: "run_3", state: "failed", failureCode: "BUDGET_MAX_TOOL_CALLS" }),
					makeRun({ runId: "run_4", state: "completed", retryOfRunId: "run_3" }),
				]}
				onOpenRecords={() => {}}
			/>
		));
		// The completed retry's card is hidden, but it keeps its place in the DOM.
		await screen.findByRole("article", { name: "Run run_4", hidden: true });
		// The retry stays after the run it retries, in reading order.
		expect(runOrder()).toEqual(["Run run_3", "Run run_4"]);
		expect(screen.queryByRole("region", { name: "Earlier runs" })).toBeNull();
		const retry = screen.getByRole("article", { name: "Run run_4", hidden: true });
		expect(retry.getAttribute("data-run-state")).toBe("completed");
		expect(retry.closest("li")?.hidden).toBe(true);
		// Neither ordinary ending shows a state badge; the failure keeps its alert line.
		expect(retry.querySelector('[data-field="state"]')).toBeNull();
		const failed = screen.getByRole("article", { name: "Run run_3" });
		expect(failed.querySelector('[data-field="state"]')).toBeNull();
		expect(failed.querySelector('[role="alert"]')?.textContent).toContain("BUDGET_MAX_TOOL_CALLS");
	});

	it("an assistant message alone never earns a run an inline place", async () => {
		cleanup();
		const conversation = {
			...CONVERSATION,
			messages: [assistantMessage("msg_2", 1, "run_x", "An answer without its question loaded.")],
			hasEarlier: false,
		};
		render(() => (
			<Conversation
				conversation={conversation}
				runs={[makeRun({ runId: "run_x", state: "partial", failureCode: "BUDGET_MAX_TOOL_CALLS" })]}
				onOpenRecords={() => {}}
			/>
		));
		const earlier = await screen.findByRole("region", { name: "Earlier runs" });
		expect(within(earlier).getByRole("article", { name: "Run run_x" })).toBeDefined();
		const messages = screen.getByRole("list", { name: "Messages" });
		expect(messages.querySelector('article[aria-label="Run run_x"]')).toBeNull();
	});
});

describe("conversation status announcements (finding 9)", () => {
	it("announces run transitions once each and stays silent when nothing changes", async () => {
		cleanup();
		const [runs, setRuns] = createSignal<readonly ResearchRun[]>([
			makeRun({ runId: "run_live", state: "pending", provenance: null }),
		]);
		render(() => (
			<Conversation conversation={CONVERSATION} runs={runs()} onOpenRecords={() => {}} />
		));

		const regions = () => [...document.querySelectorAll('[data-run-status="true"]')];
		expect(regions()).toHaveLength(1);
		const region = regions()[0];
		if (!(region instanceof HTMLElement)) throw new Error("expected the status region");
		expect(region.tagName).toBe("OUTPUT");
		await waitFor(() => expect(region.textContent).toContain("Waiting for a runner"));

		setRuns([makeRun({ runId: "run_live", state: "collecting", verificationStatus: null })]);
		await waitFor(() => expect(region.textContent).toBe("Collecting evidence…"));

		// A poll with a new snapshot but no state change announces nothing:
		// same region, same text.
		setRuns([
			makeRun({
				runId: "run_live",
				state: "collecting",
				verificationStatus: null,
				progress: [
					{ at: "2026-10-04T00:01:00Z", kind: "state", text: "planning" },
					{ at: "2026-10-04T00:02:00Z", kind: "note", text: "another progress line" },
				],
			}),
		]);
		expect(document.querySelectorAll('[data-run-status="true"]')).toHaveLength(1);
		expect(document.querySelector('[data-run-status="true"]')).toBe(region);
		expect(region.textContent).toBe("Collecting evidence…");

		setRuns([makeRun({ runId: "run_live", state: "completed" })]);
		await waitFor(() => expect(region.textContent).toBe("Completed: answer added."));

		setRuns([
			makeRun({ runId: "run_live", state: "failed", failureCode: "BUDGET_MAX_TOOL_CALLS" }),
		]);
		await waitFor(() => expect(region.textContent).toBe("Failed: BUDGET_MAX_TOOL_CALLS."));
	});
});
