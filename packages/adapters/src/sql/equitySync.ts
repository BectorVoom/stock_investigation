/**
 * Annual financial statements synced from SEC and EDINET (ADR-0048 §2):
 * the repository over migration 0021 and the guarded statements a
 * `financial-sync` job's end commits with its job row
 * (`unitOfWork.commitCompletion`).
 *
 * Write discipline (the migration header is normative):
 * - filings: insert-or-ignore; only `facts_status` moves, pending → final;
 * - facts: insert-only (`ON CONFLICT DO NOTHING`);
 * - metric values: upsert that changes a row only when a stored column
 *   differs, so an unchanged selection writes nothing;
 * - every statement of a completion is guarded on the job compare-and-set,
 *   so a stale lease (or any lost race) writes nothing at all.
 * Bulk rows are bound as JSON arrays read with `json_each` (D1 allows at
 * most 100 bound parameters per statement), chunked by bytes.
 */
import type {
	EquityClaimContext,
	EquityCompanyRecord,
	EquityCompanySummary,
	EquityFactWithFiling,
	EquityMetricValueContent,
	EquityMetricValueWithFiling,
	EquitySyncEffects,
	EquitySyncRepository,
	EquitySyncStateRecord,
	StoredEquityFact,
	StoredEquityFiling,
	StoredEquityMetricValue,
} from "@research/application";
import { EMPTY_EQUITY_SYNC_STATE } from "@research/application";
import {
	equityAccountingStandardSchema,
	equityMarketSchema,
	equityMetricCodeSchema,
	equityPeriodTypeSchema,
	equityProviderSchema,
	equityReportFormSchema,
	equityScopeSchema,
	equityUnavailableReasonSchema,
} from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { TERMINAL_SQL } from "./repositories.ts";
import { decode, storedUpstreamStatus } from "./rows.ts";

/** A batch guard: SQL that is true only inside the batch whose job compare-and-set won. */
export interface EquityGuard {
	readonly sql: string;
	readonly values: readonly SqlValue[];
}

const UNGUARDED: EquityGuard = { sql: "1 = 1", values: [] };

/**
 * Bound JSON per bulk statement at most (UTF-8 bytes): well under D1's
 * ~2 MB string limit. A maximal completion (60 filings, 3,000 facts of
 * ~230 bytes each) needs 2 fact statements.
 */
export const EQUITY_CHUNK_BYTES = 512 * 1024;

function utf8Length(text: string): number {
	let bytes = 0;
	for (let index = 0; index < text.length; index += 1) {
		const code = text.charCodeAt(index);
		if (code < 0x80) bytes += 1;
		else if (code < 0x800) bytes += 2;
		else if (code >= 0xd800 && code <= 0xdbff) {
			// A surrogate pair is one 4-byte character; its low half adds nothing.
			bytes += 4;
			index += 1;
		} else bytes += 3;
	}
	return bytes;
}

/** Serialized JSON arrays of rows, each at most `budgetBytes` (a larger single row gets its own). */
export function chunkEquityRows(
	rows: readonly (readonly SqlValue[])[],
	budgetBytes: number = EQUITY_CHUNK_BYTES,
): string[] {
	const chunks: string[] = [];
	let current: string[] = [];
	let size = 2;
	for (const row of rows) {
		const json = JSON.stringify(row);
		const bytes = utf8Length(json) + (current.length === 0 ? 0 : 1);
		if (current.length > 0 && size + bytes > budgetBytes) {
			chunks.push(`[${current.join(",")}]`);
			current = [];
			size = 2;
		}
		size += current.length === 0 ? utf8Length(json) : bytes;
		current.push(json);
	}
	if (current.length > 0) chunks.push(`[${current.join(",")}]`);
	return chunks;
}

/* ---------- Row decoding ---------- */

const text = z.string();
const nullableText = z.string().nullable();
const phaseSchema = z.enum(["discovery", "backfill", "forward", "idle", "not-found"]);

const companyRowSchema = z.object({
	company_id: text,
	market: equityMarketSchema,
	symbol: text,
	provider: equityProviderSchema,
	source_company_id: nullableText,
	name: nullableText,
	fiscal_year_end: nullableText,
	tracked: z.number(),
	tracked_at: text,
});

/** The sync-state columns of a joined row (`state_` prefix; all null when no state row exists). */
const stateRowSchema = z.object({
	state_next_due_at: nullableText,
	state_last_checked_at: nullableText,
	state_last_succeeded_at: nullableText,
	state_failure_code: nullableText,
	state_failure_upstream_status: storedUpstreamStatus,
	state_failure_at: nullableText,
	state_consecutive_failures: z.number().nullable(),
	state_more_pending: z.number().nullable(),
	state_edinet_phase: phaseSchema.nullable(),
	state_data_updated_at: nullableText,
});

/** Columns qualified with `alias`, each renamed `<prefix><column>` (a join's colliding names). */
function prefixedColumns(alias: string, prefix: string, columns: readonly string[]): string {
	return columns.map((column) => `${alias}.${column} AS ${prefix}${column}`).join(", ");
}

/** Columns qualified with `alias`, under their own names. */
function qualifiedColumns(alias: string, columns: readonly string[]): string {
	return columns.map((column) => `${alias}.${column}`).join(", ");
}

const STATE_COLUMNS = prefixedColumns("ess", "state_", [
	"next_due_at",
	"last_checked_at",
	"last_succeeded_at",
	"failure_code",
	"failure_upstream_status",
	"failure_at",
	"consecutive_failures",
	"more_pending",
	"edinet_phase",
	"data_updated_at",
]);

/** The company columns a company read decodes, qualified with `eco` (every company read aliases it). */
const COMPANY_COLUMNS = qualifiedColumns("eco", [
	"company_id",
	"market",
	"symbol",
	"provider",
	"source_company_id",
	"name",
	"fiscal_year_end",
	"tracked",
	"tracked_at",
]);

const filingRowSchema = z.object({
	filing_id: text,
	company_id: text,
	provider: equityProviderSchema,
	source_document_id: text,
	form: equityReportFormSchema,
	filed_on: text,
	submitted_at: nullableText,
	period_start: nullableText,
	period_end: text,
	accounting_standard: equityAccountingStandardSchema.nullable(),
	amends_source_document_id: nullableText,
	source_url: text,
	facts_status: z.enum(["pending", "extracted", "unavailable"]),
	fact_count: z.number(),
	primary_scope: equityScopeSchema.nullable(),
});

/** The filing columns a filing read decodes (`filingRowSchema`'s keys). */
const FILING_COLUMN_NAMES = filingRowSchema.keyof().options;

/** A filing read from `equity_report_filing` alone. */
const FILING_COLUMNS = FILING_COLUMN_NAMES.join(", ");

/**
 * The filing columns of a join, `filing_` prefixed: the joined value and fact
 * rows have their own `filing_id`, `period_start` and `period_end`.
 */
const JOINED_FILING_COLUMNS = prefixedColumns("erf", "filing_", FILING_COLUMN_NAMES);

const factRowSchema = z.object({
	filing_id: text,
	concept: text,
	scope: equityScopeSchema,
	period_type: equityPeriodTypeSchema,
	period_start: text,
	period_end: text,
	unit: text,
	fiscal_year: z.number(),
	metric_code: equityMetricCodeSchema.nullable(),
	value_decimal: text,
	filing_filed_on: text,
	filing_accounting_standard: equityAccountingStandardSchema.nullable(),
	filing_primary_scope: equityScopeSchema.nullable(),
});

/** The fact columns a fact read decodes, qualified with `erp` (fact reads always join the filing). */
const FACT_COLUMNS = qualifiedColumns("erp", [
	"filing_id",
	"concept",
	"scope",
	"period_type",
	"period_start",
	"period_end",
	"unit",
	"fiscal_year",
	"metric_code",
	"value_decimal",
]);

const valueRowSchema = z.object({
	metric_code: equityMetricCodeSchema,
	fiscal_year: z.number(),
	value_decimal: nullableText,
	currency: nullableText,
	unavailable_reason: equityUnavailableReasonSchema.nullable(),
	filing_id: nullableText,
	concept: nullableText,
	scope: equityScopeSchema.nullable(),
	period_start: nullableText,
	period_end: nullableText,
	derived: z.number(),
	reported_value_count: z.number(),
	updated_at: text,
});

/** The metric-value columns a value read decodes (`valueRowSchema`'s keys). */
const VALUE_COLUMN_NAMES = valueRowSchema.keyof().options;

function toCompany(row: unknown): EquityCompanyRecord {
	const r = decode("equity_company", companyRowSchema, row);
	return {
		companyId: r.company_id,
		market: r.market,
		symbol: r.symbol,
		provider: r.provider,
		sourceCompanyId: r.source_company_id,
		name: r.name,
		fiscalYearEnd: r.fiscal_year_end,
		tracked: r.tracked !== 0,
		trackedAt: r.tracked_at,
	};
}

function toState(row: unknown): EquitySyncStateRecord {
	const r = decode("equity_sync_state", stateRowSchema, row);
	if (r.state_consecutive_failures === null) return EMPTY_EQUITY_SYNC_STATE;
	return {
		nextDueAt: r.state_next_due_at,
		lastCheckedAt: r.state_last_checked_at,
		lastSucceededAt: r.state_last_succeeded_at,
		failureCode: r.state_failure_code,
		failureUpstreamStatus: r.state_failure_code === null ? null : r.state_failure_upstream_status,
		failureAt: r.state_failure_at,
		consecutiveFailures: r.state_consecutive_failures,
		morePending: r.state_more_pending === 1,
		edinetPhase: r.state_edinet_phase,
		dataUpdatedAt: r.state_data_updated_at,
	};
}

function toFiling(row: unknown): StoredEquityFiling {
	const r = decode("equity_report_filing", filingRowSchema, row);
	return {
		filingId: r.filing_id,
		companyId: r.company_id,
		provider: r.provider,
		sourceDocumentId: r.source_document_id,
		form: r.form,
		filedOn: r.filed_on,
		submittedAt: r.submitted_at,
		periodStart: r.period_start,
		periodEnd: r.period_end,
		accountingStandard: r.accounting_standard,
		amendsSourceDocumentId: r.amends_source_document_id,
		sourceUrl: r.source_url,
		factsStatus: r.facts_status,
		factCount: r.fact_count,
		primaryScope: r.primary_scope,
	};
}

function toFact(row: unknown): StoredEquityFact {
	const r = decode("equity_reported_fact", factRowSchema, row);
	return {
		filingId: r.filing_id,
		concept: r.concept,
		scope: r.scope,
		periodType: r.period_type,
		periodStart: r.period_type === "instant" ? null : r.period_start,
		periodEnd: r.period_end,
		unit: r.unit,
		fiscalYear: r.fiscal_year,
		metricCode: r.metric_code,
		valueDecimal: r.value_decimal,
		filedOn: r.filing_filed_on,
		accountingStandard: r.filing_accounting_standard,
		primaryScope: r.filing_primary_scope,
	};
}

function toValue(row: unknown): StoredEquityMetricValue {
	const r = decode("equity_metric_value", valueRowSchema, row);
	return {
		metricCode: r.metric_code,
		fiscalYear: r.fiscal_year,
		valueDecimal: r.value_decimal,
		currency: r.currency,
		unavailableReason: r.unavailable_reason,
		filingId: r.filing_id,
		concept: r.concept,
		scope: r.scope,
		periodStart: r.period_start,
		periodEnd: r.period_end,
		derived: r.derived !== 0,
		reportedValueCount: r.reported_value_count,
		updatedAt: r.updated_at,
	};
}

/** The filing of a joined row (`JOINED_FILING_COLUMNS`), or null when the join found none. */
const joinedFilingSchema = z.object({ filing_filing_id: nullableText });

function joinedFiling(row: unknown): StoredEquityFiling | null {
	const probe = decode("equity_report_filing", joinedFilingSchema, row);
	if (probe.filing_filing_id === null) return null;
	const record = decode("equity_report_filing", z.record(z.string(), z.unknown()), row);
	const unprefixed: Record<string, unknown> = {};
	for (const column of FILING_COLUMN_NAMES) unprefixed[column] = record[`filing_${column}`];
	return toFiling(unprefixed);
}

/* ---------- Completion statements ---------- */

/**
 * The `next_due_at` a job's end writes (`EquityJobSchedule`): its own time,
 * unless the stored value is no longer the one the scheduler held the
 * company at while the job ran — then the owner pressed "Sync now" (or
 * re-tracked) meanwhile, and the earlier of the two is kept. Binds one
 * value, the held time.
 */
const NEXT_DUE_AT_OF_JOB_END = `CASE
		WHEN equity_sync_state.next_due_at IS ? THEN excluded.next_due_at
		ELSE min(coalesce(equity_sync_state.next_due_at, excluded.next_due_at), excluded.next_due_at)
	END`;

function metricValueTuple(row: EquityMetricValueContent): SqlValue[] {
	return [
		row.metricCode,
		row.fiscalYear,
		row.valueDecimal,
		row.currency,
		row.unavailableReason,
		row.filingId,
		row.concept,
		row.scope,
		row.periodStart,
		row.periodEnd,
		row.derived ? 1 : 0,
		row.reportedValueCount,
	];
}

/**
 * The statements of a `financial-sync` job's end, every one guarded on
 * `guard` (the job compare-and-set of the same batch). A sync that brought
 * nothing new produces only the sync-state upsert.
 */
export function equitySyncStatements(
	db: SqlDatabase,
	ownerId: string,
	effects: EquitySyncEffects,
	guard: EquityGuard,
): SqlStatement[] {
	const g = guard.sql;
	const gv = guard.values;
	if (effects.kind === "failed") {
		return [
			db
				.prepare(
					`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, last_checked_at,
						failure_code, failure_upstream_status, failure_at, consecutive_failures)
					SELECT ?, ?, ?, ?, ?, ?, ?, ?
					WHERE ${g}
						AND EXISTS (
							SELECT 1
							FROM equity_company AS eco
							WHERE eco.owner_id = ? AND eco.company_id = ?
						)
					ON CONFLICT (owner_id, company_id) DO UPDATE SET
						next_due_at = ${NEXT_DUE_AT_OF_JOB_END},
						last_checked_at = excluded.last_checked_at,
						failure_code = excluded.failure_code,
						failure_upstream_status = excluded.failure_upstream_status,
						failure_at = excluded.failure_at, consecutive_failures = excluded.consecutive_failures`,
				)
				.bind(
					ownerId,
					effects.companyId,
					effects.nextDueAt,
					effects.at,
					effects.failureCode,
					effects.failureUpstreamStatus,
					effects.at,
					effects.consecutiveFailures,
					...gv,
					ownerId,
					effects.companyId,
					effects.schedule.heldNextDueAt,
				),
		];
	}
	const companyId = effects.companyId;
	const statements: SqlStatement[] = [];
	const identity = effects.identity;
	if (identity !== null) {
		// A resolved identity is never rewritten; the name and year end follow
		// the source. The row is touched only when something differs.
		statements.push(
			db
				.prepare(
					`UPDATE equity_company SET
						source_company_id = coalesce(equity_company.source_company_id, identity.source_id),
						name = coalesce(identity.name, equity_company.name),
						fiscal_year_end = coalesce(identity.fiscal_year_end, equity_company.fiscal_year_end)
					FROM (SELECT ? AS source_id, ? AS name, ? AS fiscal_year_end) AS identity
					WHERE equity_company.owner_id = ? AND equity_company.company_id = ?
						AND (equity_company.source_company_id IS NULL
							OR equity_company.source_company_id = identity.source_id)
						AND (equity_company.source_company_id IS NOT identity.source_id
							OR equity_company.name IS NOT coalesce(identity.name, equity_company.name)
							OR equity_company.fiscal_year_end
								IS NOT coalesce(identity.fiscal_year_end, equity_company.fiscal_year_end))
						AND ${g}`,
				)
				.bind(
					identity.sourceCompanyId,
					identity.name,
					identity.fiscalYearEnd,
					ownerId,
					companyId,
					...gv,
				),
		);
	}
	if (effects.newFilings.length > 0) {
		const tuples = effects.newFilings.map((filing): SqlValue[] => [
			filing.filingId,
			filing.provider,
			filing.sourceDocumentId,
			filing.form,
			filing.filedOn,
			filing.submittedAt,
			filing.periodStart,
			filing.periodEnd,
			filing.accountingStandard,
			filing.amendsSourceDocumentId,
			filing.sourceUrl,
			filing.factsStatus,
			filing.factCount,
			filing.primaryScope,
			filing.firstSeenAt,
			filing.recordedAt,
		]);
		for (const chunk of chunkEquityRows(tuples)) {
			statements.push(
				db
					.prepare(
						`INSERT INTO equity_report_filing (owner_id, company_id, filing_id, provider,
							source_document_id, form, filed_on, submitted_at, period_start, period_end,
							accounting_standard, amends_source_document_id, source_url, facts_status,
							fact_count, primary_scope, first_seen_at, recorded_at)
						SELECT ?, ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
							json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
							json_extract(incoming.value, '$[4]'), json_extract(incoming.value, '$[5]'),
							json_extract(incoming.value, '$[6]'), json_extract(incoming.value, '$[7]'),
							json_extract(incoming.value, '$[8]'), json_extract(incoming.value, '$[9]'),
							json_extract(incoming.value, '$[10]'), json_extract(incoming.value, '$[11]'),
							json_extract(incoming.value, '$[12]'), json_extract(incoming.value, '$[13]'),
							json_extract(incoming.value, '$[14]'), json_extract(incoming.value, '$[15]')
						FROM json_each(?) AS incoming
						WHERE ${g}
						ON CONFLICT DO NOTHING`,
					)
					.bind(ownerId, companyId, chunk, ...gv),
			);
		}
	}
	if (effects.finalizedFilings.length > 0) {
		const tuples = effects.finalizedFilings.map((filing): SqlValue[] => [
			filing.filingId,
			filing.factsStatus,
			filing.factCount,
			filing.accountingStandard,
			filing.primaryScope,
		]);
		for (const chunk of chunkEquityRows(tuples)) {
			statements.push(
				db
					.prepare(
						`UPDATE equity_report_filing SET
							facts_status = finalized.facts_status, fact_count = finalized.fact_count,
							primary_scope = finalized.primary_scope, recorded_at = ?,
							accounting_standard = coalesce(equity_report_filing.accounting_standard, finalized.standard)
						FROM (SELECT json_extract(incoming.value, '$[0]') AS filing_id,
								json_extract(incoming.value, '$[1]') AS facts_status,
								json_extract(incoming.value, '$[2]') AS fact_count,
								json_extract(incoming.value, '$[3]') AS standard,
								json_extract(incoming.value, '$[4]') AS primary_scope
							FROM json_each(?) AS incoming) AS finalized
						WHERE equity_report_filing.owner_id = ? AND equity_report_filing.company_id = ?
							AND equity_report_filing.filing_id = finalized.filing_id
							AND equity_report_filing.facts_status = 'pending'
							AND ${g}`,
					)
					.bind(effects.at, chunk, ownerId, companyId, ...gv),
			);
		}
	}
	if (effects.facts.length > 0) {
		const tuples = effects.facts.map((fact): SqlValue[] => [
			fact.filingId,
			fact.concept,
			fact.scope,
			fact.periodType,
			fact.periodStart ?? "",
			fact.periodEnd,
			fact.unit,
			fact.fiscalYear,
			fact.metricCode,
			fact.valueDecimal,
		]);
		for (const chunk of chunkEquityRows(tuples)) {
			statements.push(
				db
					.prepare(
						`INSERT INTO equity_reported_fact (owner_id, company_id, filing_id, concept, scope,
							period_type, period_start, period_end, unit, fiscal_year, metric_code, value_decimal,
							recorded_at)
						SELECT ?, ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
							json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
							json_extract(incoming.value, '$[4]'), json_extract(incoming.value, '$[5]'),
							json_extract(incoming.value, '$[6]'), json_extract(incoming.value, '$[7]'),
							json_extract(incoming.value, '$[8]'), json_extract(incoming.value, '$[9]'), ?
						FROM json_each(?) AS incoming
						WHERE ${g}
						ON CONFLICT DO NOTHING`,
					)
					.bind(ownerId, companyId, effects.at, chunk, ...gv),
			);
		}
	}
	if (effects.metricValues.length > 0) {
		for (const chunk of chunkEquityRows(effects.metricValues.map(metricValueTuple))) {
			statements.push(
				db
					.prepare(
						`INSERT INTO equity_metric_value (owner_id, company_id, metric_code, fiscal_year,
							value_decimal, currency, unavailable_reason, filing_id, concept, scope,
							period_start, period_end, derived, reported_value_count, updated_at)
						SELECT ?, ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
							json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
							json_extract(incoming.value, '$[4]'), json_extract(incoming.value, '$[5]'),
							json_extract(incoming.value, '$[6]'), json_extract(incoming.value, '$[7]'),
							json_extract(incoming.value, '$[8]'), json_extract(incoming.value, '$[9]'),
							json_extract(incoming.value, '$[10]'), json_extract(incoming.value, '$[11]'), ?
						FROM json_each(?) AS incoming
						WHERE ${g}
						ON CONFLICT (owner_id, company_id, fiscal_year, metric_code) DO UPDATE SET
							value_decimal = excluded.value_decimal, currency = excluded.currency,
							unavailable_reason = excluded.unavailable_reason, filing_id = excluded.filing_id,
							concept = excluded.concept, scope = excluded.scope,
							period_start = excluded.period_start, period_end = excluded.period_end,
							derived = excluded.derived, reported_value_count = excluded.reported_value_count,
							updated_at = excluded.updated_at
						WHERE equity_metric_value.value_decimal IS NOT excluded.value_decimal
							OR equity_metric_value.currency IS NOT excluded.currency
							OR equity_metric_value.unavailable_reason IS NOT excluded.unavailable_reason
							OR equity_metric_value.filing_id IS NOT excluded.filing_id
							OR equity_metric_value.concept IS NOT excluded.concept
							OR equity_metric_value.scope IS NOT excluded.scope
							OR equity_metric_value.period_start IS NOT excluded.period_start
							OR equity_metric_value.period_end IS NOT excluded.period_end
							OR equity_metric_value.derived IS NOT excluded.derived
							OR equity_metric_value.reported_value_count IS NOT excluded.reported_value_count`,
					)
					.bind(ownerId, companyId, effects.at, chunk, ...gv),
			);
		}
	}
	if (effects.scannedDays.length > 0) {
		statements.push(
			db
				.prepare(
					`INSERT INTO equity_edinet_scanned_day (owner_id, company_id, scanned_on)
					SELECT ?, ?, scanned_days.value
					FROM json_each(?) AS scanned_days
					WHERE ${g}
					ON CONFLICT DO NOTHING`,
				)
				.bind(ownerId, companyId, JSON.stringify(effects.scannedDays), ...gv),
		);
	}
	const state = effects.state;
	statements.push(
		db
			.prepare(
				`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, last_checked_at,
					last_succeeded_at, consecutive_failures, more_pending, edinet_phase, data_updated_at)
				SELECT ?, ?, ?, ?, ?, 0, ?, ?, ?
				WHERE ${g}
				ON CONFLICT (owner_id, company_id) DO UPDATE SET
					next_due_at = ${NEXT_DUE_AT_OF_JOB_END},
					last_checked_at = excluded.last_checked_at,
					last_succeeded_at = excluded.last_succeeded_at, failure_code = NULL,
					failure_upstream_status = NULL, failure_at = NULL, consecutive_failures = 0,
					more_pending = excluded.more_pending, edinet_phase = excluded.edinet_phase,
					data_updated_at = coalesce(excluded.data_updated_at, equity_sync_state.data_updated_at)`,
			)
			.bind(
				ownerId,
				companyId,
				state.nextDueAt,
				state.checkedAt,
				state.checkedAt,
				state.morePending ? 1 : 0,
				state.edinetPhase,
				state.dataUpdatedAt,
				...gv,
				effects.schedule.heldNextDueAt,
			),
	);
	return statements;
}

/* ---------- Repository ---------- */

const probeRowSchema = z.object({
	seeded: z.number(),
	active: z.number(),
	due: nullableText,
});

const yearRowSchema = z.object({ fiscal_year: z.number() });
const dayRowSchema = z.object({ scanned_on: text });
const countsSchema = z.object({
	latest_fiscal_year: z.number().nullable(),
	filing_count: z.number(),
});

/** Rows of `(metric, fiscal year)` keys, bound as one JSON array. */
function keysJson(keys: readonly (readonly [string, number])[]): string {
	return JSON.stringify(keys);
}

/** The listing lookup of `track` and `findByListing` (the `uq_equity_company__owner_id_market_symbol` seek). */
const BY_LISTING = "eco.owner_id = ? AND eco.market = ? AND eco.symbol = ?";

export function createEquitySyncRepository(db: SqlDatabase): EquitySyncRepository {
	async function companyWithState(
		ownerId: string,
		companyId: string,
	): Promise<{ company: EquityCompanyRecord; state: EquitySyncStateRecord } | null> {
		const row = await db
			.prepare(
				`SELECT ${COMPANY_COLUMNS}, ${STATE_COLUMNS}
				FROM equity_company AS eco
				LEFT JOIN equity_sync_state AS ess
					ON ess.owner_id = eco.owner_id AND ess.company_id = eco.company_id
				WHERE eco.owner_id = ? AND eco.company_id = ?`,
			)
			.bind(ownerId, companyId)
			.first();
		return row === null ? null : { company: toCompany(row), state: toState(row) };
	}

	/**
	 * A company's filings newest first (filing date, then id), at most
	 * `limit` (-1: all): idx_equity_report_filing__owner_id_company_id_filed_on_filing_id
	 * scanned backwards, no temporary sort.
	 */
	async function filingsNewestFirst(
		ownerId: string,
		companyId: string,
		limit: number,
	): Promise<StoredEquityFiling[]> {
		const { results } = await db
			.prepare(
				`SELECT ${FILING_COLUMNS}
				FROM equity_report_filing
				WHERE owner_id = ? AND company_id = ?
				ORDER BY filed_on DESC, filing_id DESC
				LIMIT ?`,
			)
			.bind(ownerId, companyId, limit)
			.all();
		return results.map(toFiling);
	}

	/** One company by a predicate over `eco` (the caller's fixed SQL, values bound). */
	async function companyBy(sql: string, values: readonly SqlValue[]) {
		const row = await db
			.prepare(`SELECT ${COMPANY_COLUMNS} FROM equity_company AS eco WHERE ${sql}`)
			.bind(...values)
			.first();
		return row === null ? null : toCompany(row);
	}

	return {
		async probe(ownerId, nowIso) {
			// The due company comes off idx_equity_sync_state__owner_id_next_due_at
			// in (next_due_at, company_id) order; untracked companies are skipped.
			const row = await db
				.prepare(
					`SELECT
						EXISTS (SELECT 1 FROM equity_sync_meta AS esm WHERE esm.owner_id = ?1) AS seeded,
						EXISTS (
							SELECT 1
							FROM research_jobs AS rj
							WHERE rj.owner_id = ?1
								AND rj.kind = 'financial-sync'
								AND rj.state NOT IN (${TERMINAL_SQL})
						) AS active,
						(
							SELECT ess.company_id
							FROM equity_sync_state AS ess
							JOIN equity_company AS eco
								ON eco.owner_id = ess.owner_id AND eco.company_id = ess.company_id
							WHERE ess.owner_id = ?1
								AND ess.next_due_at IS NOT NULL
								AND ess.next_due_at <= ?2
								AND eco.tracked = 1
							ORDER BY ess.next_due_at, ess.company_id
							LIMIT 1
						) AS due`,
				)
				.bind(ownerId, nowIso)
				.first();
			const r = decode("equity_sync_state", probeRowSchema, row);
			return { seeded: r.seeded === 1, activeJob: r.active === 1, dueCompanyId: r.due };
		},

		async seedDefaults(ownerId, companies, at) {
			// The meta row is the once-per-owner marker: the companies go in
			// only in the batch that wrote it (its timestamp is the guard).
			const marker = `EXISTS (
				SELECT 1
				FROM equity_sync_meta AS esm
				WHERE esm.owner_id = ? AND esm.defaults_added_at = ?
			)`;
			const rows = JSON.stringify(
				companies.map((company) => [
					company.companyId,
					company.market,
					company.symbol,
					company.provider,
					company.name,
				]),
			);
			await db.batch([
				db
					.prepare(
						"INSERT INTO equity_sync_meta (owner_id, defaults_added_at) VALUES (?, ?) ON CONFLICT DO NOTHING",
					)
					.bind(ownerId, at),
				db
					.prepare(
						`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name,
							tracked, tracked_at)
						SELECT ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
							json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
							json_extract(incoming.value, '$[4]'), 1, ?
						FROM json_each(?) AS incoming
						WHERE ${marker}
						ON CONFLICT DO NOTHING`,
					)
					.bind(ownerId, at, rows, ownerId, at),
				db
					.prepare(
						`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
						SELECT eco.owner_id, eco.company_id, ?
						FROM equity_company AS eco
						WHERE eco.owner_id = ?
							AND eco.company_id IN (
								SELECT json_extract(incoming.value, '$[0]')
								FROM json_each(?) AS incoming
							)
							AND ${marker}
						ON CONFLICT DO NOTHING`,
					)
					.bind(at, ownerId, rows, ownerId, at),
			]);
		},

		async track(ownerId, company, maxTracked, at) {
			const existing = await companyBy(BY_LISTING, [ownerId, company.market, company.symbol]);
			if (existing?.tracked === true) {
				return { kind: "already-tracked", companyId: existing.companyId };
			}
			const underCap = `(
				SELECT count(*)
				FROM equity_company AS eco_tracked
				WHERE eco_tracked.owner_id = ? AND eco_tracked.tracked = 1
			) < ?`;
			const companyId = existing?.companyId ?? company.companyId;
			const write =
				existing === null
					? db
							.prepare(
								`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name,
									tracked, tracked_at)
								SELECT ?, ?, ?, ?, ?, ?, 1, ?
								WHERE ${underCap}
								ON CONFLICT DO NOTHING`,
							)
							.bind(
								ownerId,
								company.companyId,
								company.market,
								company.symbol,
								company.provider,
								company.name,
								at,
								ownerId,
								maxTracked,
							)
					: db
							.prepare(
								`UPDATE equity_company SET tracked = 1, tracked_at = ?
								WHERE equity_company.owner_id = ?
									AND equity_company.company_id = ?
									AND equity_company.tracked = 0
									AND ${underCap}`,
							)
							.bind(at, ownerId, companyId, ownerId, maxTracked);
			const results = await db.batch([
				write,
				// Due now: a tracked (or re-tracked) company syncs at the next claim.
				db
					.prepare(
						`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
						SELECT ?, ?, ?
						WHERE EXISTS (
							SELECT 1
							FROM equity_company AS eco
							WHERE eco.owner_id = ? AND eco.company_id = ? AND eco.tracked = 1
								AND eco.tracked_at = ?
						)
						ON CONFLICT (owner_id, company_id) DO UPDATE SET next_due_at = excluded.next_due_at`,
					)
					.bind(ownerId, companyId, at, ownerId, companyId, at),
			]);
			if (results[0]?.meta.changes === 1) {
				return existing === null ? { kind: "inserted" } : { kind: "retracked", companyId };
			}
			// Nothing written: the cap, or a concurrent track of the same listing.
			const now = await companyBy(BY_LISTING, [ownerId, company.market, company.symbol]);
			return now?.tracked === true
				? { kind: "already-tracked", companyId: now.companyId }
				: { kind: "limit-reached" };
		},

		async untrack(ownerId, companyId) {
			// `tracked = 1` makes a repeat a no-op the caller can tell apart
			// (no second audit row); only then is existence looked up.
			const result = await db
				.prepare(
					"UPDATE equity_company SET tracked = 0 WHERE owner_id = ? AND company_id = ? AND tracked = 1",
				)
				.bind(ownerId, companyId)
				.run();
			if (result.meta.changes === 1) return "untracked";
			const existing = await companyBy("eco.owner_id = ? AND eco.company_id = ?", [
				ownerId,
				companyId,
			]);
			return existing === null ? "not-found" : "already-untracked";
		},

		async requestSync(ownerId, companyId, at) {
			const result = await db
				.prepare(
					`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
					SELECT ?, ?, ?
					WHERE EXISTS (
						SELECT 1
						FROM equity_company AS eco
						WHERE eco.owner_id = ? AND eco.company_id = ? AND eco.tracked = 1
					)
					ON CONFLICT (owner_id, company_id) DO UPDATE SET next_due_at = excluded.next_due_at`,
				)
				.bind(ownerId, companyId, at, ownerId, companyId)
				.run();
			return result.meta.changes === 1;
		},

		async reschedule(ownerId, companyId, patch) {
			await db
				.prepare(
					`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at, edinet_phase)
					SELECT ?, ?, ?, ?
					WHERE EXISTS (
						SELECT 1
						FROM equity_company AS eco
						WHERE eco.owner_id = ? AND eco.company_id = ?
					)
					ON CONFLICT (owner_id, company_id) DO UPDATE SET
						next_due_at = excluded.next_due_at, edinet_phase = excluded.edinet_phase`,
				)
				.bind(ownerId, companyId, patch.nextDueAt, patch.edinetPhase, ownerId, companyId)
				.run();
		},

		async listSummaries(ownerId, filter) {
			// One statement for the whole list: the two aggregates are
			// correlated sub-queries over the company's key ranges (no N+1).
			// The latest year is a backward walk of the equity_metric_value key
			// (owner, company, fiscal_year, metric) that stops at the first
			// stored value; the filing count is a range of the filing index.
			const { results } = await db
				.prepare(
					`SELECT
						${COMPANY_COLUMNS},
						${STATE_COLUMNS},
						(
							SELECT max(emv.fiscal_year)
							FROM equity_metric_value AS emv
							WHERE emv.owner_id = eco.owner_id
								AND emv.company_id = eco.company_id
								AND emv.value_decimal IS NOT NULL
						) AS latest_fiscal_year,
						(
							SELECT count(*)
							FROM equity_report_filing AS erf
							WHERE erf.owner_id = eco.owner_id AND erf.company_id = eco.company_id
						) AS filing_count
					FROM equity_company AS eco
					LEFT JOIN equity_sync_state AS ess
						ON ess.owner_id = eco.owner_id AND ess.company_id = eco.company_id
					WHERE eco.owner_id = ?1
						AND ((?2 IS NULL AND eco.tracked = 1) OR eco.company_id = ?2)
					ORDER BY eco.tracked_at, eco.market DESC, eco.symbol
					LIMIT 200`,
				)
				.bind(ownerId, filter.companyId)
				.all();
			return results.map((row): EquityCompanySummary => {
				const counts = decode("equity_company", countsSchema, row);
				return {
					company: toCompany(row),
					state: toState(row),
					latestFiscalYear: counts.latest_fiscal_year,
					filingCount: counts.filing_count,
				};
			});
		},

		findByListing: (ownerId, market, symbol) => companyBy(BY_LISTING, [ownerId, market, symbol]),

		findBySourceId: (ownerId, provider, sourceCompanyId) =>
			companyBy("eco.owner_id = ? AND eco.provider = ? AND eco.source_company_id = ?", [
				ownerId,
				provider,
				sourceCompanyId,
			]),

		async claimContext(ownerId, companyId): Promise<EquityClaimContext | null> {
			const found = await companyWithState(ownerId, companyId);
			if (found === null) return null;
			const [filings, days] = await Promise.all([
				filingsNewestFirst(ownerId, companyId, -1),
				found.company.provider === "edinet"
					? db
							.prepare(
								`SELECT scanned_on
								FROM equity_edinet_scanned_day
								WHERE owner_id = ? AND company_id = ?
								ORDER BY scanned_on`,
							)
							.bind(ownerId, companyId)
							.all()
					: Promise.resolve({ results: [] }),
			]);
			return {
				...found,
				filings,
				scannedDays: days.results.map(
					(row) => decode("equity_edinet_scanned_day", dayRowSchema, row).scanned_on,
				),
			};
		},

		listFilings: (ownerId, companyId, limit) => filingsNewestFirst(ownerId, companyId, limit),

		async factsOfKeys(ownerId, companyId, keys) {
			if (keys.length === 0) return [];
			// Driven from the keys: one seek per key in
			// idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal.
			// CROSS JOIN fixes that loop order (SQLite never reorders it): with a
			// plain JOIN the planner, which has no statistics, put the keys
			// innermost and read every fact of the company once per key
			// (33 ms instead of 0.13 ms at 9,000 facts a company).
			const { results } = await db
				.prepare(
					`SELECT
						${FACT_COLUMNS},
						erf.filed_on AS filing_filed_on,
						erf.accounting_standard AS filing_accounting_standard,
						erf.primary_scope AS filing_primary_scope
					FROM json_each(?) AS touched_keys
					CROSS JOIN equity_reported_fact AS erp
						ON erp.owner_id = ?
						AND erp.company_id = ?
						AND erp.metric_code = json_extract(touched_keys.value, '$[0]')
						AND erp.fiscal_year = json_extract(touched_keys.value, '$[1]')
					JOIN equity_report_filing AS erf
						ON erf.owner_id = erp.owner_id AND erf.filing_id = erp.filing_id`,
				)
				.bind(keysJson(keys), ownerId, companyId)
				.all();
			return results.map(toFact);
		},

		async valuesOfYears(ownerId, companyId, fiscalYears) {
			if (fiscalYears.length === 0) return [];
			// One key range per year (the key is owner, company, fiscal_year, metric).
			const { results } = await db
				.prepare(
					`SELECT ${VALUE_COLUMN_NAMES.join(", ")}
					FROM equity_metric_value
					WHERE owner_id = ? AND company_id = ?
						AND fiscal_year IN (SELECT years.value FROM json_each(?) AS years)`,
				)
				.bind(ownerId, companyId, JSON.stringify(fiscalYears))
				.all();
			return results.map(toValue);
		},

		async valueYears(ownerId, companyId, limit) {
			// The key walked backwards: stops after `limit` distinct years, no
			// temporary sort. A year counts when it has a value or a reason
			// other than `not-reported` (`no-mapping-for-standard`,
			// `ambiguous`, ...): an IFRS filer's years are listed with their
			// reasons instead of answering like a company never synced.
			const { results } = await db
				.prepare(
					`SELECT DISTINCT fiscal_year
					FROM equity_metric_value
					WHERE owner_id = ? AND company_id = ?
						AND (value_decimal IS NOT NULL OR unavailable_reason <> 'not-reported')
					ORDER BY fiscal_year DESC
					LIMIT ?`,
				)
				.bind(ownerId, companyId, limit)
				.all();
			return results.map((row) => decode("equity_metric_value", yearRowSchema, row).fiscal_year);
		},

		async valuesWithFilings(ownerId, companyId, metrics, fiscalYears) {
			if (metrics.length === 0 || fiscalYears.length === 0) return [];
			// One key seek per (year, metric); the filing by its primary key.
			const { results } = await db
				.prepare(
					`SELECT ${qualifiedColumns("emv", VALUE_COLUMN_NAMES)}, ${JOINED_FILING_COLUMNS}
					FROM equity_metric_value AS emv
					LEFT JOIN equity_report_filing AS erf
						ON erf.owner_id = emv.owner_id AND erf.filing_id = emv.filing_id
					WHERE emv.owner_id = ? AND emv.company_id = ?
						AND emv.fiscal_year IN (SELECT years.value FROM json_each(?) AS years)
						AND emv.metric_code IN (SELECT metrics.value FROM json_each(?) AS metrics)`,
				)
				.bind(ownerId, companyId, JSON.stringify(fiscalYears), JSON.stringify(metrics))
				.all();
			return results.map(
				(row): EquityMetricValueWithFiling => ({ value: toValue(row), filing: joinedFiling(row) }),
			);
		},

		async revisions(ownerId, companyId, metric, fiscalYear, limit) {
			// One range of the covering
			// idx_equity_reported_fact__owner_id_company_id_metric_code_fiscal_year_value_decimal;
			// the sort is over that metric-year's few facts.
			const { results } = await db
				.prepare(
					`SELECT ${FACT_COLUMNS}, ${JOINED_FILING_COLUMNS}
					FROM equity_reported_fact AS erp
					JOIN equity_report_filing AS erf
						ON erf.owner_id = erp.owner_id AND erf.filing_id = erp.filing_id
					WHERE erp.owner_id = ? AND erp.company_id = ? AND erp.metric_code = ?
						AND erp.fiscal_year = ?
					ORDER BY erf.filed_on DESC, erp.filing_id DESC, erp.scope, erp.concept, erp.period_end
					LIMIT ?`,
				)
				.bind(ownerId, companyId, metric, fiscalYear, limit)
				.all();
			return results.flatMap((row): EquityFactWithFiling[] => {
				const filing = joinedFiling(row);
				return filing === null ? [] : [{ fact: toFact(row), filing }];
			});
		},

		async recordFailure(ownerId, failure) {
			await db.batch(equitySyncStatements(db, ownerId, failure, UNGUARDED));
		},
	};
}
