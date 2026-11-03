/**
 * Finnhub's whole-market earnings calendar (ADR-0068, crate
 * `research-finance`: `finnhub::fetch_calendar`, `calendar_windows`,
 * `finnhub_calendar_symbol`).
 *
 * `windows` and `symbols` are the pure helpers over a corpus of edges. Walk
 * cases are transcripts like `finnhub.json`'s: the real adapter's
 * `fetchCalendar` runs against a scripted fetcher and a scripted pacing hook,
 * and the case records every hook call and request (URL included) and the
 * result. Hand-written walks cover each rule (a window under the cap, a
 * capped week asked again day by day, a capped single day reported in
 * `truncatedDates`, symbol mapping, skipped rows, duplicate periods, every
 * failure); seeded walks mix them.
 */
import {
	calendarWindows,
	createFinnhubEarningsSource,
	finnhubCalendarSymbol,
} from "../../../packages/adapters/src/finance/finnhubEarnings.ts";
import {
	type FetchEvent,
	fetchError,
	plain,
	Rng,
	type ScriptEntry,
	scriptedBefore,
	scriptedFetcher,
} from "./support.ts";

const NEVER = new AbortController().signal;
const FINNHUB_KEY = "finnhub-synthetic-key-001";
/** `EARNINGS_CALENDAR_LIMITS.finnhubRowCap`. */
const CAP = 1_500;

/* ---------- pure helpers ---------- */

function windowCases(): unknown[] {
	const inputs: [string, string, number][] = [
		["2026-11-03", "2026-11-03", 7],
		["2026-11-03", "2026-11-09", 7],
		["2026-11-03", "2026-11-10", 7],
		["2026-11-03", "2026-11-20", 7],
		["2026-11-03", "2027-05-07", 7],
		["2026-12-29", "2027-01-08", 7],
		["2026-12-31", "2027-01-01", 1],
		["2028-02-25", "2028-03-05", 7],
		["2027-02-25", "2027-03-05", 3],
		["2026-11-03", "2026-11-09", 1],
		["2026-11-03", "2026-11-12", 10],
		["2026-11-03", "2026-11-12", 11],
		["2026-11-04", "2026-11-03", 7],
		["2026-11-03", "2026-11-03", 1],
		["2026-11-03", "2026-11-09", 0],
		["2026-11-03", "2026-11-09", -1],
		["2026-11-03", "2026-11-09", 1.5],
		["2026-11-03", "2026-11-09", Number.NaN],
		["2026-02-30", "2026-03-09", 7],
		["2026-11-03", "2026-13-01", 7],
		["", "", 7],
		["2026-11-3", "2026-11-09", 7],
		["9999-12-25", "9999-12-31", 7],
		["9999-12-30", "9999-12-31", 7],
		["0100-01-01", "0100-01-10", 7],
	];
	return inputs.map(([fromDate, toDate, days]) => ({
		fromDate,
		toDate,
		// NaN has no JSON form: the replay reads null as NaN.
		days: Number.isNaN(days) ? null : days,
		output: plain(calendarWindows(fromDate, toDate, days)),
	}));
}

function symbolCases(): unknown[] {
	const inputs = [
		"AAPL",
		"BH.A",
		"BRK.B",
		" MSFT ",
		"\tTSLA\n",
		"BF-B",
		"aapl",
		"BRK B",
		"",
		"   ",
		".A",
		"-A",
		"A.",
		"A".repeat(16),
		"A".repeat(17),
		"A.B.C",
		"130A",
		"7203",
		"ÄPPL",
		" AAPL ",
		"﻿AAPL",
		"A..B",
		"X:Y",
	];
	return inputs.map((symbol) => ({ symbol, output: finnhubCalendarSymbol(symbol) }));
}

/* ---------- walks ---------- */

interface WalkCase {
	readonly apiKey: string;
	readonly fromDate: string;
	readonly toDate: string;
	readonly before: readonly boolean[];
	readonly script: readonly ScriptEntry[];
	readonly events: unknown;
	readonly output: unknown;
}

async function runWalk(
	fromDate: string,
	toDate: string,
	before: readonly boolean[],
	script: readonly ScriptEntry[],
): Promise<WalkCase> {
	const events: FetchEvent[] = [];
	const source = createFinnhubEarningsSource({
		apiKey: FINNHUB_KEY,
		fetcher: scriptedFetcher(script, events),
	});
	const result = await source.fetchCalendar({
		fromDate,
		toDate,
		signal: NEVER,
		beforeRequest: scriptedBefore(before, events),
	});
	return {
		apiKey: FINNHUB_KEY,
		fromDate,
		toDate,
		before,
		script,
		events: plain(events),
		output: plain(result.ok ? { ok: result.value } : { err: result.error }),
	};
}

type Row = { [key: string]: unknown };

function row(
	symbol: unknown,
	date: string,
	year: unknown,
	quarter: unknown,
	hour: unknown = "amc",
): Row {
	const value: Row = {
		date,
		epsActual: null,
		epsEstimate: 1.2,
		hour,
		quarter,
		revenueActual: null,
		revenueEstimate: 1_000_000,
		symbol,
		year,
	};
	for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
	return value;
}

function answer(rows: readonly unknown[]): ScriptEntry {
	return { text: JSON.stringify({ earningsCalendar: rows }) };
}

/**
 * An answer of `count` rows: `rows` first, then filler rows Finnhub would
 * never send in this form (an empty date, so every runner skips them), to
 * reach the cap without bloating the vector file.
 */
function padded(rows: readonly Row[], count: number): ScriptEntry {
	const filler = Array.from({ length: Math.max(0, count - rows.length) }, () => ({ date: "" }));
	return answer([...rows, ...filler]);
}

const EMPTY = answer([]);

async function handWalks(): Promise<WalkCase[]> {
	const cases: WalkCase[] = [];
	// The main walk: [11-03, 11-20] is three windows; the second is capped and
	// asked again day by day, one of its days still capped.
	const week1 = answer([
		row("AAPL", "2026-11-05", 2026, 3, "bmo"),
		row("BH.A", "2026-11-04", 2026, 3, "amc"),
		row(" MSFT ", "2026-11-03", 2027, 1, "dmh"),
		row("BRK B", "2026-11-05", 2026, 3),
		row("aapl", "2026-11-05", 2026, 3),
		row("AAPL", "2026-11-06", 2026, 3, "amc"),
		row("NVDA", "2026-11-10", 2026, 3),
		row("NVDA", "2026-02-30", 2026, 3),
		row("NVDA", "2026-11-02", 2026, 3),
		row("TSLA", "2026-11-07", 2026, 5),
		row("TSLA", "2026-11-07", 2026.5, 3),
		row("TSLA", "2026-11-07", null, 3),
		row("TSLA", "2026-11-07", 2026, undefined),
		row(null, "2026-11-07", 2026, 3),
		row(undefined, "2026-11-07", 2026, 3),
		row("ORCL", "2026-11-08", 2026, 4, null),
		row("ORCL", "2026-11-09", 2026, 3, "xyz"),
		row("A".repeat(17), "2026-11-08", 2026, 3),
	]);
	const cappedWeek = padded([row("KO", "2026-11-12", 2026, 3)], CAP);
	const days = [
		answer([row("KO", "2026-11-10", 2026, 3, "bmo"), row("AAPL", "2026-11-10", 2026, 3)]),
		padded([row("PEP", "2026-11-11", 2026, 3), row("KO", "2026-11-11", 2026, 4)], CAP),
		answer([row("NVDA", "2026-11-12", 2026, 3, "amc"), row("NVDA", "2026-11-11", 2026, 3)]),
		EMPTY,
		answer([row("WMT", "2026-11-14", 2027, 3)]),
		EMPTY,
		padded([row("DIS", "2026-11-16", 2027, 1)], CAP - 1),
	];
	const week3 = answer([
		row("HD", "2026-11-17", 2026, 3),
		row("HD", "2026-11-20", 2026, 3),
		row("LOW", "2026-11-21", 2026, 3),
	]);
	const main = [week1, cappedWeek, ...days, week3];
	cases.push(await runWalk("2026-11-03", "2026-11-20", [], main));
	// An error on the second request fails the whole walk; nothing more is asked.
	for (const detail of ["HTTP 429", "HTTP 401", "HTTP 403", "HTTP 500", "HTTP 404", "x"]) {
		cases.push(
			await runWalk("2026-11-03", "2026-11-20", [], [week1, fetchError("HTTP_ERROR", detail)]),
		);
	}
	// ... and inside a capped week's day-by-day walk.
	cases.push(
		await runWalk(
			"2026-11-03",
			"2026-11-20",
			[],
			[week1, cappedWeek, days[0] ?? EMPTY, fetchError("HTTP_ERROR", "HTTP 429", "secret")],
		),
	);
	cases.push(
		await runWalk("2026-11-03", "2026-11-20", [], [fetchError("TIMEOUT", "no complete response")]),
	);
	cases.push(await runWalk("2026-11-03", "2026-11-20", [], [fetchError("NETWORK_ERROR", "reset")]));
	// Unparseable or misshapen answers fail the walk without a status.
	cases.push(await runWalk("2026-11-03", "2026-11-09", [], [{ text: "not json" }]));
	cases.push(await runWalk("2026-11-03", "2026-11-09", [], [{ text: '{"earningsCalendar":"x"}' }]));
	cases.push(await runWalk("2026-11-03", "2026-11-09", [], [{ text: "{}" }]));
	cases.push(
		await runWalk("2026-11-03", "2026-11-09", [], [answer([row(7, "2026-11-05", 2026, 3)])]),
	);
	cases.push(
		await runWalk("2026-11-03", "2026-11-09", [], [answer([{ symbol: "AAPL", year: 2026 }])]),
	);
	cases.push(
		await runWalk("2026-11-03", "2026-11-09", [], [answer([row("AAPL", "2026-11-05", "2026", 3)])]),
	);
	// A refused pacing grant stops the walk before its request.
	cases.push(await runWalk("2026-11-03", "2026-11-20", [false], main));
	cases.push(await runWalk("2026-11-03", "2026-11-20", [true, true, false], main));
	cases.push(await runWalk("2026-11-03", "2026-11-20", [true, true, true, true, false], main));
	// The cap's edges: 1,499 rows are kept, 1,500 split the week.
	cases.push(
		await runWalk(
			"2026-11-03",
			"2026-11-09",
			[],
			[padded([row("AAPL", "2026-11-05", 2026, 3)], CAP - 1)],
		),
	);
	cases.push(
		await runWalk(
			"2026-11-03",
			"2026-11-09",
			[],
			[
				padded([row("AAPL", "2026-11-05", 2026, 3)], CAP),
				EMPTY,
				EMPTY,
				answer([row("AAPL", "2026-11-05", 2026, 3)]),
			],
		),
	);
	cases.push(await runWalk("2026-11-03", "2026-11-09", [], [padded([], CAP + 3), ...days]));
	// A single-day window is kept even when capped, its date reported.
	cases.push(
		await runWalk(
			"2026-11-03",
			"2026-11-03",
			[],
			[padded([row("AAPL", "2026-11-03", 2026, 3)], CAP)],
		),
	);
	// A short last window (11-10 alone) is a single day too.
	cases.push(
		await runWalk(
			"2026-11-03",
			"2026-11-10",
			[],
			[week1, padded([row("KO", "2026-11-10", 2026, 3)], CAP)],
		),
	);
	// No window, no request.
	cases.push(await runWalk("2026-11-04", "2026-11-03", [], []));
	cases.push(await runWalk("2026-02-30", "2026-03-03", [], []));
	// Across a year end.
	cases.push(
		await runWalk(
			"2026-12-29",
			"2027-01-08",
			[],
			[
				answer([row("AAPL", "2026-12-31", 2027, 1), row("AAPL", "2027-01-02", 2027, 1)]),
				answer([row("AAPL", "2027-01-05", 2027, 1), row("MSFT", "2027-01-05", 2027, 2)]),
			],
		),
	);
	// The script runs out: the scripted fetcher answers 404.
	cases.push(await runWalk("2026-11-03", "2026-11-20", [], [week1]));
	return cases;
}

const RANDOM_SYMBOLS: readonly unknown[] = [
	"AAPL",
	"MSFT",
	"BH.A",
	"BRK.B",
	" KO ",
	"aapl",
	"BRK B",
	"",
	"A".repeat(17),
	null,
	undefined,
	"7203",
	"130A",
];

function randomRow(rng: Rng, from: string, spanDays: number): Row {
	const offset = rng.int(-2, spanDays + 2);
	const date = rng.chance(0.05)
		? rng.pick(["2026-02-30", "bad", "", "2026-13-01"])
		: new Date(Date.parse(`${from}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
	return row(
		rng.pick(RANDOM_SYMBOLS),
		date,
		rng.chance(0.9) ? rng.pick([2026, 2027]) : rng.pick<unknown>([2026.5, null, undefined, 0]),
		rng.chance(0.9) ? rng.int(1, 4) : rng.pick<unknown>([0, 5, 2.5, null, undefined]),
		rng.pick<unknown>(["bmo", "amc", "dmh", "", null, undefined]),
	);
}

async function randomWalks(): Promise<WalkCase[]> {
	const rng = new Rng(0xca1e);
	const cases: WalkCase[] = [];
	for (let index = 0; index < 80; index += 1) {
		const spanDays = rng.pick([0, 1, 6, 7, 8, 13, 20, 30]);
		const from = new Date(Date.UTC(2026, 10, 1 + rng.int(0, 60))).toISOString().slice(0, 10);
		const to = new Date(Date.parse(`${from}T00:00:00Z`) + spanDays * 86_400_000)
			.toISOString()
			.slice(0, 10);
		const script: ScriptEntry[] = [];
		const length = rng.int(1, 16);
		for (let entry = 0; entry < length; entry += 1) {
			const roll = rng.float();
			const rows = Array.from({ length: rng.int(0, 10) }, () => randomRow(rng, from, spanDays));
			if (roll < 0.04) script.push(fetchError("HTTP_ERROR", rng.pick(["HTTP 429", "HTTP 500"])));
			else if (roll < 0.06) script.push({ text: "{" });
			else if (roll < 0.12) script.push(padded(rows, CAP + rng.int(0, 1)));
			else script.push(answer(rows));
		}
		const before = rng.chance(0.1) ? [true, rng.chance(0.5)] : [];
		cases.push(await runWalk(from, to, before, script));
	}
	return cases;
}

export async function earningsCalendarFiles(): Promise<{ path: string; content: unknown }[]> {
	return [
		{
			path: "finance/finnhub_calendar.json",
			content: {
				windows: windowCases(),
				symbols: symbolCases(),
				walks: [...(await handWalks()), ...(await randomWalks())],
			},
		},
	];
}
