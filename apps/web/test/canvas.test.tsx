import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	commandRequests,
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
import { WORKSPACE_ID } from "./fixtures.ts";

let backend: FakeBackend;
let server: ServerState;

beforeEach(() => {
	backend = createFakeBackend();
	server = initialServerState();
	installWorkspaceRoutes(backend, server);
	window.location.hash = `#/canvas/${WORKSPACE_ID}`;
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
});

function componentOrder(): string[] {
	const list = screen.getByRole("list", { name: "Workspace components" });
	return [...list.querySelectorAll("article[data-component-id]")].map(
		(article) => article.getAttribute("data-component-id") ?? "",
	);
}

async function canvasReady(): Promise<HTMLElement> {
	await screen.findByRole("article", { name: "Component news_1" });
	return screen.getByRole("region", { name: "Canvas" });
}

describe("canvas view", () => {
	it("renders the canvas from layout.order through the registry", async () => {
		mountApp(backend);
		const canvas = await canvasReady();
		expect(componentOrder()).toEqual(["news_1", "table_1", "sources_1"]);
		expect(within(canvas).getByText("Workspace version 4")).toBeDefined();
		expect(
			within(canvas).getByRole("heading", {
				level: 3,
				name: "Utilities accelerate storage tenders",
			}),
		).toBeDefined();
		expect(
			within(canvas).getByRole("table", { name: "Grid storage demand by year" }),
		).toBeDefined();
		// The unavailable cell is explicit, with its reason.
		expect(canvas.textContent).toContain("N/A — not yet published");
	});

	it("opens the conversation with the newest activity when the URL names none", async () => {
		window.location.hash = "#/canvas";
		mountApp(backend);
		await waitFor(() => expect(window.location.hash).toBe("#/canvas/ws_2"));
	});

	it("offers the conversation picker and a back-to-chat link", async () => {
		mountApp(backend);
		await canvasReady();
		const picker = await screen.findByRole("combobox", { name: "Conversation" });
		expect(within(picker).getByRole("option", { name: "Grid storage research" })).toBeDefined();
		const back = screen.getByRole("link", { name: "Back to chat" });
		expect(back.getAttribute("href")).toBe(`#/chat/${WORKSPACE_ID}`);
	});

	it("opens the canvas from the legacy workspace URL", async () => {
		window.location.hash = `#/workspace/${WORKSPACE_ID}`;
		mountApp(backend);
		const canvas = await canvasReady();
		expect(componentOrder()).toEqual(["news_1", "table_1", "sources_1"]);
		expect(within(canvas).getByText("Workspace version 4")).toBeDefined();
	});

	it("shows an empty state that links to Chat when there are no conversations", async () => {
		server.conversations = [];
		window.location.hash = "#/canvas";
		mountApp(backend);
		await screen.findByText(/Start one on the Chat page/);
		expect(
			screen.getByRole("link", { name: /Start one on the Chat page/ }).getAttribute("href"),
		).toBe("#/chat");
	});

	it("shows an API error with its code instead of a blank screen, and can retry", async () => {
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1$/, () =>
			errorResponse(500, "INTERNAL", "database unavailable"),
		);
		mountApp(backend);
		const alert = await screen.findByText(/database unavailable/);
		expect(alert.closest('[role="alert"]')?.textContent).toContain("INTERNAL");
		expect(screen.queryByRole("region", { name: "Canvas" })).toBeNull();

		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1$/, () => jsonResponse(server.view));
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		await canvasReady();
		expect(screen.queryByText(/database unavailable/)).toBeNull();
	});

	it("has no composer, message list or run status: the split is exclusive", async () => {
		mountApp(backend);
		await canvasReady();
		expect(screen.queryByRole("form", { name: "Research composer" })).toBeNull();
		expect(screen.queryByRole("list", { name: "Messages" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Run status" })).toBeNull();
		expect(screen.queryByRole("region", { name: "Conversation" })).toBeNull();
	});
});

describe("command dispatch (UI-006 / UI-009)", () => {
	it("sends the current workspace version and a fresh command id, and waits for the server", async () => {
		const gate = deferred<void>();
		backend.on("POST", /\/commands$/, async () => {
			await gate.promise;
			server.view = {
				...server.view,
				state: {
					...server.view.state,
					version: 5,
					components: server.view.state.components.filter((c) => c.componentId !== "news_1"),
					layout: { order: ["table_1", "sources_1"], columns: 1 },
				},
			};
			return jsonResponse({ state: server.view.state, replayed: false });
		});
		mountApp(backend);
		const canvas = await canvasReady();

		fireEvent.click(within(canvas).getByRole("button", { name: "Remove news_1" }));
		await waitFor(() => expect(commandRequests(backend)).toHaveLength(1));
		expect(commandRequests(backend)[0]?.body).toEqual({
			protocolVersion: 1,
			commandId: expect.stringMatching(/^cmd-[0-9a-f-]{36}$/),
			workspaceId: WORKSPACE_ID,
			expectedWorkspaceVersion: 4,
			operation: "component.remove",
			componentId: "news_1",
		});
		// No optimistic guess: until the server answers, the component is still shown.
		expect(componentOrder()).toEqual(["news_1", "table_1", "sources_1"]);
		expect(canvas.getAttribute("aria-busy")).toBe("true");

		gate.resolve();
		await waitFor(() => expect(componentOrder()).toEqual(["table_1", "sources_1"]));
		expect(within(canvas).getByText("Workspace version 5")).toBeDefined();
		expect(canvas.getAttribute("aria-busy")).toBe("false");
	});

	it("uses the version the server returned for the next command, with a new command id", async () => {
		mountApp(backend);
		const canvas = await canvasReady();

		fireEvent.click(within(canvas).getByRole("button", { name: "Move sources_1 up" }));
		await waitFor(() => expect(componentOrder()).toEqual(["news_1", "sources_1", "table_1"]));
		fireEvent.click(within(canvas).getByRole("button", { name: "Move news_1 down" }));
		await waitFor(() => expect(componentOrder()).toEqual(["sources_1", "news_1", "table_1"]));

		const [first, second] = commandRequests(backend).map((request) => request.body);
		expect(first).toMatchObject({
			expectedWorkspaceVersion: 4,
			operation: "layout.update",
			order: ["news_1", "sources_1", "table_1"],
			columns: 1,
		});
		expect(second).toMatchObject({
			expectedWorkspaceVersion: 5,
			operation: "layout.update",
			order: ["sources_1", "news_1", "table_1"],
		});
		const ids = commandRequests(backend).map((request) =>
			typeof request.body === "object" && request.body !== null && "commandId" in request.body
				? request.body.commandId
				: null,
		);
		expect(new Set(ids).size).toBe(2);
		expect(within(canvas).getByText("Workspace version 6")).toBeDefined();
	});

	it("renders the state the server returned even when it differs from what was asked", async () => {
		backend.on("POST", /\/commands$/, () => {
			// The server answers with its own accepted state: another component focused, version 99.
			server.view = {
				...server.view,
				state: { ...server.view.state, version: 99, focusedComponentId: "table_1" },
			};
			return jsonResponse({ state: server.view.state, replayed: false });
		});
		mountApp(backend);
		const canvas = await canvasReady();

		fireEvent.click(within(canvas).getByRole("button", { name: "Focus news_1" }));
		await within(canvas).findByText("Workspace version 99");
		const focused = [...canvas.querySelectorAll('li[data-focused="true"] article')].map((article) =>
			article.getAttribute("data-component-id"),
		);
		expect(focused).toEqual(["table_1"]);
		expect(
			within(canvas).getByRole("button", { name: "Focus table_1" }).getAttribute("aria-pressed"),
		).toBe("true");
		expect(
			within(canvas).getByRole("button", { name: "Focus news_1" }).getAttribute("aria-pressed"),
		).toBe("false");
	});

	it("toggles between one and two columns through a layout command", async () => {
		mountApp(backend);
		const canvas = await canvasReady();
		fireEvent.click(within(canvas).getByRole("button", { name: "Use 2 columns" }));
		await within(canvas).findByRole("button", { name: "Use 1 column" });
		expect(commandRequests(backend)[0]?.body).toMatchObject({
			operation: "layout.update",
			order: ["news_1", "table_1", "sources_1"],
			columns: 2,
		});
		expect(
			screen.getByRole("list", { name: "Workspace components" }).getAttribute("data-columns"),
		).toBe("2");
	});

	it("selects a table row through a component.select command", async () => {
		mountApp(backend);
		const canvas = await canvasReady();
		fireEvent.click(within(canvas).getByRole("button", { name: "Select row 1" }));
		await waitFor(() =>
			expect(
				within(canvas).getByRole("button", { name: "Select row 1" }).getAttribute("aria-pressed"),
			).toBe("true"),
		);
		expect(commandRequests(backend)[0]?.body).toMatchObject({
			operation: "component.select",
			componentId: "table_1",
			itemKey: "row-0",
			expectedWorkspaceVersion: 4,
		});
	});

	it("refetches and tells the user on a 409 VERSION_CONFLICT", async () => {
		mountApp(backend);
		const canvas = await canvasReady();
		// Another writer (e.g. a finished run) moved the workspace on to version 7.
		server.view = {
			...server.view,
			state: {
				...server.view.state,
				version: 7,
				components: server.view.state.components.filter((c) => c.componentId !== "sources_1"),
				layout: { order: ["table_1", "news_1"], columns: 1 },
			},
		};

		fireEvent.click(within(canvas).getByRole("button", { name: "Remove news_1" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("VERSION_CONFLICT");
		expect(alert.textContent).toContain("version conflict");
		expect(alert.textContent).toContain("please repeat the action");

		// The stale command changed nothing; the canvas now shows the server's version 7.
		await waitFor(() => expect(componentOrder()).toEqual(["table_1", "news_1"]));
		expect(within(canvas).getByText("Workspace version 7")).toBeDefined();
		expect(commandRequests(backend)[0]?.body).toMatchObject({ expectedWorkspaceVersion: 4 });
		const lastRequests = backend.requests.slice(
			backend.requests.findIndex((request) => request.method === "POST"),
		);
		expect(
			lastRequests.some(
				(request) => request.method === "GET" && request.path === "/api/v1/workspaces/ws_1",
			),
		).toBe(true);

		// Repeating the action now uses the refreshed version and succeeds.
		fireEvent.click(within(canvas).getByRole("button", { name: "Remove news_1" }));
		await waitFor(() => expect(componentOrder()).toEqual(["table_1"]));
		expect(commandRequests(backend)[1]?.body).toMatchObject({ expectedWorkspaceVersion: 7 });
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows a rejected command with its code and leaves the canvas unchanged", async () => {
		backend.on("POST", /\/commands$/, () =>
			errorResponse(422, "UI_COMMAND_REJECTED", "command rejected", "COMPONENT_NOT_FOUND"),
		);
		mountApp(backend);
		const canvas = await canvasReady();
		fireEvent.click(within(canvas).getByRole("button", { name: "Remove table_1" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("UI_COMMAND_REJECTED");
		expect(alert.textContent).toContain("COMPONENT_NOT_FOUND");
		expect(componentOrder()).toEqual(["news_1", "table_1", "sources_1"]);
		expect(within(canvas).getByText("Workspace version 4")).toBeDefined();
	});
});

describe("canvas reload (FR-010)", () => {
	it("renders the same components after a remount, from server state, without rerunning research", async () => {
		const first = mountApp(backend);
		const canvas = await canvasReady();
		fireEvent.click(within(canvas).getByRole("button", { name: "Remove news_1" }));
		await waitFor(() => expect(componentOrder()).toEqual(["table_1", "sources_1"]));
		const before = {
			order: componentOrder(),
			table: within(canvas).getByRole("table", { name: "Grid storage demand by year" }).textContent,
		};

		// "Reload": the whole app is torn down and started again against the same server.
		first.unmount();
		expect(screen.queryByRole("region", { name: "Canvas" })).toBeNull();
		mountApp(backend);

		const reloaded = await screen.findByRole("region", { name: "Canvas" });
		await within(reloaded).findByRole("article", { name: "Component table_1" });
		expect(componentOrder()).toEqual(before.order);
		expect(
			within(reloaded).getByRole("table", { name: "Grid storage demand by year" }).textContent,
		).toBe(before.table);
		expect(within(reloaded).getByText("Workspace version 5")).toBeDefined();
		expect(window.location.hash).toBe(`#/canvas/${WORKSPACE_ID}`);
		// Reopening a canvas reads stored state only.
		expect(backend.requestsTo("POST", /research-runs/)).toHaveLength(0);
	});
});
