/**
 * Market series and earnings-date adapters (crate `research-finance`):
 * `marketFetch.ts`, `fredSeries.ts`, `twelveDataSeries.ts`,
 * `finnhubEarnings.ts` and the string-to-number primitive they share.
 *
 * Adapter cases are transcripts: the real TypeScript adapter runs against a
 * scripted fetcher (the n-th call gets the n-th scripted answer) and the case
 * records the query, the script, every call the adapter made (URL and the
 * options that matter) and its result. The corpus is the provider fixtures of
 * the TypeScript tests, every literal body of those tests' families, and
 * seeded mutations (dropped fields, wrong types, hostile numbers and dates,
 * injected failures).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFinnhubEarningsSource } from "../../../packages/adapters/src/finance/finnhubEarnings.ts";
import { createFredSeriesSource } from "../../../packages/adapters/src/finance/fredSeries.ts";
import {
	datePrefixOf,
	fetchJsonDocument,
	isIsoDate,
	subtractDaysIso,
} from "../../../packages/adapters/src/finance/marketFetch.ts";
import {
	createTwelveDataSeriesSource,
	splitTwelveSymbol,
} from "../../../packages/adapters/src/finance/twelveDataSeries.ts";
import { upstreamStatusOf } from "../../../packages/application/src/ports.ts";
import { doubleBits } from "../shared.ts";
import {
	type FetchEvent,
	fetchError,
	HTTP_DETAILS,
	plain,
	Rng,
	type ScriptEntry,
	scriptedBefore,
	scriptedFetcher,
	tickingClock,
} from "./support.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(
	here,
	"..",
	"..",
	"..",
	"packages",
	"adapters",
	"test",
	"finance",
	"fixtures",
);

function fixture(name: string): string {
	return readFileSync(join(fixtureDir, name), "utf8");
}

const NEVER = new AbortController().signal;

/* ---------- string-to-number and the date helpers ---------- */

const NUMBER_STRINGS: readonly string[] = [
	"",
	" ",
	"0",
	"-0",
	"+0",
	"1",
	"15.31",
	".5",
	"5.",
	"-.5",
	"+.5e1",
	"1e3",
	"1E3",
	"1e+3",
	"1e-3",
	"1e",
	"e1",
	".",
	"+",
	"-",
	"0x1F",
	"0X1f",
	"0b101",
	"0B11",
	"0o17",
	"0O7",
	"0x",
	"-0x10",
	"+0x10",
	"0xG",
	"0x1.5",
	"0b2",
	"0o8",
	"Infinity",
	"+Infinity",
	"-Infinity",
	"infinity",
	"inf",
	"NaN",
	"nan",
	"1_000",
	"1,5",
	"١٢٣",
	"1e400",
	"-1e400",
	"1e-400",
	"0.1",
	"0.30000000000000004",
	"9007199254740993",
	"123456789012345678901234567890",
	"0xFFFFFFFFFFFFFFFFFFFF",
	"0x20000000000001",
	"0x20000000000003",
	"0x1fffffffffffff8",
	"0b11111111111111111111111111111111111111111111111111111111",
	" 15 ",
	"﻿15﻿",
	"\u008515",
	"\t15\n",
	" 1.5 ",
	"1 5",
	"15px",
	"0.0000001",
	"1.7976931348623157e308",
	"1.7976931348623159e308",
	"2.2250738585072014e-308",
	"5e-324",
	"4.9e-324",
	"2e-324",
	"00012",
	"-00012.50",
	"1e0001",
	"0e5",
	"0.e5",
	".e5",
];

function jsNumberCases(): unknown[] {
	return NUMBER_STRINGS.map((input) => ({ input, bits: doubleBits(Number(input)) }));
}

const ISO_CANDIDATES: readonly string[] = [
	"2026-10-05",
	"2026-02-29",
	"2024-02-29",
	"2100-02-29",
	"2000-02-29",
	"1900-02-29",
	"0000-01-01",
	"0050-01-01",
	"0099-12-31",
	"0100-01-01",
	"0100-02-29",
	"9999-12-31",
	"2026-13-01",
	"2026-00-10",
	"2026-10-00",
	"2026-10-32",
	"2026-4-5",
	"26-10-05",
	"2026/10/05",
	"20261005",
	"2026-10-05T00:00:00Z",
	"2026-10-05 ",
	" 2026-10-05",
	"２０２６-10-05",
	"2026-10-05\n",
	"",
	"abcd-ef-gh",
];

function dateHelperCases(): unknown {
	const subtract: unknown[] = [];
	for (const iso of ISO_CANDIDATES) {
		for (const days of [0, 1, 45, 365, 36_525]) {
			subtract.push({ iso, days, output: subtractDaysIso(iso, days) });
		}
	}
	const prefixes: unknown[] = [];
	for (const value of [
		...ISO_CANDIDATES,
		"2026-10-05 15:30:00",
		"2026-10-05T15:30:00Z",
		"2026-10-051",
		"2026-10-0",
		"😀2026-10-0",
		"2026-10-😀",
		"2026-10-05😀",
		"0050-01-01 00:00:00",
	]) {
		prefixes.push({ input: value, output: datePrefixOf(value) });
	}
	return {
		isIsoDate: ISO_CANDIDATES.map((input) => ({ input, output: isIsoDate(input) })),
		datePrefix: prefixes,
		subtractDays: subtract,
		// The status comes from the error's `status` field only, never its detail (§4a).
		upstreamStatus: HTTP_DETAILS.flatMap((detail) =>
			(["HTTP_ERROR", "TIMEOUT", "NETWORK_ERROR", "REDIRECT_NOT_AUTHORIZED"] as const).map(
				(code) => {
					const entry = fetchError(code, detail);
					const error = "error" in entry ? entry.error : null;
					return {
						error,
						output: error === null ? null : upstreamStatusOf(error),
					};
				},
			),
		),
		splitTwelve: ["AAPL", "AAPL:NASDAQ", "7203:JPX", "A:B:C", ":X", "X:", ":", "", "EUR/USD"].map(
			(input) => ({ input, output: splitTwelveSymbol(input) }),
		),
	};
}

async function jsonDocumentCases(): Promise<unknown[]> {
	const cases: unknown[] = [];
	const scripts: ScriptEntry[][] = [
		[{ text: '{"a":1}' }],
		[{ text: '{"a":1}', finalUrl: "https://api.stlouisfed.org/other" }],
		[{ text: "{oops" }],
		[{ text: "" }],
		[{ text: '{"a":1,"a":2}' }],
		[fetchError("HTTP_ERROR", "HTTP 429", '{"error_code":429}')],
		[fetchError("TIMEOUT", "no complete response")],
	];
	for (const script of scripts) {
		const events: FetchEvent[] = [];
		const result = await fetchJsonDocument(
			scriptedFetcher(script, events),
			"https://api.stlouisfed.org/fred/series?x=1",
			{
				maxBytes: 10,
				timeoutMs: 20,
				accept: "application/json",
				allowedHosts: new Set(["api.stlouisfed.org"]),
				signal: NEVER,
			},
		);
		cases.push({ script, output: plain(result), events: plain(events) });
	}
	return cases;
}

/* ---------- generic corpus helpers ---------- */

const HOSTILE_NUMBERS: readonly string[] = [
	"15.31",
	"0",
	"-3.5",
	".",
	"",
	"  ",
	" 7.25 ",
	"0x10",
	"1e3",
	"Infinity",
	"-Infinity",
	"NaN",
	"abc",
	"1,5",
	"9999999999999999999999",
	"1e400",
	"-0",
	"+4",
	"٣",
	" 8 ",
	"﻿9﻿",
	"\u008510",
];

const HOSTILE_DATES: readonly string[] = [
	"2026-10-05",
	"2026-10-06",
	"2026-10-07",
	"2026-10-08",
	"2026-10-09",
	"2026-02-30",
	"0050-10-05",
	"2026-10-05 00:00:00",
	"2026-10-05T14:00:00",
	"20261005",
	"bad",
	"",
	"2026-1-5",
	"2024-02-29",
];

const VALID_DATES: readonly string[] = [
	"2026-10-05",
	"2026-10-06",
	"2026-10-07",
	"2026-10-08",
	"2026-10-09",
	"2026-10-02",
	"2024-02-29",
	"2026-09-30",
];

const NORMAL_NUMBERS: readonly string[] = ["15.31", "0", "-3.5", "100", "2.5e2", "332.89001", "7"];

function randomValue(rng: Rng): unknown {
	return rng.pick<unknown>([
		null,
		true,
		0,
		1.5,
		"x",
		"",
		[],
		{},
		[1, 2],
		{ a: 1 },
		Number("12345678901234567890"),
	]);
}

/** Replaces, drops or retypes a few fields of a JSON value (deterministic). */
function mutate(rng: Rng, value: unknown, depth = 0): unknown {
	if (Array.isArray(value)) {
		const copy = value.map((item) => (rng.chance(0.2) ? mutate(rng, item, depth + 1) : item));
		if (rng.chance(0.1) && copy.length > 0) copy.splice(rng.int(0, copy.length - 1), 1);
		if (rng.chance(0.05)) copy.push(randomValue(rng));
		return copy;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value);
		const out: { [key: string]: unknown } = {};
		for (const [key, item] of entries) {
			if (rng.chance(0.08)) continue;
			out[key] = rng.chance(0.12) ? randomValue(rng) : mutate(rng, item, depth + 1);
		}
		if (rng.chance(0.05)) out[rng.pick(["extra", "name", "id", "code"])] = randomValue(rng);
		return out;
	}
	return rng.chance(0.05) ? randomValue(rng) : value;
}

/** Mostly a value of `good`, now and then one of `bad`. */
function mostly<T>(rng: Rng, good: readonly T[], bad: readonly T[], badRate = 0.15): T {
	return rng.chance(badRate) ? rng.pick(bad) : rng.pick(good);
}

/** `mutate` over JSON text; text that is not JSON stays as it is. */
function mutateText(rng: Rng, text: string): string {
	try {
		return JSON.stringify(mutate(rng, JSON.parse(text)));
	} catch {
		return text;
	}
}

function randomFailure(rng: Rng): ScriptEntry {
	const detail = rng.pick(HTTP_DETAILS);
	const body = rng.pick<string | undefined>([
		undefined,
		undefined,
		"",
		"{oops",
		'{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not a 32 character alpha-numeric lower-case string."}',
		'{"error_code":400,"error_message":"Bad Request.  The series does not exist."}',
		'{"error_code":400,"error_message":"Bad Request.  Variable series_id is not set."}',
		'{"error_code":404,"error_message":"Not found"}',
		'{"error_code":"400","error_message":"x"}',
		'{"error_code":400}',
		'{"error_code":429,"error_message":"API KEY limit"}',
		'{"error_message":"api_key"}',
		"[]",
		"null",
		'{"code":401,"message":"bad","status":"error"}',
	]);
	const code = rng.chance(0.75)
		? "HTTP_ERROR"
		: rng.pick(["TIMEOUT", "NETWORK_ERROR", "RESPONSE_TOO_LARGE", "UNSAFE_URL"] as const);
	return fetchError(code, detail, body);
}

/* ---------- FRED ---------- */

interface SeriesCase {
	readonly provider: "fred" | "twelve-data";
	readonly apiKey: string;
	readonly query: {
		readonly symbol: string;
		readonly since: string | null;
		readonly maxObservations: number;
	};
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly output: unknown;
}

const FRED_KEY = "fred-synthetic-key-001";
const TWELVE_KEY = "twelve-synthetic-key-002";

const VIX_META = fixture("fred-series-VIXCLS.json");
const VIX_OBS = fixture("fred-observations-VIXCLS.json");

function fredMeta(overrides: { [key: string]: unknown } = {}): string {
	return JSON.stringify({
		seriess: [
			{
				id: "X",
				title: "T",
				units: "Percent",
				frequency: "Monthly",
				frequency_short: "M",
				seasonal_adjustment: "Not Seasonally Adjusted",
				seasonal_adjustment_short: "NSA",
				...overrides,
			},
		],
	});
}

function randomFredMeta(rng: Rng): string {
	return fredMeta({
		id: mostly(rng, ["X", "VIXCLS", "CPIAUCSL"], ["A B", "é", "A/B", ""]),
		title: mostly(
			rng,
			["T", "  Padded  ", "Consumer Price Index"],
			["", " ", "\ufeffBOM\ufeff", "x".repeat(200), "x".repeat(201), "経".repeat(200)],
		),
		units: mostly(
			rng,
			["Percent", " Index ", "Billions of Dollars"],
			["", " ", "x".repeat(80), "x".repeat(81), "\u00a0"],
		),
		frequency_short: mostly(rng, ["D", "W", "BW", "M", "Q", "A"], ["SA", "d", "", "Monthly"], 0.3),
		seasonal_adjustment_short: mostly(rng, ["NSA", "SA", "SAAR"], ["sa", "", "SA "], 0.2),
	});
}

function randomFredObservations(rng: Rng): string {
	const count = rng.int(0, 12);
	const rows = Array.from({ length: count }, () => ({
		date: mostly(rng, VALID_DATES, HOSTILE_DATES, 0.2),
		value: mostly(rng, NORMAL_NUMBERS, HOSTILE_NUMBERS, 0.25),
	}));
	return JSON.stringify({ observations: rows });
}

async function runSeries(
	provider: "fred" | "twelve-data",
	query: SeriesCase["query"],
	script: readonly ScriptEntry[],
): Promise<SeriesCase> {
	const events: FetchEvent[] = [];
	const fetcher = scriptedFetcher(script, events);
	const apiKey = provider === "fred" ? FRED_KEY : TWELVE_KEY;
	const source =
		provider === "fred"
			? createFredSeriesSource({ apiKey, fetcher, clock: tickingClock(0) })
			: createTwelveDataSeriesSource({ apiKey, fetcher });
	const result = await source.fetchSeries({ ...query, signal: NEVER });
	const output = result.ok ? { ok: result.value } : { err: result.error };
	return { provider, apiKey, query, script, events: plain(events), output: plain(output) };
}

async function fredCases(): Promise<SeriesCase[]> {
	const rng = new Rng(0xf4ed);
	const cases: SeriesCase[] = [];
	const base = { symbol: "VIXCLS", since: null, maxObservations: 800 };
	const scripts: { query: SeriesCase["query"]; script: ScriptEntry[] }[] = [
		{ query: base, script: [{ text: VIX_META }, { text: VIX_OBS }] },
		{
			query: base,
			script: [
				{ text: VIX_META },
				{ text: fixture("fred-observations-synthetic-dot-values.json") },
			],
		},
		{
			query: { symbol: "CPIAUCSL", since: "2026-09-01", maxObservations: 3 },
			script: [{ text: VIX_META }, { text: fixture("fred-observations-CPIAUCSL.json") }],
		},
		{
			query: { ...base, since: "2026-10-01", maxObservations: 5 },
			script: [{ text: VIX_META }, { text: VIX_OBS }],
		},
		{
			query: base,
			script: [fetchError("HTTP_ERROR", "HTTP 400", fixture("fred-series-badkey.json"))],
		},
		{
			query: base,
			script: [fetchError("HTTP_ERROR", "HTTP 400", fixture("fred-series-notfound.json"))],
		},
		{ query: base, script: [{ text: fixture("fred-series-badkey.json") }] },
		{ query: base, script: [{ text: fixture("fred-series-notfound.json") }] },
		{ query: base, script: [fetchError("HTTP_ERROR", "HTTP 429")] },
		{ query: base, script: [{ text: "{oops" }] },
		{ query: base, script: [{ text: '{"seriess":[]}' }] },
		{ query: base, script: [{ text: VIX_META }, fetchError("HTTP_ERROR", "HTTP 500")] },
		{
			query: base,
			script: [{ text: VIX_META }, { text: fixture("fred-series-badkey.json") }],
		},
		{
			query: { symbol: "X", since: null, maxObservations: 800 },
			script: [{ text: fredMeta({ units: "" }) }],
		},
		{
			query: { symbol: "X", since: null, maxObservations: 0 },
			script: [{ text: fredMeta() }, { text: randomFredObservations(rng) }],
		},
	];
	for (const entry of scripts) cases.push(await runSeries("fred", entry.query, entry.script));
	for (let index = 0; index < 700; index += 1) {
		const since = rng.pick<string | null>([
			null,
			null,
			"2026-10-01",
			"2026-02-28",
			"0100-01-01",
			"bad",
			"2024-03-01",
			"9999-12-31",
		]);
		const query = {
			symbol: rng.pick(["VIXCLS", "X", "A B", "é&=", "A/B", "", "a+b"]),
			since,
			maxObservations: rng.pick([1, 2, 3, 5, 800, 800, 0]),
		};
		const meta = rng.chance(0.2) ? VIX_META : randomFredMeta(rng);
		const metaEntry: ScriptEntry = rng.chance(0.06)
			? randomFailure(rng)
			: { text: rng.chance(0.1) ? mutateText(rng, meta) : meta };
		const observationEntry: ScriptEntry = rng.chance(0.06)
			? randomFailure(rng)
			: {
					text: rng.chance(0.15) ? mutateText(rng, VIX_OBS) : randomFredObservations(rng),
				};
		cases.push(await runSeries("fred", query, [metaEntry, observationEntry]));
	}
	return cases;
}

/* ---------- Twelve Data ---------- */

function twelveBody(rng: Rng): string {
	const count = rng.int(0, 10);
	const symbol = mostly(
		rng,
		["AAPL", "EUR/USD", "XAU/USD", "XAG/USD", "USD/JPY", "7203", "BRK/B"],
		["A/", "/B", "", "AAPL "],
		0.15,
	);
	const currency = mostly<string | undefined>(
		rng,
		["USD", "JPY", "USD", undefined],
		["", " ", " usd "],
		0.2,
	);
	const exchange = mostly<string | undefined>(
		rng,
		[undefined, "NASDAQ", "NYSE", "JPX"],
		["", " ", " JPX ", "X".repeat(150)],
		0.2,
	);
	const meta: { [key: string]: unknown } = { symbol };
	if (currency !== undefined) meta.currency = currency;
	if (exchange !== undefined) meta.exchange = exchange;
	const values = Array.from({ length: count }, () => ({
		datetime: mostly(rng, VALID_DATES, HOSTILE_DATES, 0.2),
		close: mostly(rng, NORMAL_NUMBERS, HOSTILE_NUMBERS, 0.25),
	}));
	return JSON.stringify({ meta, values, status: "ok" });
}

async function twelveCases(): Promise<SeriesCase[]> {
	const rng = new Rng(0x7e1fe);
	const cases: SeriesCase[] = [];
	const fixtures = [
		"twelvedata-timeseries-AAPL.json",
		"twelvedata-timeseries-EURUSD.json",
		"twelvedata-key-symbol_MSFT.json",
		"twelvedata-key-symbol_XAU_USD.json",
		"twelvedata-key-symbol_USD_JPY.json",
		"twelvedata-key-symbol_7203_exchange_JPX.json",
		"twelvedata-error-badkey.json",
		"twelvedata-error-demo-restricted.json",
		"twelvedata-synthetic-empty-values.json",
		"twelvedata-synthetic-error-429.json",
		"twelvedata-synthetic-malformed.json",
	];
	const symbols = ["AAPL", "EUR/USD", "MSFT", "XAU/USD", "USD/JPY", "7203:JPX"];
	for (const name of fixtures) {
		for (const symbol of symbols) {
			cases.push(
				await runSeries("twelve-data", { symbol, since: null, maxObservations: 800 }, [
					{ text: fixture(name) },
				]),
			);
		}
		cases.push(
			await runSeries("twelve-data", { symbol: "AAPL", since: "2026-10-01", maxObservations: 3 }, [
				{ text: fixture(name) },
			]),
		);
	}
	for (const detail of [
		"HTTP 401",
		"HTTP 403",
		"HTTP 404",
		"HTTP 429",
		"HTTP 400",
		"HTTP 500",
		"no status",
	]) {
		cases.push(
			await runSeries("twelve-data", { symbol: "AAPL", since: null, maxObservations: 800 }, [
				fetchError("HTTP_ERROR", detail),
			]),
		);
	}
	for (let index = 0; index < 700; index += 1) {
		const query = {
			symbol: rng.pick([
				"AAPL",
				"7203:JPX",
				"A:B:C",
				":X",
				"X:",
				"EUR/USD",
				"A B",
				"é",
				"A&B=C",
				"",
				"XAU/USD:Y",
			]),
			since: rng.pick<string | null>([null, null, "2026-10-01", "0100-01-01", "bad", "2026-02-29"]),
			maxObservations: rng.pick([1, 2, 5, 800, 0]),
		};
		let entry: ScriptEntry;
		const roll = rng.float();
		if (roll < 0.05) entry = randomFailure(rng);
		else if (roll < 0.1) {
			entry = {
				text: JSON.stringify({
					code: rng.pick([400, 401, 403, 404, 429, 500, 401.0, "401", 0, -1, Number("1e999")]),
					message: rng.pick(["m", "", 5]),
					status: rng.pick(["error", "ok", "ERROR"]),
				}),
			};
		} else if (roll < 0.15) {
			const name = rng.pick(fixtures);
			entry = { text: mutateText(rng, fixture(name)) };
		} else entry = { text: twelveBody(rng) };
		cases.push(await runSeries("twelve-data", query, [entry]));
	}
	return cases;
}

/* ---------- Finnhub ---------- */

interface EarningsCase {
	readonly apiKey: string;
	readonly query: {
		readonly stocks: readonly { readonly symbol: string; readonly needName: boolean }[];
		readonly fromDate: string;
		readonly toDate: string;
	};
	readonly before: readonly boolean[];
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly output: unknown;
}

const FINNHUB_KEY = "finnhub-synthetic-key-001";

async function runFinnhub(
	query: EarningsCase["query"],
	before: readonly boolean[],
	script: readonly ScriptEntry[],
): Promise<EarningsCase> {
	const events: FetchEvent[] = [];
	const source = createFinnhubEarningsSource({
		apiKey: FINNHUB_KEY,
		fetcher: scriptedFetcher(script, events),
	});
	const results = await source.fetchEarnings({
		...query,
		signal: NEVER,
		beforeRequest: scriptedBefore(before, events),
	});
	const output = results.map((result) =>
		result.ok ? { ok: result.value } : { err: result.error },
	);
	return {
		apiKey: FINNHUB_KEY,
		query,
		before,
		script,
		events: plain(events),
		output: plain(output),
	};
}

const FROM = "2026-10-13";
const TO = "2027-04-16";

function finnhubRow(rng: Rng, symbol: string): { [key: string]: unknown } {
	const row: { [key: string]: unknown } = {
		date: mostly(
			rng,
			["2026-10-29", "2026-10-13", "2027-04-16", "2026-11-02", "2026-12-01", "2026-12-01"],
			["2026-10-12", "2027-04-17", "2026-02-30", "bad"],
			0.15,
		),
		epsActual: null,
		epsEstimate: 1.9,
		hour: mostly<unknown>(rng, ["amc", "bmo", "dmh", "amc"], ["", "xyz", null, undefined, 5], 0.25),
		quarter: mostly<unknown>(rng, [1, 2, 3, 4, 3.0], [0, 5, 2.5, null, undefined, "2", -1], 0.15),
		revenueActual: null,
		symbol: mostly<unknown>(rng, [symbol], ["OTHER", null, undefined, 7], 0.15),
		year: mostly<unknown>(
			rng,
			[2026, 2027, 2026.0, 2025],
			[2026.5, 0, -1, Number("99999999999999999999"), null, undefined, "2026"],
			0.15,
		),
	};
	for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
	return row;
}

async function finnhubCases(): Promise<EarningsCase[]> {
	const rng = new Rng(0xf1117);
	const cases: EarningsCase[] = [];
	const query = (stocks: { symbol: string; needName: boolean }[]) => ({
		stocks,
		fromDate: FROM,
		toDate: TO,
	});
	const calendar = (rows: unknown): ScriptEntry => ({
		text: JSON.stringify({ earningsCalendar: rows }),
	});
	const profile = (value: unknown): ScriptEntry => ({ text: JSON.stringify(value) });
	const aapl = { symbol: "AAPL", needName: true };
	const aaplNoName = { symbol: "AAPL", needName: false };
	cases.push(
		await runFinnhub(
			query([aapl]),
			[],
			[profile({ name: "Apple Inc", ticker: "AAPL" }), calendar([finnhubRow(new Rng(1), "AAPL")])],
		),
	);
	cases.push(await runFinnhub(query([aaplNoName]), [], [calendar([])]));
	cases.push(
		await runFinnhub(
			query([aapl]),
			[],
			[profile({ name: "Apple Inc", ticker: "AAPL" }), calendar([])],
		),
	);
	cases.push(await runFinnhub(query([aapl]), [], [profile({ name: "x" })]));
	cases.push(await runFinnhub(query([aapl]), [], [profile({}), calendar([])]));
	cases.push(await runFinnhub(query([aapl]), [], [profile([])]));
	cases.push(
		await runFinnhub(
			query([aapl]),
			[],
			[profile({ name: "N".repeat(201), ticker: "AAPL" }), calendar([])],
		),
	);
	cases.push(
		await runFinnhub(
			query([aapl]),
			[],
			[profile({ name: `  ${"N".repeat(200)}  `, ticker: "AAPL" }), calendar([])],
		),
	);
	cases.push(
		await runFinnhub(
			query([aapl]),
			[],
			[profile({ name: "経".repeat(200), ticker: "AAPL" }), calendar([])],
		),
	);
	cases.push(
		await runFinnhub(
			query([aapl, aaplNoName]),
			[true, false],
			[profile({ name: "A", ticker: "AAPL" }), calendar([])],
		),
	);
	cases.push(await runFinnhub(query([aapl]), [false], []));
	cases.push(
		await runFinnhub(query([aapl]), [true, false], [profile({ name: "A", ticker: "AAPL" })]),
	);
	for (const detail of ["HTTP 401", "HTTP 403", "HTTP 429", "HTTP 500", "HTTP 404", "x"]) {
		cases.push(await runFinnhub(query([aapl]), [], [fetchError("HTTP_ERROR", detail)]));
		cases.push(
			await runFinnhub(query([aaplNoName]), [], [fetchError("HTTP_ERROR", detail, "secret body")]),
		);
	}
	for (let index = 0; index < 600; index += 1) {
		const stockCount = rng.int(1, 4);
		const stocks = Array.from({ length: stockCount }, () => ({
			symbol: rng.pick(["AAPL", "MSFT", "A B", "BRK.B", "é"]),
			needName: rng.chance(0.5),
		}));
		const before = Array.from({ length: rng.int(0, 3) }, () => rng.chance(0.95));
		const script: ScriptEntry[] = [];
		for (const stock of stocks) {
			if (stock.needName) {
				const roll = rng.float();
				if (roll < 0.04) script.push(randomFailure(rng));
				else if (roll < 0.08) script.push(profile(randomValue(rng)));
				else {
					script.push(
						profile({
							name: rng.pick<unknown>(["Apple Inc", "  ", "", " Pad ", "N".repeat(201), 5, null]),
							ticker: rng.pick<unknown>([stock.symbol, stock.symbol, undefined, null, 5]),
						}),
					);
				}
			}
			const roll = rng.float();
			if (roll < 0.04) script.push(randomFailure(rng));
			else if (roll < 0.07) script.push(calendar(randomValue(rng)));
			else if (roll < 0.1) script.push({ text: JSON.stringify(randomValue(rng)) });
			else {
				const rows = Array.from({ length: rng.int(0, 12) }, () => finnhubRow(rng, stock.symbol));
				script.push(calendar(rows));
			}
		}
		cases.push(await runFinnhub(query(stocks), before, script));
	}
	return cases;
}

export async function marketFiles(): Promise<{ path: string; content: unknown }[]> {
	const fred = await fredCases();
	const twelve = await twelveCases();
	const finnhub = await finnhubCases();
	return [
		{ path: "finance/js_number.json", content: jsNumberCases() },
		{
			path: "finance/market_fetch.json",
			content: { helpers: dateHelperCases(), documents: await jsonDocumentCases() },
		},
		{ path: "finance/fred.json", content: fred },
		{ path: "finance/twelve_data.json", content: twelve },
		{ path: "finance/finnhub.json", content: finnhub },
	];
}
