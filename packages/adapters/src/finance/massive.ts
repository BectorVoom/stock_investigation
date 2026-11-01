/**
 * Massive (formerly Polygon.io) US stock prices for the `stock-prices-sync`
 * job (ADR-0058 §2), fetched by the local runner with the owner's
 * `MASSIVE_API_KEY`. Requests are pinned to `api.massive.com` through the
 * SafeFetcher and authenticated by `Authorization: Bearer <key>`, so the
 * key never appears in a URL or a log line.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/massive.md
 *
 *  - Day: `GET /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true`
 *    — every US stock's split-adjusted bar of one date (no OTC). Each row's
 *    `T` is mapped to the directory's form; a row whose ticker has none, or
 *    whose `o h l c` are unreadable or inconsistent, is dropped.
 *  - History: `GET /v2/aggs/ticker/{ticker}/range/1/day/{from}/{to}?adjusted=true&sort=asc&limit=50000`,
 *    following `next_url` (each page paced). Bar dates are the
 *    America/New_York date of `t` (the window's start).
 *  - Splits: `GET /stocks/v1/splits?execution_date.gt=&execution_date.lte=&limit=5000`,
 *    following `next_url`; the split tickers mapped to directory symbols.
 *
 * Status mapping: 401 → the key was rejected; 403 → the plan does not cover
 * the request (too recent on the free plan before the day's end, or older
 * than its two years); 404 → unknown; 429 → rate limited; anything else a
 * source failure — the status always kept unchanged (ADR-0037).
 */
import type { SafeFetchError, SafeFetcher, SafeFetchOptions } from "@research/application";
import type { StockDayBar, StockHistoryBar } from "@research/contracts";
import { err, ok, type Result } from "@research/domain";
import { z } from "zod";
import { fetchJsonDocument } from "./marketFetch.ts";
import {
	consistentBar,
	finishDayBars,
	massiveTickerToSymbol,
	newYorkDate,
	problemOfStatus,
	type StockDayAnswer,
	type StockPriceProblem,
	type StockPriceRequestContext,
	type StockPriceSource,
	symbolToMassiveTicker,
} from "./stockPrices.ts";

export const MASSIVE_HOST = "api.massive.com";
export const MASSIVE_PUBLISHER = "Massive";
export const MASSIVE_SOURCE_URL = "https://massive.com/";
const MASSIVE_ALLOWED_HOSTS: ReadonlySet<string> = new Set([MASSIVE_HOST]);
const MASSIVE_TIMEOUT_MS = 30_000;
/** A grouped day of ~11,000 tickers is ~1.5 MB; room above it. */
export const MASSIVE_DAY_MAX_BYTES = 8_000_000;
/** Two years of one stock's bars, or one page of splits. */
export const MASSIVE_PAGE_MAX_BYTES = 2_000_000;
/** 9999-12-31T23:59:59.999Z: a bar time outside 1970…9999 is not a trading day. */
const MAX_EPOCH_MS = 253_402_300_799_999;
/** Pages one history or split listing may follow (`next_url`). */
export const MASSIVE_MAX_PAGES = 5;

export interface MassiveDeps {
	readonly apiKey: string;
	readonly fetcher: SafeFetcher;
}

const resultsSchema = z.object({
	results: z.array(z.unknown()).optional(),
	next_url: z.string().nullish(),
});
/** What makes an answer without results an empty (holiday) day. */
const emptyDaySchema = z.object({ status: z.literal("OK"), resultsCount: z.literal(0) });
const barRowSchema = z.object({
	T: z.string().optional(),
	o: z.unknown().optional(),
	h: z.unknown().optional(),
	l: z.unknown().optional(),
	c: z.unknown().optional(),
	v: z.unknown().optional(),
	t: z.number().optional(),
	otc: z.boolean().optional(),
});
const splitRowSchema = z.object({ ticker: z.string().optional() });

/** The problem a Massive fetch failure stands for (401 key, 403 plan, 404, 429, else failed). */
export function massiveProblem(error: SafeFetchError): StockPriceProblem {
	const status = error.status ?? null;
	if (error.code === "HTTP_ERROR" && error.status === 403) {
		return { kind: "plan-refused", status: error.status };
	}
	return error.code === "HTTP_ERROR" ? problemOfStatus(status) : { kind: "failed", status };
}

/**
 * A grouped-daily answer's bars (mapped, consistent, symbol-sorted); null
 * when not that shape. An answer without results is an empty day only with
 * `status: "OK"` and `resultsCount: 0`; anything else is a source failure,
 * never a holiday.
 */
export function parseMassiveDay(json: unknown): StockDayBar[] | null {
	const parsed = resultsSchema.safeParse(json);
	if (!parsed.success) return null;
	const rows = parsed.data.results ?? [];
	if (rows.length === 0 && !emptyDaySchema.safeParse(json).success) return null;
	const bars: StockDayBar[] = [];
	for (const row of rows) {
		const fields = barRowSchema.safeParse(row);
		if (!fields.success || fields.data.otc === true || fields.data.T === undefined) continue;
		const symbol = massiveTickerToSymbol(fields.data.T);
		if (symbol === null) continue;
		const read = consistentBar(
			fields.data.o,
			fields.data.h,
			fields.data.l,
			fields.data.c,
			fields.data.v,
		);
		if (read !== null) bars.push([symbol, read.close, read.bar]);
	}
	return finishDayBars(bars);
}

/** A range answer's bars and its next page; null when not that shape. */
export function parseMassiveHistory(
	json: unknown,
): { readonly bars: StockHistoryBar[]; readonly next: string | null } | null {
	const parsed = resultsSchema.safeParse(json);
	if (!parsed.success) return null;
	const bars: StockHistoryBar[] = [];
	for (const row of parsed.data.results ?? []) {
		const fields = barRowSchema.safeParse(row);
		if (
			!fields.success ||
			fields.data.t === undefined ||
			!Number.isFinite(fields.data.t) ||
			fields.data.t < 0 ||
			fields.data.t > MAX_EPOCH_MS
		)
			continue;
		const read = consistentBar(
			fields.data.o,
			fields.data.h,
			fields.data.l,
			fields.data.c,
			fields.data.v,
		);
		if (read !== null) bars.push([newYorkDate(fields.data.t), read.close, read.bar]);
	}
	return { bars, next: parsed.data.next_url ?? null };
}

/** A splits answer's directory symbols (unmappable tickers dropped) and its next page. */
export function parseMassiveSplits(
	json: unknown,
): { readonly symbols: string[]; readonly next: string | null } | null {
	const parsed = resultsSchema.safeParse(json);
	if (!parsed.success) return null;
	const symbols: string[] = [];
	for (const row of parsed.data.results ?? []) {
		const fields = splitRowSchema.safeParse(row);
		if (!fields.success || fields.data.ticker === undefined) continue;
		const symbol = massiveTickerToSymbol(fields.data.ticker);
		if (symbol !== null) symbols.push(symbol);
	}
	return { symbols, next: parsed.data.next_url ?? null };
}

/** The US stock-price source over Massive. */
export function createMassiveStockPriceSource(deps: MassiveDeps): StockPriceSource {
	const options = (maxBytes: number, signal: AbortSignal): SafeFetchOptions => ({
		maxBytes,
		timeoutMs: MASSIVE_TIMEOUT_MS,
		accept: "application/json",
		signal,
		allowedHosts: MASSIVE_ALLOWED_HOSTS,
		authorization: `Bearer ${deps.apiKey}`,
	});
	/** One paced GET answering JSON. */
	async function get(
		url: string,
		maxBytes: number,
		context: StockPriceRequestContext,
	): Promise<Result<unknown, StockPriceProblem>> {
		const admission = await context.beforeRequest();
		if (admission === "stopped") return err({ kind: "stopped" });
		if (admission === "budget-spent") return err({ kind: "rate-limited", status: null });
		const fetched = await fetchJsonDocument(deps.fetcher, url, options(maxBytes, context.signal));
		if (!fetched.ok) return err(massiveProblem(fetched.error));
		return ok(fetched.value.json);
	}
	/** Follows `next_url` pages (pinned to the host by the fetcher) up to the page cap. */
	async function pages<T>(
		first: string,
		context: StockPriceRequestContext,
		parse: (json: unknown) => { readonly items: T[]; readonly next: string | null } | null,
	): Promise<Result<T[], StockPriceProblem>> {
		const items: T[] = [];
		let url: string | null = first;
		for (let page = 0; url !== null; page += 1) {
			if (page >= MASSIVE_MAX_PAGES) return err({ kind: "failed", status: null });
			const json = await get(url, MASSIVE_PAGE_MAX_BYTES, context);
			if (!json.ok) return json;
			const parsed = parse(json.value);
			if (parsed === null) return err({ kind: "failed", status: null });
			items.push(...parsed.items);
			url = parsed.next;
		}
		return ok(items);
	}
	return {
		provider: "massive",
		market: "US",
		delayDays: 0,
		splitsInDayAnswers: false,
		async fetchDay(date, context): Promise<Result<StockDayAnswer, StockPriceProblem>> {
			const url = `https://${MASSIVE_HOST}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true`;
			const json = await get(url, MASSIVE_DAY_MAX_BYTES, context);
			if (!json.ok) return json;
			const bars = parseMassiveDay(json.value);
			if (bars === null) return err({ kind: "failed", status: null });
			return ok({ bars, adjustedSymbols: [] });
		},
		async fetchHistory(symbol, from, to, context) {
			const ticker = symbolToMassiveTicker(symbol);
			if (ticker === null) return err({ kind: "not-found", status: null });
			const url = `https://${MASSIVE_HOST}/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50000`;
			return pages(url, context, (json) => {
				const parsed = parseMassiveHistory(json);
				return parsed === null ? null : { items: parsed.bars, next: parsed.next };
			});
		},
		async fetchSplitSymbols(after, through, context) {
			const url = `https://${MASSIVE_HOST}/stocks/v1/splits?execution_date.gt=${after}&execution_date.lte=${through}&limit=5000`;
			return pages(url, context, (json) => {
				const parsed = parseMassiveSplits(json);
				return parsed === null ? null : { items: parsed.symbols, next: parsed.next };
			});
		},
	};
}
