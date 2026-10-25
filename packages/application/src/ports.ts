import type {
	AgentDescriptor,
	AgentSettings,
	Article,
	ChatMessage,
	Claim,
	ConversationSummary,
	Dataset,
	EarningsEvent,
	EarningsSourceId,
	EarningsTiming,
	EarningsUnavailableCode,
	Evidence,
	GoogleCalendarRequest,
	HomeDashboard,
	JobKind,
	JobState,
	MarketFrequency,
	MarketProviderId,
	MarketUnavailableCode,
	NewsSource,
	Notebook,
	NotebookAssistJobRequest,
	NotebookTurn,
	ResearchBundle,
	ResearchMarket,
	ResearchRequest,
	RunnerCredential,
	RunnerEvent,
	RunRecords,
	StockDirectoryEntry,
	StockDirectoryFailureCode,
	StockListing,
	TaskSchedule,
	TaskSkip,
	TaskSpendConsent,
	TaskStatus,
	UpdateSourceRequest,
	WatchMarket,
	WorkspaceSummary,
} from "@research/contracts";
import {
	err,
	type RawFeed,
	type ResourceUsage,
	type Result,
	type StockSearchKeys,
	type StockSearchRow,
	type UiCommand,
	type WorkspaceState,
} from "@research/domain";

/* ---------- Environment ports (ARCH-002: time and randomness are injected) ---------- */

export interface Clock {
	nowMs(): number;
	nowIso(): string;
}

export interface IdGenerator {
	/** Returns a fresh, unguessable identifier with the given prefix. */
	newId(prefix: string): string;
}

export interface Hasher {
	sha256Hex(text: string): Promise<string>;
}

export interface SecretGenerator {
	/** A high-entropy bearer secret (>= 256 bits). */
	newSecret(): string;
}

/* ---------- Network ports ---------- */

export interface FetchedDocument {
	/** URL after validated redirects. */
	readonly finalUrl: string;
	readonly contentType: string | null;
	readonly text: string;
}

export type SafeFetchErrorCode =
	| "UNSAFE_URL"
	| "HOST_NOT_ALLOWED"
	| "UNSAFE_REDIRECT"
	| "TOO_MANY_REDIRECTS"
	| "REDIRECT_NOT_AUTHORIZED"
	| "TIMEOUT"
	| "HTTP_ERROR"
	| "RESPONSE_TOO_LARGE"
	| "NETWORK_ERROR";

/**
 * A failed safe fetch. An `HTTP_ERROR` always carries `status`: the status
 * the external service answered with, exactly as received. Callers read it
 * from this field (never from `detail`) and pass it on unchanged as
 * `upstreamStatus` (docs/rule/error_handling.md §4a).
 */
export type SafeFetchError =
	| {
			readonly code: "HTTP_ERROR";
			readonly detail: string;
			readonly status: number;
			/**
			 * Response body of an HTTP error status, present only when the caller set
			 * `includeErrorBody`. Untrusted provider text: adapters must parse it
			 * with zod and never log, store or show it — only the fixed wording per
			 * code leaves the adapter.
			 */
			readonly body?: string;
	  }
	| {
			readonly code: Exclude<SafeFetchErrorCode, "HTTP_ERROR">;
			readonly detail: string;
			/**
			 * The answer's status when the failure was built from a response
			 * (a redirect a POST may not follow); absent when nothing answered.
			 */
			readonly status?: number;
	  };

/** The status an external service answered with, or null when nothing answered. */
export function upstreamStatusOf(error: SafeFetchError): number | null {
	return error.status ?? null;
}

export interface SafeFetchOptions {
	readonly maxBytes: number;
	readonly timeoutMs: number;
	readonly accept: string;
	readonly signal?: AbortSignal;
	/** When set, the target and every redirect hop must be one of these hosts. */
	readonly allowedHosts?: ReadonlySet<string>;
	/**
	 * Consulted before each redirect hop is contacted (never for the initial
	 * URL, which the caller already authorized). A `false` answer — or a throw,
	 * treated as `false` (fail closed, ARCH-017) — ends the fetch with
	 * `REDIRECT_NOT_AUTHORIZED` before the hop is requested, so robots approval
	 * can precede every page request.
	 */
	readonly authorizeRedirect?: (url: string) => Promise<boolean>;
	/**
	 * Identifies the requester to publishers that require it (e.g. SEC EDGAR's
	 * fair-access policy). Adapters send a generic descriptive value when absent.
	 */
	readonly userAgent?: string;
	/**
	 * One of exactly two extra request headers the fetcher can ever send, and
	 * only on the initial request (never forwarded across redirects). This is
	 * the fixed allowlist: a provider API key travels as `Authorization:
	 * <value>` (e.g. Twelve Data's `apikey <KEY>`) rather than in the URL, so
	 * it never lands in a log line or a stored document. The value must be
	 * printable ASCII (≤ 300 chars); anything else fails the request before
	 * any byte is sent.
	 */
	readonly authorization?: string;
	/**
	 * The second and last entry of the fixed header allowlist: Finnhub's API
	 * key travels as `X-Finnhub-Token: <value>` (its API has no Authorization
	 * scheme and the key must stay out of the URL). Same rule as
	 * `authorization`: attached to the first request only, never forwarded
	 * across redirects, printable ASCII (≤ 300 chars) or the request fails
	 * before any byte is sent.
	 */
	readonly finnhubToken?: string;
	/**
	 * When true, the response body of an HTTP error status is read (bounded
	 * by `maxBytes`, like a success body) and attached to the `HTTP_ERROR`
	 * as `body`, so an adapter can map a provider's error JSON. Default
	 * false: other callers never pay for, or see, error bodies. The body is
	 * untrusted provider text (see `SafeFetchError.body`).
	 */
	readonly includeErrorBody?: boolean;
	/**
	 * When set, the initial request is a `POST` with `Content-Type:
	 * application/json` and exactly this body, UTF-8 encoded (a provider
	 * search API such as Tavily). Narrow by design:
	 *  - requires `allowedHosts` (a pinned destination); without it the fetch
	 *    fails with `HOST_NOT_ALLOWED` before any byte is sent;
	 *  - at most `MAX_JSON_BODY_BYTES` (64 KiB) of UTF-8, or the fetch fails
	 *    with `NETWORK_ERROR` before any byte is sent;
	 *  - a POST is never redirected: any 3xx ends the fetch with
	 *    `REDIRECT_NOT_AUTHORIZED` and the body is sent nowhere else;
	 *  - the body is sent at most once: no retry once it may have reached
	 *    the server (a refused connection may still try the next validated
	 *    address, as for a GET).
	 * Response handling (status, `maxBytes`, `timeoutMs`, `includeErrorBody`,
	 * decoding) is unchanged. The body may carry the owner's query: never log it.
	 */
	readonly jsonBody?: string;
}

/** Largest `SafeFetchOptions.jsonBody`, in UTF-8 bytes. */
export const MAX_JSON_BODY_BYTES = 64 * 1024;

/**
 * Outbound fetch with SSRF defences (SEC-002): https only, per-hop redirect
 * validation, byte and time limits, and a destination check the adapter can
 * actually enforce in its runtime.
 */
export interface SafeFetcher {
	fetchText(
		url: string,
		options: SafeFetchOptions,
	): Promise<Result<FetchedDocument, SafeFetchError>>;
}

export interface FeedParser {
	parse(text: string): Result<RawFeed, "NOT_A_FEED">;
}

/* ---------- Persistence ports. Every method is owner-scoped (API-004). ---------- */

export interface SourceRepository {
	list(ownerId: string): Promise<readonly NewsSource[]>;
	get(ownerId: string, sourceId: string): Promise<NewsSource | null>;
	findByCanonicalUrl(ownerId: string, canonicalUrl: string): Promise<NewsSource | null>;
	/** False when the owner already has a source with this canonical URL. */
	insert(ownerId: string, source: NewsSource): Promise<boolean>;
	update(
		ownerId: string,
		sourceId: string,
		patch: UpdateSourceRequest,
		updatedAt: string,
	): Promise<NewsSource | null>;
	delete(ownerId: string, sourceId: string): Promise<boolean>;
}

export interface ArticlePage {
	readonly articles: readonly Article[];
	readonly nextCursor: string | null;
}

export interface ArticleRepository {
	list(
		ownerId: string,
		query: {
			readonly sourceId: string | null;
			readonly cursor: string | null;
			readonly limit: number;
		},
	): Promise<ArticlePage>;
}

export interface JobRecord {
	readonly runId: string;
	readonly ownerId: string;
	readonly kind: JobKind;
	readonly state: JobState;
	/**
	 * The stored request: a research request for research jobs, `{ action }`
	 * for `google-calendar` jobs (FR-019 section 2.4), a notebook-assist
	 * request for `notebook-assist` jobs (ADR-0020), `{ market }` for
	 * `stock-directory-refresh` jobs (ADR-0034), null for the other refresh
	 * kinds. Only research requests carry an `agentId` — narrow with
	 * `"agentId" in request` before touching agent fields.
	 */
	readonly request:
		| ResearchRequest
		| GoogleCalendarRequest
		| NotebookAssistJobRequest
		| StockDirectoryJobRequest
		| null;
	readonly workspaceId: string | null;
	readonly usage: ResourceUsage;
	readonly attempt: number;
	readonly maxAttempts: number;
	readonly leaseGeneration: number;
	readonly leaseOwnerId: string | null;
	readonly leaseExpiresAt: string | null;
	/** Highest runner event sequence applied in the current lease generation. */
	readonly lastEventSeq: number;
	readonly cancelRequested: boolean;
	readonly failureCode: string | null;
	readonly failureDetail: string | null;
	/**
	 * The status the external service that caused the failure answered with,
	 * unchanged (docs/rule/error_handling.md §4a); null when no external
	 * answer caused it. Set and cleared together with `failureCode`.
	 */
	readonly failureUpstreamStatus: number | null;
	readonly approvalRequest: { readonly reasonCode: string; readonly detail: string } | null;
	readonly retryOfRunId: string | null;
	/**
	 * `seq` of the owner message that asked this run's question: the stable
	 * anchor the claim reads the bounded conversation context from BEFORE.
	 * Set atomically with the enqueue; inherited by a retry. Null for
	 * news-ingest jobs and for pre-migration/imported rows, which claim an
	 * empty context (fail closed, ARCH-017).
	 */
	readonly contextAnchorSeq: number | null;
	readonly verificationStatus: ResearchBundle["verificationStatus"] | null;
	readonly providerModel: string | null;
	readonly providerSessionRef: string | null;
	/** Lease generation whose completion was recorded; makes duplicate completion a no-op. */
	readonly completedGeneration: number | null;
	/** What produced the published result: backend, prompt and tool versions, data cut-off (AGT-010). */
	readonly provenance: ResearchBundle["provenance"] | null;
	/** Optimistic-concurrency version; every write is a compare-and-set on it. */
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/**
 * The stored request of a `stock-directory-refresh` job (ADR-0034): the one
 * market it downloads. Kept in the job's request column so the claim can
 * name the market and by-kind lookups can be narrowed to it.
 */
export interface StockDirectoryJobRequest {
	readonly market: WatchMarket;
}

/**
 * Narrows a by-kind job lookup to one market's `stock-directory-refresh`
 * jobs (ADR-0034: one active run per market, status per market).
 */
export interface JobKindScope {
	readonly market: WatchMarket;
}

/** Mutable job columns. Identity, kind, creation time and the retry link never change. */
export type JobPatch = Partial<
	Omit<JobRecord, "runId" | "ownerId" | "kind" | "version" | "createdAt" | "retryOfRunId">
>;

export interface TransitionAudit {
	readonly fromState: JobState;
	readonly toState: JobState;
	readonly actor: string;
	readonly reason: string;
}

export interface JobWrite {
	readonly runId: string;
	readonly expectedVersion: number;
	readonly patch: JobPatch;
	readonly audits: readonly TransitionAudit[];
	readonly at: string;
}

export interface ProgressEntry {
	readonly at: string;
	readonly kind: "state" | "note" | "tool";
	readonly text: string;
}

/**
 * Outcome of an enqueue. The unfinished-job cap is checked inside the same
 * statement that inserts, so concurrent requests cannot both slip under it.
 * S1 extends the same guarantee to "one active market-refresh job per owner":
 * the INSERT refuses a second one, reported as `kind-active` with that run.
 */
export type EnqueueResult =
	| { readonly kind: "inserted" }
	| { readonly kind: "existing"; readonly job: JobRecord; readonly sameRequest: boolean }
	| { readonly kind: "kind-active"; readonly job: JobRecord }
	| { readonly kind: "at-capacity" }
	/** The job names a workspace that no longer exists (deleted concurrently). */
	| { readonly kind: "no-workspace" };

export interface JobRepository {
	/**
	 * Inserts unless the owner already used this idempotency key, in which case
	 * the existing job is returned together with whether the request matched.
	 */
	insert(
		job: JobRecord,
		idempotencyKey: string,
		requestFingerprint: string,
		maxUnfinished: number,
	): Promise<EnqueueResult>;
	/** The job an idempotency key was already used for, with the fingerprint of that request. */
	findByIdempotencyKey(
		ownerId: string,
		idempotencyKey: string,
	): Promise<{ readonly job: JobRecord; readonly requestFingerprint: string } | null>;
	get(ownerId: string, runId: string): Promise<JobRecord | null>;
	list(
		ownerId: string,
		query: { readonly workspaceId: string | null; readonly limit: number },
	): Promise<readonly JobRecord[]>;
	/**
	 * The newest research request of this owner, if any. A narrow read for
	 * carrying the previous backend choice into unset agent settings: unlike
	 * `list` with a limit of 1 it skips news-ingest jobs, which carry no
	 * request and must never hide the most recent research run.
	 */
	findLatestResearchRequest(ownerId: string): Promise<ResearchRequest | null>;
	/** Pending jobs plus leased jobs whose lease expired, oldest first. */
	listClaimCandidates(
		ownerId: string,
		nowIso: string,
		limit: number,
	): Promise<readonly JobRecord[]>;
	/** Atomic compare-and-set with audit rows. False when the version moved on. */
	write(ownerId: string, write: JobWrite): Promise<boolean>;
	/** As `write`, also appending progress events idempotently on (run, generation, seq). */
	writeWithEvents(
		ownerId: string,
		write: JobWrite,
		leaseGeneration: number,
		events: readonly RunnerEvent[],
	): Promise<boolean>;
	listProgress(ownerId: string, runId: string, limit: number): Promise<readonly ProgressEntry[]>;
	/**
	 * Newest non-terminal job of a kind, if any (market-refresh
	 * de-duplication). With a scope, only jobs whose stored request names
	 * that market (`stock-directory-refresh`).
	 */
	findActiveByKind(ownerId: string, kind: JobKind, scope?: JobKindScope): Promise<JobRecord | null>;
	/**
	 * Newest non-terminal `notebook-assist` job of a conversation, if any
	 * (ADR-0020: one active assistant turn per conversation — a second
	 * instruction while one is queued or running answers 409).
	 */
	findActiveNotebookAssist(ownerId: string, workspaceId: string): Promise<JobRecord | null>;
	/**
	 * Completion time of the newest COMPLETED job of a kind, if any (S2: a
	 * failed or cancelled refresh is never presented as a success).
	 */
	findLatestSuccessAtByKind(
		ownerId: string,
		kind: JobKind,
		scope?: JobKindScope,
	): Promise<string | null>;
	/**
	 * Newest terminal job of a kind that did not succeed, if any (S2: state +
	 * stable failure code + time for the "last refresh failed" line).
	 */
	findLatestFailureByKind(
		ownerId: string,
		kind: JobKind,
		scope?: JobKindScope,
	): Promise<{
		readonly state: string;
		readonly failureCode: string | null;
		/** The job's `failureUpstreamStatus` (§4a). */
		readonly failureUpstreamStatus: number | null;
		readonly at: string;
	} | null>;
	/**
	 * Newest job of a kind in state `failed` (cancelled runs excluded: an
	 * owner's cancel is neither a failure nor hides one), with its stable
	 * code and the API's own completion time. ADR-0034 status.
	 */
	findLatestFailedByKind(
		ownerId: string,
		kind: JobKind,
		scope?: JobKindScope,
	): Promise<{
		readonly failureCode: string | null;
		/** The job's `failureUpstreamStatus` (§4a). */
		readonly failureUpstreamStatus: number | null;
		readonly at: string;
	} | null>;
	/** How many of the owner's jobs are not in a terminal state (admission pre-check). */
	countUnfinished(ownerId: string): Promise<number>;
}

export interface AppliedCommand {
	readonly version: number;
	readonly command: UiCommand;
	readonly appliedAt: string;
	readonly origin: "owner" | "agent";
}

export interface WorkspaceRecord {
	readonly summary: WorkspaceSummary;
	readonly state: WorkspaceState;
}

export interface WorkspaceWrite {
	readonly workspaceId: string;
	readonly expectedVersion: number;
	readonly nextState: WorkspaceState;
	readonly commands: readonly AppliedCommand[];
	readonly at: string;
}

export interface WorkspaceRepository {
	list(ownerId: string): Promise<readonly WorkspaceSummary[]>;
	get(ownerId: string, workspaceId: string): Promise<WorkspaceRecord | null>;
	insert(ownerId: string, record: WorkspaceRecord): Promise<void>;
	/**
	 * Renames a conversation. Only the title and `updatedAt` change: the canvas
	 * `version` is untouched, so a rename never conflicts with command writes.
	 * Null when the owner has no such workspace.
	 */
	rename(
		ownerId: string,
		workspaceId: string,
		title: string,
		updatedAt: string,
	): Promise<WorkspaceSummary | null>;
	/** Every workspace record of this owner, for reference scans (conversation delete). */
	listRecords(ownerId: string): Promise<readonly WorkspaceRecord[]>;
	findCommand(
		ownerId: string,
		workspaceId: string,
		commandId: string,
	): Promise<AppliedCommand | null>;
	/**
	 * Atomic compare-and-set on the workspace version plus command history.
	 * "duplicate-command" means a concurrent request already applied a command id.
	 */
	write(
		ownerId: string,
		write: WorkspaceWrite,
	): Promise<"written" | "version-conflict" | "duplicate-command">;
	listCommandsAfter(
		ownerId: string,
		workspaceId: string,
		afterVersion: number,
		limit: number,
	): Promise<readonly AppliedCommand[]>;
}

export interface ReferenceLookup {
	readonly datasetIds: readonly string[];
	readonly evidenceIds: readonly string[];
	readonly claimIds: readonly string[];
}

export interface ResolvedReferences {
	readonly datasets: readonly Dataset[];
	readonly evidence: readonly Evidence[];
	readonly claims: readonly Claim[];
}

export interface ResearchRecordRepository {
	/** Loads whichever of the requested ids this owner stores; unknown ids are simply absent. */
	resolve(ownerId: string, lookup: ReferenceLookup): Promise<ResolvedReferences>;
	recordsForRuns(ownerId: string, runIds: readonly string[]): Promise<RunRecords>;
	claimsByIds(ownerId: string, claimIds: readonly string[]): Promise<readonly Claim[]>;
	/** Run ids that produced records in a workspace, for export. */
	runIdsForWorkspace(ownerId: string, workspaceId: string): Promise<readonly string[]>;
	datasetsForWorkspace(ownerId: string, workspaceId: string): Promise<readonly Dataset[]>;
}

export interface ChatQuery {
	readonly beforeSeq: number | null;
	readonly limit: number;
}

export interface ChatRepository {
	list(ownerId: string, workspaceId: string, query: ChatQuery): Promise<readonly ChatMessage[]>;
	/**
	 * The message of one run (an owner's question or an assistant answer),
	 * null when none is stored. Used to answer an idempotent
	 * `notebook-assist` replay with the same owner message.
	 */
	findByRunId(ownerId: string, workspaceId: string, runId: string): Promise<ChatMessage | null>;
	/**
	 * One row per workspace of this owner, newest activity first. Implemented as
	 * a single SQL statement (no per-workspace query), so a large library still
	 * costs one round trip.
	 */
	listConversations(ownerId: string, limit: number): Promise<readonly ConversationSummary[]>;
}

/** What a finished job writes besides its own row; committed all-or-nothing with it. */
export interface MarketCompletionSeries {
	readonly seriesId: string;
	readonly provider: MarketProviderId;
	readonly symbol: string;
	readonly fetchedAt: string;
	readonly meta: {
		readonly title: string;
		readonly unit: string;
		readonly frequency: MarketFrequency;
		readonly publisher: string;
		readonly sourceUrl: string;
	} | null;
	readonly observations: readonly { readonly observedOn: string; readonly value: number }[];
	readonly errorCode: MarketUnavailableCode | null;
	/** The provider's answer status behind `errorCode`, unchanged (§4a); null otherwise. */
	readonly upstreamStatus: number | null;
}

/** What a finished earnings-refresh job writes; committed all-or-nothing with it. */
export interface EarningsCompletionStock {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
	readonly fetchedAt: string;
	readonly name: string | null;
	readonly events: readonly EarningsEvent[];
	readonly errorCode: EarningsUnavailableCode | null;
	/** The provider's answer status behind `errorCode`, unchanged (§4a); null otherwise. */
	readonly upstreamStatus: number | null;
}

export interface CompletionEffects {
	readonly bundle: ResearchBundle | null;
	readonly articles: readonly Article[];
	readonly sourceReports: readonly {
		readonly sourceId: string;
		readonly fetchedAt: string;
		readonly errorCode: string | null;
		/** The feed host's answer status behind `errorCode`, unchanged (§4a); absent from older runners. */
		readonly upstreamStatus?: number | null;
	}[];
	readonly workspace: WorkspaceWrite | null;
	readonly assistantMessage: {
		readonly messageId: string;
		readonly workspaceId: string;
		readonly text: string;
		readonly claimIds: readonly string[];
	} | null;
	readonly marketSeries: readonly MarketCompletionSeries[];
	readonly earnings: readonly EarningsCompletionStock[];
	/**
	 * Google Calendar link patch committed with the job (FR-019): null for
	 * every other kind. Computed by the service from the current link row,
	 * so the SQL stays a dumb guarded upsert.
	 */
	readonly google: GoogleCalendarLinkPatch | null;
	/**
	 * Notebook write committed with a `notebook-assisted` completion
	 * (ADR-0020): the stamped body stored at `expectedVersion`. Null when the
	 * turn applied nothing (the notebook moved, the commands were invalid, or
	 * the turn only proposes removals) — then only `notebookTurn` and the
	 * assistant message commit.
	 */
	readonly notebook: {
		readonly workspaceId: string;
		readonly expectedVersion: number;
		readonly notebook: Notebook;
		readonly updatedAt: string;
	} | null;
	/** The recorded assistant turn of a `notebook-assisted` completion, if any. */
	readonly notebookTurn: { readonly workspaceId: string; readonly turn: NotebookTurn } | null;
	/**
	 * One market's full stock list of a `stock-directory-refreshed`
	 * completion (ADR-0034), replacing that market's stored rows all or
	 * nothing; null for every other outcome.
	 */
	readonly stockDirectory: StockDirectoryCompletion | null;
}

export type CompletionCommitResult =
	| { readonly kind: "committed"; readonly newArticleCount: number }
	| { readonly kind: "job-conflict" }
	| { readonly kind: "workspace-conflict" }
	/** The job compare-and-set won but the notebook moved past `expectedVersion`. */
	| { readonly kind: "notebook-conflict" };

/**
 * Ownership rule for conversation deletion. A conversation owns directly: its
 * workspace row, canvas commands, chat messages and run links. It owns
 * indirectly, through its runs: the jobs (with transitions and events) whose
 * `workspace_id` is the conversation or which its run links name (the latter
 * covers imported runs, which have records but no job row), and the evidence,
 * claims, claim edges, research records and datasets written under those run
 * ids. Owner-global rows — news sources, articles, settings,
 * credentials, rate limits, audit trail — are never touched. A run-scoped row
 * whose id the caller lists in `keep*` (still referenced by a surviving
 * conversation's canvas) survives: the delete removes only unreferenced rows.
 */
export interface DeleteWorkspaceInput {
	readonly ownerId: string;
	readonly workspaceId: string;
	/** Evidence ids still referenced by a surviving conversation; never deleted. */
	readonly keepEvidenceIds: readonly string[];
	/** Dataset ids still referenced by a surviving conversation; never deleted. */
	readonly keepDatasetIds: readonly string[];
	/** Claim ids still referenced by a surviving conversation; never deleted. */
	readonly keepClaimIds: readonly string[];
}

export type DeleteWorkspaceOutcome = "deleted" | "not-found" | "has-unfinished";

/**
 * Cross-aggregate atomic writes. Kept as one port because the guarantee that
 * matters — a job and its effects commit together or not at all — spans tables.
 */
export interface ResearchUnitOfWork {
	/** Creates the job and the owner's chat message together. */
	enqueueResearch(input: {
		readonly job: JobRecord;
		readonly idempotencyKey: string;
		readonly requestFingerprint: string;
		readonly ownerMessage: { readonly messageId: string; readonly text: string };
		readonly maxUnfinished: number;
	}): Promise<EnqueueResult>;
	commitCompletion(
		ownerId: string,
		jobWrite: JobWrite,
		effects: CompletionEffects,
	): Promise<CompletionCommitResult>;
	/** Imports a portable export as a brand-new workspace. */
	importWorkspace(input: {
		readonly ownerId: string;
		readonly record: WorkspaceRecord;
		readonly importRunId: string;
		readonly records: RunRecords;
		readonly datasets: readonly Dataset[];
		readonly messages: readonly ChatMessage[];
		readonly at: string;
	}): Promise<void>;
	/**
	 * Deletes a conversation and everything it solely owns (see
	 * `DeleteWorkspaceInput` for the ownership rule). The unfinished-run check
	 * and every removal commit in one atomic batch: either the conversation is
	 * gone with all its owned rows, or nothing changed. "has-unfinished" means
	 * a run of this conversation is not in a terminal state and nothing was
	 * deleted.
	 */
	deleteWorkspace(input: DeleteWorkspaceInput): Promise<DeleteWorkspaceOutcome>;
	/**
	 * Inserts a scheduled task and its new conversation together (ADR-0033
	 * §7). The limits — at most `maxTasks` tasks, and at most `maxActive`
	 * active ones when the task is active — are checked inside the guarded
	 * insert, so concurrent creates cannot both slip under them; "full" means
	 * nothing was written.
	 */
	createScheduledTask(input: {
		readonly ownerId: string;
		readonly workspace: WorkspaceRecord;
		readonly task: StoredScheduledTask;
		readonly maxTasks: number;
		readonly maxActive: number;
	}): Promise<CreateScheduledTaskOutcome>;
}

/* ---------- Scheduled tasks (ADR-0033) ---------- */

/** A stored scheduled task: the contract's fields without the joined last-run view. */
export interface StoredScheduledTask {
	readonly ownerId: string;
	readonly taskId: string;
	readonly workspaceId: string;
	readonly title: string;
	readonly question: string;
	readonly horizonYears: 3 | 4 | 5;
	readonly markets: readonly ResearchMarket[];
	readonly schedule: TaskSchedule;
	readonly timeZone: string;
	readonly spendConsent: TaskSpendConsent | null;
	readonly status: TaskStatus;
	/** Null unless active. */
	readonly nextRunAt: string | null;
	readonly lastRunId: string | null;
	/** The slot the last run was queued for; null for a "Run now" (or no run yet). */
	readonly lastSlotAt: string | null;
	readonly lastQueuedAt: string | null;
	readonly lastSkip: TaskSkip | null;
	/** Compare-and-set version; every write bumps it by one. */
	readonly version: number;
	readonly createdAt: string;
	readonly updatedAt: string;
}

/** Mutable task columns; identity, owner, conversation and creation time never change. */
export type ScheduledTaskPatch = Partial<
	Omit<StoredScheduledTask, "ownerId" | "taskId" | "workspaceId" | "version" | "createdAt">
>;

/** The joined state of a task's last run (the list's one join; null when it has none or it is gone). */
export interface ScheduledTaskRunState {
	readonly state: JobState;
	readonly failureCode: string | null;
	readonly failureUpstreamStatus: number | null;
}

export interface ScheduledTaskRepository {
	/**
	 * Every task of the owner with its last run's state, in one query (no
	 * N+1): active first by `next_run_at`, then paused, then completed,
	 * newest first within those two.
	 */
	list(ownerId: string): Promise<
		readonly {
			readonly task: StoredScheduledTask;
			readonly lastRun: ScheduledTaskRunState | null;
		}[]
	>;
	get(ownerId: string, taskId: string): Promise<StoredScheduledTask | null>;
	/** Active tasks with `next_run_at <= nowIso`, earliest first, at most `limit` (the claim's due scan). */
	listDue(ownerId: string, nowIso: string, limit: number): Promise<readonly StoredScheduledTask[]>;
	/** How many tasks the owner has, and how many are active (create/resume limits). */
	counts(ownerId: string): Promise<{ readonly total: number; readonly active: number }>;
	/**
	 * Compare-and-set: writes the patch and `version + 1` only when the stored
	 * version is `expectedVersion`. False when it moved on (or the task is gone).
	 * A patch that makes the task active is refused (false) when that would
	 * exceed `maxActive` active tasks — checked inside the same statement.
	 */
	write(
		ownerId: string,
		taskId: string,
		expectedVersion: number,
		patch: ScheduledTaskPatch,
		at: string,
		maxActive: number,
	): Promise<boolean>;
	/** Removes the task (its conversation stays). False when there was none. */
	delete(ownerId: string, taskId: string): Promise<boolean>;
}

export type CreateScheduledTaskOutcome = "created" | "full";

export interface StoredRunnerCredential extends RunnerCredential {
	readonly ownerId: string;
}

export interface RunnerCredentialRepository {
	list(ownerId: string): Promise<readonly RunnerCredential[]>;
	insert(ownerId: string, credential: RunnerCredential, tokenHash: string): Promise<void>;
	revoke(ownerId: string, credentialId: string, revokedAt: string): Promise<boolean>;
	/** Resolves a live (unexpired, unrevoked) credential by token hash and stamps last-used. */
	authenticate(tokenHash: string, nowIso: string): Promise<StoredRunnerCredential | null>;
	/** Replaces the token hash and expiry of a live credential. */
	rotate(
		ownerId: string,
		credentialId: string,
		tokenHash: string,
		expiresAt: string,
	): Promise<RunnerCredential | null>;
}

export interface RunnerStatus {
	readonly lastSeenAt: string;
	readonly runnerVersion: string;
	readonly agents: readonly AgentDescriptor[];
}

export interface RunnerStatusRepository {
	get(ownerId: string): Promise<RunnerStatus | null>;
	put(ownerId: string, status: RunnerStatus): Promise<void>;
}

export interface StoredAgentSettings {
	readonly settings: AgentSettings;
	readonly updatedAt: string;
}

export interface SettingsRepository {
	getAgentSettings(ownerId: string): Promise<StoredAgentSettings | null>;
	/** Insert or replace; last write wins (a single owner edits one form). */
	putAgentSettings(ownerId: string, settings: AgentSettings, updatedAt: string): Promise<void>;
}

export interface RateLimiter {
	/** Counts one event in the bucket's current window; false once `limit` is exceeded. */
	consume(input: {
		readonly ownerId: string;
		readonly bucket: string;
		readonly limit: number;
		readonly windowMs: number;
		readonly nowMs: number;
	}): Promise<boolean>;
}

export interface AuditEntry {
	readonly ownerId: string;
	readonly actor: string;
	readonly action: string;
	readonly resource: string;
	/** Must already be redacted: ids and codes only, never secrets or licensed text. */
	readonly detail: string;
	readonly at: string;
}

export interface AuditLog {
	record(entry: AuditEntry): Promise<void>;
}

export interface StoredMarketSeries {
	readonly seriesId: string;
	readonly provider: MarketProviderId;
	readonly symbol: string;
	readonly title: string;
	readonly unit: string;
	readonly frequency: MarketFrequency;
	readonly publisher: string;
	readonly sourceUrl: string;
	readonly lastRefreshedAt: string | null;
	readonly retrievedAt: string | null;
	readonly unavailableCode: MarketUnavailableCode | null;
	/** The provider's answer status behind `unavailableCode`, unchanged (§4a). */
	readonly unavailableUpstreamStatus: number | null;
}

export interface StoredMarketObservation {
	readonly seriesId: string;
	readonly observedOn: string;
	readonly value: number;
}

export interface HomeDashboardRecord {
	readonly dashboard: HomeDashboard;
	readonly version: number;
	readonly updatedAt: string | null;
}

export interface HomeDashboardRepository {
	/**
	 * The stored dashboard, null when never saved, or "unreadable" when the
	 * stored document no longer parses (fail closed — never the defaults).
	 */
	get(ownerId: string): Promise<HomeDashboardRecord | null | "unreadable">;
	/** Compare-and-set on version; insert when absent and expectedVersion === 0. */
	put(
		ownerId: string,
		dashboard: HomeDashboard,
		expectedVersion: number,
		updatedAt: string,
	): Promise<"written" | "version-conflict">;
	/**
	 * Unconditional replace with the given dashboard (V2: the way out when the
	 * stored document no longer parses — no expectedVersion is needed because
	 * the owner explicitly discards whatever is stored). Returns the new record.
	 */
	reset(ownerId: string, dashboard: HomeDashboard, updatedAt: string): Promise<HomeDashboardRecord>;
}

export interface MarketRepository {
	getSeriesMeta(
		ownerId: string,
		seriesIds: readonly string[],
	): Promise<readonly StoredMarketSeries[]>;
	/** Newest stored observation date per series (missing series are absent). */
	getLatestObservedOn(
		ownerId: string,
		seriesIds: readonly string[],
	): Promise<ReadonlyMap<string, string>>;
	/** Newest `limitPerSeries` observations per series, ascending by date. */
	getObservations(
		ownerId: string,
		seriesIds: readonly string[],
		limitPerSeries: number,
	): Promise<readonly StoredMarketObservation[]>;
	/**
	 * Deletes stored series rows and their observations that are no longer
	 * referenced by the owner's dashboard (S4b: set-based, same batch as the
	 * dashboard write — completions never accumulate series that left).
	 * Returns the number of deleted series rows.
	 */
	deleteSeriesNotIn(ownerId: string, keepSeriesIds: readonly string[]): Promise<number>;
}

/* ---------- Notebook of one conversation (ADR-0020) ---------- */

export interface NotebookRecord {
	readonly notebook: Notebook;
	readonly version: number;
	readonly updatedAt: string | null;
}

export interface NotebookRepository {
	/**
	 * The stored notebook, null when never saved, or "unreadable" when the
	 * stored document no longer parses (fail closed — never the defaults).
	 */
	get(ownerId: string, workspaceId: string): Promise<NotebookRecord | null | "unreadable">;
	/**
	 * Compare-and-set on version; inserts when absent and expectedVersion is
	 * 0. One write is one statement batch (current row + revision + prune)
	 * with the version check in the WHERE clause, so two concurrent writers
	 * cannot both succeed.
	 */
	put(
		ownerId: string,
		workspaceId: string,
		notebook: Notebook,
		expectedVersion: number,
		updatedAt: string,
	): Promise<"written" | "version-conflict">;
	/** The body stored for one version, null when no body is kept for it. */
	getRevision(ownerId: string, workspaceId: string, version: number): Promise<Notebook | null>;
	/** The latest assistant turns, oldest first, at most `limit`. */
	listTurns(ownerId: string, workspaceId: string, limit: number): Promise<readonly NotebookTurn[]>;
	/**
	 * Distinct market series ids named by the owner's notebooks' market
	 * widgets (all conversations), read from the stored notebook bodies in
	 * one set-based statement (no N+1), sorted, invalid ids dropped
	 * (ADR-0021: stored data is parsed at the boundary). Unreadable bodies
	 * are skipped, never fatal: the refresh keeps working while the single
	 * notebook read still reports them.
	 */
	listMarketSeriesIds(ownerId: string): Promise<readonly string[]>;
}

/* ---------- Stock directory storage and search (ADR-0034) ---------- */

/** One stored listed stock, as searched and shown. */
export interface StoredStockDirectoryEntry extends StockSearchRow {
	readonly listing: StockListing;
}

/**
 * One row as a completion writes it: the entry plus its folded search keys,
 * computed in TypeScript (`stockSearchKeys`, `stockSearchHaystack`) so the
 * SQL ranking reads exactly the keys the domain reference computes.
 */
export interface StockDirectoryRow extends StoredStockDirectoryEntry, StockSearchKeys {
	/** `stockSearchHaystack` of the keys: every query term must be a substring of it. */
	readonly searchKey: string;
}

/** What a `stock-directory-refreshed` completion stores; committed with its job. */
export interface StockDirectoryCompletion {
	readonly market: WatchMarket;
	readonly asOf: string | null;
	readonly retrievedAt: string;
	/** The `STOCK_SEARCH_FOLD_VERSION` the rows' keys were computed with. */
	readonly foldVersion: number;
	/** Distinct symbols of `market`, at most `STOCK_DIRECTORY_LIMITS.maxEntriesPerMarket`. */
	readonly rows: readonly StockDirectoryRow[];
}

/** One market's stored list header; absent before the first successful refresh. */
export interface StockDirectoryMeta {
	readonly market: WatchMarket;
	readonly entryCount: number;
	readonly asOf: string | null;
	readonly retrievedAt: string;
	/** The `STOCK_SEARCH_FOLD_VERSION` the stored keys were computed with. */
	readonly foldVersion: number;
}

/** New keys for one market's stored rows, computed with the current fold. */
export interface StockDirectoryRekey {
	readonly market: WatchMarket;
	/** Every stored row of the market, with its keys recomputed. */
	readonly rows: readonly StockDirectoryRow[];
	/** The version the meta row must still hold for the version stamp to move. */
	readonly fromVersion: number;
	readonly toVersion: number;
}

export interface StockDirectoryRepository {
	/**
	 * The owner's stored rows matching `query`, ranked: exactly
	 * `rankStockSearch(rows, query, limit)` over the stored rows of `market`
	 * (both markets when null). Empty for a blank query or no stored list.
	 */
	search(
		ownerId: string,
		query: { readonly text: string; readonly market: WatchMarket | null; readonly limit: number },
	): Promise<readonly StoredStockDirectoryEntry[]>;
	/** One stored row, null when the market's list does not hold the symbol. */
	getEntry(
		ownerId: string,
		market: WatchMarket,
		symbol: string,
	): Promise<StoredStockDirectoryEntry | null>;
	/** The meta row of every market that has a stored list. */
	listMeta(ownerId: string): Promise<readonly StockDirectoryMeta[]>;
	/** Every stored row of one market (for re-keying after a fold change). */
	listEntries(ownerId: string, market: WatchMarket): Promise<readonly StoredStockDirectoryEntry[]>;
	/**
	 * Writes recomputed keys in one atomic batch. A key is written only to a
	 * row whose symbol, name and local name still equal the ones it was
	 * computed from, so a list replaced concurrently never receives keys of
	 * the old names; the meta version moves from `fromVersion` to
	 * `toVersion` by compare-and-set.
	 */
	storeKeys(ownerId: string, rekey: StockDirectoryRekey): Promise<void>;
}

/* ---------- Watchlist and earnings calendar (FR-018; section 4) ---------- */

export interface StoredWatchlistStock {
	readonly stockId: string;
	readonly market: WatchMarket;
	readonly symbol: string;
	/** The provider's company name once a refresh has returned one. */
	readonly name: string | null;
	readonly addedAt: string;
	/** Last refresh attempt; null when never attempted. */
	readonly lastRefreshedAt: string | null;
	/** Last successful refresh; null when none has succeeded. */
	readonly retrievedAt: string | null;
	readonly unavailableCode: EarningsUnavailableCode | null;
	/** The provider's answer status behind `unavailableCode`, unchanged (§4a). */
	readonly unavailableUpstreamStatus: number | null;
}

export interface StoredEarningsEvent {
	readonly stockId: string;
	readonly periodKey: string;
	/** Null when the source lists the announcement with the date undecided. */
	readonly announcementDate: string | null;
	readonly fiscalPeriodLabel: string;
	readonly fiscalPeriodEnd: string | null;
	readonly timing: EarningsTiming;
}

export interface WatchlistRepository {
	/** Stocks in the order they were added. */
	listStocks(ownerId: string): Promise<readonly StoredWatchlistStock[]>;
	getStock(ownerId: string, stockId: string): Promise<StoredWatchlistStock | null>;
	countStocks(ownerId: string): Promise<number>;
	/**
	 * Adds the stock, enforcing the cap inside the INSERT itself (like the
	 * job insert enforces its capacity): `"added"` when the row was written,
	 * `"already-present"` when the stock was already there (an idempotent
	 * add changes nothing, ARCH-016 — reported even when the list is full),
	 * `"full"` when the list already holds `maxStocks` other stocks and
	 * nothing was written. Two interleaved adds cannot both slip under the
	 * cap: the loser reports `"full"`.
	 */
	insertStock(
		ownerId: string,
		stock: {
			readonly stockId: string;
			readonly market: WatchMarket;
			readonly symbol: string;
			/**
			 * The stock directory's company name when the directory holds the
			 * stock (ADR-0034), else null; never overwrites an existing row.
			 */
			readonly name: string | null;
			readonly addedAt: string;
		},
		maxStocks: number,
	): Promise<WatchlistInsertOutcome>;
	/**
	 * Removes the stock and its events atomically (one batch); false when the
	 * stock is unknown.
	 */
	removeStock(ownerId: string, stockId: string): Promise<boolean>;
}

/**
 * Outcome of an attempted watchlist add. The service audits `"added"` only,
 * so a lost race writes no second audit row.
 */
export type WatchlistInsertOutcome = "added" | "already-present" | "full";

export interface EarningsRepository {
	/** Events for the given stocks, dated ascending then undecided last per stock. */
	getEvents(ownerId: string, stockIds: readonly string[]): Promise<readonly StoredEarningsEvent[]>;
}

export interface CalendarFeedRecord {
	readonly tokenHash: string;
	readonly createdAt: string;
}

export interface CalendarFeedRepository {
	/** The owner's feed, null when no feed was issued (or after revocation). */
	get(ownerId: string): Promise<CalendarFeedRecord | null>;
	/** Issues or rotates: replaces any previous token hash. Only the hash is stored. */
	put(ownerId: string, tokenHash: string, createdAt: string): Promise<void>;
	/** Revokes the feed; false when there was none. */
	revoke(ownerId: string): Promise<boolean>;
	/** The owner holding this token hash, null when unknown or revoked. */
	findOwnerByTokenHash(tokenHash: string): Promise<string | null>;
}

/* ---------- Google Calendar sync link (FR-019 section 2.5) ---------- */

export type GoogleCalendarLinkStatus =
	| "disconnected"
	| "connecting"
	| "connected"
	| "needs-reconnect";

/**
 * The owner's Google Calendar sync state. There is deliberately NO token
 * field — ever: the refresh token lives only in the runner-side 0600 file.
 * `pendingAuthUrl` is the sign-in URL (client id, redirect port, state and
 * PKCE challenge only — none of them a credential), present only while
 * connecting. Failure fields carry a stable `GOOGLE_*` code, never provider
 * text.
 */
export interface GoogleCalendarLink {
	readonly status: GoogleCalendarLinkStatus;
	/** Status a connect run started from; restored when it fails or is cancelled. */
	readonly connectFrom: GoogleCalendarLinkStatus | null;
	readonly pendingAuthUrl: string | null;
	readonly calendarId: string | null;
	readonly connectedAt: string | null;
	readonly lastSyncedAt: string | null;
	readonly syncedDigest: string | null;
	readonly lastSync: {
		readonly inserted: number;
		readonly updated: number;
		readonly deleted: number;
		readonly unchanged: number;
	} | null;
	readonly lastFailureCode: string | null;
	/** Google's answer status behind `lastFailureCode`, unchanged (§4a); cleared with it. */
	readonly lastFailureUpstreamStatus: number | null;
	readonly lastFailureAt: string | null;
	readonly updatedAt: string;
}

/** Column patch for the link row; absent fields are left untouched. */
export interface GoogleCalendarLinkPatch {
	readonly status?: GoogleCalendarLinkStatus;
	readonly connectFrom?: GoogleCalendarLinkStatus | null;
	readonly pendingAuthUrl?: string | null;
	readonly calendarId?: string | null;
	readonly connectedAt?: string | null;
	readonly lastSyncedAt?: string | null;
	readonly syncedDigest?: string | null;
	readonly lastSync?: GoogleCalendarLink["lastSync"];
	readonly lastFailureCode?: string | null;
	readonly lastFailureUpstreamStatus?: number | null;
	readonly lastFailureAt?: string | null;
}

export interface GoogleCalendarRepository {
	/** The owner's link row, null when never connected (disconnected). */
	get(ownerId: string): Promise<GoogleCalendarLink | null>;
	/**
	 * Starts a connect: upserts the row as `connecting`, remembering the
	 * previous status and clearing any pending URL.
	 */
	setConnecting(
		ownerId: string,
		input: { readonly connectFrom: GoogleCalendarLinkStatus; readonly at: string },
	): Promise<void>;
	/** Stores the runner-reported sign-in URL (only while connecting). */
	setPendingAuthUrl(ownerId: string, url: string, at: string): Promise<void>;
	/** Applies a completion's patch (upsert; absent fields stay as they are). */
	apply(ownerId: string, patch: GoogleCalendarLinkPatch, at: string): Promise<void>;
}

/* ---------- Market data source (section 4.1; Phase A wires "unconfigured" only) ---------- */

export interface MarketSeriesMeta {
	readonly title: string;
	readonly unit: string;
	readonly frequency: MarketFrequency;
	readonly publisher: string;
	readonly sourceUrl: string;
}

export interface MarketSeriesPoint {
	readonly observedOn: string;
	readonly value: number;
}

export interface MarketSourceUnavailable {
	readonly code: MarketUnavailableCode;
	readonly reason: string;
	/** The provider's answer status behind `code`, unchanged; null when it did not answer (§4a). */
	readonly upstreamStatus: number | null;
}

/** Source-neutral fetch port; adapters implement it per provider (ARCH-006). */
export interface MarketSeriesSource {
	readonly providerId: MarketProviderId;
	fetchSeries(query: {
		readonly symbol: string;
		readonly since: string | null;
		readonly maxObservations: number;
		readonly signal: AbortSignal;
	}): Promise<
		Result<
			{ readonly meta: MarketSeriesMeta; readonly observations: readonly MarketSeriesPoint[] },
			MarketSourceUnavailable
		>
	>;
}

/** Registry of providers keyed by id; adding a provider adds an entry, not a switch. */
export type MarketSourceRegistry = ReadonlyMap<MarketProviderId, MarketSeriesSource>;

/**
 * A source that always reports the provider as not configured. Used until a
 * keyed adapter is wired (Phase B); the runner then honestly reports every
 * series of that provider as SOURCE_NOT_CONFIGURED.
 */
export function unconfiguredMarketSeriesSource(
	providerId: MarketProviderId,
	reason: string,
): MarketSeriesSource {
	return {
		providerId,
		fetchSeries: () =>
			Promise.resolve({
				ok: false as const,
				error: {
					code: "SOURCE_NOT_CONFIGURED",
					reason,
					upstreamStatus: null,
				} satisfies MarketSourceUnavailable,
			}),
	};
}

/* ---------- Earnings calendar sources (FR-018 Phase A: ports only) ---------- */

export interface EarningsCalendarStock {
	readonly symbol: string;
	readonly needName: boolean;
}

export interface EarningsCalendarQuery {
	readonly stocks: readonly EarningsCalendarStock[];
	readonly fromDate: string;
	readonly toDate: string;
	readonly signal: AbortSignal;
	/**
	 * Admits one HTTP request start (API-007): the adapter calls this
	 * immediately before EVERY request it sends (never for cached reads that
	 * send nothing) and sends nothing when it resolves false (the signal
	 * aborted while waiting). Built by the runner from the shared pacer —
	 * Finnhub 30 starts per 60 s, JPX 6 per 60 s — never by the adapter
	 * itself, so one window is shared across jobs.
	 */
	readonly beforeRequest: () => Promise<boolean>;
}

export interface EarningsCalendarResult {
	readonly name: string | null;
	readonly events: readonly EarningsEvent[];
}

/**
 * One symbol's failure. `NO_SCHEDULED_DATE` is a successful retrieval with
 * nothing listed (not a failed attempt): it alone may carry the company
 * `name`, so a stock without an upcoming date still gets its name and the
 * profile is not requested again. Every other code carries no name.
 */
export type EarningsSourceFailure =
	| {
			readonly code: Exclude<EarningsUnavailableCode, "NO_SCHEDULED_DATE">;
			/** The provider's answer status behind `code`, unchanged; null when it did not answer (§4a). */
			readonly upstreamStatus: number | null;
	  }
	| { readonly code: "NO_SCHEDULED_DATE"; readonly name: string | null };

/** One result per requested symbol, in the same order. */
export type EarningsSourceResult = Result<EarningsCalendarResult, EarningsSourceFailure>;

/** Source-neutral earnings-date fetch port; adapters implement it per source (ARCH-006). */
export interface EarningsCalendarSource {
	readonly sourceId: EarningsSourceId;
	/** One result per requested symbol, in the same order. */
	fetchEarnings(query: EarningsCalendarQuery): Promise<readonly EarningsSourceResult[]>;
}

/** Registry of earnings sources keyed by id; adding a source adds an entry, not a switch. */
export type EarningsSourceRegistry = ReadonlyMap<EarningsSourceId, EarningsCalendarSource>;

export interface EarningsSourceUnavailable {
	readonly code: EarningsUnavailableCode;
	readonly reason: string;
	/** The provider's answer status behind `code`, unchanged; null when it did not answer (§4a). */
	readonly upstreamStatus: number | null;
}

/**
 * A source that always reports itself as not configured. Used until the
 * keyed adapter is wired; the runner then honestly reports every stock of
 * that source as SOURCE_NOT_CONFIGURED. The error carries the code only —
 * the API derives the fixed wording from the code and source id.
 */
export function unconfiguredEarningsCalendarSource(
	sourceId: EarningsSourceId,
): EarningsCalendarSource {
	return {
		sourceId,
		fetchEarnings: (query) =>
			Promise.resolve(
				query.stocks.map(
					(): EarningsSourceResult => ({
						ok: false as const,
						error: { code: "SOURCE_NOT_CONFIGURED", upstreamStatus: null },
					}),
				),
			),
	};
}

/* ---------- Stock directory (ADR-0034: every listed US / JP stock) ---------- */

export interface StockDirectoryQuery {
	readonly signal: AbortSignal;
	/**
	 * Admits one HTTP request start, exactly like `EarningsCalendarQuery`:
	 * called immediately before every request; nothing is sent when it
	 * resolves false. Built by the runner from the shared pacer (SEC and JPX
	 * share their windows with the other jobs that reach those hosts).
	 */
	readonly beforeRequest: () => Promise<boolean>;
}

export interface StockDirectoryData {
	/** The date the source says the list is effective (JPX); null when it states none (SEC). */
	readonly asOf: string | null;
	/** Every kept row, distinct symbols, already filtered to the market's listings. */
	readonly entries: readonly StockDirectoryEntry[];
}

/**
 * Why a market's list could not be downloaded. `upstreamStatus` is the
 * status SEC or JPX answered with, unchanged; null when it did not answer
 * with one (not configured, a timeout, a file that did not parse) (§4a).
 */
export interface StockDirectoryFailure {
	readonly code: StockDirectoryFailureCode;
	readonly upstreamStatus: number | null;
}

/** Downloads one market's full list; adapters implement it per market (SEC, JPX). */
export interface StockDirectorySource {
	readonly market: WatchMarket;
	fetchDirectory(
		query: StockDirectoryQuery,
	): Promise<Result<StockDirectoryData, StockDirectoryFailure>>;
}

/** Registry keyed by market; the runner looks the leased market up here. */
export type StockDirectorySourceRegistry = ReadonlyMap<WatchMarket, StockDirectorySource>;

/**
 * A source that always reports `DIRECTORY_NOT_CONFIGURED` (US without
 * `SEC_USER_AGENT`), so the job fails with a stable code instead of sending
 * an undeclared User-Agent to SEC.
 */
export function unconfiguredStockDirectorySource(market: WatchMarket): StockDirectorySource {
	return {
		market,
		fetchDirectory: () =>
			Promise.resolve(err({ code: "DIRECTORY_NOT_CONFIGURED", upstreamStatus: null })),
	};
}

/* ---------- Narrow binary fetch (FR-018: workbooks; the runner is the only caller) ---------- */

export interface BinaryDocument {
	/** URL after validated redirects. */
	readonly finalUrl: string;
	readonly contentType: string | null;
	readonly bytes: Uint8Array;
}

/**
 * Outbound binary fetch with the same SSRF defences as `SafeFetcher`
 * (SEC-002): https only, per-hop redirect validation, byte and time limits.
 * Narrow on purpose (ARCH-007): the text-only `SafeFetcher` is untouched, and
 * only the Node adapter implements this — the runner is the only caller.
 */
export interface SafeBinaryFetcher {
	fetchBytes(
		url: string,
		options: SafeFetchOptions,
	): Promise<Result<BinaryDocument, SafeFetchError>>;
}

/**
 * The whole persistence seam as one named bundle (ARCH-004, ADR-0008): the
 * composition root depends on this, never on an engine type. Today it is
 * backed by SQLite-dialect SQL (`packages/adapters/src/sql` over D1 or
 * `node:sqlite`); a non-SQLite engine implements these ports in a new adapter
 * directory instead of reusing the SQL.
 */
/**
 * ADR-0026: evidence a chart widget's copy cites, on Home and in every
 * notebook but one, so deleting a conversation keeps the records those
 * copies are checked against (Undo, cut and paste keep working).
 */
export interface ChartEvidenceReferences {
	listChartEvidenceIds(ownerId: string, exceptWorkspaceId: string): Promise<readonly string[]>;
}

export interface Persistence {
	readonly sources: SourceRepository;
	readonly articles: ArticleRepository;
	readonly jobs: JobRepository;
	readonly workspaces: WorkspaceRepository;
	readonly records: ResearchRecordRepository;
	readonly chat: ChatRepository;
	readonly runnerCredentials: RunnerCredentialRepository;
	readonly runnerStatus: RunnerStatusRepository;
	readonly settings: SettingsRepository;
	readonly homeDashboard: HomeDashboardRepository;
	readonly market: MarketRepository;
	readonly notebooks: NotebookRepository;
	readonly chartEvidence: ChartEvidenceReferences;
	readonly watchlist: WatchlistRepository;
	readonly earnings: EarningsRepository;
	readonly calendarFeed: CalendarFeedRepository;
	readonly googleCalendar: GoogleCalendarRepository;
	readonly stockDirectory: StockDirectoryRepository;
	readonly scheduledTasks: ScheduledTaskRepository;
	readonly rateLimiter: RateLimiter;
	readonly audit: AuditLog;
	readonly unitOfWork: ResearchUnitOfWork;
}

/* ---------- Retrieved-page archive (research web access) ---------- */

export interface ArchivedPage {
	/** URL that was requested. */
	readonly sourceUrl: string;
	/** URL after redirects. */
	readonly finalUrl: string;
	readonly title: string | null;
	/** ISO timestamp of retrieval. */
	readonly retrievedAt: string;
	readonly markdown: string;
	/** Heuristic drops counted by the page-to-Markdown converter. */
	readonly omitted?: {
		readonly boilerplateBlocks: number;
		readonly menuLists: number;
		readonly leadingBlocks: number;
	};
}

/** Stores a retrieved page as a Markdown file on the machine that retrieved it. */
export interface PageArchive {
	save(
		page: ArchivedPage,
	): Promise<
		Result<
			{ readonly fileName: string },
			{ readonly code: "ARCHIVE_WRITE_FAILED"; readonly detail: string }
		>
	>;
}
