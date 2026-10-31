import { CHART_INK, type Sparkline as SparklineModel } from "@research/ui-registry";
import { type JSX, Show } from "solid-js";
import { CHANGE_TONES } from "../../components/ui.tsx";

/**
 * The one sparkline Home's widgets draw (the Metric widget's line, the
 * Indicator table's Trend column): decorative (`aria-hidden` — the same
 * numbers are in the text), drawn as Apple Stocks draws it, green when the
 * points end above where they started, red when below, with a dotted line
 * at the starting value. `line` is `buildSparkline` over the caller's
 * points in this same box (the caller keeps it, since it also needs the
 * direction for its text); null for fewer than two points, and then nothing
 * is drawn — the caller says what the cell shows instead.
 */
export function Sparkline(props: {
	readonly line: SparklineModel | null;
	/** Box in CSS px, the one `line` was built for. */
	readonly width: number;
	readonly height: number;
	/** Layout classes for the `<svg>` (the tone class is added here). */
	readonly class?: string;
}): JSX.Element {
	return (
		<Show when={props.line}>
			{(spark) => (
				<svg
					aria-hidden="true"
					width={props.width}
					height={props.height}
					viewBox={`0 0 ${props.width} ${props.height}`}
					class={`${props.class ?? ""} ${CHANGE_TONES[spark().direction]}`}
					data-sparkline-direction={spark().direction}
				>
					<line
						x1="0"
						x2={props.width}
						y1={spark().startY}
						y2={spark().startY}
						stroke={CHART_INK.axis}
						stroke-width="1"
						stroke-dasharray="1 3"
						stroke-linecap="round"
					/>
					<path
						d={spark().d}
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linejoin="round"
						stroke-linecap="round"
					/>
				</svg>
			)}
		</Show>
	);
}
