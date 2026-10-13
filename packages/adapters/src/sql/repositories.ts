import type {
	ArticlePage,
	ArticleRepository,
	AuditLog,
	ChatRepository,
	EnqueueResult,
	JobRecord,
	JobRepository,
	JobWrite,
	RateLimiter,
	ReferenceLookup,
	ResearchRecordRepository,
	RunnerCredentialRepository,
	RunnerStatusRepository,
	SettingsRepository,
	SourceRepository,
	WorkspaceRepository,
} from "@research/application";
import { toProgressRows } from "@research/application";
import {
	agentDescriptorSchema,
	claimSchema,
	datasetSchema,
	demandScenarioSchema,
	evidenceSchema,
	financialObservationSchema,
	investorFilingSchema,
	positionObservationSchema,
	pricingPowerRecordSchema,
	type RunRecords,
	securitySchema,
	supplierLinkSchema,
	type UpdateSourceRequest,
} from "@research/contracts";
import { LEASED_JOB_STATES, TERMINAL_JOB_STATES } from "@research/domain";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import {
	bodyOf,
	numberColumn,
	parseJsonColumn,
	textColumn,
	toAppliedCommand,
	toArticle,
	toChatMessage,
	toConversationSummary,
	toJobRecord,
	toNewsSource,
	toRunnerCredential,
	toStoredAgentSettings,
	toWorkspaceRecord,
	toWorkspaceSummary,
} from "./rows.ts";

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
						created_at, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
	try {
		const parsed = cursorSchema.safeParse(JSON.parse(atob(cursor)));
		return parsed.success ? parsed.data : null;
	} catch {
		// An unreadable cursor is treated as "start from the beginning", not an error.
		return null;
	}
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
				lease_expires_at, last_event_seq, cancel_requested, failure_code, failure_detail, approval_request_json,
				retry_of_run_id, context_anchor_seq, verification_status, provider_model, provider_session_ref,
				completed_generation, provenance_json, version, last_mutation_id, created_at, updated_at)
			SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
			WHERE (SELECT COUNT(*) FROM research_jobs
				WHERE owner_id = ? AND state NOT IN (${TERMINAL_SQL})) < ?
				AND (? IS NULL OR EXISTS (SELECT 1 FROM workspaces WHERE owner_id = ? AND workspace_id = ?))
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
		);
}

/**
 * Why an enqueue INSERT changed no row: the idempotency key already names a
 * job (a replay or a key reuse), the named workspace is gone, or the owner is
 * at the unfinished-job cap. The key is checked first so a replay still
 * answers from the stored job.
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
			return toJobRecord(row).request;
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
