import type { MarketSeries, MarketWidgetCore } from "@research/contracts";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, For, type JSX, Show } from "solid-js";
import { WidgetProvenance } from "../HomeFrame.tsx";
import {
	changeErrorText,
	formatChange,
	formatValue,
	staleFailureReason,
	summarizeSeries,
	unavailableText,
} from "../homeModel.ts";

/**
 * One row per series (economic indicators): Indicator · Latest · Unit ·
 * As of · Previous · Change · 1-year change · Source. The row header is the
 * series name, with the symbol in monospace as secondary text. Per-cell
 * "unavailable (reason)" — never blank, never 0. A series whose last refresh
 * failed still shows its stored values with an amber "last refresh failed
 * (reason)" note row beneath it.
 */
export function IndicatorTableWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "indicator-table" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	return (
		<>
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">
						{props.widget.title}: latest per indicator
					</caption>
					<thead>
						<tr class="whitespace-nowrap border-b border-slate-200 text-xs text-slate-700">
							<th scope="col" class="py-1 pr-3 font-semibold">
								Indicator
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								Latest
							</th>
							<th scope="col" class="py-1 pr-3 font-semibold">
								Unit
							</th>
							<th scope="col" class="py-1 pr-3 font-semibold">
								As of
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								Previous
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								Change
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								1-year change
							</th>
							<th scope="col" class="py-1 font-semibold">
								Source
							</th>
						</tr>
					</thead>
					<tbody>
						<For each={props.widget.seriesIds}>
							{(seriesId) => <IndicatorRow series={props.seriesById().get(seriesId) ?? null} />}
						</For>
					</tbody>
				</table>
			</div>
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</>
	);
}

function IndicatorRow(props: { readonly series: MarketSeries | null }): JSX.Element {
	const ready = createMemo(() => {
		const entry = props.series;
		if (entry === null) return null;
		const summary = summarizeSeries(entry);
		if (summary.latest === null || entry.observations.length === 0) return null;
		return { entry, summary, latest: summary.latest };
	});
	const missingReason = () => props.series?.unavailable?.reason ?? unavailableText("NO_DATA");
	const stale = () => (props.series === null ? null : staleFailureReason(props.series));
	return (
		<Show
			when={props.series}
			fallback={
				<tr class="border-b border-slate-200">
					<td colspan="8" class="py-1 text-sm text-amber-900">
						unavailable ({unavailableText("NO_DATA")})
					</td>
				</tr>
			}
		>
			{(entry) => (
				<>
					<tr class="border-b border-slate-200 align-top">
						<th scope="row" class="py-1 pr-3 font-medium">
							<span class="block">{entry().title}</span>{" "}
							<span class="block font-mono text-2xs font-normal text-slate-600">
								{entry().symbol}
							</span>
						</th>
						<Show
							when={ready()}
							fallback={
								<td colspan="6" class="py-1 pr-3 text-sm text-amber-900">
									unavailable ({missingReason()})
								</td>
							}
						>
							{(good) => (
								<>
									<td class="py-1 pr-3 text-right tabular-nums">
										{formatValue(good().latest.value)}
									</td>
									<td class="py-1 pr-3 text-xs text-slate-600">{good().entry.unit}</td>
									<td class="py-1 pr-3 text-xs">
										<time dateTime={good().latest.observedOn}>{good().latest.observedOn}</time>
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<PreviousCell change={good().summary.change} />
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<FullChangeCell change={good().summary.change} unit={good().entry.unit} />
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<FullChangeCell change={good().summary.yearChange} unit={good().entry.unit} />
									</td>
								</>
							)}
						</Show>
						<td class="whitespace-nowrap py-1 text-xs">
							<SafeLink url={entry().sourceUrl}>{entry().publisher}</SafeLink>
						</td>
					</tr>
					<Show when={stale()}>
						{(reason) => (
							<tr class="border-b border-slate-200">
								<td colspan="8" class="py-1 text-xs text-amber-900">
									last refresh failed ({reason()})
								</td>
							</tr>
						)}
					</Show>
				</>
			)}
		</Show>
	);
}

/**
 * The previous observation's value only: the row already has a Unit column,
 * so the unit is not repeated here.
 */
function PreviousCell(props: {
	readonly change: ReturnType<typeof summarizeSeries>["change"];
}): JSX.Element {
	// D1: branch on the Result's ok flag, never on the number — a previous
	// value of 0 is a real value, not an absence.
	const isOk = () => props.change.ok;
	const text = createMemo(() =>
		props.change.ok ? formatValue(props.change.value.previous.value) : null,
	);
	const problem = () => (props.change.ok ? null : changeErrorText(props.change.error));
	return (
		<Show when={isOk()} fallback={<span class="italic">unavailable ({problem()})</span>}>
			{text()}
		</Show>
	);
}

function FullChangeCell(props: {
	readonly change:
		| ReturnType<typeof summarizeSeries>["change"]
		| ReturnType<typeof summarizeSeries>["yearChange"];
	readonly unit: string;
}): JSX.Element {
	const formatted = createMemo(() =>
		props.change.ok ? formatChange(props.change.value, props.unit) : null,
	);
	const problem = () => (props.change.ok ? null : changeErrorText(props.change.error));
	return (
		<Show when={formatted()} fallback={<span class="italic">unavailable ({problem()})</span>}>
			{(line) => (
				<>
					{line().text} <span class="sr-only">({line().word})</span>
				</>
			)}
		</Show>
	);
}
