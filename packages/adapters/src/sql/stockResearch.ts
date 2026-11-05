import type { StockResearchRepository } from "@research/application";
import {
	type StockResearchHit,
	stockResearchHitSchema,
	stockResearchQuerySchema,
} from "@research/contracts";
import { interleaveSearchResults, truncateText } from "@research/domain";
import { z } from "zod";
import type { SqlDatabase } from "./database.ts";
import { decode } from "./rows.ts";

/** Search vocabulary; these are retrieval aliases, not UI labels. */
const METRIC_TERMS = {
	revenue: "売上高 売上収益",
	"gross-profit": "売上総利益",
	"operating-income": "営業利益",
	"ordinary-income": "経常利益",
	"profit-attributable-to-owners": "親会社株主に帰属する当期純利益 net income",
	"total-assets": "資産合計 総資産",
	"total-liabilities": "負債合計",
	"total-equity": "純資産合計",
	"cash-and-cash-equivalents": "現金及び現金同等物",
	"net-cash-from-operating-activities": "営業活動によるキャッシュフロー",
	"net-cash-from-investing-activities": "投資活動によるキャッシュフロー",
	"net-cash-from-financing-activities": "財務活動によるキャッシュフロー",
	"capital-expenditures": "設備投資",
	"free-cash-flow": "フリーキャッシュフロー",
} satisfies Record<import("@research/domain").EquityMetricCode, string>;
// Only constants enter this expression; all external values remain bound parameters.
const METRIC_CASE = `CASE emv.metric_code ${Object.entries(METRIC_TERMS)
	.map(([metric, terms]) => `WHEN '${metric}' THEN '${terms}'`)
	.join(" ")} ELSE '' END`;

/** Each branch returns documents with the same lineage columns. No provider calls or writes. */
const DOCUMENTS = {
	company: `SELECT 'company' AS kind, eco.company_id || ':' || p.key AS record_id,
		eco.market || ':' || eco.symbol || ' ' || coalesce(eco.name, '') || ' business description' AS title,
		json_extract(p.value, '$.text') AS text, ebd.source_url AS source_url,
		'SEC EDGAR' AS publisher, ebd.filed_on || 'T00:00:00Z' AS published_at,
		ebd.fetched_at AS retrieved_at, ebd.period_end || 'T00:00:00Z' AS effective_at,
		'regulatory-filing' AS source_class, 1 AS retain_quotes, 0 AS ai_generated
		FROM equity_company AS eco
		JOIN equity_business_description AS ebd ON ebd.owner_id = eco.owner_id AND ebd.company_id = eco.company_id
		JOIN json_each(ebd.paragraphs_json) AS p
		WHERE eco.owner_id = ? AND ebd.status = 'extracted'
		UNION ALL
		SELECT 'company', scs.market || ':' || scs.symbol,
			scs.market || ':' || scs.symbol || ' ' || coalesce(sd.name, '') || ' AI-written company overview',
			coalesce(scs.description_en, '') || char(10) || coalesce(scs.description_ja, '') || char(10) || coalesce(scs.overview_json, '') || char(10) || coalesce(scs.themes_json, ''),
			NULL, 'AI-written stored context', NULL,
			coalesce(scs.overview_generated_at, scs.generated_at), NULL, 'other', 0, 1
		FROM stock_company_summary AS scs
		LEFT JOIN stock_directory AS sd ON sd.owner_id = scs.owner_id AND sd.market = scs.market AND sd.symbol = scs.symbol
		WHERE scs.owner_id = ? AND (scs.generated_at IS NOT NULL OR scs.overview_generated_at IS NOT NULL)`,
	financials: `SELECT 'financials' AS kind, emv.company_id || ':' || emv.fiscal_year || ':' || emv.metric_code AS record_id,
		eco.market || ':' || eco.symbol || ' ' || coalesce(eco.name, '') || ' ' || replace(emv.metric_code, '-', ' ') || ' ' || (${METRIC_CASE}) AS title,
		'metric=' || emv.metric_code || '; fiscalYear=' || emv.fiscal_year ||
		'; value=' || coalesce(emv.value_decimal, 'unavailable') || '; currency=' || coalesce(emv.currency, 'unavailable') ||
		'; unit=base currency units; periodStart=' || coalesce(emv.period_start, 'unavailable') ||
		'; periodEnd=' || coalesce(emv.period_end, 'unavailable') || '; scope=' || coalesce(emv.scope, 'unavailable') ||
		'; derived=' || emv.derived || '; reportedValueCount=' || emv.reported_value_count ||
		'; unavailableReason=' || coalesce(emv.unavailable_reason, 'none') ||
		'; concept=' || coalesce(emv.concept, 'unavailable') || '; filingId=' || coalesce(emv.filing_id, 'unavailable') AS text,
		erf.source_url AS source_url, CASE eco.provider WHEN 'sec' THEN 'SEC EDGAR' ELSE 'J-Quants' END AS publisher,
		erf.filed_on || 'T00:00:00Z' AS published_at, emv.updated_at AS retrieved_at,
		emv.period_end || 'T00:00:00Z' AS effective_at, 'regulatory-filing' AS source_class,
		CASE eco.provider WHEN 'sec' THEN 1 ELSE 0 END AS retain_quotes, 0 AS ai_generated
		FROM equity_company AS eco
		JOIN equity_metric_value AS emv ON emv.owner_id = eco.owner_id AND emv.company_id = eco.company_id
		LEFT JOIN equity_report_filing AS erf ON erf.owner_id = emv.owner_id AND erf.filing_id = emv.filing_id
		WHERE eco.owner_id = ?`,
	news: `SELECT 'news' AS kind, a.article_id AS record_id, a.title AS title,
		a.title || char(10) || CASE WHEN ns.license_policy = 'short-excerpt-permitted' THEN coalesce(a.excerpt, '') ELSE '' END AS text,
		a.canonical_url AS source_url, a.publisher AS publisher, a.published_at AS published_at,
		a.retrieved_at AS retrieved_at, NULL AS effective_at, 'news' AS source_class,
		CASE WHEN ns.license_policy = 'short-excerpt-permitted' THEN 1 ELSE 0 END AS retain_quotes, 0 AS ai_generated
		FROM articles AS a
		LEFT JOIN news_sources AS ns ON ns.owner_id = a.owner_id AND ns.source_id = a.source_id
		WHERE a.owner_id = ?`,
} as const;

const hitFields = stockResearchHitSchema.shape;
const storedBoolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const rowSchema = z
	.object({
		kind: hitFields.kind,
		record_id: hitFields.recordId,
		title: z.string().min(1),
		text: z.string().min(1),
		source_url: hitFields.sourceUrl,
		publisher: hitFields.publisher,
		published_at: hitFields.publishedAt,
		retrieved_at: hitFields.retrievedAt,
		effective_at: hitFields.effectiveAt,
		source_class: hitFields.sourceClass,
		retain_quotes: storedBoolean,
		ai_generated: storedBoolean,
	})
	.transform((row) => ({
		kind: row.kind,
		recordId: row.record_id,
		title: row.title,
		text: row.text,
		sourceUrl: row.source_url,
		publisher: row.publisher,
		publishedAt: row.published_at,
		retrievedAt: row.retrieved_at,
		effectiveAt: row.effective_at,
		sourceClass: row.source_class,
		retainQuotes: row.retain_quotes,
		aiGenerated: row.ai_generated,
	}));

/** SQLite lower() folds ASCII only; keep the query's fold identical, including Japanese. */
function termsOf(query: string): readonly string[] {
	return query
		.split(/\s+/u)
		.map((term) => term.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
}

export function createStockResearchRepository(db: SqlDatabase): StockResearchRepository {
	return {
		async search(ownerId, input) {
			const query = stockResearchQuerySchema.parse(input);
			const terms = termsOf(query.query);
			const kinds =
				query.kind === undefined ? (["company", "financials", "news"] as const) : [query.kind];
			// One bounded result query per corpus; no per-stock or per-result queries.
			const groups: StockResearchHit[][] = [];
			for (const kind of kinds) {
				const result = await db
					.prepare(`WITH documents AS (${DOCUMENTS[kind]})
					SELECT d.kind, d.record_id, d.title, d.text, d.source_url, d.publisher, d.published_at, d.retrieved_at, d.effective_at, d.source_class, d.retain_quotes, d.ai_generated
					FROM documents AS d
					WHERE ${terms.map(() => "instr(lower(d.title || char(10) || d.text), ?) > 0").join(" AND ")}
					ORDER BY d.retrieved_at DESC, d.record_id DESC
					LIMIT ?`)
					.bind(...(kind === "company" ? [ownerId, ownerId] : [ownerId]), ...terms, query.limit + 1)
					.all();
				groups.push(
					result.results.map((raw) => {
						const row = decode("stock research", rowSchema, raw);
						const folded = row.text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
						const position = folded.indexOf(terms[0] ?? "");
						const start = Math.max(0, position - 160);
						return stockResearchHitSchema.parse({
							...row,
							title: truncateText(row.title, 300),
							text: truncateText(row.text.slice(start), 2400),
						});
					}),
				);
			}
			// Interleave corpora so news volume cannot crowd out statements or company text.
			const merged = interleaveSearchResults(groups, query.limit + 1);
			return { hits: merged.slice(0, query.limit), truncated: merged.length > query.limit };
		},
	};
}
