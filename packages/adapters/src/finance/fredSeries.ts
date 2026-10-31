/**
 * FRED time series (https://api.stlouisfed.org), fetched by the local runner
 * with the owner's `FRED_API_KEY` (FR-017, ADR-0014).
 *
 * Requests (both pinned to `api.stlouisfed.org` through the SafeFetcher):
 *   GET /fred/series?series_id=<ID>&file_type=json&api_key=<KEY>
 *     metadata: `seriess[0].title`, `.units`, `.frequency_short`
 *     (`D|W|BW|M|Q|SA|A`), `.seasonal_adjustment_short`.
 *   GET /fred/series/observations?series_id=<ID>&file_type=json
 *     &sort_order=desc&limit=<n>[&observation_start=YYYY-MM-DD]&api_key=<KEY>
 *     `observations[] { date, value }`; the value `"."` means "no value for
 *     that date" and is skipped (never turned into 0).
 *
 * Errors arrive as HTTP 400 with `{ error_code, error_message }`: a message
 * about `api_key` is `SOURCE_AUTH_FAILED`, about `series_id` / "does not
 * exist" is `SERIES_NOT_FOUND`; HTTP 429 is `RATE_LIMITED`; anything else is
 * `SOURCE_FAILED`. The error body is requested explicitly (`includeErrorBody`)
 * because the fetcher otherwise discards it; provider message text is matched
 * locally and never stored, shown or logged — every failure carries only the
 * fixed wording per code.
 *
 * When `from` is given, `observation_start` is exactly `from` (inclusive): the
 * runner asks from the stored anchor and checks that the answer reproduces it
 * (ADR-0044), so the adapter adds no overlap of its own. Either way
 * `sort_order=desc&limit` keeps the newest `maxObservations`.
 *
 * The validated metadata of each series is kept for 24 hours (ADR-0039), so a
 * refresh within a day sends only the observations request. Only metadata
 * that passed validation is kept: a not-found or auth answer is asked again.
 */
import {
	type Clock,
	type MarketSeriesSource,
	type MarketSourceUnavailable,
	type SafeFetchError,
	type SafeFetcher,
	type SafeFetchOptions,
	upstreamStatusOf,
} from "@research/application";
import {
	type MarketFrequency,
	type MarketSeriesMeta,
	marketSeriesMetaSchema,
	marketUnavailable,
} from "@research/contracts";
import { err, ok, parseJsonOrNull, type Result, upstreamStatusOrNull } from "@research/domain";
import { z } from "zod";
import { createBoundedCache } from "./boundedCache.ts";
import { fetchJsonDocument, isIsoDate } from "./marketFetch.ts";

export const FRED_HOST = "api.stlouisfed.org";
const FRED_ALLOWED_HOSTS: ReadonlySet<string> = new Set([FRED_HOST]);
const FRED_TIMEOUT_MS = 30_000;
const FRED_MAX_BYTES = 1_000_000;

export const FRED_PUBLISHER = "Federal Reserve Bank of St. Louis (FRED)";

/** How long a series' validated metadata is reused (ADR-0039): it practically never changes. */
export const FRED_META_TTL_MS = 24 * 60 * 60 * 1000;
/** Series whose metadata is kept; the dashboard tracks at most 60 series. */
export const FRED_META_CACHE_ENTRIES = 256;

export function fredSourceUrl(seriesId: string): string {
	return `https://fred.stlouisfed.org/series/${seriesId}`;
}

export interface FredSeriesDeps {
	readonly apiKey: string;
	readonly fetcher: SafeFetcher;
	/** Ages the metadata cache. */
	readonly clock: Clock;
}

const fredSeriesMetaSchema = z.object({
	seriess: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			units: z.string(),
			frequency_short: z.string(),
			seasonal_adjustment_short: z.string(),
		}),
	),
});

const fredObservationsSchema = z.object({
	observations: z.array(z.object({ date: z.string(), value: z.string() })),
});

const fredErrorSchema = z.object({
	error_code: z.number(),
	error_message: z.string(),
});
type FredError = z.infer<typeof fredErrorSchema>;

/** `frequency_short` to contract frequency; SA (semiannual) has no contract value. */
const FRED_FREQUENCIES: { readonly [short: string]: MarketFrequency } = {
	D: "daily",
	W: "weekly",
	BW: "weekly",
	M: "monthly",
	Q: "quarterly",
	A: "annual",
};

function toFrequency(short: string): MarketFrequency {
	return FRED_FREQUENCIES[short] ?? "unknown";
}

function toUnit(units: string, seasonalAdjustmentShort: string): string {
	const base = units.trim();
	if (seasonalAdjustmentShort === "SA" || seasonalAdjustmentShort === "SAAR") {
		return `${base}, seasonally adjusted`;
	}
	return base;
}

function unavailable(
	code: MarketSourceUnavailable["code"],
	upstreamStatus: number | null = null,
): MarketSourceUnavailable {
	return marketUnavailable(code, "fred", upstreamStatus);
}

/**
 * Maps FRED's JSON error. `upstreamStatus` is the answer's HTTP status when
 * FRED answered with an error status; on a 200 that carries an error body it
 * is FRED's own `error_code` (§4a: FRED's status, unchanged).
 */
function mapFredErrorBody(
	error: FredError,
	upstreamStatus: number | null,
): MarketSourceUnavailable {
	const message = error.error_message;
	if (/api_key/i.test(message)) return unavailable("SOURCE_AUTH_FAILED", upstreamStatus);
	if (/series_id|does not exist/i.test(message)) {
		return unavailable("SERIES_NOT_FOUND", upstreamStatus);
	}
	return unavailable("SOURCE_FAILED", upstreamStatus);
}

/** Maps a failed metadata/observations request; the body may be absent. */
function mapFredFailure(error: SafeFetchError): MarketSourceUnavailable {
	const upstreamStatus = upstreamStatusOf(error);
	if (error.code === "HTTP_ERROR" && error.status === 429) {
		return unavailable("RATE_LIMITED", upstreamStatus);
	}
	if (error.code === "HTTP_ERROR" && error.body !== undefined) {
		const body = fredErrorSchema.safeParse(parseJsonOrNull(error.body));
		if (body.success) return mapFredErrorBody(body.data, upstreamStatus);
	}
	return unavailable("SOURCE_FAILED", upstreamStatus);
}

/** A 200 answer carrying FRED's error body: its `error_code` is FRED's status. */
function mapFredErrorPayload(error: FredError): MarketSourceUnavailable {
	return mapFredErrorBody(error, upstreamStatusOrNull(error.error_code));
}

function seriesUrl(apiKey: string, symbol: string): string {
	const url = new URL(`https://${FRED_HOST}/fred/series`);
	url.searchParams.set("series_id", symbol);
	url.searchParams.set("file_type", "json");
	url.searchParams.set("api_key", apiKey);
	return url.href;
}

function observationsUrl(
	apiKey: string,
	symbol: string,
	from: string | null,
	maxObservations: number,
): string {
	const url = new URL(`https://${FRED_HOST}/fred/series/observations`);
	url.searchParams.set("series_id", symbol);
	url.searchParams.set("file_type", "json");
	url.searchParams.set("sort_order", "desc");
	url.searchParams.set("limit", String(maxObservations));
	// Only a real calendar date reaches FRED: anything else asks for the full
	// history, which the runner's anchor check then treats like any answer.
	if (from !== null && isIsoDate(from)) url.searchParams.set("observation_start", from);
	url.searchParams.set("api_key", apiKey);
	return url.href;
}

const FETCH_OPTIONS = {
	maxBytes: FRED_MAX_BYTES,
	timeoutMs: FRED_TIMEOUT_MS,
	accept: "application/json",
	allowedHosts: FRED_ALLOWED_HOSTS,
	includeErrorBody: true,
} as const;

/** `/fred/series`: the series' title, unit and frequency, validated. */
async function fetchMeta(
	deps: FredSeriesDeps,
	symbol: string,
	options: SafeFetchOptions,
): Promise<Result<MarketSeriesMeta, MarketSourceUnavailable>> {
	const meta = await fetchJsonDocument(deps.fetcher, seriesUrl(deps.apiKey, symbol), options);
	if (!meta.ok) {
		return err(mapFredFailure(meta.error));
	}
	// An error payload on 200 is not expected from FRED, but mapping it
	// costs nothing and keeps a misbehaving response honest.
	const asError = fredErrorSchema.safeParse(meta.value.json);
	if (asError.success) return err(mapFredErrorPayload(asError.data));
	const parsedMeta = fredSeriesMetaSchema.safeParse(meta.value.json);
	if (!parsedMeta.success) return err(unavailable("SOURCE_FAILED"));
	const [first] = parsedMeta.data.seriess;
	if (first === undefined) return err(unavailable("SERIES_NOT_FOUND"));
	const candidate: MarketSeriesMeta = {
		title: first.title.trim(),
		unit: toUnit(first.units, first.seasonal_adjustment_short),
		frequency: toFrequency(first.frequency_short),
		publisher: FRED_PUBLISHER,
		sourceUrl: fredSourceUrl(first.id),
	};
	// The contract meta requires a non-empty title and unit: an empty
	// one is an unexpected response, never shipped with a fallback.
	if (!marketSeriesMetaSchema.safeParse(candidate).success) {
		return err(unavailable("SOURCE_FAILED"));
	}
	return ok(candidate);
}

export function createFredSeriesSource(deps: FredSeriesDeps): MarketSeriesSource {
	// Built once per runner process, so the cache spans refresh jobs.
	const metaCache = createBoundedCache<string, MarketSeriesMeta>(
		FRED_META_CACHE_ENTRIES,
		FRED_META_TTL_MS,
	);
	return {
		providerId: "fred",
		async fetchSeries(query) {
			// A cached series costs one request; the entry stays even when the
			// observations below fail, since the metadata itself was valid.
			let candidate = metaCache.get(query.symbol, deps.clock.nowMs());
			if (candidate === undefined) {
				const fetched = await fetchMeta(deps, query.symbol, {
					...FETCH_OPTIONS,
					signal: query.signal,
				});
				if (!fetched.ok) return fetched;
				candidate = fetched.value;
				metaCache.set(query.symbol, candidate, deps.clock.nowMs());
			}

			const observations = await fetchJsonDocument(
				deps.fetcher,
				observationsUrl(deps.apiKey, query.symbol, query.from, query.maxObservations),
				{ ...FETCH_OPTIONS, signal: query.signal },
			);
			if (!observations.ok) {
				return err(mapFredFailure(observations.error));
			}
			const asObsError = fredErrorSchema.safeParse(observations.value.json);
			if (asObsError.success) return err(mapFredErrorPayload(asObsError.data));
			const parsedObs = fredObservationsSchema.safeParse(observations.value.json);
			if (!parsedObs.success) return err(unavailable("SOURCE_FAILED"));
			const points: { readonly observedOn: string; readonly value: number }[] = [];
			for (const row of parsedObs.data.observations) {
				// "." means "no value for that date"; an empty or whitespace
				// value string would convert to 0 via Number(""), so it is
				// skipped the same way (never stored as a real zero).
				const trimmed = row.value.trim();
				if (trimmed === "" || trimmed === ".") continue;
				if (!isIsoDate(row.date)) continue;
				const value = Number(trimmed);
				if (!Number.isFinite(value)) continue;
				points.push({ observedOn: row.date, value });
			}
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
