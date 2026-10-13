import type {
	AgentDescriptor,
	AgentSettings,
	ApprovedAsset,
	Article,
	ChatMessage,
	Claim,
	ConversationSummary,
	Dataset,
	Evidence,
	JobKind,
	JobState,
	NewsSource,
	ResearchBundle,
	ResearchRequest,
	RunnerCredential,
	RunnerEvent,
	RunRecords,
	UpdateSourceRequest,
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
	readonly request: ResearchRequest | null;
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
 */
export type EnqueueResult =
	| { readonly kind: "inserted" }
	| { readonly kind: "existing"; readonly job: JobRecord; readonly sameRequest: boolean }
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
	readonly assetIds: readonly string[];
	readonly claimIds: readonly string[];
}

export interface ResolvedReferences {
	readonly datasets: readonly Dataset[];
	readonly evidence: readonly Evidence[];
	readonly assets: readonly ApprovedAsset[];
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

export interface AssetRepository {
	list(ownerId: string): Promise<readonly ApprovedAsset[]>;
	insert(ownerId: string, asset: ApprovedAsset): Promise<void>;
	delete(ownerId: string, assetId: string): Promise<boolean>;
}

/** What a finished job writes besides its own row; committed all-or-nothing with it. */
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
 * ids. Owner-global rows — news sources, articles, approved assets, settings,
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
		readonly assets: readonly ApprovedAsset[];
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
	readonly assets: AssetRepository;
	readonly runnerCredentials: RunnerCredentialRepository;
	readonly runnerStatus: RunnerStatusRepository;
	readonly settings: SettingsRepository;
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
