import type {
	AgentSettingsResponse,
	AgentsResponse,
	NotebookAssistResponse,
} from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "../../src/api/http.ts";
import {
	Composer,
	type ComposerTarget,
	notebookFailureLink,
	notebookFailureText,
} from "../../src/chat/Composer.tsx";
import { composerMessages } from "../../src/chat/composer.messages.ts";
import { addressesNotebook } from "../../src/chat/composerTarget.ts";
import type { Remote } from "../../src/lib/remote.ts";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "../appHarness.tsx";
import {
	createFakeBackend,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "../fakeBackend.ts";
import { AGENT_SETTINGS_RESPONSE, AGENTS, WORKSPACE_ID } from "../fixtures.ts";
import {
	makeNotebookAssistRun,
	makeNotebookResponse,
	makeNotebookWidget,
} from "./notebookFixtures.ts";

let backend: FakeBackend;
let server: ServerState;

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

function assistResponse(runState: "pending" | "completed" = "pending"): NotebookAssistResponse {
	return {
		message: {
			messageId: "msg_nb_1",
			seq: 2,
			role: "owner",
			text: "make it larger",
			runId: "run_assist_1",
			claimIds: [],
			createdAt: "2026-10-07T00:00:00Z",
		},
		run: makeNotebookAssistRun({ runId: "run_assist_1", state: runState }),
	};
}

async function chatReady(): Promise<void> {
	await screen.findByRole("region", { name: "Conversation" });
	await screen.findByRole("article", { name: "Assistant message" });
	await screen.findByRole("region", { name: "Notebook" });
}

describe("composer target (integration)", () => {
	it("defaults to Research in Chat-first and hides research fields for Notebook", async () => {
		mountApp(backend);
		await chatReady();
		const research = await screen.findByRole("form", { name: "Research composer" });
		// The old target buttons are gone; the mode lives in the + menu.
		expect(within(research).queryByRole("button", { name: "Research" })).toBeNull();
		expect(within(research).queryByRole("button", { name: "Notebook" })).toBeNull();
		expect(within(research).getByRole("button", { name: "Choose mode" })).toBeDefined();
		expect(within(research).queryByRole("button", { name: "Leave Notebook mode" })).toBeNull();
		fireEvent.click(within(research).getByRole("button", { name: "Choose mode" }));
		const menu = await screen.findByRole("menu", { name: "Composer mode" });
		expect(
			within(menu).getByRole("menuitemradio", { name: "Research" }).getAttribute("aria-checked"),
		).toBe("true");
		expect(
			within(menu).getByRole("menuitemradio", { name: "Notebook" }).getAttribute("aria-checked"),
		).toBe("false");
		expect(within(research).getByText(/Options:/)).toBeDefined();

		fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Notebook" }));
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		expect(within(notebook).queryByText(/Options:/)).toBeNull();
		expect(within(notebook).queryByText(/Change in Settings/)).toBeNull();
		expect(within(notebook).getByText("About the whole notebook")).toBeDefined();
		expect(within(notebook).getByRole("button", { name: "Send instruction" })).toBeDefined();
		expect(within(notebook).getByRole("button", { name: "Leave Notebook mode" })).toBeDefined();
	});

	it("defaults to Notebook in Notebook-first and keeps the draft across the switch", async () => {
		mountApp(backend);
		await chatReady();
		const box = (await screen.findByLabelText("Question")) as HTMLTextAreaElement;
		fireEvent.input(box, { target: { value: "make it larger" } });
		fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		// The same textarea node: the draft survived the state switch.
		expect(within(notebook).getByLabelText("Instruction")).toBe(box);
		expect(box.value).toBe("make it larger");
	});

	it("keeps the owner's manual Research choice in Notebook-first", async () => {
		mountApp(backend);
		await chatReady();
		fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		fireEvent.click(within(notebook).getByRole("button", { name: "Choose mode" }));
		const menu = await screen.findByRole("menu", { name: "Composer mode" });
		fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Research" }));
		await screen.findByRole("form", { name: "Research composer" });
	});

	it("sends the instruction with the selection and notebook version", async () => {
		server.notebook = makeNotebookResponse({
			notebook: { widgets: [makeNotebookWidget()] },
			version: 4,
			undoAvailable: true,
		});
		backend.on("POST", /^\/api\/v1\/workspaces\/ws_1\/notebook\/assist$/, () =>
			jsonResponse(assistResponse("pending"), { status: 202 }),
		);
		mountApp(backend);
		await chatReady();
		fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		fireEvent.input(within(notebook).getByLabelText("Instruction"), {
			target: { value: "make it larger" },
		});
		fireEvent.click(within(notebook).getByRole("button", { name: "Send instruction" }));
		await waitFor(() => expect(backend.requestsTo("POST", /notebook\/assist$/)).toHaveLength(1));
		const sent = backend.requestsTo("POST", /notebook\/assist$/)[0];
		expect(sent?.body).toEqual({
			instruction: "make it larger",
			selectedWidgetIds: [],
			notebookVersion: 4,
		});
		expect(sent?.headers["idempotency-key"]).toMatch(/^idem-[0-9a-f-]{36}$/);
		await within(notebook).findByText(/starts when a runner claims it/);
		// The sent instruction clears; the composer stays on the Notebook target.
		await waitFor(() =>
			expect((within(notebook).getByLabelText("Instruction") as HTMLTextAreaElement).value).toBe(
				"",
			),
		);
	});

	it("shows a failed assist with its stable code", async () => {
		backend.on("POST", /^\/api\/v1\/workspaces\/ws_1\/notebook\/assist$/, () =>
			errorResponse(500, "INTERNAL", "database unavailable"),
		);
		mountApp(backend);
		await chatReady();
		fireEvent.click(screen.getAllByRole("button", { name: "Focus Notebook" })[0] as HTMLElement);
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		fireEvent.input(within(notebook).getByLabelText("Instruction"), {
			target: { value: "make it larger" },
		});
		fireEvent.click(within(notebook).getByRole("button", { name: "Send instruction" }));
		const alert = await within(notebook).findByText(/database unavailable/);
		expect(alert.closest('[role="alert"]')?.textContent).toContain("INTERNAL");
	});

	it("routes to the Notebook target while the draft names the notebook", async () => {
		mountApp(backend);
		await chatReady();
		const research = await screen.findByRole("form", { name: "Research composer" });
		fireEvent.input(within(research).getByLabelText("Question"), {
			target: { value: "Create a chart of gold prices in the Notebook" },
		});
		// The pills update live while typing: the draft names the notebook.
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		// The chip makes that routing visible.
		expect(within(notebook).getByRole("button", { name: "Leave Notebook mode" })).toBeDefined();
		// Dropping the mention routes back to Research.
		fireEvent.input(within(notebook).getByLabelText("Instruction"), {
			target: { value: "gold prices" },
		});
		await screen.findByRole("form", { name: "Research composer" });
	});

	it("a manual pill choice wins over a draft that names a widget", async () => {
		mountApp(backend);
		await chatReady();
		const research = await screen.findByRole("form", { name: "Research composer" });
		fireEvent.input(within(research).getByLabelText("Question"), {
			target: { value: "add a widget for gold" },
		});
		const notebook = await screen.findByRole("form", { name: "Notebook composer" });
		fireEvent.click(within(notebook).getByRole("button", { name: "Choose mode" }));
		const menu = await screen.findByRole("menu", { name: "Composer mode" });
		fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Research" }));
		// The draft still names a widget, but the manual choice holds.
		const backToResearch = await screen.findByRole("form", { name: "Research composer" });
		expect(
			within(backToResearch).queryByRole("button", { name: "Leave Notebook mode" }),
		).toBeNull();
	});
});

describe("addressesNotebook", () => {
	const cases: { readonly text: string; readonly expected: boolean }[] = [
		{ text: "create a widget in the Notebook showing a chart", expected: true },
		{ text: "Create a chart of gold prices over the past year in the Notebook", expected: true },
		{ text: "add a WIDGET for gold", expected: true },
		{ text: "open my notebooks", expected: true },
		{ text: "notebook", expected: true },
		{ text: "ノートブックに金価格のチャートを追加", expected: true },
		{ text: "ウィジェットを追加して", expected: true },
		{ text: "Please create gold chart.", expected: true },
		{ text: "Can you plot gold prices as a line graph?", expected: true },
		{ text: "show me a chart of the yen", expected: true },
		{ text: "金価格のグラフを作成して", expected: true },
		{ text: "ドル円のチャートを表示", expected: true },
		{ text: "Which chart patterns do analysts cite for gold?", expected: false },
		{ text: "Which suppliers make graphite anodes?", expected: false },
		{ text: "グラフェンの需要は？", expected: false },
		{ text: "Which storage products will see demand growth?", expected: false },
		{ text: "noteworthy gadgets", expected: false },
		{ text: "somewidgets here", expected: false },
		{ text: "ノート", expected: false },
		{ text: "", expected: false },
	];
	it.each(cases)("addressesNotebook($text) is $expected", ({ text, expected }) => {
		expect(addressesNotebook(text)).toBe(expected);
	});
});

describe("composer target (unit)", () => {
	function mountNotebook(
		props: {
			readonly target?: ComposerTarget;
			readonly selection?: readonly { readonly widgetId: string; readonly title: string }[];
			readonly onSubmitNotebook?: (
				instruction: string,
				key: string,
			) => Promise<ApiResult<NotebookAssistResponse>>;
		} = {},
	) {
		const onTargetChange = vi.fn();
		const onRemoveSelection = vi.fn();
		const agents: Remote<AgentsResponse> = { status: "ready", value: AGENTS };
		const settings: Remote<AgentSettingsResponse> = {
			status: "ready",
			value: AGENT_SETTINGS_RESPONSE,
		};
		render(() => (
			<Composer
				workspaceId={WORKSPACE_ID}
				agents={agents}
				settings={settings}
				onReloadAgents={() => undefined}
				onReloadSettings={() => undefined}
				newIdempotencyKey={() => "idem-test-key-1"}
				onSubmit={async () => ({
					ok: false,
					error: {
						kind: "api",
						code: "INTERNAL",
						status: 500,
						message: "unused",
						detail: null,
						issues: [],
					},
				})}
				target={props.target ?? "notebook"}
				onTargetChange={onTargetChange}
				selection={props.selection ?? []}
				onRemoveSelection={onRemoveSelection}
				onSubmitNotebook={props.onSubmitNotebook}
			/>
		));
		return { onTargetChange, onRemoveSelection };
	}

	it("shows selected widgets as removable chips, and the whole-notebook hint when empty", () => {
		const { onRemoveSelection } = mountNotebook({
			selection: [
				{ widgetId: "nb_1", title: "Revenue" },
				{ widgetId: "nb_2", title: "Costs" },
			],
		});
		const list = screen.getByRole("list", { name: "Selected widgets" });
		expect(within(list).getByText("Revenue")).toBeDefined();
		expect(within(list).getByText("Costs")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Remove Revenue from selection" }));
		expect(onRemoveSelection).toHaveBeenCalledWith("nb_1");
		cleanup();

		mountNotebook({ selection: [] });
		expect(screen.getByText("About the whole notebook")).toBeDefined();
		expect(screen.queryByRole("list", { name: "Selected widgets" })).toBeNull();
	});

	it("disables sending without a submit handler or instruction", () => {
		mountNotebook({});
		const withoutHandler = screen.getByRole("button", {
			name: "Send instruction",
		}) as HTMLButtonElement;
		expect(withoutHandler.disabled).toBe(true);
		cleanup();

		mountNotebook({ onSubmitNotebook: async () => ({ ok: true, value: assistResponse() }) });
		const send = screen.getByRole("button", { name: "Send instruction" }) as HTMLButtonElement;
		expect(send.disabled).toBe(true);
		fireEvent.input(screen.getByLabelText("Instruction"), { target: { value: "make it larger" } });
		expect(send.disabled).toBe(false);
	});

	it("maps the notebook-assistant failure codes to their sentences", () => {
		expect(notebookFailureText({ code: "AGENT_NOT_CONFIGURED" }, composerMessages.en)).toBe(
			"The notebook assistant needs an agent backend.",
		);
		expect(notebookFailureLink({ code: "AGENT_NOT_CONFIGURED" })).toBe(true);
		expect(notebookFailureText({ code: "NOTEBOOK_ASSIST_ACTIVE" }, composerMessages.en)).toBe(
			"One notebook request runs at a time. Wait for it to finish and try again.",
		);
		expect(notebookFailureLink({ code: "NOTEBOOK_ASSIST_ACTIVE" })).toBe(false);
		expect(notebookFailureText({ code: "INTERNAL" }, composerMessages.en)).toBeNull();
	});
});
