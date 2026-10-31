import type { EquityRepository } from "@research/application";
import {
	equityFactsResponseSchema,
	equityImportHistorySchema,
	equityImportResultSchema,
	equityImportSchema,
	equityIssuerListSchema,
	equityRecordSchema,
} from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase } from "./database.ts";
import { EQUITY_TABLES } from "./equityTables.ts";
import { bodyOf, decode } from "./rows.ts";

const savedImport = z.object({
	import_id: z.string(),
	committed_at: z.string(),
	record_count: z.number(),
	content_sha256: z.string(),
	commit_sequence: z.number().int().positive(),
});
const cursorRow = z.object({ record_id: z.string() });

export function createEquityRepository(db: SqlDatabase): EquityRepository {
	return {
		async getVersion(ownerId) {
			const row = await db
				.prepare(
					`SELECT coalesce(max(commit_sequence), 0) AS version
					FROM equity_import
					WHERE owner_id = ?`,
				)
				.bind(ownerId)
				.first();
			return decode("equity_import", z.object({ version: z.number().int().nonnegative() }), row)
				.version;
		},
		async findImport(ownerId, key) {
			const row = await db
				.prepare(
					`SELECT import_id, committed_at, record_count, content_sha256, commit_sequence
					FROM equity_import
					WHERE owner_id = ? AND idempotency_key = ?`,
				)
				.bind(ownerId, key)
				.first();
			if (row === null) return null;
			const data = decode("equity_import", savedImport, row);
			return {
				contentSha256: data.content_sha256,
				result: equityImportResultSchema.parse({
					importId: data.import_id,
					committedAt: data.committed_at,
					commitSequence: data.commit_sequence,
					recordCount: data.record_count,
					replayed: false,
				}),
			};
		},
		async commit(ownerId, write) {
			const serialized = JSON.stringify(write.records);
			const guard =
				"EXISTS (SELECT 1 FROM equity_import AS eim WHERE eim.owner_id = ? AND eim.import_id = ?)";
			const statements = [
				db
					.prepare(
						`WITH incoming AS (
							SELECT
								json_extract(record_item.value, '$.recordId') AS record_id,
								json_extract(record_item.value, '$.recordType') AS record_type,
								json_extract(record_item.value, '$.body') AS body_json
							FROM json_each(?9) AS record_item
						)
						INSERT INTO equity_import (owner_id, import_id, idempotency_key, content_sha256,
							committed_at, coverage_note, payload_json, record_count, commit_sequence)
						SELECT
							?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
							(
								SELECT coalesce(max(eim.commit_sequence), 0) + 1
								FROM equity_import AS eim
								WHERE eim.owner_id = ?10
							)
						WHERE NOT EXISTS (
								SELECT 1
								FROM incoming
								INNER JOIN equity_record AS erc
									ON erc.owner_id = ?10 AND erc.record_id = incoming.record_id
								WHERE erc.record_type <> incoming.record_type
									OR erc.body_json <> incoming.body_json
							)
							AND NOT EXISTS (
								SELECT 1
								FROM incoming
								INNER JOIN equity_issuer_identifier AS eii
									ON eii.owner_id = ?10
									AND eii.scheme = json_extract(incoming.body_json, '$.scheme')
									AND eii.value = json_extract(incoming.body_json, '$.value')
								WHERE incoming.record_type = 'identifier'
									AND eii.issuer_id <> json_extract(incoming.body_json, '$.issuerId')
							)
							AND NOT EXISTS (
								SELECT 1
								FROM incoming
								INNER JOIN equity_listing AS el
									ON el.owner_id = ?10
									AND el.venue_mic = json_extract(incoming.body_json, '$.venueMic')
									AND el.symbol = json_extract(incoming.body_json, '$.symbol')
								WHERE incoming.record_type = 'listing'
									AND el.listing_id <> incoming.record_id
									AND coalesce(el.listed_on, '0001-01-01')
										<= coalesce(json_extract(incoming.body_json, '$.delistedOn'), '9999-12-31')
									AND coalesce(json_extract(incoming.body_json, '$.listedOn'), '0001-01-01')
										<= coalesce(el.delisted_on, '9999-12-31')
							)
							AND NOT EXISTS (
								SELECT 1
								FROM incoming
								INNER JOIN equity_metric_definition AS emd
									ON emd.owner_id = ?10
									AND emd.metric_code = json_extract(incoming.body_json, '$.metricCode')
									AND emd.version = json_extract(incoming.body_json, '$.version')
								WHERE incoming.record_type = 'metric'
									AND emd.metric_definition_id <> incoming.record_id
							)
						ON CONFLICT (owner_id, idempotency_key) DO NOTHING`,
					)
					.bind(
						ownerId,
						write.importId,
						write.idempotencyKey,
						write.contentSha256,
						write.receivedAt,
						write.payload.coverageNote,
						JSON.stringify(write.payload),
						write.records.length,
						serialized,
						ownerId,
					),
				db
					.prepare(
						`INSERT INTO equity_record (owner_id, record_id, record_type, import_id, body_json)
						SELECT
							?,
							json_extract(record_item.value, '$.recordId'),
							json_extract(record_item.value, '$.recordType'),
							?,
							json_extract(record_item.value, '$.body')
						FROM json_each(?) AS record_item
						WHERE ${guard}
						ON CONFLICT (owner_id, record_id) DO NOTHING`,
					)
					.bind(ownerId, write.importId, serialized, ownerId, write.importId),
			];
			for (const definition of EQUITY_TABLES) {
				const subset = write.records.filter((record) => record.recordType === definition.kind);
				if (subset.length === 0) continue;
				const columns = definition.columns.map(([column]) => column).join(", ");
				const values = definition.columns
					.map(([, key]) => `json_extract(record_item.value, '$.body.${key}')`)
					.join(", ");
				const primary = definition.columns[0][0];
				statements.push(
					db
						.prepare(
							`INSERT INTO ${definition.table} (owner_id, ${columns})
							SELECT ?, ${values}
							FROM json_each(?) AS record_item
							WHERE json_extract(record_item.value, '$.recordType') = ? AND ${guard}
							ON CONFLICT (owner_id, ${primary}) DO NOTHING`,
						)
						.bind(ownerId, JSON.stringify(subset), definition.kind, ownerId, write.importId),
				);
			}
			statements.push(
				db
					.prepare(
						`UPDATE equity_import
						SET committed_at = max(
							?,
							strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
							coalesce(
								(
									SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(eim_other.committed_at), '+0.001 seconds')
									FROM equity_import AS eim_other
									WHERE eim_other.owner_id = ? AND eim_other.import_id <> ?
								),
								'0001-01-01T00:00:00.000Z'
							)
						)
						WHERE owner_id = ? AND import_id = ?`,
					)
					.bind(write.receivedAt, ownerId, write.importId, ownerId, write.importId),
			);
			statements.push(
				db
					.prepare(
						`INSERT INTO audit_log (owner_id, actor, action, resource, detail, at)
						SELECT owner_id, owner_id, 'equities.import', import_id, ?, committed_at
						FROM equity_import
						WHERE owner_id = ? AND import_id = ?`,
					)
					.bind(`records:${write.records.length}`, ownerId, write.importId),
			);
			const results = await db.batch(statements);
			return results[0]?.meta.changes === 1;
		},
		async getRecords(ownerId, ids) {
			if (ids.length === 0) return [];
			const rows = await db
				.prepare(
					`SELECT record_id, record_type, body_json
					FROM equity_record
					WHERE owner_id = ? AND record_id IN (SELECT value FROM json_each(?))`,
				)
				.bind(ownerId, JSON.stringify(ids))
				.all();
			return rows.results.map((row) =>
				equityRecordSchema.parse({
					recordId: row.record_id,
					recordType: row.record_type,
					body: bodyOf("equity_record", z.unknown(), row),
				}),
			);
		},
		async listIssuers(ownerId, query) {
			const rows = await db
				.prepare(
					`SELECT
						eis.issuer_id,
						erc.body_json,
						(
							SELECT json_group_array(listing_symbols.symbol)
							FROM (
								SELECT DISTINCT el.market || ':' || el.symbol AS symbol
								FROM equity_security AS esc
								INNER JOIN equity_listing AS el
									ON el.owner_id = esc.owner_id AND el.security_id = esc.security_id
								WHERE esc.owner_id = eis.owner_id AND esc.issuer_id = eis.issuer_id
								ORDER BY symbol
							) AS listing_symbols
						) AS symbols_json,
						(
							SELECT count(*)
							FROM equity_filing AS ef
							INNER JOIN equity_statement AS est
								ON est.owner_id = ef.owner_id AND est.filing_id = ef.filing_id
							INNER JOIN equity_financial_fact AS eff
								ON eff.owner_id = est.owner_id AND eff.statement_id = est.statement_id
							WHERE ef.owner_id = eis.owner_id AND ef.issuer_id = eis.issuer_id
						) AS fact_count
					FROM equity_issuer AS eis
					INNER JOIN equity_record AS erc
						ON erc.owner_id = eis.owner_id AND erc.record_id = eis.issuer_id
					WHERE eis.owner_id = ?
						AND (? IS NULL OR eis.issuer_id > ?)
						AND (
							? = ''
							OR instr(lower(eis.legal_name), lower(?)) > 0
							OR instr(coalesce(eis.local_name, ''), ?) > 0
							OR EXISTS (
								SELECT 1
								FROM equity_security AS esc
								INNER JOIN equity_listing AS el
									ON el.owner_id = esc.owner_id AND el.security_id = esc.security_id
								WHERE esc.owner_id = eis.owner_id
									AND esc.issuer_id = eis.issuer_id
									AND instr(lower(el.symbol), lower(?)) > 0
							)
						)
					ORDER BY eis.issuer_id
					LIMIT ?`,
				)
				.bind(
					ownerId,
					query.after ?? null,
					query.after ?? null,
					query.q,
					query.q,
					query.q,
					query.q,
					query.limit + 1,
				)
				.all();
			const kept = rows.results.slice(0, query.limit);
			return equityIssuerListSchema.parse({
				issuers: kept.map((row) => ({
					...bodyOf(
						"equity_record",
						z.object({
							issuerId: z.string(),
							legalName: z.string(),
							localName: z.string().nullable(),
							domicileCountry: z.string(),
						}),
						row,
					),
					symbols: bodyOf("equity_listing", z.array(z.string()), { body_json: row.symbols_json }),
					factCount: row.fact_count,
				})),
				nextCursor: rows.results.length > query.limit ? (kept.at(-1)?.issuer_id ?? null) : null,
			});
		},
		async listRecords(ownerId, query) {
			const rows = await db
				.prepare(
					`SELECT record_id, record_type, body_json
					FROM equity_record
					WHERE owner_id = ?
						AND (? IS NULL OR record_id > ?)
						AND (? IS NULL OR record_type = ?)
					ORDER BY record_id
					LIMIT ?`,
				)
				.bind(
					ownerId,
					query.after ?? null,
					query.after ?? null,
					query.recordType ?? null,
					query.recordType ?? null,
					query.limit + 1,
				)
				.all();
			const kept = rows.results.slice(0, query.limit);
			return {
				records: kept.map((row) =>
					equityRecordSchema.parse({
						recordId: row.record_id,
						recordType: row.record_type,
						body: bodyOf("equity_record", z.unknown(), row),
					}),
				),
				nextCursor:
					rows.results.length > query.limit
						? decode("equity_record", cursorRow, kept.at(-1)).record_id
						: null,
			};
		},
		async listFacts(ownerId, issuerId, query) {
			const joins = `FROM equity_filing AS ef
				INNER JOIN equity_statement AS est
					ON est.owner_id = ef.owner_id AND est.filing_id = ef.filing_id
				INNER JOIN equity_financial_fact AS eff
					ON eff.owner_id = est.owner_id AND eff.statement_id = est.statement_id
				INNER JOIN equity_record AS erc_fact
					ON erc_fact.owner_id = eff.owner_id AND erc_fact.record_id = eff.fact_id
				INNER JOIN equity_record AS erc_statement
					ON erc_statement.owner_id = est.owner_id AND erc_statement.record_id = est.statement_id
				INNER JOIN equity_record AS erc_filing
					ON erc_filing.owner_id = ef.owner_id AND erc_filing.record_id = ef.filing_id
				INNER JOIN equity_record AS erc_metric
					ON erc_metric.owner_id = eff.owner_id AND erc_metric.record_id = eff.metric_definition_id
				INNER JOIN equity_source_document AS esd
					ON esd.owner_id = ef.owner_id AND esd.source_document_id = ef.source_document_id
				INNER JOIN equity_record AS erc_document
					ON erc_document.owner_id = esd.owner_id AND erc_document.record_id = esd.source_document_id
				INNER JOIN equity_record AS erc_issuer
					ON erc_issuer.owner_id = ef.owner_id AND erc_issuer.record_id = ef.issuer_id
				INNER JOIN equity_record AS erc_source
					ON erc_source.owner_id = esd.owner_id AND erc_source.record_id = esd.source_id
				INNER JOIN equity_import AS eim_fact
					ON eim_fact.owner_id = erc_fact.owner_id AND eim_fact.import_id = erc_fact.import_id
				INNER JOIN equity_import AS eim_statement
					ON eim_statement.owner_id = erc_statement.owner_id
					AND eim_statement.import_id = erc_statement.import_id
				INNER JOIN equity_import AS eim_filing
					ON eim_filing.owner_id = erc_filing.owner_id AND eim_filing.import_id = erc_filing.import_id
				INNER JOIN equity_import AS eim_metric
					ON eim_metric.owner_id = erc_metric.owner_id AND eim_metric.import_id = erc_metric.import_id
				INNER JOIN equity_import AS eim_document
					ON eim_document.owner_id = erc_document.owner_id
					AND eim_document.import_id = erc_document.import_id
				INNER JOIN equity_import AS eim_issuer
					ON eim_issuer.owner_id = erc_issuer.owner_id AND eim_issuer.import_id = erc_issuer.import_id
				INNER JOIN equity_import AS eim_source
					ON eim_source.owner_id = erc_source.owner_id AND eim_source.import_id = erc_source.import_id`;
			const knownAt = `max(eim_fact.committed_at, eim_statement.committed_at, eim_filing.committed_at,
				eim_metric.committed_at, eim_document.committed_at, eim_issuer.committed_at,
				eim_source.committed_at)`;
			const knownSequence = `max(eim_fact.commit_sequence, eim_statement.commit_sequence,
				eim_filing.commit_sequence, eim_metric.commit_sequence, eim_document.commit_sequence,
				eim_issuer.commit_sequence, eim_source.commit_sequence)`;
			const rows = await db
				.prepare(
					`SELECT
						erc_fact.body_json,
						erc_statement.body_json AS statement_json,
						erc_metric.body_json AS metric_json,
						erc_filing.body_json AS filing_json,
						erc_document.body_json AS document_json,
						${knownAt} AS committed_at
					${joins}
					WHERE ef.owner_id = ?
						AND ef.issuer_id = ?
						AND (? IS NULL OR eff.fact_id > ?)
						AND (? IS NULL OR (ef.public_available_at IS NOT NULL AND ef.public_available_at <= ?))
						AND (? IS NULL OR (${knownAt} <= ? AND esd.retrieved_at <= ?))
						AND ${knownSequence} <= ?
					ORDER BY eff.fact_id
					LIMIT ?`,
				)
				.bind(
					ownerId,
					issuerId,
					query.after ?? null,
					query.after ?? null,
					query.informationCutoff ?? null,
					query.informationCutoff ?? null,
					query.ingestionCutoff ?? null,
					query.ingestionCutoff ?? null,
					query.ingestionCutoff ?? null,
					query.ingestionVersion,
					query.limit + 1,
				)
				.all();
			const kept = rows.results.slice(0, query.limit);
			const facts = kept.map((row) => ({
				...bodyOf("equity_financial_fact", z.record(z.string(), z.unknown()), row),
				issuerId,
				statement: bodyOf("equity_statement", z.unknown(), { body_json: row.statement_json }),
				metric: bodyOf("equity_metric_definition", z.unknown(), { body_json: row.metric_json }),
				filing: bodyOf("equity_filing", z.unknown(), { body_json: row.filing_json }),
				document: bodyOf("equity_source_document", z.unknown(), { body_json: row.document_json }),
				committedAt: row.committed_at,
			}));
			const parsed = equityFactsResponseSchema.parse({
				facts,
				nextCursor: null,
				ingestionVersion: query.ingestionVersion,
			});
			return {
				...parsed,
				nextCursor:
					rows.results.length > query.limit ? (parsed.facts.at(-1)?.factId ?? null) : null,
			};
		},
		async listIssuerRecords(ownerId, issuerId, query) {
			// Current catalog only. Historical filters belong to the provenance-complete facts query.
			const rows = await db
				.prepare(
					`WITH issuer_securities AS (
						SELECT esc.security_id
						FROM equity_security AS esc
						WHERE esc.owner_id = ?1 AND esc.issuer_id = ?2
					),
					issuer_listings AS (
						SELECT el.listing_id
						FROM equity_listing AS el
						WHERE el.owner_id = ?1
							AND el.security_id IN (SELECT issuer_securities.security_id FROM issuer_securities)
					),
					issuer_filings AS (
						SELECT ef.filing_id
						FROM equity_filing AS ef
						WHERE ef.owner_id = ?1 AND ef.issuer_id = ?2
					)
					SELECT erc.record_id, erc.record_type, erc.body_json
					FROM equity_record AS erc
					WHERE erc.owner_id = ?1
						AND (
							erc.record_id = ?2
							OR erc.record_id IN (SELECT issuer_securities.security_id FROM issuer_securities)
							OR erc.record_id IN (SELECT issuer_listings.listing_id FROM issuer_listings)
							OR erc.record_id IN (SELECT issuer_filings.filing_id FROM issuer_filings)
							OR erc.record_id IN (
								SELECT eii.identifier_id
								FROM equity_issuer_identifier AS eii
								WHERE eii.owner_id = ?1 AND eii.issuer_id = ?2
							)
							OR erc.record_id IN (
								SELECT epb.price_bar_id
								FROM equity_price_bar AS epb
								WHERE epb.owner_id = ?1
									AND epb.listing_id IN (SELECT issuer_listings.listing_id FROM issuer_listings)
							)
							OR erc.record_id IN (
								SELECT eca.action_id
								FROM equity_corporate_action AS eca
								WHERE eca.owner_id = ?1
									AND eca.security_id IN (SELECT issuer_securities.security_id FROM issuer_securities)
							)
							OR erc.record_id IN (
								SELECT ego.guidance_id
								FROM equity_guidance_observation AS ego
								WHERE ego.owner_id = ?1 AND ego.issuer_id = ?2
							)
						)
						AND (?3 IS NULL OR erc.record_id > ?3)
					ORDER BY erc.record_id
					LIMIT ?4`,
				)
				.bind(ownerId, issuerId, query.after ?? null, query.limit + 1)
				.all();
			const kept = rows.results.slice(0, query.limit);
			return {
				records: kept.map((row) =>
					equityRecordSchema.parse({
						recordId: row.record_id,
						recordType: row.record_type,
						body: bodyOf("equity_record", z.unknown(), row),
					}),
				),
				nextCursor:
					rows.results.length > query.limit
						? decode("equity_record", cursorRow, kept.at(-1)).record_id
						: null,
			};
		},
		async listImports(ownerId, query) {
			const rows = await db
				.prepare(
					`SELECT import_id, committed_at, record_count, coverage_note, content_sha256
					FROM equity_import
					WHERE owner_id = ?
						AND (? IS NULL OR committed_at < ? OR (committed_at = ? AND import_id < ?))
					ORDER BY committed_at DESC, import_id DESC
					LIMIT ?`,
				)
				.bind(
					ownerId,
					query.after ?? null,
					query.after?.slice(0, 24) ?? null,
					query.after?.slice(0, 24) ?? null,
					query.after?.slice(25) ?? null,
					query.limit + 1,
				)
				.all();
			const kept = rows.results.slice(0, query.limit);
			return equityImportHistorySchema.parse({
				imports: kept.map((r) => ({
					importId: r.import_id,
					committedAt: r.committed_at,
					recordCount: r.record_count,
					coverageNote: r.coverage_note,
					contentSha256: r.content_sha256,
				})),
				nextCursor:
					rows.results.length > query.limit
						? `${kept.at(-1)?.committed_at}_${kept.at(-1)?.import_id}`
						: null,
			});
		},
		async getImportPayload(ownerId, importId) {
			const row = await db
				.prepare(
					`SELECT payload_json AS body_json
					FROM equity_import
					WHERE owner_id = ? AND import_id = ?`,
				)
				.bind(ownerId, importId)
				.first();
			return row === null ? null : bodyOf("equity_import", equityImportSchema, row);
		},
	};
}
