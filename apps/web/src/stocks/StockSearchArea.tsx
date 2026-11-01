import type { StockDirectoryHit } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import type { JSX } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { Section } from "../components/ui.tsx";
import { StockPickerBox } from "./StockPickerBox.tsx";
import { stocksMessages } from "./stocks.messages.ts";

/** The search box's DOM id on the Stocks page. */
export const STOCKS_SEARCH_ID = "stocks-search";

/**
 * "Find a stock" (ADR-0050 §1): the stock-directory search box (ADR-0034,
 * `StockPickerBox`) on the Stocks page. Picking a hit opens that stock —
 * registered or not — and clears the box; nothing is added, and nothing is
 * read until the owner types.
 */
export function StockSearchArea(props: {
	readonly api: ApiClient;
	readonly onOpen: (hit: StockDirectoryHit) => void;
}): JSX.Element {
	const s = useMessages(stocksMessages);
	return (
		<Section title={s().searchTitle}>
			<p class="text-xs text-slate-700">{s().searchHint}</p>
			<div class="mt-2 max-w-xl" data-field="stocks-search">
				<StockPickerBox api={props.api} id={STOCKS_SEARCH_ID} onPick={props.onOpen} />
			</div>
		</Section>
	);
}
