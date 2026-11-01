/**
 * Daily prices of every directory stock (ADR-0058 §2; crate
 * `research-finance`): `packages/adapters/src/finance/stockPrices.ts`,
 * `massive.ts` and `jquants.ts` run over corpora the Rust port replays
 * (`crates/research-finance/tests/stock_prices_vectors.rs`):
 *
 * - `mapping`: Massive tickers ↔ directory symbols, J-Quants codes ↔ symbols;
 * - `dates`: the New York and Tokyo dates of instants around every US
 *   daylight-time change of 2020–2032 and at random;
 * - `outcomes`: the day-outcome rules by age and delay;
 * - `parse`: the provider bodies (fixtures and mutations) through the parsers;
 * - `problems`: fetch failures through each provider's status mapping;
 * - `jobs`: whole `stock-prices-sync` claims over the scripted fetcher, every
 *   request and pacing admission recorded with the outcome, so the Rust job
 *   must make the same calls in the same order.
 */
import { readFileSync } from "node:fs";
import type { MarketRequestAdmission, SafeFetchError } from "@research/application";
import {
	createJquantsStockPriceSource,
	jquantsDayAnswer,
	jquantsHistoryBars,
	jquantsProblem,
	parseJquantsPage,
} from "../../../packages/adapters/src/finance/jquants.ts";
import {
	createMassiveStockPriceSource,
	massiveProblem,
	parseMassiveDay,
	parseMassiveHistory,
	parseMassiveSplits,
} from "../../../packages/adapters/src/finance/massive.ts";
import {
	delayedDayOutcome,
	emptyDayOutcome,
	jquantsCodeToSymbol,
	massiveTickerToSymbol,
	newYorkDate,
	planRefusalOutcome,
	type StockPricesJob,
	symbolToJquantsCode,
	symbolToMassiveTicker,
	syncStockPrices,
	tokyoDate,
} from "../../../packages/adapters/src/finance/stockPrices.ts";
import {
	type FetchEvent,
	fetchError,
	plain,
	Rng,
	type ScriptEntry,
	scriptedAdmission,
	scriptedFetcher,
} from "./support.ts";

const MASSIVE_KEY = "massive-vector-key";
const JQUANTS_KEY = "jquants-vector-key";
const NEVER = new AbortController().signal;

function fixture(name: string): string {
	return readFileSync(
		new URL(`../../../examples/fixtures/stock-prices/${name}`, import.meta.url),
		"utf8",
	);
}

/* ---------- Mapping ---------- */

const TICKERS: readonly string[] = [
	"AAPL",
	"BRKHU",
	"BRK.B",
	"BRK.A",
	"MKC.V",
	"KIMpL",
	"DCOMp",
	"ABRpD",
	"AAC.WS",
	"NE.WS.A",
	"AAC.U",
	"AIIAr",
	"MSGKw",
	"",
	"brk.b",
	"BRK.BB",
	"AB-C",
	"X.WS.AB",
	"ABpDE",
	"A B",
	"ÄBC",
	"ABCDEFGHIJKLMNOP",
	"ABCDEFGHIJKLMNOPQ",
	"ABCDEFGHIJKLMpQ",
	"ABCDEFGHIJKLMNO.WS",
	"A.WS.",
	".WS",
	"p",
	"Ap",
	"ApA",
	"A.U.WS",
	"A.Ur",
	"Aw",
	"Ar",
	"A1.B",
	"1380",
	"A\nB",
];

const SYMBOLS: readonly string[] = [
	"AAPL",
	"BRK-B",
	"KIM-PL",
	"DCOM-P",
	"AAC-WT",
	"NE-WTA",
	"AAC-UN",
	"AIIA-RI",
	"MSGK-WI",
	"MKC-V",
	"BRK-ABCD",
	"BRK-",
	"-A",
	"BRK.B",
	"BRK-pA",
	"A-WTAB",
	"A-PAB",
	"A-U",
	"A-RT",
	"1380",
	"",
];

const CODES: readonly string[] = [
	"13800",
	"130A0",
	"86970",
	"25935",
	"1380",
	"138000",
	"A3800",
	"130a0",
	"00000",
	"9ZZZ0",
	"",
	"13800 ",
];

function randomText(rng: Rng, alphabet: string, max: number): string {
	const length = rng.int(0, max);
	let text = "";
	for (let index = 0; index < length; index += 1) text += rng.pick([...alphabet]);
	return text;
}

function mappingCases() {
	const rng = new Rng(0x5701);
	const tickers = [...TICKERS];
	for (let index = 0; index < 400; index += 1) {
		tickers.push(randomText(rng, "ABCZ09.-pwrWSU ", 9));
	}
	const symbols = [...SYMBOLS];
	for (let index = 0; index < 400; index += 1) symbols.push(randomText(rng, "ABCZ09-.PWTUNRI", 9));
	const codes = [...CODES];
	for (let index = 0; index < 200; index += 1) codes.push(randomText(rng, "0189AZa", 6));
	return {
		tickers: tickers.map((ticker) => ({ ticker, symbol: massiveTickerToSymbol(ticker) })),
		symbols: symbols.map((symbol) => ({
			symbol,
			ticker: symbolToMassiveTicker(symbol),
			code: symbolToJquantsCode(symbol),
		})),
		codes: codes.map((code) => ({ code, symbol: jquantsCodeToSymbol(code) })),
	};
}

/* ---------- Dates ---------- */

function dateCases() {
	const rng = new Rng(0x5702);
	const instants: number[] = [0, -1, 86_399_999, Date.parse("2026-11-02T00:00:00Z")];
	for (let year = 2020; year <= 2032; year += 1) {
		for (const day of [7, 8, 9, 10, 11, 12, 13, 14]) {
			for (const hour of [5, 6, 7]) {
				const at = Date.UTC(year, 2, day, hour);
				instants.push(at - 1, at, at + 3_600_000);
			}
		}
		for (const day of [1, 2, 3, 4, 5, 6, 7]) {
			for (const hour of [4, 5, 6]) {
				const at = Date.UTC(year, 10, day, hour);
				instants.push(at - 1, at, at + 3_600_000);
			}
		}
		instants.push(Date.UTC(year, 0, 1, 4, 59, 59, 999), Date.UTC(year, 0, 1, 5));
	}
	for (let index = 0; index < 400; index += 1) {
		instants.push(
			rng.int(Date.UTC(2000, 0, 1) / 1000, Date.UTC(2040, 0, 1) / 1000) * 1000 + rng.int(0, 999),
		);
	}
	return instants.map((ms) => ({ ms, newYork: newYorkDate(ms), tokyo: tokyoDate(ms) }));
}

/* ---------- Outcomes ---------- */

function outcomeCases() {
	const cases = [];
	for (const delay of [0, 1, 84, 365]) {
		for (let age = -3; age <= delay + 400; age += age < delay + 10 ? 1 : 7) {
			cases.push({
				age,
				delay,
				delayed: delayedDayOutcome(age, delay),
				empty: emptyDayOutcome(age, delay),
				refusal: planRefusalOutcome(age, delay),
			});
		}
		for (const age of [delay + 3, delay + 4, delay + 365, delay + 366]) {
			cases.push({
				age,
				delay,
				delayed: delayedDayOutcome(age, delay),
				empty: emptyDayOutcome(age, delay),
				refusal: planRefusalOutcome(age, delay),
			});
		}
	}
	return cases;
}

/* ---------- Parsers ---------- */

const MASSIVE_ROWS: readonly unknown[] = [
	{ T: "BRK.B", o: 410, h: 415.25, l: 409.5, c: 412.5, v: 3120455, t: 1 },
	{ T: "AAPL", o: 1, h: 2, l: 0.5, c: 1.5, v: null },
	{ T: "AAPL", o: 1, h: 2, l: 0.5, c: 1.7, v: 3 },
	{ T: "X", o: 1, h: 2, l: 0.5, c: 3, v: 1 },
	{ T: "X", o: "1", h: 2, l: 0.5, c: 1, v: 1 },
	{ T: "Y", o: 1, h: 2, l: 0.5, c: 1, v: 1, t: "1" },
	{ T: "Z", o: 1, h: 2, l: 0.5, c: 1, v: 1, otc: "yes" },
	{ T: "Z", o: 1, h: 2, l: 0.5, c: 1, v: 1, otc: false },
	{ T: null, o: 1, h: 2, l: 0.5, c: 1, v: 1 },
	{ T: "KIMpL", o: -1, h: 0, l: -2, c: -0.5, v: -0 },
	{ T: "NEGV", o: 5, h: 6, l: 4, c: 5, v: -1 },
	[1, 2],
	null,
	"row",
	{ T: "HUGE", o: 1e308, h: 1e308, l: 1e308, c: 1e308, v: 1e308 },
	{ T: "BF.B", o: 1, h: 1, l: 1, c: 1 },
	{ T: "LATE", o: 1, h: 1, l: 1, c: 1, v: 1, t: 253_402_300_799_999 },
	{ T: "LATER", o: 1, h: 1, l: 1, c: 1, v: 1, t: 253_402_300_800_000 },
	{ T: "EARLY", o: 1, h: 1, l: 1, c: 1, v: 1, t: -1 },
];

function massiveDayTexts(rng: Rng): string[] {
	const texts = [
		fixture("massive-grouped-2026-10-30.synthetic.json"),
		fixture("massive-grouped-empty.synthetic.json"),
		"[]",
		"null",
		'{"results":null}',
		'{"results":{}}',
		'{"results":[],"next_url":5}',
		'{"results":[],"next_url":null}',
		'{"results":[{"T":"A","o":1,"h":1,"l":1,"c":1e400,"v":1,"t":1e400}]}',
		'{"results":[{"T":"A","o":1,"h":1,"l":1,"c":1,"v":1},{"T":"A","o":1,"h":1,"l":1,"c":1,"v":2}]}',
	];
	for (let index = 0; index < 60; index += 1) {
		const rows = rng.picks(MASSIVE_ROWS, rng.int(0, 8));
		texts.push(
			JSON.stringify(rng.chance(0.1) ? { results: rows, next_url: "x" } : { results: rows }),
		);
	}
	return texts;
}

const SPLIT_ROWS: readonly unknown[] = [
	{ ticker: "NVDA" },
	{ ticker: "ABRpD" },
	{ ticker: "odd/ticker" },
	{ ticker: null },
	{ ticker: 5 },
	{},
	"x",
];

const JQUANTS_ROWS: readonly unknown[] = [
	{
		Date: "2026-08-07",
		Code: "13800",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.5,
		AdjVo: 10,
		AdjFactor: 1,
	},
	{
		Date: "2026-08-07",
		Code: "13800",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.6,
		AdjVo: 10,
		AdjFactor: 1,
	},
	{
		Date: "2026-08-07",
		Code: "72030",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.5,
		AdjVo: 10,
		AdjFactor: 0.5,
	},
	{
		Date: "2026-08-07",
		Code: "25935",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.5,
		AdjVo: 10,
		AdjFactor: 1,
	},
	{
		Date: "2026-08-07",
		Code: "130A0",
		AdjO: null,
		AdjH: null,
		AdjL: null,
		AdjC: null,
		AdjVo: null,
		AdjFactor: 1,
	},
	{
		Date: "2026-08-06",
		Code: "99990",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.5,
		AdjVo: 10,
		AdjFactor: 1,
	},
	{
		Date: "2026-02-30",
		Code: "99990",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.5,
		AdjVo: 10,
		AdjFactor: 1,
	},
	{
		Date: "2026-08-07",
		Code: 13800,
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 1.5,
		AdjVo: 10,
		AdjFactor: 1,
	},
	{
		Date: "2026-08-07",
		Code: "13800",
		AdjO: 1,
		AdjH: 2,
		AdjL: 0.5,
		AdjC: 3,
		AdjVo: -1,
		AdjFactor: "0.5",
	},
	{ Date: "2026-08-07", Code: "86970", AdjO: 1, AdjH: 2, AdjL: 0.5, AdjC: 1, AdjFactor: 1 },
	{ Code: "86970", AdjO: 1, AdjH: 2, AdjL: 0.5, AdjC: 1, AdjVo: 1, AdjFactor: 1 },
	null,
];

function jquantsTexts(rng: Rng): string[] {
	const texts = [
		fixture("jquants-daily-2026-08-07-page1.synthetic.json"),
		fixture("jquants-daily-2026-08-07-page2.synthetic.json"),
		fixture("jquants-history-13800.synthetic.json"),
		fixture("jquants-empty.synthetic.json"),
		"{}",
		"[]",
		'{"data":null}',
		'{"data":[],"pagination_key":""}',
		'{"data":[],"pagination_key":null}',
		'{"data":[],"pagination_key":7}',
	];
	for (let index = 0; index < 60; index += 1) {
		const rows = rng.picks(JQUANTS_ROWS, rng.int(0, 8));
		texts.push(
			JSON.stringify(rng.chance(0.2) ? { data: rows, pagination_key: "k.1." } : { data: rows }),
		);
	}
	return texts;
}

function parseCases() {
	const rng = new Rng(0x5703);
	const massive = massiveDayTexts(rng).map((text) => {
		const json: unknown = JSON.parse(text);
		return {
			text,
			day: parseMassiveDay(json),
			history: parseMassiveHistory(json),
			splits: parseMassiveSplits(json),
		};
	});
	const splitTexts = [fixture("massive-splits.synthetic.json")];
	for (let index = 0; index < 20; index += 1) {
		splitTexts.push(JSON.stringify({ results: rng.picks(SPLIT_ROWS, rng.int(0, 5)) }));
	}
	const splits = splitTexts.map((text) => ({ text, splits: parseMassiveSplits(JSON.parse(text)) }));
	const jquants = jquantsTexts(rng).map((text) => {
		const page = parseJquantsPage(JSON.parse(text));
		return {
			text,
			page: page === null ? null : { next: page.next, records: page.records.length },
			day: page === null ? null : jquantsDayAnswer(page.records, "2026-08-07"),
			history: page === null ? null : jquantsHistoryBars(page.records, "1380"),
		};
	});
	return plain({ massive, splits, jquants });
}

/* ---------- Status mapping ---------- */

function problemCases() {
	const errors: SafeFetchError[] = [
		{ code: "TIMEOUT", detail: "timed out" },
		{ code: "NETWORK_ERROR", detail: "response is not valid JSON" },
		{ code: "REDIRECT_NOT_AUTHORIZED", detail: "x", status: 307 },
		{ code: "HOST_NOT_ALLOWED", detail: "host is not on the allowlist" },
	];
	for (const status of [400, 401, 403, 404, 429, 500, 503, 520]) {
		errors.push({ code: "HTTP_ERROR", detail: `HTTP ${status}`, status });
	}
	for (const body of [
		fixture("jquants-error-403-key.synthetic.json"),
		fixture("jquants-error-403-plan.synthetic.json"),
		'{"message":"The incoming API KEY is invalid"}',
		'{"message":"api  key"}',
		'{"message":5}',
		'{"message":"x"}',
		"not json",
		"",
		'["api key"]',
	]) {
		errors.push({ code: "HTTP_ERROR", detail: "HTTP 403", status: 403, body });
	}
	return errors.map((error) => ({
		error,
		massive: massiveProblem(error),
		jquants: jquantsProblem(error),
	}));
}

/* ---------- Whole jobs ---------- */

interface JobScenario {
	readonly name: string;
	readonly nowMs: number;
	readonly delayDays?: number;
	readonly job: StockPricesJob;
	readonly script: readonly ScriptEntry[];
	readonly admissions?: readonly MarketRequestAdmission[];
}

const LEASE = {
	runId: "run_prices",
	leaseGeneration: 2,
	leaseExpiresAt: "2026-10-31T16:00:00.000Z",
	attempt: 1,
	heartbeatIntervalMs: 20_000,
	sources: [],
};

function usJob(fields: Partial<StockPricesJob>): StockPricesJob {
	return {
		kind: "stock-prices-sync",
		...LEASE,
		market: "US",
		days: [],
		histories: [],
		adjustmentsSince: null,
		windowStart: "2024-11-01",
		...fields,
	};
}

function jpJob(fields: Partial<StockPricesJob>): StockPricesJob {
	return usJob({ market: "JP", windowStart: "2024-08-05", ...fields });
}

const US_NOW = Date.parse("2026-10-31T15:00:00Z");
const JP_NOW = Date.parse("2026-11-01T03:00:00Z");
const GROUPED = fixture("massive-grouped-2026-10-30.synthetic.json");
const EMPTY_GROUPED = fixture("massive-grouped-empty.synthetic.json");
const RANGE_1 = fixture("massive-range-BRK.B-page1.synthetic.json");
const RANGE_2 = fixture("massive-range-BRK.B-page2.synthetic.json");
const SPLITS = fixture("massive-splits.synthetic.json");
const JQ_1 = fixture("jquants-daily-2026-08-07-page1.synthetic.json");
const JQ_2 = fixture("jquants-daily-2026-08-07-page2.synthetic.json");
const JQ_HISTORY = fixture("jquants-history-13800.synthetic.json");
const JQ_EMPTY = fixture("jquants-empty.synthetic.json");

function scenarios(): JobScenario[] {
	const three = ["2026-10-30", "2026-10-29", "2026-10-28"];
	return [
		{
			name: "us days: stored, empty recent, empty old",
			nowMs: US_NOW,
			job: usJob({ days: ["2026-10-30", "2026-10-29", "2026-10-20"] }),
			script: [{ text: GROUPED }, { text: EMPTY_GROUPED }, { text: EMPTY_GROUPED }],
		},
		{
			name: "us history over two pages",
			nowMs: US_NOW,
			job: usJob({ histories: [{ symbol: "BRK-B", from: "2026-10-27", to: "2026-10-30" }] }),
			script: [{ text: RANGE_1 }, { text: RANGE_2 }],
		},
		{
			name: "us history unknown, then unmappable",
			nowMs: US_NOW,
			job: usJob({
				histories: [
					{ symbol: "ZZZZ", from: "2024-11-01", to: "2026-10-30" },
					{ symbol: "BRK-ABCD", from: "2024-11-01", to: "2026-10-30" },
				],
			}),
			script: [fetchError("HTTP_ERROR", "HTTP 404")],
		},
		{
			name: "us splits after the stored day refetch within the cap",
			nowMs: US_NOW,
			job: usJob({
				days: ["2026-10-30"],
				adjustmentsSince: "2026-10-27",
				histories: [{ symbol: "AAPL", from: "2024-11-01", to: "2026-10-30" }],
			}),
			script: [
				{ text: GROUPED },
				{ text: RANGE_2 },
				{ text: SPLITS },
				{ text: RANGE_2 },
				{ text: RANGE_2 },
			],
		},
		{
			name: "us splits not asked when no day after the anchor was stored",
			nowMs: US_NOW,
			job: usJob({ days: ["2026-10-29"], adjustmentsSince: "2026-10-29" }),
			script: [{ text: GROUPED }],
		},
		{
			name: "us plan refusals by age",
			nowMs: US_NOW,
			job: usJob({ days: ["2026-10-30", "2024-10-01"] }),
			script: [fetchError("HTTP_ERROR", "HTTP 403"), fetchError("HTTP_ERROR", "HTTP 403")],
		},
		{
			name: "us plan refusal in the middle fails the job",
			nowMs: US_NOW,
			job: usJob({ days: ["2026-06-01", "2026-05-29"] }),
			script: [fetchError("HTTP_ERROR", "HTTP 403")],
		},
		{
			name: "us rejected key",
			nowMs: US_NOW,
			job: usJob({ days: three }),
			script: [{ text: GROUPED }, fetchError("HTTP_ERROR", "HTTP 401")],
		},
		{
			name: "us rate limit after a stored day",
			nowMs: US_NOW,
			job: usJob({
				days: three,
				histories: [{ symbol: "AAPL", from: "2024-11-01", to: "2026-10-30" }],
			}),
			script: [{ text: GROUPED }, fetchError("HTTP_ERROR", "HTTP 429")],
		},
		{
			name: "us rate limit first",
			nowMs: US_NOW,
			job: usJob({ days: three }),
			script: [fetchError("HTTP_ERROR", "HTTP 429")],
		},
		{
			name: "us source failure first",
			nowMs: US_NOW,
			job: usJob({ days: three }),
			script: [fetchError("TIMEOUT", "timed out")],
		},
		{
			name: "us unreadable answer",
			nowMs: US_NOW,
			job: usJob({ days: three }),
			script: [{ text: "not json" }, { text: GROUPED }],
		},
		{
			name: "us budget spent before any request",
			nowMs: US_NOW,
			job: usJob({ days: three }),
			script: [],
			admissions: ["budget-spent"],
		},
		{
			name: "us stopped while waiting",
			nowMs: US_NOW,
			job: usJob({ days: three }),
			script: [{ text: GROUPED }],
			admissions: ["granted", "stopped"],
		},
		{
			name: "us refused window asked again from inside the plan",
			nowMs: US_NOW,
			job: usJob({ histories: [{ symbol: "BRK-B", from: "2024-10-31", to: "2026-10-30" }] }),
			script: [fetchError("HTTP_ERROR", "HTTP 403"), { text: RANGE_2 }],
		},
		{
			name: "us duplicate days and histories asked once",
			nowMs: US_NOW,
			job: usJob({
				days: ["2026-10-30", "2026-10-30"],
				histories: [
					{ symbol: "BRK-B", from: "2026-10-29", to: "2026-10-30" },
					{ symbol: "BRK-B", from: "2026-10-29", to: "2026-10-30" },
				],
			}),
			script: [{ text: GROUPED }, { text: RANGE_2 }],
		},
		{
			name: "jp days: delayed without a request, two pages, empty",
			nowMs: JP_NOW,
			delayDays: 84,
			job: jpJob({ days: ["2026-10-30", "2026-08-07", "2026-08-03"] }),
			script: [{ text: JQ_1 }, { text: JQ_2 }, { text: JQ_EMPTY }],
		},
		{
			name: "jp adjustment factor refetches the code's window",
			nowMs: JP_NOW,
			delayDays: 84,
			job: jpJob({ days: ["2026-08-07"], adjustmentsSince: "2026-08-06" }),
			script: [{ text: JQ_1 }, { text: JQ_2 }, { text: JQ_HISTORY }],
		},
		{
			name: "jp history clamped to the delay",
			nowMs: JP_NOW,
			delayDays: 84,
			job: jpJob({ histories: [{ symbol: "1380", from: "2026-08-05", to: "2026-10-30" }] }),
			script: [{ text: JQ_HISTORY }],
		},
		{
			name: "jp key rejected by its 403 message",
			nowMs: JP_NOW,
			delayDays: 84,
			job: jpJob({ days: ["2026-08-07"] }),
			script: [
				fetchError("HTTP_ERROR", "HTTP 403", fixture("jquants-error-403-key.synthetic.json")),
			],
		},
		{
			name: "jp plan refusal of a recent day",
			nowMs: JP_NOW,
			delayDays: 84,
			job: jpJob({ days: ["2026-08-07", "2024-06-03"] }),
			script: [
				fetchError("HTTP_ERROR", "HTTP 403", fixture("jquants-error-403-plan.synthetic.json")),
				fetchError("HTTP_ERROR", "HTTP 403", fixture("jquants-error-403-plan.synthetic.json")),
			],
		},
		{
			name: "jp delay zero on a paid plan",
			nowMs: JP_NOW,
			delayDays: 0,
			job: jpJob({ days: ["2026-10-30"] }),
			script: [{ text: JQ_EMPTY }],
		},
		{
			name: "jp page failure fails the day",
			nowMs: JP_NOW,
			delayDays: 84,
			job: jpJob({ days: ["2026-08-07"] }),
			script: [{ text: JQ_1 }, fetchError("HTTP_ERROR", "HTTP 500")],
		},
	];
}

async function runScenario(scenario: JobScenario) {
	const events: FetchEvent[] = [];
	const fetcher = scriptedFetcher(scenario.script, events);
	const source =
		scenario.job.market === "US"
			? createMassiveStockPriceSource({ apiKey: MASSIVE_KEY, fetcher })
			: createJquantsStockPriceSource({
					apiKey: JQUANTS_KEY,
					fetcher,
					delayDays: scenario.delayDays ?? 84,
				});
	const outcome = await syncStockPrices(scenario.job, source, {
		nowMs: scenario.nowMs,
		signal: NEVER,
		beforeRequest: scriptedAdmission(scenario.admissions ?? [], events),
	});
	return plain({
		name: scenario.name,
		nowMs: scenario.nowMs,
		delayDays: scenario.delayDays ?? 84,
		apiKey: scenario.job.market === "US" ? MASSIVE_KEY : JQUANTS_KEY,
		job: scenario.job,
		script: scenario.script,
		admissions: scenario.admissions ?? [],
		events,
		outcome,
	});
}

export async function stockPricesFiles(): Promise<{ path: string; content: unknown }[]> {
	const jobs = [];
	for (const scenario of scenarios()) jobs.push(await runScenario(scenario));
	return [
		{
			path: "finance/stock_prices.json",
			content: {
				mapping: mappingCases(),
				dates: dateCases(),
				outcomes: outcomeCases(),
				parse: parseCases(),
				problems: plain(problemCases()),
				jobs,
			},
		},
	];
}
