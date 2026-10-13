import type { HomeWidget, MarketSeries } from "@research/contracts";
import { SafeLink } from "@research/ui-registry";
import { type Accessor, createMemo, For, type JSX, Match, Show, Switch } from "solid-js";
import {
	changeErrorText,
	formatAbsDelta,
	formatPctValue,
	formatValue,
	staleFailureReason,
	summarizeSeries,
	unavailableText,
} from "../homeModel.ts";
import { TwelveDataSessionNote, WidgetProvenance } from "../WidgetFrame.tsx";

/**
 * One row per series (price table): Series · Last close · Change ·
 * Change % · As of · Source. The row header is the series name, with the
 * symbol in monospace as secondary text. Every cell carries a value or an
 * explicit "unavailable (reason)" — never blank, never 0. A series whose
 * last refresh failed still shows its stored values with an amber
 * "last refresh failed (reason)" note row beneath it.
 */
export function StockTableWidget(props: {
	readonly widget: Extract<HomeWidget, { readonly type: "stock-table" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	return (
		<>
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">
						{props.widget.title}: last close per series
					</caption>
					<thead>
						<tr class="whitespace-nowrap border-b border-slate-200 text-xs text-slate-700">
							<th scope="col" class="py-1 pr-3 font-semibold">
								Series
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								Last close
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								Change
							</th>
							<th scope="col" class="py-1 pr-3 text-right font-semibold">
								Change %
							</th>
							<th scope="col" class="py-1 pr-3 font-semibold">
								As of
							</th>
							<th scope="col" class="py-1 font-semibold">
								Source
							</th>
						</tr>
					</thead>
					<tbody>
						<For each={props.widget.seriesIds}>
							{(seriesId) => <StockRow series={props.seriesById().get(seriesId) ?? null} />}
						</For>
					</tbody>
				</table>
			</div>
			<TwelveDataSessionNote seriesIds={props.widget.seriesIds} byId={props.seriesById} />
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</>
	);
}

function StockRow(props: { readonly series: MarketSeries | null }): JSX.Element {
	const summary = createMemo(() => (props.series === null ? null : summarizeSeries(props.series)));
	const ready = createMemo(() => {
		const entry = props.series;
		const current = summary();
		return entry !== null &&
			current !== null &&
			current.latest !== null &&
			entry.observations.length > 0
			? { entry, summary: current, latest: current.latest }
			: null;
	});
	const missingReason = () => props.series?.unavailable?.reason ?? unavailableText("NO_DATA");
	const stale = () => (props.series === null ? null : staleFailureReason(props.series));
	return (
		<Show
			when={props.series}
			fallback={
				<tr class="border-b border-slate-200">
					<td colspan="6" class="py-1 text-sm text-amber-900">
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
								<td colspan="4" class="py-1 pr-3 text-sm text-amber-900">
									unavailable ({missingReason()})
								</td>
							}
						>
							{(good) => (
								<>
									<td class="py-1 pr-3 text-right tabular-nums">
										{formatValue(good().latest.value)}{" "}
										<span class="text-xs text-slate-600">{good().entry.unit}</span>
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<ChangeCell
											change={good().summary.change}
											unit={good().entry.unit}
											kind="abs"
										/>
									</td>
									<td class="py-1 pr-3 text-right tabular-nums">
										<ChangeCell
											change={good().summary.change}
											unit={good().entry.unit}
											kind="pct"
										/>
									</td>
									<td class="py-1 pr-3 text-xs">
										<time dateTime={good().latest.observedOn}>{good().latest.observedOn}</time>
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
								<td colspan="6" class="py-1 text-xs text-amber-900">
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

export function ChangeCell(props: {
	readonly change: ReturnType<typeof summarizeSeries>["change"] | null;
	readonly unit: string;
	readonly kind: "abs" | "pct";
}): JSX.Element {
	/**
	 * One memo over the live props: a value to show, "not applicable" (a
	 * percent of a percent), or the reason the cell is unavailable.
	 */
	const display = createMemo((): ChangeCellDisplay => {
		const change = props.change;
		if (change === null) return { kind: "unavailable", reason: unavailableText("NO_DATA") };
		if (!change.ok) return { kind: "unavailable", reason: changeErrorText(change.error) };
		if (props.kind === "abs") {
			// The delta follows the series' latest value magnitude (the one rule in homeModel.ts).
			return {
				kind: "value",
				text: formatAbsDelta(change.value.absoluteChange, props.unit, change.value.latest.value),
			};
		}
		const pct = formatPctValue(change.value.percentChange, props.unit);
		return pct === null ? { kind: "not-applicable" } : { kind: "value", text: pct };
	});
	const valueText = () => {
		const current = display();
		return current.kind === "value" ? current.text : null;
	};
	const hasValue = () => display().kind === "value";
	const notApplicable = () => display().kind === "not-applicable";
	const unavailableReason = () => {
		const current = display();
		return current.kind === "unavailable" ? current.reason : unavailableText("NO_DATA");
	};
	return (
		// Branches on the display kind, never on the text: a value like "0"
		// must render (D1 audit).
		<Switch fallback={<span class="italic">unavailable ({unavailableReason()})</span>}>
			<Match when={hasValue()}>{valueText()}</Match>
			<Match when={notApplicable()}>
				<span class="italic">not applicable</span>
			</Match>
		</Switch>
	);
}

type ChangeCellDisplay =
	| { readonly kind: "value"; readonly text: string }
	| { readonly kind: "not-applicable" }
	| { readonly kind: "unavailable"; readonly reason: string };
