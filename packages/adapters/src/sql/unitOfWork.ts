import type {
	CompletionEffects,
	DeleteWorkspaceInput,
	DeleteWorkspaceOutcome,
	EarningsCompletionStock,
	JobWrite,
	MarketCompletionSeries,
	ResearchUnitOfWork,
	StockDirectoryCompletion,
	WorkspaceWrite,
} from "@research/application";
import { deriveConversationTitle } from "@research/application";
import type {
	ChatMessage,
	Dataset,
	NotebookTurn,
	ResearchBundle,
	RunRecords,
} from "@research/contracts";
import {
	DEFAULT_CONVERSATION_TITLE,
	EMPTY_NOTEBOOK,
	MARKET_LIMITS,
	NOTEBOOK_LIMITS,
	notebookSchema,
	notebookTurnSchema,
} from "@research/contracts";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { equitySyncStatements } from "./equitySync.ts";
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
import {
	ACTIVE_TASK_COUNT_BELOW_SQL,
	insertScheduledTaskStatement,
	TASK_COUNT_BELOW_SQL,
} from "./scheduledTasks.ts";
import { chunkStockDirectoryRows } from "./stockDirectoryChunks.ts";

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

/**
 * ADR-0044: answered dates one history-delete statement carries at most. A
 * date serializes to 13 bytes in the JSON list, so a full statement binds
 * about 320 KB (well under D1's ~2 MB string limit), and a maximal
 * completion (60 series x 800 dates) needs 2 statements instead of one per
 * series — the batch stays far under the ~50-query D1 budget.
 */
export const MARKET_HISTORY_DELETE_CHUNK_DATES = 24_000;

/** One series' history replacement: the dates its answer holds, and from where it replaces. */
export interface MarketHistoryReplacement {
	readonly seriesId: string;
	/** First date replaced; null replaces every stored row of the series. */
	readonly replaceFrom: string | null;
	readonly dates: readonly string[];
}

/**
 * Packs whole series into history-delete chunks of at most
 * `MARKET_HISTORY_DELETE_CHUNK_DATES` dates (a series is never split: its
 * delete must see every date it answered). A series larger than the budget
 * (never, while it is above `maxObservationsPerResponse`) gets a chunk of
 * its own.
 */
export function chunkHistoryReplacements(
	replacements: readonly MarketHistoryReplacement[],
): MarketHistoryReplacement[][] {
	const chunks: MarketHistoryReplacement[][] = [];
	let current: MarketHistoryReplacement[] = [];
	let dates = 0;
	for (const replacement of replacements) {
		if (
			current.length > 0 &&
			dates + replacement.dates.length > MARKET_HISTORY_DELETE_CHUNK_DATES
		) {
			chunks.push(current);
			current = [];
			dates = 0;
		}
		current.push(replacement);
		dates += replacement.dates.length;
	}
	if (current.length > 0) chunks.push(current);
	return chunks;
}

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

/**
 * Statements replacing one market's stored list with a
 * `stock-directory-refreshed` completion (ADR-0034): delete the owner's rows
 * of that market, insert the new rows in byte-bounded `json_each` chunks,
 * and upsert the market's meta row. Every statement is guarded on the job
 * compare-and-set, so a stale lease (or any lost race) changes nothing and a
 * failed statement rolls the whole batch back — the stored list is replaced
 * all or nothing. A US completion of 7,691 rows costs 1 + 4 + 1 statements
 * here (plus the caller's job write and audit).
 */
function stockDirectoryStatements(
	db: SqlDatabase,
	ownerId: string,
	completion: StockDirectoryCompletion,
	guard: Guard,
): SqlStatement[] {
	const statements: SqlStatement[] = [
		db
			.prepare(
				`DELETE FROM stock_directory
				WHERE owner_id = ? AND market = ? AND ${guard.sql}`,
			)
			.bind(ownerId, completion.market, ...guard.values),
	];
	for (const chunk of chunkStockDirectoryRows(completion.rows)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO stock_directory (owner_id, market, symbol, name, local_name, listing,
						symbol_key, name_key, local_name_key, search_key)
					SELECT ?, ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
						json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'), json_extract(incoming.value, '$[4]'),
						json_extract(incoming.value, '$[5]'), json_extract(incoming.value, '$[6]'), json_extract(incoming.value, '$[7]')
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}`,
				)
				.bind(ownerId, completion.market, chunk, ...guard.values),
		);
	}
	statements.push(
		db
			.prepare(
				`INSERT INTO stock_directory_meta (owner_id, market, entry_count, as_of, retrieved_at, fold_version)
				SELECT ?, ?, ?, ?, ?, ?
				WHERE ${guard.sql}
				ON CONFLICT (owner_id, market) DO UPDATE SET
					entry_count = excluded.entry_count, as_of = excluded.as_of,
					retrieved_at = excluded.retrieved_at, fold_version = excluded.fold_version`,
			)
			.bind(
				ownerId,
				completion.market,
				completion.rows.length,
				completion.asOf,
				completion.retrievedAt,
				completion.foldVersion,
				...guard.values,
			),
	);
	return statements;
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
					SELECT ?, json_extract(incoming.value, '$.evidenceId'), ?, incoming.value
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}`,
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
					SELECT ?, json_extract(incoming.value, '$.claimId'), ?, json_extract(incoming.value, '$.status'), incoming.value
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, JSON.stringify(records.claims), ...guard.values),
		);
		if (edges.length > 0) {
			statements.push(
				db
					.prepare(
						`INSERT INTO claim_evidence (owner_id, claim_id, evidence_id, relation, ordinal)
						SELECT ?, json_extract(incoming.value, '$.claimId'), json_extract(incoming.value, '$.evidenceId'),
							json_extract(incoming.value, '$.relation'), json_extract(incoming.value, '$.ordinal')
						FROM json_each(?) AS incoming
						WHERE ${guard.sql}`,
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
					SELECT ?, json_extract(incoming.value, '$.recordId'), ?, json_extract(incoming.value, '$.recordType'),
						json_extract(incoming.value, '$.ordinal'), json_extract(incoming.value, '$.body')
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, JSON.stringify(typed), ...guard.values),
		);
	}
	if (datasets.length > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO datasets (owner_id, dataset_id, run_id, workspace_id, body_json)
					SELECT ?, json_extract(incoming.value, '$.datasetId'), ?, ?, incoming.value
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}`,
				)
				.bind(ownerId, runId, workspaceId, JSON.stringify(datasets), ...guard.values),
		);
	}
	if (workspaceId !== null) {
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO workspace_runs (owner_id, workspace_id, run_id)
					SELECT ?, ?, ?
					WHERE ${guard.sql}`,
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
				coalesce(
					(
						SELECT max(cm_last.seq) + 1
						FROM chat_messages AS cm_last
						WHERE cm_last.owner_id = ? AND cm_last.workspace_id = ?
					),
					0
				),
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
			`UPDATE workspaces
			SET state_json = ?, version = ?, last_mutation_id = ?, updated_at = ?
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
 * for ALL failed series' status rows, chunked deletes of the rows a history
 * write replaces (ADR-0044), chunked `json_each` statements for the
 * observations (S5: no bound parameter near D1's ~2 MB string limit), one prune
 * to `MARKET_LIMITS.maxStoredObservations` rows per series — regardless of row
 * count. A full 60-series completion costs 2 (job + audit, counted by the
 * caller) + at most 1 + 1 + 2 + 12 + 1 = 17 here, well under the ~50-query D1
 * budget; a failed series keeps its stored observations and only records the
 * failure code and attempt time. The whole completion stays one guarded batch.
 *
 * The stored result equals the domain's `mergeHistory(stored, answered,
 * history, maxStoredObservations)`: the delete drops only rows the answer
 * replaces and does not hold, the upsert writes every answered point (and
 * rewrites a row only when its value changed), the prune runs last. A
 * series without `history` (a runner from before ADR-0044) is only merged.
 *
 * `committedAt` is the API's own completion time (the job write's `at`). A
 * full write stamps `history_checked_at` with it, not with the runner's
 * `fetchedAt`: the claim compares the stamp with the API clock, and a runner
 * clock running ahead would otherwise postpone the next full check.
 */
function marketStatements(
	db: SqlDatabase,
	ownerId: string,
	series: readonly NonNullable<CompletionEffects["marketSeries"]>[number][],
	guard: Guard,
	committedAt: string,
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
			// ADR-0044: only a full write proves the whole stored history current.
			historyCheckedAt: entry.history?.mode === "full" ? committedAt : null,
		}));
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
						unavailable_upstream_status, history_checked_at)
					SELECT ?, json_extract(incoming.value, '$.seriesId'), json_extract(incoming.value, '$.provider'),
						json_extract(incoming.value, '$.symbol'), json_extract(incoming.value, '$.title'),
						json_extract(incoming.value, '$.unit'), json_extract(incoming.value, '$.frequency'),
						json_extract(incoming.value, '$.publisher'), json_extract(incoming.value, '$.sourceUrl'),
						json_extract(incoming.value, '$.lastRefreshedAt'), json_extract(incoming.value, '$.retrievedAt'), NULL, NULL,
						json_extract(incoming.value, '$.historyCheckedAt')
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}
					ON CONFLICT (owner_id, series_id) DO UPDATE SET
						provider = excluded.provider, symbol = excluded.symbol, title = excluded.title,
						unit = excluded.unit, frequency = excluded.frequency, publisher = excluded.publisher,
						source_url = excluded.source_url, last_refreshed_at = excluded.last_refreshed_at,
						retrieved_at = excluded.retrieved_at, unavailable_code = NULL,
						unavailable_upstream_status = NULL,
						history_checked_at = coalesce(excluded.history_checked_at, market_series.history_checked_at)`,
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
			upstreamStatus: entry.upstreamStatus,
		}));
		statements.push(
			db
				.prepare(
					`INSERT INTO market_series (owner_id, series_id, provider, symbol, title, unit, frequency,
						publisher, source_url, last_refreshed_at, retrieved_at, unavailable_code,
						unavailable_upstream_status)
					SELECT ?, json_extract(incoming.value, '$.seriesId'), json_extract(incoming.value, '$.provider'),
						json_extract(incoming.value, '$.symbol'), json_extract(incoming.value, '$.title'), '', 'unknown', '',
						json_extract(incoming.value, '$.sourceUrl'), json_extract(incoming.value, '$.lastRefreshedAt'), NULL,
						json_extract(incoming.value, '$.unavailableCode'), json_extract(incoming.value, '$.upstreamStatus')
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}
					ON CONFLICT (owner_id, series_id) DO UPDATE SET
						last_refreshed_at = excluded.last_refreshed_at,
						unavailable_code = excluded.unavailable_code,
						unavailable_upstream_status = excluded.unavailable_upstream_status`,
				)
				.bind(ownerId, JSON.stringify(meta), ...guard.values),
		);
	}
	const replacements: MarketHistoryReplacement[] = [];
	for (const entry of succeeded) {
		if (entry.history === null) continue;
		replacements.push({
			seriesId: entry.seriesId,
			replaceFrom: entry.history.replaceFrom,
			dates: entry.observations.map((point) => point.observedOn),
		});
	}
	// ADR-0044 step 1: rows the answer replaces but does not hold are deleted
	// (a withdrawn or superseded point), set-based per chunk of series. The
	// answer is parsed once (MATERIALIZED; re-reading a series id out of its
	// 10 KB JSON element per date costs ~10x the whole delete), the stored
	// rows in each series' range are key range seeks (CROSS JOIN keeps the
	// answer outer: SQLite never reorders it), and the answered dates are
	// removed by EXCEPT. Not `(series_id, observed_on) NOT IN (...)`: SQLite
	// scans a row-value NOT IN list per row whose columns may be NULL —
	// measured 25 s for 30 x 1,500 rows.
	for (const chunk of chunkHistoryReplacements(replacements)) {
		statements.push(
			db
				.prepare(
					`WITH answer (series_id, replace_from, dates) AS MATERIALIZED (
						SELECT
							json_extract(incoming.value, '$.seriesId'),
							json_extract(incoming.value, '$.replaceFrom'),
							json_extract(incoming.value, '$.dates')
						FROM json_each(?) AS incoming
					)
					DELETE FROM market_observations
					WHERE market_observations.owner_id = ?
						AND market_observations.series_id IN (SELECT answer.series_id FROM answer)
						AND (market_observations.series_id, market_observations.observed_on) IN (
							SELECT mo.series_id, mo.observed_on
							FROM answer
							CROSS JOIN market_observations AS mo
								ON mo.owner_id = ?
								AND mo.series_id = answer.series_id
								-- '' sorts before every date: a NULL replaceFrom replaces every row.
								AND mo.observed_on >= coalesce(answer.replace_from, '')
							EXCEPT
							SELECT answer.series_id, answered_date.value
							FROM answer, json_each(answer.dates) AS answered_date
						)
						AND ${guard.sql}`,
				)
				.bind(JSON.stringify(chunk), ownerId, ownerId, ...guard.values),
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
					SELECT ?, json_extract(incoming.value, '$.seriesId'), json_extract(incoming.value, '$.observedOn'),
						json_extract(incoming.value, '$.value')
					FROM json_each(?) AS incoming
					WHERE ${guard.sql}
					ON CONFLICT (owner_id, series_id, observed_on) DO UPDATE
						SET value = excluded.value
						WHERE excluded.value <> market_observations.value`,
				)
				.bind(ownerId, JSON.stringify(chunk), ...guard.values),
		);
	}
	// Prune to the newest maxStoredObservations rows per series. Each
	// series' cutoff (the newest row past the limit) is one backward key
	// range seek, and only rows at or before it are touched: a completion
	// with nothing to prune reads ~1,500 index entries per series instead of
	// ranking every stored row (S4c: only this completion's series; measured
	// 3 ms instead of 54 ms for 60 x 1,500 rows).
	statements.push(
		db
			.prepare(
				`WITH cut (series_id, cutoff) AS MATERIALIZED (
					SELECT
						series_ids.value,
						(
							SELECT mo_kept.observed_on
							FROM market_observations AS mo_kept
							WHERE mo_kept.owner_id = ? AND mo_kept.series_id = series_ids.value
							ORDER BY mo_kept.observed_on DESC
							LIMIT 1 OFFSET ?
						)
					FROM json_each(?) AS series_ids
				)
				DELETE FROM market_observations
				WHERE market_observations.owner_id = ?
					AND market_observations.series_id IN (
						SELECT cut.series_id FROM cut WHERE cut.cutoff IS NOT NULL
					)
					AND (market_observations.series_id, market_observations.observed_on) IN (
						SELECT mo.series_id, mo.observed_on
						FROM cut
						CROSS JOIN market_observations AS mo
							ON mo.owner_id = ? AND mo.series_id = cut.series_id AND mo.observed_on <= cut.cutoff
					)
					AND ${guard.sql}`,
			)
			.bind(
				ownerId,
				MARKET_LIMITS.maxStoredObservations,
				JSON.stringify(series.map((entry) => entry.seriesId)),
				ownerId,
				ownerId,
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
			upstreamStatus: entry.upstreamStatus,
		}));
		statements.push(
			db
				.prepare(
					`UPDATE watchlist_stocks SET
						name = coalesce(payload.name, watchlist_stocks.name),
						last_refreshed_at = payload.fetched_at,
						retrieved_at = payload.fetched_at,
						unavailable_code = payload.unavailable_code,
						unavailable_upstream_status = payload.upstream_status
					FROM (SELECT json_extract(incoming.value, '$.stockId') AS stock_id,
							json_extract(incoming.value, '$.name') AS name,
							json_extract(incoming.value, '$.fetchedAt') AS fetched_at,
							json_extract(incoming.value, '$.unavailableCode') AS unavailable_code,
							json_extract(incoming.value, '$.upstreamStatus') AS upstream_status
						FROM json_each(?) AS incoming) AS payload
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
			upstreamStatus: entry.upstreamStatus,
		}));
		statements.push(
			db
				.prepare(
					`UPDATE watchlist_stocks SET
						last_refreshed_at = payload.fetched_at,
						unavailable_code = payload.unavailable_code,
						unavailable_upstream_status = payload.upstream_status
					FROM (SELECT json_extract(incoming.value, '$.stockId') AS stock_id,
							json_extract(incoming.value, '$.fetchedAt') AS fetched_at,
							json_extract(incoming.value, '$.unavailableCode') AS unavailable_code,
							json_extract(incoming.value, '$.upstreamStatus') AS upstream_status
						FROM json_each(?) AS incoming) AS payload
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
					`DELETE FROM earnings_events
					WHERE owner_id = ?
						AND stock_id IN (SELECT cleared_ids.value FROM json_each(?) AS cleared_ids)
						AND ${guard.sql}`,
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
						SELECT ?, json_extract(incoming.value, '$.stockId'), json_extract(incoming.value, '$.periodKey'),
							json_extract(incoming.value, '$.announcementDate'), json_extract(incoming.value, '$.fiscalPeriodLabel'),
							json_extract(incoming.value, '$.fiscalPeriodEnd'), json_extract(incoming.value, '$.timing')
						FROM json_each(?) AS incoming
						WHERE ${guard.sql}
							AND EXISTS (
								SELECT 1
								FROM watchlist_stocks AS ws_guard
								WHERE ws_guard.owner_id = ?
									AND ws_guard.stock_id = json_extract(incoming.value, '$.stockId')
							)
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

/**
 * Statements storing one `notebook-assisted` completion's notebook write
 * (ADR-0020): the current row (compare-and-set on `expectedVersion`, inserted
 * when the base is 0 and no row exists yet), the revision row for the new
 * version, and the set-based prune to the last `maxRevisions` bodies — one
 * guarded batch with the job compare-and-set, so a concurrent owner edit
 * either wins first (and this completion reports `notebook-conflict`) or
 * loses (and the write lands once).
 */
function notebookStatements(
	db: SqlDatabase,
	ownerId: string,
	write: NonNullable<CompletionEffects["notebook"]>,
	guard: Guard,
): SqlStatement[] {
	const validated = notebookSchema.parse(write.notebook);
	const body = JSON.stringify(validated);
	const nextVersion = write.expectedVersion + 1;
	const notebookMutationId = crypto.randomUUID();
	const notebookGuard: Guard = {
		sql: `EXISTS (
			SELECT 1
			FROM workspace_notebooks AS wn_guard
			WHERE wn_guard.owner_id = ? AND wn_guard.workspace_id = ? AND wn_guard.last_mutation_id = ?
		)`,
		values: [ownerId, write.workspaceId, notebookMutationId],
	};
	const both: Guard = {
		sql: `${guard.sql} AND ${notebookGuard.sql}`,
		values: [...guard.values, ...notebookGuard.values],
	};
	const current =
		write.expectedVersion === 0
			? db
					.prepare(
						`INSERT INTO workspace_notebooks (owner_id, workspace_id, body_json, version, last_mutation_id, updated_at)
						SELECT ?, ?, ?, 1, ?, ?
						WHERE NOT EXISTS (
								SELECT 1
								FROM workspace_notebooks AS wn_existing
								WHERE wn_existing.owner_id = ? AND wn_existing.workspace_id = ?
							)
							AND ${guard.sql}`,
					)
					.bind(
						ownerId,
						write.workspaceId,
						body,
						notebookMutationId,
						write.updatedAt,
						ownerId,
						write.workspaceId,
						...guard.values,
					)
			: db
					.prepare(
						`UPDATE workspace_notebooks
						SET body_json = ?, version = version + 1, last_mutation_id = ?, updated_at = ?
						WHERE owner_id = ? AND workspace_id = ? AND version = ? AND ${guard.sql}`,
					)
					.bind(
						body,
						notebookMutationId,
						write.updatedAt,
						ownerId,
						write.workspaceId,
						write.expectedVersion,
						...guard.values,
					);
	const statements = [
		current,
		db
			.prepare(
				`INSERT INTO workspace_notebook_revisions (owner_id, workspace_id, version, body_json)
				SELECT ?, ?, ?, ?
				WHERE ${both.sql}`,
			)
			.bind(ownerId, write.workspaceId, nextVersion, body, ...both.values),
		db
			.prepare(
				`DELETE FROM workspace_notebook_revisions
				WHERE owner_id = ?
					AND workspace_id = ?
					AND version NOT IN (
						SELECT wnr_kept.version
						FROM workspace_notebook_revisions AS wnr_kept
						WHERE wnr_kept.owner_id = ? AND wnr_kept.workspace_id = ?
						ORDER BY wnr_kept.version DESC
						LIMIT ?
					)
					AND ${both.sql}`,
			)
			.bind(
				ownerId,
				write.workspaceId,
				ownerId,
				write.workspaceId,
				NOTEBOOK_LIMITS.maxRevisions,
				...both.values,
			),
	];
	if (write.expectedVersion === 0) {
		// The first write keeps the empty body as revision 0 in the same
		// batch, so undo at version 1 restores "no widgets yet".
		statements.push(
			db
				.prepare(
					`INSERT INTO workspace_notebook_revisions (owner_id, workspace_id, version, body_json)
					SELECT ?, ?, 0, ?
					WHERE ${both.sql}`,
				)
				.bind(ownerId, write.workspaceId, JSON.stringify(EMPTY_NOTEBOOK), ...both.values),
		);
	}
	return statements;
}

/**
 * Statement recording one assistant turn, guarded on the job compare-and-set
 * having won. `OR IGNORE` on the run makes a replayed completion a no-op
 * rather than a second row.
 */
function notebookTurnStatement(
	db: SqlDatabase,
	ownerId: string,
	runId: string,
	write: NonNullable<CompletionEffects["notebookTurn"]>,
	guard: Guard,
): SqlStatement {
	const turn: NotebookTurn = notebookTurnSchema.parse(write.turn);
	return db
		.prepare(
			`INSERT OR IGNORE INTO notebook_turns
				(owner_id, run_id, workspace_id, base_version, applied_version, body_json, created_at)
			SELECT ?, ?, ?, ?, ?, ?, ?
			WHERE ${guard.sql}`,
		)
		.bind(
			ownerId,
			runId,
			write.workspaceId,
			turn.baseVersion,
			turn.appliedVersion,
			JSON.stringify(turn),
			turn.createdAt,
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
							`UPDATE research_jobs
							SET context_anchor_seq = (
								SELECT cm.seq
								FROM chat_messages AS cm
								WHERE cm.owner_id = ? AND cm.workspace_id = ? AND cm.message_id = ?
							)
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
								`UPDATE workspaces
								SET title = ?, updated_at = ?
								WHERE owner_id = ?
									AND workspace_id = ?
									AND title = ?
									AND (
										SELECT count(*)
										FROM chat_messages AS cm
										WHERE cm.owner_id = ? AND cm.workspace_id = ?
									) = 1
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
			const notebook = effects.notebook;
			const conditions: { readonly sql: string; readonly values: readonly SqlValue[] }[] = [];
			if (workspace !== null) {
				conditions.push({
					sql: "EXISTS (SELECT 1 FROM workspaces AS w_base WHERE w_base.owner_id = ? AND w_base.workspace_id = ? AND w_base.version = ?)",
					values: [ownerId, workspace.workspaceId, workspace.expectedVersion],
				});
			}
			if (notebook !== null) {
				// The notebook must still be at the base version the turn was
				// computed against (compare-and-set, like the workspace): a
				// concurrent owner edit fails this condition and the whole
				// completion reports `notebook-conflict` with nothing written.
				conditions.push(
					notebook.expectedVersion === 0
						? {
								sql: "NOT EXISTS (SELECT 1 FROM workspace_notebooks AS wn_base WHERE wn_base.owner_id = ? AND wn_base.workspace_id = ?)",
								values: [ownerId, notebook.workspaceId],
							}
						: {
								sql: "EXISTS (SELECT 1 FROM workspace_notebooks AS wn_base WHERE wn_base.owner_id = ? AND wn_base.workspace_id = ? AND wn_base.version = ?)",
								values: [ownerId, notebook.workspaceId, notebook.expectedVersion],
							},
				);
			}
			const statements = jobWriteStatements(
				db,
				ownerId,
				jobWrite,
				mutationId,
				conditions.length === 0
					? undefined
					: {
							sql: conditions.map((condition) => condition.sql).join(" AND "),
							values: conditions.flatMap((condition) => condition.values),
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
							SELECT ?, json_extract(incoming.value, '$.articleId'), json_extract(incoming.value, '$.sourceId'),
								json_extract(incoming.value, '$.canonicalUrl'), json_extract(incoming.value, '$.publisher'),
								json_extract(incoming.value, '$.title'), json_extract(incoming.value, '$.publishedAt'),
								json_extract(incoming.value, '$.retrievedAt'), json_extract(incoming.value, '$.contentFingerprint'),
								json_extract(incoming.value, '$.excerpt')
							FROM json_each(?) AS incoming
							WHERE ${guard.sql}`,
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
								last_error_upstream_status = report.upstream_status,
								feed_status = CASE
									WHEN news_sources.feed_status = 'paused' THEN 'paused'
									WHEN report.error_code IS NULL THEN 'active'
									ELSE 'failing' END
							FROM (SELECT json_extract(incoming.value, '$.sourceId') AS source_id,
									json_extract(incoming.value, '$.fetchedAt') AS fetched_at,
									json_extract(incoming.value, '$.errorCode') AS error_code,
									json_extract(incoming.value, '$.upstreamStatus') AS upstream_status
								FROM json_each(?) AS incoming) AS report
							WHERE news_sources.owner_id = ? AND news_sources.source_id = report.source_id AND ${guard.sql}`,
						)
						.bind(JSON.stringify(effects.sourceReports), ownerId, ...guard.values),
				);
			}
			statements.push(
				...marketStatements(db, ownerId, effects.marketSeries ?? [], guard, jobWrite.at),
			);
			statements.push(...earningsStatements(db, ownerId, effects.earnings ?? [], guard));
			if (effects.google !== null) {
				statements.push(...googleLinkStatements(db, ownerId, effects.google, jobWrite.at, guard));
			}
			if (notebook !== null) {
				statements.push(...notebookStatements(db, ownerId, notebook, guard));
			}
			if (effects.notebookTurn !== null) {
				statements.push(
					notebookTurnStatement(db, ownerId, jobWrite.runId, effects.notebookTurn, guard),
				);
			}
			if (effects.stockDirectory !== null) {
				statements.push(...stockDirectoryStatements(db, ownerId, effects.stockDirectory, guard));
			}
			if (effects.equitySync !== null) {
				// ADR-0048 §6: filings, facts, changed values and the sync state,
				// all guarded on this batch's job compare-and-set.
				statements.push(...equitySyncStatements(db, ownerId, effects.equitySync, guard));
			}

			const results = await db.batch(statements);
			if (results[0]?.meta.changes === 1) {
				return {
					kind: "committed",
					newArticleCount:
						articleStatementIndex === -1 ? 0 : (results[articleStatementIndex]?.meta.changes ?? 0),
				};
			}
			if (workspace === null && notebook === null) return { kind: "job-conflict" };
			const current = await db
				.prepare("SELECT version FROM research_jobs WHERE owner_id = ? AND run_id = ?")
				.bind(ownerId, jobWrite.runId)
				.first();
			if (
				current === null ||
				numberColumn("research_jobs", "version", current) !== jobWrite.expectedVersion
			) {
				return { kind: "job-conflict" };
			}
			// The job compare-and-set won, so the guarded condition that
			// failed names the conflict: the canvas moved, or the notebook
			// moved past the turn's base version.
			return workspace !== null ? { kind: "workspace-conflict" } : { kind: "notebook-conflict" };
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
							SELECT ?, json_extract(incoming.value, '$.messageId'), ?, json_extract(incoming.value, '$.seq'),
								json_extract(incoming.value, '$.role'), json_extract(incoming.value, '$.text'), json_extract(incoming.value, '$.runId'),
								json_extract(incoming.value, '$.claimIds'), json_extract(incoming.value, '$.createdAt')
							FROM json_each(?) AS incoming`,
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
				sql: "EXISTS (SELECT 1 FROM workspaces AS w_guard WHERE w_guard.owner_id = ? AND w_guard.workspace_id = ? AND w_guard.last_mutation_id = ?)",
				values: [ownerId, workspaceId, mutationId],
			};
			// Runs this conversation owns: jobs naming it, plus linked runs (an
			// import writes records under its run id without a job row).
			const runIdList: Guard = {
				sql: `SELECT rj_run.run_id
					FROM research_jobs AS rj_run
					WHERE rj_run.owner_id = ? AND rj_run.workspace_id = ?
					UNION
					SELECT wr_run.run_id
					FROM workspace_runs AS wr_run
					WHERE wr_run.owner_id = ? AND wr_run.workspace_id = ?`,
				values: [ownerId, workspaceId, ownerId, workspaceId],
			};
			const doomedRuns = (column: string): Guard => ({
				sql: `${column} IN (${runIdList.sql})`,
				values: runIdList.values,
			});
			const keepIds = (column: string, ids: readonly string[]): Guard => ({
				sql: `${column} NOT IN (SELECT kept_ids.value FROM json_each(?) AS kept_ids)`,
				values: [JSON.stringify(ids)],
			});
			const prep = (sql: string, values: readonly SqlValue[]): SqlStatement =>
				db.prepare(`${sql} AND ${guard.sql}`).bind(...values, ...guard.values);
			const doomed = doomedRuns("run_id");
			const keptClaims = keepIds("claim_id", input.keepClaimIds);
			// The same two conditions on the claims alias, for the edge delete's subquery.
			const doomedClaims = doomedRuns("cl.run_id");
			const keptClaimsOfClaims = keepIds("cl.claim_id", input.keepClaimIds);
			const keptEvidence = keepIds("evidence_id", input.keepEvidenceIds);
			const keptDatasets = keepIds("dataset_id", input.keepDatasetIds);
			const statements: SqlStatement[] = [
				// The compare-and-set the whole delete hangs off: stamps only
				// when the workspace exists with no unfinished run.
				db
					.prepare(
						`UPDATE workspaces
						SET last_mutation_id = ?
						WHERE owner_id = ?
							AND workspace_id = ?
							AND NOT EXISTS (
								SELECT 1
								FROM research_jobs AS rj_unfinished
								WHERE rj_unfinished.owner_id = ?
									AND rj_unfinished.workspace_id = ?
									AND rj_unfinished.state NOT IN (${TERMINAL_SQL})
							)`,
					)
					.bind(mutationId, ownerId, workspaceId, ownerId, workspaceId),
				// Claim edges of removed claims (kept claims keep theirs, so
				// their evidence survives the check below).
				prep(
					`DELETE FROM claim_evidence
					WHERE owner_id = ?
						AND claim_id IN (
							SELECT cl.claim_id
							FROM claims AS cl
							WHERE cl.owner_id = ? AND ${doomedClaims.sql} AND ${keptClaimsOfClaims.sql}
						)`,
					[ownerId, ownerId, ...doomedClaims.values, ...keptClaimsOfClaims.values],
				),
				prep(`DELETE FROM claims WHERE owner_id = ? AND ${doomed.sql} AND ${keptClaims.sql}`, [
					ownerId,
					...doomed.values,
					...keptClaims.values,
				]),
				// Evidence survives when a remaining edge, a surviving
				// dataset cell, or a surviving canvas still cites it.
				prep(
					`DELETE FROM evidence
					WHERE owner_id = ?
						AND ${doomed.sql}
						AND ${keptEvidence.sql}
						AND NOT EXISTS (
							SELECT 1
							FROM claim_evidence AS ce
							WHERE ce.owner_id = ? AND ce.evidence_id = evidence.evidence_id
						)
						AND NOT EXISTS (
							SELECT 1
							FROM datasets AS ds,
								json_each(ds.body_json, '$.rows') AS dataset_row,
								json_each(dataset_row.value) AS cell
							WHERE ds.owner_id = ?
								AND (
									ds.run_id NOT IN (${runIdList.sql})
									OR ds.dataset_id IN (SELECT kept_ids.value FROM json_each(?) AS kept_ids)
								)
								AND json_extract(cell.value, '$.sourceId') = evidence.evidence_id
						)`,
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
				prep(`DELETE FROM notebook_turns WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM workspace_notebook_revisions WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM workspace_notebooks WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				prep(`DELETE FROM workspace_commands WHERE owner_id = ? AND workspace_id = ?`, [
					ownerId,
					workspaceId,
				]),
				// ADR-0033 §5: the conversation's scheduled tasks go with it.
				prep(`DELETE FROM scheduled_tasks WHERE owner_id = ? AND workspace_id = ?`, [
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

		/**
		 * The task's conversation and the task in one atomic batch (ADR-0033
		 * §7). The conversation INSERT carries the limits in its own WHERE
		 * clause — fewer than `maxTasks` tasks, fewer than `maxActive` active
		 * ones when the new task is active, and no task with this id yet (a
		 * replayed create) — so concurrent creates cannot both slip under a
		 * limit; the task INSERT is conditional on that row's mutation stamp.
		 * "full" means nothing was written.
		 */
		async createScheduledTask({ ownerId, workspace, task, maxTasks, maxActive }) {
			const mutationId = crypto.randomUUID();
			const { summary, state } = workspace;
			const limits: Guard =
				task.status === "active"
					? {
							sql: `${TASK_COUNT_BELOW_SQL} AND ${ACTIVE_TASK_COUNT_BELOW_SQL}`,
							values: [ownerId, maxTasks, ownerId, maxActive],
						}
					: { sql: TASK_COUNT_BELOW_SQL, values: [ownerId, maxTasks] };
			const results = await db.batch([
				db
					.prepare(
						`INSERT INTO workspaces (owner_id, workspace_id, title, version, state_json, last_mutation_id, created_at, updated_at)
						SELECT ?, ?, ?, ?, ?, ?, ?, ?
						WHERE ${limits.sql}
							AND NOT EXISTS (
								SELECT 1
								FROM scheduled_tasks AS st_existing
								WHERE st_existing.owner_id = ? AND st_existing.task_id = ?
							)`,
					)
					.bind(
						ownerId,
						summary.workspaceId,
						summary.title,
						state.version,
						JSON.stringify(state),
						mutationId,
						summary.createdAt,
						summary.updatedAt,
						...limits.values,
						ownerId,
						task.taskId,
					),
				insertScheduledTaskStatement(db, task, {
					sql: "EXISTS (SELECT 1 FROM workspaces AS w_guard WHERE w_guard.owner_id = ? AND w_guard.workspace_id = ? AND w_guard.last_mutation_id = ?)",
					values: [ownerId, summary.workspaceId, mutationId],
				}),
			]);
			return results[1]?.meta.changes === 1 ? "created" : "full";
		},
	};
}
