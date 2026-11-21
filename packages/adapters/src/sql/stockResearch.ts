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
import {
	boundedOsaDistance,
	evaluateCompanyCandidate,
	foldSqlQueryText,
	fuzzyAllowedEdits,
	interleaveSearchResults,
	type ParsedCompanyQuery,
	type ParsedCompanyTerm,
	parseCompanySearchQuery,
	parseJsonOrNull,
	stemEnglishToken,
	stockPriceSeriesId,
	type ThemeName,
	textMatchesTermDirect,
	textMatchesTermRelated,
	truncateText,
} from "@research/domain";
import { z } from "zod";
import type { SqlDatabase } from "./database.ts";
import { decode } from "./rows.ts";

/** Search vocabulary; these are retrieval aliases, not UI labels. */
const METRIC_TERMS = {
	revenue: "売上高 売上収益 営業収益 sales",
	"gross-profit": "売上総利益 gross profit",
	"basic-eps": "基本EPS 1株当たり利益 basic earnings per share EPS",
	"operating-income": "営業利益 operating profit",
	"ordinary-income": "経常利益",
	"profit-attributable-to-owners":
		"親会社株主に帰属する当期純利益 当期利益 最終利益 純利益率 利益率 net income net profit margin earnings",
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

const KNOWN_FINANCIAL_ENGLISH_WORDS = [
	"revenue",
	"revenues",
	"sales",
	"gross",
	"operating",
	"ordinary",
	"profit",
	"income",
	"attributable",
	"owners",
	"margin",
	"earnings",
	"total",
	"assets",
	"liabilities",
	"equity",
	"cash",
	"equivalents",
	"activities",
	"investing",
	"financing",
	"capital",
	"expenditures",
	"free",
	"flow",
] as const;

const financialDocumentsSql = (extraColumns = "") => `SELECT 'financials' AS kind,
	emv.company_id || ':' || emv.fiscal_year || ':' || emv.metric_code AS record_id,
	eco.market || ':' || eco.symbol || ' ' || coalesce(eco.name, '') || ' ' || coalesce(sd.local_name, '') || ' ' || replace(emv.metric_code, '-', ' ') || ' ' || (${METRIC_CASE}) AS title,
	'issuer=' || eco.market || ':' || eco.symbol || CASE WHEN eco.name IS NOT NULL AND eco.name <> '' THEN ' ' || eco.name ELSE '' END ||
	'; metric=' || emv.metric_code || '; fiscalYear=' || emv.fiscal_year ||
	'; value=' || coalesce(emv.value_decimal, 'unavailable') || '; currency=' || coalesce(emv.currency, 'unavailable') ||
	'; unit=' || CASE WHEN emv.metric_code = 'basic-eps' THEN 'currency per share' ELSE 'base currency units' END || '; periodStart=' || coalesce(emv.period_start, 'unavailable') ||
	'; periodEnd=' || coalesce(emv.period_end, 'unavailable') || '; scope=' || coalesce(emv.scope, 'unavailable') ||
	'; derived=' || emv.derived || '; reportedValueCount=' || emv.reported_value_count ||
	'; unavailableReason=' || coalesce(emv.unavailable_reason, 'none') ||
	'; concept=' || coalesce(emv.concept, 'unavailable') || '; filingId=' || coalesce(emv.filing_id, 'unavailable') AS text,
	erf.source_url AS source_url, CASE eco.provider WHEN 'sec' THEN 'SEC EDGAR' ELSE 'J-Quants' END AS publisher,
	erf.filed_on || 'T00:00:00Z' AS published_at, emv.updated_at AS retrieved_at,
	emv.period_end || 'T00:00:00Z' AS effective_at, 'regulatory-filing' AS source_class,
	CASE eco.provider WHEN 'sec' THEN 1 ELSE 0 END AS retain_quotes, 0 AS ai_generated,
	eco.market AS market, eco.symbol AS symbol${extraColumns}
	FROM equity_company AS eco
	JOIN equity_metric_value AS emv ON emv.owner_id = eco.owner_id AND emv.company_id = eco.company_id
	LEFT JOIN equity_report_filing AS erf ON erf.owner_id = emv.owner_id AND erf.filing_id = emv.filing_id
	LEFT JOIN stock_directory AS sd ON sd.owner_id = eco.owner_id AND sd.market = eco.market AND sd.symbol = eco.symbol`;

const NEWS_DOCUMENTS_SQL = `SELECT 'news' AS kind, a.article_id AS record_id, a.title AS title,
	a.title || char(10) || CASE WHEN ns.license_policy = 'short-excerpt-permitted' THEN coalesce(a.excerpt, '') ELSE '' END AS text,
	a.canonical_url AS source_url, a.publisher AS publisher, a.published_at AS published_at,
	a.retrieved_at AS retrieved_at, NULL AS effective_at, 'news' AS source_class,
	CASE WHEN ns.license_policy = 'short-excerpt-permitted' THEN 1 ELSE 0 END AS retain_quotes, 0 AS ai_generated,
	NULL AS market
	FROM articles AS a
	LEFT JOIN news_sources AS ns ON ns.owner_id = a.owner_id AND ns.source_id = a.source_id`;

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

const companyFilingRowSchema = z.object({
	record_id: z.string().min(1),
	title: z.string().min(1),
	paragraph_text: z.string().min(1),
	source_url: hitFields.sourceUrl,
	published_at: hitFields.publishedAt,
	retrieved_at: hitFields.retrievedAt,
	effective_at: hitFields.effectiveAt,
	market: z.enum(["JP", "US"]),
	symbol: z.string().min(1),
	company_name: z.string().nullable(),
	dir_name: z.string().nullable(),
	local_name: z.string().nullable(),
	sector17_name: z.string().nullable(),
	sector33_name: z.string().nullable(),
	theme_names: z.string().nullable(),
	themes_json: z.string().nullable(),
	description_en: z.string().nullable(),
	description_ja: z.string().nullable(),
	overview_json: z.string().nullable(),
});

const companySummaryRowSchema = z.object({
	record_id: z.string().min(1),
	title: z.string().min(1),
	retrieved_at: hitFields.retrievedAt,
	market: z.enum(["JP", "US"]),
	symbol: z.string().min(1),
	dir_name: z.string().nullable(),
	local_name: z.string().nullable(),
	sector17_name: z.string().nullable(),
	sector33_name: z.string().nullable(),
	theme_names: z.string().nullable(),
	themes_json: z.string().nullable(),
	description_en: z.string().nullable(),
	description_ja: z.string().nullable(),
	overview_json: z.string().nullable(),
});

const themeTupleArraySchema = z.array(z.tuple([z.string(), z.string()]));
const themeObjArraySchema = z.array(z.object({ en: z.string(), ja: z.string() }));

const overviewExtractSchema = z.object({
	feature: z.object({ en: z.string(), ja: z.string() }).nullable().optional(),
	businesses: z.array(z.object({ en: z.string(), ja: z.string() })).optional(),
	segments: z
		.array(
			z.object({
				name: z.object({ en: z.string(), ja: z.string() }),
				activity: z.object({ en: z.string(), ja: z.string() }).optional(),
			}),
		)
		.optional(),
});

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
	retrieved_at: z.string(),
	concept: z.string().nullable(),
	accounting_standard: z.string().nullable(),
	source_url: z.string().nullable(),
	filed_on: z.string().nullable(),
});

const TOKEN_BOUNDED_TERM = /^(?=.*[0-9])[0-9a-z:.-]+$/;

/** Deduplicates bound SQL parameters using numbered placeholders (`?1`, `?2`, ...), keeping D1 well below 100 vars. */
class SqlParams {
	readonly values: (string | number | null)[] = [];
	private readonly stringSlots = new Map<string, string>();

	bindString(value: string): string {
		const existing = this.stringSlots.get(value);
		if (existing !== undefined) return existing;
		this.values.push(value);
		const slot = `?${this.values.length}`;
		this.stringSlots.set(value, slot);
		return slot;
	}

	bindValue(value: string | number | null): string {
		this.values.push(value);
		return `?${this.values.length}`;
	}
}

function needleSql(params: SqlParams, haystackExpr: string, needle: string): string {
	const slot = params.bindString(needle);
	if (!TOKEN_BOUNDED_TERM.test(needle)) {
		return `instr(${haystackExpr}, ${slot}) > 0`;
	}
	return `(instr(${haystackExpr}, ${slot}) > 0 AND substr(${haystackExpr}, instr(${haystackExpr}, ${slot}) - 1, 1) NOT GLOB '[0-9a-z]' AND substr(${haystackExpr}, instr(${haystackExpr}, ${slot}) + length(${slot}), 1) NOT GLOB '[0-9a-z]')`;
}

function termNeedlesOrSql(
	params: SqlParams,
	haystackExpr: string,
	needles: readonly string[],
): string {
	if (needles.length === 0) return "0 = 1";
	if (needles.length === 1 && needles[0] !== undefined) {
		return needleSql(params, haystackExpr, needles[0]);
	}
	return `(${needles.map((n) => needleSql(params, haystackExpr, n)).join(" OR ")})`;
}

function parseThemes(themeNamesRaw: string | null, themesJsonRaw: string | null): ThemeName[] {
	if (themeNamesRaw !== null && themeNamesRaw !== "") {
		const raw = parseJsonOrNull(themeNamesRaw);
		const parsed = raw === null ? null : themeTupleArraySchema.safeParse(raw);
		if (parsed?.success === true) {
			return parsed.data.map(([en, ja]) => ({ en, ja }));
		}
	}
	if (themesJsonRaw !== null && themesJsonRaw !== "") {
		const raw = parseJsonOrNull(themesJsonRaw);
		const parsed = raw === null ? null : themeObjArraySchema.safeParse(raw);
		if (parsed?.success === true) return parsed.data;
	}
	return [];
}

function parseOverviewDetails(overviewJsonRaw: string | null): {
	readonly segmentNames: readonly ThemeName[];
	readonly readableText: string;
} {
	if (overviewJsonRaw === null || overviewJsonRaw === "") {
		return { segmentNames: [], readableText: "" };
	}
	const raw = parseJsonOrNull(overviewJsonRaw);
	const parsed = raw === null ? null : overviewExtractSchema.safeParse(raw);
	if (parsed === null || !parsed.success) return { segmentNames: [], readableText: "" };
	const segmentNames = (parsed.data.segments ?? []).map((seg) => seg.name);
	const lines: string[] = [];
	if (parsed.data.feature) {
		if (parsed.data.feature.ja !== "") lines.push(parsed.data.feature.ja);
		if (parsed.data.feature.en !== "") lines.push(parsed.data.feature.en);
	}
	for (const biz of parsed.data.businesses ?? []) {
		if (biz.ja !== "") lines.push(biz.ja);
		if (biz.en !== "") lines.push(biz.en);
	}
	return { segmentNames, readableText: lines.join("\n") };
}

function formatAiCompanyText(input: {
	readonly sector33Name: string | null;
	readonly sector17Name: string | null;
	readonly themes: readonly ThemeName[];
	readonly segmentNames: readonly ThemeName[];
	readonly descriptionJa: string | null;
	readonly descriptionEn: string | null;
	readonly overviewReadableText: string;
}): string {
	const headerParts: string[] = [];
	const sector = input.sector33Name ?? input.sector17Name;
	if (sector !== null && sector !== "") {
		headerParts.push(`Sector: ${sector}`);
	}
	if (input.themes.length > 0) {
		const formattedThemes = input.themes
			.map((t) => (t.ja !== "" && t.ja !== t.en ? `${t.ja} (${t.en})` : t.en || t.ja))
			.join(", ");
		headerParts.push(`Themes: ${formattedThemes}`);
	}
	if (input.segmentNames.length > 0) {
		const formattedSegments = input.segmentNames
			.map((s) => (s.ja !== "" && s.ja !== s.en ? `${s.ja} (${s.en})` : s.en || s.ja))
			.join(", ");
		headerParts.push(`Segments: ${formattedSegments}`);
	}
	const bodyParts: string[] = [];
	if (input.descriptionJa !== null && input.descriptionJa !== "")
		bodyParts.push(input.descriptionJa);
	if (input.descriptionEn !== null && input.descriptionEn !== "")
		bodyParts.push(input.descriptionEn);
	if (input.overviewReadableText !== "") bodyParts.push(input.overviewReadableText);

	const combined = [
		...(headerParts.length > 0 ? [headerParts.join(" | ")] : []),
		...bodyParts,
	].join("\n");
	return combined !== "" ? combined : "AI-written company overview";
}

function findSnippetStart(text: string, terms: readonly ParsedCompanyTerm[]): number {
	const folded = text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
	for (const term of terms) {
		for (const candidate of [term.folded, ...term.directVariants, ...term.relatedVariants]) {
			if (candidate === "") continue;
			const pos = folded.indexOf(candidate);
			if (pos >= 0) return Math.max(0, pos - 160);
		}
	}
	return 0;
}

const COMPANY_CANDIDATE_SCAN_LIMIT = 120;

async function runCompanySqlPass(
	db: SqlDatabase,
	ownerId: string,
	parsedQuery: ParsedCompanyQuery,
	termNeedles: readonly (readonly string[])[],
	includeFilings: boolean,
): Promise<{
	readonly filingResults: readonly Record<string, unknown>[];
	readonly summaryResults: readonly Record<string, unknown>[];
}> {
	// Branch B: Stored AI company overviews & summaries (`stock_company_summary`).
	// Computes the compact ~180-byte `h_struct` ONCE per row in a CTE without touching 65 MB of `overview_json`!
	const summaryParams = new SqlParams();
	const summaryOwnerSlot = summaryParams.bindString(ownerId);
	const summaryMarketClause =
		parsedQuery.marketFilter === null
			? "1 = 1"
			: `scs.market = ${summaryParams.bindString(parsedQuery.marketFilter)}`;
	const anyTermInStructSql = `(${termNeedles
		.map((needles) => termNeedlesOrSql(summaryParams, "c.h_struct", needles))
		.join(" OR ")})`;
	const summaryLimitSlot = summaryParams.bindValue(COMPANY_CANDIDATE_SCAN_LIMIT);

	const summarySql = `WITH struct_scan AS MATERIALIZED (
		SELECT
			scs.market AS market,
			scs.symbol AS symbol,
			sd.name AS dir_name,
			sd.local_name AS local_name,
			scp.sector17_name AS sector17_name,
			scp.sector33_name AS sector33_name,
			lower(scs.market || ':' || scs.symbol) || ' ' || coalesce(sd.name_key, '') || ' ' || coalesce(sd.local_name, '') || ' ' || coalesce(lower(scs.theme_names), '') || ' ' || coalesce(scp.sector33_name, '') || ' ' || coalesce(scp.sector17_name, '') AS h_struct
		FROM stock_company_summary AS scs
		LEFT JOIN stock_directory AS sd ON sd.owner_id = scs.owner_id AND sd.market = scs.market AND sd.symbol = scs.symbol
		LEFT JOIN stock_company_profile AS scp ON scp.owner_id = scs.owner_id AND scp.market = scs.market AND scp.symbol = scs.symbol
		WHERE scs.owner_id = ${summaryOwnerSlot}
			AND (scs.generated_at IS NOT NULL OR scs.overview_generated_at IS NOT NULL)
			AND ${summaryMarketClause}
	),
	matched_keys AS (
		SELECT s.market, s.symbol, s.dir_name, s.local_name, s.sector17_name, s.sector33_name
		FROM struct_scan AS s
		WHERE ${anyTermInStructSql.replaceAll("c.h_struct", "s.h_struct")}
	)
	SELECT
		scs.market || ':' || scs.symbol AS record_id,
		scs.market || ':' || scs.symbol || ' ' || CASE
			WHEN m.local_name IS NOT NULL AND m.local_name <> '' THEN
				CASE
					WHEN m.dir_name IS NOT NULL AND m.dir_name <> '' THEN m.local_name || ' (' || m.dir_name || ')'
					ELSE m.local_name
				END
			ELSE coalesce(m.dir_name, '')
		END || ' AI-written company overview' AS title,
		coalesce(scs.overview_generated_at, scs.generated_at) AS retrieved_at,
		scs.market AS market,
		scs.symbol AS symbol,
		m.dir_name AS dir_name,
		m.local_name AS local_name,
		m.sector17_name AS sector17_name,
		m.sector33_name AS sector33_name,
		scs.theme_names AS theme_names,
		scs.themes_json AS themes_json,
		scs.description_en AS description_en,
		scs.description_ja AS description_ja,
		scs.overview_json AS overview_json
	FROM matched_keys AS m
	JOIN stock_company_summary AS scs
		ON scs.owner_id = ${summaryOwnerSlot} AND scs.market = m.market AND scs.symbol = m.symbol
	ORDER BY retrieved_at DESC, record_id DESC
	LIMIT ${summaryLimitSlot}`;

	if (!includeFilings) {
		const summaryRows = await db
			.prepare(summarySql)
			.bind(...summaryParams.values)
			.all();
		return { filingResults: [], summaryResults: summaryRows.results };
	}

	// Branch A: Citeable regulatory filings (`equity_business_description`).
	// Filters summarized companies at the company level BEFORE expanding `json_each(paragraphs_json)`.
	const filingParams = new SqlParams();
	const filingOwnerSlot = filingParams.bindString(ownerId);
	const filingMarketClause =
		parsedQuery.marketFilter === null
			? "1 = 1"
			: `eco.market = ${filingParams.bindString(parsedQuery.marketFilter)}`;
	const companyAnchorSql = `(fc.has_summary = 0 OR ${termNeedles
		.map((needles) => termNeedlesOrSql(filingParams, "fc.h_struct", needles))
		.join(" OR ")})`;
	const paragraphWhereSql = termNeedles
		.map((needles) => termNeedlesOrSql(filingParams, "fp.h_doc", needles))
		.join(" AND ");
	const filingLimitSlot = filingParams.bindValue(COMPANY_CANDIDATE_SCAN_LIMIT);

	const filingSql = `WITH filing_companies AS MATERIALIZED (
		SELECT
			eco.company_id AS company_id,
			eco.market AS market,
			eco.symbol AS symbol,
			eco.name AS company_name,
			sd.name AS dir_name,
			sd.local_name AS local_name,
			scp.sector17_name AS sector17_name,
			scp.sector33_name AS sector33_name,
			CASE WHEN scs.theme_names IS NOT NULL OR scs.themes_json IS NOT NULL THEN 1 ELSE 0 END AS has_summary,
			lower(eco.market || ':' || eco.symbol) || ' ' || lower(coalesce(eco.name, '')) || ' ' || coalesce(sd.local_name, '') || ' ' || coalesce(sd.name_key, '') || ' ' || coalesce(lower(scs.theme_names), '') || ' ' || coalesce(scp.sector33_name, '') || ' ' || coalesce(scp.sector17_name, '') AS h_struct
		FROM equity_company AS eco
		JOIN equity_business_description AS ebd_chk ON ebd_chk.owner_id = eco.owner_id AND ebd_chk.company_id = eco.company_id
		LEFT JOIN stock_directory AS sd ON sd.owner_id = eco.owner_id AND sd.market = eco.market AND sd.symbol = eco.symbol
		LEFT JOIN stock_company_profile AS scp ON scp.owner_id = eco.owner_id AND scp.market = eco.market AND scp.symbol = eco.symbol
		LEFT JOIN stock_company_summary AS scs ON scs.owner_id = eco.owner_id AND scs.market = eco.market AND scs.symbol = eco.symbol
		WHERE eco.owner_id = ${filingOwnerSlot}
			AND ebd_chk.status = 'extracted'
			AND ${filingMarketClause}
	),
	matched_companies AS MATERIALIZED (
		SELECT
			fc.company_id,
			fc.market,
			fc.symbol,
			fc.company_name,
			fc.dir_name,
			fc.local_name,
			fc.sector17_name,
			fc.sector33_name
		FROM filing_companies AS fc
		WHERE ${companyAnchorSql}
	),
	filing_paragraphs AS MATERIALIZED (
		SELECT
			mc.company_id || ':' || p.key AS record_id,
			mc.market || ':' || mc.symbol || ' ' || coalesce(mc.company_name, '') || ' business description' AS title,
			json_extract(p.value, '$.text') AS paragraph_text,
			ebd.source_url AS source_url,
			ebd.filed_on || 'T00:00:00Z' AS published_at,
			ebd.fetched_at AS retrieved_at,
			ebd.period_end || 'T00:00:00Z' AS effective_at,
			mc.market AS market,
			mc.symbol AS symbol,
			mc.company_name AS company_name,
			mc.dir_name AS dir_name,
			mc.local_name AS local_name,
			mc.sector17_name AS sector17_name,
			mc.sector33_name AS sector33_name,
			scs.theme_names AS theme_names,
			scs.themes_json AS themes_json,
			scs.description_en AS description_en,
			scs.description_ja AS description_ja,
			scs.overview_json AS overview_json,
			lower(mc.market || ':' || mc.symbol || ' ' || coalesce(mc.company_name, '') || ' ' || coalesce(mc.local_name, '') || char(10) || json_extract(p.value, '$.text')) AS h_doc
		FROM matched_companies AS mc
		JOIN equity_business_description AS ebd ON ebd.owner_id = ${filingOwnerSlot} AND ebd.company_id = mc.company_id
		LEFT JOIN stock_company_summary AS scs ON scs.owner_id = ${filingOwnerSlot} AND scs.market = mc.market AND scs.symbol = mc.symbol
		JOIN json_each(ebd.paragraphs_json) AS p
	)
	SELECT fp.record_id, fp.title, fp.paragraph_text, fp.source_url, fp.published_at, fp.retrieved_at,
		fp.effective_at, fp.market, fp.symbol, fp.company_name, fp.dir_name, fp.local_name,
		fp.sector17_name, fp.sector33_name, fp.theme_names, fp.themes_json, fp.description_en, fp.description_ja, fp.overview_json
	FROM filing_paragraphs AS fp
	WHERE ${paragraphWhereSql}
	ORDER BY fp.retrieved_at DESC, fp.record_id DESC
	LIMIT ${filingLimitSlot}`;

	const [filingRows, summaryRows] = await Promise.all([
		db
			.prepare(filingSql)
			.bind(...filingParams.values)
			.all(),
		db
			.prepare(summarySql)
			.bind(...summaryParams.values)
			.all(),
	]);
	return { filingResults: filingRows.results, summaryResults: summaryRows.results };
}

async function searchCompanyCorpus(
	db: SqlDatabase,
	ownerId: string,
	parsedQuery: ParsedCompanyQuery,
	limit: number,
): Promise<{ readonly hit: StockResearchHit; readonly market: "JP" | "US" | null }[]> {
	if (parsedQuery.terms.length === 0) return [];

	// Keep per-term SQL needles bounded so even 8-term queries stay well under D1's 100-variable cap.
	const maxNeedlesPerTerm = Math.max(3, Math.floor(64 / parsedQuery.terms.length));
	const primaryNeedles = parsedQuery.terms.map((t) => t.sqlNeedles.slice(0, maxNeedlesPerTerm));

	const scoreRows = (
		filingResults: readonly Record<string, unknown>[],
		summaryResults: readonly Record<string, unknown>[],
	) => {
		const filingRows = { results: filingResults };
		const summaryRows = { results: summaryResults };

		interface ScoredCandidate {
			readonly rank: number;
			readonly retrievedAt: string;
			readonly recordId: string;
			readonly hit: StockResearchHit;
			readonly market: "JP" | "US";
			readonly companyKey: string;
			readonly isFiling: boolean;
			readonly isIdentity: boolean;
		}
		const scored: ScoredCandidate[] = [];

		for (const raw of filingRows.results) {
			const row = decode("stock research company filing", companyFilingRowSchema, raw);
			const themes = parseThemes(row.theme_names, row.themes_json);
			const overview = parseOverviewDetails(row.overview_json);
			const hasSummary = row.theme_names !== null || row.themes_json !== null;
			const summaryContext = [
				row.description_en ?? "",
				row.description_ja ?? "",
				overview.readableText,
			]
				.filter((s) => s !== "")
				.join("\n");
			const evaluation = evaluateCompanyCandidate(
				{
					market: row.market,
					symbol: row.symbol,
					name: row.company_name ?? row.dir_name,
					localName: row.local_name,
					hasSummary,
					themes,
					sector17Name: row.sector17_name,
					sector33Name: row.sector33_name,
					segmentNames: overview.segmentNames,
					bodyText:
						summaryContext !== "" ? `${row.paragraph_text}\n${summaryContext}` : row.paragraph_text,
					documentText: `${row.title}\n${row.paragraph_text}`,
				},
				parsedQuery,
			);
			if (evaluation === null) continue;
			// Also ensure the specific SEC paragraph itself isn't a divested/customer-only note when unanchored:
			if (evaluation.tier === "activeFiling") {
				const paragraphEval = evaluateCompanyCandidate(
					{
						market: row.market,
						symbol: row.symbol,
						name: row.company_name ?? row.dir_name,
						localName: row.local_name,
						hasSummary: false,
						themes: [],
						sector17Name: null,
						sector33Name: null,
						segmentNames: [],
						bodyText: row.paragraph_text,
					},
					parsedQuery,
				);
				if (paragraphEval === null) continue;
			}
			const start = findSnippetStart(row.paragraph_text, parsedQuery.terms);
			const hit = stockResearchHitSchema.parse({
				kind: "company",
				recordId: row.record_id,
				title: truncateText(row.title, 300),
				text: truncateText(row.paragraph_text.slice(start), 2400),
				sourceUrl: row.source_url,
				publisher: "SEC EDGAR",
				publishedAt: row.published_at,
				retrievedAt: row.retrieved_at,
				effectiveAt: row.effective_at,
				sourceClass: "regulatory-filing",
				retainQuotes: true,
				aiGenerated: false,
			});
			scored.push({
				rank: evaluation.rank,
				retrievedAt: row.retrieved_at,
				recordId: row.record_id,
				hit,
				market: row.market,
				companyKey: `${row.market}:${row.symbol}`,
				isFiling: true,
				isIdentity: evaluation.hasIdentityTerm,
			});
		}

		for (const raw of summaryRows.results) {
			const row = decode("stock research company summary", companySummaryRowSchema, raw);
			const themes = parseThemes(row.theme_names, row.themes_json);
			const overview = parseOverviewDetails(row.overview_json);
			const bodyParts = [
				row.description_en ?? "",
				row.description_ja ?? "",
				overview.readableText,
			].filter((s) => s !== "");
			const evaluation = evaluateCompanyCandidate(
				{
					market: row.market,
					symbol: row.symbol,
					name: row.dir_name,
					localName: row.local_name,
					hasSummary: true,
					themes,
					sector17Name: row.sector17_name,
					sector33Name: row.sector33_name,
					segmentNames: overview.segmentNames,
					bodyText: bodyParts.join("\n"),
				},
				parsedQuery,
			);
			if (evaluation === null) continue;
			const formattedText = formatAiCompanyText({
				sector33Name: row.sector33_name,
				sector17Name: row.sector17_name,
				themes,
				segmentNames: overview.segmentNames,
				descriptionJa: row.description_ja,
				descriptionEn: row.description_en,
				overviewReadableText: overview.readableText,
			});
			const hit = stockResearchHitSchema.parse({
				kind: "company",
				recordId: row.record_id,
				title: truncateText(row.title, 300),
				text: truncateText(formattedText, 2400),
				sourceUrl: null,
				publisher: "AI-written stored context",
				publishedAt: null,
				retrievedAt: row.retrieved_at,
				effectiveAt: null,
				sourceClass: "other",
				retainQuotes: false,
				aiGenerated: true,
			});
			scored.push({
				rank: evaluation.rank,
				retrievedAt: row.retrieved_at,
				recordId: row.record_id,
				hit,
				market: row.market,
				companyKey: `${row.market}:${row.symbol}`,
				isFiling: false,
				isIdentity: evaluation.tier === "identity",
			});
		}

		scored.sort((a, b) => {
			if (a.rank !== b.rank) return a.rank - b.rank;
			if (a.retrievedAt !== b.retrievedAt) return a.retrievedAt > b.retrievedAt ? -1 : 1;
			if (a.recordId !== b.recordId) return a.recordId > b.recordId ? -1 : 1;
			return 0;
		});

		// On non-identity thematic queries, cap regulatory-filing paragraphs at 1 per company so a single
		// 50-paragraph 10-K cannot crowd out other candidates while preserving multi-paragraph company lookups.
		const seenThematicFilingCompany = new Set<string>();
		const deduped: ScoredCandidate[] = [];
		for (const item of scored) {
			if (item.isFiling && !item.isIdentity) {
				if (seenThematicFilingCompany.has(item.companyKey)) continue;
				seenThematicFilingCompany.add(item.companyKey);
			}
			deduped.push(item);
		}
		return deduped;
	};

	const phase1 = await runCompanySqlPass(db, ownerId, parsedQuery, primaryNeedles, true);
	let scored = scoreRows(phase1.filingResults, phase1.summaryResults);

	if (scored.length === 0 && parsedQuery.terms.some((t) => t.fuzzySqlSlices.length > 0)) {
		const fuzzyNeedles = parsedQuery.terms.map((t) =>
			t.fuzzySqlSlices.length > 0
				? t.fuzzySqlSlices.slice(0, maxNeedlesPerTerm)
				: t.sqlNeedles.slice(0, maxNeedlesPerTerm),
		);
		const phase2 = await runCompanySqlPass(db, ownerId, parsedQuery, fuzzyNeedles, true);
		scored = scoreRows(phase2.filingResults, phase2.summaryResults);
	}

	return scored.slice(0, limit + 1).map(({ hit, market }) => ({ hit, market }));
}

const KNOWN_FINANCIAL_ENGLISH_SET: ReadonlySet<string> = new Set(KNOWN_FINANCIAL_ENGLISH_WORDS);

function isShortAsciiTickerTerm(term: string): boolean {
	return /^[a-z:.-]{1,4}$/.test(term) && !KNOWN_FINANCIAL_ENGLISH_SET.has(term);
}

function tokenBoundedNeedleSql(params: SqlParams, haystackExpr: string, needle: string): string {
	const slot = params.bindString(needle);
	return `(instr(${haystackExpr}, ${slot}) > 0 AND substr(${haystackExpr}, instr(${haystackExpr}, ${slot}) - 1, 1) NOT GLOB '[0-9a-z]' AND substr(${haystackExpr}, instr(${haystackExpr}, ${slot}) + length(${slot}), 1) NOT GLOB '[0-9a-z]')`;
}

function financialTermWhereSql(params: SqlParams, haystackExpr: string, term: string): string {
	if (TOKEN_BOUNDED_TERM.test(term) || isShortAsciiTickerTerm(term)) {
		const slot = params.bindString(term);
		return `(lower(d.symbol) = ${slot} OR lower(d.market || ':' || d.symbol) = ${slot} OR ${tokenBoundedNeedleSql(params, haystackExpr, term)})`;
	}
	return termNeedlesOrSql(params, haystackExpr, expandFinancialTermNeedles(term));
}

function expandFinancialTermNeedles(term: string): readonly string[] {
	if (TOKEN_BOUNDED_TERM.test(term)) return [term];
	const needles = new Set<string>([term]);
	if (/^[a-z]+$/.test(term)) {
		const stem = stemEnglishToken(term);
		if (stem.length >= 3) needles.add(stem);
		const maxEdits = fuzzyAllowedEdits("ascii", term.length);
		if (maxEdits > 0) {
			for (const word of KNOWN_FINANCIAL_ENGLISH_WORDS) {
				if (word[0] === term[0] && boundedOsaDistance(term, word, maxEdits) !== null) {
					needles.add(word);
				}
			}
		}
	}
	return [...needles];
}

async function searchFinancialsCorpus(
	db: SqlDatabase,
	ownerId: string,
	rawQuery: string,
	limit: number,
): Promise<{ readonly hit: StockResearchHit; readonly market: "JP" | "US" | null }[]> {
	const rawTerms = foldSqlQueryText(rawQuery)
		.split(/\s+/u)
		.filter((t) => t.length > 0);
	if (rawTerms.length === 0) return [];
	const params = new SqlParams();
	const ownerSlot = params.bindString(ownerId);
	const haystack = "lower(d.title || char(10) || d.text)";
	const whereSql = rawTerms
		.map((term) => financialTermWhereSql(params, haystack, term))
		.join(" AND ");
	const symbolPrioritySql = rawTerms
		.map((term) => {
			const slot = params.bindString(term);
			return `lower(d.symbol) = ${slot} OR lower(d.market || ':' || d.symbol) = ${slot}`;
		})
		.join(" OR ");
	const limitSlot = params.bindValue(limit + 1);

	const result = await db
		.prepare(`WITH documents AS (${financialDocumentsSql()} WHERE eco.owner_id = ${ownerSlot})
			SELECT d.kind, d.record_id, d.title, d.text, d.source_url, d.publisher, d.published_at, d.retrieved_at, d.effective_at, d.source_class, d.retain_quotes, d.ai_generated, d.market
			FROM documents AS d
			WHERE ${whereSql}
			ORDER BY CASE WHEN (${symbolPrioritySql}) THEN 1 ELSE 0 END DESC, d.retrieved_at DESC, d.record_id DESC
			LIMIT ${limitSlot}`)
		.bind(...params.values)
		.all();

	return result.results.map((raw) => {
		const decoded = decode("stock research financials", rowSchema, raw);
		return {
			hit: stockResearchHitSchema.parse({
				...decoded.hit,
				title: truncateText(decoded.hit.title, 300),
				text: truncateText(decoded.hit.text, 2400),
			}),
			market: decoded.market,
		};
	});
}

async function searchNewsCorpus(
	db: SqlDatabase,
	ownerId: string,
	parsedQuery: ParsedCompanyQuery,
	rawQuery: string,
	limit: number,
): Promise<{ readonly hit: StockResearchHit; readonly market: "JP" | "US" | null }[]> {
	const rawTerms = foldSqlQueryText(rawQuery)
		.split(/\s+/u)
		.filter((t) => t.length > 0);
	if (rawTerms.length === 0) return [];
	const termsForNews =
		parsedQuery.marketFilter !== null
			? parseCompanySearchQuery(`${rawQuery} `).rawTerms.map(
					(t) => parseCompanySearchQuery(t).terms[0],
				)
			: parsedQuery.terms;
	const activeTerms = termsForNews.filter((t): t is ParsedCompanyTerm => t !== undefined);
	if (activeTerms.length === 0) return [];

	const params = new SqlParams();
	const ownerSlot = params.bindString(ownerId);
	const haystack = "lower(d.title || char(10) || d.text)";
	const maxNeedlesPerTerm = Math.max(3, Math.floor(64 / activeTerms.length));
	const whereSql = activeTerms
		.map((term) => termNeedlesOrSql(params, haystack, term.sqlNeedles.slice(0, maxNeedlesPerTerm)))
		.join(" AND ");
	// Fetch a small cushion so JS verification of fuzzy/pigeonhole hits still fills `limit + 1`.
	const scanLimit = Math.max(limit + 1, (limit + 1) * 4);
	const limitSlot = params.bindValue(scanLimit);

	const result = await db
		.prepare(`WITH documents AS (${NEWS_DOCUMENTS_SQL} WHERE a.owner_id = ${ownerSlot})
			SELECT d.kind, d.record_id, d.title, d.text, d.source_url, d.publisher, d.published_at, d.retrieved_at, d.effective_at, d.source_class, d.retain_quotes, d.ai_generated, d.market
			FROM documents AS d
			WHERE ${whereSql}
			ORDER BY d.retrieved_at DESC, d.record_id DESC
			LIMIT ${limitSlot}`)
		.bind(...params.values)
		.all();

	const verified: { readonly hit: StockResearchHit; readonly market: "JP" | "US" | null }[] = [];
	for (const raw of result.results) {
		const decoded = decode("stock research news", rowSchema, raw);
		const combined = `${decoded.hit.title}\n${decoded.hit.text}`;
		const allMatch = activeTerms.every(
			(term) => textMatchesTermDirect(combined, term) || textMatchesTermRelated(combined, term),
		);
		if (!allMatch) continue;
		const start = findSnippetStart(decoded.hit.text, activeTerms);
		verified.push({
			hit: stockResearchHitSchema.parse({
				...decoded.hit,
				title: truncateText(decoded.hit.title, 300),
				text: truncateText(decoded.hit.text.slice(start), 2400),
			}),
			market: decoded.market,
		});
		if (verified.length >= limit + 1) break;
	}
	return verified;
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
	const distinctCompanyIds = [...new Set(targets.map((t) => t.companyId))];
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

const VALUATION_CURRENCY = /^currency=([a-z]{3})$/;
const VALUATION_FILTER = /^(eps|per|pe|p\/e)(<=|>=|=|<|>)(-?\d+(?:\.\d+)?)$/;

async function screenStockValuations(
	db: SqlDatabase,
	ownerId: string,
	rawQuery: string,
	limit: number,
): Promise<StockResearchHit[] | null> {
	const terms = foldSqlQueryText(rawQuery).split(/\s+/u);
	const filters = terms.flatMap((term) => {
		const match = VALUATION_FILTER.exec(term);
		return match === null
			? []
			: [{ metric: match[1], operator: match[2], value: Number(match[3]) }];
	});
	if (filters.length === 0) return null;
	const needsPrice = filters.some((filter) => filter.metric !== "eps");
	const params = new SqlParams();
	const owner = params.bindString(ownerId);
	const bounds = filters.map(
		(filter) =>
			`${filter.metric === "eps" ? "d.eps_value" : "d.per"} ${filter.operator} ${params.bindValue(filter.value)}`,
	);
	const textTerms = terms.filter((term) => !VALUATION_FILTER.test(term));
	const matches = textTerms.map((term) => {
		if (term === "jp" || term === "us")
			return `d.market = ${params.bindString(term.toUpperCase())}`;
		const currency = VALUATION_CURRENCY.exec(term)?.[1];
		if (currency !== undefined)
			return `d.eps_currency = ${params.bindString(currency.toUpperCase())}`;
		return financialTermWhereSql(params, "lower(d.title)", term);
	});
	// Use the same series identifiers and the same annual period as the Stocks page.
	const stockMarker = "_ticker_";
	const usSeries = needsPrice ? params.bindString(stockPriceSeriesId("US", stockMarker)) : "";
	const jpSeries = needsPrice ? params.bindString(stockPriceSeriesId("JP", stockMarker)) : "";
	const priceJoins = needsPrice
		? `JOIN market_series AS ms
			ON ms.owner_id = eco.owner_id AND ms.unit = emv.currency
			AND ms.series_id = replace(CASE eco.market WHEN 'JP' THEN ${jpSeries} ELSE ${usSeries} END, '${stockMarker}', eco.symbol)
		JOIN market_observations AS mo
			ON mo.owner_id = ms.owner_id AND mo.series_id = ms.series_id
			AND mo.observed_on = (
				SELECT max(latest.observed_on)
				FROM market_observations AS latest
				WHERE latest.owner_id = ms.owner_id AND latest.series_id = ms.series_id
			)
			AND mo.observed_on >= emv.period_end AND mo.value > 0`
		: "";
	const priceColumns = needsPrice
		? ", mo.value / emv.value_real AS per, mo.value AS close, mo.observed_on AS close_date, ms.publisher AS close_publisher, ms.source_url AS close_url"
		: "";
	const limitSlot = params.bindValue(limit + 1);
	const result = await db
		.prepare(`WITH documents AS (
		${financialDocumentsSql(`, emv.value_real AS eps_value, emv.currency AS eps_currency${priceColumns}`)}
		${priceJoins}
		WHERE eco.owner_id = ${owner}
			AND emv.metric_code = 'basic-eps' AND emv.value_real IS NOT NULL
			${needsPrice ? "AND emv.value_real > 0" : ""}
			AND emv.fiscal_year = (
				SELECT recent.fiscal_year FROM equity_metric_value AS recent
				WHERE recent.owner_id = eco.owner_id AND recent.company_id = eco.company_id
					AND (recent.value_decimal IS NOT NULL OR recent.unavailable_reason <> 'not-reported')
				ORDER BY recent.fiscal_year DESC LIMIT 1
			)
	)
	SELECT d.* FROM documents AS d
	WHERE ${[...bounds, ...matches].join(" AND ")}
	ORDER BY ${needsPrice ? "d.per ASC" : "d.eps_value DESC"}, d.record_id ASC
	LIMIT ${limitSlot}`)
		.bind(...params.values)
		.all();
	return result.results.map((raw) => {
		const { hit } = decode("stock valuation screening", rowSchema, raw);
		if (!needsPrice) {
			return stockResearchHitSchema.parse({ ...hit, title: truncateText(hit.title, 300) });
		}
		const price = decode("stock valuation close", valuationPriceSchema, raw);
		const details = `Calculated P/E (PER)=${price.per}; close=${price.close}; closeDate=${price.close_date}; pricePublisher=${price.close_publisher}; priceSource=${price.close_url}. P/E uses reported basic EPS and the stored close.`;
		return stockResearchHitSchema.parse({
			...hit,
			title: truncateText(hit.title, 300),
			text: truncateText(hit.text.replace("; metric=", `; ${details}\nmetric=`), 2400),
		});
	});
}

const valuationPriceSchema = z.object({
	per: z.number().positive(),
	close: z.number().positive(),
	close_date: z.string(),
	close_publisher: z.string(),
	close_url: z.string(),
});

export function createStockResearchRepository(db: SqlDatabase): StockResearchRepository {
	return {
		async search(ownerId, input) {
			const query = stockResearchQuerySchema.parse(input);
			if (query.kind === undefined || query.kind === "financials") {
				const screen = await screenStockValuations(db, ownerId, query.query, query.limit);
				if (screen !== null) {
					return {
						hits: screen.slice(0, query.limit),
						truncated: screen.length > query.limit,
						jpFinancials: [],
					};
				}
			}
			const parsedCompanyQuery = parseCompanySearchQuery(query.query);
			const kinds =
				query.kind === undefined ? (["company", "financials", "news"] as const) : [query.kind];

			const groups = await Promise.all(
				kinds.map((kind) => {
					if (kind === "company") {
						return searchCompanyCorpus(db, ownerId, parsedCompanyQuery, query.limit);
					}
					if (kind === "financials") {
						return searchFinancialsCorpus(db, ownerId, query.query, query.limit);
					}
					return searchNewsCorpus(db, ownerId, parsedCompanyQuery, query.query, query.limit);
				}),
			);

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
