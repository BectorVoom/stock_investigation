/**
 * The shared EDINET index (ADR-0058 §4, migration 0026): the repository the
 * `edinet-index` plan reads, and the guarded statements an `edinet-indexed`
 * completion commits with its job row (`unitOfWork.commitCompletion`).
 *
 * Write discipline:
 * - days and reports are insert-or-ignore: a listed day is final, and a
 *   report row is EDINET's statement of it, never rewritten;
 * - every tracked Japanese company with an indexed report it has not stored
 *   is made due at once (`next_due_at`, and `sync_requested_at`, so a job of
 *   the company running meanwhile keeps the request — `EquityJobSchedule`);
 * - every statement is guarded on the job compare-and-set of the batch.
 * Bulk rows are bound as JSON arrays read with `json_each`, chunked by bytes
 * (`chunkEquityRows`): a busy June job lists a few thousand reports.
 */
import type { EdinetIndexEffects, EdinetIndexRepository } from "@research/application";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { chunkEquityRows, type EquityGuard } from "./equitySync.ts";
import { decode } from "./rows.ts";

const listedDayRowSchema = z.object({ listed_on: z.string() });

export function createEdinetIndexRepository(db: SqlDatabase): EdinetIndexRepository {
	return {
		async listedDays(ownerId, fromDay) {
			// One primary-key range of the owner's days.
			const { results } = await db
				.prepare(
					`SELECT listed_on
					FROM edinet_index_day
					WHERE owner_id = ? AND listed_on >= ?
					ORDER BY listed_on`,
				)
				.bind(ownerId, fromDay)
				.all();
			return results.map((row) => decode("edinet_index_day", listedDayRowSchema, row).listed_on);
		},
	};
}

/**
 * The statements of an `edinet-indexed` completion, every one guarded on
 * `guard`: the days first (the reports reference them), then the reports,
 * then the due marks, which read the reports' codes from the same JSON.
 */
export function edinetIndexStatements(
	db: SqlDatabase,
	ownerId: string,
	effects: EdinetIndexEffects,
	guard: EquityGuard,
): SqlStatement[] {
	const g = guard.sql;
	const gv = guard.values;
	const statements: SqlStatement[] = [];
	if (effects.days.length > 0) {
		const days = effects.days.map((day): SqlValue[] => [day.listedOn, day.documentCount]);
		for (const chunk of chunkEquityRows(days)) {
			statements.push(
				db
					.prepare(
						`INSERT INTO edinet_index_day (owner_id, listed_on, checked_at, document_count)
						SELECT ?, json_extract(incoming.value, '$[0]'), ?, json_extract(incoming.value, '$[1]')
						FROM json_each(?) AS incoming
						WHERE ${g}
						ON CONFLICT DO NOTHING`,
					)
					.bind(ownerId, effects.checkedAt, chunk, ...gv),
			);
		}
	}
	if (effects.documents.length === 0) return statements;
	const documents = effects.documents.map((document): SqlValue[] => [
		document.docId,
		document.secCode,
		document.edinetCode,
		document.filerName,
		document.docTypeCode,
		document.periodStart,
		document.periodEnd,
		document.submittedAt,
		document.parentDocId,
		document.listedOn,
	]);
	for (const chunk of chunkEquityRows(documents)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO edinet_document_index (owner_id, doc_id, sec_code, edinet_code, filer_name,
						doc_type_code, period_start, period_end, submitted_at, parent_doc_id, listed_on)
					SELECT ?, json_extract(incoming.value, '$[0]'), json_extract(incoming.value, '$[1]'),
						json_extract(incoming.value, '$[2]'), json_extract(incoming.value, '$[3]'),
						json_extract(incoming.value, '$[4]'), json_extract(incoming.value, '$[5]'),
						json_extract(incoming.value, '$[6]'), json_extract(incoming.value, '$[7]'),
						json_extract(incoming.value, '$[8]'), json_extract(incoming.value, '$[9]')
					FROM json_each(?) AS incoming
					WHERE ${g}
					ON CONFLICT DO NOTHING`,
				)
				.bind(ownerId, chunk, ...gv),
		);
	}
	// A Japanese symbol is the securities code without its check "0"
	// (`edinetSecuritiesCode`); the company seek is
	// uq_equity_company__owner_id_market_symbol, the stored-filing test a
	// primary-key seek of equity_report_filing (filing ids are
	// `<companyId>:edinet:<docID>`, `equityFilingId`).
	const found = effects.documents.map((document): SqlValue[] => [document.secCode, document.docId]);
	for (const chunk of chunkEquityRows(found)) {
		statements.push(
			db
				.prepare(
					`UPDATE equity_sync_state SET next_due_at = ?, sync_requested_at = ?
					WHERE owner_id = ?
						AND (next_due_at IS NULL OR next_due_at > ?)
						AND company_id IN (
							SELECT eco.company_id
							FROM json_each(?) AS found_reports
							CROSS JOIN equity_company AS eco
								ON eco.owner_id = ?
								AND eco.market = 'JP'
								AND eco.symbol = substr(json_extract(found_reports.value, '$[0]'), 1, 4)
							WHERE eco.tracked = 1
								AND NOT EXISTS (
									SELECT 1
									FROM equity_report_filing AS erf
									WHERE erf.owner_id = eco.owner_id
										AND erf.filing_id = eco.company_id || ':edinet:'
											|| json_extract(found_reports.value, '$[1]')
								)
						)
						AND ${g}`,
				)
				.bind(effects.at, effects.at, ownerId, effects.at, chunk, ownerId, ...gv),
		);
	}
	return statements;
}
