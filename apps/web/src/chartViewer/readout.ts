import type { DetailChartModel } from "@research/ui-registry";
import { formatPctValue, formatSignedDelta, formatValue } from "../home/homeModel.ts";

/**
 * Readout line above the main chart: the date, each series' raw value with
 * its unit, and the change against the previous bar computed from raw closes.
 * In percent mode the rebased display value rides along ("rebased +2.66%"),
 * so a rebased number is never shown with the series' original unit. Pure
 * over the render model so the keyboard handler can announce the same text
 * the pointer readout shows. Status is never colour alone: every change
 * carries ▲/▼/▬ plus a word.
 */

const MARK = { up: "▲", down: "▼", unchanged: "▬" } as const;
const WORD = { up: "up", down: "down", unchanged: "unchanged" } as const;

type Direction = keyof typeof MARK;

function directionOf(change: number): Direction {
	if (change > 0) return "up";
	if (change < 0) return "down";
	return "unchanged";
}

export const READOUT_HINT =
	"Point at the chart to read values; the data table below lists every value.";

/** Readout for the union-day bar at `index` (`units` aligns with the model series). */
export function buildReadoutText(
	model: DetailChartModel,
	index: number,
	units: readonly string[],
): string {
	const iso = model.isoAt[index] ?? "date not stated";
	const labels = new Map(model.seriesPaths.map((entry) => [entry.key, entry.label] as const));
	const rawByKey = new Map(model.rawValues.map((entry) => [entry.key, entry.values] as const));
	const percentMode = model.mode === "percent";
	const parts = model.seriesValues.map((entry, slot) => {
		const label = labels.get(entry.key) ?? entry.key;
		const unit = units[slot] ?? "";
		const suffix = unit === "" ? "" : ` ${unit}`;
		const rawSeries = rawByKey.get(entry.key) ?? entry.values;
		const raw = rawSeries[index] ?? null;
		if (raw === null || !Number.isFinite(raw)) return `${label}: unavailable`;
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
				? `rebased ${formatSignedDelta(rebased ?? 0, rebased ?? 0)}%`
				: "rebased unavailable (zero base)";
		if (previous === null)
			return percentMode
				? `${label}: ${formatValue(raw)}${suffix}; ${rebasedText}`
				: `${label}: ${formatValue(raw)}${suffix}`;
		const change = raw - previous;
		const direction = directionOf(change);
		const percent =
			previous === 0 ? null : formatPctValue((change / Math.abs(previous)) * 100, unit);
		const tail = percent === null ? "" : ` (${percent})`;
		const head =
			`${label}: ${formatValue(raw)}${suffix} ` +
			`(${MARK[direction]} ${WORD[direction]} ${formatSignedDelta(change, raw)}${tail})`;
		return percentMode ? `${head}; ${rebasedText}` : head;
	});
	return `${iso} — ${parts.join(" · ")}`;
}
