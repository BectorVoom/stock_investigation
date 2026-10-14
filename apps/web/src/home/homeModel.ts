import {
	type HomeWidget,
	homeWidgetSeriesIds,
	type MarketProviderId,
	type MarketRange,
	type MarketSeries,
	type MarketUnavailableCode,
	marketUnavailableReason,
} from "@research/contracts";
import {
	type ChangeError,
	changeOverOneYear,
	latestChange,
	type MarketChange,
	type MarketPoint,
	type YearChangeError,
} from "@research/domain";
import {
	buildHomeLineModel,
	type HomeLineModel,
	type HomeLinePath,
	type HomeLineSeriesInput,
	sparklinePath,
} from "@research/ui-registry";

/**
 * Pure view-model for the Home page (FR-017). No DOM, no fetch, no clock:
 * every function is a pure derivation over contract types, unit-tested in
 * `apps/web/test/homeModel.test.ts` with hand-worked numbers. The widgets
 * memoize these derivations (`createMemo`) and never re-parse.
 */

/**
 * Number precision on Home (one rule, applied everywhere a market number is
 * shown): the fraction digits follow the SERIES' LATEST VALUE as displayed —
 * at most 2 fraction digits when |latest value| >= 10, at most 4 below
 * (grouped, `en-US`). An absolute change is formatted with exactly the digits
 * its series' latest value is displayed with (159,044 → +29; 334.13 → +1.32;
 * 4,173.67 → +4.25), never with digits derived from the delta's own size
 * (which printed "+4.2525" next to "4,173.67") and never with forced trailing
 * zeros (which printed "+29.00" next to "159,044"). Percentages always show 2
 * digits. Rationale: a long unit next to a 4-decimal price
 * ("4,168.4404 USD per XAU (troy ounce of gold)") wraps badly, while small
 * values (yields, spreads) need their decimals.
 */
const valueLargeFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const valueSmallFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
/** Percentages always show 2 digits. */
const signedPercentFormat = new Intl.NumberFormat("en-US", {
	minimumFractionDigits: 2,
	maximumFractionDigits: 2,
	signDisplay: "exceptZero",
});

/** Thirty minutes: a dashboard whose newest refresh is older queues one auto-refresh per visit. */
export const HOME_AUTO_REFRESH_STALE_MS = 30 * 60 * 1_000;

export const HOME_RANGES: readonly MarketRange[] = ["1m", "3m", "6m", "1y", "3y", "max"];

export const HOME_RANGE_LABELS: { readonly [R in MarketRange]: string } = {
	"1m": "Past month",
	"3m": "Past 3 months",
	"6m": "Past 6 months",
	"1y": "Past year",
	"3y": "Past 3 years",
	max: "All data",
};

/**
 * Fixed widget sizes on a grid of equal cells with a fixed row height
 * (HIG Widgets: fixed sizes, "make each size distinct"). The grid is
 * `grid-cols-2 lg:grid-cols-4` with `auto-rows-[17rem]` and a 16 px gap;
 * Small is 1 × 1 (17rem), Medium and Large are 2 rows (35rem); Large spans
 * the full width (4 columns at `lg`, 2 below it). Static class strings so
 * Tailwind sees them.
 */
export const HOME_SIZE_SPAN: { readonly [S in HomeWidget["size"]]: string } = {
	small: "col-span-1 row-span-1",
	medium: "col-span-2 row-span-2",
	large: "col-span-2 row-span-2 lg:col-span-4",
};

export function seriesById(series: readonly MarketSeries[]): ReadonlyMap<string, MarketSeries> {
	return new Map(series.map((entry) => [entry.seriesId, entry]));
}

export function widgetSeriesIds(widget: HomeWidget): readonly string[] {
	// The contract owns the walk (the earnings calendar carries no series);
	// this re-exports it so the two never drift.
	return homeWidgetSeriesIds(widget);
}

/** Wire tuples ([observedOn, value]) to domain points; the repository returns them ascending. */
export function toPoints(observations: readonly (readonly [string, number])[]): MarketPoint[] {
	return observations.map(([observedOn, value]) => ({ observedOn, value }));
}

export function latestPoint(series: MarketSeries): MarketPoint | null {
	const last = series.observations.at(-1);
	return last === undefined ? null : { observedOn: last[0], value: last[1] };
}

/** Percent-unit series (e.g. FRED "Percent") show changes in percentage points, never % of %. */
export function isPercentUnit(unit: string): boolean {
	return /percent/i.test(unit);
}

export function formatValue(value: number): string {
	return (Math.abs(value) >= 10 ? valueLargeFormat : valueSmallFormat).format(value);
}

export type ChangeDirection = "up" | "down" | "unchanged";

export function changeDirection(absoluteChange: number): ChangeDirection {
	if (absoluteChange > 0) return "up";
	if (absoluteChange < 0) return "down";
	return "unchanged";
}

const DIRECTION_MARK: { readonly [D in ChangeDirection]: string } = {
	up: "▲",
	down: "▼",
	unchanged: "▬",
};

const DIRECTION_WORD: { readonly [D in ChangeDirection]: string } = {
	up: "up",
	down: "down",
	unchanged: "unchanged",
};

export interface FormattedChange {
	/** E.g. "▲ +0.52 (+0.23%)", "▲ +0.50 pp", "▬ +0.00". Never colour alone: mark plus word. */
	readonly text: string;
	readonly direction: ChangeDirection;
	/** Screen-reader word accompanying the mark. */
	readonly word: string;
}

/**
 * One change line: signed absolute delta, plus the percent in parentheses when
 * it is defined and meaningful. The unit is shown once next to the value, so
 * change lines carry no unit — except percent-unit series, which show "pp"
 * (a percent of a percent is never shown). A zero base yields no percent
 * (undefined, never 0 or infinity). E.g. "▲ +0.52 (+0.23%)", "▲ +0.50 pp",
 * "▬ 0.00". Never colour alone: mark plus word.
 */
export function formatChange(change: MarketChange, unit: string): FormattedChange {
	const direction = changeDirection(change.absoluteChange);
	const mark = DIRECTION_MARK[direction];
	const word = DIRECTION_WORD[direction];
	// The delta follows the VALUE's displayed digits (change.latest.value), not its own.
	const reference = change.latest.value;
	if (isPercentUnit(unit)) {
		return {
			text: `${mark} ${deltaFormatForValue(reference).format(change.absoluteChange)} pp`,
			direction,
			word,
		};
	}
	const absolute = formatSignedDelta(change.absoluteChange, reference);
	if (change.percentChange === null) return { text: `${mark} ${absolute}`, direction, word };
	return {
		text: `${mark} ${absolute} (${signedPercentFormat.format(change.percentChange)}%)`,
		direction,
		word,
	};
}

/** Signed delta formatters by exact fraction-digit count (0..4), created lazily. */
const signedDeltaCache = new Map<number, Intl.NumberFormat>();

/**
 * How many fraction digits the reference (latest) value is displayed with:
 * the digits after the "." in `formatValue`, or 0 for a whole display like
 * "159,044". A delta of a whole-number series therefore shows no decimals.
 */
function valueFractionDigits(referenceValue: number): number {
	const text = formatValue(referenceValue);
	const dot = text.indexOf(".");
	if (dot < 0) return 0;
	return Math.min(4, Math.max(0, text.length - dot - 1));
}

/** The signed formatter whose digits follow a series' latest value (the one rule above). */
function deltaFormatForValue(referenceValue: number): Intl.NumberFormat {
	const digits = valueFractionDigits(referenceValue);
	const cached = signedDeltaCache.get(digits);
	if (cached !== undefined) return cached;
	const created = new Intl.NumberFormat("en-US", {
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		signDisplay: "exceptZero",
	});
	signedDeltaCache.set(digits, created);
	return created;
}

/**
 * Signed absolute delta ("+10", "-27.41", "+0.0012"). The digits follow
 * `referenceValue` — the series' latest value at every call site — not the
 * delta's own size. Callers with no series value at hand omit it, in which
 * case the delta's own display digits apply.
 */
export function formatSignedDelta(
	absoluteChange: number,
	referenceValue: number = absoluteChange,
): string {
	return deltaFormatForValue(referenceValue).format(absoluteChange);
}

/** Signed absolute delta with its unit ("+0.52 USD"), or in "pp" for percent-unit series. */
export function formatAbsDelta(
	absoluteChange: number,
	unit: string,
	referenceValue: number = absoluteChange,
): string {
	if (isPercentUnit(unit))
		return `${deltaFormatForValue(referenceValue).format(absoluteChange)} pp`;
	return `${formatSignedDelta(absoluteChange, referenceValue)}${unit === "" ? "" : ` ${unit}`}`;
}

/**
 * Signed percent ("+0.23%"), or null when there is no meaningful percent:
 * a zero base, or a percent-unit series (a percent of a percent).
 */
export function formatPctValue(percentChange: number | null, unit: string): string | null {
	if (percentChange === null || isPercentUnit(unit)) return null;
	return `${signedPercentFormat.format(percentChange)}%`;
}

export interface SeriesSummary {
	readonly latest: MarketPoint | null;
	readonly change: ReturnType<typeof latestChange>;
	readonly yearChange: ReturnType<typeof changeOverOneYear>;
}

export function summarizeSeries(series: MarketSeries): SeriesSummary {
	const points = toPoints(series.observations);
	return {
		latest: points.at(-1) ?? null,
		change: latestChange(points),
		yearChange: changeOverOneYear(points),
	};
}

/**
 * The failure reason to note beside stored values, or null when there is
 * nothing stale to note. A series whose last refresh failed but that still
 * holds stored observations shows those real values (with their as-of date)
 * together with an amber "last refresh failed (reason)" note — real data is
 * never hidden behind "unavailable". Only a series with no observations at
 * all is "unavailable (reason)".
 */
export function staleFailureReason(series: MarketSeries): string | null {
	if (series.unavailable === null || series.observations.length === 0) return null;
	return series.unavailable.reason;
}

export function changeErrorText(error: ChangeError | YearChangeError): string {
	switch (error) {
		case "NOT_ENOUGH_OBSERVATIONS":
		case "NO_BASE_OBSERVATION":
			return "needs more history";
		case "BASE_TOO_OLD":
			return "no observation near the year-ago mark";
		case "NON_FINITE":
			return "value is not a number";
	}
}

/** Fixed unavailable wording per code (provider text is never shown); exported for tests. */
export function unavailableText(code: MarketUnavailableCode, provider?: MarketProviderId): string {
	return marketUnavailableReason(code, provider);
}

/**
 * True when Home should queue one automatic refresh on this visit: no refresh
 * is active and the newest `lastRefreshedAt` across the dashboard's series is
 * missing or older than 30 minutes. Pure over the timestamps and `nowMs`.
 * V3: an empty series list never needs a refresh (a bare dashboard queues
 * nothing, and the decision is only taken once both dashboard and data have
 * loaded — see HomeView).
 */
export function needsAutoRefresh(
	lastRefreshedAts: readonly (string | null)[],
	nowMs: number,
): boolean {
	if (lastRefreshedAts.length === 0) return false;
	let newest = Number.NEGATIVE_INFINITY;
	for (const at of lastRefreshedAts) {
		if (at === null) return true;
		const ms = Date.parse(at);
		if (!Number.isFinite(ms)) return true;
		if (ms > newest) newest = ms;
	}
	if (newest === Number.NEGATIVE_INFINITY) return true;
	return nowMs - newest > HOME_AUTO_REFRESH_STALE_MS;
}

/** True when any series on the dashboard comes from FRED (attribution line). */
export function hasFredSeries(seriesIds: readonly string[]): boolean {
	return seriesIds.some((id) => id.startsWith("fred:"));
}

export type { HomeLineModel, HomeLinePath, HomeLineSeriesInput };
export { buildHomeLineModel, sparklinePath };
