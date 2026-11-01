/**
 * J-Quants (JPX's official API, V2) Japanese stock prices for the
 * `stock-prices-sync` job (ADR-0058 §2), fetched by the local runner with
 * the owner's `JQUANTS_API_KEY`. Requests are pinned to `api.jquants.com`
 * through the SafeFetcher and authenticated by the `x-api-key` header, so
 * the key never appears in a URL or a log line.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/jquants.md
 *
 *  - Day: `GET /v2/equities/bars/daily?date=YYYY-MM-DD`, following
 *    `pagination_key` until it is absent (each page paced; a day is
 *    reported only when every page was read).
 *  - History: `GET /v2/equities/bars/daily?code=<5-char>&from=&to=`, paginated the same way.
 *  - The adjusted values are stored (`AdjO AdjH AdjL AdjC AdjVo`); a record
 *    whose prices are null (no trade that day) gives no bar. A 5-character
 *    `Code` ending in `0` is the directory's 4-character code; any other
 *    code (a preferred line) is dropped. A day record whose `AdjFactor ≠ 1`
 *    marks that code's stored bars as needing a refetch.
 *  - The Free plan is about 12 weeks behind (`JQUANTS_DELAY_DAYS`, default
 *    84): days newer than that are not asked for.
 *
 * Status mapping: 403 whose message names the API key, or 401 → the key was
 * rejected; any other 403 → the plan does not cover the request; 404 →
 * unknown; 429 → rate limited (no Retry-After: the pacer's one-minute
 * window and the next job's gap wait it out); anything else a source
 * failure — the status always kept unchanged (ADR-0037). The error body is
 * read only to tell the key from the plan, never logged or stored.
 */
import type { SafeFetchError, SafeFetcher, SafeFetchOptions } from "@research/application";
import type { StockDayBar, StockHistoryBar } from "@research/contracts";
import { err, ok, parseJson, type Result } from "@research/domain";
import { z } from "zod";
import { fetchJsonDocument, isIsoDate } from "./marketFetch.ts";
import {
	consistentBar,
	finishDayBars,
	jquantsCodeToSymbol,
	problemOfStatus,
	type StockDayAnswer,
	type StockPriceProblem,
	type StockPriceRequestContext,
	type StockPriceSource,
	symbolToJquantsCode,
} from "./stockPrices.ts";

export const JQUANTS_HOST = "api.jquants.com";
export const JQUANTS_PUBLISHER = "J-Quants";
export const JQUANTS_SOURCE_URL = "https://jpx-jquants.com/";
const JQUANTS_ALLOWED_HOSTS: ReadonlySet<string> = new Set([JQUANTS_HOST]);
const JQUANTS_TIMEOUT_MS = 30_000;
/** One page of a day's ~4,400 records (every field of each). */
export const JQUANTS_PAGE_MAX_BYTES = 8_000_000;
/** Pages one day or history may follow (`pagination_key`). */
export const JQUANTS_MAX_PAGES = 20;
/** The Free plan's delay (12 weeks); a paid plan sets 0. */
export const DEFAULT_JQUANTS_DELAY_DAYS = 84;

export interface JquantsDeps {
	readonly apiKey: string;
	readonly fetcher: SafeFetcher;
	/** `JQUANTS_DELAY_DAYS`. */
	readonly delayDays: number;
}

const pageSchema = z.object({
	data: z.array(z.unknown()),
	pagination_key: z.string().nullish(),
});
const recordSchema = z.object({
	Date: z.string(),
	Code: z.string(),
	AdjO: z.unknown().optional(),
	AdjH: z.unknown().optional(),
	AdjL: z.unknown().optional(),
	AdjC: z.unknown().optional(),
	AdjVo: z.unknown().optional(),
	AdjFactor: z.unknown().optional(),
});
const errorBodySchema = z.object({ message: z.string() });

/** The problem a J-Quants fetch failure stands for. */
export function jquantsProblem(error: SafeFetchError): StockPriceProblem {
	if (error.code !== "HTTP_ERROR") return { kind: "failed", status: error.status ?? null };
	if (error.status === 403) {
		const body = error.body === undefined ? null : parseJson(error.body);
		const message = body?.ok === true ? errorBodySchema.safeParse(body.value) : null;
		const aboutKey = message?.success === true && /api key/i.test(message.data.message);
		return aboutKey
			? { kind: "auth-failed", status: error.status }
			: { kind: "plan-refused", status: error.status };
	}
	return problemOfStatus(error.status);
}

/** One record as `[symbol, date, close, bar]` with its adjustment flag; null when it gives no bar. */
function readRecord(row: unknown): {
	readonly symbol: string;
	readonly date: string;
	readonly close: number;
	readonly bar: StockDayBar[2];
	readonly adjusted: boolean;
} | null {
	const fields = recordSchema.safeParse(row);
	if (!fields.success || !isIsoDate(fields.data.Date)) return null;
	const symbol = jquantsCodeToSymbol(fields.data.Code);
	if (symbol === null) return null;
	const read = consistentBar(
		fields.data.AdjO,
		fields.data.AdjH,
		fields.data.AdjL,
		fields.data.AdjC,
		fields.data.AdjVo,
	);
	if (read === null) return null;
	const factor = fields.data.AdjFactor;
	const adjusted = typeof factor === "number" && Number.isFinite(factor) && factor !== 1;
	return { symbol, date: fields.data.Date, close: read.close, bar: read.bar, adjusted };
}

/** One page: its records and the next page's key; null when not that shape. */
export function parseJquantsPage(
	json: unknown,
): { readonly records: readonly unknown[]; readonly next: string | null } | null {
	const parsed = pageSchema.safeParse(json);
	if (!parsed.success) return null;
	const next = parsed.data.pagination_key;
	return {
		records: parsed.data.data,
		next: next === undefined || next === null || next === "" ? null : next,
	};
}

/** A day's records as its bars (that date only) and the symbols adjusted that day. */
export function jquantsDayAnswer(records: readonly unknown[], date: string): StockDayAnswer {
	const bars: StockDayBar[] = [];
	const adjusted = new Set<string>();
	for (const row of records) {
		const read = readRecord(row);
		if (read === null || read.date !== date) continue;
		bars.push([read.symbol, read.close, read.bar]);
		if (read.adjusted) adjusted.add(read.symbol);
	}
	return { bars: finishDayBars(bars), adjustedSymbols: [...adjusted].sort() };
}

/** A history's records as bars of that one code. */
export function jquantsHistoryBars(records: readonly unknown[], symbol: string): StockHistoryBar[] {
	const bars: StockHistoryBar[] = [];
	for (const row of records) {
		const read = readRecord(row);
		if (read !== null && read.symbol === symbol) bars.push([read.date, read.close, read.bar]);
	}
	return bars;
}

/** The JP stock-price source over J-Quants. */
export function createJquantsStockPriceSource(deps: JquantsDeps): StockPriceSource {
	const options = (signal: AbortSignal): SafeFetchOptions => ({
		maxBytes: JQUANTS_PAGE_MAX_BYTES,
		timeoutMs: JQUANTS_TIMEOUT_MS,
		accept: "application/json",
		signal,
		allowedHosts: JQUANTS_ALLOWED_HOSTS,
		xApiKey: deps.apiKey,
		includeErrorBody: true,
	});
	/** Every page of one query, each paced. */
	async function records(
		query: URLSearchParams,
		context: StockPriceRequestContext,
	): Promise<Result<unknown[], StockPriceProblem>> {
		const all: unknown[] = [];
		let key: string | null = null;
		for (let page = 0; page === 0 || key !== null; page += 1) {
			if (page >= JQUANTS_MAX_PAGES) return err({ kind: "failed", status: null });
			const params = new URLSearchParams(query);
			if (key !== null) params.set("pagination_key", key);
			const admission = await context.beforeRequest();
			if (admission === "stopped") return err({ kind: "stopped" });
			if (admission === "budget-spent") return err({ kind: "rate-limited", status: null });
			const url = `https://${JQUANTS_HOST}/v2/equities/bars/daily?${params.toString()}`;
			const fetched = await fetchJsonDocument(deps.fetcher, url, options(context.signal));
			if (!fetched.ok) return err(jquantsProblem(fetched.error));
			const parsed = parseJquantsPage(fetched.value.json);
			if (parsed === null) return err({ kind: "failed", status: null });
			all.push(...parsed.records);
			key = parsed.next;
		}
		return ok(all);
	}
	return {
		provider: "jquants",
		market: "JP",
		delayDays: deps.delayDays,
		splitsInDayAnswers: true,
		async fetchDay(date, context) {
			const answer = await records(new URLSearchParams({ date }), context);
			return answer.ok ? ok(jquantsDayAnswer(answer.value, date)) : answer;
		},
		async fetchHistory(symbol, from, to, context) {
			const code = symbolToJquantsCode(symbol);
			if (code === null) return err({ kind: "not-found", status: null });
			const answer = await records(new URLSearchParams({ code, from, to }), context);
			return answer.ok ? ok(jquantsHistoryBars(answer.value, symbol)) : answer;
		},
		async fetchSplitSymbols() {
			// J-Quants reports adjustments in the day answers (`AdjFactor`).
			return ok([]);
		},
	};
}
