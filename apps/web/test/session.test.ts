import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import type { VisibilitySource } from "../src/lib/polling.ts";
import { createWorkspaceSession, type WorkspaceSession } from "../src/lib/session.ts";
import { initialServerState, installWorkspaceRoutes, type ServerState } from "./appHarness.tsx";
import {
	createFakeBackend,
	deferred,
	errorResponse,
	type FakeBackend,
	jsonResponse,
} from "./fakeBackend.ts";
import { CONVERSATION, DEFAULT_BUDGET, makeRun, WORKSPACE_ID } from "./fixtures.ts";

let backend: FakeBackend;
let server: ServerState;
let dispose: () => void = () => {};

beforeEach(() => {
	vi.useFakeTimers();
	backend = createFakeBackend();
	server = initialServerState();
	installWorkspaceRoutes(backend, server);
});

afterEach(() => {
	dispose();
	vi.useRealTimers();
});

function startSession(visibility: VisibilitySource): WorkspaceSession {
	return createRoot((disposeRoot) => {
		dispose = disposeRoot;
		return createWorkspaceSession(
			createApiClient({ fetch: backend.fetch }),
			WORKSPACE_ID,
			visibility,
		);
	});
}

function manualVisibility(initiallyVisible: boolean) {
	let visible = initiallyVisible;
	const listeners = new Set<() => void>();
	const source: VisibilitySource = {
		isVisible: () => visible,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		source,
		set(next: boolean) {
			visible = next;
			for (const listener of listeners) listener();
		},
	};
}

const paths = (from = 0) => backend.requests.slice(from).map((r) => `${r.method} ${r.path}`);

describe("workspace session polling", () => {
	it("loads workspace, conversation and runs once, then revalidates with ETags and backs off", async () => {
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.view()?.state.version).toBe(4);
		expect(session.conversation()?.messages).toHaveLength(2);
		expect(session.runs().map((run) => run.runId)).toEqual(["run_1"]);
		expect(backend.requests).toHaveLength(3);
		expect(
			backend.requests.every((request) => request.headers["if-none-match"] === undefined),
		).toBe(true);

		const loadedView = session.view();
		// Idle: nothing before 5 s (no per-second polling), next poll only after the base interval.
		await vi.advanceTimersByTimeAsync(4_999);
		expect(backend.requests).toHaveLength(3);
		await vi.advanceTimersByTimeAsync(1);
		expect(backend.requests).toHaveLength(6);
		const workspacePoll = backend.requests[3];
		const messagesPoll = backend.requests[4];
		expect(workspacePoll?.headers["if-none-match"]).toBe('"v4"');
		expect(messagesPoll?.headers["if-none-match"]).toBe('"m1"');
		// 304s: the rendered state object is untouched, so nothing re-renders.
		expect(session.view()).toBe(loadedView);

		// Unchanged again and again: 10 s, then 20 s between polls.
		await vi.advanceTimersByTimeAsync(9_999);
		expect(backend.requests).toHaveLength(6);
		await vi.advanceTimersByTimeAsync(1);
		expect(backend.requests).toHaveLength(9);
		await vi.advanceTimersByTimeAsync(19_999);
		expect(backend.requests).toHaveLength(9);
	});

	it("picks up a change made elsewhere on the next poll", async () => {
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		server.view = {
			...server.view,
			state: { ...server.view.state, version: 5, focusedComponentId: "table_1" },
		};
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.view()?.state.version).toBe(5);
		expect(session.view()?.state.focusedComponentId).toBe("table_1");
	});

	it("polls only the executing run, fast and conditionally, then refetches everything when it finishes", async () => {
		server.runs = [makeRun({ runId: "run_9", state: "collecting", verificationStatus: null })];
		let runEtag = '"r1"';
		let run = server.runs[0] ?? makeRun();
		backend.on("GET", /^\/api\/v1\/research-runs\/run_9$/, (request) =>
			request.headers["if-none-match"] === runEtag
				? new Response(null, { status: 304 })
				: jsonResponse({ run }, { headers: { ETag: runEtag } }),
		);
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.runs()[0]?.state).toBe("collecting");

		const afterLoad = backend.requests.length;
		await vi.advanceTimersByTimeAsync(2_500);
		await vi.advanceTimersByTimeAsync(2_500);
		await vi.advanceTimersByTimeAsync(2_500);
		expect(paths(afterLoad)).toEqual([
			"GET /api/v1/research-runs/run_9",
			"GET /api/v1/research-runs/run_9",
			"GET /api/v1/research-runs/run_9",
		]);
		expect(backend.requests[afterLoad + 1]?.headers["if-none-match"]).toBe('"r1"');

		// The run completes and publishes a component: workspace version moves on.
		run = makeRun({ runId: "run_9", state: "completed" });
		runEtag = '"r2"';
		server.runs = [run];
		server.view = { ...server.view, state: { ...server.view.state, version: 5 } };
		const beforeCompletion = backend.requests.length;
		await vi.advanceTimersByTimeAsync(2_500);
		expect(paths(beforeCompletion)).toEqual([
			"GET /api/v1/research-runs/run_9",
			"GET /api/v1/workspaces/ws_1",
			"GET /api/v1/workspaces/ws_1/messages",
			"GET /api/v1/research-runs?workspaceId=ws_1",
		]);
		expect(session.runs()[0]?.state).toBe("completed");
		expect(session.view()?.state.version).toBe(5);

		// Nothing is executing any more: the fast interval stops.
		const afterCompletion = backend.requests.length;
		await vi.advanceTimersByTimeAsync(4_999);
		expect(backend.requests).toHaveLength(afterCompletion);
	});

	it("makes no requests while the tab is hidden and catches up when it is shown", async () => {
		const visibility = manualVisibility(false);
		const session = startSession(visibility.source);
		await vi.advanceTimersByTimeAsync(120_000);
		expect(backend.requests).toHaveLength(0);
		expect(session.view()).toBeNull();

		visibility.set(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.view()?.state.version).toBe(4);

		visibility.set(false);
		const whileHidden = backend.requests.length;
		await vi.advanceTimersByTimeAsync(600_000);
		expect(backend.requests).toHaveLength(whileHidden);
	});

	it("stops polling when the workspace is closed", async () => {
		startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		const loaded = backend.requests.length;
		dispose();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(backend.requests).toHaveLength(loaded);
	});
});

describe("stale reads never overwrite newer state", () => {
	const WORKSPACE_ROUTE = /^\/api\/v1\/workspaces\/ws_1$/;
	const serveCurrentWorkspace = () =>
		backend.on("GET", WORKSPACE_ROUTE, () =>
			jsonResponse(server.view, { headers: { ETag: `"v${server.view.state.version}"` } }),
		);
	const componentIds = (session: WorkspaceSession) =>
		session.view()?.state.components.map((item) => item.componentId);

	it("ignores a poll response that was requested before a command was accepted", async () => {
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.view()?.state.version).toBe(4);

		// The next poll's workspace read is slow: it will answer with what was true when it was sent.
		const versionFour = structuredClone(server.view);
		const slowRead = deferred<Response>();
		backend.on("GET", WORKSPACE_ROUTE, () => slowRead.promise);
		await vi.advanceTimersByTimeAsync(5_000);
		serveCurrentWorkspace();

		await session.dispatch({ operation: "component.remove", componentId: "news_1" });
		expect(session.view()?.state.version).toBe(5);
		expect(componentIds(session)).toEqual(["table_1", "sources_1"]);

		slowRead.resolve(jsonResponse(versionFour, { headers: { ETag: '"v4-late"' } }));
		await vi.advanceTimersByTimeAsync(0);
		// The canvas must not revert to the state before the accepted command.
		expect(session.view()?.state.version).toBe(5);
		expect(componentIds(session)).toEqual(["table_1", "sources_1"]);
		expect(session.view()?.workspace.version).toBe(5);

		// The discarded response's ETag was not adopted either: the next read is unconditional on it.
		const before = backend.requests.length;
		await vi.advanceTimersByTimeAsync(60_000);
		const laterWorkspaceReads = backend.requests
			.slice(before)
			.filter((request) => WORKSPACE_ROUTE.test(request.path));
		expect(laterWorkspaceReads.length).toBeGreaterThan(0);
		expect(laterWorkspaceReads.every((r) => r.headers["if-none-match"] !== '"v4-late"')).toBe(true);
		expect(session.view()?.state.version).toBe(5);
	});

	it("never installs a workspace view older than the one it already holds", async () => {
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		const versionFour = structuredClone(server.view);
		await session.dispatch({ operation: "component.focus", componentId: "table_1" });
		expect(session.view()?.state.version).toBe(5);

		// A fresh read (started after the command) is answered from a stale cache or replica.
		backend.on("GET", WORKSPACE_ROUTE, () =>
			jsonResponse(versionFour, { headers: { ETag: '"stale"' } }),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.view()?.state.version).toBe(5);
		expect(session.view()?.state.focusedComponentId).toBe("table_1");

		// A genuinely newer version is still accepted afterwards.
		server.view = { ...server.view, state: { ...server.view.state, version: 6 } };
		serveCurrentWorkspace();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(session.view()?.state.version).toBe(6);
	});

	it("does not let a late command response roll back a newer polled version", async () => {
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		const slowCommand = deferred<Response>();
		backend.on("POST", /\/commands$/, () => slowCommand.promise);
		const dispatched = session.dispatch({ operation: "component.focus", componentId: "news_1" });

		// While the command response is in transit, an agent publishes: the poll sees version 6.
		const acceptedAtFive = { ...server.view.state, version: 5, focusedComponentId: "news_1" };
		server.view = {
			...server.view,
			state: { ...server.view.state, version: 6, focusedComponentId: "sources_1" },
		};
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.view()?.state.version).toBe(6);

		slowCommand.resolve(jsonResponse({ state: acceptedAtFive, replayed: false }));
		await dispatched;
		expect(session.view()?.state.version).toBe(6);
		expect(session.view()?.state.focusedComponentId).toBe("sources_1");
		expect(session.commandPending()).toBe(false);
	});

	it("does not let a late run list or conversation replace what a submission just produced", async () => {
		const submitted = makeRun({
			runId: "run_new",
			state: "pending",
			createdAt: "2026-10-06T00:00:00Z",
			updatedAt: "2026-10-06T00:00:00Z",
		});
		backend.on("POST", /^\/api\/v1\/research-runs$/, () => {
			server.runs = [submitted, ...server.runs];
			return jsonResponse({ run: submitted }, { status: 202 });
		});
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.conversation()?.messages).toHaveLength(2);

		// The next poll's run list and conversation are slow and predate the submission.
		const slowRuns = deferred<Response>();
		const slowMessages = deferred<Response>();
		backend.on("GET", /research-runs\?workspaceId=ws_1$/, () => slowRuns.promise);
		backend.on("GET", /\/messages$/, () => slowMessages.promise);
		await vi.advanceTimersByTimeAsync(5_000);
		// Later reads never answer in this test, so nothing can paper over a wrongly applied stale one.
		const unanswered = deferred<Response>();
		backend.on("GET", /research-runs\?workspaceId=ws_1$/, () => unanswered.promise);
		backend.on("GET", /\/messages$/, () => unanswered.promise);

		const result = await session.submitRun(
			{
				workspaceId: WORKSPACE_ID,
				question: "A new question",
				agentId: "claude-code",
				model: null,
				effort: "medium",
				horizonYears: 5,
				markets: ["JP"],
				budget: DEFAULT_BUDGET,
				webAccess: "off",
			},
			"idem-session-test-1",
		);
		expect(result.ok).toBe(true);
		expect(session.runs().map((run) => run.runId)).toEqual(["run_new", "run_1"]);

		slowRuns.resolve(jsonResponse({ runs: [makeRun()] }));
		slowMessages.resolve(
			jsonResponse(
				{ ...CONVERSATION, messages: CONVERSATION.messages.slice(0, 1) },
				{ headers: { ETag: '"m0"' } },
			),
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.runs().map((run) => run.runId)).toEqual(["run_new", "run_1"]);
		expect(session.conversation()?.messages).toHaveLength(2);
	});

	it("does not let a late cancel response replace a newer snapshot of the same run", async () => {
		const collecting = makeRun({
			runId: "run_9",
			state: "collecting",
			verificationStatus: null,
			updatedAt: "2026-10-04T00:05:00Z",
		});
		server.runs = [collecting];
		let current = collecting;
		backend.on("GET", /^\/api\/v1\/research-runs\/run_9$/, () => jsonResponse({ run: current }));
		const slowCancel = deferred<Response>();
		backend.on("POST", /run_9\/cancel$/, () => slowCancel.promise);
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);

		const cancelling = session.cancelRun("run_9");
		// Before the cancel response arrives the runner finishes, and the poll sees it.
		current = makeRun({ runId: "run_9", state: "completed", updatedAt: "2026-10-04T00:09:00Z" });
		server.runs = [current];
		await vi.advanceTimersByTimeAsync(2_500);
		expect(session.runs()[0]?.state).toBe("completed");

		slowCancel.resolve(
			jsonResponse({
				run: { ...collecting, cancelRequested: true, updatedAt: "2026-10-04T00:06:00Z" },
			}),
		);
		await cancelling;
		expect(session.runs()[0]?.state).toBe("completed");
	});
});

describe("hidden tab", () => {
	it("defers the follow-up refresh when a run finishes while the tab is hidden", async () => {
		const first = makeRun({ runId: "run_9", state: "collecting", verificationStatus: null });
		const second = makeRun({
			runId: "run_10",
			state: "collecting",
			verificationStatus: null,
			createdAt: "2026-10-04T01:00:00Z",
		});
		server.runs = [second, first];
		const slowRun = deferred<Response>();
		backend.on("GET", /^\/api\/v1\/research-runs\/run_9$/, () => slowRun.promise);
		backend.on("GET", /^\/api\/v1\/research-runs\/run_10$/, () => jsonResponse({ run: second }));
		const visibility = manualVisibility(true);
		const session = startSession(visibility.source);
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2_500);

		// The poll is in flight when the owner switches tabs; then the run finishes.
		visibility.set(false);
		const finished = makeRun({ runId: "run_9", state: "completed" });
		server.runs = [second, finished];
		server.view = { ...server.view, state: { ...server.view.state, version: 5 } };
		const whenHidden = backend.requests.length;
		slowRun.resolve(jsonResponse({ run: finished }));
		await vi.advanceTimersByTimeAsync(600_000);

		// The answer that was already on its way is applied, but nothing new is requested.
		expect(paths(whenHidden)).toEqual([]);
		expect(session.runs().find((run) => run.runId === "run_9")?.state).toBe("completed");
		expect(session.view()?.state.version).toBe(4);

		// Back in the foreground: the deferred refresh happens, even though run_10 still executes.
		visibility.set(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(paths(whenHidden)).toEqual([
			"GET /api/v1/workspaces/ws_1",
			"GET /api/v1/workspaces/ws_1/messages",
			"GET /api/v1/research-runs?workspaceId=ws_1",
		]);
		expect(session.view()?.state.version).toBe(5);
	});
});

describe("history gaps and conversation failures (findings 6 and 7)", () => {
	const streamMessage = (seq: number) => ({
		messageId: `msg_${seq}`,
		seq,
		role: seq % 2 === 0 ? ("owner" as const) : ("assistant" as const),
		text: `Message ${seq}`,
		runId: null,
		claimIds: [] as string[],
		createdAt: "2026-10-04T00:00:00Z",
	});

	/** Serves newest-200 pages below `before` from a mutable `total`, like the server. */
	function serveStream(getTotal: () => number) {
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, (request) => {
			const url = new URL(request.path, "http://test");
			const beforeRaw = url.searchParams.get("before");
			const before = beforeRaw === null ? null : Number(beforeRaw);
			const all = Array.from({ length: getTotal() }, (_, seq) => streamMessage(seq));
			const eligible = before === null ? all : all.filter((message) => message.seq < before);
			const ordered = [...eligible].sort((a, b) => b.seq - a.seq);
			const hasEarlier = ordered.length > 200;
			const page = (hasEarlier ? ordered.slice(0, 200) : ordered).sort((a, b) => a.seq - b.seq);
			return jsonResponse({ messages: page, claims: [], evidence: [], hasEarlier });
		});
	}

	const seqs = (session: WorkspaceSession) =>
		(session.conversation()?.messages ?? []).map((message) => message.seq);

	it("fills a one-message gap by paging backwards from the new window", async () => {
		let total = 200;
		serveStream(() => total);
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(seqs(session)).toHaveLength(200);
		expect(session.hasEarlierMessages()).toBe(false);

		// Away while messages up to 400 arrive: the newest page is 201–400.
		total = 401;
		const before = backend.requests.length;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(seqs(session)).toHaveLength(401);
		expect(seqs(session)[0]).toBe(0);
		expect(seqs(session)[400]).toBe(400);
		expect(session.hasEarlierMessages()).toBe(false);
		// One newest page plus one gap page: bounded.
		expect(backend.requestsTo("GET", /messages/).length - before <= 2 + 1).toBe(true);
	});

	it("drops the older window with hasEarlier true when the gap exceeds the bound", async () => {
		let total = 200;
		serveStream(() => total);
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(seqs(session)).toHaveLength(200);

		total = 1001;
		const before = backend.requests.length;
		await vi.advanceTimersByTimeAsync(5_000);
		// Three gap pages (601–800, 401–600, 201–400) still do not meet 0–199:
		// the older window is dropped, but the history stays hole-free with a
		// control to load back.
		const held = seqs(session);
		expect(held).toHaveLength(800);
		expect(held[0]).toBe(201);
		expect(held[held.length - 1]).toBe(1000);
		expect(session.hasEarlierMessages()).toBe(true);
		expect(backend.requestsTo("GET", /messages/).length - before).toBeLessThanOrEqual(4);
	});

	it("records a failed first message fetch instead of loading forever", async () => {
		backend.on("GET", /\/messages$/, () => errorResponse(500, "INTERNAL", "database unavailable"));
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.conversation()).toBeNull();
		expect(session.conversationError()?.code).toBe("INTERNAL");
		expect(session.conversationError()?.message).toContain("database unavailable");
	});

	it("keeps messages and records the error when loading earlier fails", async () => {
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, (request) => {
			const url = new URL(request.path, "http://test");
			if (url.searchParams.get("before") === null) {
				return jsonResponse(
					{ ...CONVERSATION, hasEarlier: true },
					{ headers: { ETag: '"m-new"' } },
				);
			}
			return errorResponse(500, "INTERNAL", "database unavailable");
		});
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.conversation()?.messages).toHaveLength(2);
		expect(session.hasEarlierMessages()).toBe(true);

		await session.loadEarlierMessages();
		expect(session.conversation()?.messages).toHaveLength(2);
		expect(session.earlierError()?.code).toBe("INTERNAL");
		expect(session.loadingEarlier()).toBe(false);
	});
});

describe("earlier messages", () => {
	it("merges an earlier page without duplicates and survives a poll of the newest page", async () => {
		const newest = {
			...CONVERSATION,
			messages: [
				{ ...CONVERSATION.messages[1], messageId: "msg_2", seq: 1 },
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
			hasEarlier: true,
		};
		const earlier = {
			...CONVERSATION,
			messages: [
				{ ...CONVERSATION.messages[0], messageId: "msg_1", seq: 0 },
				// Intentional duplicate of the boundary message.
				{ ...CONVERSATION.messages[1], messageId: "msg_2", seq: 1 },
			],
			hasEarlier: false,
		};
		backend.on("GET", /^\/api\/v1\/workspaces\/ws_1\/messages.*$/, (request) => {
			const url = new URL(request.path, "http://test");
			return url.searchParams.get("before") === null
				? jsonResponse(newest, { headers: { ETag: '"m-new"' } })
				: jsonResponse(earlier);
		});
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.conversation()?.messages.map((message) => message.messageId)).toEqual([
			"msg_2",
			"msg_3",
		]);
		expect(session.hasEarlierMessages()).toBe(true);

		await session.loadEarlierMessages();
		expect(session.conversation()?.messages.map((message) => message.messageId)).toEqual([
			"msg_1",
			"msg_2",
			"msg_3",
		]);
		expect(session.hasEarlierMessages()).toBe(false);
		expect(session.loadingEarlier()).toBe(false);
		expect(backend.requestsTo("GET", /messages/).map((request) => request.path)).toContain(
			"/api/v1/workspaces/ws_1/messages?before=1",
		);

		// A poll fetches only the newest page: the earlier messages already loaded must survive it.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(session.conversation()?.messages.map((message) => message.messageId)).toEqual([
			"msg_1",
			"msg_2",
			"msg_3",
		]);
		expect(session.hasEarlierMessages()).toBe(false);
	});

	it("does nothing when no earlier page remains", async () => {
		const session = startSession(manualVisibility(true).source);
		await vi.advanceTimersByTimeAsync(0);
		expect(session.hasEarlierMessages()).toBe(false);
		const before = backend.requests.length;
		await session.loadEarlierMessages();
		expect(backend.requests).toHaveLength(before);
	});
});
