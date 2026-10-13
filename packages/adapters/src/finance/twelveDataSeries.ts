/**
 * Twelve Data time series (https://api.twelvedata.com), fetched by the local
 * runner with the owner's `TWELVE_DATA_API_KEY` (FR-017, ADR-0014). Verified
 * live on 2026-10-12 with a free-plan key: header authentication works, and
 * `XAU/USD` (daily bars include weekends), `MSFT` and `USD/JPY` answer, while
 * `7203` on `JPX` answers HTTP 404 `{"code":404,"message":"Data not found"}`
 * (Japanese listings are not served on the free plan — hence the fixed
 * `SERIES_NOT_FOUND` wording about the configured plan).
 *
 * Request (pinned to `api.twelvedata.com` through the SafeFetcher):
 *   GET /time_series?symbol=<S>[&exchange=<X>]&interval=1day&outputsize=<n>
 *     [&start_date=YYYY-MM-DD]
 * authenticated with the header `Authorization: apikey <KEY>` — the key
 * never appears in the URL. The `:EXCHANGE` suffix of a series symbol travels
 * as the `exchange` parameter.
 *
 * Success: `{ meta, values[] { datetime, close, … }, status: "ok" }`. Stocks
 * (`meta.currency`) take the currency as the unit and `"<symbol> (<exchange>)"`
 * as the title; currency/metal pairs take the symbol as the title and
 * `"<QUOTE> per <BASE>"` from the symbol's ISO codes as the unit (`XAU` and
 * `XAG` are by definition one troy ounce, so they read e.g.
 * "USD per XAU (troy ounce of gold)").
 *
 * Errors arrive as JSON `{ code, message, status: "error" }` with ANY HTTP
 * status (including 200): 401 is `SOURCE_AUTH_FAILED`, 404 or 400 is
 * `SERIES_NOT_FOUND`, 403 is `PLAN_NOT_ENTITLED`, 429 is `RATE_LIMITED`, and
 * anything else is `SOURCE_FAILED`. A non-200 status without a body is mapped
 * by the status with the same table. An empty `values` is `NO_DATA`.
 * Provider message text is matched never, stored never, shown never, logged
 * never — every failure carries only the fixed wording per code.
 *
 * When `since` is given, `start_date` is `since − 45 days` (revision overlap,
 * like FRED); otherwise the newest `maxObservations`.
 */
import type {
	MarketSeriesSource,
	MarketSourceUnavailable,
	SafeFetcher,
} from "@research/application";
import {
	type MarketSeriesMeta,
	type MarketUnavailableCode,
	marketSeriesMetaSchema,
	marketUnavailable,
} from "@research/contracts";
import { err, ok } from "@research/domain";
import { z } from "zod";
import { datePrefixOf, fetchJsonDocument, httpStatusOf, subtractDaysIso } from "./marketFetch.ts";

export const TWELVE_DATA_HOST = "api.twelvedata.com";
const TWELVE_DATA_ALLOWED_HOSTS: ReadonlySet<string> = new Set([TWELVE_DATA_HOST]);
const TWELVE_DATA_TIMEOUT_MS = 30_000;
const TWELVE_DATA_MAX_BYTES = 1_000_000;
/** Revision overlap for incremental refreshes, like FRED. */
const TWELVE_DATA_REVISION_OVERLAP_DAYS = 45;

export const TWELVE_DATA_PUBLISHER = "Twelve Data";
export const TWELVE_DATA_SOURCE_URL = "https://twelvedata.com/";

export interface TwelveDataSeriesDeps {
	readonly apiKey: string;
	readonly fetcher: SafeFetcher;
}

/** Splits the `:EXCHANGE` suffix off a Twelve Data symbol, if it has one. */
export function splitTwelveSymbol(symbol: string): {
	readonly base: string;
	readonly exchange: string | null;
} {
	const separator = symbol.lastIndexOf(":");
	if (separator === -1) return { base: symbol, exchange: null };
	return { base: symbol.slice(0, separator), exchange: symbol.slice(separator + 1) };
}

const twelveMetaSchema = z.object({
	symbol: z.string().min(1),
	currency: z.string().optional(),
	exchange: z.string().optional(),
});

const twelveSuccessSchema = z.object({
	meta: twelveMetaSchema,
	values: z.array(z.object({ datetime: z.string(), close: z.string() })),
});

const twelveErrorSchema = z.object({
	code: z.number(),
	message: z.string(),
	status: z.literal("error"),
});

function unavailable(code: MarketUnavailableCode): MarketSourceUnavailable {
	return marketUnavailable(code, "twelve-data");
}

function mapTwelveCode(code: number): MarketSourceUnavailable {
	if (code === 401) return unavailable("SOURCE_AUTH_FAILED");
	if (code === 404 || code === 400) return unavailable("SERIES_NOT_FOUND");
	if (code === 403) return unavailable("PLAN_NOT_ENTITLED");
	if (code === 429) return unavailable("RATE_LIMITED");
	return unavailable("SOURCE_FAILED");
}

/**
 * Title and unit from the provider meta and the symbol's ISO codes, or null
 * when no honest unit can be determined (the series then fails as
 * `SOURCE_FAILED` rather than shipping a fabricated unit).
 */
function titleAndUnit(
	metaSymbol: string,
	meta: { readonly currency?: string; readonly exchange?: string },
): { readonly title: string; readonly unit: string } | null {
	if (meta.currency !== undefined && meta.currency.trim() !== "") {
		const exchange = meta.exchange?.trim() ?? "";
		return {
			title: exchange === "" ? metaSymbol : `${metaSymbol} (${exchange})`,
			unit: meta.currency,
		};
	}
	const slash = metaSymbol.indexOf("/");
	if (slash !== -1) {
		const base = metaSymbol.slice(0, slash);
		const quote = metaSymbol.slice(slash + 1);
		if (base !== "" && quote !== "") {
			const baseUnit =
				base === "XAU"
					? "XAU (troy ounce of gold)"
					: base === "XAG"
						? "XAG (troy ounce of silver)"
						: base;
			return { title: metaSymbol, unit: `${quote} per ${baseUnit}` };
		}
	}
	return null;
}

function timeSeriesUrl(
	base: string,
	exchange: string | null,
	since: string | null,
	maxObservations: number,
): string {
	const url = new URL(`https://${TWELVE_DATA_HOST}/time_series`);
	url.searchParams.set("symbol", base);
	if (exchange !== null && exchange !== "") url.searchParams.set("exchange", exchange);
	url.searchParams.set("interval", "1day");
	url.searchParams.set("outputsize", String(maxObservations));
	if (since !== null) {
		const start = subtractDaysIso(since, TWELVE_DATA_REVISION_OVERLAP_DAYS);
		if (start !== null) url.searchParams.set("start_date", start);
	}
	return url.href;
}

export function createTwelveDataSeriesSource(deps: TwelveDataSeriesDeps): MarketSeriesSource {
	return {
		providerId: "twelve-data",
		async fetchSeries(query) {
			const { base, exchange } = splitTwelveSymbol(query.symbol);
			const fetched = await fetchJsonDocument(
				deps.fetcher,
				timeSeriesUrl(base, exchange, query.since, query.maxObservations),
				{
					maxBytes: TWELVE_DATA_MAX_BYTES,
					timeoutMs: TWELVE_DATA_TIMEOUT_MS,
					accept: "application/json",
					allowedHosts: TWELVE_DATA_ALLOWED_HOSTS,
					authorization: `apikey ${deps.apiKey}`,
					signal: query.signal,
				},
			);
			if (!fetched.ok) {
				const status = httpStatusOf(fetched.error);
				return err(status === null ? unavailable("SOURCE_FAILED") : mapTwelveCode(status));
			}
			const asError = twelveErrorSchema.safeParse(fetched.value.json);
			if (asError.success) return err(mapTwelveCode(asError.data.code));
			const parsed = twelveSuccessSchema.safeParse(fetched.value.json);
			if (!parsed.success) return err(unavailable("SOURCE_FAILED"));
			if (parsed.data.values.length === 0) return err(unavailable("NO_DATA"));
			const labelled = titleAndUnit(parsed.data.meta.symbol, parsed.data.meta);
			const candidate: MarketSeriesMeta | null =
				labelled === null
					? null
					: {
							title: labelled.title,
							unit: labelled.unit,
							frequency: "daily",
							publisher: TWELVE_DATA_PUBLISHER,
							sourceUrl: TWELVE_DATA_SOURCE_URL,
						};
			if (candidate === null || !marketSeriesMetaSchema.safeParse(candidate).success) {
				return err(unavailable("SOURCE_FAILED"));
			}
			const points: { readonly observedOn: string; readonly value: number }[] = [];
			for (const bar of parsed.data.values) {
				// The daily bar's close; an unreadable bar is skipped, never zeroed.
				// An empty or whitespace close would convert to 0 via Number(""),
				// so it is skipped explicitly (like ".").
				if (bar.close.trim() === "") continue;
				const observedOn = datePrefixOf(bar.datetime);
				if (observedOn === null) continue;
				const value = Number(bar.close);
				if (!Number.isFinite(value)) continue;
				points.push({ observedOn, value });
			}
			if (points.length === 0) return err(unavailable("NO_DATA"));
			// Ascending by date, deduplicated (the first row per date in
			// ascending order wins), newest `maxObservations`.
			points.sort((a, b) =>
				a.observedOn < b.observedOn ? -1 : a.observedOn > b.observedOn ? 1 : 0,
			);
			const seen = new Set<string>();
			const ascending = points.filter((point) => {
				if (seen.has(point.observedOn)) return false;
				seen.add(point.observedOn);
				return true;
			});
			return ok({ meta: candidate, observations: ascending.slice(-query.maxObservations) });
		},
	};
}
