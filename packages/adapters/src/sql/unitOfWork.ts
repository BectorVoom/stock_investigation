import type {
	CompletionEffects,
	DeleteWorkspaceInput,
	DeleteWorkspaceOutcome,
	JobWrite,
	ResearchUnitOfWork,
	WorkspaceWrite,
} from "@research/application";
import { deriveConversationTitle } from "@research/application";
import type { ChatMessage, Dataset, ResearchBundle, RunRecords } from "@research/contracts";
import { DEFAULT_CONVERSATION_TITLE } from "@research/contracts";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import {
	enqueueOutcome,
	insertCommandsStatement,
	insertJobStatement,
	JOB_GUARD_SQL,
	jobWriteStatements,
	type RecordType,
	TERMINAL_SQL,
} from "./repositories.ts";
import { numberColumn } from "./rows.ts";

interface Guard {
	readonly sql: string;
	readonly values: readonly SqlValue[];
}

const ALWAYS: Guard = { sql: "1 = 1", values: [] };

function recordRows(records: RunRecords) {
	const rows: { recordId: string; recordType: RecordType; ordinal: number; body: unknown }[] = [];
	const add = <T>(recordType: RecordType, items: readonly T[], id: (item: T) => string) => {
		items.forEach((item, ordinal) => {
			rows.push({ recordId: id(item), recordType, ordinal, body: item });
		});
	};
	add("scenario", records.scenarios, (item) => item.scenarioId);
	add("security", records.securities, (item) => item.securityId);
	add("supplier-link", records.supplierLinks, (item) => item.supplierLinkId);
	add("financial-observation", records.financialObservations, (item) => item.observationId);
	add("position-observation", records.positionObservations, (item) => item.observationId);
	add("investor-filing", records.investorFilings, (item) => item.filingId);
	add("pricing-power", records.pricingPower, (item) => item.pricingPowerId);
	return rows;
}

/**
 * Statements that store a set of research records under `runId`. Each is one
 * multi-row INSERT fed by `json_each`, so a whole bundle costs a fixed handful
 * of queries regardless of its size (Workers Free allows 50 per request).
 */
function recordStatements(
	db: SqlDatabase,
	ownerId: string,
	runId: string,
	workspaceId: string | null,
	records: RunRecords,
	datasets: readonly Dataset[],
	guard: Guard,
): SqlStatement[] {
	const statements: SqlStatement[] = [];
	if (records.evidence.length > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO evidence (owner_id, evidence_id, run_id, body_json)
					SELECT ?, json_extract(value, '$.evidenceId'), ?, value FROM json_each(?) WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, JSON.stringify(records.evidence), ...guard.values),
		);
	}
	if (records.claims.length > 0) {
		const edges = records.claims.flatMap((claim) =>
			claim.links.map((link, ordinal) => ({
				claimId: claim.claimId,
				evidenceId: link.evidenceId,
				relation: link.relation,
				ordinal,
			})),
		);
		statements.push(
			db
				.prepare(
					`INSERT INTO claims (owner_id, claim_id, run_id, status, body_json)
					SELECT ?, json_extract(value, '$.claimId'), ?, json_extract(value, '$.status'), value
					FROM json_each(?) WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, JSON.stringify(records.claims), ...guard.values),
		);
		if (edges.length > 0) {
			statements.push(
				db
					.prepare(
						`INSERT INTO claim_evidence (owner_id, claim_id, evidence_id, relation, ordinal)
						SELECT ?, json_extract(value, '$.claimId'), json_extract(value, '$.evidenceId'),
							json_extract(value, '$.relation'), json_extract(value, '$.ordinal')
						FROM json_each(?) WHERE ${guard.sql}`,
					)
					.bind(ownerId, JSON.stringify(edges), ...guard.values),
			);
		}
	}
	const typed = recordRows(records);
	if (typed.length > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO research_records (owner_id, record_id, run_id, record_type, ordinal, body_json)
					SELECT ?, json_extract(value, '$.recordId'), ?, json_extract(value, '$.recordType'),
						json_extract(value, '$.ordinal'), json_extract(value, '$.body')
					FROM json_each(?) WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, JSON.stringify(typed), ...guard.values),
		);
	}
	if (datasets.length > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO datasets (owner_id, dataset_id, run_id, workspace_id, body_json)
					SELECT ?, json_extract(value, '$.datasetId'), ?, ?, value FROM json_each(?) WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, workspaceId, JSON.stringify(datasets), ...guard.values),
		);
	}
	if (workspaceId !== null) {
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO workspace_runs (owner_id, workspace_id, run_id) SELECT ?, ?, ? WHERE ${guard.sql}`,
				)
				.bind(ownerId, workspaceId, runId, ...guard.values),
		);
	}
	return statements;
}

function bundleRecords(bundle: ResearchBundle): RunRecords {
	return {
		evidence: bundle.evidence,
		claims: bundle.claims,
		scenarios: bundle.scenarios,
		securities: bundle.securities,
		supplierLinks: bundle.supplierLinks,
		financialObservations: bundle.financialObservations,
		positionObservations: bundle.positionObservations,
		investorFilings: bundle.investorFilings,
		pricingPower: bundle.pricingPower,
	};
}

/** Appends one chat message at the next sequence number of its workspace. */
function appendMessageStatement(
	db: SqlDatabase,
	ownerId: string,
	message: {
		readonly messageId: string;
		readonly workspaceId: string;
		readonly role: "owner" | "assistant";
		readonly text: string;
		readonly runId: string | null;
		readonly claimIds: readonly string[];
		readonly at: string;
	},
	guard: Guard,
): SqlStatement {
	return db
		.prepare(
			`INSERT OR IGNORE INTO chat_messages (owner_id, message_id, workspace_id, seq, role, text, run_id, claim_ids_json, created_at)
			SELECT ?, ?, ?,
				COALESCE((SELECT MAX(seq) + 1 FROM chat_messages WHERE owner_id = ? AND workspace_id = ?), 0),
				?, ?, ?, ?, ?
			WHERE ${guard.sql}`,
		)
		.bind(
			ownerId,
			message.messageId,
			message.workspaceId,
			ownerId,
			message.workspaceId,
			message.role,
			message.text,
			message.runId,
			JSON.stringify(message.claimIds),
			message.at,
			...guard.values,
		);
}

function workspaceUpdateStatement(
	db: SqlDatabase,
	ownerId: string,
	write: WorkspaceWrite,
	guard: Guard,
): SqlStatement {
	return db
		.prepare(
			`UPDATE workspaces SET state_json = ?, version = ?, last_mutation_id = ?, updated_at = ?
			WHERE owner_id = ? AND workspace_id = ? AND version = ? AND ${guard.sql}`,
		)
		.bind(
			JSON.stringify(write.nextState),
			write.nextState.version,
			crypto.randomUUID(),
			write.at,
			ownerId,
			write.workspaceId,
			write.expectedVersion,
			...guard.values,
		);
}

export function createResearchUnitOfWork(db: SqlDatabase): ResearchUnitOfWork {
	return {
		async enqueueResearch({
			job,
			idempotencyKey,
			requestFingerprint,
			ownerMessage,
			maxUnfinished,
		}) {
			const mutationId = crypto.randomUUID();
			const guard: Guard = { sql: JOB_GUARD_SQL, values: [job.ownerId, job.runId, mutationId] };
			const statements = [
				insertJobStatement(db, job, idempotencyKey, requestFingerprint, mutationId, maxUnfinished),
			];
			if (job.workspaceId !== null) {
				statements.push(
					appendMessageStatement(
						db,
						job.ownerId,
						{
							messageId: ownerMessage.messageId,
							workspaceId: job.workspaceId,
							role: "owner",
							text: ownerMessage.text,
							runId: job.runId,
							claimIds: [],
							at: job.createdAt,
						},
						guard,
					),
					// The stable context anchor: the seq the owner's question just
					// took, stamped on the job in the same batch so a claim can
					// never see the job without its anchor. Guarded on the job
					// insert having won, like the message itself.
					db
						.prepare(
							`UPDATE research_jobs SET context_anchor_seq =
								(SELECT seq FROM chat_messages WHERE owner_id = ? AND workspace_id = ? AND message_id = ?)
							WHERE owner_id = ? AND run_id = ? AND ${JOB_GUARD_SQL}`,
						)
						.bind(
							job.ownerId,
							job.workspaceId,
							ownerMessage.messageId,
							job.ownerId,
							job.runId,
							...guard.values,
						),
				);
				// Names a still-untitled conversation from its first question. The
				// message just inserted is the only one exactly when no message
				// predates this batch, and the title still being the default
				// proves the owner never renamed it — so this UPDATE fires only
				// for the first question of an unrenamed conversation, in the
				// same batch as the question itself (no rename race).
				const firstTitle = deriveConversationTitle(ownerMessage.text);
				if (firstTitle !== null) {
					statements.push(
						db
							.prepare(
								`UPDATE workspaces SET title = ?, updated_at = ?
								WHERE owner_id = ? AND workspace_id = ? AND title = ?
									AND (SELECT COUNT(*) FROM chat_messages WHERE owner_id = ? AND workspace_id = ?) = 1
									AND ${JOB_GUARD_SQL}`,
							)
							.bind(
								firstTitle,
								job.createdAt,
								job.ownerId,
								job.workspaceId,
								DEFAULT_CONVERSATION_TITLE,
								job.ownerId,
								job.workspaceId,
								...guard.values,
							),
					);
				}
			}
			const results = await db.batch(statements);
			if (results[0]?.meta.changes === 1) return { kind: "inserted" };
			return enqueueOutcome(db, job, idempotencyKey, requestFingerprint);
		},

		/**
		 * One atomic batch (a single transaction). The job compare-and-set runs first
		 * and — when the completion also changes a workspace — additionally
		 * requires the workspace to still be at the expected version. Every other
		 * statement is guarded on that update having happened, so either the whole
		 * completion is stored or none of it is.
		 */
		async commitCompletion(ownerId: string, jobWrite: JobWrite, effects: CompletionEffects) {
			const mutationId = crypto.randomUUID();
			const guard: Guard = { sql: JOB_GUARD_SQL, values: [ownerId, jobWrite.runId, mutationId] };
			const workspace = effects.workspace;
			const statements = jobWriteStatements(
				db,
				ownerId,
				jobWrite,
				mutationId,
				workspace === null
					? undefined
					: {
							sql: "EXISTS (SELECT 1 FROM workspaces WHERE owner_id = ? AND workspace_id = ? AND version = ?)",
							values: [ownerId, workspace.workspaceId, workspace.expectedVersion],
						},
			);
			if (workspace !== null) {
				statements.push(
					workspaceUpdateStatement(db, ownerId, workspace, guard),
					insertCommandsStatement(db, ownerId, workspace.workspaceId, workspace.commands, guard),
				);
			}
			if (effects.bundle !== null) {
				statements.push(
					...recordStatements(
						db,
						ownerId,
						jobWrite.runId,
						effects.assistantMessage?.workspaceId ?? null,
						bundleRecords(effects.bundle),
						effects.bundle.datasets,
						guard,
					),
				);
			}
			if (effects.assistantMessage !== null) {
				statements.push(
					appendMessageStatement(
						db,
						ownerId,
						{
							...effects.assistantMessage,
							role: "assistant",
							runId: jobWrite.runId,
							at: jobWrite.at,
						},
						guard,
					),
				);
			}
			let articleStatementIndex = -1;
			if (effects.articles.length > 0) {
				articleStatementIndex = statements.length;
				statements.push(
					db
						.prepare(
							// OR IGNORE implements FR-003: a URL or fingerprint already stored is skipped.
							`INSERT OR IGNORE INTO articles (owner_id, article_id, source_id, canonical_url, publisher, title,
								published_at, retrieved_at, content_fingerprint, excerpt)
							SELECT ?, json_extract(value, '$.articleId'), json_extract(value, '$.sourceId'),
								json_extract(value, '$.canonicalUrl'), json_extract(value, '$.publisher'),
								json_extract(value, '$.title'), json_extract(value, '$.publishedAt'),
								json_extract(value, '$.retrievedAt'), json_extract(value, '$.contentFingerprint'),
								json_extract(value, '$.excerpt')
							FROM json_each(?) WHERE ${guard.sql}`,
						)
						.bind(ownerId, JSON.stringify(effects.articles), ...guard.values),
				);
			}
			if (effects.sourceReports.length > 0) {
				statements.push(
					db
						.prepare(
							`UPDATE news_sources SET
								last_fetched_at = report.fetched_at,
								last_error_code = report.error_code,
								feed_status = CASE
									WHEN news_sources.feed_status = 'paused' THEN 'paused'
									WHEN report.error_code IS NULL THEN 'active'
									ELSE 'failing' END
							FROM (SELECT json_extract(value, '$.sourceId') AS source_id,
									json_extract(value, '$.fetchedAt') AS fetched_at,
									json_extract(value, '$.errorCode') AS error_code
								FROM json_each(?)) AS report
							WHERE news_sources.owner_id = ? AND news_sources.source_id = report.source_id AND ${guard.sql}`,
						)
						.bind(JSON.stringify(effects.sourceReports), ownerId, ...guard.values),
				);
			}

			const results = await db.batch(statements);
			if (results[0]?.meta.changes === 1) {
				return {
					kind: "committed",
					newArticleCount:
						articleStatementIndex === -1 ? 0 : (results[articleStatementIndex]?.meta.changes ?? 0),
				};
			}
			if (workspace === null) return { kind: "job-conflict" };
			const current = await db
				.prepare("SELECT version FROM research_jobs WHERE owner_id = ? AND run_id = ?")
				.bind(ownerId, jobWrite.runId)
				.first();
			return current !== null &&
				numberColumn("research_jobs", "version", current) === jobWrite.expectedVersion
				? { kind: "workspace-conflict" }
				: { kind: "job-conflict" };
		},

		async importWorkspace(input) {
			const { ownerId, record } = input;
			const workspaceId = record.summary.workspaceId;
			const messages = input.messages.map((message: ChatMessage) => ({
				...message,
				claimIds: JSON.stringify(message.claimIds),
			}));
			const statements = [
				db
					.prepare(
						`INSERT INTO workspaces (owner_id, workspace_id, title, version, state_json, last_mutation_id, created_at, updated_at)
						VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						ownerId,
						workspaceId,
						record.summary.title,
						record.state.version,
						JSON.stringify(record.state),
						crypto.randomUUID(),
						input.at,
						input.at,
					),
				...recordStatements(
					db,
					ownerId,
					input.importRunId,
					workspaceId,
					input.records,
					input.datasets,
					ALWAYS,
				),
			];
			if (messages.length > 0) {
				statements.push(
					db
						.prepare(
							`INSERT INTO chat_messages (owner_id, message_id, workspace_id, seq, role, text, run_id, claim_ids_json, created_at)
							SELECT ?, json_extract(value, '$.messageId'), ?, json_extract(value, '$.seq'),
								json_extract(value, '$.role'), json_extract(value, '$.text'), json_extract(value, '$.runId'),
								json_extract(value, '$.claimIds'), json_extract(value, '$.createdAt')
							FROM json_each(?)`,
						)
						.bind(ownerId, workspaceId, JSON.stringify(messages)),
				);
			}
			await db.batch(statements);
		},

		/**
		 * Deletes a conversation and everything it solely owns in one atomic
		 * batch (ownership rule in `DeleteWorkspaceInput`). The first statement
		 * is a guarded compare-and-set: it stamps a mutation id only when the
		 * workspace exists AND no run of it is unfinished. Every removal after
		 * it is conditional on that stamp, so a run submitted concurrently
		 * either commits first (and the delete refuses with "has-unfinished")
		 * or commits after (and its workspace-guarded insert writes nothing) —
		 * no run can survive pointing at a deleted conversation. Within the
		 * batch every statement is set-based; no per-row loops.
		 *
		 * What is NOT guaranteed: the `keep*` lists are a snapshot of surviving
		 * references taken before the batch. A borrow (a component or dataset
		 * cell in another conversation) that commits concurrently with the
		 * delete may reference a removed row; reads tolerate the dangling id
		 * (unknown ids resolve as absent) and the next write re-validates.
		 */
		async deleteWorkspace(input: DeleteWorkspaceInput): Promise<DeleteWorkspaceOutcome> {
			const { ownerId, workspaceId } = input;
			const mutationId = crypto.randomUUID();
			const guard: Guard = {
				sql: "EXISTS (SELECT 1 FROM workspaces WHERE owner_id = ? AND workspace_id = ? AND last_mutation_id = ?)",
				values: [ownerId, workspaceId, mutationId],
			};
			// Runs this conversation owns: jobs naming it, plus linked runs (an
			// import writes records under its run id without a job row).
			const runIdList: Guard = {
				sql: `SELECT run_id FROM research_jobs WHERE owner_id = ? AND workspace_id = ?
					UNION SELECT run_id FROM workspace_runs WHERE owner_id = ? AND workspace_id = ?`,
				values: [ownerId, workspaceId, ownerId, workspaceId],
			};
			const doomedRuns = (column: string): Guard => ({
				sql: `${column} IN (${runIdList.sql})`,
				values: runIdList.values,
			});
			const keepIds = (column: string, ids: readonly string[]): Guard => ({
				sql: `${column} NOT IN (SELECT value FROM json_each(?))`,
				values: [JSON.stringify(ids)],
			});
			const prep = (sql: string, values: readonly SqlValue[]): SqlStatement =>
				db.prepare(`${sql} AND ${guard.sql}`).bind(...values, ...guard.values);
			const doomed = doomedRuns("run_id");
			const keptClaims = keepIds("claim_id", input.keepClaimIds);
			const keptEvidence = keepIds("evidence_id", input.keepEvidenceIds);
			const keptDatasets = keepIds("dataset_id", input.keepDatasetIds);
			const statements: SqlStatement[] = [
				// The compare-and-set the whole delete hangs off: stamps only
				// when the workspace exists with no unfinished run.
				db
					.prepare(
						`UPDATE workspaces SET last_mutation_id = ?
						WHERE owner_id = ? AND workspace_id = ?
							AND NOT EXISTS (SELECT 1 FROM research_jobs
								WHERE owner_id = ? AND workspace_id = ? AND state NOT IN (${TERMINAL_SQL}))`,
					)
					.bind(mutationId, ownerId, workspaceId, ownerId, workspaceId),
				// Claim edges of removed claims (kept claims keep theirs, so
				// their evidence survives the check below).
				prep(
					`DELETE FROM claim_evidence WHERE owner_id = ? AND claim_id IN
						(SELECT claim_id FROM claims WHERE owner_id = ? AND ${doomed.sql} AND ${keptClaims.sql})`,
					[ownerId, ownerId, ...doomed.values, ...keptClaims.values],
				),
				prep(`DELETE FROM claims WHERE owner_id = ? AND ${doomed.sql} AND ${keptClaims.sql}`, [
					ownerId,
					...doomed.values,
					...keptClaims.values,
				]),
				// Evidence survives when a remaining edge, a surviving
				// dataset cell, or a surviving canvas still cites it.
				prep(
					`DELETE FROM evidence WHERE owner_id = ? AND ${doomed.sql} AND ${keptEvidence.sql}
						AND NOT EXISTS (SELECT 1 FROM claim_evidence
							WHERE owner_id = ? AND claim_evidence.evidence_id = evidence.evidence_id)
						AND NOT EXISTS (SELECT 1 FROM datasets d,
							json_each(d.body_json, '$.rows') AS rows, json_each(rows.value) AS cell
							WHERE d.owner_id = ? AND (d.run_id NOT IN (${runIdList.sql})
								OR d.dataset_id IN (SELECT value FROM json_each(?)))
							AND json_extract(cell.value, '$.sourceId') = evidence.evidence_id)`,
					[
						ownerId,
						...doomed.values,
						...keptEvidence.values,
						ownerId,
						ownerId,
						...runIdList.values,
						JSON.stringify(input.keepDatasetIds),
					],
				),
				prep(`DELETE FROM research_records WHERE owner_id = ? AND ${doomed.sql}`, [
					ownerId,
					...doomed.values,
				]),
				prep(`DELETE FROM datasets WHERE owner_id = ? AND ${doomed.sql} AND ${keptDatasets.sql}`, [
					ownerId,
					...doomed.values,
					...keptDatasets.values,
				]),
				prep(`DELETE FROM job_events WHERE owner_id = ? AND ${doomed.sql}`, [
					ownerId,
					...doomed.values,
				]),
				prep(`DELETE FROM job_transitions WHERE owner_id = ? AND ${doomed.sql}`, [
					ownerId,
					...doomed.values,
				]),
				prep(`DELETE FROM research_jobs WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM workspace_runs WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM chat_messages WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM workspace_commands WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM workspaces WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
			];
			const results = await db.batch(statements);
			if (results[0]?.meta.changes === 1) return "deleted";
			// The stamp lost: either the workspace is gone, or an unfinished
			// run exists. The follow-up read only names the answer; the
			// atomic decision already happened above.
			const workspace = await db
				.prepare("SELECT 1 AS found FROM workspaces WHERE owner_id = ? AND workspace_id = ?")
				.bind(ownerId, workspaceId)
				.first();
			return workspace === null ? "not-found" : "has-unfinished";
		},
	};
}
