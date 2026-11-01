/**
 * Every directory stock's daily bars, one request per market and date
 * (ADR-0058 §2): the provider-neutral body of a `stock-prices-sync` job and
 * the pure rules it decides by. The providers (Massive for US, J-Quants for
 * JP) implement `StockPriceSource`; this module walks the claim's days
 * newest first, fetches the requested stock windows, refetches the windows
 * of stocks a split made inconsistent, and reports one outcome per day.
 *
 * The rules are replayed by the Rust runner (`vectors/finance/stock_prices.json`):
 *  - ticker mapping: Massive writes classes `BRK.B`, preferreds `ABRpD`,
 *    warrants `AAC.WS` / `NE.WS.A`, units `AAC.U`, rights `AIIAr`,
 *    when-issued `MSGKw` (the consolidated-tape forms); the directory holds
 *    SEC's forms `BRK-B`, `ABR-PD`, `AAC-WT`, `NE-WTA`, `AAC-UN`, `AIIA-RI`,
 *    `MSGK-WI`. J-Quants writes 5-character codes (`13800`, `130A0`); the
 *    directory holds the 4-character code. Anything else is dropped.
 *  - market dates: US days are America/New_York dates (US daylight-saving
 *    rules since 2007), JP days Asia/Tokyo dates.
 *  - day outcomes: a day newer than the plan's delay is `not-yet-available`
 *    without a request; an empty answer is `no-trading` once the day is
 *    older than the delay plus `settleDays`, else `not-yet-available`; a
 *    plan refusal (403 not about the key) is `not-yet-available` for a
 *    recent day, `too-old` for a day more than `PLAN_REFUSAL_TOO_OLD_DAYS`
 *    beyond the delay, and otherwise fails the job as `PLAN_NOT_ENTITLED`.
 *
 * Failures: a rejected key fails the job (`SOURCE_AUTH_FAILED`, the
 * provider's status unchanged, ADR-0037); a rate limit or a source failure
 * ends the fetching and the job reports what it has — or fails
 * (`RATE_LIMITED` not retried at once, `SOURCE_FAILED` retryable) when it
 * has nothing. Provider text is never logged, stored or shown.
 */
import type { MarketRequestAdmission } from "@research/application";
import {
	type ClaimedJob,
	isConsistentBar,
	type MarketBarTuple,
	type MarketUnavailableCode,
	STOCK_PRICE_LIMITS,
	type StockDayBar,
	type StockHistoryBar,
	type StockHistoryResult,
	type StockPriceDayOutcome,
	type StockPriceDayResult,
	type StockPriceProvider,
	stockPriceSymbolSchema,
	type WatchMarket,
} from "@research/contracts";
import { isoDateOfDayNumber, isoDayNumber, type Result } from "@research/domain";

export type StockPricesJob = Extract<ClaimedJob, { kind: "stock-prices-sync" }>;

/**
 * A plan refusal for a day more than this many days beyond the delay is
 * `too-old`: both free plans keep two years, so a refusal that far back is
 * the history limit, while one within the last year means the key's plan
 * does not include the data at all.
 */
export const PLAN_REFUSAL_TOO_OLD_DAYS = 365;

/**
 * A window whose start the plan refuses is asked once more from this many
 * days before the window's end (when that is inside the window): safely
 * inside both free plans' two years, so an edge day of the claim's window
 * cannot cost a stock its history. The stored window is the one asked.
 */
export const PLAN_HISTORY_SAFE_DAYS = 700;

/** Why a provider request gave no answer. */
export type StockPriceProblem =
	/** The job was stopped while waiting for its admission. */
	| { readonly kind: "stopped" }
	/** The key is missing at the provider, invalid or expired. */
	| { readonly kind: "auth-failed"; readonly status: number | null }
	/** The plan does not cover the request (a 403 not about the key). */
	| { readonly kind: "plan-refused"; readonly status: number }
	/** The provider's rate limit (429), or the runner's own budget. */
	| { readonly kind: "rate-limited"; readonly status: number | null }
	/** The provider does not know the stock (404). */
	| { readonly kind: "not-found"; readonly status: number | null }
	/** A network, server or format failure. */
	| { readonly kind: "failed"; readonly status: number | null };

/** One market's answer for one date. */
export interface StockDayAnswer {
	/** Mapped, consistent, symbol-sorted and symbol-unique bars. */
	readonly bars: readonly StockDayBar[];
	/** Symbols whose record says a price adjustment applied that day (J-Quants `AdjFactor ≠ 1`). */
	readonly adjustedSymbols: readonly string[];
}

/** What a source needs per request: the stop signal and the pacing admission. */
export interface StockPriceRequestContext {
	readonly signal: AbortSignal;
	/** Awaited before every HTTP request, every page of a paginated answer included. */
	readonly beforeRequest: () => Promise<MarketRequestAdmission>;
}

/** One provider of one market's stock prices (ARCH-006). */
export interface StockPriceSource {
	readonly provider: StockPriceProvider;
	readonly market: WatchMarket;
	/** Days newer than today minus this are not asked for (J-Quants Free: 84; Massive: 0). */
	readonly delayDays: number;
	/** True when splits show in the day answers (`adjustedSymbols`), false when they are listed. */
	readonly splitsInDayAnswers: boolean;
	fetchDay(
		date: string,
		context: StockPriceRequestContext,
	): Promise<Result<StockDayAnswer, StockPriceProblem>>;
	/** Ascending, date-unique bars of `[from, to]`; `not-found` when the provider knows none. */
	fetchHistory(
		symbol: string,
		from: string,
		to: string,
		context: StockPriceRequestContext,
	): Promise<Result<readonly StockHistoryBar[], StockPriceProblem>>;
	/** Directory symbols with a split executed in `(after, through]` (only when not in day answers). */
	fetchSplitSymbols(
		after: string,
		through: string,
		context: StockPriceRequestContext,
	): Promise<Result<readonly string[], StockPriceProblem>>;
}

export type StockPricesOutcome =
	| {
			readonly kind: "synced";
			readonly days: readonly StockPriceDayResult[];
			readonly histories: readonly StockHistoryResult[];
			/** Split stocks not refetched because the job's history cap was reached. */
			readonly splitsOverCap: number;
			/**
			 * Every split the job found, refetched or not: sorted, distinct, at
			 * most `maxSplitSymbols` (the API refetches the rest later).
			 */
			readonly splitSymbols: readonly string[];
			/**
			 * The newest day the split check ran completely through (US: the
			 * listing answered to its last page; JP: every claimed day after
			 * `adjustmentsSince` was read), null when it did not run or finish.
			 */
			readonly splitCheckedThrough: string | null;
			/** What ended the fetching early, or null when every request was made. */
			readonly endedBy: "rate-limited" | "failed" | null;
	  }
	| {
			readonly kind: "failed";
			readonly code: MarketUnavailableCode;
			readonly upstreamStatus: number | null;
			readonly retryable: boolean;
	  }
	| { readonly kind: "stopped" };

/* ---------- Ticker and code mapping ---------- */

const PLAIN = /^[A-Z0-9]+$/;
const MASSIVE_WARRANT = /^([A-Z0-9]+)\.WS(?:\.([A-Z]))?$/;
const MASSIVE_UNIT = /^([A-Z0-9]+)\.U$/;
const MASSIVE_CLASS = /^([A-Z0-9]+)\.([A-Z])$/;
const MASSIVE_PREFERRED = /^([A-Z0-9]+)p([A-Z])?$/;
const MASSIVE_RIGHT = /^([A-Z0-9]+)r$/;
const MASSIVE_WHEN_ISSUED = /^([A-Z0-9]+)w$/;
const DIRECTORY_SUFFIXED = /^([A-Z0-9]+)-([A-Z]{1,3})$/;
const JQUANTS_CODE = /^([0-9][0-9A-Z]{3})0$/;
const JP_SYMBOL = /^[0-9][0-9A-Z]{3}$/;

function directorySymbol(symbol: string): string | null {
	return stockPriceSymbolSchema.safeParse(symbol).success ? symbol : null;
}

/** Massive's ticker in the directory's (SEC) form, or null when it has none. */
export function massiveTickerToSymbol(ticker: string): string | null {
	if (PLAIN.test(ticker)) return directorySymbol(ticker);
	let match = MASSIVE_WARRANT.exec(ticker);
	if (match !== null) return directorySymbol(`${match[1]}-WT${match[2] ?? ""}`);
	match = MASSIVE_UNIT.exec(ticker);
	if (match !== null) return directorySymbol(`${match[1]}-UN`);
	match = MASSIVE_CLASS.exec(ticker);
	if (match !== null) return directorySymbol(`${match[1]}-${match[2]}`);
	match = MASSIVE_PREFERRED.exec(ticker);
	if (match !== null) return directorySymbol(`${match[1]}-P${match[2] ?? ""}`);
	match = MASSIVE_RIGHT.exec(ticker);
	if (match !== null) return directorySymbol(`${match[1]}-RI`);
	match = MASSIVE_WHEN_ISSUED.exec(ticker);
	if (match !== null) return directorySymbol(`${match[1]}-WI`);
	return null;
}

/** A directory symbol in Massive's form (the inverse of `massiveTickerToSymbol`), or null. */
export function symbolToMassiveTicker(symbol: string): string | null {
	if (PLAIN.test(symbol)) return symbol;
	const match = DIRECTORY_SUFFIXED.exec(symbol);
	if (match === null) return null;
	const base = match[1] ?? "";
	const suffix = match[2] ?? "";
	if (suffix === "WT") return `${base}.WS`;
	if (suffix.length === 3 && suffix.startsWith("WT")) return `${base}.WS.${suffix.slice(2)}`;
	if (suffix === "UN") return `${base}.U`;
	if (suffix === "RI") return `${base}r`;
	if (suffix === "WI") return `${base}w`;
	if (suffix === "P") return `${base}p`;
	if (suffix.length === 2 && suffix.startsWith("P")) return `${base}p${suffix.slice(1)}`;
	if (suffix.length === 1) return `${base}.${suffix}`;
	return null;
}

/** J-Quants' 5-character code as the directory's 4-character code (`13800` → `1380`), or null. */
export function jquantsCodeToSymbol(code: string): string | null {
	const match = JQUANTS_CODE.exec(code);
	return match?.[1] ?? null;
}

/** A JP directory symbol as J-Quants' 5-character code (`1380` → `13800`), or null. */
export function symbolToJquantsCode(symbol: string): string | null {
	return JP_SYMBOL.test(symbol) ? `${symbol}0` : null;
}

/* ---------- Market dates ---------- */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** The UTC day number of the `nth` Sunday (1-based) of a month (0-based). */
function nthSundayDay(year: number, month: number, nth: number): number {
	const first = Date.UTC(year, month, 1) / DAY_MS;
	// 1970-01-01 was a Thursday (weekday 4, Sunday 0).
	const weekday = (((first + 4) % 7) + 7) % 7;
	return first + ((7 - weekday) % 7) + (nth - 1) * 7;
}

/**
 * The America/New_York date of an instant: daylight time (UTC−4) from the
 * second Sunday of March 02:00 EST to the first Sunday of November 02:00
 * EDT, standard time (UTC−5) otherwise.
 */
export function newYorkDate(epochMs: number): string {
	const year = new Date(epochMs).getUTCFullYear();
	const daylightStart = nthSundayDay(year, 2, 2) * DAY_MS + 7 * HOUR_MS;
	const daylightEnd = nthSundayDay(year, 10, 1) * DAY_MS + 6 * HOUR_MS;
	const offset = epochMs >= daylightStart && epochMs < daylightEnd ? -4 * HOUR_MS : -5 * HOUR_MS;
	return isoDateOfDayNumber(Math.floor((epochMs + offset) / DAY_MS));
}

/** The Asia/Tokyo date of an instant (UTC+9, no daylight time). */
export function tokyoDate(epochMs: number): string {
	return isoDateOfDayNumber(Math.floor((epochMs + 9 * HOUR_MS) / DAY_MS));
}

/** Today's date in the market's own time zone. */
export function marketToday(market: WatchMarket, epochMs: number): string {
	return market === "US" ? newYorkDate(epochMs) : tokyoDate(epochMs);
}

/* ---------- Day outcomes ---------- */

/** A day newer than the plan's delay is not asked for: `not-yet-available`, else null. */
export function delayedDayOutcome(ageDays: number, delayDays: number): StockPriceDayOutcome | null {
	return ageDays < delayDays ? "not-yet-available" : null;
}

/** An empty answer: final (`no-trading`) once the day is older than the delay plus `settleDays`. */
export function emptyDayOutcome(ageDays: number, delayDays: number): StockPriceDayOutcome {
	return ageDays > delayDays + STOCK_PRICE_LIMITS.settleDays ? "no-trading" : "not-yet-available";
}

/** A plan refusal's outcome, or null when it means the plan lacks the data (the job fails). */
export function planRefusalOutcome(
	ageDays: number,
	delayDays: number,
): StockPriceDayOutcome | null {
	if (ageDays <= delayDays + STOCK_PRICE_LIMITS.settleDays) return "not-yet-available";
	if (ageDays > delayDays + PLAN_REFUSAL_TOO_OLD_DAYS) return "too-old";
	return null;
}

/* ---------- Bars ---------- */

/** The provider's volume, or null when absent, not finite or negative. */
export function providerVolume(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** A finite provider price, or null. */
export function providerPrice(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `[close, [open, high, low, volume]]` when every price is readable and the bar consistent. */
export function consistentBar(
	open: unknown,
	high: unknown,
	low: unknown,
	close: unknown,
	volume: unknown,
): { readonly close: number; readonly bar: MarketBarTuple } | null {
	const o = providerPrice(open);
	const h = providerPrice(high);
	const l = providerPrice(low);
	const c = providerPrice(close);
	if (o === null || h === null || l === null || c === null) return null;
	const bar: MarketBarTuple = [o, h, l, providerVolume(volume)];
	return isConsistentBar(c, bar) ? { close: c, bar } : null;
}

/** Symbol-sorted, symbol-unique (first wins), at most `maxBarsPerDay`. */
export function finishDayBars(bars: StockDayBar[]): StockDayBar[] {
	bars.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const unique: StockDayBar[] = [];
	for (const bar of bars) {
		if (unique.length > 0 && unique[unique.length - 1]?.[0] === bar[0]) continue;
		unique.push(bar);
	}
	return unique.slice(0, STOCK_PRICE_LIMITS.maxBarsPerDay);
}

/** Ascending, date-unique (first wins), within `[from, to]`, the newest `maxBarsPerHistory`. */
export function finishHistoryBars(
	bars: StockHistoryBar[],
	from: string,
	to: string,
): StockHistoryBar[] {
	const inside = bars.filter(([date]) => date >= from && date <= to);
	// Stable sort: the first of two bars of one date stays first.
	inside.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const unique: StockHistoryBar[] = [];
	for (const bar of inside) {
		if (unique.length > 0 && unique[unique.length - 1]?.[0] === bar[0]) continue;
		unique.push(bar);
	}
	return unique.slice(-STOCK_PRICE_LIMITS.maxBarsPerHistory);
}

/* ---------- The job ---------- */

export interface StockPricesSyncDeps {
	readonly nowMs: number;
	readonly signal: AbortSignal;
	readonly beforeRequest: () => Promise<MarketRequestAdmission>;
	/** Called on every 429 the provider answers: the pacer holds the provider. */
	readonly onRateLimited: () => void;
}

type Ended = Exclude<StockPriceProblem, { kind: "stopped" | "auth-failed" | "plan-refused" }>;

function failedOutcome(problem: Ended): StockPricesOutcome {
	return problem.kind === "rate-limited"
		? { kind: "failed", code: "RATE_LIMITED", upstreamStatus: problem.status, retryable: false }
		: { kind: "failed", code: "SOURCE_FAILED", upstreamStatus: problem.status, retryable: true };
}

function authFailed(status: number | null): StockPricesOutcome {
	return { kind: "failed", code: "SOURCE_AUTH_FAILED", upstreamStatus: status, retryable: false };
}

/**
 * Runs one `stock-prices-sync` claim against its market's source. Requests
 * are sequential; each passes the source's admission (the pacer) first.
 */
export async function syncStockPrices(
	job: StockPricesJob,
	source: StockPriceSource,
	deps: StockPricesSyncDeps,
): Promise<StockPricesOutcome> {
	const context: StockPriceRequestContext = {
		signal: deps.signal,
		beforeRequest: deps.beforeRequest,
	};
	const today = isoDayNumber(marketToday(source.market, deps.nowMs)) ?? 0;
	const days: StockPriceDayResult[] = [];
	const reported = new Set<string>();
	/** Claimed days whose answer was read (their adjustments inspected). */
	const inspected = new Set<string>();
	const adjusted: string[] = [];
	const observe = (problem: StockPriceProblem): void => {
		if (problem.kind === "rate-limited" && problem.status !== null) deps.onRateLimited();
	};
	let newestStored: string | null = null;
	// Held in an object: the window fetches below set it from a closure.
	const state: { ended: Ended | null } = { ended: null };

	for (const date of job.days) {
		if (deps.signal.aborted) return { kind: "stopped" };
		const dayNumber = isoDayNumber(date);
		if (dayNumber === null || reported.has(date)) continue;
		const age = today - dayNumber;
		const delayed = delayedDayOutcome(age, source.delayDays);
		if (delayed !== null) {
			reported.add(date);
			days.push({ date, outcome: delayed, bars: [] });
			continue;
		}
		const answer = await source.fetchDay(date, context);
		if (!answer.ok) {
			const problem = answer.error;
			observe(problem);
			if (problem.kind === "stopped") return { kind: "stopped" };
			if (problem.kind === "auth-failed") return authFailed(problem.status);
			if (problem.kind === "plan-refused") {
				const outcome = planRefusalOutcome(age, source.delayDays);
				if (outcome === null) {
					return {
						kind: "failed",
						code: "PLAN_NOT_ENTITLED",
						upstreamStatus: problem.status,
						retryable: false,
					};
				}
				reported.add(date);
				days.push({ date, outcome, bars: [], upstreamStatus: problem.status });
				continue;
			}
			state.ended = problem;
			break;
		}
		reported.add(date);
		inspected.add(date);
		if (job.adjustmentsSince !== null && date > job.adjustmentsSince) {
			adjusted.push(...answer.value.adjustedSymbols);
		}
		if (answer.value.bars.length === 0) {
			days.push({ date, outcome: emptyDayOutcome(age, source.delayDays), bars: [] });
			continue;
		}
		days.push({ date, outcome: "stored", bars: [...answer.value.bars] });
		if (newestStored === null || date > newestStored) newestStored = date;
	}

	const histories: StockHistoryResult[] = [];
	const fetched = new Set<string>();
	// The plan's newest day: a window never asks past it.
	const newestAvailable = isoDateOfDayNumber(today - source.delayDays);
	/** Fetches one window; a problem that ends the job is returned instead. */
	const fetchWindow = async (
		symbol: string,
		requestedFrom: string,
		requestedTo: string,
		reason: StockHistoryResult["reason"],
	): Promise<StockPricesOutcome | null> => {
		fetched.add(symbol);
		let from = requestedFrom;
		const to = requestedTo > newestAvailable ? newestAvailable : requestedTo;
		if (from > to) return null;
		let answer = await source.fetchHistory(symbol, from, to, context);
		if (!answer.ok) observe(answer.error);
		// A refused start is asked once more from inside the window and the plan.
		const retryFrom = isoDateOfDayNumber((isoDayNumber(to) ?? 0) - PLAN_HISTORY_SAFE_DAYS);
		if (!answer.ok && answer.error.kind === "plan-refused" && retryFrom > from) {
			from = retryFrom;
			answer = await source.fetchHistory(symbol, from, to, context);
			if (!answer.ok) observe(answer.error);
		}
		if (answer.ok) {
			const bars = finishHistoryBars([...answer.value], from, to);
			histories.push({
				symbol,
				reason,
				outcome: bars.length > 0 ? "stored" : "not-found",
				from,
				to,
				bars,
			});
			return null;
		}
		const problem = answer.error;
		if (problem.kind === "stopped") return { kind: "stopped" };
		if (problem.kind === "auth-failed") return authFailed(problem.status);
		if (problem.kind === "not-found") {
			histories.push({ symbol, reason, outcome: "not-found", from, to, bars: [] });
			return null;
		}
		// A refused or failed window is reported unavailable (the API backs it
		// off); a refusal lets the others go on, a source failure ends the walk.
		if (problem.kind === "plan-refused" || problem.kind === "failed") {
			histories.push({ symbol, reason, outcome: "unavailable", from, to, bars: [] });
		}
		if (problem.kind !== "plan-refused") state.ended = problem;
		return null;
	};

	for (const request of job.histories) {
		if (state.ended !== null) break;
		if (deps.signal.aborted) return { kind: "stopped" };
		if (fetched.has(request.symbol) || request.from > request.to) continue;
		const stop = await fetchWindow(request.symbol, request.from, request.to, "requested");
		if (stop !== null) return stop;
	}

	let splitsOverCap = 0;
	let splitSymbols: string[] = [];
	let splitCheckedThrough: string | null = null;
	const since = job.adjustmentsSince;
	if (since !== null && source.splitsInDayAnswers) {
		// JP: the adjustments of every read day after `since` are known, even
		// when the walk ended early. The check is complete through the newest
		// stored day when every claimed day after `since` was read and no
		// unclaimed due day can lie after `since` (a full claim's oldest day
		// is not after it).
		splitSymbols = [...adjusted];
		const claimedAfter = job.days.filter((date) => date > since);
		const oldest = job.days.reduce<string | null>(
			(min, date) => (min === null || date < min ? date : min),
			null,
		);
		const fullClaim =
			job.days.length >= STOCK_PRICE_LIMITS.maxDaysPerJob && oldest !== null && oldest > since;
		if (
			newestStored !== null &&
			newestStored > since &&
			!fullClaim &&
			claimedAfter.every((date) => date > newestStored || inspected.has(date))
		) {
			splitCheckedThrough = newestStored;
		}
	} else if (since !== null && state.ended === null) {
		// US: the listing of every split executed after `since`, through the
		// settled day (a split published a little late is still listed).
		const through = isoDateOfDayNumber(today - STOCK_PRICE_LIMITS.settleDays);
		if (through > since) {
			if (deps.signal.aborted) return { kind: "stopped" };
			const listed = await source.fetchSplitSymbols(since, through, context);
			if (listed.ok) {
				splitSymbols = [...listed.value];
				splitCheckedThrough = through;
			} else {
				const problem = listed.error;
				observe(problem);
				if (problem.kind === "stopped") return { kind: "stopped" };
				if (problem.kind === "auth-failed") return authFailed(problem.status);
				if (problem.kind === "rate-limited" || problem.kind === "failed") state.ended = problem;
			}
		}
	}
	splitSymbols = [...new Set(splitSymbols)].sort().slice(0, STOCK_PRICE_LIMITS.maxSplitSymbols);
	const requested = new Set(job.histories.map((request) => request.symbol));
	const candidates = splitSymbols.filter((symbol) => !requested.has(symbol));
	const room = Math.max(0, STOCK_PRICE_LIMITS.maxHistoriesPerJob - job.histories.length);
	if (state.ended === null) splitsOverCap = Math.max(0, candidates.length - room);
	for (const symbol of candidates.slice(0, room)) {
		if (state.ended !== null) break;
		if (deps.signal.aborted) return { kind: "stopped" };
		// The whole window to the plan's newest day: no pre-split bar is left.
		const stop = await fetchWindow(symbol, job.windowStart, newestAvailable, "split");
		if (stop !== null) return stop;
	}

	const endedBy = state.ended;
	if (days.length === 0 && histories.length === 0 && endedBy !== null) {
		return failedOutcome(endedBy);
	}
	return {
		kind: "synced",
		days,
		histories,
		splitsOverCap,
		splitSymbols,
		splitCheckedThrough,
		endedBy: endedBy === null ? null : endedBy.kind === "rate-limited" ? "rate-limited" : "failed",
	};
}

/** The problem a fetch failure means for a stock-price provider's status, before provider rules. */
export function problemOfStatus(status: number | null): StockPriceProblem {
	if (status === 401) return { kind: "auth-failed", status };
	if (status === 404) return { kind: "not-found", status };
	if (status === 429) return { kind: "rate-limited", status };
	return { kind: "failed", status };
}
