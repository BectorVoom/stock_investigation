import {
	type AgentSettings,
	type AgentSettingsResponse,
	type AgentsResponse,
	API_PREFIX,
	type ApprovedAsset,
	type Article,
	agentSettingsResponseSchema,
	agentSettingsSchema,
	agentsResponseSchema,
	approveAssetRequestSchema,
	approvedAssetSchema,
	approveRunRequestSchema,
	articleListResponseSchema,
	assetListResponseSchema,
	type Conversation,
	type ConversationSummary,
	conversationListResponseSchema,
	conversationResponseSchema,
	createResearchRunRequestSchema,
	createWorkspaceRequestSchema,
	idempotencyKeySchema,
	issuedRunnerCredentialSchema,
	issueRunnerCredentialRequestSchema,
	type NewsSource,
	newsSourceSchema,
	previewSourceRequestSchema,
	type RecommendedSource,
	type RegisterSourceRequest,
	type ResearchExport,
	type ResearchRequest,
	type ResearchRun,
	type RunnerCredential,
	type RunRecords,
	recommendedSourcesResponseSchema,
	registerSourceRequestSchema,
	renameWorkspaceRequestSchema,
	researchExportSchema,
	researchRunListResponseSchema,
	researchRunResponseSchema,
	runnerCredentialListResponseSchema,
	runRecordsResponseSchema,
	type SourcePreview,
	sessionResponseSchema,
	sourceListResponseSchema,
	sourcePreviewSchema,
	submitCommandResponseSchema,
	type UpdateSourceRequest,
	uiCommandSchema,
	updateSourceRequestSchema,
	type WorkspaceSummary,
	type WorkspaceView,
	workspaceEventsResponseSchema,
	workspaceListResponseSchema,
	workspaceSummarySchema,
	workspaceViewSchema,
} from "@research/contracts";
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
export type UiCommand = Parsed<typeof uiCommandSchema>;
export type SubmitCommandResponse = Parsed<typeof submitCommandResponseSchema>;
export type WorkspaceEvents = Parsed<typeof workspaceEventsResponseSchema>;
export type ResearchBudget = Parsed<typeof approveRunRequestSchema>["budget"];
export type ApproveAssetRequest = Parsed<typeof approveAssetRequestSchema>;
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
	const assets = `${API_PREFIX}/assets`;
	const credentials = `${API_PREFIX}/runner-credentials`;

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
							message: `Expected a text/markdown export but received "${contentType || "no content type"}".`,
						});
					}
					return ok(await response.text());
				},
			),
		/** `payload` is untrusted file content; it is validated here and again by the server. */
		importWorkspace: (payload: unknown): Promise<ApiResult<WorkspaceSummary>> =>
			write(
				{ method: "POST", path: `${workspaces}/import` },
				researchExportSchema,
				payload,
				workspaceSummarySchema,
			),

		/* ----- approved assets ----- */
		listAssets: async (): Promise<ApiResult<readonly ApprovedAsset[]>> => {
			const result = await requestJson({ method: "GET", path: assets }, assetListResponseSchema);
			return result.ok ? ok(result.value.assets) : result;
		},
		approveAsset: (request: ApproveAssetRequest): Promise<ApiResult<ApprovedAsset>> =>
			write(
				{ method: "POST", path: assets },
				approveAssetRequestSchema,
				request,
				approvedAssetSchema,
			),
		deleteAsset: (assetId: string): Promise<ApiResult<null>> =>
			requestEmpty({ method: "DELETE", path: `${assets}/${segment(assetId)}` }),

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
