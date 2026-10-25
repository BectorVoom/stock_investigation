import {
	type AddWatchlistStockRequest,
	type AgentSettings,
	type AgentSettingsResponse,
	type AgentsResponse,
	API_PREFIX,
	type Article,
	addWatchlistStockRequestSchema,
	agentSettingsResponseSchema,
	agentSettingsSchema,
	agentsResponseSchema,
	approveRunRequestSchema,
	articleListResponseSchema,
	type CalendarFeedIssued,
	type Conversation,
	type ConversationSummary,
	type CreateScheduledTaskRequest,
	calendarFeedIssuedSchema,
	conversationListResponseSchema,
	conversationResponseSchema,
	createResearchRunRequestSchema,
	createScheduledTaskRequestSchema,
	createWorkspaceRequestSchema,
	dropLegacyEmptyAssets,
	type HomeDashboard,
	homeDashboardResponseSchema,
	homeDataResponseSchema,
	idempotencyKeySchema,
	issuedRunnerCredentialSchema,
	issueRunnerCredentialRequestSchema,
	type MarketCatalogEntry,
	marketCatalogResponseSchema,
	type NewsSource,
	type Notebook,
	type NotebookAssistRequest,
	type NotebookAssistResponse,
	type NotebookResponse,
	newsSourceSchema,
	notebookAssistRequestSchema,
	notebookAssistResponseSchema,
	notebookResponseSchema,
	previewSourceRequestSchema,
	putHomeDashboardRequestSchema,
	putNotebookRequestSchema,
	type RecommendedSource,
	type RegisterSourceRequest,
	type ResearchExport,
	type ResearchRequest,
	type ResearchRun,
	type RunnerCredential,
	type RunRecords,
	type RunScheduledTaskResponse,
	recommendedSourcesResponseSchema,
	registerSourceRequestSchema,
	renameWorkspaceRequestSchema,
	researchExportSchema,
	researchRunListResponseSchema,
	researchRunResponseSchema,
	runnerCredentialListResponseSchema,
	runRecordsResponseSchema,
	runScheduledTaskResponseSchema,
	type ScheduledTask,
	type ScheduledTaskListResponse,
	type SourcePreview,
	type StockDirectoryRefreshResponse,
	type StockDirectorySearchResponse,
	type StockDirectoryStatusResponse,
	scheduledTaskListResponseSchema,
	scheduledTaskResponseSchema,
	sessionResponseSchema,
	sourceListResponseSchema,
	sourcePreviewSchema,
	stockDirectoryRefreshRequestSchema,
	stockDirectoryRefreshResponseSchema,
	stockDirectorySearchQuerySchema,
	stockDirectorySearchResponseSchema,
	stockDirectoryStatusResponseSchema,
	submitCommandResponseSchema,
	type TaskResult,
	type TaskResultResponse,
	taskResultResponseSchema,
	type UpdateScheduledTaskRequest,
	type UpdateSourceRequest,
	uiCommandSchema,
	undoNotebookRequestSchema,
	updateScheduledTaskRequestSchema,
	updateSourceRequestSchema,
	type WatchlistResponse,
	type WatchMarket,
	type WorkspaceSummary,
	type WorkspaceView,
	watchlistResponseSchema,
	workspaceEventsResponseSchema,
	workspaceListResponseSchema,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "@research/contracts";
import { clientFailureMessages } from "./errors.messages.ts";
import {
	type ApiResult,
	type Conditional,
	type FetchLike,
	fail,
	type HttpOptions,
	jsonBody,
	ok,
	type Parsed,
	type Parser,
	type RequestSpec,
	request,
	validate,
} from "./http.ts";

export type Session = Parsed<typeof sessionResponseSchema>;
export type { AgentSettings, AgentSettingsResponse };
export type HomeDashboardResponse = Parsed<typeof homeDashboardResponseSchema>;
export type HomeDataResponse = Parsed<typeof homeDataResponseSchema>;
export type WatchlistData = Parsed<typeof watchlistResponseSchema>;
export type { AddWatchlistStockRequest, CalendarFeedIssued, WatchlistResponse };
export type {
	StockDirectoryRefreshResponse,
	StockDirectorySearchResponse,
	StockDirectoryStatusResponse,
	CreateScheduledTaskRequest,
	RunScheduledTaskResponse,
	ScheduledTask,
	ScheduledTaskListResponse,
	TaskResult,
	TaskResultResponse,
	UpdateScheduledTaskRequest,
};
/** One stock-directory search as the Watchlist's search box asks it (ADR-0034). */
export interface StockDirectorySearch {
	readonly q: string;
	readonly market?: WatchMarket;
	readonly limit?: number;
}
export type UiCommand = Parsed<typeof uiCommandSchema>;
export type SubmitCommandResponse = Parsed<typeof submitCommandResponseSchema>;
export type WorkspaceEvents = Parsed<typeof workspaceEventsResponseSchema>;
export type ResearchBudget = Parsed<typeof approveRunRequestSchema>["budget"];
export type IssueRunnerCredentialRequest = Parsed<typeof issueRunnerCredentialRequestSchema>;
export type IssuedRunnerCredential = Parsed<typeof issuedRunnerCredentialSchema>;
export type ArticlePage = {
	readonly articles: readonly Article[];
	readonly nextCursor: string | null;
};
/** One earlier page of a conversation: messages with `seq` below `before`. */
export interface ConversationPage {
	readonly before: number;
	readonly limit?: number;
}

export interface ApiClientOptions {
	readonly fetch?: FetchLike;
	/** Source of unique ids for idempotency keys and command ids. */
	readonly randomUuid?: () => string;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function segment(id: string): string {
	return encodeURIComponent(id);
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== "") params.set(key, value);
	}
	const text = params.toString();
	return text === "" ? path : `${path}?${text}`;
}

/**
 * One function per `/api/v1` endpoint. Requests are validated before they are
 * sent and every response is parsed with its contract schema, so the rest of
 * the SPA only ever sees typed, validated data or an `ApiFailure`.
 */
export function createApiClient(options: ApiClientOptions = {}) {
	const http: HttpOptions = {
		fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
		timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	};
	const randomUuid = options.randomUuid ?? (() => globalThis.crypto.randomUUID());

	async function requestJson<T>(spec: RequestSpec, schema: Parser<T>): Promise<ApiResult<T>> {
		return request(http, spec, jsonBody(schema));
	}

	/** For 204 responses: there is no body to read. */
	async function requestEmpty(spec: RequestSpec): Promise<ApiResult<null>> {
		return request(http, spec, async () => ok(null));
	}

	async function conditionalGet<T>(
		path: string,
		schema: Parser<T>,
		etag: string | null,
	): Promise<ApiResult<Conditional<T>>> {
		const readBody = jsonBody(schema);
		const read = async (response: Response): Promise<ApiResult<Conditional<T>>> => {
			if (response.status === 304) return ok({ changed: false });
			const body = await readBody(response);
			if (!body.ok) return body;
			return ok({ changed: true, value: body.value, etag: response.headers.get("ETag") });
		};
		return request(http, { method: "GET", path, ifNoneMatch: etag }, read);
	}

	/** Validates a request body first, so an invalid request never leaves the browser. */
	async function write<Request, T>(
		spec: Omit<RequestSpec, "body">,
		requestSchema: Parser<Request>,
		body: unknown,
		responseSchema: Parser<T>,
	): Promise<ApiResult<T>> {
		const request = validate(requestSchema, body, { kind: "invalid-request", status: null });
		if (!request.ok) return request;
		return requestJson({ ...spec, body: request.value }, responseSchema);
	}

	function checkedIdempotencyKey(key: string): ApiResult<string> {
		return validate(idempotencyKeySchema, key, { kind: "invalid-request", status: null });
	}

	const runs = `${API_PREFIX}/research-runs`;
	const sources = `${API_PREFIX}/sources`;
	const workspaces = `${API_PREFIX}/workspaces`;
	const credentials = `${API_PREFIX}/runner-credentials`;
	const scheduledTasks = `${API_PREFIX}/scheduled-tasks`;

	return {
		/** Fresh key for one logical write; reuse it when re-sending that same write. */
		newIdempotencyKey: (): string => `idem-${randomUuid()}`,
		newCommandId: (): string => `cmd-${randomUuid()}`,

		getSession: (): Promise<ApiResult<Session>> =>
			requestJson({ method: "GET", path: `${API_PREFIX}/session` }, sessionResponseSchema),

		/* ----- sources ----- */
		previewSource: (url: string): Promise<ApiResult<SourcePreview>> =>
			write(
				{ method: "POST", path: `${sources}/preview` },
				previewSourceRequestSchema,
				{ url },
				sourcePreviewSchema,
			),
		listRecommendedSources: async (): Promise<ApiResult<readonly RecommendedSource[]>> => {
			const result = await requestJson(
				{ method: "GET", path: `${sources}/recommended` },
				recommendedSourcesResponseSchema,
			);
			return result.ok ? ok(result.value.entries) : result;
		},
		listSources: async (): Promise<ApiResult<readonly NewsSource[]>> => {
			const result = await requestJson({ method: "GET", path: sources }, sourceListResponseSchema);
			return result.ok ? ok(result.value.sources) : result;
		},
		registerSource: (request: RegisterSourceRequest): Promise<ApiResult<NewsSource>> =>
			write(
				{ method: "POST", path: sources },
				registerSourceRequestSchema,
				request,
				newsSourceSchema,
			),
		updateSource: (sourceId: string, patch: UpdateSourceRequest): Promise<ApiResult<NewsSource>> =>
			write(
				{ method: "PATCH", path: `${sources}/${segment(sourceId)}` },
				updateSourceRequestSchema,
				patch,
				newsSourceSchema,
			),
		deleteSource: (sourceId: string): Promise<ApiResult<null>> =>
			requestEmpty({ method: "DELETE", path: `${sources}/${segment(sourceId)}` }),
		/** Queues a news-ingest job for the local runner. */
		refreshSources: async (idempotencyKey: string): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{ method: "POST", path: `${sources}/refresh`, idempotencyKey: key.value },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		listArticles: (
			query: { readonly sourceId?: string; readonly cursor?: string } = {},
		): Promise<ApiResult<ArticlePage>> =>
			requestJson(
				{
					method: "GET",
					path: withQuery(`${API_PREFIX}/articles`, {
						sourceId: query.sourceId,
						cursor: query.cursor,
					}),
				},
				articleListResponseSchema,
			),

		/* ----- agents and research runs ----- */
		listAgents: (): Promise<ApiResult<AgentsResponse>> =>
			requestJson({ method: "GET", path: `${API_PREFIX}/agents` }, agentsResponseSchema),
		/**
		 * Conditional re-read of the agent backends for visibility-aware
		 * polling (settings form): an unchanged answer comes back as a cheap
		 * 304 and costs no re-render.
		 */
		pollAgents: (etag: string | null): Promise<ApiResult<Conditional<AgentsResponse>>> =>
			conditionalGet(`${API_PREFIX}/agents`, agentsResponseSchema, etag),
		/* ----- AI agent settings (Settings → AI agent is the only writer) ----- */
		getAgentSettings: (): Promise<ApiResult<AgentSettingsResponse>> =>
			requestJson(
				{ method: "GET", path: `${API_PREFIX}/settings/agent` },
				agentSettingsResponseSchema,
			),
		saveAgentSettings: (settings: AgentSettings): Promise<ApiResult<AgentSettingsResponse>> =>
			write(
				{ method: "PUT", path: `${API_PREFIX}/settings/agent` },
				agentSettingsSchema,
				settings,
				agentSettingsResponseSchema,
			),
		/** Also stores the question as the owner's chat message, server-side. */
		createResearchRun: async (
			request: ResearchRequest,
			idempotencyKey: string,
		): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await write(
				{ method: "POST", path: runs, idempotencyKey: key.value },
				createResearchRunRequestSchema,
				request,
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		listResearchRuns: async (workspaceId: string): Promise<ApiResult<readonly ResearchRun[]>> => {
			const result = await requestJson(
				{ method: "GET", path: withQuery(runs, { workspaceId }) },
				researchRunListResponseSchema,
			);
			return result.ok ? ok(result.value.runs) : result;
		},
		getResearchRun: async (
			runId: string,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<ResearchRun>>> => {
			const result = await conditionalGet(
				`${runs}/${segment(runId)}`,
				researchRunResponseSchema,
				etag,
			);
			if (!result.ok) return result;
			if (!result.value.changed) return ok({ changed: false });
			return ok({ changed: true, value: result.value.value.run, etag: result.value.etag });
		},
		getRunRecords: (runId: string): Promise<ApiResult<RunRecords>> =>
			requestJson(
				{ method: "GET", path: `${runs}/${segment(runId)}/records` },
				runRecordsResponseSchema,
			),
		cancelResearchRun: async (runId: string): Promise<ApiResult<ResearchRun>> => {
			const result = await requestJson(
				{ method: "POST", path: `${runs}/${segment(runId)}/cancel` },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		/** Creates a NEW run that retries the given one. */
		retryResearchRun: async (
			runId: string,
			idempotencyKey: string,
		): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{ method: "POST", path: `${runs}/${segment(runId)}/retry`, idempotencyKey: key.value },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		approveResearchRun: async (
			runId: string,
			budget: ResearchBudget,
		): Promise<ApiResult<ResearchRun>> => {
			const result = await write(
				{ method: "POST", path: `${runs}/${segment(runId)}/approve` },
				approveRunRequestSchema,
				{ budget },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},

		/* ----- workspaces ----- */
		listWorkspaces: async (): Promise<ApiResult<readonly WorkspaceSummary[]>> => {
			const result = await requestJson(
				{ method: "GET", path: workspaces },
				workspaceListResponseSchema,
			);
			return result.ok ? ok(result.value.workspaces) : result;
		},
		createWorkspace: (title?: string): Promise<ApiResult<WorkspaceSummary>> =>
			write(
				{ method: "POST", path: workspaces },
				createWorkspaceRequestSchema,
				title === undefined ? {} : { title },
				workspaceSummarySchema,
			),
		renameWorkspace: (workspaceId: string, title: string): Promise<ApiResult<WorkspaceSummary>> =>
			write(
				{ method: "PATCH", path: `${workspaces}/${segment(workspaceId)}` },
				renameWorkspaceRequestSchema,
				{ title },
				workspaceSummarySchema,
			),
		deleteWorkspace: (workspaceId: string): Promise<ApiResult<null>> =>
			requestEmpty({ method: "DELETE", path: `${workspaces}/${segment(workspaceId)}` }),
		getWorkspace: (
			workspaceId: string,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<WorkspaceView>>> =>
			conditionalGet(`${workspaces}/${segment(workspaceId)}`, workspaceViewSchema, etag),
		getWorkspaceEvents: (
			workspaceId: string,
			afterVersion: number,
		): Promise<ApiResult<WorkspaceEvents>> =>
			requestJson(
				{
					method: "GET",
					path: withQuery(`${workspaces}/${segment(workspaceId)}/events`, {
						after: String(afterVersion),
					}),
				},
				workspaceEventsResponseSchema,
			),
		/** 409 VERSION_CONFLICT and 422 UI_COMMAND_REJECTED come back as `kind: "api"` failures. */
		submitCommand: (command: UiCommand): Promise<ApiResult<SubmitCommandResponse>> =>
			write(
				{ method: "POST", path: `${workspaces}/${segment(command.workspaceId)}/commands` },
				uiCommandSchema,
				command,
				submitCommandResponseSchema,
			),
		getConversation: (
			workspaceId: string,
			etag: string | null = null,
			page: ConversationPage | null = null,
		): Promise<ApiResult<Conditional<Conversation>>> =>
			conditionalGet(
				withQuery(`${workspaces}/${segment(workspaceId)}/messages`, {
					before: page === null ? undefined : String(page.before),
					limit: page?.limit === undefined ? undefined : String(page.limit),
				}),
				conversationResponseSchema,
				etag,
			),
		listConversations: (
			etag: string | null = null,
		): Promise<ApiResult<Conditional<readonly ConversationSummary[]>>> =>
			(async () => {
				const result = await conditionalGet(
					`${API_PREFIX}/conversations`,
					conversationListResponseSchema,
					etag,
				);
				if (!result.ok) return result;
				if (!result.value.changed) return ok({ changed: false });
				return ok({
					changed: true,
					value: result.value.value.conversations,
					etag: result.value.etag,
				});
			})(),
		exportWorkspaceJson: (workspaceId: string): Promise<ApiResult<ResearchExport>> =>
			requestJson(
				{
					method: "GET",
					path: withQuery(`${workspaces}/${segment(workspaceId)}/export`, { format: "json" }),
				},
				researchExportSchema,
			),
		exportWorkspaceMarkdown: (workspaceId: string): Promise<ApiResult<string>> =>
			request(
				http,
				{
					method: "GET",
					path: withQuery(`${workspaces}/${segment(workspaceId)}/export`, { format: "markdown" }),
					accept: "text/markdown",
				},
				async (response) => {
					const contentType = response.headers.get("Content-Type") ?? "";
					if (!contentType.toLowerCase().startsWith("text/markdown")) {
						return fail({
							kind: "invalid-response",
							code: "INVALID_RESPONSE",
							status: response.status,
							message: clientFailureMessages.en.markdownContentType(contentType),
						});
					}
					return ok(await response.text());
				},
			),
		/**
		 * `payload` is untrusted file content; it is validated here and again by the server.
		 * Pre-removal files without images still carry an empty `assets` array the contract no
		 * longer defines, so it is dropped before validation. A file that still contains images
		 * is refused: an empty array never validates past the strict schema either, and anything
		 * image-bearing fails here or at the server with the reason named.
		 */
		importWorkspace: (payload: unknown): Promise<ApiResult<WorkspaceSummary>> =>
			write(
				{ method: "POST", path: `${workspaces}/import` },
				researchExportSchema,
				dropLegacyEmptyAssets(payload),
				workspaceSummarySchema,
			),

		/* ----- notebook of one conversation (ADR-0020) ----- */
		getNotebook: (workspaceId: string): Promise<ApiResult<NotebookResponse>> =>
			requestJson(
				{ method: "GET", path: `${workspaces}/${segment(workspaceId)}/notebook` },
				notebookResponseSchema,
			),
		/** Compare-and-set save: a 409 `VERSION_CONFLICT` means the notebook changed elsewhere. */
		saveNotebook: (
			workspaceId: string,
			notebook: Notebook,
			expectedVersion: number,
		): Promise<ApiResult<NotebookResponse>> =>
			write(
				{ method: "PUT", path: `${workspaces}/${segment(workspaceId)}/notebook` },
				putNotebookRequestSchema,
				{ notebook, expectedVersion },
				notebookResponseSchema,
			),
		/** Restores the body kept before `expectedVersion` (the version on screen). */
		undoNotebook: (
			workspaceId: string,
			expectedVersion: number,
		): Promise<ApiResult<NotebookResponse>> =>
			write(
				{ method: "POST", path: `${workspaces}/${segment(workspaceId)}/notebook/undo` },
				undoNotebookRequestSchema,
				{ expectedVersion },
				notebookResponseSchema,
			),
		/** Stores the instruction as the owner's chat message and queues a notebook-assistant job. */
		assistNotebook: async (
			workspaceId: string,
			request: NotebookAssistRequest,
			idempotencyKey: string,
		): Promise<ApiResult<NotebookAssistResponse>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			return write(
				{
					method: "POST",
					path: `${workspaces}/${segment(workspaceId)}/notebook/assist`,
					idempotencyKey: key.value,
				},
				notebookAssistRequestSchema,
				request,
				notebookAssistResponseSchema,
			);
		},

		/**
		 * Live series of the notebook's market widgets (ADR-0021), in the Home
		 * data shape; conditional on the ETag like `getHomeData`.
		 */
		getNotebookMarketData: (
			workspaceId: string,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<HomeDataResponse>>> =>
			conditionalGet(
				`${workspaces}/${segment(workspaceId)}/notebook/market-data`,
				homeDataResponseSchema,
				etag,
			),

		/* ----- home dashboard (FR-017) ----- */
		getHomeDashboard: (): Promise<ApiResult<HomeDashboardResponse>> =>
			requestJson(
				{ method: "GET", path: `${API_PREFIX}/home/dashboard` },
				homeDashboardResponseSchema,
			),
		saveHomeDashboard: (
			dashboard: HomeDashboard,
			expectedVersion: number,
		): Promise<ApiResult<HomeDashboardResponse>> =>
			write(
				{ method: "PUT", path: `${API_PREFIX}/home/dashboard` },
				putHomeDashboardRequestSchema,
				{ dashboard, expectedVersion },
				homeDashboardResponseSchema,
			),
		/**
		 * V2: replaces the stored dashboard with the defaults without an
		 * expectedVersion — the way out when the stored document no longer
		 * parses (the server exposes no version in that error path).
		 */
		resetHomeDashboard: (): Promise<ApiResult<HomeDashboardResponse>> =>
			requestJson(
				{ method: "POST", path: `${API_PREFIX}/home/dashboard/reset` },
				homeDashboardResponseSchema,
			),
		getHomeData: (etag: string | null = null): Promise<ApiResult<Conditional<HomeDataResponse>>> =>
			conditionalGet(`${API_PREFIX}/home/data`, homeDataResponseSchema, etag),
		listMarketCatalog: async (): Promise<ApiResult<readonly MarketCatalogEntry[]>> => {
			const result = await requestJson(
				{ method: "GET", path: `${API_PREFIX}/home/catalog` },
				marketCatalogResponseSchema,
			);
			return result.ok ? ok(result.value.entries) : result;
		},
		/** Queues a market-refresh job for the local runner. */
		refreshMarket: async (idempotencyKey: string): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{ method: "POST", path: `${API_PREFIX}/home/refresh`, idempotencyKey: key.value },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},

		/* ----- watchlist and earnings-date calendar (FR-018) ----- */
		getWatchlist: (etag: string | null = null): Promise<ApiResult<Conditional<WatchlistData>>> =>
			conditionalGet(`${API_PREFIX}/watchlist`, watchlistResponseSchema, etag),
		addWatchlistStock: (stock: AddWatchlistStockRequest): Promise<ApiResult<WatchlistData>> =>
			write(
				{ method: "POST", path: `${API_PREFIX}/watchlist/stocks` },
				addWatchlistStockRequestSchema,
				stock,
				watchlistResponseSchema,
			),
		removeWatchlistStock: (stockId: string): Promise<ApiResult<WatchlistData>> =>
			requestJson(
				{ method: "DELETE", path: `${API_PREFIX}/watchlist/stocks/${segment(stockId)}` },
				watchlistResponseSchema,
			),
		/** Queues an earnings-date refresh job for the local runner. */
		refreshEarnings: async (idempotencyKey: string): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{ method: "POST", path: `${API_PREFIX}/watchlist/refresh`, idempotencyKey: key.value },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		/* ----- stock directory: every US and JP listed stock (ADR-0034) ----- */
		/** Each market's stored list: size, dates, active run and last failure (US, then JP). */
		getStockDirectory: (): Promise<ApiResult<StockDirectoryStatusResponse>> =>
			requestJson(
				{ method: "GET", path: `${API_PREFIX}/watchlist/directory` },
				stockDirectoryStatusResponseSchema,
			),
		/**
		 * Searches the stored lists. `signal` lets a newer keystroke cancel
		 * this request; the query is checked against the contract first, so an
		 * empty or over-long query never leaves the browser.
		 */
		searchStockDirectory: (
			search: StockDirectorySearch,
			signal?: AbortSignal,
		): Promise<ApiResult<StockDirectorySearchResponse>> => {
			const query = validate(stockDirectorySearchQuerySchema, search, {
				kind: "invalid-request",
				status: null,
			});
			if (!query.ok) return Promise.resolve(query);
			return requestJson(
				{
					method: "GET",
					path: withQuery(`${API_PREFIX}/watchlist/directory/search`, {
						q: query.value.q,
						market: query.value.market,
						limit: String(query.value.limit),
					}),
					...(signal === undefined ? {} : { signal }),
				},
				stockDirectorySearchResponseSchema,
			);
		},
		/** Queues one stock-list download per market for the local runner (an active one is reused). */
		refreshStockDirectory: async (
			markets: readonly WatchMarket[],
			idempotencyKey: string,
		): Promise<ApiResult<StockDirectoryRefreshResponse>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			return write(
				{
					method: "POST",
					path: `${API_PREFIX}/watchlist/directory/refresh`,
					idempotencyKey: key.value,
				},
				stockDirectoryRefreshRequestSchema,
				{ markets },
				stockDirectoryRefreshResponseSchema,
			);
		},
		/** The owner's calendar document as .ics text (the caller offers it as a download). */
		downloadWatchlistIcs: (): Promise<ApiResult<string>> =>
			request(
				http,
				{
					method: "GET",
					path: `${API_PREFIX}/watchlist/calendar.ics`,
					accept: "text/calendar",
				},
				async (response) => {
					const contentType = response.headers.get("Content-Type") ?? "";
					if (!contentType.toLowerCase().startsWith("text/calendar")) {
						return fail({
							kind: "invalid-response",
							code: "INVALID_RESPONSE",
							status: response.status,
							message: clientFailureMessages.en.calendarContentType(contentType),
						});
					}
					return ok(await response.text());
				},
			),
		/**
		 * Issues (or rotates) the calendar subscription token. The token is
		 * shown once and must never be persisted by the SPA.
		 */
		issueCalendarFeed: (): Promise<ApiResult<CalendarFeedIssued>> =>
			requestJson(
				{ method: "POST", path: `${API_PREFIX}/watchlist/feed` },
				calendarFeedIssuedSchema,
			),
		revokeCalendarFeed: (): Promise<ApiResult<null>> =>
			requestEmpty({ method: "DELETE", path: `${API_PREFIX}/watchlist/feed` }),

		/* ----- Google Calendar sync (FR-019): one queued run per action ----- */
		/** Queues a Google Calendar connect job for the local runner. */
		connectGoogleCalendar: async (idempotencyKey: string): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{
					method: "POST",
					path: `${API_PREFIX}/google-calendar/connect`,
					idempotencyKey: key.value,
				},
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		/** Queues a Google Calendar sync job for the local runner. */
		syncGoogleCalendar: async (idempotencyKey: string): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{ method: "POST", path: `${API_PREFIX}/google-calendar/sync`, idempotencyKey: key.value },
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},
		/** Queues a Google Calendar disconnect job for the local runner. */
		disconnectGoogleCalendar: async (idempotencyKey: string): Promise<ApiResult<ResearchRun>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await requestJson(
				{
					method: "POST",
					path: `${API_PREFIX}/google-calendar/disconnect`,
					idempotencyKey: key.value,
				},
				researchRunResponseSchema,
			);
			return result.ok ? ok(result.value.run) : result;
		},

		/* ----- scheduled tasks (ADR-0033) ----- */
		/**
		 * Conditional read of the owner's tasks for visibility-aware polling
		 * (the Tasks page and the widget share one poll): an unchanged list
		 * answers a cheap 304.
		 */
		listScheduledTasks: (
			etag: string | null = null,
		): Promise<ApiResult<Conditional<ScheduledTaskListResponse>>> =>
			conditionalGet(scheduledTasks, scheduledTaskListResponseSchema, etag),
		/**
		 * Conditional read of one task's latest answer (ADR-0038 §3): an
		 * unchanged answer is a cheap 304; a task the owner does not have is
		 * 404 `NOT_FOUND`.
		 */
		getScheduledTaskResult: (
			taskId: string,
			etag: string | null = null,
		): Promise<ApiResult<Conditional<TaskResultResponse>>> =>
			conditionalGet(`${scheduledTasks}/${segment(taskId)}/result`, taskResultResponseSchema, etag),
		/** Creates the task and its own conversation; reuse the key when re-sending the same create. */
		createScheduledTask: async (
			request: CreateScheduledTaskRequest,
			idempotencyKey: string,
		): Promise<ApiResult<ScheduledTask>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			const result = await write(
				{ method: "POST", path: scheduledTasks, idempotencyKey: key.value },
				createScheduledTaskRequestSchema,
				request,
				scheduledTaskResponseSchema,
			);
			return result.ok ? ok(result.value.task) : result;
		},
		/** Edit, pause (`status: "paused"`) or resume (`"active"`); 409 VERSION_CONFLICT when stale. */
		updateScheduledTask: async (
			taskId: string,
			request: UpdateScheduledTaskRequest,
		): Promise<ApiResult<ScheduledTask>> => {
			const result = await write(
				{ method: "PATCH", path: `${scheduledTasks}/${segment(taskId)}` },
				updateScheduledTaskRequestSchema,
				request,
				scheduledTaskResponseSchema,
			);
			return result.ok ? ok(result.value.task) : result;
		},
		/** Deletes the task; its conversation (the answers) stays. */
		deleteScheduledTask: (taskId: string): Promise<ApiResult<null>> =>
			requestEmpty({ method: "DELETE", path: `${scheduledTasks}/${segment(taskId)}` }),
		/** Run now: queues one run without moving the schedule, or answers the unfinished one. */
		runScheduledTask: async (
			taskId: string,
			idempotencyKey: string,
		): Promise<ApiResult<RunScheduledTaskResponse>> => {
			const key = checkedIdempotencyKey(idempotencyKey);
			if (!key.ok) return key;
			return requestJson(
				{
					method: "POST",
					path: `${scheduledTasks}/${segment(taskId)}/run`,
					idempotencyKey: key.value,
				},
				runScheduledTaskResponseSchema,
			);
		},

		/* ----- runner credentials ----- */
		listRunnerCredentials: async (): Promise<ApiResult<readonly RunnerCredential[]>> => {
			const result = await requestJson(
				{ method: "GET", path: credentials },
				runnerCredentialListResponseSchema,
			);
			return result.ok ? ok(result.value.credentials) : result;
		},
		/** The returned token is shown once and must never be persisted by the SPA. */
		issueRunnerCredential: (
			request: IssueRunnerCredentialRequest,
		): Promise<ApiResult<IssuedRunnerCredential>> =>
			write(
				{ method: "POST", path: credentials },
				issueRunnerCredentialRequestSchema,
				request,
				issuedRunnerCredentialSchema,
			),
		revokeRunnerCredential: (credentialId: string): Promise<ApiResult<null>> =>
			requestEmpty({ method: "DELETE", path: `${credentials}/${segment(credentialId)}` }),
	};
}

export type ApiClient = ReturnType<typeof createApiClient>;
