/**
 * Annual financial statements synced from SEC and EDINET (ADR-0045 §2):
 * the repository over migration 0020 and the guarded statements a
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

/** The sync-state columns of a joined row (`s_` prefix; all null when no state row exists). */
const stateRowSchema = z.object({
	s_next_due_at: nullableText,
	s_last_checked_at: nullableText,
	s_last_succeeded_at: nullableText,
	s_failure_code: nullableText,
	s_failure_upstream_status: storedUpstreamStatus,
	s_failure_at: nullableText,
	s_consecutive_failures: z.number().nullable(),
	s_more_pending: z.number().nullable(),
	s_edinet_phase: phaseSchema.nullable(),
	s_data_updated_at: nullableText,
});

const STATE_COLUMNS = `s.next_due_at AS s_next_due_at, s.last_checked_at AS s_last_checked_at,
	s.last_succeeded_at AS s_last_succeeded_at, s.failure_code AS s_failure_code,
	s.failure_upstream_status AS s_failure_upstream_status, s.failure_at AS s_failure_at,
	s.consecutive_failures AS s_consecutive_failures, s.more_pending AS s_more_pending,
	s.edinet_phase AS s_edinet_phase, s.data_updated_at AS s_data_updated_at`;

const COMPANY_COLUMNS = `c.company_id, c.market, c.symbol, c.provider, c.source_company_id, c.name,
	c.fiscal_year_end, c.tracked, c.tracked_at`;

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
});

const FILING_COLUMNS = `r.filing_id, r.company_id, r.provider, r.source_document_id, r.form, r.filed_on,
	r.submitted_at, r.period_start, r.period_end, r.accounting_standard, r.amends_source_document_id,
	r.source_url, r.facts_status, r.fact_count`;

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
	f_filed_on: text,
	f_accounting_standard: equityAccountingStandardSchema.nullable(),
});

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

const VALUE_COLUMNS = `v.metric_code, v.fiscal_year, v.value_decimal, v.currency, v.unavailable_reason,
	v.filing_id, v.concept, v.scope, v.period_start, v.period_end, v.derived,
	v.reported_value_count, v.updated_at`;

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
	if (r.s_consecutive_failures === null) return EMPTY_EQUITY_SYNC_STATE;
	return {
		nextDueAt: r.s_next_due_at,
		lastCheckedAt: r.s_last_checked_at,
		lastSucceededAt: r.s_last_succeeded_at,
		failureCode: r.s_failure_code,
		failureUpstreamStatus: r.s_failure_code === null ? null : r.s_failure_upstream_status,
		failureAt: r.s_failure_at,
		consecutiveFailures: r.s_consecutive_failures,
		morePending: r.s_more_pending === 1,
		edinetPhase: r.s_edinet_phase,
		dataUpdatedAt: r.s_data_updated_at,
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
		filedOn: r.f_filed_on,
		accountingStandard: r.f_accounting_standard,
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

/** The filing columns of a joined row, aliased `r_…`, or null when the join found none. */
const joinedFilingSchema = z.object({ r_filing_id: nullableText });

function joinedFiling(row: unknown): StoredEquityFiling | null {
	const probe = decode("equity_report_filing", joinedFilingSchema, row);
	if (probe.r_filing_id === null) return null;
	const record = decode("equity_report_filing", z.record(z.string(), z.unknown()), row);
	const unprefixed: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (key.startsWith("r_")) unprefixed[key.slice(2)] = value;
	}
	return toFiling(unprefixed);
}

const JOINED_FILING_COLUMNS = FILING_COLUMNS.split(",")
	.map((column) => column.trim())
	.map((column) => `${column} AS r_${column.slice(2)}`)
	.join(", ");

/* ---------- Completion statements ---------- */

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
					SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${g}
						AND EXISTS (SELECT 1 FROM equity_company WHERE owner_id = ? AND company_id = ?)
					ON CONFLICT (owner_id, company_id) DO UPDATE SET
						next_due_at = excluded.next_due_at, last_checked_at = excluded.last_checked_at,
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
						source_company_id = COALESCE(equity_company.source_company_id, identity.source_id),
						name = COALESCE(identity.name, equity_company.name),
						fiscal_year_end = COALESCE(identity.fiscal_year_end, equity_company.fiscal_year_end)
					FROM (SELECT ? AS source_id, ? AS name, ? AS fiscal_year_end) AS identity
					WHERE equity_company.owner_id = ? AND equity_company.company_id = ?
						AND (equity_company.source_company_id IS NULL
							OR equity_company.source_company_id = identity.source_id)
						AND (equity_company.source_company_id IS NOT identity.source_id
							OR equity_company.name IS NOT COALESCE(identity.name, equity_company.name)
							OR equity_company.fiscal_year_end
								IS NOT COALESCE(identity.fiscal_year_end, equity_company.fiscal_year_end))
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
							fact_count, first_seen_at, recorded_at)
						SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
							json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
							json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
							json_extract(value, '$[8]'), json_extract(value, '$[9]'), json_extract(value, '$[10]'),
							json_extract(value, '$[11]'), json_extract(value, '$[12]'), json_extract(value, '$[13]'),
							json_extract(value, '$[14]')
						FROM json_each(?) WHERE ${g}
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
		]);
		for (const chunk of chunkEquityRows(tuples)) {
			statements.push(
				db
					.prepare(
						`UPDATE equity_report_filing SET
							facts_status = final.facts_status, fact_count = final.fact_count, recorded_at = ?,
							accounting_standard = COALESCE(equity_report_filing.accounting_standard, final.standard)
						FROM (SELECT json_extract(value, '$[0]') AS filing_id,
								json_extract(value, '$[1]') AS facts_status,
								json_extract(value, '$[2]') AS fact_count,
								json_extract(value, '$[3]') AS standard
							FROM json_each(?)) AS final
						WHERE equity_report_filing.owner_id = ? AND equity_report_filing.company_id = ?
							AND equity_report_filing.filing_id = final.filing_id
							AND equity_report_filing.facts_status = 'pending' AND ${g}`,
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
						SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
							json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
							json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
							json_extract(value, '$[8]'), json_extract(value, '$[9]'), ?
						FROM json_each(?) WHERE ${g}
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
						SELECT ?, ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
							json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
							json_extract(value, '$[5]'), json_extract(value, '$[6]'), json_extract(value, '$[7]'),
							json_extract(value, '$[8]'), json_extract(value, '$[9]'), json_extract(value, '$[10]'),
							json_extract(value, '$[11]'), ?
						FROM json_each(?) WHERE ${g}
						ON CONFLICT (owner_id, company_id, metric_code, fiscal_year) DO UPDATE SET
							value_decimal = excluded.value_decimal, currency = excluded.currency,
							unavailable_reason = excluded.unavailable_reason, filing_id = excluded.filing_id,
							concept = excluded.concept, scope = excluded.scope,
							period_start = excluded.period_start, period_end = excluded.period_end,
							derived = excluded.derived, reported_value_count = excluded.reported_value_count,
							updated_at = excluded.updated_at
						WHERE value_decimal IS NOT excluded.value_decimal OR currency IS NOT excluded.currency
							OR unavailable_reason IS NOT excluded.unavailable_reason
							OR filing_id IS NOT excluded.filing_id OR concept IS NOT excluded.concept
							OR scope IS NOT excluded.scope OR period_start IS NOT excluded.period_start
							OR period_end IS NOT excluded.period_end OR derived IS NOT excluded.derived
							OR reported_value_count IS NOT excluded.reported_value_count`,
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
					SELECT ?, ?, value FROM json_each(?) WHERE ${g}
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
				SELECT ?, ?, ?, ?, ?, 0, ?, ?, ? WHERE ${g}
				ON CONFLICT (owner_id, company_id) DO UPDATE SET
					next_due_at = excluded.next_due_at, last_checked_at = excluded.last_checked_at,
					last_succeeded_at = excluded.last_succeeded_at, failure_code = NULL,
					failure_upstream_status = NULL, failure_at = NULL, consecutive_failures = 0,
					more_pending = excluded.more_pending, edinet_phase = excluded.edinet_phase,
					data_updated_at = COALESCE(excluded.data_updated_at, equity_sync_state.data_updated_at)`,
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

export function createEquitySyncRepository(db: SqlDatabase): EquitySyncRepository {
	async function companyWithState(
		ownerId: string,
		companyId: string,
	): Promise<{ company: EquityCompanyRecord; state: EquitySyncStateRecord } | null> {
		const row = await db
			.prepare(
				`SELECT ${COMPANY_COLUMNS}, ${STATE_COLUMNS}
				FROM equity_company c
				LEFT JOIN equity_sync_state s ON s.owner_id = c.owner_id AND s.company_id = c.company_id
				WHERE c.owner_id = ? AND c.company_id = ?`,
			)
			.bind(ownerId, companyId)
			.first();
		return row === null ? null : { company: toCompany(row), state: toState(row) };
	}

	async function companyBy(sql: string, values: readonly SqlValue[]) {
		const row = await db
			.prepare(`SELECT ${COMPANY_COLUMNS} FROM equity_company c WHERE ${sql}`)
			.bind(...values)
			.first();
		return row === null ? null : toCompany(row);
	}

	return {
		async probe(ownerId, nowIso) {
			const row = await db
				.prepare(
					`SELECT
						EXISTS (SELECT 1 FROM equity_sync_meta WHERE owner_id = ?1) AS seeded,
						EXISTS (SELECT 1 FROM research_jobs WHERE owner_id = ?1 AND kind = 'financial-sync'
							AND state NOT IN (${TERMINAL_SQL})) AS active,
						(SELECT s.company_id FROM equity_sync_state s
							JOIN equity_company c ON c.owner_id = s.owner_id AND c.company_id = s.company_id
							WHERE s.owner_id = ?1 AND s.next_due_at IS NOT NULL AND s.next_due_at <= ?2
								AND c.tracked = 1
							ORDER BY s.next_due_at, s.company_id LIMIT 1) AS due`,
				)
				.bind(ownerId, nowIso)
				.first();
			const r = decode("equity_sync_state", probeRowSchema, row);
			return { seeded: r.seeded === 1, activeJob: r.active === 1, dueCompanyId: r.due };
		},

		async seedDefaults(ownerId, companies, at) {
			// The meta row is the once-per-owner marker: the companies go in
			// only in the batch that wrote it (its timestamp is the guard).
			const marker =
				"EXISTS (SELECT 1 FROM equity_sync_meta WHERE owner_id = ? AND defaults_added_at = ?)";
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
						SELECT ?, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
							json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
							1, ?
						FROM json_each(?) WHERE ${marker}
						ON CONFLICT DO NOTHING`,
					)
					.bind(ownerId, at, rows, ownerId, at),
				db
					.prepare(
						`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
						SELECT c.owner_id, c.company_id, ? FROM equity_company c
						WHERE c.owner_id = ? AND c.company_id IN (SELECT json_extract(value, '$[0]') FROM json_each(?))
							AND ${marker}
						ON CONFLICT DO NOTHING`,
					)
					.bind(at, ownerId, rows, ownerId, at),
			]);
		},

		async track(ownerId, company, maxTracked, at) {
			const existing = await companyBy("c.owner_id = ? AND c.market = ? AND c.symbol = ?", [
				ownerId,
				company.market,
				company.symbol,
			]);
			if (existing?.tracked === true) {
				return { kind: "already-tracked", companyId: existing.companyId };
			}
			const underCap = `(SELECT COUNT(*) FROM equity_company WHERE owner_id = ? AND tracked = 1) < ?`;
			const companyId = existing?.companyId ?? company.companyId;
			const write =
				existing === null
					? db
							.prepare(
								`INSERT INTO equity_company (owner_id, company_id, market, symbol, provider, name,
									tracked, tracked_at)
								SELECT ?, ?, ?, ?, ?, ?, 1, ? WHERE ${underCap}
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
								WHERE owner_id = ? AND company_id = ? AND tracked = 0 AND ${underCap}`,
							)
							.bind(at, ownerId, companyId, ownerId, maxTracked);
			const results = await db.batch([
				write,
				// Due now: a tracked (or re-tracked) company syncs at the next claim.
				db
					.prepare(
						`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
						SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM equity_company
							WHERE owner_id = ? AND company_id = ? AND tracked = 1 AND tracked_at = ?)
						ON CONFLICT (owner_id, company_id) DO UPDATE SET next_due_at = excluded.next_due_at`,
					)
					.bind(ownerId, companyId, at, ownerId, companyId, at),
			]);
			if (results[0]?.meta.changes === 1) {
				return existing === null ? { kind: "inserted" } : { kind: "retracked", companyId };
			}
			// Nothing written: the cap, or a concurrent track of the same listing.
			const now = await companyBy("c.owner_id = ? AND c.market = ? AND c.symbol = ?", [
				ownerId,
				company.market,
				company.symbol,
			]);
			return now?.tracked === true
				? { kind: "already-tracked", companyId: now.companyId }
				: { kind: "limit-reached" };
		},

		async untrack(ownerId, companyId) {
			const result = await db
				.prepare("UPDATE equity_company SET tracked = 0 WHERE owner_id = ? AND company_id = ?")
				.bind(ownerId, companyId)
				.run();
			return result.meta.changes === 1;
		},

		async requestSync(ownerId, companyId, at) {
			const result = await db
				.prepare(
					`INSERT INTO equity_sync_state (owner_id, company_id, next_due_at)
					SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM equity_company
						WHERE owner_id = ? AND company_id = ? AND tracked = 1)
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
					SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM equity_company
						WHERE owner_id = ? AND company_id = ?)
					ON CONFLICT (owner_id, company_id) DO UPDATE SET
						next_due_at = excluded.next_due_at, edinet_phase = excluded.edinet_phase`,
				)
				.bind(ownerId, companyId, patch.nextDueAt, patch.edinetPhase, ownerId, companyId)
				.run();
		},

		async listSummaries(ownerId, filter) {
			// One statement for the whole list: the two aggregates are
			// correlated sub-queries over the company's index ranges (no N+1).
			const { results } = await db
				.prepare(
					`SELECT ${COMPANY_COLUMNS}, ${STATE_COLUMNS},
						(SELECT MAX(v.fiscal_year) FROM equity_metric_value v
							WHERE v.owner_id = c.owner_id AND v.company_id = c.company_id
								AND v.value_decimal IS NOT NULL) AS latest_fiscal_year,
						(SELECT COUNT(*) FROM equity_report_filing r
							WHERE r.owner_id = c.owner_id AND r.company_id = c.company_id) AS filing_count
					FROM equity_company c
					LEFT JOIN equity_sync_state s ON s.owner_id = c.owner_id AND s.company_id = c.company_id
					WHERE c.owner_id = ?1 AND (?2 IS NULL AND c.tracked = 1 OR c.company_id = ?2)
					ORDER BY c.tracked_at, c.market DESC, c.symbol
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

		findByListing: (ownerId, market, symbol) =>
			companyBy("c.owner_id = ? AND c.market = ? AND c.symbol = ?", [ownerId, market, symbol]),

		findBySourceId: (ownerId, provider, sourceCompanyId) =>
			companyBy("c.owner_id = ? AND c.provider = ? AND c.source_company_id = ?", [
				ownerId,
				provider,
				sourceCompanyId,
			]),

		async claimContext(ownerId, companyId): Promise<EquityClaimContext | null> {
			const found = await companyWithState(ownerId, companyId);
			if (found === null) return null;
			const [filings, days] = await Promise.all([
				db
					.prepare(
						`SELECT ${FILING_COLUMNS} FROM equity_report_filing r
						WHERE r.owner_id = ? AND r.company_id = ?
						ORDER BY r.filed_on DESC, r.filing_id DESC`,
					)
					.bind(ownerId, companyId)
					.all(),
				found.company.provider === "edinet"
					? db
							.prepare(
								`SELECT scanned_on FROM equity_edinet_scanned_day
								WHERE owner_id = ? AND company_id = ? ORDER BY scanned_on`,
							)
							.bind(ownerId, companyId)
							.all()
					: Promise.resolve({ results: [] }),
			]);
			return {
				...found,
				filings: filings.results.map(toFiling),
				scannedDays: days.results.map(
					(row) => decode("equity_edinet_scanned_day", dayRowSchema, row).scanned_on,
				),
			};
		},

		async factsOfKeys(ownerId, companyId, keys) {
			if (keys.length === 0) return [];
			// Driven from the keys: one seek per key in equity_reported_fact_by_metric_year.
			const { results } = await db
				.prepare(
					`SELECT f.filing_id, f.concept, f.scope, f.period_type, f.period_start, f.period_end,
						f.unit, f.fiscal_year, f.metric_code, f.value_decimal,
						r.filed_on AS f_filed_on, r.accounting_standard AS f_accounting_standard
					FROM json_each(?) AS k
					JOIN equity_reported_fact f ON f.owner_id = ? AND f.company_id = ?
						AND f.metric_code = json_extract(k.value, '$[0]')
						AND f.fiscal_year = json_extract(k.value, '$[1]')
					JOIN equity_report_filing r ON r.owner_id = f.owner_id AND r.filing_id = f.filing_id`,
				)
				.bind(keysJson(keys), ownerId, companyId)
				.all();
			return results.map(toFact);
		},

		async valuesOfYears(ownerId, companyId, fiscalYears) {
			if (fiscalYears.length === 0) return [];
			const { results } = await db
				.prepare(
					`SELECT ${VALUE_COLUMNS} FROM equity_metric_value v
					WHERE v.owner_id = ? AND v.company_id = ?
						AND v.fiscal_year IN (SELECT value FROM json_each(?))`,
				)
				.bind(ownerId, companyId, JSON.stringify(fiscalYears))
				.all();
			return results.map(toValue);
		},

		async valueYears(ownerId, companyId, limit) {
			const { results } = await db
				.prepare(
					`SELECT DISTINCT fiscal_year FROM equity_metric_value
					WHERE owner_id = ? AND company_id = ? AND value_decimal IS NOT NULL
					ORDER BY fiscal_year DESC LIMIT ?`,
				)
				.bind(ownerId, companyId, limit)
				.all();
			return results.map((row) => decode("equity_metric_value", yearRowSchema, row).fiscal_year);
		},

		async valuesWithFilings(ownerId, companyId, metrics, fiscalYears) {
			if (metrics.length === 0 || fiscalYears.length === 0) return [];
			const { results } = await db
				.prepare(
					`SELECT ${VALUE_COLUMNS}, ${JOINED_FILING_COLUMNS}
					FROM equity_metric_value v
					LEFT JOIN equity_report_filing r ON r.owner_id = v.owner_id AND r.filing_id = v.filing_id
					WHERE v.owner_id = ? AND v.company_id = ?
						AND v.metric_code IN (SELECT value FROM json_each(?))
						AND v.fiscal_year IN (SELECT value FROM json_each(?))`,
				)
				.bind(ownerId, companyId, JSON.stringify(metrics), JSON.stringify(fiscalYears))
				.all();
			return results.map(
				(row): EquityMetricValueWithFiling => ({ value: toValue(row), filing: joinedFiling(row) }),
			);
		},

		async revisions(ownerId, companyId, metric, fiscalYear, limit) {
			const { results } = await db
				.prepare(
					`SELECT f.filing_id, f.concept, f.scope, f.period_type, f.period_start, f.period_end,
						f.unit, f.fiscal_year, f.metric_code, f.value_decimal,
						r.filed_on AS f_filed_on, r.accounting_standard AS f_accounting_standard,
						${JOINED_FILING_COLUMNS}
					FROM equity_reported_fact f
					JOIN equity_report_filing r ON r.owner_id = f.owner_id AND r.filing_id = f.filing_id
					WHERE f.owner_id = ? AND f.company_id = ? AND f.metric_code = ? AND f.fiscal_year = ?
					ORDER BY r.filed_on DESC, f.filing_id DESC, f.scope, f.concept, f.period_end
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
