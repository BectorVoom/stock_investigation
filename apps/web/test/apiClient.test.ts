import {
	agentSettingsResponseSchema,
	agentSettingsSchema,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	DEFAULT_AGENT_SETTINGS,
	idempotencyKeySchema,
	type ResearchRequest,
} from "@research/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api/client.ts";
import type { FetchLike } from "../src/api/http.ts";
import { createFakeBackend, errorResponse, jsonResponse } from "./fakeBackend.ts";
import {
	CONVERSATION,
	DEFAULT_BUDGET,
	makeRun,
	WORKSPACE_ID,
	WORKSPACE_SUMMARY,
	WORKSPACE_VIEW,
} from "./fixtures.ts";

afterEach(() => {
	vi.useRealTimers();
});

const CSRF = CSRF_HEADER.toLowerCase();
const RESEARCH_REQUEST: ResearchRequest = {
	workspaceId: WORKSPACE_ID,
	question: "Where will storage demand grow?",
	agentId: "claude-code",
	model: null,
	effort: "medium",
	horizonYears: 5,
	markets: ["JP"],
	budget: DEFAULT_BUDGET,
	webAccess: "off",
};

type Api = ReturnType<typeof createApiClient>;

/** Headers have arrived, but reading the body never completes. */
class StalledResponse extends Response {
	constructor(status: number, headers: Record<string, string> = {}) {
		super(null, { status, headers });
	}
	override json(): Promise<never> {
		return new Promise(() => {});
	}
	override text(): Promise<never> {
		return new Promise(() => {});
	}
}

/** The connection drops while the body is being read. */
class BrokenBodyResponse extends Response {
	constructor(status: number, headers: Record<string, string> = {}) {
		super(null, { status, headers });
	}
	override text(): Promise<never> {
		return Promise.reject(new TypeError("network connection lost"));
	}
}

function setup() {
	const backend = createFakeBackend();
	let counter = 0;
	const api = createApiClient({
		fetch: backend.fetch,
		randomUuid: () => {
			counter += 1;
			return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
		},
	});
	return { backend, api };
}

describe("response validation", () => {
	it("returns the parsed value for a response that matches the contract", async () => {
		const { backend, api } = setup();
		backend.on("GET", /^\/api\/v1\/workspaces$/, () =>
			jsonResponse({ workspaces: [WORKSPACE_SUMMARY] }),
		);
		const result = await api.listWorkspaces();
		expect(result).toEqual({ ok: true, value: [WORKSPACE_SUMMARY] });
	});

	it("maps a response that violates the schema to INVALID_RESPONSE instead of throwing", async () => {
		const { backend, api } = setup();
		backend.on("GET", /^\/api\/v1\/workspaces$/, () =>
			jsonResponse({ workspaces: [{ ...WORKSPACE_SUMMARY, version: "four", surprise: true }] }),
		);
		const result = await api.listWorkspaces();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("invalid-response");
		expect(result.error.code).toBe("INVALID_RESPONSE");
		expect(result.error.status).toBe(200);
		expect(result.error.issues.some((issue) => issue.startsWith("workspaces.0.version:"))).toBe(
			true,
		);
	});

	it("maps a 200 that is not JSON to INVALID_RESPONSE", async () => {
		const { backend, api } = setup();
		backend.on("GET", /session$/, () => new Response("<html>login</html>", { status: 200 }));
		const result = await api.getSession();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_RESPONSE");
		expect(result.error.message).toBe("The server response is not valid JSON.");
	});

	it("rejects extra fields the contract does not allow (strict objects)", async () => {
		const { backend, api } = setup();
		backend.on("GET", /session$/, () =>
			jsonResponse({
				ownerId: "owner",
				authMode: "local-dev",
				environment: "production",
				apiKey: "leak",
			}),
		);
		const result = await api.getSession();
		expect(result.ok).toBe(false);
	});
});

describe("error mapping", () => {
	it("carries the API error code, status, message and detail", async () => {
		const { backend, api } = setup();
		backend.on("POST", /commands$/, () =>
			errorResponse(409, "VERSION_CONFLICT", "workspace is at version 7", "expected 4"),
		);
		const result = await api.submitCommand({
			protocolVersion: 1,
			commandId: "cmd-1",
			workspaceId: WORKSPACE_ID,
			expectedWorkspaceVersion: 4,
			operation: "component.remove",
			componentId: "news_1",
		});
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "api",
				code: "VERSION_CONFLICT",
				status: 409,
				message: "workspace is at version 7",
				detail: "expected 4",
				issues: [],
			},
		});
	});

	it("maps an error status without a recognisable body to UNEXPECTED_STATUS", async () => {
		const { backend, api } = setup();
		backend.on("GET", /agents$/, () => new Response("Bad gateway", { status: 502 }));
		const result = await api.listAgents();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("invalid-response");
		expect(result.error.code).toBe("UNEXPECTED_STATUS");
		expect(result.error.status).toBe(502);
	});

	it("does not trust an error body with an unknown code", async () => {
		const { backend, api } = setup();
		backend.on("GET", /agents$/, () =>
			jsonResponse({ error: { code: "MADE_UP", message: "x" } }, { status: 400 }),
		);
		const result = await api.listAgents();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("UNEXPECTED_STATUS");
	});

	it("maps a rejected fetch to NETWORK_ERROR", async () => {
		const failingFetch: FetchLike = () => Promise.reject(new TypeError("Failed to fetch"));
		const api = createApiClient({ fetch: failingFetch });
		const result = await api.listSources();
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("network");
		expect(result.error.code).toBe("NETWORK_ERROR");
		expect(result.error.status).toBeNull();
		expect(result.error.message).toContain("Failed to fetch");
	});

	it("aborts a request that exceeds the timeout and reports TIMEOUT", async () => {
		vi.useFakeTimers();
		const hangingFetch: FetchLike = (_input, init) =>
			new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () =>
					reject(new DOMException("aborted", "AbortError")),
				);
			});
		const api = createApiClient({ fetch: hangingFetch, timeoutMs: 5_000 });
		const pending = api.listSources();
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TIMEOUT");
		expect(result.error.message).toBe("The server did not answer within 5 s.");
	});

	it("keeps the timeout armed while the body is read: a stalled body is a TIMEOUT, not a hang", async () => {
		vi.useFakeTimers();
		let aborted = false;
		const stalledFetch: FetchLike = async (_input, init) => {
			init.signal?.addEventListener("abort", () => {
				aborted = true;
			});
			// Headers arrive at once; the body never does.
			return new StalledResponse(200);
		};
		const api = createApiClient({ fetch: stalledFetch, timeoutMs: 5_000 });
		const settled = vi.fn();
		const pending = api.listWorkspaces().then((result) => {
			settled(result);
			return result;
		});

		await vi.advanceTimersByTimeAsync(4_999);
		expect(settled).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		const result = await pending;
		expect(result).toEqual({
			ok: false,
			error: {
				kind: "network",
				code: "TIMEOUT",
				status: null,
				message: "The server did not answer within 5 s.",
				detail: null,
				issues: [],
			},
		});
		expect(aborted).toBe(true);
	});

	it.each([
		["an error body", () => new StalledResponse(500), (api: Api) => api.listAgents()],
		[
			"a conditional GET body",
			() => new StalledResponse(200),
			(api: Api) => api.getWorkspace("ws_1", '"v1"'),
		],
		[
			"a Markdown export body",
			() => new StalledResponse(200, { "Content-Type": "text/markdown" }),
			(api: Api) => api.exportWorkspaceMarkdown("ws_1"),
		],
	])("times out when %s stalls", async (_name, respond, call) => {
		vi.useFakeTimers();
		const api = createApiClient({ fetch: async () => respond(), timeoutMs: 2_000 });
		const pending = call(api);
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("TIMEOUT");
	});

	it("clears the timer once a response has been fully read", async () => {
		vi.useFakeTimers();
		const { backend, api } = setup();
		backend.on("GET", /session$/, () =>
			jsonResponse({ ownerId: "owner", authMode: "local-dev", environment: "production" }),
		);
		const result = await api.getSession();
		expect(result.ok).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a body that fails while being read as a network error", async () => {
		const api = createApiClient({
			fetch: async () => new BrokenBodyResponse(200, { "Content-Type": "text/markdown" }),
		});
		const result = await api.exportWorkspaceMarkdown("ws_1");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("NETWORK_ERROR");
	});

	it("treats a 304 as an error when no ETag was sent", async () => {
		const { backend, api } = setup();
		backend.on("GET", /agents$/, () => new Response(null, { status: 304 }));
		const result = await api.listAgents();
		expect(result.ok).toBe(false);
	});
});

describe("request validation", () => {
	it("does not send a request that violates the request schema", async () => {
		const { backend, api } = setup();
		const result = await api.createWorkspace("   ");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("invalid-request");
		expect(result.error.code).toBe("INVALID_REQUEST");
		expect(backend.requests).toHaveLength(0);
	});

	it("validates an import file locally and reports where it is wrong", async () => {
		const { backend, api } = setup();
		const result = await api.importWorkspace({ format: "something-else", formatVersion: 99 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_REQUEST");
		expect(result.error.issues.some((issue) => issue.startsWith("format:"))).toBe(true);
		expect(backend.requests).toHaveLength(0);
	});
});

describe("workspaces: create, rename and delete", () => {
	it("creates an untitled workspace with no title in the body", async () => {
		const { backend, api } = setup();
		backend.on("POST", /workspaces$/, () => jsonResponse(WORKSPACE_SUMMARY, { status: 201 }));
		const result = await api.createWorkspace();
		expect(result).toEqual({ ok: true, value: WORKSPACE_SUMMARY });
		expect(backend.requests[0]?.body).toEqual({});
		expect(backend.requests[0]?.headers[CSRF]).toBe(CSRF_HEADER_VALUE);
	});

	it("renames with PATCH and the contract shape", async () => {
		const { backend, api } = setup();
		const renamed = { ...WORKSPACE_SUMMARY, title: "Renamed" };
		backend.on("PATCH", /workspaces\/ws_1$/, () => jsonResponse(renamed));
		const result = await api.renameWorkspace(WORKSPACE_ID, "Renamed");
		expect(result).toEqual({ ok: true, value: renamed });
		expect(backend.requests[0]?.method).toBe("PATCH");
		expect(backend.requests[0]?.path).toBe("/api/v1/workspaces/ws_1");
		expect(backend.requests[0]?.body).toEqual({ title: "Renamed" });
		expect(backend.requests[0]?.headers[CSRF]).toBe(CSRF_HEADER_VALUE);
	});

	it("validates a rename locally and sends nothing invalid", async () => {
		const { backend, api } = setup();
		const result = await api.renameWorkspace(WORKSPACE_ID, "   ");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_REQUEST");
		expect(backend.requests).toHaveLength(0);
	});

	it("deletes with DELETE and returns null on 204", async () => {
		const { backend, api } = setup();
		backend.on("DELETE", /workspaces\/ws_1$/, () => new Response(null, { status: 204 }));
		const result = await api.deleteWorkspace(WORKSPACE_ID);
		expect(result).toEqual({ ok: true, value: null });
		expect(backend.requests[0]?.method).toBe("DELETE");
		expect(backend.requests[0]?.path).toBe("/api/v1/workspaces/ws_1");
		expect(backend.requests[0]?.headers[CSRF]).toBe(CSRF_HEADER_VALUE);
	});

	it("carries a 409 from delete as an api failure", async () => {
		const { backend, api } = setup();
		backend.on("DELETE", /workspaces\/ws_1$/, () =>
			errorResponse(409, "CONFLICT", "A question is still running in this chat."),
		);
		const result = await api.deleteWorkspace(WORKSPACE_ID);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("CONFLICT");
		expect(result.error.status).toBe(409);
	});
});

describe("write protection headers", () => {
	it("sends the CSRF header, JSON content type and same-origin credentials on every write", async () => {
		const { backend, api } = setup();
		backend.on("POST", /workspaces$/, () => jsonResponse(WORKSPACE_SUMMARY, { status: 201 }));
		backend.on("PATCH", /sources\/src_1$/, () => errorResponse(404, "NOT_FOUND", "no such source"));
		backend.on("DELETE", /sources\/src_1$/, () => new Response(null, { status: 204 }));
		backend.on("POST", /cancel$/, () => jsonResponse({ run: makeRun({ state: "cancelled" }) }));

		await api.createWorkspace("New workspace");
		await api.updateSource("src_1", { feedStatus: "paused" });
		const deleted = await api.deleteSource("src_1");
		await api.cancelResearchRun("run_1");

		expect(deleted).toEqual({ ok: true, value: null });
		expect(backend.requests.map((request) => request.method)).toEqual([
			"POST",
			"PATCH",
			"DELETE",
			"POST",
		]);
		for (const request of backend.requests) {
			expect(request.headers[CSRF]).toBe(CSRF_HEADER_VALUE);
			expect(request.headers["content-type"]).toBe("application/json");
			expect(request.credentials).toBe("same-origin");
		}
		expect(backend.requests[0]?.body).toEqual({ title: "New workspace" });
		expect(backend.requests[1]?.body).toEqual({ feedStatus: "paused" });
	});

	it("sends no CSRF header on reads", async () => {
		const { backend, api } = setup();
		backend.on("GET", /session$/, () =>
			jsonResponse({ ownerId: "owner", authMode: "local-dev", environment: "production" }),
		);
		await api.getSession();
		expect(backend.requests[0]?.headers[CSRF]).toBeUndefined();
		expect(backend.requests[0]?.credentials).toBe("same-origin");
	});
});

describe("idempotency keys", () => {
	it("generates distinct keys that satisfy the contract's key format", () => {
		const api = createApiClient({ fetch: createFakeBackend().fetch });
		const first = api.newIdempotencyKey();
		const second = api.newIdempotencyKey();
		expect(idempotencyKeySchema.safeParse(first).success).toBe(true);
		expect(idempotencyKeySchema.safeParse(second).success).toBe(true);
		expect(first).not.toBe(second);
		expect(first).toMatch(/^idem-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
	});

	it("sends the Idempotency-Key header when creating, retrying and refreshing", async () => {
		const { backend, api } = setup();
		const run = makeRun({ state: "pending" });
		backend.on("POST", /research-runs$/, () => jsonResponse({ run }, { status: 202 }));
		backend.on("POST", /retry$/, () => jsonResponse({ run }, { status: 202 }));
		backend.on("POST", /sources\/refresh$/, () =>
			jsonResponse(
				{ run: makeRun({ kind: "news-ingest", request: null, workspaceId: null }) },
				{ status: 202 },
			),
		);

		const created = await api.createResearchRun(RESEARCH_REQUEST, "idem-create-0001");
		await api.retryResearchRun("run_1", "idem-retry-0001");
		await api.refreshSources("idem-refresh-0001");

		expect(created).toEqual({ ok: true, value: run });
		expect(backend.requests.map((request) => request.headers["idempotency-key"])).toEqual([
			"idem-create-0001",
			"idem-retry-0001",
			"idem-refresh-0001",
		]);
		expect(backend.requests[0]?.body).toEqual(RESEARCH_REQUEST);
		expect(backend.requests[1]?.path).toBe("/api/v1/research-runs/run_1/retry");
	});

	it("refuses a malformed idempotency key before any request is made", async () => {
		const { backend, api } = setup();
		const result = await api.createResearchRun(RESEARCH_REQUEST, "short");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_REQUEST");
		expect(backend.requests).toHaveLength(0);
	});

	it("does not attach an idempotency key to requests that have none", async () => {
		const { backend, api } = setup();
		backend.on("POST", /cancel$/, () => jsonResponse({ run: makeRun({ state: "cancelled" }) }));
		await api.cancelResearchRun("run_1");
		expect(backend.requests[0]?.headers["idempotency-key"]).toBeUndefined();
	});
});

describe("conditional GET (ETag)", () => {
	it("returns the value and its ETag on 200, and sends no If-None-Match the first time", async () => {
		const { backend, api } = setup();
		backend.on("GET", /workspaces\/ws_1$/, () =>
			jsonResponse(WORKSPACE_VIEW, { headers: { ETag: '"v4"' } }),
		);
		const result = await api.getWorkspace(WORKSPACE_ID);
		expect(result).toEqual({
			ok: true,
			value: { changed: true, value: WORKSPACE_VIEW, etag: '"v4"' },
		});
		expect(backend.requests[0]?.headers["if-none-match"]).toBeUndefined();
	});

	it("sends If-None-Match and treats 304 as unchanged", async () => {
		const { backend, api } = setup();
		backend.on("GET", /workspaces\/ws_1$/, () => new Response(null, { status: 304 }));
		backend.on("GET", /messages$/, () => new Response(null, { status: 304 }));
		backend.on("GET", /research-runs\/run_1$/, () => new Response(null, { status: 304 }));

		const workspace = await api.getWorkspace(WORKSPACE_ID, '"v4"');
		const conversation = await api.getConversation(WORKSPACE_ID, '"m9"');
		const run = await api.getResearchRun("run_1", '"r2"');

		expect(workspace).toEqual({ ok: true, value: { changed: false } });
		expect(conversation).toEqual({ ok: true, value: { changed: false } });
		expect(run).toEqual({ ok: true, value: { changed: false } });
		expect(backend.requests.map((request) => request.headers["if-none-match"])).toEqual([
			'"v4"',
			'"m9"',
			'"r2"',
		]);
	});

	it("unwraps a fresh run and conversation", async () => {
		const { backend, api } = setup();
		const run = makeRun();
		backend.on("GET", /research-runs\/run_1$/, () =>
			jsonResponse({ run }, { headers: { ETag: '"r3"' } }),
		);
		backend.on("GET", /messages$/, () => jsonResponse(CONVERSATION));
		expect(await api.getResearchRun("run_1", '"r2"')).toEqual({
			ok: true,
			value: { changed: true, value: run, etag: '"r3"' },
		});
		expect(await api.getConversation(WORKSPACE_ID)).toEqual({
			ok: true,
			value: { changed: true, value: CONVERSATION, etag: null },
		});
	});

	it("lists conversations conditionally, like workspaces", async () => {
		const { backend, api } = setup();
		backend.on("GET", /conversations$/, () =>
			jsonResponse(
				{
					conversations: [
						{
							workspaceId: WORKSPACE_ID,
							title: "Grid storage research",
							messageCount: 2,
							lastMessageAt: "2026-10-04T00:10:00Z",
							lastMessageRole: "assistant",
							lastMessagePreview: "Utility tenders are rising.",
							lastActivityAt: "2026-10-04T00:10:00Z",
						},
					],
				},
				{ headers: { ETag: '"c1"' } },
			),
		);
		const first = await api.listConversations();
		expect(first).toEqual({
			ok: true,
			value: {
				changed: true,
				value: [
					{
						workspaceId: WORKSPACE_ID,
						title: "Grid storage research",
						messageCount: 2,
						lastMessageAt: "2026-10-04T00:10:00Z",
						lastMessageRole: "assistant",
						lastMessagePreview: "Utility tenders are rising.",
						lastActivityAt: "2026-10-04T00:10:00Z",
					},
				],
				etag: '"c1"',
			},
		});
		expect(backend.requests[0]?.headers["if-none-match"]).toBeUndefined();

		backend.on("GET", /conversations$/, () => new Response(null, { status: 304 }));
		const second = await api.listConversations('"c1"');
		expect(second).toEqual({ ok: true, value: { changed: false } });
		expect(backend.requests[1]?.headers["if-none-match"]).toBe('"c1"');
	});

	it("adds before and limit query parameters when paging a conversation", async () => {
		const { backend, api } = setup();
		backend.on("GET", /messages/, () => jsonResponse(CONVERSATION));
		await api.getConversation(WORKSPACE_ID, null, { before: 5 });
		await api.getConversation(WORKSPACE_ID, '"m1"', { before: 5, limit: 50 });
		await api.getConversation(WORKSPACE_ID);
		expect(backend.requests.map((request) => request.path)).toEqual([
			"/api/v1/workspaces/ws_1/messages?before=5",
			"/api/v1/workspaces/ws_1/messages?before=5&limit=50",
			"/api/v1/workspaces/ws_1/messages",
		]);
		expect(backend.requests[1]?.headers["if-none-match"]).toBe('"m1"');
	});
});

describe("paths and formats", () => {
	it("encodes ids and query parameters", async () => {
		const { backend, api } = setup();
		backend.on("GET", /./, () => jsonResponse({ articles: [], nextCursor: null }));
		await api.listArticles({ sourceId: "src:1", cursor: "a b&c" });
		await api.listArticles();
		expect(backend.requests.map((request) => request.path)).toEqual([
			"/api/v1/articles?sourceId=src%3A1&cursor=a+b%26c",
			"/api/v1/articles",
		]);
	});

	it("requests the run list for one workspace and the events after a version", async () => {
		const { backend, api } = setup();
		backend.on("GET", /research-runs\?/, () => jsonResponse({ runs: [] }));
		backend.on("GET", /events\?/, () => jsonResponse({ events: [], currentVersion: 4 }));
		await api.listResearchRuns(WORKSPACE_ID);
		await api.getWorkspaceEvents(WORKSPACE_ID, 3);
		expect(backend.requests.map((request) => request.path)).toEqual([
			"/api/v1/research-runs?workspaceId=ws_1",
			"/api/v1/workspaces/ws_1/events?after=3",
		]);
	});

	it("returns a Markdown export as text and rejects another content type", async () => {
		const { backend, api } = setup();
		backend.on(
			"GET",
			/export\?format=markdown$/,
			() =>
				new Response("# Export\n", { headers: { "Content-Type": "text/markdown; charset=utf-8" } }),
		);
		expect(await api.exportWorkspaceMarkdown(WORKSPACE_ID)).toEqual({
			ok: true,
			value: "# Export\n",
		});

		backend.on("GET", /export\?format=markdown$/, () => jsonResponse({ not: "markdown" }));
		const wrong = await api.exportWorkspaceMarkdown(WORKSPACE_ID);
		expect(wrong.ok).toBe(false);
		if (wrong.ok) return;
		expect(wrong.error.code).toBe("INVALID_RESPONSE");
	});

	it("returns the one-time runner token from the issue response", async () => {
		const { backend, api } = setup();
		const credential = {
			credentialId: "cred_1",
			label: "Desk PC",
			createdAt: "2026-10-05T00:00:00Z",
			expiresAt: "2026-11-04T00:00:00Z",
			revokedAt: null,
			lastUsedAt: null,
		};
		backend.on("POST", /runner-credentials$/, () =>
			jsonResponse({ credential, token: "t".repeat(48) }, { status: 201 }),
		);
		const result = await api.issueRunnerCredential({ label: "Desk PC", expiresInDays: 30 });
		expect(result).toEqual({ ok: true, value: { credential, token: "t".repeat(48) } });
	});
});

describe("agent settings", () => {
	const SAVED = agentSettingsSchema.parse({
		defaultAgentId: "opencode",
		models: { opencode: "provider/model" },
		effort: "high",
		budget: {
			maxAgentSteps: 6,
			maxToolCalls: 20,
			maxWallClockMs: 600_000,
			maxInputBytes: 400_000,
			maxSpendUsd: 2,
		},
		webAccess: "off",
	});

	it("gets the saved settings with their timestamp", async () => {
		const { backend, api } = setup();
		backend.on("GET", /settings\/agent$/, () =>
			jsonResponse({ settings: SAVED, updatedAt: "2026-10-06T00:00:00Z", origin: "saved" }),
		);
		const result = await api.getAgentSettings();
		expect(result).toEqual({
			ok: true,
			value: { settings: SAVED, updatedAt: "2026-10-06T00:00:00Z", origin: "saved" },
		});
	});

	it("gets the defaults with a null timestamp before any save", async () => {
		const { backend, api } = setup();
		backend.on("GET", /settings\/agent$/, () =>
			jsonResponse({ settings: DEFAULT_AGENT_SETTINGS, updatedAt: null, origin: "defaults" }),
		);
		const result = await api.getAgentSettings();
		expect(result).toEqual({
			ok: true,
			value: { settings: DEFAULT_AGENT_SETTINGS, updatedAt: null, origin: "defaults" },
		});
	});

	it("saves with PUT, sending the CSRF header and the contract shape", async () => {
		const { backend, api } = setup();
		backend.on("PUT", /settings\/agent$/, () =>
			jsonResponse({ settings: SAVED, updatedAt: "2026-10-06T00:00:00Z", origin: "saved" }),
		);
		const result = await api.saveAgentSettings(SAVED);
		expect(result).toEqual({
			ok: true,
			value: agentSettingsResponseSchema.parse({
				settings: SAVED,
				updatedAt: "2026-10-06T00:00:00Z",
				origin: "saved",
			}),
		});
		expect(backend.requests[0]?.method).toBe("PUT");
		expect(backend.requests[0]?.path).toBe("/api/v1/settings/agent");
		expect(backend.requests[0]?.body).toEqual(SAVED);
		expect(backend.requests[0]?.headers[CSRF]).toBe(CSRF_HEADER_VALUE);
	});

	it("validates the settings locally and sends nothing invalid", async () => {
		const { backend, api } = setup();
		const result = await api.saveAgentSettings({
			...SAVED,
			budget: { ...SAVED.budget, maxAgentSteps: 99 },
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_REQUEST");
		expect(backend.requests).toHaveLength(0);
	});
});
