/**
 * Per-provider request pacing for market-data refreshes (API-007): Twelve
 * Data's free plan allows 8 requests per minute, FRED 100. Each request start
 * passes through `rateWindowPermit` — one grant per request actually sent; a
 * request that does not fit waits out its `retryAfterMs` instead of spending
 * the provider's quota. A provider with a daily budget (Twelve Data,
 * `TWELVE_DATA_DAILY_LIMIT` per UTC day) is refused at once when the day's
 * budget is spent.
 *
 * The pacer is keyed by provider/source id (`MarketProviderId |
 * EarningsSourceId`), so the earnings-date refresh (FR-018: Finnhub at 30
 * request starts per 60 s, JPX at 6) paces through the SAME gate rather than
 * a copy: entries are added in the composition root, never by branching here
 * (ARCH-006).
 *
 * The clock and sleep are injected (ARCH-002): tests use a fake clock with a
 * sleep that advances it — a sleep that never advances time would wait
 * forever, exactly as a real sleep that never elapsed would. The pacer holds
 * its grant history across jobs (it is built once in the composition root),
 * so back-to-back refreshes share one window per provider.
 */
import type { Clock, MarketRequestAdmission } from "@research/application";
import type {
	EarningsSourceId,
	MarketProviderId,
	StockDirectorySourceId,
} from "@research/contracts";
import { rateWindowPermit } from "@research/domain";

export interface MarketRateLimit {
	readonly maxPerWindow: number;
	readonly windowMs: number;
}

/** Free-plan default: 8 Twelve Data request starts per minute. */
export const DEFAULT_TWELVE_DATA_REQUESTS_PER_MINUTE = 8;
/** Override bounds for TWELVE_DATA_REQUESTS_PER_MINUTE (section 4.4). */
export const TWELVE_DATA_REQUESTS_PER_MINUTE_MIN = 1;
export const TWELVE_DATA_REQUESTS_PER_MINUTE_MAX = 600;
export const TWELVE_DATA_WINDOW_MS = 60_000;
/** FRED publishes 120 requests per minute; we pace at 100 as our own margin below it. */
export const FRED_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 100, windowMs: 60_000 };
/** Finnhub's free plan documents 60 calls/minute; the runner paces at half that (FR-018). */
export const FINNHUB_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 30, windowMs: 60_000 };
/** JPX asks callers to avoid high-frequency access: one paced batch per 10 s (FR-018). */
export const JPX_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 6, windowMs: 60_000 };
/**
 * SEC (the US stock directory, ADR-0034): the window form of the SEC
 * client's own 125 ms spacing, so a stopped job stops waiting here too.
 */
export const SEC_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 8, windowMs: 1_000 };
/** EDINET API v2 (ADR-0048 §6): one request per second, lists and document downloads alike. */
export const EDINET_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 1, windowMs: 1_000 };
/** Google Calendar: at most 5 requests per second, sequential (FR-019 section 2.2). */
export const GOOGLE_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 5, windowMs: 1_000 };

export function twelveDataRateLimit(requestsPerMinute: number): MarketRateLimit {
	return { maxPerWindow: requestsPerMinute, windowMs: TWELVE_DATA_WINDOW_MS };
}

/**
 * Default `TWELVE_DATA_DAILY_LIMIT`: the Basic (free) plan's 800 API credits
 * per day, the quota resetting at 00:00:00 UTC; `/time_series` costs 1
 * credit (support article "Credits", read 2026-10-31). Paid plans have no
 * daily limit: they set 0.
 */
export const DEFAULT_TWELVE_DATA_DAILY_LIMIT = 800;
/** Override bounds for TWELVE_DATA_DAILY_LIMIT; 0 means no daily limit. */
export const TWELVE_DATA_DAILY_LIMIT_MAX = 1_000_000;

/**
 * Stock-directory refreshes pace under their source id: JPX shares its window
 * with earnings; a `financial-sync` job paces under `sec` (shared with the US
 * stock list) or `edinet`.
 */
export type PacerKey =
	| MarketProviderId
	| EarningsSourceId
	| StockDirectorySourceId
	| "google"
	| "edinet";

/** The daily budgets: Twelve Data's configured limit; 0 (a paid plan) means none. */
export function marketDailyBudgets(twelveDataDailyLimit: number): ReadonlyMap<PacerKey, number> {
	return twelveDataDailyLimit === 0 ? new Map() : new Map([["twelve-data", twelveDataDailyLimit]]);
}

export interface MarketPacerDeps {
	readonly clock: Clock;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly limits: ReadonlyMap<PacerKey, MarketRateLimit>;
	/**
	 * Grants one `pace` call takes when it names no count, by provider
	 * (default 1). Market adapters ask once per request they send
	 * (`admit`), so no provider needs more.
	 */
	readonly requestsPerSeries?: ReadonlyMap<string, number>;
	/**
	 * Request starts allowed per UTC day, by provider (Twelve Data's Basic
	 * plan). In memory only: a runner restart starts the day's count at 0.
	 */
	readonly dailyBudgets?: ReadonlyMap<PacerKey, number>;
}

export interface MarketPacer {
	/**
	 * Waits until all `requests` units for `provider` fit its window
	 * together, then records them at once (a request costing more than the
	 * window holds takes the whole window). A provider without a limit is
	 * always allowed.
	 * False when the signal aborted while waiting — the caller must stop, not
	 * fetch — or when the provider's daily budget is spent. `requests`
	 * defaults to `requestsPerSeries` (1).
	 */
	pace(provider: PacerKey, signal: AbortSignal, requests?: number): Promise<boolean>;
}

/** The market pacer: `pace`, plus the per-request admission the market adapters await. */
export interface MarketRequestPacer extends MarketPacer {
	/**
	 * Admits one request start: `budget-spent` at once, without waiting,
	 * when the provider's daily budget is used up; otherwise waits for the
	 * window like `pace` (`stopped` when the signal aborted).
	 */
	admit(provider: PacerKey, signal: AbortSignal): Promise<MarketRequestAdmission>;
}

const UTC_DAY_MS = 86_400_000;

export function createMarketPacer(deps: MarketPacerDeps): MarketRequestPacer {
	const grants = new Map<PacerKey, number[]>();
	/** Starts counted against the daily budget, for the UTC day (days since the epoch) `day`. */
	const spentToday = new Map<PacerKey, { readonly day: number; readonly spent: number }>();

	/**
	 * Admits one request costing `units` grants, reserving them all at one
	 * instant: it waits until every unit fits the window together, so two
	 * multi-unit requests can never overrun a window between them. A request
	 * costing more than the window holds takes the whole window (it could
	 * never fit otherwise). The daily budget counts units too.
	 */
	async function take(
		provider: PacerKey,
		signal: AbortSignal,
		units: number,
	): Promise<MarketRequestAdmission> {
		const limit = deps.limits.get(provider);
		const budget = deps.dailyBudgets?.get(provider);
		if (units <= 0 || (limit === undefined && budget === undefined)) return "granted";
		const reserved = limit === undefined ? units : Math.min(units, limit.maxPerWindow);
		for (;;) {
			if (signal.aborted) return "stopped";
			const nowMs = deps.clock.nowMs();
			// A changed UTC date (forward or, with a clock moved back, backward) starts a new count.
			const day = Math.floor(nowMs / UTC_DAY_MS);
			const counted = spentToday.get(provider);
			const spent = counted !== undefined && counted.day === day ? counted.spent : 0;
			if (budget !== undefined && spent + units > budget) return "budget-spent";
			if (limit !== undefined) {
				const recent = (grants.get(provider) ?? []).filter((at) => at > nowMs - limit.windowMs);
				// All `reserved` units fit iff fewer than `max - reserved + 1` grants are in the window.
				const decision = rateWindowPermit(
					recent,
					nowMs,
					limit.maxPerWindow - reserved + 1,
					limit.windowMs,
				);
				if (!decision.allowed) {
					await deps.sleep(decision.retryAfterMs, signal);
					continue;
				}
				grants.set(provider, [...recent, ...Array.from({ length: reserved }, () => nowMs)]);
			}
			if (budget !== undefined) spentToday.set(provider, { day, spent: spent + units });
			return "granted";
		}
	}

	return {
		admit: (provider, signal) => take(provider, signal, 1),
		async pace(provider, signal, requests) {
			const units = requests ?? deps.requestsPerSeries?.get(provider) ?? 1;
			return (await take(provider, signal, units)) === "granted";
		},
	};
}
