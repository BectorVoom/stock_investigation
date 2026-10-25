import { createMemo, For, type JSX } from "solid-js";

/** One tab: its key (`"all"` or a list id) and its visible name. */
export interface ListTab {
	readonly key: string;
	readonly label: string;
}

/** The DOM id of a tab (its `aria-controls` panel names it back). */
export function listTabId(key: string): string {
	return `watchlist-tab-${key}`;
}

/** Moves focus to a tab once it is rendered (after a re-read renders it again). */
export function focusListTab(key: string): void {
	const tab = document.getElementById(listTabId(key));
	if (tab instanceof HTMLElement) tab.focus();
}

/**
 * The Watchlist's tab strip (ADR-0040 §7), the WAI-ARIA tabs pattern with
 * automatic activation: one tab stop (the selected tab), ← / → move to the
 * previous / next tab and wrap, Home / End to the first / last, and the tab
 * focus lands on is selected. Every tab controls the one panel below. On a
 * narrow screen the strip scrolls sideways inside itself; the page does not.
 */
export function ListTabs(props: {
	readonly label: string;
	readonly tabs: readonly ListTab[];
	readonly selected: string;
	readonly panelId: string;
	readonly onSelect: (key: string) => void;
}): JSX.Element {
	// Keyed by the tab's key (a string), so a re-read that rebuilds the tab
	// objects keeps every tab element — and the focus in it.
	const keys = createMemo(() => props.tabs.map((tab) => tab.key));
	const labels = createMemo(() => new Map(props.tabs.map((tab) => [tab.key, tab.label])));
	const move = (event: KeyboardEvent, index: number): void => {
		const count = props.tabs.length;
		const target =
			event.key === "ArrowRight"
				? (index + 1) % count
				: event.key === "ArrowLeft"
					? (index - 1 + count) % count
					: event.key === "Home"
						? 0
						: event.key === "End"
							? count - 1
							: null;
		if (target === null) return;
		event.preventDefault();
		const tab = props.tabs[target];
		if (tab === undefined) return;
		props.onSelect(tab.key);
		focusListTab(tab.key);
	};
	return (
		<div
			role="tablist"
			aria-label={props.label}
			class="-mx-1 flex gap-1 overflow-x-auto border-b border-slate-300 px-1 pt-1"
		>
			<For each={keys()}>
				{(key, index) => {
					const selected = () => key === props.selected;
					return (
						<button
							type="button"
							role="tab"
							id={listTabId(key)}
							data-tab-key={key}
							aria-selected={selected()}
							aria-controls={props.panelId}
							tabIndex={selected() ? 0 : -1}
							class="-mb-px max-w-64 shrink-0 truncate whitespace-nowrap border-b-2 border-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 aria-selected:border-blue-700 aria-selected:font-semibold aria-selected:text-slate-900"
							// A long title is cut with an ellipsis; the whole name stays the
							// tab's text (its accessible name) and its tooltip.
							title={labels().get(key) ?? key}
							onClick={() => props.onSelect(key)}
							onKeyDown={(event) => move(event, index())}
						>
							{labels().get(key) ?? key}
						</button>
					);
				}}
			</For>
		</div>
	);
}
