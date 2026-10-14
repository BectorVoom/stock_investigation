import type {
	CompletionEffects,
	DeleteWorkspaceInput,
	DeleteWorkspaceOutcome,
	EarningsCompletionStock,
	JobWrite,
	MarketCompletionSeries,
	ResearchUnitOfWork,
	WorkspaceWrite,
} from "@research/application";
import { deriveConversationTitle } from "@research/application";
import type { ChatMessage, Dataset, ResearchBundle, RunRecords } from "@research/contracts";
import { DEFAULT_CONVERSATION_TITLE, MARKET_LIMITS } from "@research/contracts";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import {
	enqueueOutcome,
	googleLinkStatements,
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

export interface MarketObservationPoint {
	readonly seriesId: string;
	readonly observedOn: string;
	readonly value: number;
}

/**
 * S5: D1 limits a bound string to about 2 MB (Cloudflare's documented limit;
 * a single observations JSON parameter measured 1.96 MB for a 30 x 800 first
 * refresh). Split the observations upsert into chunks that stay well under
 * 1 MB each: one point serializes to at most ~160 bytes (series id ≤ 64
 * chars, ISO date, number, JSON overhead), so 4,000 points peak near 640 KB.
 * A maximal completion (30 series x 800 = 24,000 points) needs 6 chunks.
 */
export const MARKET_OBSERVATION_CHUNK_POINTS = 4_000;

/** Packs observation points into upsert chunks of at most `MARKET_OBSERVATION_CHUNK_POINTS`. */
export function chunkObservationPoints(
	points: readonly MarketObservationPoint[],
): MarketObservationPoint[][] {
	const chunks: MarketObservationPoint[][] = [];
	for (let start = 0; start < points.length; start += MARKET_OBSERVATION_CHUNK_POINTS) {
		chunks.push(points.slice(start, start + MARKET_OBSERVATION_CHUNK_POINTS));
	}
	return chunks;
}

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

/**
 * Narrows a completion entry to one that carried provider metadata. The
 * succeeded branch then reads `entry.meta.*` directly: no `?? fallback`
 * chain that could invent a title, unit or source URL.
 */
function hasMarketMeta(entry: MarketCompletionSeries): entry is MarketCompletionSeries & {
	readonly meta: NonNullable<MarketCompletionSeries["meta"]>;
} {
	return entry.meta !== null;
}

/**
 * Statements storing one market-refresh completion (FR-017). Writes are
 * set-based: one `json_each` statement for ALL succeeded series' metadata, one
 * for ALL failed series' status rows, chunked `json_each` statements for the
 * observations (S5: no bound parameter near D1's ~2 MB string limit), one prune
 * to `MARKET_LIMITS.maxStoredObservations` rows per series — regardless of row
 * count. A full 30-series completion costs 2 (job + audit, counted by the
 * caller) + at most 2 + 6 + 1 = 11 here, well under the ~50-query D1 budget;
 * a failed series keeps its stored observations and only records the failure
 * code and attempt time. The whole completion stays one guarded batch.
 */
function marketStatements(
	db: SqlDatabase,
	ownerId: string,
	series: readonly NonNullable<CompletionEffects["marketSeries"]>[number][],
	guard: Guard,
): SqlStatement[] {
	if (series.length === 0) return [];
	const succeeded = series.filter(hasMarketMeta);
	const failed = series.filter((entry) => entry.meta === null);
	const statements: SqlStatement[] = [];
	if (succeeded.length > 0) {
		const meta = succeeded.map((entry) => ({
			seriesId: entry.seriesId,
			provider: entry.provider,
			symbol: entry.symbol,
			title: entry.meta.title,
			unit: entry.meta.unit,
			frequency: entry.meta.frequency,
			publisher: entry.meta.publisher,
			sourceUrl: entry.meta.sourceUrl,
			lastRefreshedAt: entry.fetchedAt,
			retrievedAt: entry.fetchedAt,
		}));
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code)
					SELECT ?, json_extract(value, '$.seriesId'), json_extract(value, '$.provider'),
						json_extract(value, '$.symbol'), json_extract(value, '$.title'),
						json_extract(value, '$.unit'), json_extract(value, '$.frequency'),
						json_extract(value, '$.publisher'), json_extract(value, '$.sourceUrl'),
						json_extract(value, '$.lastRefreshedAt'), json_extract(value, '$.retrievedAt'), NULL
					FROM json_each(?) WHERE ${guard.sql}
					ON CONFLICT (owner_id, series_id) DO UPDATE SET
						provider = excluded.provider, symbol = excluded.symbol, title = excluded.title,
						unit = excluded.unit, frequency = excluded.frequency, publisher = excluded.publisher,
						source_url = excluded.source_url, last_refreshed_at = excluded.last_refreshed_at,
						retrieved_at = excluded.retrieved_at, unavailable_code = NULL`,
				)
				.bind(ownerId, JSON.stringify(meta), ...guard.values),
		);
	}
	if (failed.length > 0) {
		// A failed series keeps its stored observations and metadata and only
		// records the failure code and attempt time; a brand-new failed series
		// gets a placeholder row so the failure is visible instead of NEVER_REFRESHED.
		const meta = failed.map((entry) => ({
			seriesId: entry.seriesId,
			provider: entry.provider,
			symbol: entry.symbol,
			title: entry.symbol,
			sourceUrl:
				entry.provider === "fred"
					? `https://fred.stlouisfed.org/series/${entry.symbol}`
					: "https://twelvedata.com/",
			lastRefreshedAt: entry.fetchedAt,
			unavailableCode: entry.errorCode,
		}));
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code)
					SELECT ?, json_extract(value, '$.seriesId'), json_extract(value, '$.provider'),
						json_extract(value, '$.symbol'), json_extract(value, '$.title'), '', 'unknown', '',
						json_extract(value, '$.sourceUrl'), json_extract(value, '$.lastRefreshedAt'), NULL,
						json_extract(value, '$.unavailableCode')
					FROM json_each(?) WHERE ${guard.sql}
					ON CONFLICT (owner_id, series_id) DO UPDATE SET
						last_refreshed_at = excluded.last_refreshed_at,
						unavailable_code = excluded.unavailable_code`,
				)
				.bind(ownerId, JSON.stringify(meta), ...guard.values),
		);
	}
	const points: MarketObservationPoint[] = succeeded.flatMap((entry) =>
		entry.observations.map((point) => ({
			seriesId: entry.seriesId,
			observedOn: point.observedOn,
			value: point.value,
		})),
	);
	// S5: one upsert statement per chunk, each well under 1 MB of bound JSON.
	for (const chunk of chunkObservationPoints(points)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO market_observations (owner_id, series_id, observed_on, value)
					SELECT ?, json_extract(value, '$.seriesId'), json_extract(value, '$.observedOn'),
						json_extract(value, '$.value')
					FROM json_each(?) WHERE ${guard.sql}
					ON CONFLICT (owner_id, series_id, observed_on) DO UPDATE SET value = excluded.value
					WHERE excluded.value <> market_observations.value`,
				)
				.bind(ownerId, JSON.stringify(chunk), ...guard.values),
		);
	}
	statements.push(
		db
			.prepare(
				`DELETE FROM market_observations WHERE owner_id = ?
				AND series_id IN (SELECT value FROM json_each(?))
				AND (owner_id, series_id, observed_on) IN (
					SELECT owner_id, series_id, observed_on FROM (
						SELECT owner_id, series_id, observed_on,
							ROW_NUMBER() OVER (PARTITION BY series_id ORDER BY observed_on DESC) AS rn
						FROM market_observations WHERE owner_id = ?
						-- S4c: the window scan is restricted to this completion's
						-- series, not every observation the owner holds.
						AND series_id IN (SELECT value FROM json_each(?))
					) WHERE rn > ${MARKET_LIMITS.maxStoredObservations}
				) AND ${guard.sql}`,
			)
			.bind(
				ownerId,
				JSON.stringify(series.map((entry) => entry.seriesId)),
				ownerId,
				JSON.stringify(series.map((entry) => entry.seriesId)),
				...guard.values,
			),
	);
	return statements;
}

/**
 * Statements storing one earnings-refresh completion (FR-018). Writes are
 * set-based: one `json_each` statement for ALL succeeded stocks' rows, one
 * for ALL failed stocks' status rows, one DELETE plus one `json_each`
 * INSERT replacing the succeeded stocks' events — regardless of row count.
 * A full 50-stock completion costs 2 (job + audit, counted by the caller) +
 * at most 4 here, well under the ~50-query D1 budget. NO_SCHEDULED_DATE is a
 * successful retrieval with nothing listed: it clears the stock's stored
 * events and sets both stamps while recording the code. Every other error
 * keeps the stored events and records only the code and attempt time; only
 * stocks still on the watchlist reach this function (the service drops the
 * rest before committing), and the writes below are fail-closed anyway —
 * an UPDATE that matches no row and an events INSERT guarded on the
 * watchlist row — so a stock removed between the check and the batch leaves
 * neither a stock row nor orphan events.
 */
function earningsStatements(
	db: SqlDatabase,
	ownerId: string,
	stocks: readonly EarningsCompletionStock[],
	guard: Guard,
): SqlStatement[] {
	if (stocks.length === 0) return [];
	// NO_SCHEDULED_DATE is a successful retrieval with nothing listed, not a
	// failed attempt: like a dated success it clears the stock's stored events
	// and sets both stamps — but the code is still recorded, so the page can
	// say why there is no date. Every other error keeps the stored events and
	// records only the code and attempt time.
	const cleared = stocks.filter(
		(entry) => entry.errorCode === null || entry.errorCode === "NO_SCHEDULED_DATE",
	);
	const failed = stocks.filter(
		(entry) => entry.errorCode !== null && entry.errorCode !== "NO_SCHEDULED_DATE",
	);
	const statements: SqlStatement[] = [];
	if (cleared.length > 0) {
		// A cleared stock sets its attempt and success stamps and takes the
		// runner's company name only when one was returned (COALESCE keeps
		// the stored name otherwise) — never a guess. Dated successes clear
		// the failure code; NO_SCHEDULED_DATE records it.
		const rows = cleared.map((entry) => ({
			stockId: entry.stockId,
			name: entry.name,
			fetchedAt: entry.fetchedAt,
			unavailableCode: entry.errorCode,
		}));
		statements.push(
			db
				.prepare(
					`UPDATE watchlist_stocks SET
						name = COALESCE(payload.name, watchlist_stocks.name),
						last_refreshed_at = payload.fetched_at,
						retrieved_at = payload.fetched_at,
						unavailable_code = payload.unavailable_code
					FROM (SELECT json_extract(value, '$.stockId') AS stock_id,
							json_extract(value, '$.name') AS name,
							json_extract(value, '$.fetchedAt') AS fetched_at,
							json_extract(value, '$.unavailableCode') AS unavailable_code
						FROM json_each(?)) AS payload
					WHERE watchlist_stocks.owner_id = ?
						AND watchlist_stocks.stock_id = payload.stock_id
						AND ${guard.sql}`,
				)
				.bind(JSON.stringify(rows), ownerId, ...guard.values),
		);
	}
	if (failed.length > 0) {
		// A failed stock keeps its stored events, name and success stamp and
		// only records the failure code and attempt time. UPDATE-only: a
		// watchlist row always pre-exists (the service drops stocks that
		// left before committing), so a stock removed between the check and
		// the batch is simply not recorded — never re-inserted.
		const rows = failed.map((entry) => ({
			stockId: entry.stockId,
			fetchedAt: entry.fetchedAt,
			unavailableCode: entry.errorCode,
		}));
		statements.push(
			db
				.prepare(
					`UPDATE watchlist_stocks SET
						last_refreshed_at = payload.fetched_at,
						unavailable_code = payload.unavailable_code
					FROM (SELECT json_extract(value, '$.stockId') AS stock_id,
							json_extract(value, '$.fetchedAt') AS fetched_at,
							json_extract(value, '$.unavailableCode') AS unavailable_code
						FROM json_each(?)) AS payload
					WHERE watchlist_stocks.owner_id = ?
						AND watchlist_stocks.stock_id = payload.stock_id
						AND ${guard.sql}`,
				)
				.bind(JSON.stringify(rows), ownerId, ...guard.values),
		);
	}
	const clearedIds = cleared.map((entry) => entry.stockId);
	if (cleared.length > 0) {
		// A cleared stock REPLACES its stored events (set-based): rows of a
		// rescheduled-away period vanish with the delete below, and a
		// NO_SCHEDULED_DATE stock's stale dates vanish because its fresh
		// event list is empty.
		statements.push(
			db
				.prepare(
					`DELETE FROM earnings_events WHERE owner_id = ?
					AND stock_id IN (SELECT value FROM json_each(?)) AND ${guard.sql}`,
				)
				.bind(ownerId, JSON.stringify(clearedIds), ...guard.values),
		);
		const events = cleared.flatMap((entry) =>
			entry.events.map((event) => ({
				stockId: entry.stockId,
				periodKey: event.periodKey,
				announcementDate: event.announcementDate,
				fiscalPeriodLabel: event.fiscalPeriodLabel,
				fiscalPeriodEnd: event.fiscalPeriodEnd,
				timing: event.timing,
			})),
		);
		if (events.length > 0) {
			statements.push(
				db
					.prepare(
						`INSERT INTO earnings_events
							(owner_id, stock_id, period_key, announcement_date, fiscal_period_label, fiscal_period_end, timing)
						SELECT ?, json_extract(value, '$.stockId'), json_extract(value, '$.periodKey'),
							json_extract(value, '$.announcementDate'), json_extract(value, '$.fiscalPeriodLabel'),
							json_extract(value, '$.fiscalPeriodEnd'), json_extract(value, '$.timing')
						FROM json_each(?) WHERE ${guard.sql}
							AND EXISTS (SELECT 1 FROM watchlist_stocks AS guard_stock
								WHERE guard_stock.owner_id = ?
								AND guard_stock.stock_id = json_extract(value, '$.stockId'))
						ON CONFLICT (owner_id, stock_id, period_key) DO UPDATE SET
							announcement_date = excluded.announcement_date,
							fiscal_period_label = excluded.fiscal_period_label,
							fiscal_period_end = excluded.fiscal_period_end,
							timing = excluded.timing`,
					)
					.bind(ownerId, JSON.stringify(events), ...guard.values, ownerId),
			);
		}
	}
	return statements;
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
			statements.push(...marketStatements(db, ownerId, effects.marketSeries ?? [], guard));
			statements.push(...earningsStatements(db, ownerId, effects.earnings ?? [], guard));
			if (effects.google !== null) {
				statements.push(...googleLinkStatements(db, ownerId, effects.google, jobWrite.at, guard));
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
