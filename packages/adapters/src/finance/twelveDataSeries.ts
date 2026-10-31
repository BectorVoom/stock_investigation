/**
 * Twelve Data time series, fetched by the local runner with the owner's
 * `TWELVE_DATA_API_KEY` (FR-017, ADR-0014). The request is pinned to
 * `api.twelvedata.com` through the SafeFetcher and authenticated by header,
 * so the key never appears in the URL. The `:EXCHANGE` suffix of a series
 * symbol travels as the `exchange` parameter.
 *
 * Wire format, limits and error mapping: docs/external-apis/apis/twelve-data.md
 *
 * Stocks (`meta.currency`) take the currency as the unit and
 * `"<symbol> (<exchange>)"` as the title; currency/metal pairs take the symbol
 * as the title and `"<QUOTE> per <BASE>"` from the symbol's ISO codes as the
 * unit (`XAU` and `XAG` are by definition one troy ounce, so they read e.g.
 * "USD per XAU (troy ounce of gold)"). Japanese listings are not served on the
 * free plan, hence the fixed `SERIES_NOT_FOUND` wording about the configured
 * plan. Errors can arrive with any HTTP status, including 200, so the body's
 * `status` decides. Provider message text is never stored, shown or logged —
 * every failure carries only the fixed wording per code.
 *
 * When `from` is given, `start_date` is exactly `from` (inclusive): the runner
 * asks from the stored anchor and checks that the answer reproduces it
 * (ADR-0044), so the adapter adds no overlap of its own. `outputsize` still
 * caps the answer at the newest `maxObservations` bars. Without `from` the
 * answer is the newest `maxObservations`.
 */
import {
	type MarketSeriesSource,
	type MarketSourceUnavailable,
	type SafeFetcher,
	upstreamStatusOf,
} from "@research/application";
import {
	type MarketSeriesMeta,
	type MarketUnavailableCode,
	marketSeriesMetaSchema,
	marketUnavailable,
} from "@research/contracts";
import { err, ok, upstreamStatusOrNull } from "@research/domain";
import { z } from "zod";
import { admitMarketRequest, datePrefixOf, fetchJsonDocument, isIsoDate } from "./marketFetch.ts";

export const TWELVE_DATA_HOST = "api.twelvedata.com";
const TWELVE_DATA_ALLOWED_HOSTS: ReadonlySet<string> = new Set([TWELVE_DATA_HOST]);
const TWELVE_DATA_TIMEOUT_MS = 30_000;
const TWELVE_DATA_MAX_BYTES = 1_000_000;

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

function unavailable(
	code: MarketUnavailableCode,
	upstreamStatus: number | null = null,
): MarketSourceUnavailable {
	return marketUnavailable(code, "twelve-data", upstreamStatus);
}

/**
 * Twelve Data's status — the HTTP status of an error answer, or the JSON
 * error `code` it puts on any answer — as our code, with the status itself
 * kept unchanged beside it (§4a). A `code` that is not an HTTP status is
 * classified but not reported as one.
 */
function mapTwelveCode(code: number): MarketSourceUnavailable {
	const upstreamStatus = upstreamStatusOrNull(code);
	if (code === 401) return unavailable("SOURCE_AUTH_FAILED", upstreamStatus);
	// 400 is an invalid parameter, not a missing symbol: SERIES_NOT_FOUND's
	// wording would blame the plan, so it falls through to SOURCE_FAILED.
	if (code === 404) return unavailable("SERIES_NOT_FOUND", upstreamStatus);
	if (code === 403) return unavailable("PLAN_NOT_ENTITLED", upstreamStatus);
	if (code === 429) return unavailable("RATE_LIMITED", upstreamStatus);
	return unavailable("SOURCE_FAILED", upstreamStatus);
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
			unit: meta.currency.trim(),
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
	from: string | null,
	maxObservations: number,
): string {
	const url = new URL(`https://${TWELVE_DATA_HOST}/time_series`);
	url.searchParams.set("symbol", base);
	if (exchange !== null && exchange !== "") url.searchParams.set("exchange", exchange);
	url.searchParams.set("interval", "1day");
	url.searchParams.set("outputsize", String(maxObservations));
	// Only a real calendar date reaches Twelve Data: anything else asks for
	// the newest bars, which the runner's anchor check then treats like any answer.
	if (from !== null && isIsoDate(from)) url.searchParams.set("start_date", from);
	return url.href;
}

export function createTwelveDataSeriesSource(deps: TwelveDataSeriesDeps): MarketSeriesSource {
	return {
		providerId: "twelve-data",
		async fetchSeries(query) {
			const { base, exchange } = splitTwelveSymbol(query.symbol);
			const refused = await admitMarketRequest(query.beforeRequest, "twelve-data");
			if (refused !== null) return err(refused);
			const fetched = await fetchJsonDocument(
				deps.fetcher,
				timeSeriesUrl(base, exchange, query.from, query.maxObservations),
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
				const status = upstreamStatusOf(fetched.error);
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
