import type {
	ArticlePage,
	ArticleRepository,
	AuditLog,
	CalendarFeedRecord,
	CalendarFeedRepository,
	ChartEvidenceReferences,
	ChatRepository,
	EarningsRepository,
	EnqueueResult,
	GoogleCalendarLink,
	GoogleCalendarLinkPatch,
	GoogleCalendarRepository,
	HomeDashboardRepository,
	JobKindScope,
	JobRecord,
	JobRepository,
	JobWrite,
	MarketRepository,
	MarketSeriesRefreshState,
	NotebookRepository,
	RateLimiter,
	ReferenceLookup,
	ResearchRecordRepository,
	RunnerCredentialRepository,
	RunnerStatusRepository,
	SettingsRepository,
	SourceRepository,
	StockDirectoryRepository,
	StoredEarningsEvent,
	StoredMarketObservation,
	StoredWatchlistStock,
	WatchlistRepository,
	WorkspaceRepository,
} from "@research/application";
import { toProgressRows } from "@research/application";
import {
	agentDescriptorSchema,
	claimSchema,
	datasetSchema,
	demandScenarioSchema,
	EMPTY_NOTEBOOK,
	evidenceSchema,
	financialObservationSchema,
	homeDashboardSchema,
	idSchema,
	investorFilingSchema,
	NOTEBOOK_LIMITS,
	notebookSchema,
	parseMarketSeriesId,
	positionObservationSchema,
	pricingPowerRecordSchema,
	type RunRecords,
	securitySchema,
	supplierLinkSchema,
	type UpdateSourceRequest,
} from "@research/contracts";
import {
	LEASED_JOB_STATES,
	parseJsonOrNull,
	STOCK_SEARCH_LIMITS,
	stockSearchTerms,
	TERMINAL_JOB_STATES,
} from "@research/domain";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import {
	bodyOf,
	decode,
	numberColumn,
	parseJsonColumn,
	StoredDataError,
	statusBesideCode,
	storedUpstreamStatus,
	textColumn,
	toAppliedCommand,
	toArticle,
	toCalendarFeedRecord,
	toChatMessage,
	toConversationSummary,
	toGoogleCalendarLink,
	toHomeDashboardRecord,
	toJobRecord,
	toNewsSource,
	toNotebookRecord,
	toNotebookRevision,
	toNotebookTurn,
	toRunnerCredential,
	toStockDirectoryMeta,
	toStoredAgentSettings,
	toStoredEarningsEvent,
	toStoredMarketSeries,
	toStoredStockDirectoryEntry,
	toStoredWatchlistStock,
	toWorkspaceRecord,
	toWorkspaceSummary,
} from "./rows.ts";
import { chunkStockDirectoryRows } from "./stockDirectoryChunks.ts";

/** Quoted, comma-separated SQL literals for a fixed list of state names. */
const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
const LEASED_SQL = sqlList(LEASED_JOB_STATES);
export const TERMINAL_SQL = sqlList(TERMINAL_JOB_STATES);

/* ---------- Sources and articles ---------- */

const SOURCE_PATCH_COLUMNS: { readonly [K in keyof UpdateSourceRequest]-?: string } = {
	title: "title",
	publisher: "publisher",
	licensePolicy: "license_policy",
	trustClassification: "trust_classification",
	feedStatus: "feed_status",
};

export function createSourceRepository(db: SqlDatabase): SourceRepository {
	return {
		async list(ownerId) {
			const { results } = await db
				.prepare("SELECT * FROM news_sources WHERE owner_id = ? ORDER BY created_at, source_id")
				.bind(ownerId)
				.all();
			return results.map(toNewsSource);
		},
		async get(ownerId, sourceId) {
			const row = await db
				.prepare("SELECT * FROM news_sources WHERE owner_id = ? AND source_id = ?")
				.bind(ownerId, sourceId)
				.first();
			return row === null ? null : toNewsSource(row);
		},
		async findByCanonicalUrl(ownerId, canonicalUrl) {
			const row = await db
				.prepare("SELECT * FROM news_sources WHERE owner_id = ? AND canonical_url = ?")
				.bind(ownerId, canonicalUrl)
				.first();
			return row === null ? null : toNewsSource(row);
		},
		async insert(ownerId, source) {
			const result = await db
				.prepare(
					`INSERT INTO news_sources (owner_id, source_id, canonical_url, source_type, title, publisher,
						license_policy, trust_classification, feed_status, last_fetched_at, last_error_code,
						last_error_upstream_status, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT (owner_id, canonical_url) DO NOTHING`,
				)
				.bind(
					ownerId,
					source.sourceId,
					source.canonicalUrl,
					source.sourceType,
					source.title,
					source.publisher,
					source.licensePolicy,
					source.trustClassification,
					source.feedStatus,
					source.lastFetchedAt,
					source.lastErrorCode,
					source.lastErrorUpstreamStatus,
					source.createdAt,
					source.updatedAt,
				)
				.run();
			return result.meta.changes === 1;
		},
		async update(ownerId, sourceId, patch, updatedAt) {
			// Column names come from a fixed map keyed by the validated patch, never from input.
			const assignments: string[] = [];
			const values: string[] = [];
			for (const [key, column] of Object.entries(SOURCE_PATCH_COLUMNS)) {
				const value = Object.entries(patch).find(([name]) => name === key)?.[1];
				if (typeof value === "string") {
					assignments.push(`${column} = ?`);
					values.push(value);
				}
			}
			const row = await db
				.prepare(
					`UPDATE news_sources SET ${[...assignments, "updated_at = ?"].join(", ")}
					WHERE owner_id = ? AND source_id = ? RETURNING *`,
				)
				.bind(...values, updatedAt, ownerId, sourceId)
				.first();
			return row === null ? null : toNewsSource(row);
		},
		async delete(ownerId, sourceId) {
			const result = await db
				.prepare("DELETE FROM news_sources WHERE owner_id = ? AND source_id = ?")
				.bind(ownerId, sourceId)
				.run();
			return result.meta.changes === 1;
		},
	};
}

const cursorSchema = z.tuple([z.string(), z.string()]);

function decodeCursor(cursor: string | null): readonly [string, string] | null {
	if (cursor === null) return null;
	// An unreadable cursor is treated as "start from the beginning", not an error.
	let decoded: string;
	try {
		decoded = atob(cursor);
	} catch {
		// atob throws only InvalidCharacterError: the cursor is not base64.
		return null;
	}
	const parsed = cursorSchema.safeParse(parseJsonOrNull(decoded));
	return parsed.success ? parsed.data : null;
}

export function createArticleRepository(db: SqlDatabase): ArticleRepository {
	return {
		async list(ownerId, query): Promise<ArticlePage> {
			const after = decodeCursor(query.cursor);
			const { results } = await db
				.prepare(
					`SELECT * FROM articles
					WHERE owner_id = ?1
						AND (?2 IS NULL OR source_id = ?2)
						AND (?3 IS NULL OR (retrieved_at, article_id) < (?3, ?4))
					ORDER BY retrieved_at DESC, article_id DESC
					LIMIT ?5`,
				)
				.bind(ownerId, query.sourceId, after?.[0] ?? null, after?.[1] ?? null, query.limit + 1)
				.all();
			const articles = results.slice(0, query.limit).map(toArticle);
			const last = articles.at(-1);
			return {
				articles,
				nextCursor:
					results.length > query.limit && last !== undefined
						? btoa(JSON.stringify([last.retrievedAt, last.articleId]))
						: null,
			};
		},
	};
}

/* ---------- Jobs ---------- */

/**
 * Statement that inserts a job row unless its idempotency key is already taken
 * or the owner already has `maxUnfinished` unfinished jobs. The capacity test is
 * part of the INSERT itself, so two concurrent requests cannot both pass it.
 * When the job names a workspace, that workspace must still exist: the test is
 * part of the INSERT, so a run submitted against a concurrently deleted
 * conversation writes nothing instead of orphaning a job.
 *
 * S1: "at most one active refresh job per owner, per refresh kind" is
 * enforced the same way — the INSERT is a no-op while an unfinished job of
 * the same refresh kind (`market-refresh`, `earnings-refresh` or
 * `google-calendar`) exists for the owner, no matter which idempotency key
 * the concurrent request used. `enqueueOutcome` maps that no-op back to the
 * active run, so the loser of the race answers with the winner's run id.
 *
 * ADR-0020: "at most one active notebook-assist job per conversation" is
 * enforced the same way, scoped to the workspace instead of the owner — the
 * INSERT is a no-op while an unfinished `notebook-assist` job of the same
 * workspace exists.
 *
 * ADR-0034: "at most one active stock-directory-refresh job per market" is
 * enforced the same way, scoped to the market the stored request names.
 */
export function insertJobStatement(
	db: SqlDatabase,
	job: JobRecord,
	idempotencyKey: string,
	requestFingerprint: string,
	mutationId: string,
	maxUnfinished: number,
): SqlStatement {
	return db
		.prepare(
			`INSERT INTO research_jobs (owner_id, run_id, kind, state, idempotency_key, request_fingerprint,
				request_json, workspace_id, usage_json, attempt, max_attempts, lease_generation, lease_owner_id,
				lease_expires_at, last_event_seq, cancel_requested, failure_code, failure_detail, failure_upstream_status,
				approval_request_json, retry_of_run_id, context_anchor_seq, verification_status, provider_model, provider_session_ref,
				completed_generation, provenance_json, version, last_mutation_id, created_at, updated_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (SELECT COUNT(*) FROM research_jobs
				WHERE owner_id = ? AND state NOT IN (${TERMINAL_SQL})) < ?
				AND (? IS NULL OR EXISTS (SELECT 1 FROM workspaces WHERE owner_id = ? AND workspace_id = ?))
				AND NOT (? IN ('market-refresh', 'earnings-refresh', 'google-calendar') AND EXISTS (SELECT 1 FROM research_jobs
					WHERE owner_id = ? AND kind = ? AND state NOT IN (${TERMINAL_SQL})))
				AND NOT (? = 'notebook-assist' AND ? IS NOT NULL AND EXISTS (SELECT 1 FROM research_jobs
					WHERE owner_id = ? AND workspace_id = ? AND kind = 'notebook-assist' AND state NOT IN (${TERMINAL_SQL})))
				AND NOT (? = 'stock-directory-refresh' AND EXISTS (SELECT 1 FROM research_jobs
					WHERE owner_id = ? AND kind = 'stock-directory-refresh'
						AND json_extract(request_json, '$.market') = json_extract(?, '$.market')
						AND state NOT IN (${TERMINAL_SQL})))
			ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
		)
		.bind(
			job.ownerId,
			job.runId,
			job.kind,
			job.state,
			idempotencyKey,
			requestFingerprint,
			job.request === null ? null : JSON.stringify(job.request),
			job.workspaceId,
			JSON.stringify(job.usage),
			job.attempt,
			job.maxAttempts,
			job.leaseGeneration,
			job.leaseOwnerId,
			job.leaseExpiresAt,
			job.lastEventSeq,
			job.cancelRequested ? 1 : 0,
			job.failureCode,
			job.failureDetail,
			job.failureUpstreamStatus,
			job.approvalRequest === null ? null : JSON.stringify(job.approvalRequest),
			job.retryOfRunId,
			job.contextAnchorSeq,
			job.verificationStatus,
			job.providerModel,
			job.providerSessionRef,
			job.completedGeneration,
			job.provenance === null ? null : JSON.stringify(job.provenance),
			job.version,
			mutationId,
			job.createdAt,
			job.updatedAt,
			job.ownerId,
			maxUnfinished,
			job.workspaceId,
			job.ownerId,
			job.workspaceId,
			job.kind,
			job.ownerId,
			job.kind,
			job.kind,
			job.workspaceId,
			job.ownerId,
			job.workspaceId,
			job.kind,
			job.ownerId,
			job.request === null ? null : JSON.stringify(job.request),
		);
}

/**
 * `AND`-clause narrowing a by-kind job query to one market's
 * `stock-directory-refresh` jobs (ADR-0034); the market sits in the stored
 * request. `?N` is the parameter number the market is bound to (NULL = any).
 */
function marketScopeSql(parameter: number): string {
	return `(?${parameter} IS NULL OR json_extract(request_json, '$.market') = ?${parameter})`;
}

/**
 * Newest non-terminal job of a kind, if any (shared by the repository and the
 * enqueue path); with a scope, only that market's jobs.
 */
async function findActiveJobByKind(
	db: SqlDatabase,
	ownerId: string,
	kind: string,
	scope: JobKindScope | undefined,
) {
	const { results } = await db
		.prepare(
			`SELECT * FROM research_jobs
			WHERE owner_id = ?1 AND kind = ?2 AND state NOT IN (${TERMINAL_SQL}) AND ${marketScopeSql(3)}
			ORDER BY created_at DESC, run_id DESC LIMIT 1`,
		)
		.bind(ownerId, kind, scope?.market ?? null)
		.all();
	const row = results[0];
	return row === undefined ? null : toJobRecord(row);
}

/**
 * Why an enqueue INSERT changed no row: the idempotency key already names a
 * job (a replay or a key reuse), the named workspace is gone, the owner is
 * at the unfinished-job cap, or — for a refresh kind (`market-refresh`,
 * `earnings-refresh`, `google-calendar`) — an unfinished job of that kind already exists (S1:
 * the INSERT itself refused the second active job, so map the no-op back to
 * the active run instead of reporting capacity). The key is checked first so
 * a replay still answers from the stored job.
 */
export async function enqueueOutcome(
	db: SqlDatabase,
	job: JobRecord,
	idempotencyKey: string,
	requestFingerprint: string,
): Promise<EnqueueResult> {
	const existing = await findJobByIdempotencyKey(db, job.ownerId, idempotencyKey);
	if (existing !== null) {
		return {
			kind: "existing",
			job: existing,
			sameRequest: existing.requestFingerprint === requestFingerprint,
		};
	}
	if (
		job.kind === "market-refresh" ||
		job.kind === "earnings-refresh" ||
		job.kind === "google-calendar"
	) {
		const active = await findActiveJobByKind(db, job.ownerId, job.kind, undefined);
		if (active !== null) {
			const { requestFingerprint: _fingerprint, ...record } = active;
			return { kind: "kind-active", job: record };
		}
	}
	if (job.kind === "stock-directory-refresh" && job.request !== null && "market" in job.request) {
		// ADR-0034: the INSERT refused a second active run of this market.
		const active = await findActiveJobByKind(db, job.ownerId, job.kind, {
			market: job.request.market,
		});
		if (active !== null) {
			const { requestFingerprint: _fingerprint, ...record } = active;
			return { kind: "kind-active", job: record };
		}
	}
	if (job.kind === "notebook-assist" && job.workspaceId !== null) {
		// ADR-0020: the INSERT itself refused a second active assistant turn
		// for this conversation, so map the no-op back to that run instead of
		// reporting capacity.
		const { results } = await db
			.prepare(
				`SELECT * FROM research_jobs
				WHERE owner_id = ?1 AND workspace_id = ?2 AND kind = 'notebook-assist'
					AND state NOT IN (${TERMINAL_SQL})
				ORDER BY created_at DESC, run_id DESC LIMIT 1`,
			)
			.bind(job.ownerId, job.workspaceId)
			.all();
		const row = results[0];
		if (row !== undefined) {
			const { requestFingerprint: _fingerprint, ...record } = toJobRecord(row);
			return { kind: "kind-active", job: record };
		}
	}
	if (job.workspaceId !== null && !(await workspaceExists(db, job.ownerId, job.workspaceId))) {
		return { kind: "no-workspace" };
	}
	return { kind: "at-capacity" };
}

/** Whether the owner's conversation still exists (guards enqueue against a concurrent delete). */
export async function workspaceExists(
	db: SqlDatabase,
	ownerId: string,
	workspaceId: string,
): Promise<boolean> {
	const row = await db
		.prepare("SELECT 1 AS found FROM workspaces WHERE owner_id = ? AND workspace_id = ?")
		.bind(ownerId, workspaceId)
		.first();
	return row !== null;
}

export async function findJobByIdempotencyKey(
	db: SqlDatabase,
	ownerId: string,
	idempotencyKey: string,
) {
	const row = await db
		.prepare("SELECT * FROM research_jobs WHERE owner_id = ? AND idempotency_key = ?")
		.bind(ownerId, idempotencyKey)
		.first();
	return row === null ? null : toJobRecord(row);
}

/** Column assignments for a job patch. Keys are a closed set; values are bound, never inlined. */
function jobAssignments(patch: JobWrite["patch"]): { sql: string[]; values: SqlValue[] } {
	const sql: string[] = [];
	const values: SqlValue[] = [];
	const set = (column: string, value: SqlValue) => {
		sql.push(`${column} = ?`);
		values.push(value);
	};
	if (patch.state !== undefined) set("state", patch.state);
	if (patch.request !== undefined) {
		set("request_json", patch.request === null ? null : JSON.stringify(patch.request));
	}
	if (patch.workspaceId !== undefined) set("workspace_id", patch.workspaceId);
	if (patch.usage !== undefined) set("usage_json", JSON.stringify(patch.usage));
	if (patch.attempt !== undefined) set("attempt", patch.attempt);
	if (patch.maxAttempts !== undefined) set("max_attempts", patch.maxAttempts);
	if (patch.leaseGeneration !== undefined) set("lease_generation", patch.leaseGeneration);
	if (patch.leaseOwnerId !== undefined) set("lease_owner_id", patch.leaseOwnerId);
	if (patch.leaseExpiresAt !== undefined) set("lease_expires_at", patch.leaseExpiresAt);
	if (patch.lastEventSeq !== undefined) set("last_event_seq", patch.lastEventSeq);
	if (patch.cancelRequested !== undefined) set("cancel_requested", patch.cancelRequested ? 1 : 0);
	if (patch.failureCode !== undefined) set("failure_code", patch.failureCode);
	if (patch.failureDetail !== undefined) set("failure_detail", patch.failureDetail);
	if (patch.failureUpstreamStatus !== undefined) {
		set("failure_upstream_status", patch.failureUpstreamStatus);
	}
	if (patch.approvalRequest !== undefined) {
		set(
			"approval_request_json",
			patch.approvalRequest === null ? null : JSON.stringify(patch.approvalRequest),
		);
	}
	if (patch.contextAnchorSeq !== undefined) set("context_anchor_seq", patch.contextAnchorSeq);
	if (patch.verificationStatus !== undefined) set("verification_status", patch.verificationStatus);
	if (patch.providerModel !== undefined) set("provider_model", patch.providerModel);
	if (patch.providerSessionRef !== undefined) set("provider_session_ref", patch.providerSessionRef);
	if (patch.completedGeneration !== undefined) {
		set("completed_generation", patch.completedGeneration);
	}
	if (patch.provenance !== undefined) {
		set("provenance_json", patch.provenance === null ? null : JSON.stringify(patch.provenance));
	}
	return { sql, values };
}

/** `EXISTS` guard true only inside a batch whose job compare-and-set (tagged `mutationId`) won. */
export const JOB_GUARD_SQL =
	"EXISTS (SELECT 1 FROM research_jobs WHERE owner_id = ? AND run_id = ? AND last_mutation_id = ?)";

/**
 * Statements for one job compare-and-set plus its audit rows. The UPDATE is
 * first; every later statement in the same batch is conditional on it having
 * stamped `mutationId`, so a lost race writes nothing at all.
 *
 * @param extraCondition optional additional SQL condition (with its bound
 *   values) the UPDATE must also satisfy, e.g. an expected workspace version.
 */
export function jobWriteStatements(
	db: SqlDatabase,
	ownerId: string,
	write: JobWrite,
	mutationId: string,
	extraCondition?: { readonly sql: string; readonly values: readonly SqlValue[] },
): SqlStatement[] {
	const { sql, values } = jobAssignments(write.patch);
	const update = db
		.prepare(
			`UPDATE research_jobs
			SET ${[...sql, "version = version + 1", "last_mutation_id = ?", "updated_at = ?"].join(", ")}
			WHERE owner_id = ? AND run_id = ? AND version = ?${
				extraCondition === undefined ? "" : ` AND ${extraCondition.sql}`
			}`,
		)
		.bind(
			...values,
			mutationId,
			write.at,
			ownerId,
			write.runId,
			write.expectedVersion,
			...(extraCondition?.values ?? []),
		);
	const audits = write.audits.map((audit) =>
		db
			.prepare(
				`INSERT INTO job_transitions (owner_id, run_id, from_state, to_state, lease_generation, actor, reason, at)
				SELECT owner_id, run_id, ?, ?, lease_generation, ?, ?, ?
				FROM research_jobs WHERE owner_id = ? AND run_id = ? AND last_mutation_id = ?`,
			)
			.bind(
				audit.fromState,
				audit.toState,
				audit.actor,
				audit.reason,
				write.at,
				ownerId,
				write.runId,
				mutationId,
			),
	);
	return [update, ...audits];
}

/** The newest counted `completed` job of a kind: its completion time. */
const latestSuccessRowSchema = z.object({ updated_at: z.string() });

/** The newest `failed` job of a kind: its code, the upstream status beside it (§4a), its time. */
const latestFailedRowSchema = z.object({
	failure_code: z.string().nullable(),
	failure_upstream_status: storedUpstreamStatus,
	updated_at: z.string(),
});

/** The newest non-completed terminal job of a kind (S2), likewise. */
const latestFailureRowSchema = latestFailedRowSchema.extend({ state: z.string() });

export function createJobRepository(db: SqlDatabase): JobRepository {
	const get = async (ownerId: string, runId: string) => {
		const row = await db
			.prepare("SELECT * FROM research_jobs WHERE owner_id = ? AND run_id = ?")
			.bind(ownerId, runId)
			.first();
		return row === null ? null : toJobRecord(row);
	};

	return {
		get,
		async insert(job, idempotencyKey, requestFingerprint, maxUnfinished) {
			const result = await insertJobStatement(
				db,
				job,
				idempotencyKey,
				requestFingerprint,
				crypto.randomUUID(),
				maxUnfinished,
			).run();
			if (result.meta.changes === 1) return { kind: "inserted" };
			return enqueueOutcome(db, job, idempotencyKey, requestFingerprint);
		},
		async findByIdempotencyKey(ownerId, idempotencyKey) {
			const existing = await findJobByIdempotencyKey(db, ownerId, idempotencyKey);
			return existing === null
				? null
				: { job: existing, requestFingerprint: existing.requestFingerprint };
		},
		async list(ownerId, query) {
			const { results } = await db
				.prepare(
					`SELECT * FROM research_jobs
					WHERE owner_id = ?1 AND (?2 IS NULL OR workspace_id = ?2)
					ORDER BY created_at DESC, run_id DESC LIMIT ?3`,
				)
				.bind(ownerId, query.workspaceId, query.limit)
				.all();
			return results.map(toJobRecord);
		},
		async listClaimCandidates(ownerId, nowIso, limit) {
			const { results } = await db
				.prepare(
					`SELECT * FROM research_jobs
					WHERE owner_id = ?1
						AND (state = 'pending'
							OR (state IN (${LEASED_SQL}) AND (lease_expires_at IS NULL OR lease_expires_at <= ?2)))
					ORDER BY created_at, run_id LIMIT ?3`,
				)
				.bind(ownerId, nowIso, limit)
				.all();
			return results.map(toJobRecord);
		},
		async findLatestResearchRequest(ownerId) {
			// One row, newest first: news-ingest jobs carry no request and
			// must never hide the most recent research run.
			const row = await db
				.prepare(
					`SELECT * FROM research_jobs
					WHERE owner_id = ?1 AND kind = 'research' AND request_json IS NOT NULL
					ORDER BY created_at DESC, run_id DESC LIMIT 1`,
				)
				.bind(ownerId)
				.first();
			if (row === null) return null;
			const request = toJobRecord(row).request;
			// Research rows carry research requests; anything else is a
			// storage fault, answered as absent (fail closed).
			return request !== null && "agentId" in request ? request : null;
		},
		async write(ownerId, write) {
			const results = await db.batch(jobWriteStatements(db, ownerId, write, crypto.randomUUID()));
			return results[0]?.meta.changes === 1;
		},
		async writeWithEvents(ownerId, write, leaseGeneration, events) {
			const mutationId = crypto.randomUUID();
			const rows = toProgressRows(events);
			const statements = jobWriteStatements(db, ownerId, write, mutationId);
			if (rows.length > 0) {
				statements.push(
					db
						.prepare(
							`INSERT OR IGNORE INTO job_events (owner_id, run_id, lease_generation, seq, kind, text, at)
							SELECT ?, ?, ?, json_extract(value, '$.seq'), json_extract(value, '$.kind'),
								json_extract(value, '$.text'), json_extract(value, '$.at')
							FROM json_each(?) WHERE ${JOB_GUARD_SQL}`,
						)
						.bind(
							ownerId,
							write.runId,
							leaseGeneration,
							JSON.stringify(rows),
							ownerId,
							write.runId,
							mutationId,
						),
				);
			}
			const results = await db.batch(statements);
			return results[0]?.meta.changes === 1;
		},
		async listProgress(ownerId, runId, limit) {
			const { results } = await db
				.prepare(
					`SELECT at, kind, text FROM job_events WHERE owner_id = ? AND run_id = ?
					ORDER BY lease_generation DESC, seq DESC LIMIT ?`,
				)
				.bind(ownerId, runId, limit)
				.all();
			const entrySchema = z.object({
				at: z.string(),
				kind: z.enum(["state", "note", "tool"]),
				text: z.string(),
			});
			return results.map((row) => entrySchema.parse(row)).reverse();
		},
		async findActiveByKind(ownerId, kind, scope) {
			const active = await findActiveJobByKind(db, ownerId, kind, scope);
			if (active === null) return null;
			const { requestFingerprint: _fingerprint, ...record } = active;
			return record;
		},
		async findActiveNotebookAssist(ownerId, workspaceId) {
			const { results } = await db
				.prepare(
					`SELECT * FROM research_jobs
					WHERE owner_id = ?1 AND workspace_id = ?2 AND kind = 'notebook-assist'
						AND state NOT IN (${TERMINAL_SQL})
					ORDER BY created_at DESC, run_id DESC LIMIT 1`,
				)
				.bind(ownerId, workspaceId)
				.all();
			const row = results[0];
			if (row === undefined) return null;
			const { requestFingerprint: _fingerprint, ...record } = toJobRecord(row);
			return record;
		},
		async findLatestSuccessAtByKind(ownerId, kind, scope) {
			// S2: only a COMPLETED run counts as a success — failed/cancelled
			// runs have their own line and never pose as one. ADR-0039: a run
			// that fetched only the unrefreshed items is not "the last
			// refresh" either — most data on screen is older than it. Other
			// kinds store no `scope`, so the clause never excludes them.
			const row = await db
				.prepare(
					`SELECT updated_at FROM research_jobs
					WHERE owner_id = ?1 AND kind = ?2 AND state = 'completed' AND ${marketScopeSql(3)}
						AND (request_json IS NULL OR json_extract(request_json, '$.scope') IS NOT 'unrefreshed')
					ORDER BY updated_at DESC, run_id DESC LIMIT 1`,
				)
				.bind(ownerId, kind, scope?.market ?? null)
				.first();
			if (row === null) return null;
			return decode("research_jobs", latestSuccessRowSchema, row).updated_at;
		},
		async findLatestFailedByKind(ownerId, kind, scope) {
			const row = await db
				.prepare(
					`SELECT failure_code, failure_upstream_status, updated_at FROM research_jobs
					WHERE owner_id = ?1 AND kind = ?2 AND state = 'failed' AND ${marketScopeSql(3)}
					ORDER BY updated_at DESC, run_id DESC LIMIT 1`,
				)
				.bind(ownerId, kind, scope?.market ?? null)
				.first();
			if (row === null) return null;
			const failed = decode("research_jobs", latestFailedRowSchema, row);
			return {
				failureCode: failed.failure_code,
				failureUpstreamStatus: statusBesideCode(
					failed.failure_code,
					failed.failure_upstream_status,
				),
				at: failed.updated_at,
			};
		},
		async countUnfinished(ownerId) {
			const row = await db
				.prepare(
					`SELECT COUNT(*) AS n FROM research_jobs WHERE owner_id = ? AND state NOT IN (${TERMINAL_SQL})`,
				)
				.bind(ownerId)
				.first();
			return row === null ? 0 : numberColumn("research_jobs", "n", row);
		},
		async findLatestFailureByKind(ownerId, kind, scope) {
			// S2: the newest terminal run that did not succeed (completed runs
			// are excluded here; they feed lastSucceededAt instead).
			const row = await db
				.prepare(
					`SELECT state, failure_code, failure_upstream_status, updated_at FROM research_jobs
					WHERE owner_id = ?1 AND kind = ?2 AND state IN (${TERMINAL_SQL}) AND state <> 'completed'
						AND ${marketScopeSql(3)}
					ORDER BY updated_at DESC, run_id DESC LIMIT 1`,
				)
				.bind(ownerId, kind, scope?.market ?? null)
				.first();
			if (row === null) return null;
			// A row whose state or time is not text has no line to show (null),
			// as before; a non-text code reads as no code.
			const parsed = latestFailureRowSchema.safeParse(row);
			if (!parsed.success) return null;
			const failureCode = parsed.data.failure_code;
			return {
				state: parsed.data.state,
				failureCode,
				failureUpstreamStatus: statusBesideCode(failureCode, parsed.data.failure_upstream_status),
				at: parsed.data.updated_at,
			};
		},
	};
}

/* ---------- Workspaces ---------- */

/** `EXISTS` guard true only inside a batch whose workspace compare-and-set won. */
export const WORKSPACE_GUARD_SQL =
	"EXISTS (SELECT 1 FROM workspaces WHERE owner_id = ? AND workspace_id = ? AND last_mutation_id = ?)";

export function insertCommandsStatement(
	db: SqlDatabase,
	ownerId: string,
	workspaceId: string,
	commands: Parameters<WorkspaceRepository["write"]>[1]["commands"],
	guard: { readonly sql: string; readonly values: readonly SqlValue[] },
): SqlStatement {
	const rows = commands.map((applied) => ({
		commandId: applied.command.commandId,
		version: applied.version,
		command: applied.command,
		origin: applied.origin,
		appliedAt: applied.appliedAt,
	}));
	return db
		.prepare(
			`INSERT INTO workspace_commands (owner_id, workspace_id, command_id, version, command_json, origin, applied_at)
			SELECT ?, ?, json_extract(value, '$.commandId'), json_extract(value, '$.version'),
				json_extract(value, '$.command'), json_extract(value, '$.origin'), json_extract(value, '$.appliedAt')
			FROM json_each(?) WHERE ${guard.sql}`,
		)
		.bind(ownerId, workspaceId, JSON.stringify(rows), ...guard.values);
}

export function createWorkspaceRepository(db: SqlDatabase): WorkspaceRepository {
	return {
		async list(ownerId) {
			const { results } = await db
				.prepare(
					`SELECT workspace_id, title, version, created_at, updated_at FROM workspaces
					WHERE owner_id = ? ORDER BY updated_at DESC, workspace_id`,
				)
				.bind(ownerId)
				.all();
			return results.map(toWorkspaceSummary);
		},
		async get(ownerId, workspaceId) {
			const row = await db
				.prepare("SELECT * FROM workspaces WHERE owner_id = ? AND workspace_id = ?")
				.bind(ownerId, workspaceId)
				.first();
			return row === null ? null : toWorkspaceRecord(row);
		},
		async insert(ownerId, record) {
			await db
				.prepare(
					`INSERT INTO workspaces (owner_id, workspace_id, title, version, state_json, last_mutation_id, created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					ownerId,
					record.summary.workspaceId,
					record.summary.title,
					record.state.version,
					JSON.stringify(record.state),
					crypto.randomUUID(),
					record.summary.createdAt,
					record.summary.updatedAt,
				)
				.run();
		},
		/**
		 * A rename touches the title only: the canvas version is not a
		 * compare-and-set here, so a rename racing a command write changes the
		 * label without invalidating the writer's expected version.
		 */
		async rename(ownerId, workspaceId, title, updatedAt) {
			const row = await db
				.prepare(
					`UPDATE workspaces SET title = ?, updated_at = ?
					WHERE owner_id = ? AND workspace_id = ?
					RETURNING workspace_id, title, version, created_at, updated_at`,
				)
				.bind(title, updatedAt, ownerId, workspaceId)
				.first();
			return row === null ? null : toWorkspaceSummary(row);
		},
		async listRecords(ownerId) {
			const { results } = await db
				.prepare(
					"SELECT * FROM workspaces WHERE owner_id = ? ORDER BY updated_at DESC, workspace_id",
				)
				.bind(ownerId)
				.all();
			return results.map(toWorkspaceRecord);
		},
		async findCommand(ownerId, workspaceId, commandId) {
			const row = await db
				.prepare(
					"SELECT * FROM workspace_commands WHERE owner_id = ? AND workspace_id = ? AND command_id = ?",
				)
				.bind(ownerId, workspaceId, commandId)
				.first();
			return row === null ? null : toAppliedCommand(row);
		},
		async write(ownerId, write) {
			const mutationId = crypto.randomUUID();
			const commandIds = JSON.stringify(write.commands.map((applied) => applied.command.commandId));
			const results = await db.batch([
				db
					.prepare(
						`UPDATE workspaces SET state_json = ?, version = ?, last_mutation_id = ?, updated_at = ?
						WHERE owner_id = ? AND workspace_id = ? AND version = ?
							AND NOT EXISTS (SELECT 1 FROM workspace_commands
								WHERE owner_id = ? AND workspace_id = ? AND command_id IN (SELECT value FROM json_each(?)))`,
					)
					.bind(
						JSON.stringify(write.nextState),
						write.nextState.version,
						mutationId,
						write.at,
						ownerId,
						write.workspaceId,
						write.expectedVersion,
						ownerId,
						write.workspaceId,
						commandIds,
					),
				insertCommandsStatement(db, ownerId, write.workspaceId, write.commands, {
					sql: WORKSPACE_GUARD_SQL,
					values: [ownerId, write.workspaceId, mutationId],
				}),
			]);
			if (results[0]?.meta.changes === 1) return "written";
			const duplicate = await db
				.prepare(
					`SELECT 1 AS found FROM workspace_commands
					WHERE owner_id = ? AND workspace_id = ? AND command_id IN (SELECT value FROM json_each(?)) LIMIT 1`,
				)
				.bind(ownerId, write.workspaceId, commandIds)
				.first();
			return duplicate === null ? "version-conflict" : "duplicate-command";
		},
		async listCommandsAfter(ownerId, workspaceId, afterVersion, limit) {
			const { results } = await db
				.prepare(
					`SELECT * FROM workspace_commands WHERE owner_id = ? AND workspace_id = ? AND version > ?
					ORDER BY version LIMIT ?`,
				)
				.bind(ownerId, workspaceId, afterVersion, limit)
				.all();
			return results.map(toAppliedCommand);
		},
	};
}

/* ---------- Research records ---------- */

export type RecordType =
	| "scenario"
	| "security"
	| "supplier-link"
	| "financial-observation"
	| "position-observation"
	| "investor-filing"
	| "pricing-power";

export function createResearchRecordRepository(db: SqlDatabase): ResearchRecordRepository {
	const byIds = (table: string, idColumn: string, ownerId: string, ids: readonly string[]) =>
		db
			.prepare(
				`SELECT body_json FROM ${table} WHERE owner_id = ? AND ${idColumn} IN (SELECT value FROM json_each(?))`,
			)
			.bind(ownerId, JSON.stringify(ids));

	return {
		async resolve(ownerId, lookup: ReferenceLookup) {
			// One batch for every kind; empty lookups are skipped to save queries.
			const plan = [
				{ ids: lookup.datasetIds, table: "datasets", column: "dataset_id" },
				{ ids: lookup.evidenceIds, table: "evidence", column: "evidence_id" },
				{ ids: lookup.claimIds, table: "claims", column: "claim_id" },
			] as const;
			const active = plan.filter((entry) => entry.ids.length > 0);
			const results =
				active.length === 0
					? []
					: await db.batch(
							active.map((entry) => byIds(entry.table, entry.column, ownerId, entry.ids)),
						);
			const rowsFor = (table: (typeof plan)[number]["table"]): readonly unknown[] => {
				const index = active.findIndex((entry) => entry.table === table);
				return index === -1 ? [] : (results[index]?.results ?? []);
			};
			return {
				datasets: rowsFor("datasets").map((row) => bodyOf("datasets", datasetSchema, row)),
				evidence: rowsFor("evidence").map((row) => bodyOf("evidence", evidenceSchema, row)),
				claims: rowsFor("claims").map((row) => bodyOf("claims", claimSchema, row)),
			};
		},
		async recordsForRuns(ownerId, runIds): Promise<RunRecords> {
			const empty: RunRecords = {
				evidence: [],
				claims: [],
				scenarios: [],
				securities: [],
				supplierLinks: [],
				financialObservations: [],
				positionObservations: [],
				investorFilings: [],
				pricingPower: [],
			};
			if (runIds.length === 0) return empty;
			const runs = JSON.stringify(runIds);
			const [evidence, claims, records] = await db.batch([
				db
					.prepare(
						`SELECT body_json FROM evidence WHERE owner_id = ? AND run_id IN (SELECT value FROM json_each(?))
						ORDER BY run_id, evidence_id`,
					)
					.bind(ownerId, runs),
				db
					.prepare(
						`SELECT body_json FROM claims WHERE owner_id = ? AND run_id IN (SELECT value FROM json_each(?))
						ORDER BY run_id, claim_id`,
					)
					.bind(ownerId, runs),
				db
					.prepare(
						`SELECT record_type, body_json FROM research_records
						WHERE owner_id = ? AND run_id IN (SELECT value FROM json_each(?))
						ORDER BY run_id, record_type, ordinal`,
					)
					.bind(ownerId, runs),
			]);
			const typed = <T>(type: RecordType, schema: z.ZodType<T>): T[] =>
				(records?.results ?? [])
					.filter((row) => textColumn("research_records", "record_type", row) === type)
					.map((row) => bodyOf("research_records", schema, row));
			return {
				evidence: (evidence?.results ?? []).map((row) => bodyOf("evidence", evidenceSchema, row)),
				claims: (claims?.results ?? []).map((row) => bodyOf("claims", claimSchema, row)),
				scenarios: typed("scenario", demandScenarioSchema),
				securities: typed("security", securitySchema),
				supplierLinks: typed("supplier-link", supplierLinkSchema),
				financialObservations: typed("financial-observation", financialObservationSchema),
				positionObservations: typed("position-observation", positionObservationSchema),
				investorFilings: typed("investor-filing", investorFilingSchema),
				pricingPower: typed("pricing-power", pricingPowerRecordSchema),
			};
		},
		async claimsByIds(ownerId, claimIds) {
			if (claimIds.length === 0) return [];
			const { results } = await byIds("claims", "claim_id", ownerId, claimIds).all();
			return results.map((row) => bodyOf("claims", claimSchema, row));
		},
		async runIdsForWorkspace(ownerId, workspaceId) {
			const { results } = await db
				.prepare(
					"SELECT run_id FROM workspace_runs WHERE owner_id = ? AND workspace_id = ? ORDER BY run_id",
				)
				.bind(ownerId, workspaceId)
				.all();
			return results.map((row) => textColumn("workspace_runs", "run_id", row));
		},
		async datasetsForWorkspace(ownerId, workspaceId) {
			const { results } = await db
				.prepare(
					"SELECT body_json FROM datasets WHERE owner_id = ? AND workspace_id = ? ORDER BY dataset_id",
				)
				.bind(ownerId, workspaceId)
				.all();
			return results.map((row) => bodyOf("datasets", datasetSchema, row));
		},
	};
}

/* ---------- Chat, credentials, runner status, rate limits, audit ---------- */

export function createChatRepository(db: SqlDatabase): ChatRepository {
	return {
		async list(ownerId, workspaceId, query) {
			const { results } = await db
				.prepare(
					`SELECT * FROM (SELECT * FROM chat_messages
						WHERE owner_id = ? AND workspace_id = ? AND (? IS NULL OR seq < ?)
						ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
				)
				.bind(ownerId, workspaceId, query.beforeSeq, query.beforeSeq, query.limit)
				.all();
			return results.map(toChatMessage);
		},
		async findByRunId(ownerId, workspaceId, runId) {
			const row = await db
				.prepare(
					"SELECT * FROM chat_messages WHERE owner_id = ? AND workspace_id = ? AND run_id = ? LIMIT 1",
				)
				.bind(ownerId, workspaceId, runId)
				.first();
			return row === null ? null : toChatMessage(row);
		},
		async listConversations(ownerId, limit) {
			// One statement over both tables (ARCH-014): the per-workspace aggregate
			// is joined back for the last message's role and preview, so N workspaces
			// cost one round trip. The preview is cut with substr in SQL so long
			// message bodies are never shipped out of the database only to be cut.
			const { results } = await db
				.prepare(
					`SELECT w.workspace_id AS workspace_id, w.title AS title,
						COALESCE(agg.message_count, 0) AS message_count,
						last.created_at AS last_message_at,
						last.role AS last_role,
						substr(last.text, 1, 160) AS last_preview,
						COALESCE(last.created_at, w.created_at) AS last_activity_at
					FROM workspaces w
					LEFT JOIN (
						SELECT workspace_id, COUNT(*) AS message_count, MAX(seq) AS max_seq
						FROM chat_messages WHERE owner_id = ? GROUP BY workspace_id
					) agg ON agg.workspace_id = w.workspace_id
					LEFT JOIN chat_messages last ON last.owner_id = ? AND last.workspace_id = w.workspace_id
						AND last.seq = agg.max_seq
					WHERE w.owner_id = ?
					ORDER BY last_activity_at DESC, w.workspace_id ASC
					LIMIT ?`,
				)
				.bind(ownerId, ownerId, ownerId, limit)
				.all();
			return results.map(toConversationSummary);
		},
	};
}

export function createRunnerCredentialRepository(db: SqlDatabase): RunnerCredentialRepository {
	return {
		async list(ownerId) {
			const { results } = await db
				.prepare("SELECT * FROM runner_credentials WHERE owner_id = ? ORDER BY created_at DESC")
				.bind(ownerId)
				.all();
			return results.map((row) => {
				const { ownerId: _owner, ...credential } = toRunnerCredential(row);
				return credential;
			});
		},
		async insert(ownerId, credential, tokenHash) {
			await db
				.prepare(
					`INSERT INTO runner_credentials (owner_id, credential_id, token_hash, label, created_at, expires_at, revoked_at, last_used_at)
					VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
				)
				.bind(
					ownerId,
					credential.credentialId,
					tokenHash,
					credential.label,
					credential.createdAt,
					credential.expiresAt,
				)
				.run();
		},
		async revoke(ownerId, credentialId, revokedAt) {
			const result = await db
				.prepare(
					"UPDATE runner_credentials SET revoked_at = ? WHERE owner_id = ? AND credential_id = ? AND revoked_at IS NULL",
				)
				.bind(revokedAt, ownerId, credentialId)
				.run();
			return result.meta.changes === 1;
		},
		async authenticate(tokenHash, nowIso) {
			// Lookup and last-used stamp in one statement; revoked or expired tokens match nothing.
			const row = await db
				.prepare(
					`UPDATE runner_credentials SET last_used_at = ?
					WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ? RETURNING *`,
				)
				.bind(nowIso, tokenHash, nowIso)
				.first();
			return row === null ? null : toRunnerCredential(row);
		},
		async rotate(ownerId, credentialId, tokenHash, expiresAt) {
			const row = await db
				.prepare(
					`UPDATE runner_credentials SET token_hash = ?, expires_at = ?
					WHERE owner_id = ? AND credential_id = ? AND revoked_at IS NULL RETURNING *`,
				)
				.bind(tokenHash, expiresAt, ownerId, credentialId)
				.first();
			if (row === null) return null;
			const { ownerId: _owner, ...credential } = toRunnerCredential(row);
			return credential;
		},
	};
}

export function createRunnerStatusRepository(db: SqlDatabase): RunnerStatusRepository {
	const rowSchema = z.object({
		last_seen_at: z.string(),
		runner_version: z.string(),
		agents_json: z.string(),
	});
	return {
		async get(ownerId) {
			const row = await db
				.prepare("SELECT * FROM runner_status WHERE owner_id = ?")
				.bind(ownerId)
				.first();
			if (row === null) return null;
			const r = rowSchema.parse(row);
			return {
				lastSeenAt: r.last_seen_at,
				runnerVersion: r.runner_version,
				agents: parseJsonColumn("runner_status", z.array(agentDescriptorSchema), r.agents_json),
			};
		},
		async put(ownerId, status) {
			await db
				.prepare(
					`INSERT INTO runner_status (owner_id, last_seen_at, runner_version, agents_json) VALUES (?, ?, ?, ?)
					ON CONFLICT (owner_id) DO UPDATE SET last_seen_at = excluded.last_seen_at,
						runner_version = excluded.runner_version, agents_json = excluded.agents_json`,
				)
				.bind(ownerId, status.lastSeenAt, status.runnerVersion, JSON.stringify(status.agents))
				.run();
		},
	};
}

export function createRateLimiter(db: SqlDatabase): RateLimiter {
	return {
		/** Fixed-window counter. Windows older than the previous one are pruned on the way. */
		async consume({ ownerId, bucket, limit, windowMs, nowMs }) {
			const windowStart = Math.floor(nowMs / windowMs) * windowMs;
			const [counted] = await db.batch([
				db
					.prepare(
						`INSERT INTO rate_limits (owner_id, bucket, window_start, count) VALUES (?, ?, ?, 1)
						ON CONFLICT (owner_id, bucket, window_start) DO UPDATE SET count = count + 1
						RETURNING count`,
					)
					.bind(ownerId, bucket, windowStart),
				db
					.prepare("DELETE FROM rate_limits WHERE owner_id = ? AND bucket = ? AND window_start < ?")
					.bind(ownerId, bucket, windowStart - windowMs),
			]);
			const row = counted?.results[0];
			return row !== undefined && numberColumn("rate_limits", "count", row) <= limit;
		},
	};
}

export function createAuditLog(db: SqlDatabase): AuditLog {
	return {
		async record(entry) {
			await db
				.prepare(
					"INSERT INTO audit_log (owner_id, actor, action, resource, detail, at) VALUES (?, ?, ?, ?, ?, ?)",
				)
				.bind(entry.ownerId, entry.actor, entry.action, entry.resource, entry.detail, entry.at)
				.run();
		},
	};
}

export function createSettingsRepository(db: SqlDatabase): SettingsRepository {
	return {
		async getAgentSettings(ownerId) {
			const row = await db
				.prepare("SELECT agent_settings_json, updated_at FROM owner_settings WHERE owner_id = ?")
				.bind(ownerId)
				.first();
			return row === null ? null : toStoredAgentSettings(row);
		},
		async putAgentSettings(ownerId, settings, updatedAt) {
			await db
				.prepare(
					`INSERT INTO owner_settings (owner_id, agent_settings_json, updated_at) VALUES (?, ?, ?)
					ON CONFLICT (owner_id) DO UPDATE SET agent_settings_json = excluded.agent_settings_json,
						updated_at = excluded.updated_at`,
				)
				.bind(ownerId, JSON.stringify(settings), updatedAt)
				.run();
		},
	};
}

export function createHomeDashboardRepository(db: SqlDatabase): HomeDashboardRepository {
	return {
		async get(ownerId) {
			const row = await db
				.prepare(
					"SELECT dashboard_json, version, updated_at FROM home_dashboards WHERE owner_id = ?",
				)
				.bind(ownerId)
				.first();
			if (row === null) return null;
			// Fail closed: a stored dashboard that no longer parses is reported
			// as "unreadable" (never silently replaced by the defaults) — the
			// service maps it to STORED_DASHBOARD_UNREADABLE and the app offers
			// a reset (V2).
			try {
				const record = toHomeDashboardRecord(row);
				return {
					dashboard: record.dashboard,
					version: record.version,
					updatedAt: record.updatedAt,
				};
			} catch (error) {
				if (error instanceof StoredDataError) return "unreadable";
				throw error;
			}
		},
		async put(ownerId, dashboard, expectedVersion, updatedAt) {
			const validated = homeDashboardSchema.parse(dashboard);
			if (expectedVersion === 0) {
				const result = await db
					.prepare(
						`INSERT INTO home_dashboards (owner_id, dashboard_json, version, updated_at)
						VALUES (?, ?, 1, ?)
						ON CONFLICT (owner_id) DO UPDATE SET
							dashboard_json = excluded.dashboard_json,
							version = version + 1,
							updated_at = excluded.updated_at
						WHERE version = ?`,
					)
					.bind(ownerId, JSON.stringify(validated), updatedAt, expectedVersion)
					.run();
				return result.meta.changes === 1 ? "written" : "version-conflict";
			}
			const result = await db
				.prepare(
					`UPDATE home_dashboards SET dashboard_json = ?, version = version + 1, updated_at = ?
					WHERE owner_id = ? AND version = ?`,
				)
				.bind(JSON.stringify(validated), updatedAt, ownerId, expectedVersion)
				.run();
			return result.meta.changes === 1 ? "written" : "version-conflict";
		},
		async reset(ownerId, dashboard, updatedAt) {
			// V2: unconditional replace — the way out when the stored document
			// no longer parses. No expectedVersion: the owner explicitly
			// discards whatever is stored.
			const validated = homeDashboardSchema.parse(dashboard);
			await db
				.prepare(
					`INSERT INTO home_dashboards (owner_id, dashboard_json, version, updated_at)
					VALUES (?, ?, 1, ?)
					ON CONFLICT (owner_id) DO UPDATE SET
						dashboard_json = excluded.dashboard_json,
						version = version + 1,
						updated_at = excluded.updated_at`,
				)
				.bind(ownerId, JSON.stringify(validated), updatedAt)
				.run();
			const row = await db
				.prepare(
					"SELECT dashboard_json, version, updated_at FROM home_dashboards WHERE owner_id = ?",
				)
				.bind(ownerId)
				.first();
			if (row === null) throw new Error("home dashboard reset did not persist");
			const record = toHomeDashboardRecord(row);
			return { dashboard: record.dashboard, version: record.version, updatedAt: record.updatedAt };
		},
	};
}

/** One row of the market-refresh claim's per-series state read (ADR-0039). */
const seriesRefreshStateRowSchema = z.object({
	series_id: z.string(),
	latest_observed_on: z.string().nullable(),
	last_refreshed_at: z.string().nullable(),
});

export function createMarketRepository(db: SqlDatabase): MarketRepository {
	return {
		async getSeriesMeta(ownerId, seriesIds) {
			if (seriesIds.length === 0) return [];
			const { results } = await db
				.prepare(
					`SELECT * FROM market_series WHERE owner_id = ? AND series_id IN (SELECT value FROM json_each(?))`,
				)
				.bind(ownerId, JSON.stringify(seriesIds))
				.all();
			return results.map(toStoredMarketSeries);
		},
		async getRefreshState(ownerId, seriesIds) {
			if (seriesIds.length === 0) return new Map();
			// One statement for every requested series (no N+1): each
			// correlated lookup is a primary-key seek, MAX(observed_on) included.
			const { results } = await db
				.prepare(
					`SELECT ids.value AS series_id,
						(SELECT MAX(observed_on) FROM market_observations
							WHERE owner_id = ?1 AND series_id = ids.value) AS latest_observed_on,
						(SELECT last_refreshed_at FROM market_series
							WHERE owner_id = ?1 AND series_id = ids.value) AS last_refreshed_at
					FROM json_each(?2) AS ids`,
				)
				.bind(ownerId, JSON.stringify(seriesIds))
				.all();
			const map = new Map<string, MarketSeriesRefreshState>();
			for (const row of results) {
				const r = decode("market_series", seriesRefreshStateRowSchema, row);
				map.set(r.series_id, {
					latestObservedOn: r.latest_observed_on,
					lastRefreshedAt: r.last_refreshed_at,
				});
			}
			return map;
		},
		async getObservations(ownerId, seriesIds, limitPerSeries) {
			if (seriesIds.length === 0) return [];
			// One statement: newest N rows per series via a window function, ascending output.
			const { results } = await db
				.prepare(
					`SELECT series_id, observed_on, value FROM (
						SELECT series_id, observed_on, value,
							ROW_NUMBER() OVER (PARTITION BY series_id ORDER BY observed_on DESC) AS rn
						FROM market_observations
						WHERE owner_id = ? AND series_id IN (SELECT value FROM json_each(?))
					) WHERE rn <= ? ORDER BY series_id, observed_on`,
				)
				.bind(ownerId, JSON.stringify(seriesIds), limitPerSeries)
				.all();
			const out: StoredMarketObservation[] = [];
			for (const row of results) {
				const record = row as Record<string, unknown>;
				if (
					typeof record.series_id === "string" &&
					typeof record.observed_on === "string" &&
					typeof record.value === "number"
				) {
					out.push({
						seriesId: record.series_id,
						observedOn: record.observed_on,
						value: record.value,
					});
				}
			}
			return out;
		},
		async deleteSeriesNotIn(ownerId, keepSeriesIds) {
			// S4b: one batch — observations first (child rows), then the series
			// rows. An empty keep list removes everything (an empty dashboard
			// references nothing).
			const keep = JSON.stringify([...keepSeriesIds]);
			const results = await db.batch([
				db
					.prepare(
						`DELETE FROM market_observations WHERE owner_id = ?
						AND series_id NOT IN (SELECT value FROM json_each(?))`,
					)
					.bind(ownerId, keep),
				db
					.prepare(
						`DELETE FROM market_series WHERE owner_id = ?
						AND series_id NOT IN (SELECT value FROM json_each(?))`,
					)
					.bind(ownerId, keep),
			]);
			return results[1]?.meta.changes ?? 0;
		},
	};
}

/* ---------- Notebook of one conversation (ADR-0020) ---------- */

/** One row of the notebooks' market series scan. */
const seriesIdRowSchema = z.object({ series_id: z.string() });
const listIdRowSchema = z.object({ list_id: idSchema });

export function createNotebookRepository(db: SqlDatabase): NotebookRepository {
	return {
		async get(ownerId, workspaceId) {
			const row = await db
				.prepare(
					"SELECT body_json, version, updated_at FROM workspace_notebooks WHERE owner_id = ? AND workspace_id = ?",
				)
				.bind(ownerId, workspaceId)
				.first();
			if (row === null) return null;
			// Fail closed: a stored notebook that no longer parses is reported
			// as "unreadable" (never silently replaced by the defaults) — the
			// service maps it to STORED_NOTEBOOK_UNREADABLE.
			try {
				const record = toNotebookRecord(row);
				return {
					notebook: record.notebook,
					version: record.version,
					updatedAt: record.updatedAt,
				};
			} catch (error) {
				if (error instanceof StoredDataError) return "unreadable";
				throw error;
			}
		},
		async put(ownerId, workspaceId, notebook, expectedVersion, updatedAt) {
			const validated = notebookSchema.parse(notebook);
			const body = JSON.stringify(validated);
			const mutationId = crypto.randomUUID();
			// Guard for the revision and prune statements of this batch: true
			// only when this call's current-row write just won.
			const guard =
				"EXISTS (SELECT 1 FROM workspace_notebooks WHERE owner_id = ? AND workspace_id = ? AND last_mutation_id = ? AND version = ?)";
			const guardValues = [ownerId, workspaceId, mutationId, expectedVersion + 1] as const;
			const current =
				expectedVersion === 0
					? db
							.prepare(
								`INSERT INTO workspace_notebooks (owner_id, workspace_id, body_json, version, last_mutation_id, updated_at)
							VALUES (?, ?, ?, 1, ?, ?)
							ON CONFLICT (owner_id, workspace_id) DO UPDATE SET
								body_json = excluded.body_json,
								version = version + 1,
								last_mutation_id = excluded.last_mutation_id,
								updated_at = excluded.updated_at
							WHERE version = ?`,
							)
							.bind(ownerId, workspaceId, body, mutationId, updatedAt, expectedVersion)
					: db
							.prepare(
								`UPDATE workspace_notebooks SET body_json = ?, version = version + 1,
								last_mutation_id = ?, updated_at = ?
							WHERE owner_id = ? AND workspace_id = ? AND version = ?`,
							)
							.bind(body, mutationId, updatedAt, ownerId, workspaceId, expectedVersion);
			const statements = [
				current,
				db
					.prepare(
						`INSERT INTO workspace_notebook_revisions (owner_id, workspace_id, version, body_json)
						SELECT ?, ?, ?, ? WHERE ${guard}`,
					)
					.bind(ownerId, workspaceId, expectedVersion + 1, body, ...guardValues),
				db
					.prepare(
						`DELETE FROM workspace_notebook_revisions
						WHERE owner_id = ? AND workspace_id = ?
							AND version NOT IN (SELECT version FROM workspace_notebook_revisions
								WHERE owner_id = ? AND workspace_id = ? ORDER BY version DESC LIMIT ?)
							AND ${guard}`,
					)
					.bind(
						ownerId,
						workspaceId,
						ownerId,
						workspaceId,
						NOTEBOOK_LIMITS.maxRevisions,
						...guardValues,
					),
			];
			if (expectedVersion === 0) {
				// The first write keeps the empty body as revision 0 in the
				// same batch, so undo at version 1 restores "no widgets yet".
				statements.push(
					db
						.prepare(
							`INSERT INTO workspace_notebook_revisions (owner_id, workspace_id, version, body_json)
							SELECT ?, ?, 0, ? WHERE ${guard}`,
						)
						.bind(ownerId, workspaceId, JSON.stringify(EMPTY_NOTEBOOK), ...guardValues),
				);
			}
			const results = await db.batch(statements);
			return results[0]?.meta.changes === 1 ? "written" : "version-conflict";
		},
		async getRevision(ownerId, workspaceId, version) {
			const row = await db
				.prepare(
					"SELECT body_json FROM workspace_notebook_revisions WHERE owner_id = ? AND workspace_id = ? AND version = ?",
				)
				.bind(ownerId, workspaceId, version)
				.first();
			if (row === null) return null;
			try {
				return toNotebookRevision(row);
			} catch (error) {
				// An unreadable kept body restores nothing: report it as not
				// kept rather than writing a guess.
				if (error instanceof StoredDataError) return null;
				throw error;
			}
		},
		async listTurns(ownerId, workspaceId, limit) {
			const { results } = await db
				.prepare(
					`SELECT body_json FROM notebook_turns WHERE owner_id = ? AND workspace_id = ?
					ORDER BY created_at DESC, run_id DESC LIMIT ?`,
				)
				.bind(ownerId, workspaceId, limit)
				.all();
			// Newest first in SQL for the bound; oldest first for the response.
			return results.map(toNotebookTurn).reverse();
		},
		async listMarketSeriesIds(ownerId) {
			// ADR-0021: one set-based statement over every stored notebook
			// body (no N+1, no new table): `market-metric` names `seriesId`,
			// the other market widget types name `seriesIds`; the earnings
			// calendar names none. Unreadable bodies are skipped via
			// `json_valid`, never fatal. Every id is parsed at this boundary
			// and invalid ones are dropped.
			const { results } = await db
				.prepare(
					`SELECT DISTINCT series_id AS series_id FROM (
						SELECT json_extract(w.value, '$.seriesId') AS series_id
						FROM workspace_notebooks AS n, json_each(n.body_json, '$.widgets') AS w
						WHERE n.owner_id = ?1 AND json_valid(n.body_json)
							AND json_extract(w.value, '$.type') = 'market-metric'
						UNION
						SELECT s.value AS series_id
						FROM workspace_notebooks AS n, json_each(n.body_json, '$.widgets') AS w,
							json_each(json_extract(w.value, '$.seriesIds')) AS s
						WHERE n.owner_id = ?1 AND json_valid(n.body_json)
							AND json_extract(w.value, '$.type') IN ('line-chart', 'stock-table', 'indicator-table')
					) WHERE series_id IS NOT NULL AND series_id != ''
					ORDER BY series_id`,
				)
				.bind(ownerId)
				.all();
			const ids: string[] = [];
			for (const row of results) {
				// Stored data is parsed at the boundary: an id that no
				// longer parses is dropped, never served as another provider.
				const parsed = seriesIdRowSchema.safeParse(row);
				if (!parsed.success || parseMarketSeriesId(parsed.data.series_id) === null) continue;
				ids.push(parsed.data.series_id);
			}
			return ids;
		},
		async listWatchlistListIds(ownerId) {
			// ADR-0040: the same set-based walk over every stored notebook
			// body as `listMarketSeriesIds`; unreadable bodies are skipped
			// and every id is parsed at this boundary.
			const { results } = await db
				.prepare(
					`SELECT DISTINCT json_extract(w.value, '$.listId') AS list_id
					FROM workspace_notebooks AS n, json_each(n.body_json, '$.widgets') AS w
					WHERE n.owner_id = ?1 AND json_valid(n.body_json)
						AND json_extract(w.value, '$.type') = 'watchlist-prices'
					ORDER BY list_id`,
				)
				.bind(ownerId)
				.all();
			const ids: string[] = [];
			for (const row of results) {
				const parsed = listIdRowSchema.safeParse(row);
				if (parsed.success) ids.push(parsed.data.list_id);
			}
			return ids;
		},
	};
}

export function createWatchlistRepository(db: SqlDatabase): WatchlistRepository {
	return {
		async listStocks(ownerId) {
			// Insertion order: `added_at` first, `rowid` breaks ties from
			// same-millisecond adds, so the order is always the added order.
			const { results } = await db
				.prepare(`SELECT * FROM watchlist_stocks WHERE owner_id = ? ORDER BY added_at, rowid`)
				.bind(ownerId)
				.all();
			const stocks: StoredWatchlistStock[] = results.map(toStoredWatchlistStock);
			return stocks;
		},
		async getStock(ownerId, stockId) {
			const row = await db
				.prepare(`SELECT * FROM watchlist_stocks WHERE owner_id = ? AND stock_id = ?`)
				.bind(ownerId, stockId)
				.first();
			return row === null ? null : toStoredWatchlistStock(row);
		},
		async countStocks(ownerId) {
			const row = await db
				.prepare(`SELECT COUNT(*) AS n FROM watchlist_stocks WHERE owner_id = ?`)
				.bind(ownerId)
				.first();
			if (row === null) return 0;
			return numberColumn("watchlist_stocks", "n", row);
		},
		async insertStock(ownerId, stock, maxStocks) {
			// The cap lives in the INSERT's own WHERE clause (like the job
			// insert's capacity guard): check-then-insert would let two
			// interleaved adds at 49 both write, leaving 51 rows — after
			// which every watchlist route answers 500 because the response
			// schema rejects the list. `changes === 0` means the row was
			// already present or the list is full; the follow-up read tells
			// those apart (idempotent re-adds succeed even when full).
			const result = await db
				.prepare(
					`INSERT INTO watchlist_stocks
						(owner_id, stock_id, market, symbol, name, added_at, last_refreshed_at, retrieved_at, unavailable_code)
					SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, NULL
					WHERE (SELECT COUNT(*) FROM watchlist_stocks WHERE owner_id = ?) < ?
					ON CONFLICT (owner_id, stock_id) DO NOTHING`,
				)
				.bind(
					ownerId,
					stock.stockId,
					stock.market,
					stock.symbol,
					stock.name,
					stock.addedAt,
					ownerId,
					maxStocks,
				)
				.run();
			if (result.meta.changes === 1) return "added";
			const present = await db
				.prepare(`SELECT 1 FROM watchlist_stocks WHERE owner_id = ? AND stock_id = ?`)
				.bind(ownerId, stock.stockId)
				.first();
			return present === null ? "full" : "already-present";
		},
		async removeStock(ownerId, stockId, now) {
			// The stock, its events and its list memberships go in one atomic
			// batch: a crash between the statements cannot orphan event or
			// membership rows (ADR-0040). The lists that held it are bumped
			// FIRST, while the memberships that name them still exist, so the
			// `/watchlist` ETag sees every list the stock leaves.
			const results = await db.batch([
				db
					.prepare(
						`UPDATE watchlist_lists SET version = version + 1, updated_at = ?3
						WHERE owner_id = ?1 AND list_id IN (
							SELECT list_id FROM watchlist_list_stocks WHERE owner_id = ?1 AND stock_id = ?2)`,
					)
					.bind(ownerId, stockId, now),
				db
					.prepare(`DELETE FROM watchlist_list_stocks WHERE owner_id = ? AND stock_id = ?`)
					.bind(ownerId, stockId),
				db
					.prepare(`DELETE FROM earnings_events WHERE owner_id = ? AND stock_id = ?`)
					.bind(ownerId, stockId),
				db
					.prepare(`DELETE FROM watchlist_stocks WHERE owner_id = ? AND stock_id = ?`)
					.bind(ownerId, stockId),
			]);
			return (results[3]?.meta.changes ?? 0) === 1;
		},
	};
}

/* ---------- Stock directory (ADR-0034) ---------- */

/**
 * One `instr` test per possible query term (`?2` .. `?{1 + maxTerms}`); an
 * absent term is bound as NULL and passes. Built from `maxTerms` so the SQL
 * can never silently ignore a term the domain keeps.
 */
const TERM_PARAMETERS = Array.from(
	{ length: STOCK_SEARCH_LIMITS.maxTerms },
	(_, index) => index + 2,
);
const TERM_COUNT_PARAMETER = STOCK_SEARCH_LIMITS.maxTerms + 2;
const MARKET_PARAMETER = TERM_COUNT_PARAMETER + 1;
const LIMIT_PARAMETER = MARKET_PARAMETER + 1;

/**
 * The SQL form of `rankStockSearch` (packages/domain, ADR-0034 section 6),
 * over the keys the completion stored with each row:
 * - match: every term is a substring of `search_key` (the haystack; terms
 *   hold no newline, so a term never spans two keys);
 * - tier: 0 when the one term equals the symbol key, 1 symbol-key prefix,
 *   2 name- or local-name-key prefix (first term only), else 3 —
 *   `instr(key, t) = 1` is "starts with" for a non-empty term, and `instr`
 *   compares the stored text exactly (no collation, no LIKE wildcards);
 * - order: tier, shorter symbol, symbol, market. Symbols and markets are
 *   ASCII, so `length` and BINARY order equal the reference's UTF-16 ones.
 * `apps/api/test/stockDirectory.test.ts` runs both on the same rows.
 */
const STOCK_SEARCH_SQL = `SELECT market, symbol, name, local_name, listing,
		CASE
			WHEN ?${TERM_COUNT_PARAMETER} = 1 AND symbol_key = ?2 THEN 0
			WHEN instr(symbol_key, ?2) = 1 THEN 1
			WHEN instr(name_key, ?2) = 1 OR instr(local_name_key, ?2) = 1 THEN 2
			ELSE 3
		END AS tier
	FROM stock_directory
	WHERE owner_id = ?1
		AND (?${MARKET_PARAMETER} IS NULL OR market = ?${MARKET_PARAMETER})
		AND ${TERM_PARAMETERS.map((parameter) => `(?${parameter} IS NULL OR instr(search_key, ?${parameter}) > 0)`).join("\n\t\tAND ")}
	ORDER BY tier, length(symbol), symbol, market
	LIMIT ?${LIMIT_PARAMETER}`;

export function createStockDirectoryRepository(db: SqlDatabase): StockDirectoryRepository {
	return {
		async search(ownerId, query) {
			const terms = stockSearchTerms(query.text);
			if (terms.length === 0) return [];
			// The same clamp as `rankStockSearch`.
			const limit = Math.min(Math.max(Math.trunc(query.limit), 1), STOCK_SEARCH_LIMITS.maxResults);
			const termValues = TERM_PARAMETERS.map((_, index) => terms[index] ?? null);
			const { results } = await db
				.prepare(STOCK_SEARCH_SQL)
				.bind(ownerId, ...termValues, terms.length, query.market, limit)
				.all();
			return results.map(toStoredStockDirectoryEntry);
		},
		async getEntry(ownerId, market, symbol) {
			const row = await db
				.prepare(
					`SELECT market, symbol, name, local_name, listing FROM stock_directory
					WHERE owner_id = ? AND market = ? AND symbol = ?`,
				)
				.bind(ownerId, market, symbol)
				.first();
			return row === null ? null : toStoredStockDirectoryEntry(row);
		},
		async listMeta(ownerId) {
			const { results } = await db
				.prepare(
					`SELECT market, entry_count, as_of, retrieved_at, fold_version FROM stock_directory_meta
					WHERE owner_id = ? ORDER BY market`,
				)
				.bind(ownerId)
				.all();
			return results.map(toStockDirectoryMeta);
		},
		async listEntries(ownerId, market) {
			const { results } = await db
				.prepare(
					`SELECT market, symbol, name, local_name, listing FROM stock_directory
					WHERE owner_id = ? AND market = ?`,
				)
				.bind(ownerId, market)
				.all();
			return results.map(toStoredStockDirectoryEntry);
		},
		async storeKeys(ownerId, rekey) {
			// Same byte-bounded chunks as the completion's inserts (S5). The
			// name match makes each UPDATE safe against a list replaced since
			// the rows were read: keys land only on the rows they were
			// computed from (a replacement already carries current keys).
			const statements: SqlStatement[] = chunkStockDirectoryRows(rekey.rows).map((chunk) =>
				db
					.prepare(
						`UPDATE stock_directory SET
							symbol_key = payload.symbol_key, name_key = payload.name_key,
							local_name_key = payload.local_name_key, search_key = payload.search_key
						FROM (SELECT json_extract(value, '$[0]') AS symbol, json_extract(value, '$[1]') AS name,
								json_extract(value, '$[2]') AS local_name, json_extract(value, '$[4]') AS symbol_key,
								json_extract(value, '$[5]') AS name_key, json_extract(value, '$[6]') AS local_name_key,
								json_extract(value, '$[7]') AS search_key
							FROM json_each(?)) AS payload
						WHERE stock_directory.owner_id = ? AND stock_directory.market = ?
							AND stock_directory.symbol = payload.symbol AND stock_directory.name = payload.name
							AND stock_directory.local_name IS payload.local_name`,
					)
					.bind(chunk, ownerId, rekey.market),
			);
			statements.push(
				db
					.prepare(
						`UPDATE stock_directory_meta SET fold_version = ?
						WHERE owner_id = ? AND market = ? AND fold_version = ?`,
					)
					.bind(rekey.toVersion, ownerId, rekey.market, rekey.fromVersion),
			);
			await db.batch(statements);
		},
	};
}

export function createEarningsRepository(db: SqlDatabase): EarningsRepository {
	return {
		async getEvents(ownerId, stockIds) {
			if (stockIds.length === 0) return [];
			// Dated events ascending, undecided last — per stock, in one statement.
			const { results } = await db
				.prepare(
					`SELECT * FROM earnings_events
					WHERE owner_id = ? AND stock_id IN (SELECT value FROM json_each(?))
					ORDER BY stock_id, announcement_date IS NULL, announcement_date, period_key`,
				)
				.bind(ownerId, JSON.stringify([...stockIds]))
				.all();
			const events: StoredEarningsEvent[] = results.map(toStoredEarningsEvent);
			return events;
		},
	};
}

export function createCalendarFeedRepository(db: SqlDatabase): CalendarFeedRepository {
	return {
		async get(ownerId) {
			const row = await db
				.prepare(`SELECT token_hash, created_at FROM calendar_feeds WHERE owner_id = ?`)
				.bind(ownerId)
				.first();
			if (row === null) return null;
			const record: CalendarFeedRecord = toCalendarFeedRecord(row);
			return record;
		},
		async put(ownerId, tokenHash, createdAt) {
			// One feed per owner: an issue replaces any previous hash, so a
			// rotation instantly invalidates the old token.
			await db
				.prepare(
					`INSERT INTO calendar_feeds (owner_id, token_hash, created_at)
					VALUES (?, ?, ?)
					ON CONFLICT (owner_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`,
				)
				.bind(ownerId, tokenHash, createdAt)
				.run();
		},
		async revoke(ownerId) {
			const result = await db
				.prepare(`DELETE FROM calendar_feeds WHERE owner_id = ?`)
				.bind(ownerId)
				.run();
			return result.meta.changes === 1;
		},
		async findOwnerByTokenHash(tokenHash) {
			const row = await db
				.prepare(`SELECT owner_id FROM calendar_feeds WHERE token_hash = ?`)
				.bind(tokenHash)
				.first();
			if (row === null) return null;
			return decode("calendar_feeds", z.object({ owner_id: z.string() }), row).owner_id;
		},
	};
}

/* ---------- Google Calendar sync link (FR-019 section 2.5) ---------- */

const GOOGLE_LINK_COLUMNS = [
	"status",
	"connect_from",
	"pending_auth_url",
	"calendar_id",
	"connected_at",
	"last_synced_at",
	"synced_digest",
	"last_inserted",
	"last_updated",
	"last_deleted",
	"last_unchanged",
	"last_failure_code",
	"last_failure_upstream_status",
	"last_failure_at",
] as const;

/** `?` per bound value: the owner, every link column, the stamp. */
const GOOGLE_LINK_PLACEHOLDERS = Array.from(
	{ length: GOOGLE_LINK_COLUMNS.length + 2 },
	() => "?",
).join(", ");

function googleLinkValues(link: GoogleCalendarLink): SqlValue[] {
	return [
		link.status,
		link.connectFrom,
		link.pendingAuthUrl,
		link.calendarId,
		link.connectedAt,
		link.lastSyncedAt,
		link.syncedDigest,
		link.lastSync?.inserted ?? null,
		link.lastSync?.updated ?? null,
		link.lastSync?.deleted ?? null,
		link.lastSync?.unchanged ?? null,
		link.lastFailureCode,
		link.lastFailureUpstreamStatus,
		link.lastFailureAt,
	];
}

function applyGoogleLinkPatch(
	link: GoogleCalendarLink,
	patch: GoogleCalendarLinkPatch,
): GoogleCalendarLink {
	// Explicit null clears a column; an absent field keeps it. `??` alone
	// cannot tell those apart, so presence is tested per field.
	return {
		status: patch.status ?? link.status,
		connectFrom: "connectFrom" in patch ? (patch.connectFrom ?? null) : link.connectFrom,
		pendingAuthUrl:
			"pendingAuthUrl" in patch ? (patch.pendingAuthUrl ?? null) : link.pendingAuthUrl,
		calendarId: "calendarId" in patch ? (patch.calendarId ?? null) : link.calendarId,
		connectedAt: "connectedAt" in patch ? (patch.connectedAt ?? null) : link.connectedAt,
		lastSyncedAt: "lastSyncedAt" in patch ? (patch.lastSyncedAt ?? null) : link.lastSyncedAt,
		syncedDigest: "syncedDigest" in patch ? (patch.syncedDigest ?? null) : link.syncedDigest,
		lastSync: "lastSync" in patch ? (patch.lastSync ?? null) : link.lastSync,
		lastFailureCode:
			"lastFailureCode" in patch ? (patch.lastFailureCode ?? null) : link.lastFailureCode,
		lastFailureUpstreamStatus:
			"lastFailureUpstreamStatus" in patch
				? (patch.lastFailureUpstreamStatus ?? null)
				: link.lastFailureUpstreamStatus,
		lastFailureAt: "lastFailureAt" in patch ? (patch.lastFailureAt ?? null) : link.lastFailureAt,
		updatedAt: link.updatedAt,
	};
}

/** A disconnected link row: every column null except the status and stamp. */
function disconnectedGoogleLink(at: string): GoogleCalendarLink {
	return {
		status: "disconnected",
		connectFrom: null,
		pendingAuthUrl: null,
		calendarId: null,
		connectedAt: null,
		lastSyncedAt: null,
		syncedDigest: null,
		lastSync: null,
		lastFailureCode: null,
		lastFailureUpstreamStatus: null,
		lastFailureAt: null,
		updatedAt: at,
	};
}

/**
 * Statements storing one google-calendar completion's link patch (FR-019).
 * One guarded UPDATE: the row always exists (the queue created it before
 * the job was inserted), so a missing row writes nothing rather than
 * inventing state. The whole completion stays one guarded batch through the
 * caller's `JOB_GUARD_SQL`.
 */
export function googleLinkStatements(
	db: SqlDatabase,
	ownerId: string,
	patch: GoogleCalendarLinkPatch,
	at: string,
	guard: { readonly sql: string; readonly values: readonly SqlValue[] },
): SqlStatement[] {
	const assignments: string[] = [];
	const values: SqlValue[] = [];
	const set = (column: string, value: SqlValue): void => {
		assignments.push(`${column} = ?`);
		values.push(value);
	};
	if (patch.status !== undefined) set("status", patch.status);
	if (patch.connectFrom !== undefined) set("connect_from", patch.connectFrom);
	if (patch.pendingAuthUrl !== undefined) set("pending_auth_url", patch.pendingAuthUrl);
	if (patch.calendarId !== undefined) set("calendar_id", patch.calendarId);
	if (patch.connectedAt !== undefined) set("connected_at", patch.connectedAt);
	if (patch.lastSyncedAt !== undefined) set("last_synced_at", patch.lastSyncedAt);
	if (patch.syncedDigest !== undefined) set("synced_digest", patch.syncedDigest);
	if (patch.lastSync !== undefined) {
		set("last_inserted", patch.lastSync?.inserted ?? null);
		set("last_updated", patch.lastSync?.updated ?? null);
		set("last_deleted", patch.lastSync?.deleted ?? null);
		set("last_unchanged", patch.lastSync?.unchanged ?? null);
	}
	if (patch.lastFailureCode !== undefined) set("last_failure_code", patch.lastFailureCode);
	if (patch.lastFailureUpstreamStatus !== undefined)
		set("last_failure_upstream_status", patch.lastFailureUpstreamStatus);
	if (patch.lastFailureAt !== undefined) set("last_failure_at", patch.lastFailureAt);
	if (assignments.length === 0) return [];
	return [
		db
			.prepare(
				`UPDATE google_calendar_links SET ${[...assignments, "updated_at = ?"].join(", ")}
				WHERE owner_id = ? AND ${guard.sql}`,
			)
			.bind(...values, at, ownerId, ...guard.values),
	];
}

export function createGoogleCalendarRepository(db: SqlDatabase): GoogleCalendarRepository {
	async function upsert(ownerId: string, link: GoogleCalendarLink): Promise<void> {
		await db
			.prepare(
				`INSERT INTO google_calendar_links (owner_id, ${GOOGLE_LINK_COLUMNS.join(", ")}, updated_at)
				VALUES (${GOOGLE_LINK_PLACEHOLDERS})
				ON CONFLICT (owner_id) DO UPDATE SET
					status = excluded.status, connect_from = excluded.connect_from,
					pending_auth_url = excluded.pending_auth_url, calendar_id = excluded.calendar_id,
					connected_at = excluded.connected_at, last_synced_at = excluded.last_synced_at,
					synced_digest = excluded.synced_digest, last_inserted = excluded.last_inserted,
					last_updated = excluded.last_updated, last_deleted = excluded.last_deleted,
					last_unchanged = excluded.last_unchanged,
					last_failure_code = excluded.last_failure_code,
					last_failure_upstream_status = excluded.last_failure_upstream_status,
					last_failure_at = excluded.last_failure_at, updated_at = excluded.updated_at`,
			)
			.bind(ownerId, ...googleLinkValues(link), link.updatedAt)
			.run();
	}

	return {
		async get(ownerId) {
			const row = await db
				.prepare(`SELECT * FROM google_calendar_links WHERE owner_id = ?`)
				.bind(ownerId)
				.first();
			return row === null ? null : toGoogleCalendarLink(row);
		},
		async setConnecting(ownerId, input) {
			const current = await db
				.prepare(`SELECT * FROM google_calendar_links WHERE owner_id = ?`)
				.bind(ownerId)
				.first();
			const previous: GoogleCalendarLink =
				current === null ? disconnectedGoogleLink(input.at) : toGoogleCalendarLink(current);
			await upsert(ownerId, {
				...previous,
				status: "connecting",
				connectFrom: input.connectFrom,
				pendingAuthUrl: null,
				updatedAt: input.at,
			});
		},
		async setPendingAuthUrl(ownerId, url, at) {
			const current = await db
				.prepare(`SELECT * FROM google_calendar_links WHERE owner_id = ?`)
				.bind(ownerId)
				.first();
			if (current === null) return;
			const link = toGoogleCalendarLink(current);
			// Only while connecting: a URL for any other status is a stale
			// runner message and is dropped, never stored.
			if (link.status !== "connecting") return;
			await upsert(ownerId, { ...link, pendingAuthUrl: url, updatedAt: at });
		},
		async apply(ownerId, patch, at) {
			const current = await db
				.prepare(`SELECT * FROM google_calendar_links WHERE owner_id = ?`)
				.bind(ownerId)
				.first();
			const previous: GoogleCalendarLink =
				current === null ? disconnectedGoogleLink(at) : toGoogleCalendarLink(current);
			await upsert(ownerId, { ...applyGoogleLinkPatch(previous, patch), updatedAt: at });
		},
	};
}

const evidenceIdRowSchema = z.object({ evidence_id: z.string().min(1) });

export function createChartEvidenceReferences(db: SqlDatabase): ChartEvidenceReferences {
	return {
		async listChartEvidenceIds(ownerId, exceptWorkspaceId) {
			// One set-based statement over Home and every other notebook (no
			// N+1): a chart's `sources` copies name exactly the ids it cites.
			// Unreadable bodies are skipped via `json_valid`, never fatal.
			const { results } = await db
				.prepare(
					`SELECT DISTINCT evidence_id FROM (
						SELECT json_extract(s.value, '$.evidenceId') AS evidence_id
						FROM workspace_notebooks AS n, json_each(n.body_json, '$.widgets') AS w,
							json_each(json_extract(w.value, '$.sources')) AS s
						WHERE n.owner_id = ?1 AND n.workspace_id != ?2 AND json_valid(n.body_json)
							AND json_extract(w.value, '$.type') = 'chart'
						UNION
						SELECT json_extract(s.value, '$.evidenceId') AS evidence_id
						FROM home_dashboards AS h, json_each(h.dashboard_json, '$.widgets') AS w,
							json_each(json_extract(w.value, '$.sources')) AS s
						WHERE h.owner_id = ?1 AND json_valid(h.dashboard_json)
							AND json_extract(w.value, '$.type') = 'chart'
					) WHERE evidence_id IS NOT NULL`,
				)
				.bind(ownerId, exceptWorkspaceId)
				.all();
			return results.flatMap((row) => {
				const parsed = evidenceIdRowSchema.safeParse(row);
				return parsed.success ? [parsed.data.evidence_id] : [];
			});
		},
	};
}
