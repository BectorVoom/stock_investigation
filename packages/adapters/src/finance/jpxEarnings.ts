/**
 * JPX earnings-announcement schedule (no key needed), fetched by the local
 * runner (FR-018, §6.2).
 *
 * EXERCISED LIVE on 2026-10-13 (see `earningsLive.test.ts`): the Japanese
 * index page links workbooks such as
 * `/listing/event-schedules/financial-announcement/tvdivq0000001ofb-att/kessan09_1009.xlsx`
 * (one per quarter-/year-end month; `_MMDD` is the update date). Only hrefs
 * matching that shape on `www.jpx.co.jp` are followed — de-duplicated, at
 * most 6. Inside each workbook only `xl/worksheets/sheet1.xml` and
 * `xl/sharedStrings.xml` are inflated (see `node/zipReader.ts` for the
 * ceilings); columns are located by header text, not letters (see
 * `jpxWorkbook.ts`).
 *
 * Mapping: a wanted code with a dated row inside `[fromDate, toDate]` yields
 * events; "Undecided" yields an event with `announcementDate: null`; rows
 * dated before `fromDate` are dropped. A wanted code in no workbook is
 * `NO_SCHEDULED_DATE`. Index or workbook download/parse failure is
 * `SOURCE_FAILED` for every requested JP stock.
 *
 * Politeness (JPX terms of use, read 2026-10-13 — JPX's copyright, no
 * commercial collection, no high-load/high-frequency automatic retrieval):
 * this source fetches only when the runner calls it (owner-queued refresh),
 * sequentially (one workbook after another, never in parallel), caches the
 * index page for 30 minutes and each parsed workbook by URL (the file name
 * carries its update date) with the injected clock, and identifies with the
 * runner's normal User-Agent (the safe fetcher's default).
 */
import type {
	Clock,
	EarningsCalendarSource,
	EarningsSourceResult,
	SafeBinaryFetcher,
	SafeFetcher,
} from "@research/application";
import {
	EARNINGS_COMPANY_NAME_MAX,
	EARNINGS_LIMITS,
	type EarningsEvent,
	type EarningsUnavailableCode,
	earningsEventSchema,
} from "@research/contracts";
import { EARNINGS_SOURCE_INFO, err, ok } from "@research/domain";
import { MAX_ZIP_ARCHIVE_BYTES, readZipEntries } from "../node/zipReader.ts";
import { type JpxWorkbookRow, parseJpxWorkbook } from "./jpxWorkbook.ts";

export const JPX_HOST = "www.jpx.co.jp";
export const JPX_INDEX_PATH = "/listing/event-schedules/financial-announcement/index.html";
export const JPX_INDEX_URL = `https://${JPX_HOST}${JPX_INDEX_PATH}`;
export const JPX_PUBLISHER = EARNINGS_SOURCE_INFO.jpx.publisher;
export const JPX_SOURCE_URL = EARNINGS_SOURCE_INFO.jpx.sourceUrl;

export const JPX_SHEET_PATH = "xl/worksheets/sheet1.xml";
export const JPX_STRINGS_PATH = "xl/sharedStrings.xml";

/** At most 6 workbooks per refresh (two were listed on 2026-10-13). */
export const MAX_JPX_WORKBOOKS = 6;
/** In-process index-page cache TTL (workbooks are cached by URL, see above). */
export const JPX_INDEX_TTL_MS = 30 * 60 * 1_000;

const JPX_ALLOWED_HOSTS: ReadonlySet<string> = new Set([JPX_HOST]);
const JPX_INDEX_TIMEOUT_MS = 30_000;
const JPX_INDEX_MAX_BYTES = 1_000_000;
const JPX_WORKBOOK_TIMEOUT_MS = 60_000;

const WORKBOOK_PATH_PATTERN =
	/^\/listing\/event-schedules\/financial-announcement\/[A-Za-z0-9_-]+\/kessan[0-9]{2}_[0-9]{4}\.xlsx$/;

export interface JpxEarningsDeps {
	readonly fetcher: SafeFetcher;
	readonly binaryFetcher: SafeBinaryFetcher;
	readonly clock: Clock;
}

/**
 * The non-empty `href` values of a page's `<a>` tags, in document order —
 * raw, unresolved and unchecked: each JPX scraper resolves them against its
 * own page and keeps only its own host and path shape (fail closed).
 */
export function* anchorHrefs(html: string): Generator<string> {
	const anchorPattern = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
	for (const match of html.matchAll(anchorPattern)) {
		const raw = match[1] ?? match[2] ?? match[3] ?? "";
		if (raw !== "") yield raw;
	}
}

/**
 * Workbook hrefs of the index page, in document order, de-duplicated, at
 * most `MAX_JPX_WORKBOOKS`. Absolute and root-relative hrefs are accepted;
 * anything off-host or off-shape is ignored (fail closed, ARCH-017).
 */
export function extractJpxWorkbookUrls(html: string): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const raw of anchorHrefs(html)) {
		if (!URL.canParse(raw, JPX_INDEX_URL)) continue;
		const resolved = new URL(raw, JPX_INDEX_URL);
		if (resolved.protocol !== "https:" || resolved.hostname.toLowerCase() !== JPX_HOST) continue;
		if (!WORKBOOK_PATH_PATTERN.test(resolved.pathname)) continue;
		const href = `${resolved.origin}${resolved.pathname}`;
		if (seen.has(href)) continue;
		seen.add(href);
		urls.push(href);
		if (urls.length >= MAX_JPX_WORKBOOKS) break;
	}
	return urls;
}

function failed(code: Exclude<EarningsUnavailableCode, "NO_SCHEDULED_DATE">): EarningsSourceResult {
	return err({ code });
}

/**
 * A successful retrieval with nothing listed (not a failed attempt): it
 * alone may carry the company `name`, so a stock without an upcoming date
 * still gets its name. The API clears the stock's stored events for it.
 */
function noScheduledDate(name: string | null): EarningsSourceResult {
	return err({ code: "NO_SCHEDULED_DATE", name });
}

export function createJpxEarningsSource(deps: JpxEarningsDeps): EarningsCalendarSource {
	let cachedIndex: { readonly html: string; readonly fetchedAtMs: number } | null = null;
	const cachedWorkbooks = new Map<string, JpxWorkbookRow[]>();

	async function indexHtml(
		signal: AbortSignal,
		beforeRequest: () => Promise<boolean>,
	): Promise<string | null> {
		const nowMs = deps.clock.nowMs();
		if (cachedIndex !== null && nowMs - cachedIndex.fetchedAtMs < JPX_INDEX_TTL_MS) {
			return cachedIndex.html;
		}
		if (!(await beforeRequest())) return null;
		const fetched = await deps.fetcher.fetchText(JPX_INDEX_URL, {
			maxBytes: JPX_INDEX_MAX_BYTES,
			timeoutMs: JPX_INDEX_TIMEOUT_MS,
			accept: "text/html",
			allowedHosts: JPX_ALLOWED_HOSTS,
			signal,
		});
		if (!fetched.ok) return null;
		cachedIndex = { html: fetched.value.text, fetchedAtMs: nowMs };
		return fetched.value.text;
	}

	async function workbookRows(
		url: string,
		signal: AbortSignal,
		beforeRequest: () => Promise<boolean>,
	): Promise<JpxWorkbookRow[] | null> {
		const cached = cachedWorkbooks.get(url);
		if (cached !== undefined) return cached;
		if (!(await beforeRequest())) return null;
		const downloaded = await deps.binaryFetcher.fetchBytes(url, {
			maxBytes: MAX_ZIP_ARCHIVE_BYTES,
			timeoutMs: JPX_WORKBOOK_TIMEOUT_MS,
			accept: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
			allowedHosts: JPX_ALLOWED_HOSTS,
			signal,
		});
		if (!downloaded.ok) return null;
		const entries = readZipEntries(downloaded.value.bytes, [JPX_SHEET_PATH, JPX_STRINGS_PATH]);
		if (!entries.ok) return null;
		const sheet = entries.value.get(JPX_SHEET_PATH);
		const strings = entries.value.get(JPX_STRINGS_PATH);
		if (sheet === undefined || strings === undefined) return null;
		const parsed = parseJpxWorkbook(
			new TextDecoder("utf-8").decode(sheet),
			new TextDecoder("utf-8").decode(strings),
		);
		if (!parsed.ok) return null;
		cachedWorkbooks.set(url, parsed.value);
		return parsed.value;
	}

	return {
		sourceId: "jpx",
		async fetchEarnings(query) {
			if (query.stocks.length === 0) return [];
			// One grant per request start, taken immediately before the
			// request is sent (API-007, JPX politeness): cached reads send
			// nothing and take no grant. A false hook fails the whole batch
			// without sending anything further.
			const html = await indexHtml(query.signal, query.beforeRequest);
			if (html === null) {
				return query.stocks.map(() => failed("SOURCE_FAILED"));
			}
			const urls = extractJpxWorkbookUrls(html);
			// Each JPX update is a new URL, so an ever-growing cache would
			// leak one parsed workbook per update: keep only the URLs the
			// current index lists.
			const current = new Set(urls);
			for (const cached of cachedWorkbooks.keys()) {
				if (!current.has(cached)) cachedWorkbooks.delete(cached);
			}
			const allRows: JpxWorkbookRow[] = [];
			for (const url of urls) {
				const rows = await workbookRows(url, query.signal, query.beforeRequest);
				if (rows === null) {
					return query.stocks.map(() => failed("SOURCE_FAILED"));
				}
				allRows.push(...rows);
			}
			return query.stocks.map((stock) =>
				toResult(stock.symbol, stock.needName, allRows, query.fromDate, query.toDate),
			);
		},
	};
}

function toResult(
	symbol: string,
	needName: boolean,
	allRows: readonly JpxWorkbookRow[],
	fromDate: string,
	toDate: string,
): EarningsSourceResult {
	const matched = allRows.filter((row) => row.code === symbol);
	if (matched.length === 0) return noScheduledDate(null);
	const events: EarningsEvent[] = [];
	for (const row of matched) {
		if (row.announcementDate !== null && row.announcementDate < fromDate) continue;
		if (row.announcementDate !== null && row.announcementDate > toDate) continue;
		const candidate = {
			periodKey: row.periodKey,
			announcementDate: row.announcementDate,
			fiscalPeriodLabel: row.fiscalPeriodLabel,
			fiscalPeriodEnd: row.fiscalPeriodEnd,
			timing: "unknown" as const,
		};
		const validated = earningsEventSchema.safeParse(candidate);
		if (validated.success) events.push(validated.data);
	}
	if (events.length === 0) {
		const listed = matched.find((row) => row.name !== null)?.name ?? null;
		return noScheduledDate(
			listed !== null && listed.length > EARNINGS_COMPANY_NAME_MAX ? null : listed,
		);
	}
	events.sort((a, b) => {
		const dateA = a.announcementDate;
		const dateB = b.announcementDate;
		if (dateA === null && dateB === null) return 0;
		if (dateA === null) return 1;
		if (dateB === null) return -1;
		return dateA < dateB ? -1 : dateA > dateB ? 1 : 0;
	});
	let name: string | null = null;
	if (needName) {
		const candidate = matched.find((row) => row.name !== null)?.name ?? null;
		// The completion contract bounds `name`: an over-long provider name
		// is dropped (null), never allowed to fail the whole refresh.
		name = candidate !== null && candidate.length > EARNINGS_COMPANY_NAME_MAX ? null : candidate;
	}
	return ok({ name, events: events.slice(0, EARNINGS_LIMITS.maxEventsPerStock) });
}
