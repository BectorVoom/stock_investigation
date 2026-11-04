import { spawnSync } from "node:child_process";
import {
	type CompanyOverviewEntry,
	type CompanyOverviewView,
	companyOverviewEntrySchema,
	companyOverviewViewSchema,
} from "@research/contracts";
import { z } from "zod";
import type { CompanySource, Figure, FigureMetric, SourceId, StoredProfile } from "./template.ts";

/**
 * The numbered sources of one stock, built from what the server has stored
 * — the stock directory, a US company's annual-report business section, a
 * Japanese company's J-Quants profile and the stored annual figures — read
 * from a local database file with the `sqlite3` CLI in read-only mode.
 */

/** How much of the 10-K business section the model may quote (production sends 4,000). */
export const MAX_BUSINESS_CHARS = 24_000;

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const JPX_LISTED_ISSUES_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html";

export interface StockKey {
	readonly market: "US" | "JP";
	readonly symbol: string;
}

/** Runs one read-only query; rows parsed with `schema`. Symbols are checked before they reach SQL. */
function query<T>(databasePath: string, sql: string, schema: z.ZodType<T>): T[] {
	const result = spawnSync("sqlite3", ["-readonly", "-json", databasePath, sql], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(`sqlite3 failed (${result.status}): ${result.stderr.trim()}`);
	}
	const text = result.stdout.trim();
	return text === "" ? [] : z.array(schema).parse(JSON.parse(text));
}

const SYMBOL = /^[A-Z0-9.-]{1,16}$/;

const stockKeyRow = z.object({ market: z.enum(["US", "JP"]), symbol: z.string().regex(SYMBOL) });

function keyClause(alias: string, key: StockKey): string {
	if (!SYMBOL.test(key.symbol)) throw new Error(`unexpected symbol ${key.symbol}`);
	return `${alias}.market = '${key.market}' AND ${alias}.symbol = '${key.symbol}'`;
}

/** The single owner of the Watchlist (one owner per database, API-004). */
export function ownerOf(databasePath: string): string {
	const owners = query(
		databasePath,
		"SELECT DISTINCT owner_id FROM watchlist_stocks",
		z.object({ owner_id: z.string().min(1) }),
	);
	const [owner] = owners;
	if (owner === undefined || owners.length > 1) {
		throw new Error(`expected one Watchlist owner, found ${owners.length}`);
	}
	return owner.owner_id;
}

export function watchlistStocks(databasePath: string): StockKey[] {
	return query(
		databasePath,
		"SELECT market, symbol FROM watchlist_stocks ORDER BY market, symbol",
		stockKeyRow,
	);
}

/**
 * Every stock-list stock, the order web-search credits are spent in
 * (the free Tavily plan runs out long before the list does): the
 * Watchlist first, then Japanese stocks by TOPIX size (Core30 first) — a
 * Japanese company has no stored business text, so its entry depends on
 * the web — then the rest. A US company with a stored 10-K business
 * section needs no web search and may come anywhere.
 */
export function directoryStocks(databasePath: string): StockKey[] {
	return query(
		databasePath,
		`SELECT d.market, d.symbol
		 FROM stock_directory AS d
		 LEFT JOIN stock_company_profile AS p ON p.market = d.market AND p.symbol = d.symbol
		 ORDER BY
		     EXISTS (SELECT 1 FROM watchlist_stocks AS w WHERE w.market = d.market AND w.symbol = d.symbol) DESC,
		     CASE p.scale_category
		         WHEN 'TOPIX Core30' THEN 1
		         WHEN 'TOPIX Large70' THEN 2
		         WHEN 'TOPIX Mid400' THEN 3
		         WHEN 'TOPIX Small 1' THEN 4
		         WHEN 'TOPIX Small 2' THEN 5
		         ELSE 6
		     END,
		     d.market DESC, d.symbol`,
		stockKeyRow,
	);
}

/** The stocks whose overview is already stored: "MARKET:SYMBOL" → when it was written. */
export function storedOverviewKeys(databasePath: string): Map<string, string> {
	const rows = query(
		databasePath,
		`SELECT scs.market, scs.symbol, scs.overview_generated_at
		 FROM stock_company_summary AS scs WHERE scs.overview_generated_at IS NOT NULL`,
		stockKeyRow.extend({ overview_generated_at: z.string() }),
	);
	return new Map(rows.map((row) => [`${row.market}:${row.symbol}`, row.overview_generated_at]));
}

/**
 * The issuer of a US preferred share, warrant, unit or right ("AHL-PD" →
 * "AHL", "AAC-WT" → "AAC") when the issuer is itself in `listed`, else
 * null. 472 of the 532 such listings have one (2026-11-04).
 */
export function issuerOf(stock: StockKey, listed: ReadonlySet<string>): StockKey | null {
	if (stock.market !== "US") return null;
	const match = /^([A-Z0-9.]+)-[A-Z]{1,3}$/.exec(stock.symbol);
	const base = match?.[1];
	if (base === undefined || !listed.has(`US:${base}`)) return null;
	return { market: "US", symbol: base };
}

/** A stock's whole stored overview (entry, facts, references, who wrote it), or null. */
export function storedOverviewView(
	databasePath: string,
	stock: StockKey,
): CompanyOverviewView | null {
	const [row] = query(
		databasePath,
		`SELECT scs.overview_json, scs.overview_facts_json, scs.overview_references_json,
		        scs.overview_agent_id, scs.overview_model, scs.overview_generated_at
		 FROM stock_company_summary AS scs
		 WHERE ${keyClause("scs", stock)} AND scs.overview_json IS NOT NULL`,
		z.object({
			overview_json: z.string(),
			overview_facts_json: z.string(),
			overview_references_json: z.string(),
			overview_agent_id: z.string(),
			overview_model: z.string().nullable(),
			overview_generated_at: z.string(),
		}),
	);
	if (row === undefined) return null;
	const parsed = companyOverviewViewSchema.safeParse({
		entry: JSON.parse(row.overview_json),
		facts: JSON.parse(row.overview_facts_json),
		references: JSON.parse(row.overview_references_json),
		agentId: row.overview_agent_id,
		model: row.overview_model,
		generatedAt: row.overview_generated_at,
	});
	return parsed.success ? parsed.data : null;
}

/** A stock's stored overview entry, or null when none is stored (or it no longer reads). */
export function storedOverviewEntry(
	databasePath: string,
	stock: StockKey,
): CompanyOverviewEntry | null {
	const [row] = query(
		databasePath,
		`SELECT scs.overview_json FROM stock_company_summary AS scs
		 WHERE ${keyClause("scs", stock)} AND scs.overview_json IS NOT NULL`,
		z.object({ overview_json: z.string() }),
	);
	if (row === undefined) return null;
	const parsed = companyOverviewEntrySchema.safeParse(JSON.parse(row.overview_json));
	return parsed.success ? parsed.data : null;
}

const directoryRow = z.object({
	name: z.string(),
	local_name: z.string().nullable(),
	listing: z.string(),
});

const companyRow = z.object({ fiscal_year_end: z.string().nullable() });

const businessRow = z.object({
	form: z.string(),
	filed_on: z.string(),
	period_end: z.string(),
	source_url: z.string().url(),
	status: z.enum(["extracted", "not-found"]),
	paragraphs_json: z.string(),
});

const paragraphsSchema = z.array(z.object({ kind: z.enum(["heading", "text"]), text: z.string() }));

const profileRow = z.object({
	sector33_name: z.string(),
	sector17_name: z.string(),
	market_segment_name: z.string(),
	scale_category: z.string().nullable(),
	as_of: z.string(),
});

/** The 【業績】 rows, in 四季報's order. */
export const FIGURE_METRICS: readonly FigureMetric[] = [
	"revenue",
	"operating-income",
	"ordinary-income",
	"profit-attributable-to-owners",
];

const figureRow = z.object({
	metric_code: z.enum([
		"revenue",
		"operating-income",
		"ordinary-income",
		"profit-attributable-to-owners",
	]),
	fiscal_year: z.number().int(),
	value_decimal: z.string(),
	currency: z.string(),
	period_end: z.string(),
	form: z.string(),
	filed_on: z.string(),
	source_url: z.string().url(),
	provider: z.enum(["sec", "jquants"]),
});

const METRIC_LABEL: Record<FigureMetric, string> = {
	revenue: "Revenue",
	"operating-income": "Operating income",
	"ordinary-income": "Ordinary income",
	"profit-attributable-to-owners": "Net income attributable to owners",
};

/** "416161000000" → "416,161,000,000"; a decimal part is kept as stored. */
export function groupDigits(value: string): string {
	const [whole = "", fraction] = value.split(".");
	const sign = whole.startsWith("-") ? "-" : "";
	const digits = whole.replace("-", "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return `${sign}${digits}${fraction === undefined ? "" : `.${fraction}`}`;
}

export interface StockSources {
	readonly stock: StockKey;
	readonly name: { readonly en: string; readonly ja: string };
	/** Whether a stored annual-report business section is among the sources (US 10-K / 20-F Item 1). */
	readonly hasBusinessText: boolean;
	readonly sources: readonly CompanySource[];
	readonly profile: StoredProfile;
	/** The source each code-filled part cites, or null when it has none. */
	readonly cites: {
		readonly listing: SourceId | null;
		readonly sector: SourceId | null;
		readonly figures: SourceId | null;
	};
	readonly figures: readonly Figure[];
}

export function readStockSources(databasePath: string, stock: StockKey): StockSources {
	const sources: CompanySource[] = [];
	const nextId = (): SourceId => `S${sources.length + 1}`;
	const cites: { listing: SourceId | null; sector: SourceId | null; figures: SourceId | null } = {
		listing: null,
		sector: null,
		figures: null,
	};
	let sector: string | null = null;
	let hasBusinessText = false;

	const [directory] = query(
		databasePath,
		`SELECT d.name, d.local_name, d.listing FROM stock_directory AS d WHERE ${keyClause("d", stock)}`,
		directoryRow,
	);
	const [company] = query(
		databasePath,
		`SELECT eco.fiscal_year_end FROM equity_company AS eco WHERE ${keyClause("eco", stock)}`,
		companyRow,
	);
	if (directory !== undefined) {
		cites.listing = nextId();
		sources.push({
			id: cites.listing,
			title:
				stock.market === "US"
					? { en: "SEC company tickers and exchanges", ja: "SEC 登録企業ティッカー一覧" }
					: { en: "JPX list of TSE-listed issues", ja: "JPX 東証上場銘柄一覧" },
			publisher: stock.market === "US" ? "U.S. SEC" : "日本取引所グループ",
			asOf: null,
			url: stock.market === "US" ? SEC_TICKERS_URL : JPX_LISTED_ISSUES_URL,
			note: null,
			text: [
				`Company name: ${directory.name}`,
				...(directory.local_name === null ? [] : [`Japanese name: ${directory.local_name}`]),
				`Listing: ${directory.listing}`,
				`Symbol: ${stock.symbol}`,
			].join("\n"),
		});
	}

	if (stock.market === "US") {
		const [business] = query(
			databasePath,
			`SELECT ebd.form, ebd.filed_on, ebd.period_end, ebd.source_url, ebd.status, ebd.paragraphs_json
			 FROM equity_company AS eco
			 JOIN equity_business_description AS ebd USING (owner_id, company_id)
			 WHERE ${keyClause("eco", stock)}`,
			businessRow,
		);
		if (business !== undefined && business.status === "extracted") {
			const paragraphs = paragraphsSchema.parse(JSON.parse(business.paragraphs_json));
			hasBusinessText = true;
			sources.push({
				id: nextId(),
				title: {
					en: `Form ${business.form}, Item 1. Business (fiscal year ended ${business.period_end})`,
					ja: `Form ${business.form} 第1項「事業の内容」(${business.period_end} 終了事業年度)`,
				},
				publisher: "U.S. SEC EDGAR",
				asOf: business.period_end,
				url: business.source_url,
				note: { en: `Filed ${business.filed_on}.`, ja: `${business.filed_on} 提出。` },
				text: paragraphs
					.map((paragraph) => paragraph.text)
					.join("\n")
					.slice(0, MAX_BUSINESS_CHARS),
			});
		}
	} else {
		const [profile] = query(
			databasePath,
			`SELECT p.sector33_name, p.sector17_name, p.market_segment_name, p.scale_category, p.as_of
			 FROM stock_company_profile AS p WHERE ${keyClause("p", stock)}`,
			profileRow,
		);
		if (profile !== undefined) {
			cites.sector = nextId();
			sector = profile.sector33_name;
			sources.push({
				id: cites.sector,
				title: { en: "J-Quants listed issue master", ja: "J-Quants 上場銘柄一覧" },
				publisher: "JPX総研 (J-Quants)",
				asOf: profile.as_of,
				url: "https://jpx-jquants.com/en/spec/eq-master",
				note: {
					en: "The data needs a J-Quants key; the link is its specification.",
					ja: "データの閲覧には J-Quants のキーが必要。リンク先は仕様。",
				},
				text: [
					`TSE 33-sector: ${profile.sector33_name}`,
					`TSE 17-sector: ${profile.sector17_name}`,
					`Market segment: ${profile.market_segment_name}`,
					`TOPIX scale category: ${profile.scale_category ?? "none"}`,
				].join("\n"),
			});
		}
	}

	// The latest fiscal year with a stored revenue, and that year's headline figures.
	const rows = query(
		databasePath,
		`SELECT m.metric_code, m.fiscal_year, m.value_decimal, m.currency, m.period_end,
		        f.form, f.filed_on, f.source_url, f.provider
		 FROM equity_company AS eco
		 JOIN equity_metric_value AS m ON m.owner_id = eco.owner_id AND m.company_id = eco.company_id
		 JOIN equity_report_filing AS f ON f.owner_id = m.owner_id AND f.filing_id = m.filing_id
		 WHERE ${keyClause("eco", stock)}
		   AND m.value_decimal IS NOT NULL
		   AND m.metric_code IN ('${FIGURE_METRICS.join("', '")}')
		   AND m.fiscal_year = (
		       SELECT max(x.fiscal_year) FROM equity_metric_value AS x
		       WHERE x.owner_id = eco.owner_id AND x.company_id = eco.company_id
		         AND x.metric_code = 'revenue' AND x.value_decimal IS NOT NULL)`,
		figureRow,
	).sort((a, b) => FIGURE_METRICS.indexOf(a.metric_code) - FIGURE_METRICS.indexOf(b.metric_code));
	const figures: Figure[] = rows.map((row) => ({
		metric: row.metric_code,
		fiscalYear: row.fiscal_year,
		periodEnd: row.period_end,
		value: row.value_decimal,
		currency: row.currency,
	}));
	const [first] = rows;
	if (first !== undefined) {
		cites.figures = nextId();
		const fromSec = first.provider === "sec";
		sources.push({
			id: cites.figures,
			title: fromSec
				? {
						en: `Form ${first.form} financial statements (fiscal year ended ${first.period_end})`,
						ja: `Form ${first.form} 財務諸表(${first.period_end} 終了事業年度)`,
					}
				: {
						en: `Earnings summary (kessan tanshin), fiscal year ended ${first.period_end}`,
						ja: `決算短信(${first.period_end} 終了事業年度)`,
					},
			publisher: fromSec ? "U.S. SEC EDGAR (XBRL)" : "J-Quants (TDnet 決算短信)",
			asOf: first.period_end,
			url: fromSec ? first.source_url : "https://jpx-jquants.com/en/spec/fin-summary",
			note: fromSec
				? { en: `Filed ${first.filed_on}.`, ja: `${first.filed_on} 提出。` }
				: {
						en: `Disclosed ${first.filed_on}. The data needs a J-Quants key; the link is its specification.`,
						ja: `${first.filed_on} 開示。データの閲覧には J-Quants のキーが必要。リンク先は仕様。`,
					},
			text: rows
				.map(
					(row) =>
						`${METRIC_LABEL[row.metric_code]}, fiscal year ended ${row.period_end}: ${groupDigits(row.value_decimal)} ${row.currency}`,
				)
				.join("\n"),
		});
	}
	return {
		stock,
		name: {
			en: directory?.name ?? stock.symbol,
			ja: directory?.local_name ?? directory?.name ?? stock.symbol,
		},
		hasBusinessText,
		sources,
		profile: {
			listing: directory?.listing ?? null,
			sector,
			fiscalYearEnd: company?.fiscal_year_end ?? null,
		},
		cites,
		figures,
	};
}
