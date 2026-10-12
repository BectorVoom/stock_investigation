import type {
	AgentSettingsResponse,
	Conversation,
	ConversationSummary,
	ResearchRun,
	WorkspaceView,
} from "@research/contracts";
import { agentSettingsSchema } from "@research/contracts";
import { createBaselineUiRegistry } from "@research/ui-registry";
import { render } from "@solidjs/testing-library";
import { App } from "../src/App.tsx";
import { createApiClient } from "../src/api/client.ts";
import {
	ALWAYS_VISIBLE,
	errorResponse,
	type FakeBackend,
	jsonResponse,
	type RecordedRequest,
} from "./fakeBackend.ts";
import {
	AGENT_SETTINGS_RESPONSE,
	AGENTS,
	CONVERSATION,
	CONVERSATION_2,
	CONVERSATION_SUMMARIES,
	makeRun,
	WORKSPACE_SUMMARY,
	WORKSPACE_SUMMARY_2,
	WORKSPACE_VIEW,
	WORKSPACE_VIEW_2,
} from "./fixtures.ts";

type WorkspaceState = WorkspaceView["state"];

/** What the fake server currently stores; tests mutate it to simulate other writers. */
export interface ServerState {
	view: WorkspaceView;
	runs: ResearchRun[];
	conversations: ConversationSummary[];
	secondView: WorkspaceView;
	secondConversation: Conversation;
	secondRuns: ResearchRun[];
	agentSettings: AgentSettingsResponse;
}

export function initialServerState(): ServerState {
	return {
		view: structuredClone(WORKSPACE_VIEW),
		runs: [makeRun()],
		conversations: structuredClone([...CONVERSATION_SUMMARIES]),
		secondView: structuredClone(WORKSPACE_VIEW_2),
		secondConversation: structuredClone(CONVERSATION_2),
		secondRuns: [],
		agentSettings: structuredClone(AGENT_SETTINGS_RESPONSE),
	};
}

interface CommandBody {
	readonly operation: string;
	readonly expectedWorkspaceVersion: number;
	readonly componentId?: string;
	readonly itemKey?: string | null;
	readonly order?: string[];
	readonly columns?: 1 | 2;
}

function isCommandBody(body: unknown): body is CommandBody {
	return (
		typeof body === "object" &&
		body !== null &&
		"operation" in body &&
		typeof body.operation === "string" &&
		"expectedWorkspaceVersion" in body &&
		typeof body.expectedWorkspaceVersion === "number"
	);
}

/** A minimal stand-in for the server-side reducer: enough to answer owner commands. */
function applyCommand(state: WorkspaceState, command: CommandBody): WorkspaceState {
	const next: WorkspaceState = { ...state, version: state.version + 1 };
	const { componentId } = command;
	switch (command.operation) {
		case "component.remove":
			return {
				...next,
				components: state.components.filter((item) => item.componentId !== componentId),
				layout: { ...state.layout, order: state.layout.order.filter((id) => id !== componentId) },
				focusedComponentId:
					state.focusedComponentId === componentId ? null : state.focusedComponentId,
				// The contract requires focus and selection to point at existing components.
				selection: state.selection?.componentId === componentId ? null : state.selection,
			};
		case "component.focus":
			return { ...next, focusedComponentId: componentId ?? null };
		case "component.select":
			return {
				...next,
				selection:
					componentId === undefined || command.itemKey === null || command.itemKey === undefined
						? null
						: { componentId, itemKey: command.itemKey },
			};
		case "layout.update":
			return {
				...next,
				layout: { order: command.order ?? state.layout.order, columns: command.columns ?? 1 },
			};
		default:
			return next;
	}
}

function conversationsEtag(
	conversations: readonly {
		workspaceId: string;
		title: string;
		messageCount: number;
		lastActivityAt: string;
	}[],
): string {
	return `"c-${conversations.map((entry) => `${entry.workspaceId}:${entry.title}:${entry.messageCount}:${entry.lastActivityAt}`).join(",")}"`;
}

/** Slice messages like the server: newest `limit` below `before`, oldest dropped when overflowing. */
function pageConversation(
	full: Conversation,
	beforeRaw: string | null,
	limitRaw: string | null,
): Conversation {
	const limit = limitRaw === null ? 200 : Math.min(Math.max(Number(limitRaw) || 200, 1), 200);
	const before = beforeRaw === null ? null : Number(beforeRaw);
	const eligible =
		before === null || !Number.isFinite(before)
			? full.messages
			: full.messages.filter((message) => message.seq < before);
	const ordered = [...eligible].sort((a, b) => b.seq - a.seq);
	const hasEarlier = ordered.length > limit;
	const messages = (hasEarlier ? ordered.slice(0, limit) : ordered).sort((a, b) => a.seq - b.seq);
	return { ...full, messages, hasEarlier };
}

/** Registers the routes the chat and canvas views need, backed by the mutable `server` state. */
export function installWorkspaceRoutes(backend: FakeBackend, server: ServerState): void {
	const deletedWorkspaces = new Set<string>();
	const workspaceEtag = () => `"v${server.view.state.version}"`;
	backend.on("GET", /^\/api\/v1\/session$/, () =>
		jsonResponse({ ownerId: "owner-1", authMode: "local-dev", environment: "production" }),
	);
	backend.on("GET", /^\/api\/v1\/workspaces$/, () =>
		jsonResponse({ workspaces: [{ ...WORKSPACE_SUMMARY, version: server.view.state.version }] }),
	);
	backend.on("POST", /^\/api\/v1\/workspaces$/, (request) => {
		const body = request.body as { title?: unknown } | undefined;
		const raw = body !== undefined && typeof body.title === "string" ? body.title.trim() : null;
		const title = raw === null ? "New chat" : raw;
		if (title === "") return errorResponse(400, "VALIDATION_FAILED", "title is required");
		if (title.length > 300) return errorResponse(400, "VALIDATION_FAILED", "title is too long");
		deletedWorkspaces.delete("ws_new");
		const created = {
			...WORKSPACE_SUMMARY_2,
			workspaceId: "ws_new",
			title,
			createdAt: "2026-10-07T00:00:00Z",
			updatedAt: "2026-10-07T00:00:00Z",
		};
		server.conversations = [
			{
				workspaceId: created.workspaceId,
				title: created.title,
				messageCount: 0,
				lastMessageAt: null,
				lastMessageRole: null,
				lastMessagePreview: null,
				lastActivityAt: created.createdAt,
			},
			...server.conversations.filter((entry) => entry.workspaceId !== "ws_new"),
		];
		return jsonResponse(created, { status: 201 });
	});
	const runsFor = (id: string): ResearchRun[] => {
		if (id === "ws_1") return server.runs;
		if (id === "ws_2") return server.secondRuns;
		return [];
	};
	const isRunning = (state: string): boolean =>
		state === "pending" ||
		state === "claimed" ||
		state === "planning" ||
		state === "collecting" ||
		state === "analyzing" ||
		state === "verifying" ||
		state === "publishing" ||
		state === "waiting_approval";
	backend.on("PATCH", /^\/api\/v1\/workspaces\/([^/?]+)$/, (request, match) => {
		const id = match[1] ?? "";
		if (deletedWorkspaces.has(id)) return errorResponse(404, "NOT_FOUND", "no such workspace");
		const body = request.body as { title?: unknown } | undefined;
		const raw = typeof body?.title === "string" ? body.title.trim() : "";
		if (raw === "" || raw.length > 300)
			return errorResponse(400, "VALIDATION_FAILED", "title is required");
		const index = server.conversations.findIndex((entry) => entry.workspaceId === id);
		if (index < 0) return errorResponse(404, "NOT_FOUND", "no such workspace");
		const existing = server.conversations[index];
		if (existing === undefined) return errorResponse(404, "NOT_FOUND", "no such workspace");
		const updated = { ...existing, title: raw };
		server.conversations = [
			...server.conversations.slice(0, index),
			updated,
			...server.conversations.slice(index + 1),
		];
		if (id === "ws_1") {
			server.view = {
				...server.view,
				workspace: { ...server.view.workspace, title: raw, updatedAt: "2026-10-07T00:00:00Z" },
			};
		}
		if (id === "ws_2") {
			server.secondView = {
				...server.secondView,
				workspace: {
					...server.secondView.workspace,
					title: raw,
					updatedAt: "2026-10-07T00:00:00Z",
				},
			};
		}
		const summary = {
			workspaceId: id,
			title: raw,
			version: id === "ws_1" ? server.view.state.version : 1,
			createdAt: existing.lastActivityAt,
			updatedAt: "2026-10-07T00:00:00Z",
		};
		return jsonResponse(summary);
	});
	backend.on("DELETE", /^\/api\/v1\/workspaces\/([^/?]+)$/, (_request, match) => {
		const id = match[1] ?? "";
		if (deletedWorkspaces.has(id)) return errorResponse(404, "NOT_FOUND", "no such workspace");
		const exists = server.conversations.some((entry) => entry.workspaceId === id);
		if (!exists) return errorResponse(404, "NOT_FOUND", "no such workspace");
		if (runsFor(id).some((run) => isRunning(run.state))) {
			return errorResponse(409, "CONFLICT", "A question is still running in this chat.");
		}
		deletedWorkspaces.add(id);
		server.conversations = server.conversations.filter((entry) => entry.workspaceId !== id);
		return new Response(null, { status: 204 });
	});
	backend.on("GET", /^\/api\/v1\/conversations$/, (request) => {
		const etag = conversationsEtag(server.conversations);
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse({ conversations: server.conversations }, { headers: { ETag: etag } });
	});
	const workspaceViewFor = (id: string): WorkspaceView | null => {
		if (deletedWorkspaces.has(id)) return null;
		if (id === "ws_1") return server.view;
		if (id === "ws_2") return server.secondView;
		if (id === "ws_new") {
			const summary = server.conversations.find((entry) => entry.workspaceId === "ws_new");
			if (summary === undefined) return null;
			return {
				...server.secondView,
				workspace: {
					workspaceId: "ws_new",
					title: summary.title,
					version: 0,
					createdAt: summary.lastActivityAt,
					updatedAt: summary.lastActivityAt,
				},
				state: { ...server.secondView.state, workspaceId: "ws_new", version: 0 },
			};
		}
		return null;
	};
	backend.on("GET", /^\/api\/v1\/workspaces\/([^/?]+)$/, (request, match) => {
		const id = match[1] ?? "";
		if (deletedWorkspaces.has(id)) return errorResponse(404, "NOT_FOUND", "no such workspace");
		if (id === "ws_1") {
			return request.headers["if-none-match"] === workspaceEtag()
				? new Response(null, { status: 304 })
				: jsonResponse(server.view, { headers: { ETag: workspaceEtag() } });
		}
		const found = workspaceViewFor(id);
		if (found === null) return errorResponse(404, "NOT_FOUND", "no such workspace");
		return jsonResponse(found);
	});
	const conversationFor = (id: string): Conversation | null => {
		if (deletedWorkspaces.has(id)) return null;
		if (id === "ws_1") return CONVERSATION;
		if (id === "ws_2") return server.secondConversation;
		if (id === "ws_new")
			return {
				messages: [],
				claims: [],
				evidence: [],
				hasEarlier: false,
			};
		return null;
	};
	backend.on("GET", /^\/api\/v1\/workspaces\/([^/?]+)\/messages.*$/, (request, match) => {
		const id = match[1] ?? "";
		const full = conversationFor(id);
		if (full === null) return errorResponse(404, "NOT_FOUND", "no such workspace");
		const url = new URL(request.path, "http://test");
		const page = pageConversation(
			full,
			url.searchParams.get("before"),
			url.searchParams.get("limit"),
		);
		// The first page keeps the historic ETag so long-running poll tests still match.
		const etag =
			id === "ws_1" &&
			url.searchParams.get("before") === null &&
			url.searchParams.get("limit") === null
				? '"m1"'
				: `"m-${id}-${url.searchParams.get("before") ?? "all"}-${page.messages.length}-${page.hasEarlier}"`;
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(page, { headers: { ETag: etag } });
	});
	backend.on("GET", /^\/api\/v1\/research-runs\?workspaceId=ws_1$/, () =>
		jsonResponse({ runs: server.runs }),
	);
	backend.on("GET", /^\/api\/v1\/research-runs\?workspaceId=ws_2$/, () =>
		jsonResponse({ runs: server.secondRuns }),
	);
	backend.on("GET", /^\/api\/v1\/research-runs\?workspaceId=ws_new$/, () =>
		jsonResponse({ runs: [] }),
	);
	backend.on("GET", /^\/api\/v1\/agents$/, () => jsonResponse(AGENTS));
	backend.on("GET", /^\/api\/v1\/settings\/agent$/, () => jsonResponse(server.agentSettings));
	backend.on("PUT", /^\/api\/v1\/settings\/agent$/, (request) => {
		const parsed = agentSettingsSchema.safeParse(request.body);
		if (!parsed.success) return errorResponse(400, "VALIDATION_FAILED", "invalid agent settings");
		server.agentSettings = {
			settings: parsed.data,
			updatedAt: "2026-10-06T00:00:00Z",
			origin: "saved",
		};
		return jsonResponse(server.agentSettings);
	});
	backend.on("POST", /^\/api\/v1\/workspaces\/ws_1\/commands$/, (request) => {
		if (!isCommandBody(request.body)) {
			return errorResponse(400, "VALIDATION_FAILED", "not a command");
		}
		if (request.body.expectedWorkspaceVersion !== server.view.state.version) {
			return errorResponse(
				409,
				"VERSION_CONFLICT",
				`workspace is at version ${server.view.state.version}`,
			);
		}
		const state = applyCommand(server.view.state, request.body);
		server.view = { ...server.view, state };
		return jsonResponse({ state, replayed: false });
	});
}

export function mountApp(backend: FakeBackend) {
	const api = createApiClient({ fetch: backend.fetch });
	return render(() => (
		<App
			api={api}
			registry={createBaselineUiRegistry()}
			visibility={ALWAYS_VISIBLE}
			window={window}
		/>
	));
}

export function commandRequests(backend: FakeBackend): RecordedRequest[] {
	return backend.requestsTo("POST", /\/commands$/);
}
