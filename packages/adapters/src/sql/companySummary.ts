/**
 * AI-written company summaries (ADR-0060) and company overviews (事業概要,
 * ADR-0064), `stock_company_summary`: the repository the Stocks read and
 * the claim's schedule use, the guarded statement a `company-summarized`
 * completion commits, and the statement that stores an overview.
 */
import type { CompanySummaryEffects, CompanySummaryRepository } from "@research/application";
import {
	type CompanyOverviewView,
	companyOverviewEntrySchema,
	companyOverviewFactsSchema,
	companyOverviewViewSchema,
	companySummaryThemeSchema,
	companySummaryViewSchema,
	overviewReferenceSchema,
	type WatchMarket,
} from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { decode, parseJsonColumn } from "./rows.ts";

const TABLE = "stock_company_summary";

const storedRowSchema = z.object({
	description_en: z.string().nullable(),
	description_ja: z.string().nullable(),
	themes_json: z.string().nullable(),
	agent_id: z.string().nullable(),
	model: z.string().nullable(),
	generated_at: z.string().nullable(),
	overview_json: z.string().nullable(),
	overview_facts_json: z.string().nullable(),
	overview_references_json: z.string().nullable(),
	overview_agent_id: z.string().nullable(),
	overview_model: z.string().nullable(),
	overview_generated_at: z.string().nullable(),
});

const scheduleRowSchema = z.object({
	market: z.enum(["US", "JP"]),
	symbol: z.string(),
	queued_at: z.string(),
	generated_at: z.string().nullable(),
});

const themesSchema = z.array(companySummaryThemeSchema);
const referencesSchema = z.array(overviewReferenceSchema);

export function createCompanySummaryRepository(db: SqlDatabase): CompanySummaryRepository {
	return {
		async get(ownerId, market, symbol) {
			// One primary-key seek for both parts; a part that fails its
			// contract is a storage fault (`StoredDataError`). The table's
			// CHECKs store each part whole or not at all.
			const row = await db
				.prepare(
					`SELECT scs.description_en, scs.description_ja, scs.themes_json, scs.agent_id,
						scs.model, scs.generated_at, scs.overview_json, scs.overview_facts_json,
						scs.overview_references_json, scs.overview_agent_id, scs.overview_model,
						scs.overview_generated_at
					FROM stock_company_summary AS scs
					WHERE scs.owner_id = ? AND scs.market = ? AND scs.symbol = ?`,
				)
				.bind(ownerId, market, symbol)
				.first();
			if (row === null) return { summary: null, overview: null };
			const r = decode(TABLE, storedRowSchema, row);
			const summary =
				r.generated_at === null ||
				r.description_en === null ||
				r.description_ja === null ||
				r.themes_json === null ||
				r.agent_id === null
					? null
					: decode(TABLE, companySummaryViewSchema, {
							description: { en: r.description_en, ja: r.description_ja },
							themes: parseJsonColumn(TABLE, themesSchema, r.themes_json),
							agentId: r.agent_id,
							model: r.model,
							generatedAt: r.generated_at,
						});
			const overview =
				r.overview_generated_at === null ||
				r.overview_json === null ||
				r.overview_facts_json === null ||
				r.overview_references_json === null ||
				r.overview_agent_id === null
					? null
					: decode(TABLE, companyOverviewViewSchema, {
							entry: parseJsonColumn(TABLE, companyOverviewEntrySchema, r.overview_json),
							facts: parseJsonColumn(TABLE, companyOverviewFactsSchema, r.overview_facts_json),
							references: parseJsonColumn(TABLE, referencesSchema, r.overview_references_json),
							agentId: r.overview_agent_id,
							model: r.overview_model,
							generatedAt: r.overview_generated_at,
						});
			return { summary, overview };
		},
		async listSchedule(ownerId) {
			const { results } = await db
				.prepare(
					`SELECT scs.market, scs.symbol, scs.queued_at, scs.generated_at
					FROM stock_company_summary AS scs
					WHERE scs.owner_id = ?`,
				)
				.bind(ownerId)
				.all();
			return results.map((row) => {
				const r = decode(TABLE, scheduleRowSchema, row);
				return {
					market: r.market,
					symbol: r.symbol,
					queuedAt: r.queued_at,
					generatedAt: r.generated_at,
				};
			});
		},
		async markQueued(ownerId, market, symbol, at) {
			await db
				.prepare(
					`INSERT INTO stock_company_summary (owner_id, market, symbol, queued_at)
					VALUES (?, ?, ?, ?)
					ON CONFLICT (owner_id, market, symbol) DO UPDATE SET queued_at = excluded.queued_at`,
				)
				.bind(ownerId, market, symbol, at)
				.run();
		},
	};
}

/**
 * The summary of a `company-summarized` completion, written over the
 * stock's row (created when it is missing) only when the job's
 * compare-and-set in the same batch won (`guard`).
 */
export function companySummaryStatements(
	db: SqlDatabase,
	ownerId: string,
	effects: CompanySummaryEffects,
	guard: { readonly sql: string; readonly values: readonly SqlValue[] },
): SqlStatement[] {
	return [
		db
			.prepare(
				`INSERT INTO stock_company_summary (owner_id, market, symbol, queued_at, description_en,
					description_ja, themes_json, agent_id, model, generated_at)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
				WHERE ${guard.sql}
				ON CONFLICT (owner_id, market, symbol) DO UPDATE SET
					description_en = excluded.description_en,
					description_ja = excluded.description_ja,
					themes_json = excluded.themes_json,
					agent_id = excluded.agent_id,
					model = excluded.model,
					generated_at = excluded.generated_at`,
			)
			.bind(
				ownerId,
				effects.market,
				effects.symbol,
				effects.generatedAt,
				effects.summary.description.en,
				effects.summary.description.ja,
				JSON.stringify(effects.summary.themes),
				effects.agentId,
				effects.model,
				effects.generatedAt,
				...guard.values,
			),
	];
}

/**
 * Stores a company overview (ADR-0064) over the stock's row, created when
 * missing (with `queued_at` = the write time); the summary columns are left
 * as they are. The view is checked against its contract first, so a stored
 * overview always reads back.
 */
export function companyOverviewStatement(
	db: SqlDatabase,
	ownerId: string,
	market: WatchMarket,
	symbol: string,
	overview: CompanyOverviewView,
): SqlStatement {
	const view = companyOverviewViewSchema.parse(overview);
	return db
		.prepare(
			`INSERT INTO stock_company_summary (owner_id, market, symbol, queued_at, overview_json,
				overview_facts_json, overview_references_json, overview_agent_id, overview_model,
				overview_generated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (owner_id, market, symbol) DO UPDATE SET
				overview_json = excluded.overview_json,
				overview_facts_json = excluded.overview_facts_json,
				overview_references_json = excluded.overview_references_json,
				overview_agent_id = excluded.overview_agent_id,
				overview_model = excluded.overview_model,
				overview_generated_at = excluded.overview_generated_at`,
		)
		.bind(
			ownerId,
			market,
			symbol,
			view.generatedAt,
			JSON.stringify(view.entry),
			JSON.stringify(view.facts),
			JSON.stringify(view.references),
			view.agentId,
			view.model,
			view.generatedAt,
		);
}
