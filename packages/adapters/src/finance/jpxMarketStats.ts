/**
 * JPX market statistics (ADR-0076; no key needed), fetched by the local
 * runner's market refresh under the provider id `jpx`:
 *
 * - `SHORT_SELLING_RATIO` — the daily short-selling ratio of the TSE's
 *   auction market (空売り比率): short sales with and without the price
 *   restriction over all sales, from the daily summary PDFs (空売り集計);
 * - `MARGIN_BUYING_VALUE` — the weekly margin buying balance in value
 *   (信用買い残, Tokyo and Nagoya, JPY millions), and
 * - `MARGIN_RATIO` — the weekly margin ratio (信用倍率: buying over selling
 *   balance in shares), both from the weekly margin workbooks (信用取引現在高)
 *   and the history workbook (過去推移表).
 *
 * Wire format, file layouts, limits and error mapping:
 * docs/external-apis/apis/jpx.md. The Rust runner's
 * `crates/research-finance/src/jpx_stats.rs` follows the same rules.
 *
 * JPX lists only recent files (about ten trading days of PDFs, three weekly
 * workbooks, a history workbook of about six weeks), so an answer is never a
 * full history: the runner stores a `jpx` series by merging (no history
 * write, ADR-0076 §3) and the stored series grows week by week.
 *
 * Politeness (JPX terms of use — no high-load or high-frequency automatic
 * retrieval): requests are sequential, each takes a grant of the shared `jpx`
 * pacer window first, the three pages are cached for three hours and each
 * downloaded file's parsed result by URL (a file name carries its date), so a
 * refresh after the first sends at most the three pages and the new files.
 */
import {
	type Clock,
	type MarketSeriesPoint,
	type MarketSeriesSource,
	type MarketSourceUnavailable,
	type SafeBinaryFetcher,
	type SafeFetcher,
	upstreamStatusOf,
} from "@research/application";
import { type MarketSeriesMeta, marketUnavailable } from "@research/contracts";
import { err, isJpxMarketSymbol, type JpxMarketSymbol, ok, type Result } from "@research/domain";
import { readPdfTextTokens } from "../node/pdfText.ts";
import { MAX_ZIP_ARCHIVE_BYTES, readZipEntries } from "../node/zipReader.ts";
import { anchorHrefs, JPX_HOST, JPX_SHEET_PATH, JPX_STRINGS_PATH } from "./jpxEarnings.ts";
import { readWorkbookRows, type WorkbookCell } from "./jpxWorkbook.ts";
import { admitMarketRequest } from "./marketFetch.ts";

export const JPX_SHORT_SELLING_URL = `https://${JPX_HOST}/markets/statistics-equities/short-selling/index.html`;
export const JPX_MARGIN_WEEKLY_URL = `https://${JPX_HOST}/markets/statistics-equities/margin/04.html`;
export const JPX_MARGIN_HISTORY_URL = `https://${JPX_HOST}/markets/statistics-equities/margin/05.html`;
export const JPX_STATS_PUBLISHER = "Japan Exchange Group (JPX)";

/** In-process page cache TTL: JPX updates the files daily (short selling) and weekly (margin). */
export const JPX_STATS_PAGE_TTL_MS = 3 * 60 * 60 * 1_000;
/** Short-selling PDFs read per refresh: the page lists about ten trading days. */
export const MAX_SHORT_SELLING_FILES = 10;
/** Weekly margin workbooks read per refresh: the page lists three weeks. */
export const MAX_MARGIN_WEEKLY_FILES = 8;
/** A summary PDF is about 42 kB. */
export const MAX_SHORT_SELLING_PDF_BYTES = 1_048_576;

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([JPX_HOST]);
const PAGE_TIMEOUT_MS = 30_000;
const PAGE_MAX_BYTES = 1_000_000;
const FILE_TIMEOUT_MS = 60_000;
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const SHORT_SELLING_PATH =
	/^\/markets\/statistics-equities\/short-selling\/[A-Za-z0-9_-]+\/([0-9]{6})-m\.pdf$/;
const MARGIN_WEEKLY_PATH =
	/^\/markets\/statistics-equities\/margin\/[A-Za-z0-9_-]+\/([0-9]{8})_mtcurrent\.xlsx$/;
const MARGIN_HISTORY_PATH =
	/^\/markets\/statistics-equities\/margin\/[A-Za-z0-9_-]+\/[A-Za-z0-9_]+\.xlsx$/;

const AMOUNT = /^[0-9]{1,3}(,[0-9]{3})+$/;
const PERCENT = /^[0-9]{1,3}\.[0-9]%$/;

/** Excel's 1900 date system: serial 1 is 1900-01-01, counted from 1899-12-30. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
/** History rows: serials of 2000-01-01 … 2099-12-31. */
const MIN_HISTORY_SERIAL = 36_526;
const MAX_HISTORY_SERIAL = 73_050;

/** The meta of each series (exact strings: docs/external-apis/apis/jpx.md). */
export const JPX_SERIES_META: { readonly [S in JpxMarketSymbol]: MarketSeriesMeta } = {
	SHORT_SELLING_RATIO: {
		title: "Short-selling ratio (空売り比率), TSE",
		unit: "Percent",
		frequency: "daily",
		publisher: JPX_STATS_PUBLISHER,
		sourceUrl: JPX_SHORT_SELLING_URL,
	},
	MARGIN_BUYING_VALUE: {
		title: "Margin buying balance (信用買い残), value, Tokyo & Nagoya",
		unit: "Millions of Yen",
		frequency: "weekly",
		publisher: JPX_STATS_PUBLISHER,
		sourceUrl: JPX_MARGIN_WEEKLY_URL,
	},
	MARGIN_RATIO: {
		title: "Margin ratio (信用倍率), shares, Tokyo & Nagoya",
		unit: "Times",
		frequency: "weekly",
		publisher: JPX_STATS_PUBLISHER,
		sourceUrl: JPX_MARGIN_WEEKLY_URL,
	},
};

/** One day's short-selling summary, JPY millions (概算). */
export interface ShortSellingDay {
	/** 実注文: sales that are not short sales. */
	readonly actual: number;
	/** 空売り（価格規制あり）. */
	readonly restricted: number;
	/** 空売り（価格規制なし）. */
	readonly unrestricted: number;
	/** 合計. */
	readonly total: number;
}

/** One week's outstanding margin trading, Tokyo and Nagoya (thousand shares, JPY millions). */
export interface MarginFigures {
	readonly sellShares: number;
	readonly sellValue: number;
	readonly buyShares: number;
	readonly buyValue: number;
}

export interface DatedMarginFigures {
	readonly date: string;
	readonly figures: MarginFigures;
}

export interface JpxMarketStatsDeps {
	readonly fetcher: SafeFetcher;
	readonly binaryFetcher: SafeBinaryFetcher;
	readonly clock: Clock;
}

/** The short-selling ratio in percent, one decimal: (restricted + unrestricted) / total. */
export function shortSellingRatio(day: ShortSellingDay): number {
	return Math.round(((day.restricted + day.unrestricted) * 1_000) / day.total) / 10;
}

/** The margin ratio in times, two decimals; null when nothing is sold short. */
export function marginRatio(figures: MarginFigures): number | null {
	if (figures.sellShares === 0) return null;
	return Math.round((figures.buyShares * 100) / figures.sellShares) / 100;
}

/**
 * The summary of one short-selling PDF, or null when the file does not read
 * as one: exactly four amounts (actual, restricted, unrestricted, total)
 * that add up within 3 (JPX rounds each), and exactly three percentages
 * each within 0.1 of its amount's share of the total.
 */
export function readShortSellingPdf(pdf: Uint8Array): ShortSellingDay | null {
	const tokens = readPdfTextTokens(pdf);
	if (tokens === null) return null;
	const amounts: number[] = [];
	const percents: number[] = [];
	for (const token of tokens) {
		if (AMOUNT.test(token)) amounts.push(Number(token.replaceAll(",", "")));
		else if (PERCENT.test(token)) percents.push(Number(token.slice(0, -1)));
	}
	const [actual, restricted, unrestricted, total] = amounts;
	if (
		amounts.length !== 4 ||
		percents.length !== 3 ||
		actual === undefined ||
		restricted === undefined ||
		unrestricted === undefined ||
		total === undefined
	) {
		return null;
	}
	if (total <= 0 || Math.abs(actual + restricted + unrestricted - total) > 3) return null;
	const parts = [actual, restricted, unrestricted];
	for (let i = 0; i < 3; i += 1) {
		const percent = percents[i] ?? Number.NaN;
		const part = parts[i] ?? Number.NaN;
		if (!(Math.abs(percent - (100 * part) / total) <= 0.1)) return null;
	}
	return { actual, restricted, unrestricted, total };
}

/** Column letters as a 1-based index (A = 1, Z = 26, AA = 27). */
export function columnIndex(column: string): number {
	let index = 0;
	for (const char of column) index = index * 26 + (char.charCodeAt(0) - 64);
	return index;
}

/** A cell's text as a non-negative integer, or null. */
function wholeNumber(cell: WorkbookCell | undefined): number | null {
	if (cell === undefined || cell.text.trim() === "") return null;
	const value = Number(cell.text.trim());
	return Number.isInteger(value) && value >= 0 ? value : null;
}

function cellAt(row: readonly WorkbookCell[], column: number): WorkbookCell | undefined {
	return row.find((cell) => columnIndex(cell.column) === column);
}

/** The Excel 1900 serial of a `YYYY-MM-DD` date. */
export function excelSerial(date: string): number {
	return Math.round((Date.parse(`${date}T00:00:00Z`) - EXCEL_EPOCH_MS) / DAY_MS);
}

/** The `YYYY-MM-DD` date of an Excel 1900 serial. */
export function serialDate(serial: number): string {
	return new Date(EXCEL_EPOCH_MS + serial * DAY_MS).toISOString().slice(0, 10);
}

/**
 * One weekly margin workbook's Tokyo-and-Nagoya totals, or null when it does
 * not read as one. `date` is the week's application date from the file name;
 * the workbook must carry its serial above the header.
 */
export function readMarginWeeklyWorkbook(
	rows: readonly (readonly WorkbookCell[])[],
	date: string,
): MarginFigures | null {
	const headerAt = rows.findIndex((row) => row.some((cell) => cell.text.includes("二市場")));
	if (headerAt < 0) return null;
	const header = rows[headerAt]?.find((cell) => cell.text.includes("二市場"));
	if (header === undefined) return null;
	const twoMarkets = columnIndex(header.column);
	const serial = excelSerial(date);
	const dated = rows
		.slice(0, headerAt)
		.some((row) => row.some((cell) => wholeNumber(cell) === serial));
	if (!dated) return null;
	let sellCol: number | null = null;
	let buyCol: number | null = null;
	for (const row of rows.slice(headerAt + 1)) {
		for (const cell of row) {
			const column = columnIndex(cell.column);
			if (column < twoMarkets) continue;
			if (sellCol === null && cell.text.startsWith("売残高")) sellCol = column;
			if (buyCol === null && cell.text.startsWith("買残高")) buyCol = column;
		}
	}
	if (sellCol === null || buyCol === null) return null;
	const sharesAt = rows.findIndex((row) =>
		row.some((cell) => cell.text.startsWith("信用取引残高合計")),
	);
	const sharesRow = rows[sharesAt];
	const valueRow = rows[sharesAt + 1];
	if (sharesAt < 0 || sharesRow === undefined || valueRow === undefined) return null;
	if (!sharesRow.some((cell) => cell.text.startsWith("株数"))) return null;
	if (!valueRow.some((cell) => cell.text.startsWith("金額"))) return null;
	const sellShares = wholeNumber(cellAt(sharesRow, sellCol));
	const buyShares = wholeNumber(cellAt(sharesRow, buyCol));
	const sellValue = wholeNumber(cellAt(valueRow, sellCol));
	const buyValue = wholeNumber(cellAt(valueRow, buyCol));
	if (sellShares === null || buyShares === null || sellValue === null || buyValue === null) {
		return null;
	}
	return { sellShares, sellValue, buyShares, buyValue };
}

/**
 * The weekly Tokyo-and-Nagoya totals of the history workbook, in row order;
 * empty when it does not read as one.
 */
export function readMarginHistoryWorkbook(
	rows: readonly (readonly WorkbookCell[])[],
): DatedMarginFigures[] {
	let headerAt = -1;
	let sellCol = 0;
	let buyCol = 0;
	for (let i = 0; i < rows.length && headerAt < 0; i += 1) {
		const row = rows[i] ?? [];
		const sell = row.find((cell) => cell.text.startsWith("株数(A)"));
		const buy = row.find((cell) => cell.text.startsWith("株数(B)"));
		if (sell === undefined || buy === undefined) continue;
		headerAt = i;
		sellCol = columnIndex(sell.column);
		buyCol = columnIndex(buy.column);
		const valueHeaders = [cellAt(row, sellCol + 1), cellAt(row, buyCol + 1)];
		if (!valueHeaders.every((cell) => cell?.text.startsWith("金額") === true)) return [];
	}
	if (headerAt < 0) return [];
	const result: DatedMarginFigures[] = [];
	let inSection = false;
	for (const row of rows.slice(headerAt + 1)) {
		const label = cellAt(row, 1)?.text ?? "";
		if (!inSection) {
			if (label.startsWith("[東京・名古屋")) inSection = true;
			continue;
		}
		if (label.startsWith("[")) break;
		const serial = wholeNumber(cellAt(row, 1));
		if (serial === null || serial < MIN_HISTORY_SERIAL || serial > MAX_HISTORY_SERIAL) continue;
		const sellShares = wholeNumber(cellAt(row, sellCol));
		const sellValue = wholeNumber(cellAt(row, sellCol + 1));
		const buyShares = wholeNumber(cellAt(row, buyCol));
		const buyValue = wholeNumber(cellAt(row, buyCol + 1));
		if (sellShares === null || sellValue === null || buyShares === null || buyValue === null) {
			continue;
		}
		result.push({
			date: serialDate(serial),
			figures: { sellShares, sellValue, buyShares, buyValue },
		});
	}
	return result;
}

/** A real calendar `YYYY-MM-DD`, or null. */
function realDate(year: string, month: string, day: string): string | null {
	const date = `${year}-${month}-${day}`;
	const ms = Date.parse(`${date}T00:00:00Z`);
	return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? date : null;
}

/** A linked file and the date its name carries. */
export interface DatedLink {
	readonly url: string;
	readonly date: string;
}

/**
 * The `https://www.jpx.co.jp` links of a page whose path matches `pattern`,
 * resolved against `pageUrl`, without query or fragment, de-duplicated, in
 * document order (the callers drop undated names, then cap).
 */
export function jpxPageLinks(
	html: string,
	pageUrl: string,
	pattern: RegExp,
): { readonly url: string; readonly match: RegExpExecArray }[] {
	const links: { readonly url: string; readonly match: RegExpExecArray }[] = [];
	const seen = new Set<string>();
	for (const raw of anchorHrefs(html)) {
		if (!URL.canParse(raw, pageUrl)) continue;
		const resolved = new URL(raw, pageUrl);
		if (resolved.protocol !== "https:" || resolved.hostname.toLowerCase() !== JPX_HOST) continue;
		const match = pattern.exec(resolved.pathname);
		if (match === null) continue;
		const url = `${resolved.origin}${resolved.pathname}`;
		if (seen.has(url)) continue;
		seen.add(url);
		links.push({ url, match });
	}
	return links;
}

/** The short-selling PDFs of the index page, dated by their `YYMMDD` names. */
export function shortSellingLinks(html: string): DatedLink[] {
	return jpxPageLinks(html, JPX_SHORT_SELLING_URL, SHORT_SELLING_PATH)
		.flatMap(({ url, match }) => {
			const name = match[1] ?? "";
			const date = realDate(`20${name.slice(0, 2)}`, name.slice(2, 4), name.slice(4, 6));
			return date === null ? [] : [{ url, date }];
		})
		.slice(0, MAX_SHORT_SELLING_FILES);
}

/** The weekly margin workbooks of page 04, dated by their `YYYYMMDD` names. */
export function marginWeeklyLinks(html: string): DatedLink[] {
	return jpxPageLinks(html, JPX_MARGIN_WEEKLY_URL, MARGIN_WEEKLY_PATH)
		.flatMap(({ url, match }) => {
			const name = match[1] ?? "";
			const date = realDate(name.slice(0, 4), name.slice(4, 6), name.slice(6, 8));
			return date === null ? [] : [{ url, date }];
		})
		.slice(0, MAX_MARGIN_WEEKLY_FILES);
}

/** The history workbook of page 05 (the first `.xlsx` link), or null. */
export function marginHistoryLink(html: string): string | null {
	return jpxPageLinks(html, JPX_MARGIN_HISTORY_URL, MARGIN_HISTORY_PATH)[0]?.url ?? null;
}

/** JPX's answer status as our code: 429 is a rate limit, anything else a failed source (§4a). */
function downloadFailed(upstreamStatus: number | null): MarketSourceUnavailable {
	return marketUnavailable(
		upstreamStatus === 429 ? "RATE_LIMITED" : "SOURCE_FAILED",
		"jpx",
		upstreamStatus,
	);
}

const NO_POINTS: MarketSourceUnavailable = marketUnavailable("SOURCE_FAILED", "jpx", null);

/** Ascending, one point per date, the newest `max` (0: all). */
function finishPoints(points: MarketSeriesPoint[], max: number): MarketSeriesPoint[] {
	const byDate = new Map<string, MarketSeriesPoint>();
	for (const point of points)
		if (!byDate.has(point.observedOn)) byDate.set(point.observedOn, point);
	const sorted = [...byDate.values()].sort((a, b) =>
		a.observedOn < b.observedOn ? -1 : a.observedOn > b.observedOn ? 1 : 0,
	);
	return max > 0 && sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

type Query = Parameters<MarketSeriesSource["fetchSeries"]>[0];

export function createJpxMarketStatsSource(deps: JpxMarketStatsDeps): MarketSeriesSource {
	const pages = new Map<string, { readonly html: string; readonly fetchedAtMs: number }>();
	/** Parsed results by URL; null: the file did not read (it is not downloaded again). */
	const shortSelling = new Map<string, ShortSellingDay | null>();
	const marginWeekly = new Map<string, MarginFigures | null>();
	const marginHistory = new Map<string, readonly DatedMarginFigures[]>();

	/** Sends one request after its grant; a refused grant is the series' failure. */
	async function admitted(query: Query): Promise<MarketSourceUnavailable | null> {
		return admitMarketRequest(query.beforeRequest, "jpx");
	}

	async function page(url: string, query: Query): Promise<Result<string, MarketSourceUnavailable>> {
		const nowMs = deps.clock.nowMs();
		const cached = pages.get(url);
		if (cached !== undefined && nowMs - cached.fetchedAtMs < JPX_STATS_PAGE_TTL_MS) {
			return ok(cached.html);
		}
		const refused = await admitted(query);
		if (refused !== null) return err(refused);
		const fetched = await deps.fetcher.fetchText(url, {
			maxBytes: PAGE_MAX_BYTES,
			timeoutMs: PAGE_TIMEOUT_MS,
			accept: "text/html",
			allowedHosts: ALLOWED_HOSTS,
			signal: query.signal,
		});
		if (!fetched.ok) return err(downloadFailed(upstreamStatusOf(fetched.error)));
		pages.set(url, { html: fetched.value.text, fetchedAtMs: nowMs });
		return ok(fetched.value.text);
	}

	async function download(
		url: string,
		accept: string,
		maxBytes: number,
		query: Query,
	): Promise<Result<Uint8Array, MarketSourceUnavailable>> {
		const refused = await admitted(query);
		if (refused !== null) return err(refused);
		const downloaded = await deps.binaryFetcher.fetchBytes(url, {
			maxBytes,
			timeoutMs: FILE_TIMEOUT_MS,
			accept,
			allowedHosts: ALLOWED_HOSTS,
			signal: query.signal,
		});
		if (!downloaded.ok) return err(downloadFailed(upstreamStatusOf(downloaded.error)));
		return ok(downloaded.value.bytes);
	}

	/** The rows of a downloaded workbook's first sheet, or null when it is not one. */
	function workbookRows(bytes: Uint8Array): WorkbookCell[][] | null {
		const entries = readZipEntries(bytes, [JPX_SHEET_PATH, JPX_STRINGS_PATH]);
		if (!entries.ok) return null;
		const sheet = entries.value.get(JPX_SHEET_PATH);
		const strings = entries.value.get(JPX_STRINGS_PATH);
		if (sheet === undefined || strings === undefined) return null;
		const rows = readWorkbookRows(
			new TextDecoder("utf-8").decode(sheet),
			new TextDecoder("utf-8").decode(strings),
		);
		return rows.ok ? rows.value : null;
	}

	/** Drops cached results of files a page no longer lists. */
	function prune<V>(cache: Map<string, V>, listed: ReadonlySet<string>): void {
		for (const url of cache.keys()) if (!listed.has(url)) cache.delete(url);
	}

	async function shortSellingPoints(
		query: Query,
	): Promise<Result<MarketSeriesPoint[], MarketSourceUnavailable>> {
		const html = await page(JPX_SHORT_SELLING_URL, query);
		if (!html.ok) return html;
		const links = shortSellingLinks(html.value);
		if (links.length === 0) return err(NO_POINTS);
		prune(shortSelling, new Set(links.map((link) => link.url)));
		const points: MarketSeriesPoint[] = [];
		for (const link of links) {
			let day = shortSelling.get(link.url);
			if (day === undefined) {
				const bytes = await download(
					link.url,
					"application/pdf",
					MAX_SHORT_SELLING_PDF_BYTES,
					query,
				);
				if (!bytes.ok) return bytes;
				day = readShortSellingPdf(bytes.value);
				shortSelling.set(link.url, day);
			}
			if (day !== null) points.push({ observedOn: link.date, value: shortSellingRatio(day) });
		}
		return ok(points);
	}

	/** Every week's figures: the history workbook's, overridden by the weekly workbooks'. */
	async function marginWeeks(
		query: Query,
	): Promise<Result<Map<string, MarginFigures>, MarketSourceUnavailable>> {
		const weeklyHtml = await page(JPX_MARGIN_WEEKLY_URL, query);
		if (!weeklyHtml.ok) return weeklyHtml;
		const weekly = marginWeeklyLinks(weeklyHtml.value);
		if (weekly.length === 0) return err(NO_POINTS);
		const historyHtml = await page(JPX_MARGIN_HISTORY_URL, query);
		if (!historyHtml.ok) return historyHtml;
		const historyUrl = marginHistoryLink(historyHtml.value);
		if (historyUrl === null) return err(NO_POINTS);
		prune(marginWeekly, new Set(weekly.map((link) => link.url)));
		prune(marginHistory, new Set([historyUrl]));
		const weeks = new Map<string, MarginFigures>();
		let history = marginHistory.get(historyUrl);
		if (history === undefined) {
			const bytes = await download(historyUrl, XLSX_TYPE, MAX_ZIP_ARCHIVE_BYTES, query);
			if (!bytes.ok) return bytes;
			const rows = workbookRows(bytes.value);
			history = rows === null ? [] : readMarginHistoryWorkbook(rows);
			marginHistory.set(historyUrl, history);
		}
		for (const week of history) weeks.set(week.date, week.figures);
		for (const link of weekly) {
			let figures = marginWeekly.get(link.url);
			if (figures === undefined) {
				const bytes = await download(link.url, XLSX_TYPE, MAX_ZIP_ARCHIVE_BYTES, query);
				if (!bytes.ok) return bytes;
				const rows = workbookRows(bytes.value);
				figures = rows === null ? null : readMarginWeeklyWorkbook(rows, link.date);
				marginWeekly.set(link.url, figures);
			}
			if (figures !== null) weeks.set(link.date, figures);
		}
		return ok(weeks);
	}

	async function points(
		symbol: JpxMarketSymbol,
		query: Query,
	): Promise<Result<MarketSeriesPoint[], MarketSourceUnavailable>> {
		if (symbol === "SHORT_SELLING_RATIO") return shortSellingPoints(query);
		const weeks = await marginWeeks(query);
		if (!weeks.ok) return weeks;
		const result: MarketSeriesPoint[] = [];
		for (const [observedOn, figures] of weeks.value) {
			const value = symbol === "MARGIN_RATIO" ? marginRatio(figures) : figures.buyValue;
			if (value !== null) result.push({ observedOn, value });
		}
		return ok(result);
	}

	return {
		providerId: "jpx",
		async fetchSeries(query) {
			if (!isJpxMarketSymbol(query.symbol)) {
				return err(marketUnavailable("SERIES_NOT_FOUND", "jpx", null));
			}
			const fetched = await points(query.symbol, query);
			if (!fetched.ok) return fetched;
			const observations = finishPoints(fetched.value, query.maxObservations);
			if (observations.length === 0) return err(NO_POINTS);
			return ok({ meta: JPX_SERIES_META[query.symbol], observations });
		},
	};
}
