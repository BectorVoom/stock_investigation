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
export function directoryStocks(databasePath: string): DirectoryListing[] {
	return query(
		databasePath,
		`SELECT d.market, d.symbol, d.name
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
		stockKeyRow.extend({ name: z.string() }),
	);
}

/** A stock-list stock with the company name the list gives it. */
export interface DirectoryListing extends StockKey {
	readonly name: string;
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
 * Whether `issuer` is the symbol of the company that issued `security`,
 * both listed under one company name: the issuer's symbol followed by more
 * letters (Nasdaq's preferred, warrant, unit and right suffixes: EFSC →
 * EFSCP, GRAB → GRABW, GPAC → GPACU; a note: DUK → DUKB), or a class-A
 * stock and another class of the same root (FCNCA → FCNCN, LBTYA →
 * LBTYK). An exchange-traded note shares only its bank's name (BMO's FLYD,
 * Deutsche Bank's DZZ): it is not the bank's business, so it matches
 * neither.
 */
export function isIssuerSymbol(issuer: string, security: string): boolean {
	if (issuer === security) return false;
	if (security.length > issuer.length) return security.startsWith(issuer);
	return (
		issuer.length >= 3 &&
		security.length === issuer.length &&
		issuer.endsWith("A") &&
		security.slice(0, -1) === issuer.slice(0, -1)
	);
}

/**
 * The issuer of a US preferred share, warrant, unit, right or note, found
 * among the stock list's listings, or null. "AHL-PD" → AHL and "AAC-WT" →
 * AAC when that symbol is listed (472 of the 532 hyphenated listings,
 * 2026-11-04); else a listing under the same company name whose symbol is
 * the issuer's (`isIssuerSymbol`; the shortest when several are): 70 of
 * the first 171 stocks the 2026-11-04 run could not write were such
 * listings (EFSCP, HBANP, EDBLW, FCNCN), searched as companies of their own.
 *
 * The symbol before the hyphen is the issuer only when the stock list names
 * both alike: EP-PC is a Kinder Morgan preferred, not Empire Petroleum's
 * (EP), and copied the wrong entry (review of 2026-11-05). Such a listing
 * takes a same-name listing without a hyphen instead (KMI), else is
 * written on its own (CMS-PB, a Consumers Energy preferred).
 *
 * When the symbol before the hyphen is not listed at all (Triton
 * International's TRTN-PA … TRTN-PG), the first series of that base and
 * name is written and the others copy it.
 *
 * `secMainTickerOf` (from SEC's company_tickers.json, `secMainTickerOf`)
 * names the main ticker of each other ticker of a filer: such a listing
 * takes its main ticker's entry when no symbol rule finds an issuer.
 */
/** A company name without case, punctuation or spaces ("Kinder Morgan, Inc." = "KINDER MORGAN INC"). */
function comparableName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function issuerFinder(
	directory: readonly DirectoryListing[],
	secMainTickerOf: ReadonlyMap<string, string> = new Map(),
): (stock: StockKey) => StockKey | null {
	const listed = new Set(directory.map((key) => `${key.market}:${key.symbol}`));
	const nameOf = new Map<string, string>();
	const symbolsOf = new Map<string, string[]>();
	for (const listing of directory) {
		if (listing.market !== "US") continue;
		nameOf.set(listing.symbol, listing.name);
		const symbols = symbolsOf.get(listing.name);
		if (symbols === undefined) symbolsOf.set(listing.name, [listing.symbol]);
		else symbols.push(listing.symbol);
	}
	const sameName = (a: string | undefined, b: string | undefined) =>
		a === undefined || b === undefined || comparableName(a) === comparableName(b);
	return (stock) => {
		if (stock.market !== "US") return null;
		const name = nameOf.get(stock.symbol);
		const base = /^([A-Z0-9.]+)-[A-Z]{1,3}$/.exec(stock.symbol)?.[1];
		if (base !== undefined && listed.has(`US:${base}`) && sameName(name, nameOf.get(base))) {
			return { market: "US", symbol: base };
		}
		const isIssuer = (symbol: string) =>
			base === undefined ? isIssuerSymbol(symbol, stock.symbol) : !symbol.includes("-");
		const sameNamed = name === undefined ? [] : (symbolsOf.get(name) ?? []);
		const byLength = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
		const issuer = sameNamed
			.filter((symbol) => symbol !== stock.symbol && isIssuer(symbol))
			.sort(byLength)[0];
		if (issuer !== undefined) return { market: "US", symbol: issuer };
		// No common stock listed (Triton International: TRTN-PA … TRTN-PG): the
		// first series of the same base and name is written, the others copy it.
		if (base !== undefined) {
			const firstSeries = sameNamed
				.filter((symbol) => symbol.startsWith(`${base}-`))
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0];
			if (firstSeries !== undefined && firstSeries !== stock.symbol) {
				return { market: "US", symbol: firstSeries };
			}
		}
		// Another ticker of a filer whose main ticker is listed under the same
		// name (MBNKO → MFIN, MHNC → MHLA), unless the name is shared like an
		// ETN's bank (`sharedNameNote`): those are written as themselves.
		const main = secMainTickerOf.get(stock.symbol);
		const unrelated = sameNamed.filter(
			(symbol) =>
				symbol !== stock.symbol &&
				!symbol.includes("-") &&
				!isIssuerSymbol(symbol, stock.symbol) &&
				!isIssuerSymbol(stock.symbol, symbol),
		);
		return main !== undefined &&
			listed.has(`US:${main}`) &&
			sameName(name, nameOf.get(main)) &&
			unrelated.length < SHARED_NAME_LISTINGS
			? { market: "US", symbol: main }
			: null;
	};
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
	/** Whether a stored annual-report business section of at least MIN_BUSINESS_TEXT_CHARS is among the sources (US 10-K Item 1 / 20-F Item 4). */
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
	/**
	 * Other US listings the stock list gives the same company name, hyphenated
	 * ones (preferred shares) and those whose symbol is built from this one's
	 * (`isIssuerSymbol`, either way) aside. The list names an exchange-traded note
	 * by its bank (DULL, FLYD and 43 more are "BANK OF MONTREAL /CAN/"), so
	 * a name shared like this says the listing may be a security of the
	 * issuer rather than its common stock (review of 2026-11-05: 47 ETNs
	 * were described as their bank).
	 */
	readonly listingsSharingName: readonly string[];
}

/** How many other listings sharing the name make a listing look like an issuer's security, not its stock. */
export const SHARED_NAME_LISTINGS = 2;

/**
 * The note for the page search and the writer when the stock list names
 * this listing after an issuer that has other listings under that name.
 */
export function sharedNameNote(stock: StockSources): string | null {
	const others = stock.listingsSharingName;
	if (others.length < SHARED_NAME_LISTINGS) return null;
	const shown = others.slice(0, 4).join(", ");
	return `The stock list gives code ${stock.stock.symbol} its issuer's name, which ${others.length} other listings share (${shown}${others.length > 4 ? ", …" : ""}). Code ${stock.stock.symbol} may be an exchange-traded note (ETN), a fund or another security of that issuer rather than its common stock.`;
}

/**
 * Listed companies' EDINET codes by their 4-character JPX code, from the
 * EDINET code list (EdinetcodeDlInfo.csv in Edinetcode.zip, Shift_JIS):
 * columns EDINET code, …, 上場区分 (3rd), …, 提出者名 (7th, the filer's name
 * now), …, 証券コード (12th, the JPX code plus a check digit "0").
 */
export function edinetCodesByStockCode(
	csv: string,
): Map<string, { readonly edinetCode: string; readonly filerName: string }> {
	const codes = new Map<string, { readonly edinetCode: string; readonly filerName: string }>();
	for (const line of csv.split(/\r?\n/)) {
		const fields = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? "");
		const [edinetCode, , listing] = fields;
		const securitiesCode = fields[11] ?? "";
		if (edinetCode === undefined || listing !== "上場" || !/^E\d{5}$/.test(edinetCode)) continue;
		if (!/^[0-9A-Z]{4}0$/.test(securitiesCode)) continue;
		codes.set(securitiesCode.slice(0, 4), { edinetCode, filerName: fields[6] ?? "" });
	}
	return codes;
}

/**
 * A stored business section shorter than this is a cross-reference, not a
 * description ("See also 'Additional Information' of this Annual Report.",
 * TotalEnergies' 20-F; 16 of 5,149 on 2026-11-05): it stays a source, but
 * the stock is searched on the web as if it had none.
 */
export const MIN_BUSINESS_TEXT_CHARS = 1_500;

/**
 * `--pages`: lines "MARKET:SYMBOL=https://…" naming a page to read for a
 * stock besides the search's; blank lines and "#" comments are skipped.
 */
export function pagesByStock(text: string): Map<string, string[]> {
	const pages = new Map<string, string[]>();
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const match = /^((?:US|JP):[A-Z0-9.-]{1,16})=(https:\/\/\S+)$/.exec(line);
		const [, stock, url] = match ?? [];
		if (stock === undefined || url === undefined) {
			throw new Error(`--pages line ${index + 1}: expected MARKET:SYMBOL=https://…, got ${line}`);
		}
		pages.set(stock, [...(pages.get(stock) ?? []), url]);
	}
	return pages;
}

const secTickerFileSchema = z.record(
	z.string(),
	z.object({ cik_str: z.number().int().positive(), ticker: z.string().min(1) }),
);

/**
 * Each SEC filer's main ticker and its 10-digit CIK, from SEC's
 * company_tickers.json: a filer's tickers are listed main one first (JPM
 * before JPM-PC, VYLD and AMJB; KMI before EP-PC).
 */
export function secMainTickers(file: unknown): Map<string, string> {
	const entries = Object.entries(secTickerFileSchema.parse(file)).sort(
		([a], [b]) => Number(a) - Number(b),
	);
	const seen = new Set<number>();
	const main = new Map<string, string>();
	for (const [, entry] of entries) {
		if (seen.has(entry.cik_str)) continue;
		seen.add(entry.cik_str);
		main.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, "0"));
	}
	return main;
}

/** Each SEC filer's other tickers and the filer's main ticker (EP-PC → KMI, MBNKO → MFIN). */
export function secMainTickerOf(file: unknown): Map<string, string> {
	const entries = Object.entries(secTickerFileSchema.parse(file)).sort(
		([a], [b]) => Number(a) - Number(b),
	);
	const mainOfFiler = new Map<number, string>();
	const mainOf = new Map<string, string>();
	for (const [, entry] of entries) {
		const ticker = entry.ticker.toUpperCase();
		const main = mainOfFiler.get(entry.cik_str);
		if (main === undefined) mainOfFiler.set(entry.cik_str, ticker);
		else if (main !== ticker) mainOf.set(ticker, main);
	}
	return mainOf;
}

/**
 * `issuerCik`: the SEC CIK whose main ticker this listing is (the first of
 * the CIK's tickers in SEC's company_tickers.json), or null. The equity sync
 * gives a CIK to one listing only, the first synced: EP-PC holds Kinder
 * Morgan's and KMI has none, AMJB holds JPMorgan's, CCZ Comcast's (review of
 * 2026-11-05). A main ticker without its own business section reads the one
 * stored under the listing that holds its CIK.
 */
export function readStockSources(
	databasePath: string,
	stock: StockKey,
	issuerCik: string | null = null,
	/** The EDINET filer's name: a renamed company's filings name it, not the stock list's old one. */
	filerName: string | null = null,
): StockSources {
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
	const listingsSharingName =
		stock.market === "US"
			? query(
					databasePath,
					`SELECT other.symbol FROM stock_directory AS d
					 JOIN stock_directory AS other
					   ON other.owner_id = d.owner_id AND other.market = d.market AND other.name = d.name
					 WHERE ${keyClause("d", stock)} AND other.symbol <> d.symbol AND instr(other.symbol, '-') = 0
					 ORDER BY other.symbol`,
					z.object({ symbol: z.string() }),
				)
					.map((row) => row.symbol)
					// A SPAC's units and warrants (AACIU, AACIW) and a bank's notes (AGNCL) are its own.
					.filter(
						(symbol) =>
							!isIssuerSymbol(symbol, stock.symbol) && !isIssuerSymbol(stock.symbol, symbol),
					)
			: [];
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
				...(filerName === null || filerName === "" || filerName === directory.local_name
					? []
					: [`EDINET filer name (the same securities code): ${filerName}`]),
				`Listing: ${directory.listing}`,
				`Symbol: ${stock.symbol}`,
			].join("\n"),
		});
	}

	if (stock.market === "US") {
		const businessOf = (where: string) =>
			query(
				databasePath,
				`SELECT ebd.form, ebd.filed_on, ebd.period_end, ebd.source_url, ebd.status, ebd.paragraphs_json
				 FROM equity_company AS eco
				 JOIN equity_business_description AS ebd USING (owner_id, company_id)
				 WHERE ${where}`,
				businessRow,
			)[0];
		const own = businessOf(keyClause("eco", stock));
		const business =
			own?.status !== "extracted" && issuerCik !== null && /^\d{10}$/.test(issuerCik)
				? (businessOf(`eco.provider = 'sec' AND eco.source_company_id = '${issuerCik}'`) ?? own)
				: own;
		if (business !== undefined && business.status === "extracted") {
			const paragraphs = paragraphsSchema.parse(JSON.parse(business.paragraphs_json));
			hasBusinessText =
				paragraphs.reduce((chars, paragraph) => chars + paragraph.text.length, 0) >=
				MIN_BUSINESS_TEXT_CHARS;
			sources.push({
				id: nextId(),
				// A 20-F's business section is Item 4, "Information on the Company".
				title:
					business.form === "20-F"
						? {
								en: `Form 20-F, Item 4. Information on the Company (fiscal year ended ${business.period_end})`,
								ja: `Form 20-F 第4項「企業情報」(${business.period_end} 終了事業年度)`,
							}
						: {
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
		listingsSharingName,
		profile: {
			listing: directory?.listing ?? null,
			sector,
			fiscalYearEnd: company?.fiscal_year_end ?? null,
		},
		cites,
		figures,
	};
}
