import type {
	AgentSettingsResponse,
	Conversation,
	ConversationSummary,
	HomeDashboard,
	MarketCatalogEntry,
	MarketSeries,
	NotebookResponse,
	ResearchRun,
	WatchlistResponse,
	WorkspaceView,
} from "@research/contracts";
import { agentSettingsSchema, DEFAULT_HOME_DASHBOARD } from "@research/contracts";
import { createBaselineUiRegistry } from "@research/ui-registry";
import { render } from "@solidjs/testing-library";
import { App } from "../src/App.tsx";
import { createApiClient } from "../src/api/client.ts";
import type { VisibilitySource } from "../src/lib/polling.ts";
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
	notebook: NotebookResponse;
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
		notebook: {
			workspaceId: "ws_1",
			notebook: { widgets: [] },
			version: 0,
			updatedAt: null,
			undoAvailable: false,
			turns: [],
		},
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
	/* ----- notebook of one conversation (ADR-0020): compare-and-set save, undo, assist ----- */
	backend.on("GET", /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/, (_request, match) => {
		const id = match[1] ?? "";
		if (deletedWorkspaces.has(id)) return errorResponse(404, "NOT_FOUND", "no such workspace");
		return jsonResponse({ ...server.notebook, workspaceId: id });
	});
	backend.on("PUT", /^\/api\/v1\/workspaces\/([^/?]+)\/notebook$/, (request, match) => {
		const id = match[1] ?? "";
		if (deletedWorkspaces.has(id)) return errorResponse(404, "NOT_FOUND", "no such workspace");
		const body = request.body as { notebook?: unknown; expectedVersion?: unknown } | undefined;
		if (
			typeof body?.notebook !== "object" ||
			body.notebook === null ||
			body.expectedVersion !== server.notebook.version
		) {
			if (body?.expectedVersion !== server.notebook.version) {
				return errorResponse(409, "VERSION_CONFLICT", "The notebook changed elsewhere.");
			}
			return errorResponse(400, "VALIDATION_FAILED", "notebook is required");
		}
		server.notebook = {
			workspaceId: id,
			notebook: body.notebook as NotebookResponse["notebook"],
			version: server.notebook.version + 1,
			updatedAt: "2026-10-07T00:00:00Z",
			undoAvailable: true,
			turns: server.notebook.turns,
		};
		return jsonResponse(server.notebook);
	});
	backend.on("POST", /^\/api\/v1\/workspaces\/([^/?]+)\/notebook\/undo$/, (_request, match) => {
		const id = match[1] ?? "";
		if (deletedWorkspaces.has(id)) return errorResponse(404, "NOT_FOUND", "no such workspace");
		server.notebook = {
			...server.notebook,
			workspaceId: id,
			version: server.notebook.version + 1,
			updatedAt: "2026-10-07T00:00:00Z",
		};
		return jsonResponse(server.notebook);
	});
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

export function mountApp(backend: FakeBackend, visibility: VisibilitySource = ALWAYS_VISIBLE) {
	const api = createApiClient({ fetch: backend.fetch });
	return render(() => (
		<App api={api} registry={createBaselineUiRegistry()} visibility={visibility} window={window} />
	));
}

/* ----- Home dashboard fake backend (FR-017) ----- */

function homeSeries(entry: {
	readonly seriesId: string;
	readonly provider: "fred" | "twelve-data";
	readonly symbol: string;
	readonly title: string;
	readonly unit: string;
	readonly publisher: string;
	readonly sourceUrl: string;
	readonly lastRefreshedAt: string | null;
	readonly unavailable?: MarketSeries["unavailable"];
	readonly closes: readonly (readonly [string, number])[];
}): MarketSeries {
	return {
		seriesId: entry.seriesId,
		provider: entry.provider,
		symbol: entry.symbol,
		title: entry.title,
		unit: entry.unit,
		frequency: "daily",
		publisher: entry.publisher,
		sourceUrl: entry.sourceUrl,
		lastRefreshedAt: entry.lastRefreshedAt,
		retrievedAt: entry.lastRefreshedAt,
		unavailable: entry.unavailable ?? null,
		observations: entry.closes.map(([observedOn, value]): [string, number] => [observedOn, value]),
	};
}

const FRED_PUBLISHER = "Federal Reserve Bank of St. Louis (FRED)";
const TWELVE_PUBLISHER = "Twelve Data";
const FRESH_AT = "2026-10-12T11:50:00Z";

/** Series for every id on the default dashboard, with numbers from the recorded fixtures. */
export function defaultHomeSeries(stale: boolean): MarketSeries[] {
	const at = stale ? "2026-10-10T00:00:00Z" : FRESH_AT;
	const fred = (
		symbol: string,
		title: string,
		unit: string,
		closes: readonly (readonly [string, number])[],
	): MarketSeries =>
		homeSeries({
			seriesId: `fred:${symbol}`,
			provider: "fred",
			symbol,
			title,
			unit,
			publisher: FRED_PUBLISHER,
			sourceUrl: `https://fred.stlouisfed.org/series/${symbol}`,
			lastRefreshedAt: at,
			closes,
		});
	const twelve = (
		symbol: string,
		title: string,
		unit: string,
		closes: readonly (readonly [string, number])[],
	): MarketSeries =>
		homeSeries({
			seriesId: `twelve-data:${symbol}`,
			provider: "twelve-data",
			symbol,
			title,
			unit,
			publisher: TWELVE_PUBLISHER,
			sourceUrl: "https://twelvedata.com/",
			lastRefreshedAt: at,
			closes,
		});
	return [
		fred("VIXCLS", "CBOE Volatility Index: VIX", "Index", [
			["2026-10-06", 15.01],
			["2026-10-07", 15.08],
			["2026-10-08", 15.41],
		]),
		twelve("XAU/USD", "XAU/USD", "USD per XAU (troy ounce of gold)", [
			["2026-10-10", 4195.80423],
			["2026-10-11", 4195.84955],
			["2026-10-12", 4168.44041],
		]),
		fred("DGS10", "10-Year Treasury Constant Maturity Rate", "Percent", [
			["2026-10-06", 4.12],
			["2026-10-07", 4.15],
			["2026-10-08", 4.18],
		]),
		fred("SP500", "S&P 500", "Index", [
			["2026-10-06", 6651.21],
			["2026-10-07", 6671.06],
			["2026-10-08", 6692.34],
		]),
		twelve("AAPL", "AAPL (NASDAQ)", "USD", [
			["2026-10-07", 336.67001],
			["2026-10-08", 340.42001],
			["2026-10-09", 336.64001],
		]),
		twelve("MSFT", "MSFT (NASDAQ)", "USD", [
			["2026-10-07", 531.2],
			["2026-10-08", 533.9],
			["2026-10-09", 535.070007],
		]),
		twelve("NVDA", "NVDA (NASDAQ)", "USD", [
			["2026-10-07", 181.5],
			["2026-10-08", 183.2],
			["2026-10-09", 182.75],
		]),
		fred("CPIAUCSL", "Consumer Price Index", "Index", [
			["2026-07-01", 322.1],
			["2026-08-01", 322.8],
			["2026-09-01", 323.5],
		]),
		fred("UNRATE", "Unemployment Rate", "Percent", [
			["2026-07-01", 4.1],
			["2026-08-01", 4.2],
			["2026-09-01", 4.2],
		]),
		fred("FEDFUNDS", "Effective Federal Funds Rate", "Percent", [
			["2026-07-01", 4.33],
			["2026-08-01", 4.33],
			["2026-09-01", 4.33],
		]),
		fred("GDPC1", "Real Gross Domestic Product", "Billions of Chained 2017 Dollars", [
			["2026-01-01", 23500.5],
			["2026-04-01", 23610.2],
			["2026-07-01", 23720.8],
		]),
		fred("PAYEMS", "All Employees, Total Nonfarm", "Thousands of Persons", [
			["2026-07-01", 159100],
			["2026-08-01", 159250],
			["2026-09-01", 159400],
		]),
		fred("T10Y2Y", "10-Year Treasury Minus 2-Year Treasury", "Percent", [
			["2026-10-06", 0.52],
			["2026-10-07", 0.55],
			["2026-10-08", 0.58],
		]),
	];
}

export const HOME_CATALOG: readonly MarketCatalogEntry[] = [
	{
		seriesId: "fred:VIXCLS",
		label: "VIX Index",
		category: "volatility",
		description: "CBOE Volatility Index, daily close from FRED.",
	},
	{
		seriesId: "fred:DGS10",
		label: "US 10-year yield",
		category: "rates",
		description: "10-year Treasury constant maturity rate.",
	},
	{
		seriesId: "twelve-data:AAPL",
		label: "Apple",
		category: "equity",
		description: "Apple Inc. share price.",
	},
];

/** What the home fake server stores; tests mutate it (complete a refresh, change series). */
export interface HomeServerState {
	dashboard: HomeDashboard;
	version: number;
	updatedAt: string | null;
	saved: boolean;
	/** V2: when true the dashboard GET answers STORED_DASHBOARD_UNREADABLE. */
	dashboardUnreadable: boolean;
	series: MarketSeries[];
	catalog: readonly MarketCatalogEntry[];
	activeRunId: string | null;
	runState: string;
	lastSucceededAt: string | null;
	lastFailure: { readonly state: string; readonly code: string; readonly at: string } | null;
	refreshCount: number;
	/** Test hook: the next N data GETs answer 500 instead (V1/V2b). */
	dataFailures: number;
}

export function initialHomeServerState(stale: boolean): HomeServerState {
	return {
		dashboard: structuredClone(DEFAULT_HOME_DASHBOARD),
		version: 0,
		updatedAt: null,
		saved: false,
		dashboardUnreadable: false,
		series: defaultHomeSeries(stale),
		catalog: HOME_CATALOG,
		activeRunId: null,
		runState: "pending",
		lastSucceededAt: null,
		lastFailure: null,
		refreshCount: 0,
		dataFailures: 0,
	};
}

function homeDataEtag(home: HomeServerState): string {
	const stamp = home.series
		.map(
			(entry) =>
				`${entry.seriesId}:${entry.lastRefreshedAt ?? "never"}:${entry.observations.length}`,
		)
		.join(",");
	const failure =
		home.lastFailure === null
			? "no-failure"
			: `${home.lastFailure.state}:${home.lastFailure.code}:${home.lastFailure.at}`;
	return `"home-${home.activeRunId ?? "idle"}-${home.runState}-${home.lastSucceededAt ?? "never"}-${failure}-${stamp.length}-${stamp}"`;
}

/** Registers the `/home/*` routes plus the run read the status line needs, backed by `home`. */
export function installHomeRoutes(
	backend: FakeBackend,
	server: ServerState,
	home: HomeServerState,
): void {
	installWorkspaceRoutes(backend, server);
	backend.on("GET", /^\/api\/v1\/home\/dashboard$/, () => {
		if (home.dashboardUnreadable) {
			return errorResponse(
				500,
				"STORED_DASHBOARD_UNREADABLE",
				"The stored dashboard could not be read. Reset to the default arrangement to continue.",
			);
		}
		return jsonResponse({
			dashboard: home.dashboard,
			version: home.version,
			updatedAt: home.updatedAt,
			origin: home.saved ? "saved" : "defaults",
		});
	});
	backend.on("PUT", /^\/api\/v1\/home\/dashboard$/, (request) => {
		const body = request.body as { dashboard?: unknown; expectedVersion?: unknown };
		if (
			typeof body?.expectedVersion !== "number" ||
			body.expectedVersion !== home.version ||
			typeof body?.dashboard !== "object" ||
			body.dashboard === null ||
			!Array.isArray((body.dashboard as { widgets?: unknown }).widgets)
		) {
			if (typeof body?.expectedVersion === "number" && body.expectedVersion !== home.version) {
				return errorResponse(
					409,
					"VERSION_CONFLICT",
					"The dashboard changed; reload and try again.",
				);
			}
			return errorResponse(400, "VALIDATION_FAILED", "dashboard is required");
		}
		home.dashboard = body.dashboard as HomeDashboard;
		home.version += 1;
		home.updatedAt = "2026-10-12T12:00:00Z";
		home.saved = true;
		return jsonResponse({
			dashboard: home.dashboard,
			version: home.version,
			updatedAt: home.updatedAt,
			origin: "saved",
		});
	});
	backend.on("GET", /^\/api\/v1\/home\/data(\?.*)?$/, (request) => {
		if (home.dataFailures > 0) {
			home.dataFailures -= 1;
			return errorResponse(500, "INTERNAL", "boom (V1/V2b fixture)");
		}
		const etag = homeDataEtag(home);
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(
			{
				series: home.series,
				refresh: {
					activeRunId: home.activeRunId,
					activeRunState: home.activeRunId === null ? null : home.runState,
					lastSucceededAt: home.lastSucceededAt,
					lastFailure: home.lastFailure,
				},
			},
			{ headers: { ETag: etag } },
		);
	});
	backend.on("POST", /^\/api\/v1\/home\/dashboard\/reset$/, () => {
		home.dashboard = structuredClone(DEFAULT_HOME_DASHBOARD);
		home.version += 1;
		home.updatedAt = "2026-10-12T12:00:00Z";
		home.saved = true;
		home.dashboardUnreadable = false;
		return jsonResponse({
			dashboard: home.dashboard,
			version: home.version,
			updatedAt: home.updatedAt,
			origin: "saved",
		});
	});
	backend.on("GET", /^\/api\/v1\/home\/catalog$/, () => jsonResponse({ entries: home.catalog }));
	backend.on("POST", /^\/api\/v1\/home\/refresh$/, () => {
		home.refreshCount += 1;
		if (home.activeRunId === null) {
			home.activeRunId = `run_market_${home.refreshCount}`;
			home.runState = "pending";
		}
		return jsonResponse(
			{
				run: makeRun({
					runId: home.activeRunId,
					kind: "market-refresh",
					request: null,
					workspaceId: null,
					state: home.runState as ResearchRun["state"],
				}),
			},
			{ status: 202 },
		);
	});
	backend.on("GET", /^\/api\/v1\/research-runs\/([^/?]+)$/, (_request, match) => {
		const runId = match[1] ?? "";
		const runs = [...server.runs, ...server.secondRuns];
		const found =
			runs.find((run) => run.runId === runId) ??
			(runId === home.activeRunId
				? makeRun({
						runId,
						kind: "market-refresh",
						request: null,
						workspaceId: null,
						state: home.runState as ResearchRun["state"],
					})
				: null);
		if (found === null) return errorResponse(404, "NOT_FOUND", "no such run");
		return jsonResponse({ run: found });
	});
}

export function commandRequests(backend: FakeBackend): RecordedRequest[] {
	return backend.requestsTo("POST", /\/commands$/);
}

/* ----- Watchlist fake backend (FR-018 fix F: Home auto-refresh tests) ----- */

/** What the watchlist fake server stores; tests mutate it to end runs and refresh stocks. */
export interface WatchlistServerState {
	stocks: WatchlistResponse["stocks"];
	activeRunId: string | null;
	runState: string;
	lastSucceededAt: string | null;
	lastFailure: { readonly state: string; readonly code: string; readonly at: string } | null;
	refreshCount: number;
	google: {
		status: "disconnected" | "connecting" | "connected" | "needs-reconnect";
		authUrl: string | null;
		calendarId: string | null;
		connectedAt: string | null;
		lastSyncedAt: string | null;
		lastSync: {
			readonly inserted: number;
			readonly updated: number;
			readonly deleted: number;
			readonly unchanged: number;
		} | null;
		inSync: boolean | null;
		activeRunId: string | null;
		activeRunState: string | null;
		activeAction: "connect" | "sync" | "disconnect" | null;
		lastFailure: { readonly code: string; readonly reason: string; readonly at: string } | null;
	};
	syncCount: number;
}

export function initialWatchlistServerState(): WatchlistServerState {
	return {
		stocks: [],
		activeRunId: null,
		runState: "pending",
		lastSucceededAt: null,
		lastFailure: null,
		refreshCount: 0,
		google: {
			status: "disconnected",
			authUrl: null,
			calendarId: null,
			connectedAt: null,
			lastSyncedAt: null,
			lastSync: null,
			inSync: null,
			activeRunId: null,
			activeRunState: null,
			activeAction: null,
			lastFailure: null,
		},
		syncCount: 0,
	};
}

function watchlistEtag(watch: WatchlistServerState): string {
	const stamp = watch.stocks
		.map((entry) => `${entry.stockId}:${entry.lastRefreshedAt ?? "never"}`)
		.join(",");
	return `"watch-${watch.activeRunId ?? "idle"}-${watch.lastSucceededAt ?? "never"}-${stamp.length}-${stamp}-${JSON.stringify(watch.google)}"`;
}

/** Registers the `/watchlist` + `/watchlist/refresh` routes Home's calendar widget needs. */
export function installWatchlistRoutes(backend: FakeBackend, watch: WatchlistServerState): void {
	backend.on("GET", /^\/api\/v1\/watchlist$/, (request) => {
		const etag = watchlistEtag(watch);
		if (request.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
		return jsonResponse(
			{
				stocks: watch.stocks,
				refresh: {
					activeRunId: watch.activeRunId,
					activeRunState: watch.activeRunId === null ? null : watch.runState,
					lastSucceededAt: watch.lastSucceededAt,
					lastFailure: watch.lastFailure,
				},
				feed: { enabled: false, createdAt: null },
				googleCalendar: {
					...watch.google,
					activeRunState:
						watch.google.activeRunId === null ? null : (watch.google.activeRunState ?? "pending"),
				},
			},
			{ headers: { ETag: etag } },
		);
	});
	backend.on("POST", /^\/api\/v1\/watchlist\/refresh$/, () => {
		watch.refreshCount += 1;
		if (watch.activeRunId === null) {
			watch.activeRunId = `run_earnings_${watch.refreshCount}`;
			watch.runState = "pending";
		}
		return jsonResponse(
			{
				run: makeRun({
					runId: watch.activeRunId,
					kind: "earnings-refresh",
					request: null,
					workspaceId: null,
					state: watch.runState as ResearchRun["state"],
				}),
			},
			{ status: 202 },
		);
	});
	backend.on("POST", /^\/api\/v1\/google-calendar\/sync$/, () => {
		if (watch.google.status !== "connected") {
			return errorResponse(400, "VALIDATION_FAILED", "Google Calendar is not connected.");
		}
		watch.syncCount += 1;
		watch.google = {
			...watch.google,
			activeRunId: `run_google_sync_${watch.syncCount}`,
			activeRunState: "pending",
			activeAction: "sync",
		};
		return jsonResponse(
			{
				run: makeRun({
					runId: watch.google.activeRunId ?? "run_google_sync",
					kind: "google-calendar",
					request: null,
					workspaceId: null,
					state: "pending",
				}),
			},
			{ status: 202 },
		);
	});
}
