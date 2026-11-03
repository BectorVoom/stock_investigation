import type { MarketPoint } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import { createMemo, type JSX, Show } from "solid-js";
import { chartViewerMessages } from "../../chartViewer/chartViewer.messages.tsx";
import { buildSparkline, TREND_PRESET } from "../homeModel.ts";
import { marketWidgetMessages } from "./marketWidgets.messages.ts";
import { Sparkline } from "./Sparkline.tsx";

/**
 * A series' trend as the market widgets show it (the Indicator table's Trend
 * column, the Metric widget under its change lines): the sparkline over the
 * points of the last year (`TREND_PRESET`, `presetPoints`; the caller passes
 * them). The Metric widget names the year beside the line in the chart
 * viewer's preset wording ("1Y", 「1年」); the table names it once in its
 * column header instead. The line and the name are `aria-hidden`; a screen
 * reader hears the direction over the year ("up over 1 year"), or that the
 * year holds too few observations for a line. Phrasing content only, so it
 * may sit inside a chart opener button.
 */
export function TrendLine(props: {
	readonly points: readonly MarketPoint[];
	/** Show the range's name beside the line (where no header names it). */
	readonly showRange: boolean;
	/** Sparkline box in CSS px; the inset keeps the 2 px stroke off the top and bottom edges. */
	readonly width: number;
	readonly height: number;
	readonly inset: number;
	/** Layout classes for the wrapping span. */
	readonly class?: string;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const viewerText = useMessages(chartViewerMessages);
	const line = createMemo(() =>
		buildSparkline(props.points, props.width, props.height, props.inset),
	);
	const spoken = () => {
		const current = line();
		return current === null ? m().trendTooShort : m().trendDirection(current.direction);
	};
	return (
		<span
			class={`flex items-center gap-2 whitespace-nowrap ${props.class ?? ""}`}
			data-field="trend-line"
		>
			<Sparkline line={line()} width={props.width} height={props.height} class="block shrink-0" />
			<Show when={props.showRange}>
				<span aria-hidden="true" class="text-2xs text-slate-600">
					{viewerText().preset(TREND_PRESET)}
				</span>
			</Show>
			<span class="sr-only">{spoken()}</span>
		</span>
	);
}
