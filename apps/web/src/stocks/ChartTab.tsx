import type { JSX } from "solid-js";
import type { StockTabProps } from "./stockTabs.ts";

/** SEAM STUB — the Chart tab (ADR-0049 §4). Replaced by the chart/news worker. */
export function ChartTab(props: StockTabProps): JSX.Element {
	return <p data-field="stock-chart-tab">{props.stock().stockId}</p>;
}
