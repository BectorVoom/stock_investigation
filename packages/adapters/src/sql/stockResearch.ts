import type { StockResearchRepository } from "@research/application";
import {
	type StockResearchHit,
	type StockResearchJpFigure,
	type StockResearchJpFinancials,
	stockResearchHitSchema,
	stockResearchJpFigureSchema,
	stockResearchJpFinancialsSchema,
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
		'regulatory-filing' AS source_class, 1 AS retain_quotes, 0 AS ai_generated,
		eco.market AS market, eco.symbol AS symbol, eco.name AS name_text, NULL AS theme_text
		FROM equity_company AS eco
		JOIN equity_business_description AS ebd ON ebd.owner_id = eco.owner_id AND ebd.company_id = eco.company_id
		JOIN json_each(ebd.paragraphs_json) AS p
		WHERE eco.owner_id = ? AND ebd.status = 'extracted'
		UNION ALL
		SELECT 'company', scs.market || ':' || scs.symbol,
			scs.market || ':' || scs.symbol || ' ' || CASE
				WHEN sd.local_name IS NOT NULL AND sd.local_name <> '' THEN
					CASE
						WHEN sd.name IS NOT NULL AND sd.name <> '' THEN sd.local_name || ' (' || sd.name || ')'
						ELSE sd.local_name
					END
				ELSE coalesce(sd.name, '')
			END || ' AI-written company overview',
			coalesce(scs.description_en, '') || char(10) || coalesce(scs.description_ja, '') || char(10) || coalesce(scs.overview_json, '') || char(10) || coalesce(scs.themes_json, ''),
			NULL, 'AI-written stored context', NULL,
			coalesce(scs.overview_generated_at, scs.generated_at), NULL, 'other', 0, 1,
			scs.market, scs.symbol, coalesce(sd.local_name, '') || ' ' || coalesce(sd.name, ''), scs.theme_names
		FROM stock_company_summary AS scs
		LEFT JOIN stock_directory AS sd ON sd.owner_id = scs.owner_id AND sd.market = scs.market AND sd.symbol = scs.symbol
		WHERE scs.owner_id = ? AND (scs.generated_at IS NOT NULL OR scs.overview_generated_at IS NOT NULL)`,
	financials: `SELECT 'financials' AS kind, emv.company_id || ':' || emv.fiscal_year || ':' || emv.metric_code AS record_id,
		eco.market || ':' || eco.symbol || ' ' || coalesce(eco.name, '') || ' ' || replace(emv.metric_code, '-', ' ') || ' ' || (${METRIC_CASE}) AS title,
		'issuer=' || eco.market || ':' || eco.symbol || CASE WHEN eco.name IS NOT NULL AND eco.name <> '' THEN ' ' || eco.name ELSE '' END ||
		'; metric=' || emv.metric_code || '; fiscalYear=' || emv.fiscal_year ||
		'; value=' || coalesce(emv.value_decimal, 'unavailable') || '; currency=' || coalesce(emv.currency, 'unavailable') ||
		'; unit=base currency units; periodStart=' || coalesce(emv.period_start, 'unavailable') ||
		'; periodEnd=' || coalesce(emv.period_end, 'unavailable') || '; scope=' || coalesce(emv.scope, 'unavailable') ||
		'; derived=' || emv.derived || '; reportedValueCount=' || emv.reported_value_count ||
		'; unavailableReason=' || coalesce(emv.unavailable_reason, 'none') ||
		'; concept=' || coalesce(emv.concept, 'unavailable') || '; filingId=' || coalesce(emv.filing_id, 'unavailable') AS text,
		erf.source_url AS source_url, CASE eco.provider WHEN 'sec' THEN 'SEC EDGAR' ELSE 'J-Quants' END AS publisher,
		erf.filed_on || 'T00:00:00Z' AS published_at, emv.updated_at AS retrieved_at,
		emv.period_end || 'T00:00:00Z' AS effective_at, 'regulatory-filing' AS source_class,
		CASE eco.provider WHEN 'sec' THEN 1 ELSE 0 END AS retain_quotes, 0 AS ai_generated,
		eco.market AS market, eco.symbol AS symbol, NULL AS name_text, NULL AS theme_text
		FROM equity_company AS eco
		JOIN equity_metric_value AS emv ON emv.owner_id = eco.owner_id AND emv.company_id = eco.company_id
		LEFT JOIN equity_report_filing AS erf ON erf.owner_id = emv.owner_id AND erf.filing_id = emv.filing_id
		WHERE eco.owner_id = ?`,
	news: `SELECT 'news' AS kind, a.article_id AS record_id, a.title AS title,
		a.title || char(10) || CASE WHEN ns.license_policy = 'short-excerpt-permitted' THEN coalesce(a.excerpt, '') ELSE '' END AS text,
		a.canonical_url AS source_url, a.publisher AS publisher, a.published_at AS published_at,
		a.retrieved_at AS retrieved_at, NULL AS effective_at, 'news' AS source_class,
		CASE WHEN ns.license_policy = 'short-excerpt-permitted' THEN 1 ELSE 0 END AS retain_quotes, 0 AS ai_generated,
		NULL AS market, NULL AS symbol, NULL AS name_text, NULL AS theme_text
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
		market: z.enum(["JP", "US"]).nullable(),
	})
	.transform((row) => ({
		hit: {
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
		},
		market: row.market,
	}));

const jpCompanyRowSchema = z.object({
	company_id: z.string().min(1),
	symbol: z.string().min(1),
	company_name: z.string().nullable(),
	local_name: z.string().nullable(),
	en_name: z.string().nullable(),
	listing: z.string().nullable(),
});

const jpMetricRowSchema = z.object({
	company_id: z.string().min(1),
	fiscal_year: z.number().int(),
	metric_code: z.enum(["revenue", "profit-attributable-to-owners"]),
	value_decimal: z.string().nullable(),
	value_real: z.number().nullable(),
	currency: z.string().nullable(),
	unavailable_reason: z.string().nullable(),
	period_start: z.string().nullable(),
	period_end: z.string().nullable(),
	retrieved_at: z.string().min(1),
	concept: z.string().nullable(),
	accounting_standard: z.enum(["US-GAAP", "IFRS", "JGAAP", "OTHER"]).nullable(),
	source_url: z.string().nullable(),
	filed_on: z.string().nullable(),
});

const HAYSTACK = "lower(d.title || char(10) || d.text)";
const TOKEN_BOUNDED_TERM = /^(?=.*[0-9])[0-9a-z:.-]+$/;

/** SQLite lower() folds ASCII only; keep the query's fold identical, including Japanese. */
function termsOf(query: string): readonly string[] {
	return query
		.split(/\s+/u)
		.map((term) => term.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));
}

function termClause(term: string): { readonly sql: string; readonly bindings: readonly string[] } {
	if (!TOKEN_BOUNDED_TERM.test(term)) {
		return { sql: `instr(${HAYSTACK}, ?) > 0`, bindings: [term] };
	}
	return {
		sql: `(instr(${HAYSTACK}, ?) > 0 AND substr(${HAYSTACK}, instr(${HAYSTACK}, ?) - 1, 1) NOT GLOB '[0-9a-z]' AND substr(${HAYSTACK}, instr(${HAYSTACK}, ?) + length(?), 1) NOT GLOB '[0-9a-z]')`,
		bindings: [term, term, term, term],
	};
}

function parseFinancialRecordId(
	recordId: string,
): { readonly companyId: string; readonly fiscalYear: number } | null {
	const lastColon = recordId.lastIndexOf(":");
	if (lastColon <= 0) return null;
	const prevColon = recordId.lastIndexOf(":", lastColon - 1);
	if (prevColon <= 0) return null;
	const companyId = recordId.slice(0, prevColon);
	const fiscalYear = Number(recordId.slice(prevColon + 1, lastColon));
	if (!Number.isInteger(fiscalYear) || fiscalYear < 1990 || fiscalYear > 2100) return null;
	return { companyId, fiscalYear };
}

function toJpFigure(row: z.infer<typeof jpMetricRowSchema>): {
	readonly figure: StockResearchJpFigure | null;
	readonly unavailableReason: string | null;
} {
	const numericValue =
		row.value_real ?? (row.value_decimal !== null ? Number(row.value_decimal) : null);
	if (numericValue === null || !Number.isFinite(numericValue)) {
		return {
			figure: null,
			unavailableReason: truncateText(row.unavailable_reason ?? "unavailable", 300),
		};
	}
	const candidate = stockResearchJpFigureSchema.safeParse({
		value: numericValue,
		currency: row.currency,
		accountingStandard: row.accounting_standard ?? "OTHER",
		periodStart: row.period_start,
		periodEnd: row.period_end,
		sourceUrl: row.source_url,
		filedOn: row.filed_on,
		retrievedAt: row.retrieved_at,
		concept: row.concept,
	});
	if (!candidate.success) {
		return {
			figure: null,
			unavailableReason: truncateText(row.unavailable_reason ?? "incomplete filing metadata", 300),
		};
	}
	return { figure: candidate.data, unavailableReason: null };
}

async function loadJpFinancials(
	db: SqlDatabase,
	ownerId: string,
	targets: readonly { readonly companyId: string; readonly fiscalYear: number }[],
): Promise<readonly StockResearchJpFinancials[]> {
	if (targets.length === 0) return [];
	const distinctCompanyIds = [...new Set(targets.map((target) => target.companyId))];
	const companyPlaceholders = distinctCompanyIds.map(() => "?").join(", ");
	const pairClauses = targets
		.map(() => "(emv.company_id = ? AND emv.fiscal_year = ?)")
		.join(" OR ");
	const [companyResult, metricResult] = await Promise.all([
		db
			.prepare(`SELECT eco.company_id AS company_id, eco.symbol AS symbol, eco.name AS company_name,
				sd.local_name AS local_name, sd.name AS en_name, sd.listing AS listing
				FROM equity_company AS eco
				LEFT JOIN stock_directory AS sd ON sd.owner_id = eco.owner_id AND sd.market = eco.market AND sd.symbol = eco.symbol
				WHERE eco.owner_id = ? AND eco.market = 'JP' AND eco.company_id IN (${companyPlaceholders})`)
			.bind(ownerId, ...distinctCompanyIds)
			.all(),
		db
			.prepare(`SELECT emv.company_id AS company_id, emv.fiscal_year AS fiscal_year, emv.metric_code AS metric_code,
				emv.value_decimal AS value_decimal, emv.value_real AS value_real, emv.currency AS currency,
				emv.unavailable_reason AS unavailable_reason,
				coalesce(emv.period_start, erf.period_start) AS period_start,
				coalesce(emv.period_end, erf.period_end) AS period_end,
				emv.updated_at AS retrieved_at, emv.concept AS concept,
				erf.accounting_standard AS accounting_standard, erf.source_url AS source_url, erf.filed_on AS filed_on
				FROM equity_metric_value AS emv
				LEFT JOIN equity_report_filing AS erf ON erf.owner_id = emv.owner_id AND erf.filing_id = emv.filing_id
				WHERE emv.owner_id = ?
					AND emv.metric_code IN ('revenue', 'profit-attributable-to-owners')
					AND (${pairClauses})`)
			.bind(ownerId, ...targets.flatMap((target) => [target.companyId, target.fiscalYear]))
			.all(),
	]);

	const companiesById = new Map(
		companyResult.results.map((raw) => {
			const row = decode("stock research jp company", jpCompanyRowSchema, raw);
			return [row.company_id, row] as const;
		}),
	);
	const metricsByKey = new Map<string, z.infer<typeof jpMetricRowSchema>>();
	for (const raw of metricResult.results) {
		const row = decode("stock research jp metric", jpMetricRowSchema, raw);
		metricsByKey.set(`${row.company_id}:${row.fiscal_year}:${row.metric_code}`, row);
	}

	const entries: StockResearchJpFinancials[] = [];
	for (const target of targets) {
		const company = companiesById.get(target.companyId);
		if (company === undefined) continue;
		const symbol = company.symbol.trim().toUpperCase();
		const rawIssuerName = company.company_name ?? company.local_name ?? company.en_name ?? symbol;
		const issuerName = truncateText(rawIssuerName.trim() || symbol, 300);
		const revenueRow = metricsByKey.get(`${target.companyId}:${target.fiscalYear}:revenue`);
		const netIncomeRow = metricsByKey.get(
			`${target.companyId}:${target.fiscalYear}:profit-attributable-to-owners`,
		);
		const revenue =
			revenueRow === undefined
				? { figure: null, unavailableReason: "not reported" }
				: toJpFigure(revenueRow);
		const netIncome =
			netIncomeRow === undefined
				? { figure: null, unavailableReason: "not reported" }
				: toJpFigure(netIncomeRow);
		const parsed = stockResearchJpFinancialsSchema.safeParse({
			symbol,
			issuerName,
			exchange: "TSE",
			listingVerification: company.listing !== null ? "source-verified" : "unverified",
			fiscalYear: target.fiscalYear,
			revenue: revenue.figure,
			revenueUnavailableReason: revenue.unavailableReason,
			netIncome: netIncome.figure,
			netIncomeUnavailableReason: netIncome.unavailableReason,
		});
		if (parsed.success) {
			entries.push(parsed.data);
		}
	}
	return entries;
}

export function createStockResearchRepository(db: SqlDatabase): StockResearchRepository {
	return {
		async search(ownerId, input) {
			const query = stockResearchQuerySchema.parse(input);
			const terms = termsOf(query.query);
			const clauses = terms.map(termClause);
			const whereSql = clauses.map((clause) => clause.sql).join(" AND ");
			const whereBindings = clauses.flatMap((clause) => clause.bindings);
			const nameSql = terms.map(() => "instr(lower(d.name_text), ?) > 0").join(" AND ");
			const themeSql = terms.map(() => "instr(lower(d.theme_text), ?) > 0").join(" AND ");
			const kinds =
				query.kind === undefined ? (["company", "financials", "news"] as const) : [query.kind];
			// One bounded result query per corpus; no per-stock or per-result queries.
			const groups: { readonly hit: StockResearchHit; readonly market: "JP" | "US" | null }[][] =
				[];
			for (const kind of kinds) {
				const orderSql =
					kind === "company"
						? `CASE WHEN ${nameSql} THEN 0 WHEN ${themeSql} THEN 1 ELSE 2 END, d.retrieved_at DESC, d.record_id DESC`
						: "d.retrieved_at DESC, d.record_id DESC";
				const orderBindings = kind === "company" ? [...terms, ...terms] : [];
				const result = await db
					.prepare(`WITH documents AS (${DOCUMENTS[kind]})
					SELECT d.kind, d.record_id, d.title, d.text, d.source_url, d.publisher, d.published_at, d.retrieved_at, d.effective_at, d.source_class, d.retain_quotes, d.ai_generated, d.market
					FROM documents AS d
					WHERE ${whereSql}
					ORDER BY ${orderSql}
					LIMIT ?`)
					.bind(
						...(kind === "company" ? [ownerId, ownerId] : [ownerId]),
						...whereBindings,
						...orderBindings,
						query.limit + 1,
					)
					.all();
				groups.push(
					result.results.map((raw) => {
						const decoded = decode("stock research", rowSchema, raw);
						const folded = decoded.hit.text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
						const position = folded.indexOf(terms[0] ?? "");
						const start = Math.max(0, position - 160);
						return {
							hit: stockResearchHitSchema.parse({
								...decoded.hit,
								title: truncateText(decoded.hit.title, 300),
								text: truncateText(decoded.hit.text.slice(start), 2400),
							}),
							market: decoded.market,
						};
					}),
				);
			}
			// Interleave corpora so news volume cannot crowd out statements or company text.
			const merged = interleaveSearchResults(groups, query.limit + 1);
			const selected = merged.slice(0, query.limit);
			const seenJpTargets = new Set<string>();
			const jpTargets: { readonly companyId: string; readonly fiscalYear: number }[] = [];
			for (const entry of selected) {
				if (entry.hit.kind !== "financials" || entry.market !== "JP") continue;
				const parsedId = parseFinancialRecordId(entry.hit.recordId);
				if (parsedId === null) continue;
				const key = `${parsedId.companyId}:${parsedId.fiscalYear}`;
				if (seenJpTargets.has(key)) continue;
				seenJpTargets.add(key);
				jpTargets.push(parsedId);
			}
			const jpFinancials = await loadJpFinancials(db, ownerId, jpTargets);
			return {
				hits: selected.map((entry) => entry.hit),
				truncated: merged.length > query.limit,
				jpFinancials: [...jpFinancials],
			};
		},
	};
}
