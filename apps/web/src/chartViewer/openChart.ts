import type { MarketRange } from "@research/contracts";
import type { ChartPreset } from "@research/domain";

/**
 * The chart viewer's opening preset for a widget's stored range (ADR-0025
 * "Where it opens"): the widget ranges and the viewer presets share the
 * same names, so the mapping is the identity over the widget's six ranges.
 * Kept in one place so the three entry points (line chart, metric, stock
 * table) cannot drift apart.
 */
export function initialPresetForRange(range: MarketRange): ChartPreset {
	switch (range) {
		case "1m":
			return "1m";
		case "3m":
			return "3m";
		case "6m":
			return "6m";
		case "1y":
			return "1y";
		case "3y":
			return "3y";
		case "max":
			return "max";
	}
}

/**
 * The viewer opener: a native button that looks like the plot it wraps (no
 * button chrome — the global `:focus-visible` ring stays, so keyboard focus
 * is still visible). No colour utilities and no presentation attributes, per
 * the guideline conformance test and the app's Content-Security-Policy.
 */
export const OPEN_CHART_BUTTON_CLASS = "block w-full cursor-pointer rounded border-0 p-0 text-left";

/**
 * A press on an opener that travels this far (px) before its release is a
 * text selection or a stray drag, not a tap: the release click is ignored
 * (the same 4 px threshold the main chart uses between a click and a drag).
 */
export const OPEN_PRESS_SLOP_PX = 4;
