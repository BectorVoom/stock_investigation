import type { MarketSeries, MarketWidgetCore } from "@research/contracts";
import { selectRange } from "@research/domain";
import { seriesColor } from "@research/ui-registry";
import { type Accessor, createMemo, type JSX, Show } from "solid-js";
import { TwelveDataSessionNote, WidgetProvenance } from "../HomeFrame.tsx";
import {
	changeErrorText,
	formatChange,
	formatValue,
	sparklinePath,
	staleFailureReason,
	summarizeSeries,
	toPoints,
	unavailableText,
} from "../homeModel.ts";

/**
 * One series: latest value with its unit, change vs the previous observation,
 * one-year change, and a sparkline of the last 3 months (`aria-hidden` —
 * the same numbers are in the text). The unit is shown once, next to the
 * value; change lines carry no unit ("▲ +0.33 (+2.19%)", "▲ +0.50 pp" for
 * percent-unit series). A series whose last refresh failed still shows its
 * stored values with an amber "last refresh failed (reason)" note; only a
 * series with no observations is "unavailable (reason)".
 */
export function MetricWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "market-metric" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const series = () => props.seriesById().get(props.widget.seriesId) ?? null;
	return (
		<>
			<Show
				when={series()}
				fallback={<p class="text-sm text-amber-900">unavailable ({unavailableText("NO_DATA")})</p>}
			>
				{(entry) => <MetricBody series={entry()} />}
			</Show>
			<TwelveDataSessionNote seriesIds={[props.widget.seriesId]} byId={props.seriesById} />
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</>
	);
}

function MetricBody(props: { readonly series: MarketSeries }): JSX.Element {
	const summary = createMemo(() => summarizeSeries(props.series));
	const sparkPoints = createMemo(() => selectRange(toPoints(props.series.observations), "3m"));
	const spark = createMemo(() => sparklinePath(sparkPoints(), 96, 28));
	const latest = () => summary().latest;
	const stale = () => staleFailureReason(props.series);
	const missingReason = () => props.series.unavailable?.reason ?? unavailableText("NO_DATA");
	return (
		<>
			<Show
				when={latest()}
				fallback={<p class="text-sm text-amber-900">unavailable ({missingReason()})</p>}
			>
				{(point) => (
					<div class="space-y-1">
						<p class="text-base font-semibold tabular-nums text-slate-900">
							{formatValue(point().value)}{" "}
							<span class="text-xs font-normal text-slate-600">{props.series.unit}</span>
						</p>
						<ChangeLine label="Change" change={summary().change} unit={props.series.unit} />
						<ChangeLine
							label="1-year change"
							change={summary().yearChange}
							unit={props.series.unit}
						/>
						<Show when={spark() !== ""}>
							<svg
								role="img"
								aria-hidden="true"
								width="96"
								height="28"
								viewBox="0 0 96 28"
								class="mt-1 block"
							>
								<path d={spark()} fill="none" stroke={seriesColor(0)} stroke-width="1.5" />
							</svg>
						</Show>
					</div>
				)}
			</Show>
			<Show when={stale()}>
				{(reason) => <p class="mt-1 text-xs text-amber-900">last refresh failed ({reason()})</p>}
			</Show>
		</>
	);
}

function ChangeLine(props: {
	readonly label: string;
	readonly change:
		| ReturnType<typeof summarizeSeries>["change"]
		| ReturnType<typeof summarizeSeries>["yearChange"];
	readonly unit: string;
}): JSX.Element {
	const formatted = createMemo(() =>
		props.change.ok ? formatChange(props.change.value, props.unit) : null,
	);
	const errorText = () =>
		props.change.ok ? null : `unavailable (${changeErrorText(props.change.error)})`;
	return (
		<p class="text-xs tabular-nums text-slate-700">
			{props.label}:{" "}
			<Show when={formatted()} fallback={<span class="italic">{errorText()}</span>}>
				{(line) => (
					<>
						{line().text} <span class="sr-only">({line().word})</span>
					</>
				)}
			</Show>
		</p>
	);
}
