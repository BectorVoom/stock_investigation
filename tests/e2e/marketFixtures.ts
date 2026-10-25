import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFredSeriesSource, createTwelveDataSeriesSource } from "@research/adapters/finance";
import type {
	FetchedDocument,
	MarketSeriesSource,
	SafeFetchError,
	SafeFetcher,
	SafeFetchOptions,
} from "@research/application";
import { err, ok, type Result } from "@research/domain";

/**
 * Fixture market data for the browser E2E run: the REAL FRED and Twelve Data
 * adapters served from REAL recorded provider responses
 * (`packages/adapters/test/finance/fixtures/`, no keys, no network) through
 * the REAL runner loop. Series without a recorded response fail as
 * SERIES_NOT_FOUND (fixed wording), so the suite only ever shows numbers
 * from real recorded responses, labelled as fixtures in the report.
 *
 * Twelve Data authenticates with the `Authorization: apikey <KEY>` header
 * (verified live); the stub requires that header so the suite proves the key
 * travels in the header, never in the URL.
 */
const FIXTURES = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"packages",
	"adapters",
	"test",
	"finance",
	"fixtures",
);

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Failure injection for the scripted UI review's stale-data state (H5): when
 * this JSON file exists, every listed series id fails as if the provider had
 * no data for it (the recorded NOT_FOUND shape, hence the fixed
 * SERIES_NOT_FOUND wording). The review writes `{ "seriesIds": [...] }`,
 * queues a refresh over series that already hold stored observations,
 * screenshots the stale state, and deletes the file again. Absent,
 * unreadable or malformed → no failures, so the E2E suite (which never
 * writes it) behaves exactly as before. Read per request so the review can
 * toggle failures between two refreshes without restarting the runner.
 */
export function marketFailureFile(): string {
	return join(REPO_ROOT, "test-results", "e2e-market-fail.json");
}

function failingSeriesIds(): ReadonlySet<string> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(marketFailureFile(), "utf8"));
		if (typeof parsed !== "object" || parsed === null || !("seriesIds" in parsed)) {
			return new Set();
		}
		const ids = (parsed as { readonly seriesIds: unknown }).seriesIds;
		if (!Array.isArray(ids)) return new Set();
		return new Set(ids.filter((id): id is string => typeof id === "string"));
	} catch {
		return new Set();
	}
}

function readFixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

const FRED_META: { readonly [symbol: string]: string } = {
	VIXCLS: readFixture("fred-series-VIXCLS.json"),
};
const FRED_OBSERVATIONS: { readonly [symbol: string]: string } = {
	VIXCLS: readFixture("fred-observations-VIXCLS.json"),
};
/** Recorded shape of a FRED unknown-series error (HTTP 400). */
const FRED_NOT_FOUND = readFixture("fred-series-notfound.json");

const TWELVE: { readonly [seriesId: string]: string } = {
	"XAU/USD": readFixture("twelvedata-key-symbol_XAU_USD.json"),
	AAPL: readFixture("twelvedata-timeseries-AAPL.json"),
	MSFT: readFixture("twelvedata-key-symbol_MSFT.json"),
	"USD/JPY": readFixture("twelvedata-key-symbol_USD_JPY.json"),
	"EUR/USD": readFixture("twelvedata-timeseries-EURUSD.json"),
};
/**
 * Recorded shape of a Twelve Data unknown-series error (HTTP 404); only the
 * symbol differs per request, which the adapter never shows.
 */
const TWELVE_NOT_FOUND = readFixture("twelvedata-key-symbol_7203_exchange_JPX.json");

function httpError(status: number, body: string): Result<FetchedDocument, SafeFetchError> {
	return err({
		code: "HTTP_ERROR",
		detail: `HTTP ${status} from the fixture provider`,
		status: status,
		body,
	});
}

function documentFor(url: string, text: string): Result<FetchedDocument, SafeFetchError> {
	return ok({ finalUrl: url, contentType: "application/json", text });
}

export const fixtureMarketFetcher: SafeFetcher = {
	async fetchText(
		url: string,
		options: SafeFetchOptions,
	): Promise<Result<FetchedDocument, SafeFetchError>> {
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return err({ code: "NETWORK_ERROR", detail: "not a fixture market URL" });
		}
		if (parsed.hostname === "api.stlouisfed.org") {
			const symbol = parsed.searchParams.get("series_id") ?? "";
			const failing = failingSeriesIds();
			if (parsed.pathname === "/fred/series") {
				if (failing.has(`fred:${symbol}`)) return httpError(400, FRED_NOT_FOUND);
				const fixture = FRED_META[symbol];
				return fixture === undefined ? httpError(400, FRED_NOT_FOUND) : documentFor(url, fixture);
			}
			if (parsed.pathname === "/fred/series/observations") {
				if (failing.has(`fred:${symbol}`)) return httpError(400, FRED_NOT_FOUND);
				const fixture = FRED_OBSERVATIONS[symbol];
				return fixture === undefined ? httpError(400, FRED_NOT_FOUND) : documentFor(url, fixture);
			}
			return err({ code: "NETWORK_ERROR", detail: "not a fixture market URL" });
		}
		if (parsed.hostname === "api.twelvedata.com") {
			if (options.authorization !== "apikey e2e-fixture") {
				return err({ code: "NETWORK_ERROR", detail: "missing fixture API key header" });
			}
			if (parsed.pathname === "/time_series") {
				const symbol = parsed.searchParams.get("symbol") ?? "";
				const exchange = parsed.searchParams.get("exchange") ?? "";
				const seriesId = exchange === "" ? symbol : `${symbol}:${exchange}`;
				if (failingSeriesIds().has(`twelve-data:${seriesId}`)) {
					return httpError(404, TWELVE_NOT_FOUND);
				}
				const fixture = TWELVE[seriesId];
				return fixture === undefined ? httpError(404, TWELVE_NOT_FOUND) : documentFor(url, fixture);
			}
			return err({ code: "NETWORK_ERROR", detail: "not a fixture market URL" });
		}
		return err({ code: "NETWORK_ERROR", detail: "not a fixture market URL" });
	},
};

/** The registry the E2E runner loop uses: real adapters, fixture transport. */
export function fixtureMarketSources(): ReadonlyMap<"fred" | "twelve-data", MarketSeriesSource> {
	return new Map([
		["fred", createFredSeriesSource({ apiKey: "e2e-fixture", fetcher: fixtureMarketFetcher })],
		[
			"twelve-data",
			createTwelveDataSeriesSource({ apiKey: "e2e-fixture", fetcher: fixtureMarketFetcher }),
		],
	]);
}
