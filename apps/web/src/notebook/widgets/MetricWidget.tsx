import type { WidgetCore } from "@research/contracts";
import type { JSX } from "solid-js";
import { createMemo, Show } from "solid-js";

type Metric = Extract<WidgetCore, { readonly type: "metric" }>;

const DIRECTION_MARK = { up: "▲", down: "▼", unchanged: "▬" } as const;
const DIRECTION_WORD = { up: "up", down: "down", unchanged: "unchanged" } as const;

type Direction = keyof typeof DIRECTION_MARK;

function directionOf(change: number): Direction {
	if (change > 0) return "up";
	if (change < 0) return "down";
	return "unchanged";
}

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });
const signedFormat = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 4,
	signDisplay: "exceptZero",
});

/** One headline number with unit, change, caption and as-of date. */
export function MetricWidget(props: { readonly widget: Metric }): JSX.Element {
	const value = createMemo((): { readonly display: number } | null => {
		const current = props.widget.value;
		return current === null ? null : { display: current };
	});
	const change = createMemo(
		(): { readonly display: number; readonly direction: Direction } | null => {
			const current = props.widget.change;
			return current === null ? null : { display: current, direction: directionOf(current) };
		},
	);
	const unit = () => props.widget.unit;
	const caption = () => props.widget.caption;
	const asOf = (): { readonly date: string } | null => {
		const current = props.widget.asOf;
		return current === null ? null : { date: current };
	};
	return (
		<div data-widget-body="metric" class="space-y-1">
			<Show
				when={value()}
				fallback={<p class="text-sm italic text-slate-600">unavailable (no value recorded)</p>}
			>
				{(entry) => (
					<p class="text-sm text-slate-900">
						<span class="text-lg font-semibold tabular-nums">
							{numberFormat.format(entry().display)}
						</span>
						<Show when={unit().trim().length > 0}>
							<span class="ml-1 text-xs text-slate-600">{unit()}</span>
						</Show>
					</p>
				)}
			</Show>
			<Show when={change()}>
				{(entry) => (
					<p class="text-xs text-slate-700">
						<span aria-hidden="true">{DIRECTION_MARK[entry().direction]}</span>{" "}
						<span class="tabular-nums">{signedFormat.format(entry().display)}</span>
						<Show when={unit().trim().length > 0}>
							<span> {unit()}</span>
						</Show>{" "}
						<span>({DIRECTION_WORD[entry().direction]})</span>
					</p>
				)}
			</Show>
			<Show when={caption().trim().length > 0}>
				<p class="text-xs text-slate-600">{caption()}</p>
			</Show>
			<p class="text-2xs text-slate-600">
				<Show when={asOf()} fallback={<span class="italic">as-of date not stated</span>}>
					{(date) => (
						<span>
							as of <time dateTime={date().date}>{date().date}</time>
						</span>
					)}
				</Show>
			</p>
		</div>
	);
}
