import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotebookTurnCard } from "../../src/chat/NotebookTurnCard.tsx";
import {
	initialServerState,
	installWorkspaceRoutes,
	mountApp,
	type ServerState,
} from "../appHarness.tsx";
import { createFakeBackend, type FakeBackend, jsonResponse } from "../fakeBackend.ts";
import { CONVERSATION, WORKSPACE_ID } from "../fixtures.ts";
import {
	makeNotebookAssistRun,
	makeNotebookResponse,
	makeNotebookTurn,
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

describe("NotebookTurnCard (unit)", () => {
	function mountCard(props: Partial<Parameters<typeof NotebookTurnCard>[0]> = {}) {
		const onUndo = vi.fn();
		const onRemove = vi.fn();
		const onKeep = vi.fn();
		render(() => (
			<NotebookTurnCard
				turn={makeNotebookTurn()}
				notebookVersion={2}
				isKept={() => false}
				onUndo={onUndo}
				undoPending={false}
				onRemove={onRemove}
				onKeep={onKeep}
				{...props}
			/>
		));
		return { onUndo, onRemove, onKeep };
	}

	it("lists one line per change with titles", () => {
		mountCard({
			turn: makeNotebookTurn({
				changes: [
					{ widgetId: "nb_1", kind: "added", title: "Revenue", before: null, after: null },
					{ widgetId: "nb_2", kind: "moved", title: "Costs", before: null, after: null },
					{
						widgetId: "nb_3",
						kind: "duplicated",
						title: "Risks",
						before: null,
						after: null,
					},
				],
			}),
		});
		const list = screen.getByRole("list", { name: "Notebook changes" });
		expect(list.textContent).toContain("Added “Revenue”");
		expect(list.textContent).toContain("Moved “Costs”");
		expect(list.textContent).toContain("Duplicated “Risks”");
	});

	it("shows before → after inline when short, behind a disclosure when long", () => {
		const { unmount } = render(() => (
			<NotebookTurnCard
				turn={makeNotebookTurn({
					changes: [
						{
							widgetId: "nb_1",
							kind: "updated",
							title: "Note",
							before: "old",
							after: "new",
						},
					],
				})}
				notebookVersion={2}
				isKept={() => false}
				onUndo={() => undefined}
				undoPending={false}
				onRemove={() => undefined}
				onKeep={() => undefined}
			/>
		));
		expect(screen.getByText(/old → new/)).toBeDefined();
		expect(screen.queryByText("Show changes")).toBeNull();
		unmount();
		cleanup();

		mountCard({
			turn: makeNotebookTurn({
				changes: [
					{
						widgetId: "nb_1",
						kind: "updated",
						title: "Note",
						before: "old ".repeat(60),
						after: "new ".repeat(60),
					},
				],
			}),
		});
		// Long text hides behind the disclosure until opened.
		expect(screen.getByText("Show changes")).toBeDefined();
		expect(screen.queryByText("old old old old old")).toBeNull();
		fireEvent.click(screen.getByText("Show changes"));
		expect(screen.getByText(/old old old old old/)).toBeDefined();
	});

	it("shows the failure sentence when the turn applied nothing", () => {
		mountCard({
			turn: makeNotebookTurn({
				appliedVersion: null,
				changes: [],
				failure: { code: "NOTEBOOK_CHANGED", message: "The notebook changed while working." },
			}),
		});
		expect(screen.getByText("The notebook changed while working.")).toBeDefined();
		expect(screen.queryByRole("list", { name: "Notebook changes" })).toBeNull();
	});

	it("enables Undo only while the notebook sits at the turn's version", () => {
		const first = mountCard({ notebookVersion: 2 });
		const undo = screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement;
		expect(undo.disabled).toBe(false);
		fireEvent.click(undo);
		expect(first.onUndo).toHaveBeenCalledTimes(1);
		cleanup();

		mountCard({ notebookVersion: 5 });
		expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
		cleanup();

		mountCard({
			turn: makeNotebookTurn({ appliedVersion: null, changes: [] }),
			notebookVersion: 2,
		});
		expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
	});

	it("confirms proposed removals with Remove / Keep, hiding kept ones", () => {
		const { onRemove, onKeep } = mountCard({
			turn: makeNotebookTurn({
				proposedRemovals: [{ widgetId: "nb_9", title: "Stale" }],
			}),
		});
		const row = screen.getByText("Remove “Stale”?");
		expect(row).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Remove" }));
		expect(onRemove).toHaveBeenCalledWith(["nb_9"]);
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		expect(onKeep).toHaveBeenCalledWith(["nb_9"]);
		cleanup();

		mountCard({
			turn: makeNotebookTurn({
				proposedRemovals: [{ widgetId: "nb_9", title: "Stale" }],
			}),
			isKept: (widgetId) => widgetId === "nb_9",
		});
		expect(screen.queryByText("Remove “Stale”?")).toBeNull();
	});
});

describe("notebook-assist runs in the thread (integration)", () => {
	const ASSIST_CONVERSATION = {
		...CONVERSATION,
		messages: [
			{
				messageId: "msg_a1",
				seq: 0,
				role: "owner" as const,
				text: "make it larger",
				runId: "run_assist_1",
				claimIds: [],
				createdAt: "2026-10-07T00:00:00Z",
			},
			{
				messageId: "msg_a2",
				seq: 1,
				role: "assistant" as const,
				text: "Resized Revenue to large.",
				runId: "run_assist_1",
				claimIds: [],
				createdAt: "2026-10-07T00:01:00Z",
			},
		],
		claims: [],
		evidence: [],
		hasEarlier: false,
	};

	function assistReady(runState: "pending" | "completed" = "completed"): void {
		server.runs = [makeNotebookAssistRun({ state: runState })];
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, () =>
			jsonResponse(ASSIST_CONVERSATION, { headers: { ETag: '"m-assist"' } }),
		);
	}

	it("labels the reply Notebook assistant with a turn card and no run card once finished", async () => {
		assistReady("completed");
		server.notebook = makeNotebookResponse({
			notebook: { widgets: [] },
			version: 2,
			turns: [makeNotebookTurn()],
		});
		mountApp(backend);
		const conversation = await screen.findByRole("region", { name: "Conversation" });
		const reply = (await within(conversation).findByText("Resized Revenue to large.")).closest(
			"article",
		);
		expect(reply?.textContent).toContain("Notebook assistant");
		// Never citation chips, never an Evidence action for the assistant reply.
		expect(within(reply as HTMLElement).queryByRole("button", { name: "Evidence" })).toBeNull();
		expect(within(reply as HTMLElement).queryByRole("button", { name: /^Source \d+:/ })).toBeNull();
		// The finished run mounts no card; the turn card speaks for it.
		expect(screen.queryByRole("article", { name: "Run run_assist_1" })).toBeNull();
		expect(screen.queryByRole("article", { name: "Run run_assist_1", hidden: true })).toBeNull();
		const card = await screen.findByRole("article", {
			name: "Notebook changes for run run_assist_1",
		});
		expect(card.textContent).toContain("Resized “Revenue”");
		expect((within(card).getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(
			false,
		);
	});

	it("shows the run card like a research run while queued", async () => {
		assistReady("pending");
		mountApp(backend);
		const run = await screen.findByRole("article", { name: "Run run_assist_1" });
		expect(run.getAttribute("data-run-state")).toBe("pending");
		expect(run.textContent).toContain("pending");
	});

	it("keeps a removal confirm row until the owner keeps it", async () => {
		assistReady("completed");
		server.notebook = makeNotebookResponse({
			notebook: { widgets: [] },
			version: 2,
			turns: [
				makeNotebookTurn({
					changes: [],
					proposedRemovals: [{ widgetId: "nb_9", title: "Stale" }],
				}),
			],
		});
		mountApp(backend);
		await screen.findByText("Remove “Stale”?");
		fireEvent.click(screen.getByRole("button", { name: "Keep" }));
		await waitFor(() => expect(screen.queryByText("Remove “Stale”?")).toBeNull());
	});
});
