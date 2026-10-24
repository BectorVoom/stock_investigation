/**
 * Per-provider request pacing for market-data refreshes (API-007): Twelve
 * Data's free plan allows 8 requests per minute, FRED 100. Each provider's
 * request starts pass through `rateWindowPermit`; a request that does not fit
 * waits out its `retryAfterMs` instead of spending the provider's quota.
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
import type { Clock } from "@research/application";
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
/** FRED allows 100 requests per minute; 30 series can never reach it, but the gate is uniform. */
export const FRED_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 100, windowMs: 60_000 };
/** Finnhub's free plan documents 60 calls/minute; the runner paces at half that (FR-018). */
export const FINNHUB_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 30, windowMs: 60_000 };
/** JPX asks callers to avoid high-frequency access: one paced batch per 10 s (FR-018). */
export const JPX_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 6, windowMs: 60_000 };
/**
 * SEC (the US stock directory, ADR-0033): the window form of the SEC
 * client's own 125 ms spacing, so a stopped job stops waiting here too.
 */
export const SEC_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 8, windowMs: 1_000 };
/** Google Calendar: at most 5 requests per second, sequential (FR-019 section 2.2). */
export const GOOGLE_RATE_LIMIT: MarketRateLimit = { maxPerWindow: 5, windowMs: 1_000 };

export function twelveDataRateLimit(requestsPerMinute: number): MarketRateLimit {
	return { maxPerWindow: requestsPerMinute, windowMs: TWELVE_DATA_WINDOW_MS };
}

/** Stock-directory refreshes pace under their source id: JPX shares its window with earnings. */
export type PacerKey = MarketProviderId | EarningsSourceId | StockDirectorySourceId | "google";

export interface MarketPacerDeps {
	readonly clock: Clock;
	readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly limits: ReadonlyMap<PacerKey, MarketRateLimit>;
	/**
	 * HTTP requests sent per fetched series (S6): FRED needs two (metadata +
	 * observations) while Twelve Data needs one. The pacer takes that many
	 * grants per `pace` call so back-to-back refreshes stay inside the
	 * documented per-minute request budget. Defaults to the registry below.
	 */
	readonly requestsPerSeries?: ReadonlyMap<string, number>;
}

/**
 * Requests sent per fetched series, by provider (S6). FRED's adapter sends
 * two requests per series (series metadata, then observations); Twelve Data
 * sends one. A per-series grant would let two back-to-back 30-series
 * refreshes send 120 FRED requests against the stated 100/min.
 */
export const MARKET_REQUESTS_PER_SERIES: ReadonlyMap<string, number> = new Map([
	["fred", 2],
	["twelve-data", 1],
]);

export interface MarketPacer {
	/**
	 * Waits until `requests` request starts to `provider` fit its window,
	 * then records the grants. A provider without a limit is always allowed.
	 * False when the signal aborted while waiting — the caller must stop, not
	 * fetch. `requests` defaults to the per-series table above (one market
	 * series); callers that pace one request at a time omit it.
	 */
	pace(provider: PacerKey, signal: AbortSignal, requests?: number): Promise<boolean>;
}

export function createMarketPacer(deps: MarketPacerDeps): MarketPacer {
	const grants = new Map<PacerKey, number[]>();
	return {
		async pace(provider, signal, requests) {
			const limit = deps.limits.get(provider);
			if (limit === undefined) return true;
			// S6: one grant per HTTP request, not per series.
			const count =
				requests ??
				deps.requestsPerSeries?.get(provider) ??
				MARKET_REQUESTS_PER_SERIES.get(provider) ??
				1;
			for (let taken = 0; taken < count; taken += 1) {
				for (;;) {
					if (signal.aborted) return false;
					const nowMs = deps.clock.nowMs();
					const recent = (grants.get(provider) ?? []).filter((at) => at > nowMs - limit.windowMs);
					const decision = rateWindowPermit(recent, nowMs, limit.maxPerWindow, limit.windowMs);
					if (decision.allowed) {
						grants.set(provider, [...recent, nowMs]);
						break;
					}
					await deps.sleep(decision.retryAfterMs, signal);
				}
			}
			return true;
		},
	};
}
