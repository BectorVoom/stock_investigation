import type {
	NotebookTurn,
	NotebookWidget,
	NotebookWidgetCore,
	NotebookWidgetOrigin,
} from "@research/contracts";
import type { WorkspaceComponent } from "@research/ui-registry";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupThreadComponents } from "../../src/chat/ThreadPreviews.tsx";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "../appHarness.tsx";
import { createFakeBackend, type FakeBackend } from "../fakeBackend.ts";
import { CONVERSATION, WORKSPACE_ID, WORKSPACE_VIEW } from "../fixtures.ts";
import { makeNotebookTurn, makeNotebookWidget } from "./notebookFixtures.ts";

const notebookControl = vi.hoisted(() => ({
	seedWidgets: [] as NotebookWidget[],
	seedVersion: 0,
	seedTurns: [] as NotebookTurn[],
	addCalls: [] as { readonly core: NotebookWidgetCore; readonly origin: NotebookWidgetOrigin }[],
	reloadCalls: 0,
	created: 0,
}));

vi.mock("../../src/notebook/notebookSession.ts", async () => {
	const { createSignal } = await import("solid-js");
	const contractsModule = await import("@research/contracts");
	const { makeNotebookResponse: seedNotebook } = await import("./notebookFixtures.ts");
	type SeededResponse = import("@research/contracts").NotebookResponse;
	type SeededWidget = import("@research/contracts").NotebookWidget;
	type SeededCore = import("@research/contracts").NotebookWidgetCore;
	type SeededOrigin = import("@research/contracts").NotebookWidgetOrigin;
	return {
		createNotebookSession: () => {
			notebookControl.created += 1;
			const seed: SeededResponse = seedNotebook({
				notebook: { widgets: [...notebookControl.seedWidgets] },
				version: notebookControl.seedVersion,
				turns: [...notebookControl.seedTurns],
			});
			const [state, setState] = createSignal<SeededResponse>(seed);
			const [selection, setSelection] = createSignal<readonly string[]>([]);
			return {
				state,
				widgets: () => state().notebook.widgets,
				loadError: () => null,
				notice: () => null,
				dismissNotice: () => undefined,
				pending: () => false,
				selection,
				select: (widgetId: string | null, mode: "replace" | "toggle") => {
					if (widgetId === null) return setSelection([]);
					if (mode === "replace") return setSelection([widgetId]);
					setSelection((current) =>
						current.includes(widgetId)
							? current.filter((id) => id !== widgetId)
							: [...current, widgetId],
					);
				},
				turns: () => state().turns,
				reload: async () => {
					notebookControl.reloadCalls += 1;
				},
				edit: async () => false,
				addWidget: async (core: SeededCore, origin: SeededOrigin) => {
					notebookControl.addCalls.push({ core, origin });
					const widget: SeededWidget = contractsModule.notebookWidgetSchema.parse({
						...core,
						createdAt: "2026-10-07T00:00:00Z",
						updatedAt: "2026-10-07T00:00:00Z",
						revision: 1,
						origin,
					});
					setState((current) => ({
						...current,
						notebook: { widgets: [...current.notebook.widgets, widget] },
						version: current.version + 1,
					}));
					return widget.widgetId;
				},
				undo: async () => true,
				removeWidgets: async (widgetIds: readonly string[]) => {
					setState((current) => ({
						...current,
						notebook: {
							widgets: current.notebook.widgets.filter(
								(widget) => !widgetIds.includes(widget.widgetId),
							),
						},
						version: current.version + 1,
					}));
					return true;
				},
			};
		},
	};
});

let backend: FakeBackend;
let server: ServerState;

beforeEach(() => {
	backend = createFakeBackend();
	server = initialServerState();
	installWorkspaceRoutes(backend, server);
	window.location.hash = `#/chat/${WORKSPACE_ID}`;
	window.localStorage.clear();
	notebookControl.seedWidgets = [];
	notebookControl.seedVersion = 0;
	notebookControl.seedTurns = [];
	notebookControl.addCalls = [];
	notebookControl.reloadCalls = 0;
	notebookControl.created = 0;
});

afterEach(() => {
	cleanup();
	window.location.hash = "";
	window.localStorage.clear();
});

function component(id: string): WorkspaceComponent {
	return {
		componentId: id,
		componentType: "data-table",
		schemaVersion: 1,
		props: {},
	} as WorkspaceComponent;
}

describe("groupThreadComponents", () => {
	it("groups by the run id prefix in layout order, leaving the rest as orphans", () => {
		const table = component("run_1_table");
		const news = component("run_1_news");
		const other = component("news_1");
		const groups = groupThreadComponents(
			[other, table, news],
			["news_1", "run_1_news", "run_1_table"],
			new Set(["run_1", "run_2"]),
		);
		expect([...(groups.byRun.get("run_1") ?? [])].map((item) => item.componentId)).toEqual([
			"run_1_news",
			"run_1_table",
		]);
		expect(groups.orphans.map((item) => item.componentId)).toEqual(["news_1"]);
	});

	it("ignores unknown run prefixes and layout ids with no component", () => {
		const groups = groupThreadComponents(
			[component("run_9_table")],
			["run_9_table", "missing_id"],
			new Set(["run_1"]),
		);
		expect(groups.byRun.size).toBe(0);
		expect(groups.orphans.map((item) => item.componentId)).toEqual(["run_9_table"]);
	});
});

describe("thread previews (integration)", () => {
	async function threadReady(): Promise<HTMLElement> {
		const conversation = await screen.findByRole("region", { name: "Conversation" });
		await within(conversation).findByRole("article", { name: "Assistant message" });
		await screen.findByRole("region", { name: "Notebook" });
		return conversation;
	}

	it("lists components no visible run owns after the thread under Other results", async () => {
		mountApp(backend);
		await threadReady();
		const others = await screen.findByRole("heading", { name: "Other results" });
		expect(others).toBeDefined();
		// The preview renders the component itself, widget-styled.
		expect(screen.getByRole("article", { name: "Component news_1" })).toBeDefined();
		expect(screen.getByRole("table", { name: "Grid storage demand by year" })).toBeDefined();
		// Every preview offers one save into the Notebook.
		expect(
			screen.getAllByRole("button", { name: "Add to Notebook" }).length,
		).toBeGreaterThanOrEqual(4);
	});

	it("renders owned components after their assistant answer, not under Other results", async () => {
		const extra = {
			...WORKSPACE_VIEW.state.components[1],
			componentId: "run_1_extra",
		} as (typeof WORKSPACE_VIEW.state.components)[number];
		server.view = {
			...server.view,
			state: {
				...server.view.state,
				components: [...server.view.state.components, extra],
				layout: { order: [...server.view.state.layout.order, "run_1_extra"], columns: 1 },
			},
		};
		mountApp(backend);
		await threadReady();
		const group = document.querySelector('[data-preview-run="run_1"]');
		expect(group).not.toBeNull();
		expect(group?.querySelector('[data-component-id="run_1_extra"]')).not.toBeNull();
		// The owned preview sits inside the messages list, after its answer.
		const list = screen.getByRole("list", { name: "Messages" });
		expect(list.contains(group)).toBe(true);
	});

	it("saves a component into the Notebook with a chat origin, then says In notebook", async () => {
		const extra = {
			...WORKSPACE_VIEW.state.components[1],
			componentId: "run_1_extra",
		} as (typeof WORKSPACE_VIEW.state.components)[number];
		server.view = {
			...server.view,
			state: {
				...server.view.state,
				components: [...server.view.state.components, extra],
				layout: { order: [...server.view.state.layout.order, "run_1_extra"], columns: 1 },
			},
		};
		mountApp(backend);
		const conversation = await threadReady();
		// An owned preview carries the producing run and answer in its origin…
		const owned = document.querySelector('[data-preview-component="run_1_extra"]');
		expect(owned).not.toBeNull();
		fireEvent.click(within(owned as HTMLElement).getByRole("button", { name: "Add to Notebook" }));
		await waitFor(() => expect(notebookControl.addCalls).toHaveLength(1));
		const call = notebookControl.addCalls[0];
		expect(call?.origin).toEqual({
			kind: "chat",
			messageId: "msg_2",
			runId: "run_1",
			componentId: "run_1_extra",
		});
		// A table component becomes a self-contained table widget (its rows copied).
		expect(call?.core.type).toBe("table");
		expect(typeof call?.core.widgetId).toBe("string");
		// …while an orphan (no visible run owns it) carries no run or message.
		const orphan = document.querySelector('[data-preview-component="table_1"]');
		fireEvent.click(within(orphan as HTMLElement).getByRole("button", { name: "Add to Notebook" }));
		await waitFor(() => expect(notebookControl.addCalls).toHaveLength(2));
		expect(notebookControl.addCalls[1]?.origin).toEqual({
			kind: "chat",
			messageId: null,
			runId: null,
			componentId: "table_1",
		});
		// Once added the previews offer no second click.
		await within(conversation).findAllByText("In notebook");
		expect(
			within(owned as HTMLElement).queryByRole("button", { name: "Add to Notebook" }),
		).toBeNull();
		expect(
			within(orphan as HTMLElement).queryByRole("button", { name: "Add to Notebook" }),
		).toBeNull();
	});

	it("shows In notebook up front for components already saved", async () => {
		notebookControl.seedWidgets = [
			makeNotebookWidget({
				widgetId: "nb_saved",
				origin: { kind: "chat", messageId: "msg_2", runId: "run_1", componentId: "news_1" },
			}),
		];
		mountApp(backend);
		await threadReady();
		const preview = document.querySelector('[data-preview-component="news_1"]');
		expect(preview?.textContent).toContain("In notebook");
		expect(
			within(preview as HTMLElement).queryByRole("button", { name: "Add to Notebook" }),
		).toBeNull();
	});

	it("saves an answer beside Copy answer with its message origin", async () => {
		mountApp(backend);
		const conversation = await threadReady();
		const reply = within(conversation).getByRole("article", { name: "Assistant message" });
		fireEvent.click(within(reply).getByRole("button", { name: "Add to Notebook" }));
		await waitFor(() => expect(notebookControl.addCalls).toHaveLength(1));
		expect(notebookControl.addCalls[0]?.origin).toEqual({
			kind: "chat",
			messageId: "msg_2",
			runId: "run_1",
			componentId: null,
		});
		expect(notebookControl.addCalls[0]?.core.type).toBe("text");
		await within(conversation).findByText("In notebook");
	});

	it("tags every message with its stable id for origin jumps", async () => {
		mountApp(backend);
		await threadReady();
		for (const message of CONVERSATION.messages) {
			const element = document.querySelector(`[data-message-id="${message.messageId}"]`);
			expect(element).not.toBeNull();
			expect(element?.getAttribute("id")).toBe(`message-${message.messageId}`);
		}
	});

	it("selects a preview row through a component.select command", async () => {
		mountApp(backend);
		await threadReady();
		fireEvent.click(screen.getByRole("button", { name: "Select row 1" }));
		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: "Select row 1" }).getAttribute("aria-pressed"),
			).toBe("true"),
		);
		const commands = backend.requestsTo("POST", /\/commands$/);
		expect(commands).toHaveLength(1);
		expect(commands[0]?.body).toMatchObject({
			operation: "component.select",
			componentId: "table_1",
			itemKey: "row-0",
			expectedWorkspaceVersion: 4,
		});
	});

	it("matches the assistant turn card to its reply by run id", async () => {
		notebookControl.seedTurns = [makeNotebookTurn({ runId: "run_1" })];
		notebookControl.seedVersion = 2;
		mountApp(backend);
		await threadReady();
		const card = await screen.findByRole("article", { name: "Notebook changes for run run_1" });
		expect(card.textContent).toContain("Resized “Revenue”");
		// The card sits with its reply inside the messages list.
		const list = screen.getByRole("list", { name: "Messages" });
		expect(list.contains(card)).toBe(true);
	});
});
