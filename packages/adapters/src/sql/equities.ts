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
					"SELECT coalesce(max(commit_sequence), 0) AS version FROM equity_import WHERE owner_id = ?",
				)
				.bind(ownerId)
				.first();
			return decode("equity_import", z.object({ version: z.number().int().nonnegative() }), row)
				.version;
		},
		async findImport(ownerId, key) {
			const row = await db
				.prepare(
					"SELECT import_id, committed_at, record_count, content_sha256, commit_sequence FROM equity_import WHERE owner_id = ? AND idempotency_key = ?",
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
			const guard = "EXISTS (SELECT 1 FROM equity_import WHERE owner_id = ? AND import_id = ?)";
			const statements = [
				db
					.prepare(`WITH incoming AS (
 SELECT json_extract(value, '$.recordId') AS record_id, json_extract(value, '$.recordType') AS record_type,
 json_extract(value, '$.body') AS body_json FROM json_each(?9))
 INSERT INTO equity_import (owner_id, import_id, idempotency_key, content_sha256, committed_at, coverage_note, payload_json, record_count, commit_sequence)
 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, (SELECT coalesce(max(commit_sequence), 0) + 1 FROM equity_import WHERE owner_id = ?10) WHERE NOT EXISTS (
 SELECT 1 FROM incoming i JOIN equity_record existing ON existing.owner_id = ?10 AND existing.record_id = i.record_id
 WHERE existing.record_type <> i.record_type OR existing.body_json <> i.body_json)
 AND NOT EXISTS (SELECT 1 FROM incoming i JOIN equity_issuer_identifier old ON old.owner_id = ?10
 AND old.scheme = json_extract(i.body_json, '$.scheme') AND old.value = json_extract(i.body_json, '$.value')
 WHERE i.record_type = 'identifier' AND old.issuer_id <> json_extract(i.body_json, '$.issuerId'))
 AND NOT EXISTS (SELECT 1 FROM incoming i JOIN equity_listing old ON old.owner_id = ?10
 AND old.venue_mic = json_extract(i.body_json, '$.venueMic') AND old.symbol = json_extract(i.body_json, '$.symbol')
 WHERE i.record_type = 'listing' AND old.listing_id <> i.record_id
 AND coalesce(old.listed_on, '0001-01-01') <= coalesce(json_extract(i.body_json, '$.delistedOn'), '9999-12-31')
 AND coalesce(json_extract(i.body_json, '$.listedOn'), '0001-01-01') <= coalesce(old.delisted_on, '9999-12-31'))
 AND NOT EXISTS (SELECT 1 FROM incoming i JOIN equity_metric_definition old ON old.owner_id = ?10
 AND old.metric_code = json_extract(i.body_json, '$.metricCode') AND old.version = json_extract(i.body_json, '$.version')
 WHERE i.record_type = 'metric' AND old.metric_definition_id <> i.record_id)
 ON CONFLICT (owner_id, idempotency_key) DO NOTHING`)
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
					.prepare(`INSERT INTO equity_record (owner_id, record_id, record_type, import_id, body_json)
					SELECT ?, json_extract(value, '$.recordId'), json_extract(value, '$.recordType'), ?, json_extract(value, '$.body')
					FROM json_each(?) WHERE ${guard} ON CONFLICT (owner_id, record_id) DO NOTHING`)
					.bind(ownerId, write.importId, serialized, ownerId, write.importId),
			];
			for (const definition of EQUITY_TABLES) {
				const subset = write.records.filter((record) => record.recordType === definition.kind);
				if (subset.length === 0) continue;
				const columns = definition.columns.map(([column]) => column).join(", ");
				const values = definition.columns
					.map(([, key]) => `json_extract(value, '$.body.${key}')`)
					.join(", ");
				const primary = definition.columns[0][0];
				statements.push(
					db
						.prepare(`INSERT INTO ${definition.table} (owner_id, ${columns}) SELECT ?, ${values}
					FROM json_each(?) WHERE json_extract(value, '$.recordType') = ? AND ${guard}
					ON CONFLICT (owner_id, ${primary}) DO NOTHING`)
						.bind(ownerId, JSON.stringify(subset), definition.kind, ownerId, write.importId),
				);
			}
			statements.push(
				db
					.prepare(`UPDATE equity_import SET committed_at = max(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
 coalesce((SELECT strftime('%Y-%m-%dT%H:%M:%fZ', max(committed_at), '+0.001 seconds') FROM equity_import WHERE owner_id = ? AND import_id <> ?), '0001-01-01T00:00:00.000Z'))
 WHERE owner_id = ? AND import_id = ?`)
					.bind(write.receivedAt, ownerId, write.importId, ownerId, write.importId),
			);
			statements.push(
				db
					.prepare(`INSERT INTO audit_log (owner_id, actor, action, resource, detail, at)
 SELECT owner_id, owner_id, 'equities.import', import_id, ?, committed_at FROM equity_import
 WHERE owner_id = ? AND import_id = ?`)
					.bind(`records:${write.records.length}`, ownerId, write.importId),
			);
			const results = await db.batch(statements);
			return results[0]?.meta.changes === 1;
		},
		async getRecords(ownerId, ids) {
			if (ids.length === 0) return [];
			const rows = await db
				.prepare(`SELECT record_id, record_type, body_json FROM equity_record
				WHERE owner_id = ? AND record_id IN (SELECT value FROM json_each(?))`)
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
				.prepare(`SELECT i.issuer_id, r.body_json,
				(SELECT json_group_array(symbol) FROM (SELECT DISTINCT l.market || ':' || l.symbol AS symbol
					FROM equity_security s JOIN equity_listing l ON l.owner_id = s.owner_id AND l.security_id = s.security_id
					WHERE s.owner_id = i.owner_id AND s.issuer_id = i.issuer_id ORDER BY symbol)) AS symbols_json,
				(SELECT count(*) FROM equity_filing f JOIN equity_statement st ON st.owner_id = f.owner_id AND st.filing_id = f.filing_id
					JOIN equity_financial_fact fact ON fact.owner_id = st.owner_id AND fact.statement_id = st.statement_id
					WHERE f.owner_id = i.owner_id AND f.issuer_id = i.issuer_id) AS fact_count
				FROM equity_issuer i JOIN equity_record r ON r.owner_id = i.owner_id AND r.record_id = i.issuer_id
				WHERE i.owner_id = ? AND (? IS NULL OR i.issuer_id > ?) AND
				(? = '' OR instr(lower(i.legal_name), lower(?)) > 0 OR instr(coalesce(i.local_name, ''), ?) > 0 OR EXISTS (
					SELECT 1 FROM equity_security s JOIN equity_listing l ON l.owner_id = s.owner_id AND l.security_id = s.security_id
					WHERE s.owner_id = i.owner_id AND s.issuer_id = i.issuer_id AND instr(lower(l.symbol), lower(?)) > 0))
				ORDER BY i.issuer_id LIMIT ?`)
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
				.prepare(`SELECT record_id, record_type, body_json FROM equity_record
				WHERE owner_id = ? AND (? IS NULL OR record_id > ?) AND (? IS NULL OR record_type = ?)
				ORDER BY record_id LIMIT ?`)
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
			const joins = `FROM equity_filing f JOIN equity_statement st ON st.owner_id = f.owner_id AND st.filing_id = f.filing_id
				JOIN equity_financial_fact ff ON ff.owner_id = st.owner_id AND ff.statement_id = st.statement_id
				JOIN equity_record fact ON fact.owner_id = ff.owner_id AND fact.record_id = ff.fact_id
				JOIN equity_record statement ON statement.owner_id = st.owner_id AND statement.record_id = st.statement_id
				JOIN equity_record filing ON filing.owner_id = f.owner_id AND filing.record_id = f.filing_id
				JOIN equity_record metric ON metric.owner_id = ff.owner_id AND metric.record_id = ff.metric_definition_id
				JOIN equity_source_document d ON d.owner_id = f.owner_id AND d.source_document_id = f.source_document_id
				JOIN equity_record document ON document.owner_id = d.owner_id AND document.record_id = d.source_document_id
				JOIN equity_record issuer ON issuer.owner_id = f.owner_id AND issuer.record_id = f.issuer_id
				JOIN equity_record source ON source.owner_id = d.owner_id AND source.record_id = d.source_id
				JOIN equity_import fi ON fi.owner_id = fact.owner_id AND fi.import_id = fact.import_id
				JOIN equity_import si ON si.owner_id = statement.owner_id AND si.import_id = statement.import_id
				JOIN equity_import fli ON fli.owner_id = filing.owner_id AND fli.import_id = filing.import_id
				JOIN equity_import mi ON mi.owner_id = metric.owner_id AND mi.import_id = metric.import_id
				JOIN equity_import di ON di.owner_id = document.owner_id AND di.import_id = document.import_id
				JOIN equity_import ii ON ii.owner_id = issuer.owner_id AND ii.import_id = issuer.import_id
				JOIN equity_import sci ON sci.owner_id = source.owner_id AND sci.import_id = source.import_id`;
			const knownAt =
				"max(fi.committed_at, si.committed_at, fli.committed_at, mi.committed_at, di.committed_at, ii.committed_at, sci.committed_at)";
			const rows = await db
				.prepare(`SELECT fact.body_json, statement.body_json AS statement_json, metric.body_json AS metric_json,
				filing.body_json AS filing_json, document.body_json AS document_json, ${knownAt} AS committed_at
				${joins} WHERE f.owner_id = ? AND f.issuer_id = ? AND (? IS NULL OR ff.fact_id > ?)
				AND (? IS NULL OR (f.public_available_at IS NOT NULL AND f.public_available_at <= ?))
				AND (? IS NULL OR (${knownAt} <= ? AND d.retrieved_at <= ?))
 AND max(fi.commit_sequence, si.commit_sequence, fli.commit_sequence, mi.commit_sequence, di.commit_sequence, ii.commit_sequence, sci.commit_sequence) <= ? ORDER BY ff.fact_id LIMIT ?`)
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
				.prepare(`WITH securities AS (SELECT security_id FROM equity_security WHERE owner_id = ?1 AND issuer_id = ?2),
				listings AS (SELECT listing_id FROM equity_listing WHERE owner_id = ?1 AND security_id IN (SELECT security_id FROM securities)),
                filings AS (SELECT filing_id FROM equity_filing WHERE owner_id = ?1 AND issuer_id = ?2)
                SELECT r.record_id, r.record_type, r.body_json FROM equity_record r WHERE r.owner_id = ?1
                AND (r.record_id = ?2 OR r.record_id IN (SELECT security_id FROM securities)
                    OR r.record_id IN (SELECT listing_id FROM listings) OR r.record_id IN (SELECT filing_id FROM filings)
                    OR r.record_id IN (SELECT identifier_id FROM equity_issuer_identifier WHERE owner_id = ?1 AND issuer_id = ?2)
                    OR r.record_id IN (SELECT price_bar_id FROM equity_price_bar WHERE owner_id = ?1 AND listing_id IN (SELECT listing_id FROM listings))
                    OR r.record_id IN (SELECT action_id FROM equity_corporate_action WHERE owner_id = ?1 AND security_id IN (SELECT security_id FROM securities))
                    OR r.record_id IN (SELECT guidance_id FROM equity_guidance_observation WHERE owner_id = ?1 AND issuer_id = ?2))
                AND (?3 IS NULL OR r.record_id > ?3) ORDER BY r.record_id LIMIT ?4`)
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
					"SELECT import_id, committed_at, record_count, coverage_note, content_sha256 FROM equity_import WHERE owner_id = ? AND (? IS NULL OR committed_at < ? OR (committed_at = ? AND import_id < ?)) ORDER BY committed_at DESC, import_id DESC LIMIT ?",
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
					"SELECT payload_json AS body_json FROM equity_import WHERE owner_id = ? AND import_id = ?",
				)
				.bind(ownerId, importId)
				.first();
			return row === null ? null : bodyOf("equity_import", equityImportSchema, row);
		},
	};
}
