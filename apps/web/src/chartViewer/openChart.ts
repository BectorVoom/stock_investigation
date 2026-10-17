import type { MarketRange } from "@research/contracts";
import type { ChartPreset } from "@research/domain";
import { WIDGET_BODY_CLASS } from "@research/widget-grid";

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
export const OPEN_CHART_BUTTON_CLASS =
	"block min-h-6 w-full min-w-6 cursor-pointer rounded border-0 p-0 text-left pointer-coarse:min-h-11 pointer-coarse:min-w-11";

/**
 * A mouse press on an opener that travels this far (px) before its release
 * is a text selection, not a click: the release click is ignored (the same
 * 4 px threshold the main chart uses between a click and a drag). Touch and
 * pen presses are exempt — a tap drifts a few px; touch selects no text, a
 * pen may in some desktop browsers (accepted, ADR-0025).
 */
export const OPEN_PRESS_SLOP_PX = 4;

/**
 * Marks each opener with a key unique within its widget (the series id, or
 * "plot"), so focus can find the same opener again after a reload replaced
 * the button element while the viewer was open.
 */
export const CHART_OPENER_ATTRIBUTE = "data-chart-opener";

/** Where focus goes when the viewer closes, captured when it opens. */
export interface FocusReturn {
	/** The element that opened the viewer. */
	readonly opener: HTMLElement | null;
	/** The widget's focusable body around the opener, if any. */
	readonly scope: HTMLElement | null;
	/** The opener's `data-chart-opener` key, if any. */
	readonly key: string | null;
}

/** Captures the opener with its widget body and key (ADR-0025 focus return). */
export function captureFocusReturn(opener: HTMLElement | null): FocusReturn {
	if (opener === null) return { opener: null, scope: null, key: null };
	const scope = opener.closest(`.${WIDGET_BODY_CLASS}`);
	return {
		opener,
		scope: scope instanceof HTMLElement ? scope : null,
		key: opener.getAttribute(CHART_OPENER_ATTRIBUTE),
	};
}

/**
 * The element focus returns to on close: the opener while it is still in
 * the document; else (a reload re-rendered or removed it) the widget's
 * current opener with the same key; else the widget's focusable body. Null
 * only when the whole widget is gone.
 */
export function focusReturnTarget(saved: FocusReturn): HTMLElement | null {
	if (saved.opener?.isConnected === true) return saved.opener;
	const scope = saved.scope;
	if (scope === null || !scope.isConnected) return null;
	if (saved.key !== null) {
		for (const candidate of scope.querySelectorAll(`[${CHART_OPENER_ATTRIBUTE}]`)) {
			if (
				candidate instanceof HTMLElement &&
				candidate.getAttribute(CHART_OPENER_ATTRIBUTE) === saved.key
			) {
				return candidate;
			}
		}
	}
	return scope;
}
