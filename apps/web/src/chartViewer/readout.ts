import type { MessagesOf } from "@research/i18n";
import type { DetailChartModel } from "@research/ui-registry";
import {
	type ChangeDirection,
	changeDirection,
	DIRECTION_MARK,
	formatPctValue,
	formatSignedDelta,
	formatValue,
} from "../home/homeModel.ts";
import type { chartReadoutMessages } from "./chartViewer.messages.tsx";

/**
 * Readout line above the main chart: the date, each series' raw value with
 * its unit, and the change against the previous bar computed from raw closes.
 * In percent mode the rebased display value rides along ("rebased +2.66%"),
 * so a rebased number is never shown with the series' original unit. Pure
 * over the render model so the keyboard handler can announce the same text
 * the pointer readout shows. Status is never colour alone: every change
 * carries ▲/▼/▬ plus a word. The words come from `chartReadoutMessages`
 * in the current language (`text`); labels, values and dates stay as they are.
 * The parts form keeps each change apart so the line can colour it by
 * direction; `readoutPartsText` joins them into the exact announced text.
 * When the single series has bars (`withBars`, ADR-0056 §7) the series part
 * gives open, high, low and close, then the volume and the bar's own
 * direction (close against open) in words.
 */

export type ChartReadoutText = MessagesOf<typeof chartReadoutMessages>;

/** One series in the readout: `lead`, then the change (if any), then `trail`. */
export interface ReadoutSeriesPart {
	readonly lead: string;
	readonly change: { readonly text: string; readonly direction: ChangeDirection } | null;
	readonly trail: string;
}

export interface ReadoutParts {
	readonly date: string;
	readonly series: readonly ReadoutSeriesPart[];
}

export const READOUT_DATE_SEPARATOR = " — ";
export const READOUT_SERIES_SEPARATOR = " · ";

function plain(lead: string): ReadoutSeriesPart {
	return { lead, change: null, trail: "" };
}

/** The readout as one string: what the live region announces and the line shows. */
export function readoutPartsText(parts: ReadoutParts): string {
	const series = parts.series
		.map((part) => `${part.lead}${part.change?.text ?? ""}${part.trail}`)
		.join(READOUT_SERIES_SEPARATOR);
	return `${parts.date}${READOUT_DATE_SEPARATOR}${series}`;
}

/** Readout text for the union-day bar at `index` (`units` aligns with the model series). */
export function buildReadoutText(
	model: DetailChartModel,
	index: number,
	units: readonly string[],
	text: ChartReadoutText,
	withBars = false,
): string {
	return readoutPartsText(buildReadoutParts(model, index, units, text, withBars));
}

/** The bar's prices, volume and direction words at `index`, or null when the series shows no bars. */
function barWords(
	model: DetailChartModel,
	key: string,
	index: number,
	close: number,
	text: ChartReadoutText,
): { readonly prices: string; readonly tail: string } | null {
	const bars = model.barValues;
	if (bars === null || bars.key !== key) return null;
	const open = bars.open[index] ?? null;
	const high = bars.high[index] ?? null;
	const low = bars.low[index] ?? null;
	if (open === null || high === null || low === null) return null;
	const volume = bars.volume[index] ?? null;
	const volumeText =
		volume === null ? text.volumeNotReported : text.volume(text.compactVolume(volume));
	return {
		prices: text.barPrices(
			formatValue(open),
			formatValue(high),
			formatValue(low),
			formatValue(close),
		),
		tail: ` · ${volumeText} · ${text.barDirection(changeDirection(close - open))}`,
	};
}

/** Readout parts for the union-day bar at `index` (`units` aligns with the model series). */
export function buildReadoutParts(
	model: DetailChartModel,
	index: number,
	units: readonly string[],
	text: ChartReadoutText,
	withBars = false,
): ReadoutParts {
	const iso = model.isoAt[index] ?? text.dateNotStated;
	const labels = new Map(model.seriesPaths.map((entry) => [entry.key, entry.label] as const));
	const rawByKey = new Map(model.rawValues.map((entry) => [entry.key, entry.values] as const));
	const percentMode = model.mode === "percent";
	const parts = model.seriesValues.map((entry, slot) => {
		const label = labels.get(entry.key) ?? entry.key;
		const unit = units[slot] ?? "";
		const suffix = unit === "" ? "" : ` ${unit}`;
		const rawSeries = rawByKey.get(entry.key) ?? entry.values;
		const raw = rawSeries[index] ?? null;
		if (raw === null || !Number.isFinite(raw)) return plain(text.seriesUnavailable(label));
		const bar = withBars ? barWords(model, entry.key, index, raw, text) : null;
		const valueText = bar === null ? formatValue(raw) : bar.prices;
		const barTail = bar === null ? "" : bar.tail;
		let previous: number | null = null;
		for (let back = index - 1; back >= 0; back -= 1) {
			const candidate = rawSeries[back] ?? null;
			if (candidate !== null && Number.isFinite(candidate)) {
				previous = candidate;
				break;
			}
		}
		// In percent mode the display value is the rebase off the visible
		// base (0 % at the first bar); a null means a zero base, stated below.
		const rebased = percentMode ? (entry.values[index] ?? null) : null;
		const rebasedText =
			!percentMode || (rebased !== null && Number.isFinite(rebased))
				? text.rebased(formatSignedDelta(rebased ?? 0, rebased ?? 0))
				: text.rebasedUnavailable;
		if (previous === null)
			return plain(
				percentMode
					? `${label}: ${valueText}${suffix}${barTail}; ${rebasedText}`
					: `${label}: ${valueText}${suffix}${barTail}`,
			);
		const change = raw - previous;
		const direction = changeDirection(change);
		const percent =
			previous === 0 ? null : formatPctValue((change / Math.abs(previous)) * 100, unit);
		const tail = percent === null ? "" : ` (${percent})`;
		return {
			lead: `${label}: ${valueText}${suffix} (`,
			change: {
				text: `${DIRECTION_MARK[direction]} ${text.direction(direction)} ${formatSignedDelta(change, raw)}${tail}`,
				direction,
			},
			trail: percentMode ? `)${barTail}; ${rebasedText}` : `)${barTail}`,
		};
	});
	return { date: iso, series: parts };
}
