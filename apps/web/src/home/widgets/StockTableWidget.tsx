import type { MarketSeries, MarketWidgetCore } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { SafeLink } from "@research/ui-registry";
import {
	type Accessor,
	createMemo,
	createSignal,
	For,
	type JSX,
	Match,
	Show,
	Switch,
} from "solid-js";
import { ChartOpener } from "../../chartViewer/ChartOpener.tsx";
import { LazyChartViewer } from "../../chartViewer/LazyChartViewer.tsx";
import { CHANGE_TONES } from "../../components/ui.tsx";
import { commonMessages } from "../../i18n/common.messages.ts";
import { TwelveDataSessionNote, WidgetProvenance } from "../HomeFrame.tsx";
import { homeModelMessages } from "../homeModel.messages.ts";
import {
	type ChangeDirection,
	changeDirection,
	changeErrorText,
	formatAbsDelta,
	formatPctValue,
	formatValue,
	seriesMissingReason,
	staleFailureReason,
	summarizeSeries,
	unavailableText,
} from "../homeModel.ts";
import { marketWidgetMessages } from "./marketWidgets.messages.ts";

/**
 * One row per series (price table): Series · Last close · Change ·
 * Change % · As of · Source. The row header is the series name, with the
 * symbol in monospace as secondary text. Each name cell with observations is
 * a native button named "Open chart: " plus the visible name and symbol (so
 * the row header keeps both) that opens the detailed chart viewer (ADR-0025,
 * lazy chunk) for that row's series at the 1y preset; a series without
 * observations has no button. Every cell carries a value or an
 * explicit "unavailable (reason)" — never blank, never 0. A series whose
 * last refresh failed still shows its stored values with an amber
 * "last refresh failed (reason)" note row beneath it. The viewer mounts only
 * while open, after the table (a dialog inside `<tbody>` would break the
 * table), stays open until closed (a reload that drops the row's
 * observations shows its "unavailable" state), and nothing it does is saved.
 */
export function StockTableWidget(props: {
	readonly widget: Extract<MarketWidgetCore, { readonly type: "stock-table" }>;
	readonly seriesById: Accessor<ReadonlyMap<string, MarketSeries>>;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const viewer = createSeriesViewer(props.seriesById);
	return (
		<>
			<div class="overflow-x-auto">
				<table class="w-full border-collapse text-left text-sm">
					<caption class="caption-top pb-1 text-left text-xs text-slate-600">
						{m().stockCaption(props.widget.title)}
					</caption>
					<PriceTableHead columns={STOCK_TABLE_COLUMNS} />
					<tbody>
						<For each={props.widget.seriesIds}>
							{(seriesId) => (
								<PriceRow
									series={props.seriesById().get(seriesId) ?? null}
									columns={STOCK_TABLE_COLUMNS}
									onOpen={(button) => viewer.open(seriesId, button)}
								/>
							)}
						</For>
					</tbody>
				</table>
			</div>
			<viewer.View />
			<TwelveDataSessionNote seriesIds={props.widget.seriesIds} byId={props.seriesById} />
			<WidgetProvenance widget={props.widget} byId={props.seriesById} />
		</>
	);
}

/**
 * The columns a price table shows after its row header (the series or
 * stock): each is the extra class of its cells, or null when the table
 * leaves it out. A class such as `hidden @md:table-cell` hides a column in
 * a narrow container (the Watchlist prices widget, ADR-0040 §5); the Stock
 * table shows every column.
 */
export interface PriceColumns {
	readonly lastClose: string | null;
	readonly change: string | null;
	readonly changePercent: string | null;
	readonly asOf: string | null;
	readonly source: string | null;
}

const STOCK_TABLE_COLUMNS: PriceColumns = {
	lastClose: "",
	change: "",
	changePercent: "",
	asOf: "",
	source: "",
};

/** How many columns the value cells span (everything after the row header but the source). */
function valueColumnCount(columns: PriceColumns): number {
	return [columns.lastClose, columns.change, columns.changePercent, columns.asOf].filter(
		(cell) => cell !== null,
	).length;
}

/** The header row of a price table: the row-header column, then the shown value columns. */
export function PriceTableHead(props: {
	readonly columns: PriceColumns;
	/** The row-header column's name ("Series" for the Stock table). */
	readonly first?: string;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const head = (extra: string | null, align: "left" | "right", label: string): JSX.Element => (
		<Show when={extra !== null}>
			<th
				scope="col"
				class={`py-1 pr-3 font-semibold ${align === "right" ? "text-right" : ""} ${extra ?? ""}`}
			>
				{label}
			</th>
		</Show>
	);
	return (
		<thead>
			<tr class="whitespace-nowrap border-b border-slate-200 text-xs text-slate-700">
				<th scope="col" class="py-1 pr-3 font-semibold">
					{props.first ?? m().series}
				</th>
				{head(props.columns.lastClose, "right", m().lastClose)}
				{head(props.columns.change, "right", m().change)}
				{head(props.columns.changePercent, "right", m().changePercent)}
				{head(props.columns.asOf, "left", m().asOf)}
				{head(props.columns.source, "left", m().source)}
			</tr>
		</thead>
	);
}

/**
 * The detailed chart viewer one price table opens from its rows (ADR-0025,
 * lazy chunk): `open` takes the row's series and its button, `View` mounts
 * the viewer after the table while open (a dialog inside `<tbody>` would
 * break the table). One request object per press, keyed: a press while the
 * download failure shows mounts a fresh viewer, which imports again. The
 * viewer's one series is live through the accessor — empty while the series
 * holds no observations (the open viewer then says so) — and nothing it does
 * is saved.
 */
export function createSeriesViewer(seriesById: Accessor<ReadonlyMap<string, MarketSeries>>): {
	readonly open: (seriesId: string, opener: HTMLElement) => void;
	readonly View: () => JSX.Element;
} {
	const [request, setRequest] = createSignal<{
		readonly seriesId: string;
		readonly opener: HTMLElement;
	} | null>(null);
	const viewerSeries = createMemo(() => {
		const id = request()?.seriesId ?? null;
		const entry = id === null ? undefined : seriesById().get(id);
		return entry === undefined || entry.observations.length === 0 ? [] : [entry];
	});
	return {
		open: (seriesId, opener) => setRequest({ seriesId, opener }),
		View: () => (
			<Show when={request()} keyed>
				{(current) => (
					<LazyChartViewer
						open
						title={seriesById().get(current.seriesId)?.title ?? current.seriesId}
						series={viewerSeries}
						initialPreset="1y"
						opener={current.opener}
						onClose={() => setRequest(null)}
					/>
				)}
			</Show>
		),
	};
}

/**
 * One price row: the row header (name and symbol), then the shown value
 * columns, the source, and an amber "last refresh failed (reason)" note row
 * beneath a series whose last refresh failed. Every cell carries a value or
 * an explicit "unavailable (reason)" — never blank, never 0. The header of
 * a series with observations is the chart opener.
 *
 * `label` names a row whose series may be missing (a Watchlist prices row
 * names its stock; the Stock table derives the name from the series, and a
 * missing series is one "unavailable" cell). `notShown` replaces the values
 * of a row the page is not served (past its series limit, ADR-0040 §4).
 * `symbolOnly` (a Small widget) shows the symbol without the name.
 */
export function PriceRow(props: {
	readonly series: MarketSeries | null;
	readonly columns: PriceColumns;
	readonly onOpen: (button: HTMLButtonElement) => void;
	readonly label?: { readonly name: string | null; readonly symbol: string };
	readonly notShown?: string | null;
	readonly symbolOnly?: boolean;
	/**
	 * A line clamp for the reason a row has no values (a glanceable widget
	 * keeps every row one or two lines tall); the whole reason stays in the
	 * text, so a screen reader reads it all and `title` shows it on hover.
	 */
	readonly reasonClamp?: string;
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
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
	const missingReason = () => seriesMissingReason(props.series, modelText());
	const stale = () =>
		props.series === null ? null : staleFailureReason(props.series, modelText());
	// The viewer opens only for a series with observations (ADR-0025).
	const openable = () => (props.series?.observations.length ?? 0) > 0;
	const values = () => valueColumnCount(props.columns);
	const total = () => 1 + values() + (props.columns.source === null ? 0 : 1);
	// A labelled row (a watchlist stock) names the stock only by its own
	// name: a series title is a provider's placeholder ("TM", "6758:JPX").
	const name = () => (props.label !== undefined ? props.label.name : (props.series?.title ?? null));
	const symbol = () => props.label?.symbol ?? props.series?.symbol ?? "";
	const Reason = (reason: { readonly text: string }): JSX.Element => (
		<Show when={props.reasonClamp} fallback={reason.text}>
			{(clamp) => (
				<span class={clamp()} title={reason.text}>
					{reason.text}
				</span>
			)}
		</Show>
	);
	const HeaderText = (): JSX.Element => (
		<Show
			when={props.symbolOnly !== true}
			fallback={<span class="block font-mono">{symbol()}</span>}
		>
			<Show when={name()} fallback={<span class="block font-mono">{symbol()}</span>}>
				{(text) => (
					<>
						<span class="block">{text()}</span>{" "}
						<span class="block font-mono text-2xs font-normal text-slate-600">{symbol()}</span>
					</>
				)}
			</Show>
		</Show>
	);
	const Header = (header: { readonly opener: boolean }): JSX.Element => (
		<th scope="row" class="py-1 pr-3 font-medium">
			<Show when={header.opener} fallback={<HeaderText />}>
				<ChartOpener
					srPrefix={m().openChart}
					openerKey={props.series?.seriesId ?? symbol()}
					onOpen={props.onOpen}
				>
					<HeaderText />
				</ChartOpener>
			</Show>
		</th>
	);
	const valueCell = (extra: string | null, body: () => JSX.Element, align = "text-right") => (
		<Show when={extra !== null}>
			<td class={`py-1 pr-3 ${align} tabular-nums ${extra ?? ""}`}>{body()}</td>
		</Show>
	);
	return (
		<Switch>
			<Match when={props.notShown}>
				{(text) => (
					<tr class="border-b border-slate-200 align-top">
						<Header opener={false} />
						<td colspan={total() - 1} class="py-1 text-xs text-slate-700">
							<Reason text={text()} />
						</td>
					</tr>
				)}
			</Match>
			<Match when={props.series === null && props.label === undefined}>
				<tr class="border-b border-slate-200">
					<td colspan={total()} class="py-1 text-sm text-amber-900">
						<Reason text={common().unavailable(unavailableText("NO_DATA", modelText()))} />
					</td>
				</tr>
			</Match>
			<Match when={props.series === null}>
				<tr class="border-b border-slate-200 align-top">
					<Header opener={false} />
					<td colspan={total() - 1} class="py-1 text-sm text-amber-900">
						<Reason text={common().unavailable(unavailableText("NO_DATA", modelText()))} />
					</td>
				</tr>
			</Match>
			<Match when={props.series}>
				{(entry) => (
					<>
						<tr class="border-b border-slate-200 align-top">
							<Header opener={openable()} />
							<Show
								when={ready()}
								fallback={
									<Show when={values() > 0}>
										<td colspan={values()} class="py-1 pr-3 text-sm text-amber-900">
											<Reason text={common().unavailable(missingReason())} />
										</td>
									</Show>
								}
							>
								{(good) => (
									<>
										{valueCell(props.columns.lastClose, () => (
											<>
												{formatValue(good().latest.value)}{" "}
												<span class="text-xs text-slate-600">{good().entry.unit}</span>
											</>
										))}
										{valueCell(props.columns.change, () => (
											<ChangeCell
												change={good().summary.change}
												unit={good().entry.unit}
												kind="abs"
											/>
										))}
										{valueCell(props.columns.changePercent, () => (
											<ChangeCell
												change={good().summary.change}
												unit={good().entry.unit}
												kind="pct"
											/>
										))}
										{valueCell(
											props.columns.asOf,
											() => (
												<time dateTime={good().latest.observedOn}>{good().latest.observedOn}</time>
											),
											"text-left text-xs",
										)}
									</>
								)}
							</Show>
							<Show when={props.columns.source !== null}>
								<td class={`whitespace-nowrap py-1 text-xs ${props.columns.source ?? ""}`}>
									<SafeLink url={entry().sourceUrl}>{entry().publisher}</SafeLink>
								</td>
							</Show>
						</tr>
						<Show when={stale()}>
							{(reason) => (
								<tr class="border-b border-slate-200">
									<td colspan={total()} class="py-1 text-xs text-amber-900">
										{m().lastRefreshFailed(reason())}
									</td>
								</tr>
							)}
						</Show>
					</>
				)}
			</Match>
		</Switch>
	);
}

export function ChangeCell(props: {
	readonly change: ReturnType<typeof summarizeSeries>["change"] | null;
	readonly unit: string;
	readonly kind: "abs" | "pct";
}): JSX.Element {
	const m = useMessages(marketWidgetMessages);
	const modelText = useMessages(homeModelMessages);
	const common = useMessages(commonMessages);
	/**
	 * One memo over the live props: a value to show, "not applicable" (a
	 * percent of a percent), or the reason the cell is unavailable.
	 */
	const display = createMemo((): ChangeCellDisplay => {
		const change = props.change;
		if (change === null) {
			return { kind: "unavailable", reason: unavailableText("NO_DATA", modelText()) };
		}
		if (!change.ok)
			return { kind: "unavailable", reason: changeErrorText(change.error, modelText()) };
		// The signed text ("+0.52 USD") is the non-colour cue; the tone adds colour.
		const direction = changeDirection(change.value.absoluteChange);
		if (props.kind === "abs") {
			// The delta follows the series' latest value magnitude (the one rule in homeModel.ts).
			return {
				kind: "value",
				text: formatAbsDelta(change.value.absoluteChange, props.unit, change.value.latest.value),
				direction,
			};
		}
		const pct = formatPctValue(change.value.percentChange, props.unit);
		return pct === null ? { kind: "not-applicable" } : { kind: "value", text: pct, direction };
	});
	const valueText = () => {
		const current = display();
		return current.kind === "value" ? current.text : null;
	};
	const valueTone = () => {
		const current = display();
		return current.kind === "value" ? CHANGE_TONES[current.direction] : undefined;
	};
	const hasValue = () => display().kind === "value";
	const notApplicable = () => display().kind === "not-applicable";
	const unavailableReason = () => {
		const current = display();
		return current.kind === "unavailable"
			? current.reason
			: unavailableText("NO_DATA", modelText());
	};
	return (
		// Branches on the display kind, never on the text: a value like "0"
		// must render (D1 audit).
		<Switch fallback={<span class="italic">{common().unavailable(unavailableReason())}</span>}>
			<Match when={hasValue()}>
				<span class={valueTone()}>{valueText()}</span>
			</Match>
			<Match when={notApplicable()}>
				<span class="italic">{m().notApplicable}</span>
			</Match>
		</Switch>
	);
}

type ChangeCellDisplay =
	| { readonly kind: "value"; readonly text: string; readonly direction: ChangeDirection }
	| { readonly kind: "not-applicable" }
	| { readonly kind: "unavailable"; readonly reason: string };
