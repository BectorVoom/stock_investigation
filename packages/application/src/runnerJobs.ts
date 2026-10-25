import type {
	Article,
	ClaimedJob,
	ClaimJobRequest,
	ClaimJobResponse,
	CompleteJobRequest,
	CompleteJobResponse,
	ComponentCatalog,
	ConversationContextMessage,
	HeartbeatResponse,
	HomeDashboard,
	IngestedArticle,
	ReleaseJobRequest,
	ReleaseJobResponse,
	RunnerEventsRequest,
	SubscribedSourceRef,
	WorkspaceComponentSummary,
} from "@research/contracts";
import {
	CONVERSATION_CONTEXT_LIMITS,
	DEFAULT_HOME_DASHBOARD,
	EARNINGS_LIMITS,
	parseMarketSeriesId,
	parseStockId,
} from "@research/contracts";
import {
	addDaysIso,
	checkLease,
	decideClaim,
	decideRelease,
	distinctDashboardSeriesIds,
	err,
	isLeasedJobState,
	isTerminalJobState,
	type JobLeaseView,
	type JobState,
	leaseExpiryIso,
	ok,
	type ResourceUsage,
	type Result,
	releasedLeaseView,
	STOCK_SEARCH_FOLD_VERSION,
	thrownName,
	transitionJob,
} from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import {
	applyGoogleTerminalOutcome,
	assembleDesiredEvents,
	googleSuccessPatch,
	googleTerminalPatch,
} from "./googleCalendar.ts";
import { unionSeriesIds } from "./marketData.ts";
import {
	type NotebookClaimData,
	notebookAssistedEffects,
	prepareNotebookAssistClaim,
} from "./notebook/notebook.ts";
import type {
	AuditLog,
	ChatRepository,
	Clock,
	CompletionEffects,
	EarningsCompletionStock,
	EarningsRepository,
	GoogleCalendarRepository,
	Hasher,
	HomeDashboardRepository,
	IdGenerator,
	JobPatch,
	JobRecord,
	JobRepository,
	MarketCompletionSeries,
	MarketRepository,
	NotebookRepository,
	ResearchRecordRepository,
	ResearchUnitOfWork,
	RunnerStatusRepository,
	SourceRepository,
	StockDirectoryJobRequest,
	TransitionAudit,
	WatchlistRepository,
	WorkspaceRepository,
} from "./ports.ts";
import { checkBundleIntegrity } from "./recordIntegrity.ts";
import {
	earningsStockNeedsRefresh,
	refreshScopeRequest,
	storedRefreshScope,
	widenAuditAction,
} from "./refreshScope.ts";
import { buildConversationContextBeforeAnchor } from "./research/conversationContext.ts";
import { stockDirectoryRows } from "./stockDirectory.ts";
import {
	applyRunOperations,
	commandContext,
	externalReferences,
	knownIds,
} from "./workspaceCommands.ts";

export const LEASE_DURATION_MS = 90_000;
export const HEARTBEAT_INTERVAL_MS = 20_000;
const CLAIM_SCAN_LIMIT = 5;
const POLL_AFTER_CLAIM_MS = 2_000;
const POLL_WHEN_BLOCKED_MS = 5_000;
// A question can arrive just after an empty claim. Keep its polling wait
// within one second; the runner still backs off separately on API failures.
const POLL_WHEN_IDLE_MS = 1_000;
const CAS_RETRIES = 4;
/**
 * A completion attempt costs up to ~20 D1 queries (reads, reference lookups and
 * the guarded batch). Workers Free allows about 50 per request, so the batch is
 * tried at most twice; on a second conflict the runner is told to resend.
 */
const COMPLETION_ATTEMPTS = 2;

/**
 * Usage only ever grows over the life of a run. Taking the larger of what is
 * stored and what is reported means a runner (or a retry that lost its state)
 * can never lower the run's recorded consumption (AGT-008).
 */
function cumulativeUsage(stored: ResourceUsage, reported: ResourceUsage): ResourceUsage {
	return {
		agentSteps: Math.max(stored.agentSteps, reported.agentSteps),
		toolCalls: Math.max(stored.toolCalls, reported.toolCalls),
		inputBytes: Math.max(stored.inputBytes, reported.inputBytes),
		knownCostUsd: Math.max(stored.knownCostUsd, reported.knownCostUsd),
		hasUnmeteredUsage: stored.hasUnmeteredUsage || reported.hasUnmeteredUsage,
	};
}

/** The authenticated runner: its owner and the credential that identifies its leases. */
export interface RunnerIdentity {
	readonly ownerId: string;
	readonly credentialId: string;
}

export interface RunnerJobServiceDeps {
	readonly jobs: JobRepository;
	readonly sources: SourceRepository;
	readonly workspaces: WorkspaceRepository;
	readonly records: ResearchRecordRepository;
	readonly runnerStatus: RunnerStatusRepository;
	readonly unitOfWork: ResearchUnitOfWork;
	readonly chat: ChatRepository;
	readonly catalog: ComponentCatalog;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly homeDashboard: HomeDashboardRepository;
	readonly market: MarketRepository;
	readonly notebooks: NotebookRepository;
	readonly watchlist: WatchlistRepository;
	/** Sync-payload assembly at claim time (FR-019). */
	readonly earnings: EarningsRepository;
	readonly hasher: Hasher;
	/** `google-auth-url` events and terminal bookkeeping (FR-019). */
	readonly googleCalendar: GoogleCalendarRepository;
	readonly audit: AuditLog;
	/** Fires the owner's due scheduled tasks at the start of every claim (ADR-0033 §2). */
	readonly scheduler: ClaimTimeScheduler;
	/**
	 * Told when the claim-time firing threw; the claim goes on. Receives the
	 * thrown value's class name only (SEC-010); the composition root logs it.
	 */
	readonly onSchedulerFailure: (errorName: string) => void;
}

/** Work a claim does before it scans for jobs: materialising due scheduled tasks. */
export interface ClaimTimeScheduler {
	materializeDue(ownerId: string): Promise<unknown>;
}

/**
 * How many of the most recent chat rows one claim reads before the run's
 * anchor. A single bounded query, never the whole history (data-volume
 * budget). Messages written after the anchor cannot push the question out:
 * the query itself is limited to `seq < anchorSeq`.
 */
const CONTEXT_LOAD_LIMIT = CONVERSATION_CONTEXT_LIMITS.maxMessages;

function leaseView(job: JobRecord): JobLeaseView {
	return {
		state: job.state,
		leaseGeneration: job.leaseGeneration,
		leaseOwnerId: job.leaseOwnerId,
		leaseExpiresAt: job.leaseExpiresAt,
		attempt: job.attempt,
		maxAttempts: job.maxAttempts,
		cancelRequested: job.cancelRequested,
	};
}

function staleLease(detail: string): UseCaseResult<never> {
	return fail("STALE_LEASE", "This runner no longer holds the lease for the run.", detail);
}

/** Why a google-calendar job is failed at claim time instead of leased. */
interface GoogleClaimRefusal {
	/** Audit reason (fixed text, never provider data). */
	readonly reason: string;
	readonly failureCode: "GOOGLE_REQUEST_FAILED" | "GOOGLE_AUTH_TIMEOUT";
}

/** The per-action fields of a claimed google-calendar job (FR-019 section 2.4). */
type GoogleClaimPayload = Pick<
	Extract<ClaimedJob, { kind: "google-calendar" }>,
	"action" | "calendarId" | "desiredDigest" | "events"
>;

/** The market a `stock-directory-refresh` job downloads (ADR-0034), from its stored request. */
function directoryMarket(job: JobRecord): StockDirectoryJobRequest["market"] | null {
	return job.request !== null && "market" in job.request ? job.request.market : null;
}

/** Deterministic id, so re-submitting the same article is a no-op rather than a second row. */
function toArticle(article: IngestedArticle): Article {
	return { ...article, articleId: `art_${article.contentFingerprint.slice(0, 32)}` };
}

export function createRunnerJobService(deps: RunnerJobServiceDeps) {
	/**
	 * The series a market-refresh claim fetches: the union of the Home
	 * dashboard's series (first) and every notebook's market series,
	 * de-duplicated, at most maxTrackedSeries (ADR-0021) — or, for an
	 * `"unrefreshed"` job, only those with no stored observations or never
	 * refreshed, in the same order (ADR-0039). `coversEverything` says the
	 * narrowing left every tracked series in.
	 */
	async function prepareMarketClaim(
		ownerId: string,
		job: JobRecord,
	): Promise<{
		readonly series: readonly {
			readonly seriesId: string;
			readonly latestObservedOn: string | null;
		}[];
		readonly coversEverything: boolean;
	}> {
		const dashboard = await marketDashboard(ownerId);
		const tracked = unionSeriesIds(
			distinctDashboardSeriesIds(dashboard.widgets),
			await deps.notebooks.listMarketSeriesIds(ownerId),
		);
		const state = await deps.market.getRefreshState(ownerId, tracked);
		const ids =
			storedRefreshScope(job) === "all"
				? tracked
				: tracked.filter((seriesId) => {
						const series = state.get(seriesId);
						return (
							series === undefined ||
							series.latestObservedOn === null ||
							series.lastRefreshedAt === null
						);
					});
		return {
			series: ids.map((seriesId) => ({
				seriesId,
				latestObservedOn: state.get(seriesId)?.latestObservedOn ?? null,
			})),
			coversEverything: ids.length === tracked.length,
		};
	}

	/**
	 * The stocks an earnings-refresh claim fetches, in watchlist order, at
	 * most maxStocks — for an `"unrefreshed"` job only those never refreshed
	 * or whose last fetch failed (ADR-0039, `earningsStockNeedsRefresh`).
	 * `coversEverything` says the narrowing left every stock in.
	 */
	async function prepareEarningsClaim(
		ownerId: string,
		job: JobRecord,
	): Promise<{
		readonly stocks: readonly { readonly stockId: string; readonly name: string | null }[];
		readonly coversEverything: boolean;
	}> {
		const watched = (await deps.watchlist.listStocks(ownerId)).slice(0, EARNINGS_LIMITS.maxStocks);
		const stocks =
			storedRefreshScope(job) === "all" ? watched : watched.filter(earningsStockNeedsRefresh);
		return {
			stocks: stocks.map((stock) => ({ stockId: stock.stockId, name: stock.name })),
			coversEverything: stocks.length === watched.length,
		};
	}

	/**
	 * Due scheduled tasks become ordinary research jobs here, after the
	 * runner's agents were recorded (the run service reads them for cost
	 * models) and before the candidate scan, so a fired run is claimed in
	 * this same request (ADR-0033 §2).
	 */
	async function fireDueTasks(ownerId: string): Promise<void> {
		try {
			await deps.scheduler.materializeDue(ownerId);
		} catch (error) {
			// Convert (error_handling §5.1): firing is a side duty of the
			// claim and must never cost the runner its job. The documented
			// fallback is "nothing fired this claim": every due task stays
			// due (its run is created before the task advances), so the
			// next claim tries again. Reported by class name only.
			deps.onSchedulerFailure(thrownName(error));
		}
	}

	async function marketDashboard(ownerId: string): Promise<HomeDashboard> {
		const stored = await deps.homeDashboard.get(ownerId);
		// An unreadable stored dashboard claims the defaults (like an absent
		// one): the refresh keeps working while the app shows the error state
		// with its reset way out (V2). It is never silently replaced here.
		return stored === null || stored === "unreadable" ? DEFAULT_HOME_DASHBOARD : stored.dashboard;
	}

	async function activeSources(ownerId: string): Promise<readonly SubscribedSourceRef[]> {
		const sources = await deps.sources.list(ownerId);
		return sources
			.filter((source) => source.feedStatus !== "paused")
			.map((source) => ({
				sourceId: source.sourceId,
				canonicalUrl: source.canonicalUrl,
				publisher: source.publisher,
				title: source.title,
				licensePolicy: source.licensePolicy,
			}));
	}

	async function componentSummaries(
		ownerId: string,
		workspaceId: string | null,
	): Promise<WorkspaceComponentSummary[]> {
		const workspace = workspaceId === null ? null : await deps.workspaces.get(ownerId, workspaceId);
		return (workspace?.state.components ?? []).map((component) => ({
			componentId: component.componentId,
			componentType: component.componentType,
			title: typeof component.props.title === "string" ? component.props.title : null,
		}));
	}

	/**
	 * Articles and fetch reports are accepted only for sources this owner actually has,
	 * and an excerpt only where that source's license permits one (DATA-010). The runner
	 * is not trusted to have applied either rule.
	 */
	async function ownedArticles(
		ownerId: string,
		articles: readonly IngestedArticle[],
		sourceReports: CompletionEffects["sourceReports"],
	): Promise<Pick<CompletionEffects, "articles" | "sourceReports">> {
		if (articles.length === 0 && sourceReports.length === 0) {
			return { articles: [], sourceReports: [] };
		}
		const sources = new Map(
			(await deps.sources.list(ownerId)).map((source) => [source.sourceId, source]),
		);
		return {
			articles: articles.flatMap((article) => {
				const source = sources.get(article.sourceId);
				if (source === undefined) return [];
				return [
					toArticle(
						source.licensePolicy === "short-excerpt-permitted"
							? article
							: { ...article, excerpt: null },
					),
				];
			}),
			sourceReports: sourceReports.filter((report) => sources.has(report.sourceId)),
		};
	}

	async function conversationContext(
		ownerId: string,
		workspaceId: string | null,
		anchorSeq: number | null,
	): Promise<ConversationContextMessage[]> {
		// No anchor (news-ingest, imported or pre-migration rows): fail closed
		// with an empty context instead of guessing from the latest messages.
		if (workspaceId === null || anchorSeq === null) return [];
		const rows = await deps.chat.list(ownerId, workspaceId, {
			beforeSeq: anchorSeq,
			limit: CONTEXT_LOAD_LIMIT,
		});
		return buildConversationContextBeforeAnchor(rows, anchorSeq);
	}

	function auditFor(
		runner: RunnerIdentity,
		fromState: JobState,
		toState: JobState,
		reason: string,
	) {
		return { fromState, toState, actor: `runner:${runner.credentialId}`, reason } as const;
	}

	/** Effects of a market-refreshed completion, or the reason it cannot be accepted. */
	async function marketEffects(
		request: Extract<CompleteJobRequest, { outcome: "market-refreshed" }>,
	): Promise<UseCaseResult<CompletionEffects>> {
		const marketSeries: MarketCompletionSeries[] = [];
		for (const entry of request.series) {
			const parsed = parseMarketSeriesId(entry.seriesId);
			if (parsed === null) {
				return fail("VALIDATION_FAILED", "Unknown market series id.", entry.seriesId.slice(0, 64));
			}
			marketSeries.push({
				seriesId: entry.seriesId,
				provider: parsed.provider,
				symbol: parsed.symbol,
				fetchedAt: entry.fetchedAt,
				meta:
					entry.meta === null
						? null
						: {
								title: entry.meta.title,
								unit: entry.meta.unit,
								frequency: entry.meta.frequency,
								publisher: entry.meta.publisher,
								sourceUrl: entry.meta.sourceUrl,
							},
				observations: entry.observations.map(([observedOn, value]) => ({ observedOn, value })),
				errorCode: entry.errorCode,
				upstreamStatus: entry.upstreamStatus ?? null,
			});
		}
		return ok({
			bundle: null,
			articles: [],
			sourceReports: [],
			workspace: null,
			assistantMessage: null,
			marketSeries,
			earnings: [],
			google: null,
			notebook: null,
			notebookTurn: null,
			stockDirectory: null,
		});
	}

	/** Effects of an earnings-refreshed completion, or the reason it cannot be accepted. */
	async function earningsEffects(
		request: Extract<CompleteJobRequest, { outcome: "earnings-refreshed" }>,
	): Promise<UseCaseResult<CompletionEffects>> {
		const stocks: EarningsCompletionStock[] = [];
		for (const entry of request.stocks) {
			const parsed = parseStockId(entry.stockId);
			if (parsed === null) {
				return fail("VALIDATION_FAILED", "Unknown watchlist stock id.", entry.stockId.slice(0, 64));
			}
			stocks.push({
				stockId: entry.stockId,
				market: parsed.market,
				symbol: parsed.symbol,
				fetchedAt: entry.fetchedAt,
				name: entry.name,
				events: [...entry.events],
				errorCode: entry.errorCode,
				upstreamStatus: entry.upstreamStatus ?? null,
			});
		}
		return ok({
			bundle: null,
			articles: [],
			sourceReports: [],
			workspace: null,
			assistantMessage: null,
			marketSeries: [],
			earnings: stocks,
			google: null,
			notebook: null,
			notebookTurn: null,
			stockDirectory: null,
		});
	}

	/** Effects of a bundle-bearing completion, or the reason it cannot be accepted. */
	async function bundleEffects(
		job: JobRecord,
		request: Extract<CompleteJobRequest, { outcome: "completed" | "partial" }>,
		now: string,
	): Promise<UseCaseResult<CompletionEffects>> {
		const issues = checkBundleIntegrity(job.runId, request.bundle);
		if (issues.length > 0) {
			const summary = issues
				.slice(0, 5)
				.map((issue) => `${issue.code}:${issue.recordId}`)
				.join(",");
			return fail("INTEGRITY_VIOLATION", "The research bundle failed integrity checks.", summary);
		}
		const base = {
			bundle: request.bundle,
			...(await ownedArticles(job.ownerId, request.articles, request.sourceReports)),
		};
		const workspace =
			job.workspaceId === null ? null : await deps.workspaces.get(job.ownerId, job.workspaceId);
		if (workspace === null)
			return ok({
				...base,
				workspace: null,
				assistantMessage: null,
				marketSeries: [],
				earnings: [],
				google: null,
				notebook: null,
				notebookTurn: null,
				stockDirectory: null,
			});

		const external = await deps.records.resolve(
			job.ownerId,
			externalReferences(workspace.state, job.runId, request.bundle, deps.catalog),
		);
		const known = knownIds(external);
		const applied = applyRunOperations(
			workspace.state,
			job.runId,
			request.bundle.uiOperations,
			commandContext(deps.catalog, {
				datasetIds: [...known.datasetIds, ...request.bundle.datasets.map((d) => d.datasetId)],
				evidenceIds: [...known.evidenceIds, ...request.bundle.evidence.map((e) => e.evidenceId)],
				claims: [...known.claims, ...request.bundle.claims],
			}),
			now,
		);
		const rejectedNote =
			applied.rejected.length === 0
				? ""
				: `\n\n(${applied.rejected.length} display instruction(s) were rejected by validation: ${applied.rejected
						.map((rejection) => rejection.code)
						.join(", ")}.)`;
		return ok({
			...base,
			marketSeries: [],
			earnings: [],
			google: null,
			notebook: null,
			notebookTurn: null,
			stockDirectory: null,
			workspace:
				applied.commands.length === 0
					? null
					: {
							workspaceId: workspace.summary.workspaceId,
							expectedVersion: workspace.state.version,
							nextState: applied.nextState,
							commands: applied.commands,
							at: now,
						},
			assistantMessage: {
				messageId: `${job.runId}_answer`,
				workspaceId: workspace.summary.workspaceId,
				text: `${request.bundle.answerText}${rejectedNote}`.slice(0, 6000),
				claimIds: request.bundle.answerClaimIds,
			},
		});
	}

	/**
	 * The action-specific part of a google-calendar claim (FR-019 section
	 * 2.4), or the audit reason it can never run. The sync payload is read
	 * at CLAIM time: the calendar id from the link row, the desired set
	 * assembled from the current watchlist.
	 */
	async function prepareGoogleClaim(
		ownerId: string,
		job: JobRecord,
		leaseExpired: boolean,
	): Promise<Result<GoogleClaimPayload, GoogleClaimRefusal>> {
		const action = job.request !== null && "action" in job.request ? job.request.action : null;
		// Fail closed: a google job without its action can never run.
		if (action === null) {
			return err({ reason: "google job without an action", failureCode: "GOOGLE_REQUEST_FAILED" });
		}
		if (action === "connect" && leaseExpired) {
			// The runner that opened the sign-in is gone and its link points
			// at a port nobody listens on. Starting the sign-in again on its
			// own — possibly hours later, with nobody at the browser — would
			// only time out; the owner connects again when they are there.
			return err({
				reason: "sign-in abandoned: the lease expired",
				failureCode: "GOOGLE_AUTH_TIMEOUT",
			});
		}
		if (action !== "sync") return ok({ action });
		const link = await deps.googleCalendar.get(ownerId);
		const desired = await assembleDesiredEvents(
			{ watchlist: deps.watchlist, earnings: deps.earnings, hasher: deps.hasher },
			ownerId,
		);
		if (!desired.ok) {
			return err({
				reason: "google desired set undecidable",
				failureCode: "GOOGLE_REQUEST_FAILED",
			});
		}
		return ok({
			action: "sync",
			calendarId: link?.calendarId ?? null,
			desiredDigest: desired.value.digest,
			events: [...desired.value.bodies],
		});
	}

	return {
		/**
		 * Grants at most one lease per job (section 5.2). Eligibility is decided by
		 * the pure `decideClaim`; the grant itself is a compare-and-set on the job
		 * version, so two runners racing for one job cannot both win.
		 */
		async claim(
			runner: RunnerIdentity,
			request: ClaimJobRequest,
		): Promise<UseCaseResult<ClaimJobResponse>> {
			const nowMs = deps.clock.nowMs();
			const now = deps.clock.nowIso();
			await deps.runnerStatus.put(runner.ownerId, {
				lastSeenAt: now,
				runnerVersion: request.runnerVersion,
				agents: request.agents,
			});
			const available = new Set(
				request.agents
					.filter((agent) => agent.availability.status === "available")
					.map((agent) => agent.agentId),
			);
			await fireDueTasks(runner.ownerId);
			const candidates = await deps.jobs.listClaimCandidates(runner.ownerId, now, CLAIM_SCAN_LIMIT);
			for (const job of candidates) {
				const write = (patch: JobPatch, audits: readonly TransitionAudit[]) =>
					deps.jobs.write(runner.ownerId, {
						runId: job.runId,
						expectedVersion: job.version,
						patch,
						audits,
						at: now,
					});
				if (job.cancelRequested) {
					// The owner cancelled while a runner that has since vanished held the lease.
					await write({ state: "cancelled", cancelRequested: false, leaseExpiresAt: null }, [
						auditFor(runner, job.state, "cancelled", "cancel requested; lease expired"),
					]);
					// A cancelled google-calendar run restores its link row
					// even though it never completes (FR-019 section 2.5).
					await applyGoogleTerminalOutcome(deps, runner.ownerId, job, "cancelled", null, null, now);
					continue;
				}
				const decision = decideClaim(leaseView(job), nowMs);
				if (decision.kind === "exhausted") {
					await write(
						{
							state: "failed",
							failureCode: "RETRY_CEILING_REACHED",
							failureDetail: null,
							failureUpstreamStatus: null,
							leaseExpiresAt: null,
						},
						[auditFor(runner, job.state, "failed", "retry ceiling reached")],
					);
					await applyGoogleTerminalOutcome(
						deps,
						runner.ownerId,
						job,
						"failed",
						"RETRY_CEILING_REACHED",
						null,
						now,
					);
					continue;
				}
				if (decision.kind === "not-eligible") continue;
				// Only research requests name an agent; google-calendar jobs
				// carry `{ action }` and need none.
				if (job.request !== null && "agentId" in job.request && !available.has(job.request.agentId))
					continue;

				// FR-019: everything a google-calendar claim can refuse is
				// decided BEFORE the lease is granted, while `job.version`
				// is still current — a refusal written after the grant would
				// lose its compare-and-set and leave the job leased to nobody.
				let googleClaim: GoogleClaimPayload | null = null;
				if (job.kind === "google-calendar") {
					const prepared = await prepareGoogleClaim(
						runner.ownerId,
						job,
						decision.reason === "lease-expired",
					);
					if (!prepared.ok) {
						const refused = await write(
							{
								state: "failed",
								failureCode: prepared.error.failureCode,
								failureDetail: null,
								failureUpstreamStatus: null,
								leaseExpiresAt: null,
							},
							[auditFor(runner, job.state, "failed", prepared.error.reason)],
						);
						// Only the request that won the write does the
						// bookkeeping (another claim may have got there first).
						if (refused) {
							await applyGoogleTerminalOutcome(
								deps,
								runner.ownerId,
								job,
								"failed",
								prepared.error.failureCode,
								null,
								now,
							);
						}
						continue;
					}
					googleClaim = prepared.value;
				}

				// ADR-0020: everything a notebook-assist claim can refuse is
				// decided BEFORE the lease is granted, while `job.version`
				// is still current — like the google-calendar refusal above.
				let notebookClaim: NotebookClaimData | null = null;
				if (job.kind === "notebook-assist") {
					const prepared = await prepareNotebookAssistClaim(
						{ notebooks: deps.notebooks, chat: deps.chat },
						runner.ownerId,
						job,
					);
					if (!prepared.ok) {
						await write(
							{
								state: "failed",
								failureCode: prepared.error.failureCode,
								failureDetail: null,
								failureUpstreamStatus: null,
								leaseExpiresAt: null,
							},
							[auditFor(runner, job.state, "failed", prepared.error.reason)],
						);
						continue;
					}
					notebookClaim = prepared.value;
					// The frozen agent choice names the backend that must run
					// it; any other runner waits (like research jobs).
					if (!available.has(notebookClaim.agent.agentId)) continue;
				}

				// ADR-0034: a directory job names its market in its stored
				// request; one that does not cannot run, and is refused
				// before the lease is granted (like the refusals above).
				const claimedDirectoryMarket =
					job.kind === "stock-directory-refresh" ? directoryMarket(job) : null;
				if (job.kind === "stock-directory-refresh" && claimedDirectoryMarket === null) {
					await write(
						{
							state: "failed",
							failureCode: "INTERNAL",
							failureDetail: null,
							failureUpstreamStatus: null,
							leaseExpiresAt: null,
						},
						[auditFor(runner, job.state, "failed", "stock directory job names no market")],
					);
					continue;
				}

				// ADR-0039: what a market or earnings refresh fetches is read
				// BEFORE the lease is granted, so a narrow job that turns out
				// to cover every item is stored as a refresh of everything in
				// the same write — its success is then the last refresh of
				// everything (the "last successful refresh" line counts only
				// those), as a first-ever refresh must be.
				const marketClaim =
					job.kind === "market-refresh" ? await prepareMarketClaim(runner.ownerId, job) : null;
				const earningsClaim =
					job.kind === "earnings-refresh" ? await prepareEarningsClaim(runner.ownerId, job) : null;
				const coversEverything =
					storedRefreshScope(job) === "unrefreshed" &&
					(marketClaim?.coversEverything === true || earningsClaim?.coversEverything === true);

				const audits =
					decision.reason === "lease-expired"
						? [
								auditFor(runner, job.state, "pending", "lease expired"),
								auditFor(runner, "pending", "claimed", "claimed"),
							]
						: [auditFor(runner, job.state, "claimed", "claimed")];
				const leaseExpiresAt = leaseExpiryIso(nowMs, LEASE_DURATION_MS);
				const granted = await write(
					{
						...(coversEverything ? { request: refreshScopeRequest("all") } : {}),
						state: "claimed",
						attempt: decision.nextAttempt,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseOwnerId: runner.credentialId,
						leaseExpiresAt,
						lastEventSeq: -1,
						// Finding 11: a new attempt clears the previous attempt's
						// failure metadata, or a later success would show the old code.
						failureCode: null,
						failureDetail: null,
						failureUpstreamStatus: null,
					},
					audits,
				);
				if (!granted) continue;
				if (coversEverything) {
					await deps.audit.record({
						ownerId: runner.ownerId,
						actor: `runner:${runner.credentialId}`,
						action: widenAuditAction(
							job.kind === "market-refresh" ? "market-refresh" : "earnings-refresh",
						),
						resource: job.runId,
						detail: "scope=unrefreshed->all at claim",
						at: now,
					});
				}
				if (marketClaim !== null) {
					const claimedMarket: ClaimedJob = {
						kind: "market-refresh",
						runId: job.runId,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseExpiresAt,
						attempt: decision.nextAttempt,
						heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
						sources: [],
						series: [...marketClaim.series],
					};
					return ok({ job: claimedMarket, pollAfterMs: POLL_AFTER_CLAIM_MS });
				}
				if (earningsClaim !== null) {
					// The refresh window is [today, today + horizonDays], both
					// UTC dates from the injected clock (SPEC section 1).
					const fromDate = deps.clock.nowIso().slice(0, 10);
					const toDate = addDaysIso(fromDate, EARNINGS_LIMITS.horizonDays);
					if (!toDate.ok) return fail("INTERNAL", "Internal error.");
					const claimedEarnings: ClaimedJob = {
						kind: "earnings-refresh",
						runId: job.runId,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseExpiresAt,
						attempt: decision.nextAttempt,
						heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
						sources: [],
						fromDate,
						toDate: toDate.value,
						stocks: [...earningsClaim.stocks],
					};
					return ok({ job: claimedEarnings, pollAfterMs: POLL_AFTER_CLAIM_MS });
				}
				if (claimedDirectoryMarket !== null) {
					// The runner needs nothing but the market: the whole list
					// comes from SEC (US) or JPX (JP).
					const claimedDirectory: ClaimedJob = {
						kind: "stock-directory-refresh",
						runId: job.runId,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseExpiresAt,
						attempt: decision.nextAttempt,
						heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
						sources: [],
						market: claimedDirectoryMarket,
					};
					return ok({ job: claimedDirectory, pollAfterMs: POLL_AFTER_CLAIM_MS });
				}
				if (notebookClaim !== null) {
					const notebookWorkspaceId = job.workspaceId;
					if (notebookWorkspaceId === null) return fail("INTERNAL", "Internal error.");
					const claimedNotebook: ClaimedJob = {
						kind: "notebook-assist",
						runId: job.runId,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseExpiresAt,
						attempt: decision.nextAttempt,
						heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
						sources: [],
						workspaceId: notebookWorkspaceId,
						agent: { ...notebookClaim.agent },
						instruction: notebookClaim.instruction,
						selectedWidgetIds: [...notebookClaim.selectedWidgetIds],
						notebook: notebookClaim.notebook,
						notebookVersion: notebookClaim.notebookVersion,
						conversationContext: [...notebookClaim.conversationContext],
					};
					return ok({ job: claimedNotebook, pollAfterMs: POLL_AFTER_CLAIM_MS });
				}
				if (googleClaim !== null) {
					const claimedGoogle: ClaimedJob = {
						kind: "google-calendar",
						runId: job.runId,
						leaseGeneration: decision.nextLeaseGeneration,
						leaseExpiresAt,
						attempt: decision.nextAttempt,
						heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
						sources: [],
						...googleClaim,
					};
					return ok({ job: claimedGoogle, pollAfterMs: POLL_AFTER_CLAIM_MS });
				}
				const lease = {
					runId: job.runId,
					leaseGeneration: decision.nextLeaseGeneration,
					leaseExpiresAt,
					attempt: decision.nextAttempt,
					heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
					sources: [...(await activeSources(runner.ownerId))],
				};
				let claimed: ClaimedJob;
				if (job.kind === "news-ingest" || job.request === null) {
					claimed = { kind: "news-ingest", ...lease };
				} else if (job.request !== null && "agentId" in job.request) {
					claimed = {
						kind: "research",
						...lease,
						request: job.request,
						priorUsage: job.usage,
						workspaceComponents: await componentSummaries(runner.ownerId, job.workspaceId),
						conversationContext: await conversationContext(
							runner.ownerId,
							job.workspaceId,
							job.contextAnchorSeq,
						),
					};
				} else {
					// A research-kind job without a research request is a
					// storage fault: fail closed instead of claiming it.
					return fail("INTERNAL", "Internal error.");
				}
				return ok({ job: claimed, pollAfterMs: POLL_AFTER_CLAIM_MS });
			}
			return ok({
				job: null,
				pollAfterMs: candidates.length > 0 ? POLL_WHEN_BLOCKED_MS : POLL_WHEN_IDLE_MS,
			});
		},

		async heartbeat(
			runner: RunnerIdentity,
			runId: string,
			leaseGeneration: number,
		): Promise<UseCaseResult<HeartbeatResponse>> {
			for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
				const job = await deps.jobs.get(runner.ownerId, runId);
				if (job === null) return fail("NOT_FOUND", "Run not found.");
				const lease = checkLease(leaseView(job), {
					runnerId: runner.credentialId,
					leaseGeneration,
				});
				if (!lease.ok) return staleLease(lease.error);
				const leaseExpiresAt = leaseExpiryIso(deps.clock.nowMs(), LEASE_DURATION_MS);
				const written = await deps.jobs.write(runner.ownerId, {
					runId,
					expectedVersion: job.version,
					patch: { leaseExpiresAt },
					audits: [],
					at: deps.clock.nowIso(),
				});
				if (written) return ok({ leaseExpiresAt, cancelRequested: job.cancelRequested });
			}
			return fail("CONFLICT", "The run changed concurrently; retry the heartbeat.");
		},

		/**
		 * Lease hand-back (ADR-0036): a runner that is shutting down gives the
		 * lease back instead of letting it run out. The job returns to
		 * `pending` at once with the claim refunded, so the next runner claims
		 * it within one poll and an owner's restart never uses up an attempt;
		 * a job whose cancellation was requested is cancelled instead. The
		 * runner's usage so far is recorded like an events usage (it only
		 * grows). Only the holder of the current generation may release; any
		 * other proof gets the lease check's STALE_LEASE answer.
		 */
		async release(
			runner: RunnerIdentity,
			runId: string,
			request: ReleaseJobRequest,
		): Promise<UseCaseResult<ReleaseJobResponse>> {
			for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
				const job = await deps.jobs.get(runner.ownerId, runId);
				if (job === null) return fail("NOT_FOUND", "Run not found.");
				const view = leaseView(job);
				const decision = decideRelease(view, {
					runnerId: runner.credentialId,
					leaseGeneration: request.leaseGeneration,
				});
				if (!decision.ok) return staleLease(decision.error);
				const released = releasedLeaseView(view, decision.value);
				const state = decision.value.kind === "cancel" ? "cancelled" : "pending";
				const now = deps.clock.nowIso();
				const written = await deps.jobs.write(runner.ownerId, {
					runId,
					expectedVersion: job.version,
					patch: {
						state: released.state,
						attempt: released.attempt,
						leaseOwnerId: released.leaseOwnerId,
						leaseExpiresAt: released.leaseExpiresAt,
						cancelRequested: released.cancelRequested,
						usage: cumulativeUsage(job.usage, request.usage),
					},
					audits: [
						auditFor(
							runner,
							job.state,
							released.state,
							state === "cancelled"
								? "cancel requested; lease released on runner shutdown"
								: "released on runner shutdown",
						),
					],
					at: now,
				});
				if (!written) continue;
				if (state === "cancelled") {
					// No runner will complete this run: restore the Google link
					// row like any other cancel (FR-019 section 2.5).
					await applyGoogleTerminalOutcome(deps, runner.ownerId, job, "cancelled", null, null, now);
				} else if (
					job.kind === "google-calendar" &&
					job.request !== null &&
					"action" in job.request &&
					job.request.action === "connect"
				) {
					// The sign-in link points at the stopped runner's loopback
					// port, which nobody listens on any more; the next runner
					// opens a new sign-in and reports its own link.
					await deps.googleCalendar.apply(runner.ownerId, { pendingAuthUrl: null }, now);
				}
				return ok({ state });
			}
			return fail("CONFLICT", "The run changed concurrently; retry the release.");
		},

		/**
		 * Records progress. State changes are validated one by one against the
		 * transition matrix; events at or below the stored sequence are ignored, so
		 * a retried request never replays a transition.
		 */
		async appendEvents(
			runner: RunnerIdentity,
			runId: string,
			request: RunnerEventsRequest,
		): Promise<UseCaseResult<{ readonly cancelRequested: boolean }>> {
			for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
				const job = await deps.jobs.get(runner.ownerId, runId);
				if (job === null) return fail("NOT_FOUND", "Run not found.");
				const lease = checkLease(leaseView(job), {
					runnerId: runner.credentialId,
					leaseGeneration: request.leaseGeneration,
				});
				if (!lease.ok) return staleLease(lease.error);
				const fresh = request.events
					.filter((entry) => entry.seq > job.lastEventSeq)
					.sort((a, b) => a.seq - b.seq);
				const last = fresh.at(-1);
				if (last === undefined) {
					// A resend of events already recorded. The sign-in link is
					// stored AFTER the job write, so a failure in between left
					// the events recorded and the link not: store it again
					// here (idempotent), or the runner would be told the link
					// was delivered while the owner never sees it.
					let resentUrl: string | null = null;
					for (const { event } of request.events) {
						if (event.type === "google-auth-url") resentUrl = event.url;
					}
					if (
						resentUrl !== null &&
						job.kind === "google-calendar" &&
						job.request !== null &&
						"action" in job.request &&
						job.request.action === "connect" &&
						isLeasedJobState(job.state)
					) {
						await deps.googleCalendar.setPendingAuthUrl(
							runner.ownerId,
							resentUrl,
							deps.clock.nowIso(),
						);
					}
					return ok({ cancelRequested: job.cancelRequested });
				}

				let state = job.state;
				const audits: TransitionAudit[] = [];
				const patch: {
					-readonly [K in keyof JobPatch]: JobPatch[K];
				} = { lastEventSeq: last.seq };
				let authUrl: string | undefined;
				for (const { event } of fresh) {
					if (event.type === "state" && event.state !== state) {
						const next = transitionJob(state, event.state);
						if (!next.ok) {
							return fail(
								"ILLEGAL_TRANSITION",
								"The reported state change is not allowed.",
								`${state}->${event.state}`,
							);
						}
						audits.push(auditFor(runner, state, next.value, "runner progress"));
						state = next.value;
					} else if (event.type === "usage") {
						patch.usage = cumulativeUsage(patch.usage ?? job.usage, event.usage);
					} else if (event.type === "provider-session") {
						patch.providerSessionRef = event.sessionRef;
					} else if (event.type === "google-auth-url") {
						authUrl = event.url;
					}
				}
				if (authUrl !== undefined) {
					// The sign-in URL is accepted only for a leased
					// google-calendar connect job of this lease generation
					// (the generation was already fenced by `checkLease`
					// above; the URL prefix by the request schema). Anything
					// else is rejected, never stored.
					if (job.kind !== "google-calendar") {
						return fail("VALIDATION_FAILED", "This event does not apply to this kind of job.");
					}
					const action =
						job.request !== null && "action" in job.request ? job.request.action : null;
					if (action !== "connect") {
						return fail("VALIDATION_FAILED", "This event does not apply to this kind of job.");
					}
					if (!isLeasedJobState(state)) {
						return fail("VALIDATION_FAILED", "The run is not leased.");
					}
				}
				patch.state = state;
				const written = await deps.jobs.writeWithEvents(
					runner.ownerId,
					{ runId, expectedVersion: job.version, patch, audits, at: deps.clock.nowIso() },
					request.leaseGeneration,
					fresh,
				);
				if (written) {
					// Stored only after the compare-and-set won, so a lost
					// race never records a URL for a superseded write. The
					// URL is idempotent: a resend stores the same value.
					// (`toProgressRows` drops this event type, so it never
					// reaches the progress table either.)
					if (authUrl !== undefined) {
						await deps.googleCalendar.setPendingAuthUrl(
							runner.ownerId,
							authUrl,
							deps.clock.nowIso(),
						);
					}
					return ok({ cancelRequested: job.cancelRequested });
				}
			}
			return fail("CONFLICT", "The run changed concurrently; retry the request.");
		},

		/**
		 * Finishes a lease. The job row, research records, workspace changes and
		 * the assistant message commit atomically. A duplicate completion from the
		 * same lease generation is answered without re-applying anything; one from
		 * a superseded generation is rejected (hard gate 8).
		 */
		async complete(
			runner: RunnerIdentity,
			runId: string,
			request: CompleteJobRequest,
		): Promise<UseCaseResult<CompleteJobResponse>> {
			for (let attempt = 0; attempt < COMPLETION_ATTEMPTS; attempt += 1) {
				const job = await deps.jobs.get(runner.ownerId, runId);
				if (job === null) return fail("NOT_FOUND", "Run not found.");
				if (
					job.completedGeneration === request.leaseGeneration &&
					job.leaseOwnerId === runner.credentialId
				) {
					return ok({ state: job.state, replayed: true, newArticleCount: 0 });
				}
				const lease = checkLease(leaseView(job), {
					runnerId: runner.credentialId,
					leaseGeneration: request.leaseGeneration,
				});
				if (!lease.ok) return staleLease(lease.error);

				const isIngest = job.kind === "news-ingest";
				const isMarket = job.kind === "market-refresh";
				const isEarnings = job.kind === "earnings-refresh";
				const isResearch = job.kind === "research";
				const isGoogle = job.kind === "google-calendar";
				const isNotebook = job.kind === "notebook-assist";
				const isDirectory = job.kind === "stock-directory-refresh";
				const researchOnly = request.outcome === "completed" || request.outcome === "partial";
				const marketOnly = request.outcome === "market-refreshed";
				const earningsOnly = request.outcome === "earnings-refreshed";
				const notebookOnly = request.outcome === "notebook-assisted";
				const directoryOnly = request.outcome === "stock-directory-refreshed";
				const googleOnly =
					request.outcome === "google-calendar-connected" ||
					request.outcome === "google-calendar-synced" ||
					request.outcome === "google-calendar-disconnected";
				if (
					(isIngest &&
						(researchOnly ||
							marketOnly ||
							earningsOnly ||
							googleOnly ||
							notebookOnly ||
							directoryOnly)) ||
					(isMarket &&
						!marketOnly &&
						request.outcome !== "failed" &&
						request.outcome !== "cancelled") ||
					(isEarnings &&
						!earningsOnly &&
						request.outcome !== "failed" &&
						request.outcome !== "cancelled") ||
					(isResearch &&
						(request.outcome === "ingested" ||
							marketOnly ||
							earningsOnly ||
							googleOnly ||
							notebookOnly ||
							directoryOnly)) ||
					(isGoogle &&
						!googleOnly &&
						request.outcome !== "failed" &&
						request.outcome !== "cancelled") ||
					(isNotebook &&
						!notebookOnly &&
						request.outcome !== "failed" &&
						request.outcome !== "cancelled") ||
					(isDirectory &&
						!directoryOnly &&
						request.outcome !== "failed" &&
						request.outcome !== "cancelled") ||
					(notebookOnly && !isNotebook) ||
					(directoryOnly && !isDirectory)
				) {
					return fail("VALIDATION_FAILED", "This outcome does not apply to this kind of job.");
				}
				if (isGoogle && googleOnly) {
					// Each step has exactly one success outcome: a connect
					// answered as `synced` would complete the run and leave the
					// link row `connecting`.
					const action =
						job.request !== null && "action" in job.request ? job.request.action : null;
					const expected =
						action === "connect"
							? "google-calendar-connected"
							: action === "sync"
								? "google-calendar-synced"
								: action === "disconnect"
									? "google-calendar-disconnected"
									: null;
					if (request.outcome !== expected) {
						return fail("VALIDATION_FAILED", "This outcome does not apply to this kind of job.");
					}
				}

				const now = deps.clock.nowIso();
				let target: JobState;
				// S4a: completion series that left the dashboard since the claim.
				let droppedMarketSeries = 0;
				// FR-018: completion stocks that left the watchlist since the claim.
				let droppedEarningsStocks = 0;
				let effects: CompletionEffects = {
					bundle: null,
					articles: [],
					sourceReports: [],
					workspace: null,
					assistantMessage: null,
					marketSeries: [],
					earnings: [],
					google: null,
					notebook: null,
					notebookTurn: null,
					stockDirectory: null,
				};
				const patch: { -readonly [K in keyof JobPatch]: JobPatch[K] } = {
					usage: cumulativeUsage(job.usage, request.usage),
					completedGeneration: request.leaseGeneration,
					leaseExpiresAt: null,
					cancelRequested: false,
				};
				// The owner asked to stop: a result that arrives afterwards is discarded.
				const outcome = job.cancelRequested ? "cancelled" : request.outcome;
				if (outcome === "cancelled") {
					target = "cancelled";
					// Finding 11: every completion outcome sets failure metadata
					// explicitly, so a previous attempt's detail never survives.
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
				} else if (request.outcome === "failed") {
					// A google-calendar step is never retried on its own: a
					// retried connect would wait on a sign-in link the restored
					// link row no longer shows, and a failed sync is reported
					// and started again from the calendar controls (FR-019).
					const retry = request.retryable && job.attempt < job.maxAttempts && !isGoogle;
					target = retry ? "pending" : "failed";
					patch.failureCode = request.failureCode;
					patch.failureDetail = request.failureDetail ?? null;
					// The external service's own status, unchanged (§4a); a
					// runner built before the field existed sends none.
					patch.failureUpstreamStatus = request.failureUpstreamStatus ?? null;
					patch.approvalRequest = null;
				} else if (request.outcome === "waiting_approval") {
					target = "waiting_approval";
					patch.approvalRequest = request.approvalRequest;
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
				} else if (request.outcome === "ingested") {
					target = "completed";
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
					effects = {
						...effects,
						...(await ownedArticles(runner.ownerId, request.articles, request.sourceReports)),
					};
				} else if (request.outcome === "market-refreshed") {
					target = "completed";
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
					const built = await marketEffects(request);
					if (!built.ok) return built;
					// S4a: store only series on the owner's CURRENT dashboard or
					// in a CURRENT notebook — either may have changed since the
					// claim. Dropped series are counted in the audit detail,
					// never stored.
					const current = new Set([
						...distinctDashboardSeriesIds((await marketDashboard(runner.ownerId)).widgets),
						...(await deps.notebooks.listMarketSeriesIds(runner.ownerId)),
					]);
					const kept = built.value.marketSeries.filter((entry) => current.has(entry.seriesId));
					droppedMarketSeries = built.value.marketSeries.length - kept.length;
					effects = { ...built.value, marketSeries: kept };
				} else if (request.outcome === "earnings-refreshed") {
					target = "completed";
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
					const built = await earningsEffects(request);
					if (!built.ok) return built;
					// FR-018: store only stocks still on the owner's CURRENT
					// watchlist — it may have changed since the claim. Dropped
					// stocks are counted in the audit detail, never stored.
					const current = new Set(
						(await deps.watchlist.listStocks(runner.ownerId)).map((stock) => stock.stockId),
					);
					const kept = built.value.earnings.filter((entry) => current.has(entry.stockId));
					droppedEarningsStocks = built.value.earnings.length - kept.length;
					effects = { ...built.value, earnings: kept };
				} else if (request.outcome === "stock-directory-refreshed") {
					// ADR-0034: the completion must be the list of the market
					// this job was queued for — a JP list answering a US job
					// would replace the wrong market's rows.
					if (request.market !== directoryMarket(job)) {
						return fail(
							"VALIDATION_FAILED",
							"The stock list is not for the market this run downloads.",
						);
					}
					target = "completed";
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
					effects = {
						...effects,
						stockDirectory: {
							market: request.market,
							asOf: request.asOf,
							retrievedAt: request.fetchedAt,
							foldVersion: STOCK_SEARCH_FOLD_VERSION,
							rows: stockDirectoryRows(request.market, request.entries),
						},
					};
				} else if (request.outcome === "notebook-assisted") {
					target = "completed";
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
					const built = await notebookAssistedEffects(
						{
							notebooks: deps.notebooks,
							workspaces: deps.workspaces,
							ids: deps.ids,
							records: deps.records,
						},
						job,
						request,
						now,
					);
					if (!built.ok) return built;
					effects = {
						bundle: null,
						articles: [],
						sourceReports: [],
						workspace: null,
						marketSeries: [],
						earnings: [],
						google: null,
						notebook: built.value.notebook,
						notebookTurn: built.value.notebookTurn,
						assistantMessage: built.value.assistantMessage,
						stockDirectory: null,
					};
				} else if (request.outcome === "completed" || request.outcome === "partial") {
					target = request.outcome;
					const built = await bundleEffects(job, request, now);
					if (!built.ok) return built;
					effects = built.value;
					patch.verificationStatus = request.bundle.verificationStatus;
					patch.providerModel = request.bundle.provenance.providerModel;
					patch.provenance = request.bundle.provenance;
					if (request.outcome === "partial") {
						patch.failureCode = request.failureCode;
						patch.failureDetail = null;
						patch.failureUpstreamStatus = request.failureUpstreamStatus ?? null;
					} else {
						patch.failureCode = null;
						patch.failureDetail = null;
						patch.failureUpstreamStatus = null;
					}
					patch.approvalRequest = null;
				} else if (
					request.outcome === "google-calendar-connected" ||
					request.outcome === "google-calendar-synced" ||
					request.outcome === "google-calendar-disconnected"
				) {
					target = "completed";
					patch.failureCode = null;
					patch.failureDetail = null;
					patch.failureUpstreamStatus = null;
					patch.approvalRequest = null;
					effects = { ...effects, google: googleSuccessPatch(request, now) };
				} else {
					return fail("VALIDATION_FAILED", "Unknown completion outcome.");
				}
				if (isGoogle && (outcome === "cancelled" || request.outcome === "failed")) {
					// Terminal bookkeeping for runs that end without a
					// google success outcome: a failed/cancelled connect
					// restores the previous status; AUTH_EXPIRED on sync
					// moves to needs-reconnect (FR-019 section 2.5).
					const action =
						job.request !== null && "action" in job.request ? job.request.action : null;
					const link = await deps.googleCalendar.get(runner.ownerId);
					effects = {
						...effects,
						google:
							action === null
								? null
								: googleTerminalPatch(
										link,
										action,
										outcome === "cancelled" ? "cancelled" : "failed",
										request.outcome === "failed" ? request.failureCode : null,
										request.outcome === "failed" ? (request.failureUpstreamStatus ?? null) : null,
										now,
									),
					};
				}

				const transition = transitionJob(job.state, target);
				if (!transition.ok) {
					return fail(
						"ILLEGAL_TRANSITION",
						"The run cannot finish this way from its current state.",
						`${job.state}->${target}`,
					);
				}
				patch.state = target;
				// FR-019: sync counts travel in the transition detail (counts only, never tokens).
				const googleDetail =
					isGoogle && outcome !== "cancelled" && request.outcome === "google-calendar-synced"
						? `completion: ${outcome}, inserted=${request.inserted} updated=${request.updated} deleted=${request.deleted} unchanged=${request.unchanged}`
						: null;
				// ADR-0034: the stored list's market and size travel in the
				// transition detail (counts only).
				const directoryDetail =
					effects.stockDirectory === null
						? null
						: `completion: ${outcome}, market=${effects.stockDirectory.market} entries=${effects.stockDirectory.rows.length}`;
				const committed = await deps.unitOfWork.commitCompletion(
					runner.ownerId,
					{
						runId,
						expectedVersion: job.version,
						patch,
						audits: [
							auditFor(
								runner,
								job.state,
								target,
								googleDetail ??
									directoryDetail ??
									// S4a / FR-018: dropped off-dashboard/off-watchlist
									// counts travel in the audit detail.
									(droppedMarketSeries > 0 || droppedEarningsStocks > 0
										? `completion: ${outcome}, dropped ${droppedMarketSeries} off-dashboard series, dropped ${droppedEarningsStocks} off-watchlist stocks`
										: `completion: ${outcome}`),
							),
						],
						at: now,
					},
					effects,
				);
				if (committed.kind === "committed") {
					if (isNotebook && request.outcome === "notebook-assisted") {
						// One agent-origin audit row per assistant turn: the
						// applied version, or the stable failure code when the
						// turn applied nothing (ids and codes only, SEC-010).
						const turn = effects.notebookTurn?.turn;
						if (turn !== undefined) {
							await deps.audit.record({
								ownerId: runner.ownerId,
								actor: `runner:${runner.credentialId}`,
								action: "notebook.assist.turn",
								resource: runId,
								detail:
									turn.appliedVersion !== null
										? `appliedVersion=${turn.appliedVersion}`
										: `failure=${turn.failure?.code ?? "UNKNOWN"}`,
								at: now,
							});
						}
					}
					// Owner-visible audit rows for the three google outcomes
					// (detail = counts / codes only, never tokens).
					if (isGoogle && outcome !== "cancelled") {
						const entry =
							request.outcome === "google-calendar-connected"
								? {
										action: "google_calendar.connected",
										detail: `calendar=${request.calendarId}`,
									}
								: request.outcome === "google-calendar-synced"
									? {
											action: "google_calendar.synced",
											detail: `inserted=${request.inserted} updated=${request.updated} deleted=${request.deleted} unchanged=${request.unchanged}`,
										}
									: request.outcome === "google-calendar-disconnected"
										? {
												action: "google_calendar.disconnected",
												detail: `revoked=${request.revoked}`,
											}
										: null;
						if (entry !== null) {
							await deps.audit.record({
								ownerId: runner.ownerId,
								actor: `runner:${runner.credentialId}`,
								action: entry.action,
								resource: runId,
								detail: entry.detail,
								at: now,
							});
						}
					}
					return ok({ state: target, replayed: false, newArticleCount: committed.newArticleCount });
				}
				if (committed.kind === "notebook-conflict") {
					// The notebook moved past the turn's base version while it
					// was computed: the loop runs once more, which re-reads the
					// stored notebook and records NOTEBOOK_CHANGED instead of
					// applying anything.
				} else {
					// A concurrent heartbeat or an owner edit moved a version.
					// Still conflicting: stop here, inside the request's query
					// budget. The request is idempotent, so the runner simply
					// sends it again.
					return fail("CONFLICT", "The run or its workspace changed concurrently; resend.");
				}
			}
			// Only a second consecutive notebook-conflict lands here (the
			// notebook moved again between the re-read and the commit): stop
			// inside the request's query budget. The request is idempotent, so
			// the runner simply sends it again.
			return fail("CONFLICT", "The run or its workspace changed concurrently; resend.");
		},

		/** Lets the runner tell a finished run from one it should keep working on. */
		isFinished: (state: JobState): boolean => isTerminalJobState(state),
	};
}

export type RunnerJobService = ReturnType<typeof createRunnerJobService>;
