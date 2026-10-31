import type {
	MarketFrequency,
	MarketProviderId,
	MarketRange,
	MarketSeries,
	MarketUnavailableCode,
	RefreshScope,
} from "@research/contracts";
import {
	type ChangeError,
	type ChartPreset,
	changeOverOneYear,
	dayNumberToIso,
	isoToDayNumber,
	latestChange,
	type MarketChange,
	type MarketPoint,
	presetWindow,
	type YearChangeError,
} from "@research/domain";
import type { MessagesOf } from "@research/i18n";
import {
	buildHomeLineModel,
	buildSparkline,
	type HomeLineModel,
	type HomeLinePath,
	type HomeLineSeriesInput,
} from "@research/ui-registry";
import {
	addedItemRefreshScope,
	autoRefreshScope,
	followUpRefreshScope,
	type RefreshStamp,
} from "../lib/refreshScope.ts";
import type { homeModelMessages } from "./homeModel.messages.ts";

/** The words this view-model writes, in the current language (the caller passes `m()`). */
export type HomeModelText = MessagesOf<typeof homeModelMessages>;

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

/** Thirty minutes: a page (Home or a Notebook) whose oldest refresh is older queues a refresh. */
export const HOME_AUTO_REFRESH_STALE_MS = 30 * 60 * 1_000;

/**
 * Five minutes: how often an open, visible page (Home or a Notebook) takes
 * the staleness decision again (ADR-0044 §4); it is also taken whenever the
 * page becomes visible.
 */
export const MARKET_RECHECK_INTERVAL_MS = 5 * 60 * 1_000;

/** The line chart's ranges; their names are `marketRangeMessages` (`widgets/marketRange.messages.ts`). */
export const HOME_RANGES: readonly MarketRange[] = ["1m", "3m", "6m", "1y", "3y", "max"];

export function seriesById(series: readonly MarketSeries[]): ReadonlyMap<string, MarketSeries> {
	return new Map(series.map((entry) => [entry.seriesId, entry]));
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

export const DIRECTION_MARK: { readonly [D in ChangeDirection]: string } = {
	up: "▲",
	down: "▼",
	unchanged: "▬",
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
export function formatChange(
	change: MarketChange,
	unit: string,
	text: HomeModelText,
): FormattedChange {
	const direction = changeDirection(change.absoluteChange);
	const mark = DIRECTION_MARK[direction];
	const word = text[direction];
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
export function staleFailureReason(series: MarketSeries, text: HomeModelText): string | null {
	if (series.unavailable === null || series.observations.length === 0) return null;
	return storedReason(series, series.unavailable, text);
}

/**
 * The reason a series (or a missing one) has no values: its stored
 * unavailable reason, else the fixed "no data" wording.
 */
export function seriesMissingReason(series: MarketSeries | null, text: HomeModelText): string {
	if (series === null || series.unavailable === null) return unavailableText("NO_DATA", text);
	return storedReason(series, series.unavailable, text);
}

function storedReason(
	series: MarketSeries,
	unavailable: NonNullable<MarketSeries["unavailable"]>,
	text: HomeModelText,
): string {
	return text.withUpstreamStatus(
		text.storedUnavailableReason(unavailable.reason, unavailable.code, series.provider),
		unavailable.upstreamStatus,
	);
}

export function changeErrorText(error: ChangeError | YearChangeError, text: HomeModelText): string {
	switch (error) {
		case "NOT_ENOUGH_OBSERVATIONS":
		case "NO_BASE_OBSERVATION":
			return text.needsMoreHistory;
		case "BASE_TOO_OLD":
			return text.noYearAgoObservation;
		case "NON_FINITE":
			return text.notANumber;
	}
}

/** Fixed unavailable wording per code (provider text is never shown); exported for tests. */
export function unavailableText(
	code: MarketUnavailableCode,
	text: HomeModelText,
	provider?: MarketProviderId,
): string {
	return text.unavailableReason(code, provider);
}

/**
 * The market refresh Home queues automatically on this visit, or null: the
 * shared oldest-stamp rule (`lib/refreshScope.ts`, ADR-0039) over the
 * dashboard series' `lastRefreshedAt` with the 30-minute limit. V3: an empty
 * series list never needs a refresh (a bare dashboard queues nothing, and the
 * decision is only taken once both dashboard and data have loaded and no
 * refresh is active — see HomeView).
 */
export function marketAutoRefreshScope(
	lastRefreshedAts: readonly (string | null)[],
	nowMs: number,
): RefreshScope | null {
	return autoRefreshScope(lastRefreshedAts, HOME_AUTO_REFRESH_STALE_MS, nowMs);
}

/** The refresh after a widget was added or edited without data (ADR-0039). */
export function marketAddedRefreshScope(
	lastRefreshedAts: readonly (string | null)[],
	nowMs: number,
): RefreshScope {
	return addedItemRefreshScope(lastRefreshedAts, HOME_AUTO_REFRESH_STALE_MS, nowMs);
}

/**
 * The Notebook's automatic refresh (ADR-0044 §4): Home's staleness rule
 * (`autoRefreshScope`, 30 minutes) over the Notebook's own series, with one
 * difference kept from ADR-0039 — a Notebook whose series all lack data
 * asks only for them (`"unrefreshed"`), where Home asks for everything: the
 * Notebook sees only its own series, and asking for everything would also
 * fetch every Home series (a first-ever refresh that covers everything is
 * stored as one by the claim anyway). A stale series still asks for
 * everything, so a narrow job is not followed by Home's full one.
 */
export function notebookAutoRefreshScope(
	lastRefreshedAts: readonly (string | null)[],
	nowMs: number,
): RefreshScope | null {
	const scope = autoRefreshScope(lastRefreshedAts, HOME_AUTO_REFRESH_STALE_MS, nowMs);
	return scope === "all" && lastRefreshedAts.every((at) => at === null) ? "unrefreshed" : scope;
}

/**
 * The stamps a page's staleness rules judge: each page series the providers
 * refresh, with its `lastRefreshedAt` (null for a series the data does not
 * name yet), in page order. Imported material series (`materials:`,
 * ADR-0042) are left out: the database is their only source and no refresh
 * ever stamps them, so their import time would read as stale forever and
 * ask the providers again on every check.
 */
export function marketRefreshStamps(
	seriesIds: readonly string[],
	byId: ReadonlyMap<string, MarketSeries>,
): RefreshStamp[] {
	const stamps: RefreshStamp[] = [];
	for (const id of seriesIds) {
		if (id.startsWith(MATERIALS_PREFIX)) continue;
		stamps.push({ id, lastRefreshedAt: byId.get(id)?.lastRefreshedAt ?? null });
	}
	return stamps;
}

const MATERIALS_PREFIX = "materials:";

/**
 * The one follow-up after a run ended (V4): only while a dashboard series is
 * still never refreshed, with the scope the auto-refresh rule chooses.
 */
export function marketFollowUpScope(
	lastRefreshedAts: readonly (string | null)[],
	nowMs: number,
): RefreshScope | null {
	return followUpRefreshScope(lastRefreshedAts, HOME_AUTO_REFRESH_STALE_MS, nowMs);
}

/** The range an Indicator table row's Trend covers and its chart viewer opens at. */
export type IndicatorTrendPreset = Extract<ChartPreset, "1y" | "5y" | "max">;

/**
 * The Trend range of an Indicator table row (ADR-0044 §1), by the series'
 * native frequency, so a monthly indicator never opens on twelve points:
 * daily and weekly series cover one year, monthly five, and quarterly,
 * annual and unknown ones the whole held history. The row's chart viewer
 * opens at the same preset.
 */
export function indicatorTrendPreset(frequency: MarketFrequency): IndicatorTrendPreset {
	switch (frequency) {
		case "daily":
		case "weekly":
			return "1y";
		case "monthly":
			return "5y";
		case "quarterly":
		case "annual":
		case "unknown":
			return "max";
	}
}

/**
 * The points the chart viewer shows when it opens at `preset` on these
 * points alone: the viewer's own `presetWindow` over the held extent (first
 * to last observation), so a Trend sparkline and the viewer it opens cover
 * the same dates. `points` are ascending (the repository's order); the
 * window's first index is found by binary search, so a row costs one slice,
 * not a scan with a date parse per point. Dates that do not parse (never
 * the case for contract-checked data) leave the points as they are.
 */
export function presetPoints(
	points: readonly MarketPoint[],
	preset: ChartPreset,
): readonly MarketPoint[] {
	const first = points[0];
	const last = points.at(-1);
	if (first === undefined || last === undefined || preset === "max") return points;
	const firstDay = isoToDayNumber(first.observedOn);
	const lastDay = isoToDayNumber(last.observedOn);
	if (!firstDay.ok || !lastDay.ok) return points;
	const window = presetWindow(preset, firstDay.value, lastDay.value);
	if (!window.ok) return points;
	const from = dayNumberToIso(window.value.from);
	if (!from.ok) return points;
	// ISO calendar dates order as strings: the first point on or after `from`.
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		const point = points[middle];
		if (point !== undefined && point.observedOn < from.value) low = middle + 1;
		else high = middle;
	}
	return low === 0 ? points : points.slice(low);
}

/** True when any series on the dashboard comes from FRED (attribution line). */
export function hasFredSeries(seriesIds: readonly string[]): boolean {
	return seriesIds.some((id) => id.startsWith("fred:"));
}

export type { HomeLineModel, HomeLinePath, HomeLineSeriesInput };
export { buildHomeLineModel, buildSparkline };
