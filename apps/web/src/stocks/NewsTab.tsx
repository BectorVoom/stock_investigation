import type { JSX } from "solid-js";
import type { StockTabProps } from "./stockTabs.ts";

/** SEAM STUB — the News tab (ADR-0049 §7). Replaced by the chart/news worker. */
export function NewsTab(props: StockTabProps): JSX.Element {
	return <p data-field="stock-news-tab">{props.stock().stockId}</p>;
}
