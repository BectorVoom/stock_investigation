import type { CandlestickChartProps } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { ChartFrame, ChartLegend, ChartShell } from "../charts/ChartFrame.tsx";
import {
	buildXTicks,
	type Candle,
	cellText,
	DEFAULT_PLOT,
	extractCandles,
	hasColumn,
	linearScale,
	niceTicks,
	type PlotArea,
	type Scale,
	SERIES_COLORS,
	valueExtent,
	type XTick,
} from "../charts/chartMath.ts";
import { chartMessages } from "../charts/charts.messages.ts";
import { type GuardedDataset, resolveDataset } from "../datasetGuard.ts";
import { formatIsoDate, formatNumber } from "../format.ts";
import type { RendererProps } from "../registry.tsx";

/** Blue/red is a validated warm-cool pair; the legend and data table carry the meaning too. */
const UP_COLOR = SERIES_COLORS[0];
const DOWN_COLOR = SERIES_COLORS[7];
const MAX_BODY_WIDTH = 12;

interface CandleMark {
	readonly candle: Candle;
	readonly x: number;
	readonly color: string;
	readonly highY: number;
	readonly lowY: number;
	readonly bodyY: number;
	readonly bodyHeight: number;
}

interface CandleModel {
	readonly plot: PlotArea;
	readonly yTicks: readonly number[];
	readonly yScale: Scale;
	readonly xTicks: readonly XTick[];
	readonly rowXs: readonly (number | null)[];
	readonly rowLabels: readonly (string | null)[];
	readonly bodyWidth: number;
	readonly marks: readonly CandleMark[];
	readonly candleByRow: ReadonlyMap<number, Candle>;
	readonly unavailableCount: number;
	readonly missingColumns: readonly string[];
}

function buildCandleModel(data: GuardedDataset, props: CandlestickChartProps): CandleModel {
	const { dataset } = data;
	const plot = DEFAULT_PLOT;
	const rowLabels = dataset.rows.map((row) => {
		const text = cellText(row[props.dateKey]);
		return text === null ? null : (formatIsoDate(text) ?? text);
	});
	const { candles, unavailableCount } = extractCandles(dataset, props, (rowIndex) => {
		const label = rowLabels[rowIndex];
		return label !== null && label !== undefined;
	});
	const extent = valueExtent(candles.flatMap((candle) => [candle.high, candle.low]));
	const yTicks = extent === null ? [] : niceTicks(extent.min, extent.max);
	const yScale = linearScale(yTicks[0] ?? 0, yTicks[yTicks.length - 1] ?? 1, plot.bottom, plot.top);
	// Trading sessions are placed evenly in row order (no gaps for non-trading days).
	const rowCount = dataset.rows.length;
	const band = rowCount === 0 ? 0 : (plot.right - plot.left) / rowCount;
	const rowXs = rowLabels.map((label, rowIndex) =>
		label === null ? null : plot.left + band * (rowIndex + 0.5),
	);
	const bodyWidth = Math.max(1, Math.min(MAX_BODY_WIDTH, band * 0.6));

	return {
		plot,
		yTicks,
		yScale,
		xTicks: buildXTicks(
			dataset.rows.map((_, rowIndex) => rowIndex),
			rowXs,
			rowLabels,
			plot,
			{ maxLabels: 6, maxChars: 12 },
		),
		rowXs,
		rowLabels,
		bodyWidth,
		marks: candles.map((candle): CandleMark => {
			const top = yScale(Math.max(candle.open, candle.close));
			const bottom = yScale(Math.min(candle.open, candle.close));
			return {
				candle,
				x: rowXs[candle.rowIndex] ?? plot.left,
				color: candle.close >= candle.open ? UP_COLOR : DOWN_COLOR,
				highY: yScale(candle.high),
				lowY: yScale(candle.low),
				bodyY: top,
				bodyHeight: Math.max(1, bottom - top),
			};
		}),
		candleByRow: new Map(candles.map((candle) => [candle.rowIndex, candle] as const)),
		unavailableCount,
		missingColumns: [
			props.dateKey,
			props.openKey,
			props.highKey,
			props.lowKey,
			props.closeKey,
		].filter((key) => !hasColumn(dataset, key)),
	};
}

export function CandlestickChart(props: RendererProps<CandlestickChartProps>): JSX.Element {
	const data = createMemo(() => resolveDataset(props.context, props.props.datasetRef));
	const model = createMemo(() => {
		const current = data();
		return current === undefined ? null : buildCandleModel(current, props.props);
	});
	const m = useMessages(chartMessages);
	const [hoveredRow, setHoveredRow] = createSignal<number | null>(null);
	const describe = (candle: Candle): string =>
		m().candlePrices(
			formatNumber(candle.open),
			formatNumber(candle.high),
			formatNumber(candle.low),
			formatNumber(candle.close),
			props.props.priceUnit,
		);
	const readout = createMemo((): string | null => {
		const current = model();
		const rowIndex = hoveredRow();
		if (current === null || rowIndex === null) return null;
		const candle = current.candleByRow.get(rowIndex);
		return `${current.rowLabels[rowIndex] ?? m().dateUnavailable} — ${candle === undefined ? m().pricesUnavailable : describe(candle)}`;
	});

	return (
		<ChartShell
			title={props.props.title}
			datasetRef={props.props.datasetRef}
			data={data()}
			sourceIds={props.props.sourceIds}
			sources={props.context.sources}
			citationScopeKey={props.componentId}
			plottedCount={model()?.marks.length ?? 0}
			unavailableCount={model()?.unavailableCount ?? 0}
			missingColumns={model()?.missingColumns ?? []}
			withheldSeries={[]}
			tableColumnKeys={[
				props.props.dateKey,
				props.props.openKey,
				props.props.highKey,
				props.props.lowKey,
				props.props.closeKey,
			]}
			valueColumnKeys={[
				props.props.openKey,
				props.props.highKey,
				props.props.lowKey,
				props.props.closeKey,
			]}
			readout={readout()}
			legend={
				<ChartLegend
					mark="block"
					items={[
						{ label: m().candleUp, color: UP_COLOR },
						{ label: m().candleDown, color: DOWN_COLOR },
					]}
				/>
			}
		>
			<Show when={model()}>
				{(current) => (
					<ChartFrame
						ariaLabel={m().candlestickLabel(props.props.title, props.props.priceUnit)}
						plot={current().plot}
						xAxisTitle={m().dateAxis}
						yAxisTitle={m().priceAxis(props.props.priceUnit)}
						yTicks={current().yTicks}
						yScale={current().yScale}
						xTicks={current().xTicks}
						rowXs={current().rowXs}
						hoveredRow={hoveredRow()}
						onHoverRow={setHoveredRow}
					>
						<For each={current().marks}>
							{(mark) => (
								<g data-candle="true">
									<title>
										{current().rowLabels[mark.candle.rowIndex] ?? ""} — {describe(mark.candle)}
									</title>
									<line
										x1={mark.x}
										x2={mark.x}
										y1={mark.highY}
										y2={mark.lowY}
										stroke={mark.color}
										stroke-width="1"
									/>
									<rect
										x={mark.x - current().bodyWidth / 2}
										y={mark.bodyY}
										width={current().bodyWidth}
										height={mark.bodyHeight}
										fill={mark.color}
									/>
								</g>
							)}
						</For>
					</ChartFrame>
				)}
			</Show>
		</ChartShell>
	);
}
