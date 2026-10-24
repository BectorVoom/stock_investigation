/**
 * The Japanese stock directory (ADR-0033): JPX's monthly "List of
 * TSE-listed Issues", `data_j.xlsx` (Japanese) and `data_e.xlsx` (English),
 * each linked from its own page:
 *
 *   https://www.jpx.co.jp/markets/statistics-equities/misc/01.html          → …-att/data_j.xlsx
 *   https://www.jpx.co.jp/english/markets/statistics-equities/misc/01.html  → …-att/data_e.xlsx
 *
 * The `…-att` folder is read from each page, never hard-coded (JPX may move
 * it). Layout observed 2026-10-24 on both files: sheet 1, headers in row 1
 * (`日付, コード, 銘柄名, 市場・商品区分, …` and `Effective Date, Local Code,
 * Name (English), Section/Products, …`), one row per issue, 4,447 rows, all
 * dated `20260930` (a numeric YYYYMMDD, not an Excel serial).
 *
 * Mapping: the Japanese list decides which issues are kept — Prime,
 * Standard and Growth, domestic and foreign (3,707 measured); ETFs/ETNs, PRO
 * Market, REITs and funds and equity contribution securities are dropped.
 * `localName` is 銘柄名; `name` is the English name joined on the code (the
 * Japanese name when the English list lacks the code). A name longer than
 * the stored maximum is replaced by the other language's name when that
 * fits, otherwise the row is dropped (counted, never named). `asOf` is the
 * list's date when every kept row states the same valid one, else null.
 *
 * Politeness (ADR-0016): four requests per refresh (page, workbook, page,
 * workbook), one after another, each admitted by the runner's shared JPX
 * window; the Japanese workbook is parsed before the English page is asked
 * for, so a broken list costs two requests, not four. Columns are located by
 * header text; the workbook is read with the bounded reader of
 * `jpxWorkbook.ts` (SEC-001).
 */
import type {
	SafeBinaryFetcher,
	SafeFetcher,
	StockDirectoryQuery,
	StockDirectorySource,
} from "@research/application";
import {
	parseStockId,
	type StockDirectoryEntry,
	type StockDirectoryFailureCode,
	type StockListing,
} from "@research/contracts";
import { err, isValidIsoDate, ok, type Result } from "@research/domain";
import { MAX_ZIP_ARCHIVE_BYTES, readZipEntries } from "../node/zipReader.ts";
import { anchorHrefs, JPX_HOST, JPX_SHEET_PATH, JPX_STRINGS_PATH } from "./jpxEarnings.ts";
import { readWorkbookRows, type WorkbookCell } from "./jpxWorkbook.ts";
import {
	directoryFetchFailure,
	finishDirectory,
	fitsDirectoryName,
	type ParsedStockDirectory,
} from "./stockDirectory.ts";

export type JpxListingLanguage = "ja" | "en";

export const JPX_LISTING_PAGE_URLS: { readonly [L in JpxListingLanguage]: string } = {
	ja: `https://${JPX_HOST}/markets/statistics-equities/misc/01.html`,
	en: `https://${JPX_HOST}/english/markets/statistics-equities/misc/01.html`,
};

const LISTING_PATHS: { readonly [L in JpxListingLanguage]: RegExp } = {
	ja: /^\/markets\/statistics-equities\/misc\/[A-Za-z0-9_-]+\/data_j\.xlsx$/,
	en: /^\/english\/markets\/statistics-equities\/misc\/[A-Za-z0-9_-]+\/data_e\.xlsx$/,
};

/** Header texts (exact, after trimming) of the four columns read from each list. */
const LISTING_HEADERS: {
	readonly [L in JpxListingLanguage]: {
		readonly date: string;
		readonly code: string;
		readonly name: string;
		readonly section: string;
	};
} = {
	ja: { date: "日付", code: "コード", name: "銘柄名", section: "市場・商品区分" },
	en: {
		date: "Effective Date",
		code: "Local Code",
		name: "Name (English)",
		section: "Section/Products",
	},
};

/** 市場・商品区分 (exact) → the listing kept; every other section is dropped. */
export const JPX_DIRECTORY_LISTINGS: ReadonlyMap<string, StockListing> = new Map([
	["プライム（内国株式）", "tse-prime"],
	["プライム（外国株式）", "tse-prime"],
	["スタンダード（内国株式）", "tse-standard"],
	["スタンダード（外国株式）", "tse-standard"],
	["グロース（内国株式）", "tse-growth"],
	["グロース（外国株式）", "tse-growth"],
]);

const PAGE_MAX_BYTES = 1_000_000;
const PAGE_TIMEOUT_MS = 30_000;
const WORKBOOK_TIMEOUT_MS = 60_000;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const JPX_ALLOWED_HOSTS: ReadonlySet<string> = new Set([JPX_HOST]);

/**
 * The list's workbook link on its page: the first `<a href>` that resolves
 * to `https://www.jpx.co.jp` with the language's path shape, without query
 * or fragment; null when the page has none.
 */
export function extractJpxListingUrl(html: string, language: JpxListingLanguage): string | null {
	const page = JPX_LISTING_PAGE_URLS[language];
	for (const raw of anchorHrefs(html)) {
		if (!URL.canParse(raw, page)) continue;
		const resolved = new URL(raw, page);
		if (resolved.protocol !== "https:" || resolved.hostname.toLowerCase() !== JPX_HOST) continue;
		if (!LISTING_PATHS[language].test(resolved.pathname)) continue;
		return `${resolved.origin}${resolved.pathname}`;
	}
	return null;
}

/** One issue as a list states it (texts trimmed; the code upper-cased). */
export interface JpxListingRow {
	readonly code: string;
	readonly name: string;
	readonly section: string;
	/** The raw 日付 / Effective Date text. */
	readonly date: string;
}

function textAt(cells: readonly WorkbookCell[], column: string): string {
	return cells.find((cell) => cell.column === column)?.text.trim() ?? "";
}

/**
 * The issues of one list's sheet rows: the header row is the first row
 * naming all four columns; rows after it whose code is not a JP code (a
 * blank or note row) are skipped. No header → `DIRECTORY_PARSE_FAILED`.
 */
export function jpxListingRows(
	rows: readonly (readonly WorkbookCell[])[],
	language: JpxListingLanguage,
): Result<JpxListingRow[], StockDirectoryFailureCode> {
	const wanted = LISTING_HEADERS[language];
	let columns: { date: string; code: string; name: string; section: string } | null = null;
	const out: JpxListingRow[] = [];
	for (const cells of rows) {
		if (columns === null) {
			const columnOf = (header: string): string | undefined =>
				cells.find((cell) => cell.text.trim() === header)?.column;
			const date = columnOf(wanted.date);
			const code = columnOf(wanted.code);
			const name = columnOf(wanted.name);
			const section = columnOf(wanted.section);
			if (date !== undefined && code !== undefined && name !== undefined && section !== undefined) {
				columns = { date, code, name, section };
			}
			continue;
		}
		const code = textAt(cells, columns.code).toUpperCase();
		if (parseStockId(`jp:${code}`) === null) continue;
		out.push({
			code,
			name: textAt(cells, columns.name),
			section: textAt(cells, columns.section),
			date: textAt(cells, columns.date),
		});
	}
	return columns === null ? err("DIRECTORY_PARSE_FAILED") : ok(out);
}

/** `20260930` → `2026-09-30`; null for anything that is not a real YYYYMMDD date. */
export function listingDate(text: string): string | null {
	if (!/^[0-9]{8}$/.test(text)) return null;
	const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
	return isValidIsoDate(iso) ? iso : null;
}

/**
 * Joins the two lists into the JP directory (before the row-count floor):
 * see the file header for the rules. Pure, and run by the conformance
 * vectors in TypeScript and Rust.
 */
export function jpxDirectoryEntries(
	japanese: readonly JpxListingRow[],
	english: readonly JpxListingRow[],
): {
	readonly asOf: string | null;
	readonly entries: StockDirectoryEntry[];
	readonly droppedRows: number;
} {
	const englishNames = new Map<string, string>();
	for (const row of english) {
		if (!englishNames.has(row.code)) englishNames.set(row.code, row.name);
	}
	const entries: StockDirectoryEntry[] = [];
	const seen = new Set<string>();
	const dates = new Set<string>();
	let droppedRows = 0;
	for (const row of japanese) {
		const listing = JPX_DIRECTORY_LISTINGS.get(row.section);
		if (listing === undefined || seen.has(row.code)) continue;
		const localName = row.name;
		const englishName = englishNames.get(row.code) ?? "";
		const name = fitsDirectoryName(englishName)
			? englishName
			: fitsDirectoryName(localName)
				? localName
				: null;
		const local = fitsDirectoryName(localName)
			? localName
			: fitsDirectoryName(englishName)
				? englishName
				: null;
		if (name === null || local === null) {
			droppedRows += 1;
			continue;
		}
		seen.add(row.code);
		dates.add(row.date);
		entries.push({ symbol: row.code, name, localName: local, listing });
	}
	const [only] = dates;
	const asOf = dates.size === 1 && only !== undefined ? listingDate(only) : null;
	return { asOf, entries, droppedRows };
}

/** `jpxDirectoryEntries` plus the contract's row-count floor and ceiling. */
export function parseJpxDirectory(
	japanese: readonly JpxListingRow[],
	english: readonly JpxListingRow[],
): Result<ParsedStockDirectory, StockDirectoryFailureCode> {
	const joined = jpxDirectoryEntries(japanese, english);
	return finishDirectory(joined.asOf, joined.entries, joined.droppedRows);
}

/** One list's sheet and shared strings (decoded XML) as its issues. */
export function parseJpxListingSheet(
	sheetXml: string,
	sharedStringsXml: string,
	language: JpxListingLanguage,
): Result<JpxListingRow[], StockDirectoryFailureCode> {
	const rows = readWorkbookRows(sheetXml, sharedStringsXml);
	if (!rows.ok) return err("DIRECTORY_PARSE_FAILED");
	return jpxListingRows(rows.value, language);
}

/** One downloaded list workbook (`.xlsx` bytes) as its issues. */
export function parseJpxListingWorkbook(
	bytes: Uint8Array,
	language: JpxListingLanguage,
): Result<JpxListingRow[], StockDirectoryFailureCode> {
	const entries = readZipEntries(bytes, [JPX_SHEET_PATH, JPX_STRINGS_PATH]);
	if (!entries.ok) return err("DIRECTORY_PARSE_FAILED");
	const sheet = entries.value.get(JPX_SHEET_PATH);
	const strings = entries.value.get(JPX_STRINGS_PATH);
	if (sheet === undefined || strings === undefined) return err("DIRECTORY_PARSE_FAILED");
	return parseJpxListingSheet(
		new TextDecoder("utf-8").decode(sheet),
		new TextDecoder("utf-8").decode(strings),
		language,
	);
}

export interface JpxDirectoryDeps {
	readonly fetcher: SafeFetcher;
	readonly binaryFetcher: SafeBinaryFetcher;
	/** Told how many rows were dropped for an over-long name, when any were (never the names). */
	readonly onDroppedRows?: (count: number) => void;
}

export function createJpxDirectorySource(deps: JpxDirectoryDeps): StockDirectorySource {
	async function listing(
		language: JpxListingLanguage,
		query: StockDirectoryQuery,
	): Promise<Result<JpxListingRow[], StockDirectoryFailureCode>> {
		// One grant per request start, taken immediately before it is sent;
		// a false hook (the job stopped while waiting) sends nothing more.
		if (!(await query.beforeRequest())) return err("DIRECTORY_SOURCE_FAILED");
		const page = await deps.fetcher.fetchText(JPX_LISTING_PAGE_URLS[language], {
			maxBytes: PAGE_MAX_BYTES,
			timeoutMs: PAGE_TIMEOUT_MS,
			accept: "text/html",
			allowedHosts: JPX_ALLOWED_HOSTS,
			signal: query.signal,
		});
		if (!page.ok) return err(directoryFetchFailure(page.error));
		const url = extractJpxListingUrl(page.value.text, language);
		if (url === null) return err("DIRECTORY_PARSE_FAILED");
		if (!(await query.beforeRequest())) return err("DIRECTORY_SOURCE_FAILED");
		const workbook = await deps.binaryFetcher.fetchBytes(url, {
			maxBytes: MAX_ZIP_ARCHIVE_BYTES,
			timeoutMs: WORKBOOK_TIMEOUT_MS,
			accept: XLSX_TYPE,
			allowedHosts: JPX_ALLOWED_HOSTS,
			signal: query.signal,
		});
		if (!workbook.ok) return err(directoryFetchFailure(workbook.error));
		return parseJpxListingWorkbook(workbook.value.bytes, language);
	}

	return {
		market: "JP",
		async fetchDirectory(query) {
			const japanese = await listing("ja", query);
			if (!japanese.ok) return japanese;
			const english = await listing("en", query);
			if (!english.ok) return english;
			const parsed = parseJpxDirectory(japanese.value, english.value);
			if (!parsed.ok) return parsed;
			if (parsed.value.droppedRows > 0) deps.onDroppedRows?.(parsed.value.droppedRows);
			return ok(parsed.value.data);
		},
	};
}
