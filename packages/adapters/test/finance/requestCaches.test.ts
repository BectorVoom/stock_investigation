/**
 * ADR-0039: the FRED metadata cache and the 13F filing cache send fewer
 * requests without changing what a call returns. Twin of the Rust
 * `crates/research-finance/tests/request_caches.rs`.
 */
import type { Clock, SafeFetchError } from "@research/application";
import { err, ok, type Result } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createBoundedCache } from "../../src/finance/boundedCache.ts";
import {
	createFredSeriesSource,
	FRED_META_CACHE_ENTRIES,
	FRED_META_TTL_MS,
} from "../../src/finance/fredSeries.ts";
import { createSec13FSource } from "../../src/finance/sec13f.ts";
import type { SecClient, SecError } from "../../src/finance/secClient.ts";
import { secError } from "../../src/finance/secClient.ts";
import type { ScriptedPage } from "../tools/support.ts";
import { createScriptedFetcher } from "../tools/support.ts";

const NEVER = new AbortController().signal;

function testClock(startMs: number): Clock & { advance(ms: number): void } {
	let nowMs = startMs;
	return {
		nowMs: () => nowMs,
		nowIso: () => new Date(nowMs).toISOString(),
		advance(ms) {
			nowMs += ms;
		},
	};
}

describe("bounded cache", () => {
	it("evicts the least recently used entry first", () => {
		const cache = createBoundedCache<string, number>(2, null);
		cache.set("a", 1, 0);
		cache.set("b", 2, 0);
		expect(cache.get("a", 0)).toBe(1);
		cache.set("c", 3, 0);
		expect(cache.size).toBe(2);
		expect(cache.get("b", 0)).toBeUndefined();
		expect(cache.get("a", 0)).toBe(1);
		expect(cache.get("c", 0)).toBe(3);
	});

	it("expires an entry after its TTL, and when the clock moved backwards", () => {
		const cache = createBoundedCache<string, number>(4, 100);
		cache.set("a", 1, 1_000);
		expect(cache.get("a", 1_099)).toBe(1);
		expect(cache.get("a", 1_100)).toBeUndefined();
		expect(cache.size).toBe(0);
		cache.set("b", 2, 1_000);
		expect(cache.get("b", 999)).toBeUndefined();
	});

	it("replaces a re-set key without growing, and a zero capacity stores nothing", () => {
		const cache = createBoundedCache<string, number>(2, 100);
		cache.set("a", 1, 0);
		cache.set("a", 2, 50);
		expect(cache.size).toBe(1);
		expect(cache.get("a", 140)).toBe(2);
		const none = createBoundedCache<string, number>(0, null);
		none.set("a", 1, 0);
		expect(none.get("a", 0)).toBeUndefined();
	});
});

/* ---------- FRED ---------- */

const API_KEY = "fred-test-key";
const META = JSON.stringify({
	seriess: [
		{
			id: "VIXCLS",
			title: "CBOE Volatility Index: VIX",
			units: "Index",
			frequency_short: "D",
			seasonal_adjustment_short: "NSA",
		},
	],
});
const OBSERVATIONS = JSON.stringify({
	observations: [
		{ date: "2026-10-23", value: "16.4" },
		{ date: "2026-10-22", value: "." },
	],
});

function metaUrl(id: string): string {
	return `https://api.stlouisfed.org/fred/series?series_id=${id}&file_type=json&api_key=${API_KEY}`;
}
function observationsUrl(id: string): string {
	return `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&file_type=json&sort_order=desc&limit=10&api_key=${API_KEY}`;
}

/** The scripted pages are read on every request, so a test can change an answer between calls. */
function fred(ids: readonly string[] = ["VIXCLS"]) {
	const pages: { [url: string]: ScriptedPage } = {};
	for (const id of ids) {
		pages[metaUrl(id)] = { text: META };
		pages[observationsUrl(id)] = { text: OBSERVATIONS };
	}
	const fetcher = createScriptedFetcher(pages);
	const clock = testClock(1_790_000_000_000);
	const source = createFredSeriesSource({ apiKey: API_KEY, fetcher, clock });
	let seen = 0;
	/** The requests since the last call, as `meta:<id>` / `observations:<id>`. */
	const take = (): string[] => {
		const urls = fetcher.urls().slice(seen);
		seen = fetcher.urls().length;
		return urls.map((url) => {
			const parsed = new URL(url);
			const kind = parsed.pathname === "/fred/series" ? "meta" : "observations";
			return `${kind}:${parsed.searchParams.get("series_id") ?? ""}`;
		});
	};
	const fetch = (symbol = "VIXCLS") =>
		source.fetchSeries({ symbol, since: null, maxObservations: 10, signal: NEVER });
	return { pages, clock, fetch, take };
}

function httpError(status: number, message?: string): { readonly error: SafeFetchError } {
	return {
		error: {
			code: "HTTP_ERROR",
			detail: `HTTP ${status}`,
			status,
			...(message === undefined
				? {}
				: { body: JSON.stringify({ error_code: status, error_message: message }) }),
		},
	};
}

describe("FRED metadata cache (ADR-0039)", () => {
	it("a second fetch within 24 hours sends only the observations request", async () => {
		const { clock, fetch, take } = fred();
		const first = await fetch();
		expect(take()).toEqual(["meta:VIXCLS", "observations:VIXCLS"]);
		clock.advance(FRED_META_TTL_MS - 1);
		const second = await fetch();
		expect(take()).toEqual(["observations:VIXCLS"]);
		expect(second).toEqual(first);
	});

	it("after 24 hours sends both requests again", async () => {
		const { clock, fetch, take } = fred();
		await fetch();
		take();
		clock.advance(FRED_META_TTL_MS);
		await fetch();
		expect(take()).toEqual(["meta:VIXCLS", "observations:VIXCLS"]);
	});

	it("does not cache invalid or failed metadata", async () => {
		const { pages, fetch, take } = fred();
		const answers: readonly [ScriptedPage, string][] = [
			[{ text: META.replace("CBOE Volatility Index: VIX", " ") }, "SOURCE_FAILED"],
			[httpError(400, "Bad Request.  The series does not exist."), "SERIES_NOT_FOUND"],
			[{ text: '{"seriess":[]}' }, "SERIES_NOT_FOUND"],
			[
				httpError(400, "Bad Request.  The value for variable api_key is not registered."),
				"SOURCE_AUTH_FAILED",
			],
			[{ error: { code: "NETWORK_ERROR", detail: "down" } }, "SOURCE_FAILED"],
		];
		for (const [answer, code] of answers) {
			pages[metaUrl("VIXCLS")] = answer;
			const result = await fetch();
			expect(result.ok ? null : result.error.code).toBe(code);
		}
		expect(take()).toEqual(Array.from({ length: answers.length }, () => "meta:VIXCLS"));
		pages[metaUrl("VIXCLS")] = { text: META };
		await fetch();
		await fetch();
		expect(take()).toEqual(["meta:VIXCLS", "observations:VIXCLS", "observations:VIXCLS"]);
	});

	it("keeps the cached metadata when the observations request fails", async () => {
		const { pages, fetch, take } = fred();
		pages[observationsUrl("VIXCLS")] = httpError(429);
		const limited = await fetch();
		expect(limited.ok ? null : limited.error.code).toBe("RATE_LIMITED");
		expect(take()).toEqual(["meta:VIXCLS", "observations:VIXCLS"]);
		pages[observationsUrl("VIXCLS")] = { text: OBSERVATIONS };
		expect((await fetch()).ok).toBe(true);
		expect(take()).toEqual(["observations:VIXCLS"]);
	});

	it("holds at most its entry limit", async () => {
		const ids = Array.from({ length: FRED_META_CACHE_ENTRIES + 1 }, (_, n) => `S${n}`);
		const { fetch, take } = fred(ids);
		for (const id of ids) expect((await fetch(id)).ok).toBe(true);
		take();
		const newest = ids[FRED_META_CACHE_ENTRIES] ?? "";
		await fetch(newest);
		await fetch("S1");
		expect(take()).toEqual([`observations:${newest}`, "observations:S1"]);
		await fetch("S0");
		expect(take()).toEqual(["meta:S0", "observations:S0"]);
	});
});

/* ---------- 13F ---------- */

const CIK = "0009999993";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0009999993.json";

type Row = readonly [accession: string, filed: string, period: string];
const Q1: Row = ["0009999993-26-000001", "2026-05-15", "2026-03-31"];
const Q2: Row = ["0009999993-26-000004", "2026-08-14", "2026-06-30"];
const Q3: Row = ["0009999993-26-000009", "2026-11-14", "2026-09-30"];

function filingUrl(accession: string): string {
	return `https://www.sec.gov/Archives/edgar/data/9999993/${accession.replaceAll("-", "")}/${accession}.txt`;
}

function submissions(rows: readonly Row[]): string {
	return JSON.stringify({
		name: "Synthetic Capital Management LP",
		filings: {
			recent: {
				accessionNumber: rows.map((row) => row[0]),
				filingDate: rows.map((row) => row[1]),
				reportDate: rows.map((row) => row[2]),
				form: rows.map(() => "13F-HR"),
			},
		},
	});
}

function filingText(shares: number): string {
	return `<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n<XML>\n<informationTable><infoTable><nameOfIssuer>SYNTHETIC CORP</nameOfIssuer><cusip>999999AA1</cusip><value>${shares}</value><shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable></informationTable>\n</XML>\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>`;
}

/** Serves documents by URL and records every URL asked for. */
function thirteenF() {
	const pages = new Map<string, Result<string, SecError>>([
		[SUBMISSIONS_URL, ok(submissions([Q2, Q1]))],
		[filingUrl(Q1[0]), ok(filingText(100))],
		[filingUrl(Q2[0]), ok(filingText(200))],
		[filingUrl(Q3[0]), ok(filingText(300))],
	]);
	const requests: string[] = [];
	const client: SecClient = {
		async fetchDocument(url) {
			requests.push(url);
			const page = pages.get(url) ?? err(secError("NO_DATA", "no page"));
			return page.ok ? ok({ url, text: page.value }) : page;
		},
	};
	const take = (): string[] => requests.splice(0);
	return { pages, take, source: createSec13FSource({ client }) };
}

describe("13F filing cache (ADR-0039)", () => {
	it("a second call for the same manager sends only the submissions request", async () => {
		const { source, take } = thirteenF();
		const first = await source.latestHoldings(CIK, NEVER);
		expect(take()).toEqual([SUBMISSIONS_URL, filingUrl(Q2[0]), filingUrl(Q1[0])]);
		// The same manager, written another way: the CIK is normalised first.
		const second = await source.latestHoldings("CIK9999993", NEVER);
		expect(take()).toEqual([SUBMISSIONS_URL]);
		expect(second).toEqual(first);
	});

	it("fetches only a newer filing and serves the old current one as previous", async () => {
		const { source, pages, take } = thirteenF();
		await source.latestHoldings(CIK, NEVER);
		take();
		pages.set(SUBMISSIONS_URL, ok(submissions([Q3, Q2, Q1])));
		const report = await source.latestHoldings(CIK, NEVER);
		expect(take()).toEqual([SUBMISSIONS_URL, filingUrl(Q3[0])]);
		if (!report.ok) throw new Error(report.error.code);
		expect(report.value.current.accessionNumber).toBe(Q3[0]);
		expect(report.value.current.holdings[0]?.reportedShares).toBe(300);
		expect(report.value.previous?.accessionNumber).toBe(Q2[0]);
		expect(report.value.previous?.holdings[0]?.reportedShares).toBe(200);
	});

	it("does not cache a failed load", async () => {
		const { source, pages, take } = thirteenF();
		pages.set(filingUrl(Q2[0]), err(secError("FETCH_FAILED", "HTTP 503")));
		expect((await source.latestHoldings(CIK, NEVER)).ok).toBe(false);
		expect(take()).toEqual([SUBMISSIONS_URL, filingUrl(Q2[0])]);
		// A filing without an information table fails to parse: not cached either.
		pages.set(filingUrl(Q2[0]), ok("<SEC-DOCUMENT></SEC-DOCUMENT>"));
		expect((await source.latestHoldings(CIK, NEVER)).ok).toBe(false);
		expect(take()).toEqual([SUBMISSIONS_URL, filingUrl(Q2[0])]);
		pages.set(filingUrl(Q2[0]), ok(filingText(200)));
		expect((await source.latestHoldings(CIK, NEVER)).ok).toBe(true);
		expect(take()).toEqual([SUBMISSIONS_URL, filingUrl(Q2[0]), filingUrl(Q1[0])]);
	});
});
