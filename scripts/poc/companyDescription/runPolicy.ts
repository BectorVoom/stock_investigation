import { existsSync, readFileSync } from "node:fs";
import { isBareSegment } from "@research/contracts";
import { z } from "zod";
import type { StockSources } from "./sources.ts";
import type { VerifiedDescription } from "./template.ts";

/**
 * The run's decisions about one stock's entry and the run as a whole, apart
 * from run.ts so they can be tested: what describes the business, when a new
 * entry may replace a stored one, which stocks wait after a fruitless
 * search, and when web searches pause.
 */

export type SearchProvider = "claude" | "tavily";

export const NO_BUSINESS_SOURCE = "no business source (no stored business text, no web page)";
export const NOTHING_VERIFIED = "no verified field describes the business";
export const NO_SUMMARY = "no verified 事業内容 although a source describes the business";
export const KEPT_STORED = "kept the stored entry: the new one has fewer rows";
export const ISSUER_NOT_WRITTEN = "issuer has no stored entry yet:";

/** The sources that are only records: the stock list, the sector code, the figures. */
function recordSourceIds(stock: StockSources): Set<string | null> {
	return new Set([stock.cites.listing, stock.cites.sector, stock.cites.figures]);
}

/** Whether some source can describe the business: a business text or a web page. */
export function hasBusinessSource(stock: StockSources): boolean {
	const recordIds = recordSourceIds(stock);
	return stock.sources.some((source) => !recordIds.has(source.id));
}

/**
 * Whether a verified entry describes the business: some field cites a
 * business text or a web page, not only the stock list, the sector code or
 * the figures (「東証プライム上場の松竹。」 says nothing).
 */
export function describesBusiness(entry: VerifiedDescription, stock: StockSources): boolean {
	const recordIds = recordSourceIds(stock);
	const fields = [
		...(entry.feature === null ? [] : [entry.feature]),
		...entry.businesses,
		...entry.segments,
		...entry.themes.map((theme) => theme.reason),
	];
	return fields.some((field) => field.evidence.some((item) => !recordIds.has(item.source)));
}

/**
 * Why a verified entry is not stored, or null when it is. 【事業内容】 is the
 * summary of the business (ADR-0064 §5c): an entry without one is not
 * stored when a source describes the business — 76 such entries were stored
 * before this rule (review of 2026-11-04), and the Company tab then showed
 * no summary at all instead of the ADR-0060 one.
 */
export function storeRefusal(entry: VerifiedDescription, stock: StockSources): string | null {
	if (!describesBusiness(entry, stock)) return NOTHING_VERIFIED;
	if (entry.businesses.length === 0 && hasBusinessSource(stock)) return NO_SUMMARY;
	return null;
}

/** The rows an entry fills: 【特色】【事業内容】【連結事業】(segments that say more than a name)【海外】【テーマ】. */
export function filledRows(entry: VerifiedDescription): number {
	return [
		entry.feature !== null,
		entry.businesses.length > 0,
		entry.segments.some((segment) => !isBareSegment(segment)),
		entry.overseasSales !== null,
		entry.themes.length > 0,
	].filter(Boolean).length;
}

/**
 * Whether a rewrite may replace the stored entry: not when it loses
 * 【事業内容】 or fills fewer rows. The first `--force` rewrite replaced
 * entries unconditionally and left 32 without a 【事業内容】 and 27 without a
 * 【特色】 that had one (review of 2026-11-04).
 */
export function mayReplace(next: VerifiedDescription, stored: VerifiedDescription | null): boolean {
	if (stored === null) return true;
	if (stored.businesses.length > 0 && next.businesses.length === 0) return false;
	return filledRows(next) >= filledRows(stored);
}

/** How long a stock whose search gave nothing usable is left out, so searches go to others. */
export const UNREADABLE_DAYS = 30;

const loggedOutcomeSchema = z.object({
	at: z.string(),
	stock: z.string(),
	error: z.string().nullable(),
	searched: z.boolean().optional(),
	// Entries written before the Haiku agent searched have none: Tavily searched them.
	searchedWith: z.enum(["claude", "tavily"]).nullable().optional(),
});

/** A log line as JSON, or null for a line cut off when a run was stopped mid-write. */
function parseJsonLine(line: string): unknown {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

/**
 * The stocks `provider` searched in the last UNREADABLE_DAYS days without a
 * usable result — no page could be read (robots.txt, JavaScript-only
 * pages) or nothing written from them could be stored — read from the
 * run's `run.jsonl` text. Every restart searched them again; they now wait
 * a month (`--force` tries them anyway). Another provider may still try.
 */
export function recentlyUnreadable(
	logText: string,
	nowMs: number,
	provider: SearchProvider,
): Set<string> {
	const since = new Date(nowMs - UNREADABLE_DAYS * 86_400_000).toISOString();
	const latest = new Map<string, z.infer<typeof loggedOutcomeSchema>>();
	for (const line of logText.split("\n")) {
		if (line.trim() === "") continue;
		const parsed = loggedOutcomeSchema.safeParse(parseJsonLine(line));
		if (parsed.success && parsed.data.at >= since) latest.set(parsed.data.stock, parsed.data);
	}
	const fruitless = new Set<string | null>([NO_BUSINESS_SOURCE, NOTHING_VERIFIED, NO_SUMMARY]);
	return new Set(
		[...latest.values()]
			.filter(
				(entry) =>
					entry.searched === true &&
					(entry.searchedWith ?? "tavily") === provider &&
					fruitless.has(entry.error),
			)
			.map((entry) => entry.stock),
	);
}

/** `recentlyUnreadable` for a log file that may not exist yet. */
export function recentlyUnreadableIn(
	logFile: string,
	nowMs: number,
	provider: SearchProvider,
): Set<string> {
	return existsSync(logFile)
		? recentlyUnreadable(readFileSync(logFile, "utf8"), nowMs, provider)
		: new Set();
}

/**
 * Whether a model turn failed because the account cannot pay (a used-up
 * credit balance or a spend limit). The run then stops: on 2026-11-04 the
 * credit ran out at stock 690 of 8,467 and the run went on to fail the
 * other 7,777 in 35 minutes, 4,132 of them logged as having no source.
 */
export function isOutOfCredit(failure: string): boolean {
	return failure.startsWith("PROVIDER_PAYMENT_REQUIRED");
}

/** Search failures in a row (after each search's own retries) that pause all searches. */
export const MAX_SEARCH_FAILURES_IN_A_ROW = 5;
/** How long searches pause after that. */
export const SEARCH_PAUSE_MS = 5 * 60_000;

/**
 * Web searches across the parallel workers. A run of failures pauses every
 * search for SEARCH_PAUSE_MS instead of turning the web off for the rest of
 * the run: at 16 stocks at a time one outage would otherwise have failed
 * every remaining Japanese stock in seconds. Only an answer that the plan's
 * credits or the spend limit are used up turns searches off.
 */
export class WebBudget {
	enabled: boolean;
	searches = 0;
	/** The answer that turned searches off because the plan or the account cannot pay; null until then. */
	exhaustedBy: string | null = null;
	private failuresInARow = 0;
	private pausedUntilMs = 0;
	// A plain field, not a parameter property: Node's type stripping rejects those.
	private readonly now: () => number;

	constructor(enabled: boolean, now: () => number = Date.now) {
		this.enabled = enabled;
		this.now = now;
	}

	/** Waits out a pause; true when searching is allowed. */
	async ready(sleep: (ms: number) => Promise<void>): Promise<boolean> {
		while (this.enabled && this.now() < this.pausedUntilMs) {
			await sleep(Math.min(30_000, this.pausedUntilMs - this.now()));
		}
		return this.enabled;
	}

	record(failure: { readonly code: string; readonly detail: string } | null): void {
		this.searches += 1;
		if (failure === null) {
			this.failuresInARow = 0;
			return;
		}
		this.failuresInARow += 1;
		const exhausted = /HTTP 43[23]|credit balance|spend limit|usage limit/i.test(
			`${failure.code} ${failure.detail}`,
		);
		if (this.enabled && exhausted) {
			this.enabled = false;
			this.exhaustedBy = `${failure.code} ${failure.detail}`;
			console.log(
				`web pages turned off after ${this.searches} searches: ${failure.code} ${failure.detail}`,
			);
		} else if (this.failuresInARow >= MAX_SEARCH_FAILURES_IN_A_ROW) {
			this.failuresInARow = 0;
			this.pausedUntilMs = this.now() + SEARCH_PAUSE_MS;
			console.log(
				`web searches paused for ${SEARCH_PAUSE_MS / 60_000} min after ${MAX_SEARCH_FAILURES_IN_A_ROW} failures in a row: ${failure.code} ${failure.detail}`,
			);
		}
	}

	/** Whether searches are paused now (for tests and the log). */
	paused(): boolean {
		return this.now() < this.pausedUntilMs;
	}
}
