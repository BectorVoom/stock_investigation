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
	ResearchBundle,
	ResearchRequest,
	RunnerCredential,
	RunnerEvent,
	RunRecords,
	UpdateSourceRequest,
	WatchMarket,
	WorkspaceSummary,
} from "@research/contracts";
import type { RawFeed, ResourceUsage, Result, UiCommand, WorkspaceState } from "@research/domain";

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

export interface SafeFetchError {
	readonly code: SafeFetchErrorCode;
	readonly detail: string;
	/**
	 * Response body of an HTTP error status, present only when the caller set
	 * `includeErrorBody`. Untrusted provider text: adapters must parse it
	 * with zod and never log, store or show it — only the fixed wording per
	 * code leaves the adapter.
	 */
	readonly body?: string;
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
}

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
	 * for `google-calendar` jobs (FR-019 section 2.4), null for the refresh
	 * kinds. Only research requests carry an `agentId` — narrow with
	 * `"agentId" in request` before touching agent fields.
	 */
	readonly request: ResearchRequest | GoogleCalendarRequest | null;
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
	/** Newest non-terminal job of a kind, if any (market-refresh de-duplication). */
	findActiveByKind(ownerId: string, kind: JobKind): Promise<JobRecord | null>;
	/**
	 * Completion time of the newest COMPLETED job of a kind, if any (S2: a
	 * failed or cancelled refresh is never presented as a success).
	 */
	findLatestSuccessAtByKind(ownerId: string, kind: JobKind): Promise<string | null>;
	/**
	 * Newest terminal job of a kind that did not succeed, if any (S2: state +
	 * stable failure code + time for the "last refresh failed" line).
	 */
	findLatestFailureByKind(
		ownerId: string,
		kind: JobKind,
	): Promise<{
		readonly state: string;
		readonly failureCode: string | null;
		readonly at: string;
	} | null>;
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
}

export interface CompletionEffects {
	readonly bundle: ResearchBundle | null;
	readonly articles: readonly Article[];
	readonly sourceReports: readonly {
		readonly sourceId: string;
		readonly fetchedAt: string;
		readonly errorCode: string | null;
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
}

export type CompletionCommitResult =
	| { readonly kind: "committed"; readonly newArticleCount: number }
	| { readonly kind: "job-conflict" }
	| { readonly kind: "workspace-conflict" };

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
}

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
				error: { code: "SOURCE_NOT_CONFIGURED", reason } satisfies MarketSourceUnavailable,
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
	| { readonly code: Exclude<EarningsUnavailableCode, "NO_SCHEDULED_DATE"> }
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
						error: { code: "SOURCE_NOT_CONFIGURED" },
					}),
				),
			),
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
	readonly watchlist: WatchlistRepository;
	readonly earnings: EarningsRepository;
	readonly calendarFeed: CalendarFeedRepository;
	readonly googleCalendar: GoogleCalendarRepository;
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
