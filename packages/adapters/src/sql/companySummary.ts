/**
 * AI-written company summaries (ADR-0060, `stock_company_summary`): the
 * repository the Stocks read and the claim's schedule use, and the guarded
 * statement a `company-summarized` completion commits.
 */
import type { CompanySummaryEffects, CompanySummaryRepository } from "@research/application";
import { companySummaryThemeSchema, companySummaryViewSchema } from "@research/contracts";
import { z } from "zod";
import type { SqlDatabase, SqlStatement, SqlValue } from "./database.ts";
import { decode, parseJsonColumn } from "./rows.ts";

const TABLE = "stock_company_summary";

const summaryRowSchema = z.object({
	description_en: z.string(),
	description_ja: z.string(),
	themes_json: z.string(),
	agent_id: z.string(),
	model: z.string().nullable(),
	generated_at: z.string(),
});

const scheduleRowSchema = z.object({
	market: z.enum(["US", "JP"]),
	symbol: z.string(),
	queued_at: z.string(),
	generated_at: z.string().nullable(),
});

const themesSchema = z.array(companySummaryThemeSchema);

export function createCompanySummaryRepository(db: SqlDatabase): CompanySummaryRepository {
	return {
		async get(ownerId, market, symbol) {
			// One primary-key seek; a row whose summary fails the contract is a
			// storage fault (`StoredDataError`).
			const row = await db
				.prepare(
					`SELECT scs.description_en, scs.description_ja, scs.themes_json, scs.agent_id,
						scs.model, scs.generated_at
					FROM stock_company_summary AS scs
					WHERE scs.owner_id = ? AND scs.market = ? AND scs.symbol = ?
						AND scs.generated_at IS NOT NULL`,
				)
				.bind(ownerId, market, symbol)
				.first();
			if (row === null) return null;
			const r = decode(TABLE, summaryRowSchema, row);
			return decode(TABLE, companySummaryViewSchema, {
				description: { en: r.description_en, ja: r.description_ja },
				themes: parseJsonColumn(TABLE, themesSchema, r.themes_json),
				agentId: r.agent_id,
				model: r.model,
				generatedAt: r.generated_at,
			});
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
