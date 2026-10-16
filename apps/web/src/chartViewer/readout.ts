import type { DetailChartModel } from "@research/ui-registry";
import { formatPctValue, formatSignedDelta, formatValue } from "../home/homeModel.ts";

/**
 * Readout line above the main chart: the date, each series' value with unit,
 * and the change against the previous bar. Pure over the render model so the
 * keyboard handler can announce the same text the pointer readout shows.
 * Status is never colour alone: every change carries ▲/▼/▬ plus a word.
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
	const parts = model.seriesValues.map((entry, slot) => {
		const label = labels.get(entry.key) ?? entry.key;
		const unit = units[slot] ?? "";
		const suffix = unit === "" ? "" : ` ${unit}`;
		const value = entry.values[index] ?? null;
		if (value === null || !Number.isFinite(value)) return `${label}: unavailable`;
		let previous: number | null = null;
		for (let back = index - 1; back >= 0; back -= 1) {
			const candidate = entry.values[back] ?? null;
			if (candidate !== null && Number.isFinite(candidate)) {
				previous = candidate;
				break;
			}
		}
		if (previous === null) return `${label}: ${formatValue(value)}${suffix}`;
		const change = value - previous;
		const direction = directionOf(change);
		const percent =
			previous === 0 ? null : formatPctValue((change / Math.abs(previous)) * 100, unit);
		const tail = percent === null ? "" : ` (${percent})`;
		return (
			`${label}: ${formatValue(value)}${suffix} ` +
			`(${MARK[direction]} ${WORD[direction]} ${formatSignedDelta(change, value)}${tail})`
		);
	});
	return `${iso} — ${parts.join(" · ")}`;
}
