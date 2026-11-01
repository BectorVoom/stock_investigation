import { createMemo, For, type JSX } from "solid-js";

/** One tab: its key and its visible name. */
export interface TabItem<K extends string> {
	readonly key: K;
	readonly label: string;
}

/** The DOM id of a tab in the strip whose ids start with `idPrefix`. */
export function tabElementId(idPrefix: string, key: string): string {
	return `${idPrefix}-${key}`;
}

/** Moves focus to a tab once it is rendered (after a re-read renders it again). */
export function focusTab(idPrefix: string, key: string): void {
	const tab = document.getElementById(tabElementId(idPrefix, key));
	if (tab instanceof HTMLElement) tab.focus();
}

/** The index a key press moves to in a strip of `count` tabs, or null for any other key. */
export function tabKeyTarget(key: string, index: number, count: number): number | null {
	if (count === 0) return null;
	switch (key) {
		case "ArrowRight":
			return (index + 1) % count;
		case "ArrowLeft":
			return (index - 1 + count) % count;
		case "Home":
			return 0;
		case "End":
			return count - 1;
		default:
			return null;
	}
}

/**
 * A tab strip, the WAI-ARIA tabs pattern with automatic activation: one tab
 * stop (the selected tab), ← / → move to the previous / next tab and wrap,
 * Home / End to the first / last, and the tab focus lands on is selected.
 * `panelId` names what each tab controls: one shared panel (the Watchlist's
 * list tabs, ADR-0040 §7) or one panel per tab (a stock's tabs, ADR-0049
 * §3). `onPreload` runs on pointer-enter and focus, so a tab whose panel is
 * its own chunk can start downloading it before it is chosen. On a narrow
 * screen the strip scrolls sideways inside itself; the page does not.
 */
export function Tabs<K extends string>(props: {
	readonly label: string;
	readonly idPrefix: string;
	readonly tabs: readonly TabItem<K>[];
	readonly selected: K;
	readonly panelId: string | ((key: K) => string);
	readonly onSelect: (key: K) => void;
	readonly onPreload?: (key: K) => void;
}): JSX.Element {
	// Keyed by the tab's key (a string), so a re-read that rebuilds the tab
	// objects keeps every tab element — and the focus in it.
	const keys = createMemo(() => props.tabs.map((tab) => tab.key));
	const labels = createMemo(() => new Map(props.tabs.map((tab) => [tab.key, tab.label])));
	const controls = (key: K): string =>
		typeof props.panelId === "string" ? props.panelId : props.panelId(key);
	const move = (event: KeyboardEvent, index: number): void => {
		const target = tabKeyTarget(event.key, index, props.tabs.length);
		if (target === null) return;
		event.preventDefault();
		const tab = props.tabs[target];
		if (tab === undefined) return;
		props.onSelect(tab.key);
		focusTab(props.idPrefix, tab.key);
	};
	return (
		<div
			role="tablist"
			aria-label={props.label}
			// overflow-y-hidden: each tab hangs 1 px over the strip's border (-mb-px),
			// and with overflow-x auto that pixel made the strip scroll vertically
			// and show a scroll bar wherever scroll bars are always visible.
			class="-mx-1 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-300 px-1 pt-1"
		>
			<For each={keys()}>
				{(key, index) => {
					const selected = () => key === props.selected;
					return (
						<button
							type="button"
							role="tab"
							id={tabElementId(props.idPrefix, key)}
							data-tab-key={key}
							aria-selected={selected()}
							aria-controls={controls(key)}
							tabIndex={selected() ? 0 : -1}
							class="-mb-px max-w-64 shrink-0 truncate whitespace-nowrap border-b-2 border-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 aria-selected:border-blue-700 aria-selected:font-semibold aria-selected:text-slate-900"
							// A long title is cut with an ellipsis; the whole name stays the
							// tab's text (its accessible name) and its tooltip.
							title={labels().get(key) ?? key}
							onClick={() => props.onSelect(key)}
							onKeyDown={(event) => move(event, index())}
							onPointerEnter={() => props.onPreload?.(key)}
							onFocus={() => props.onPreload?.(key)}
						>
							{labels().get(key) ?? key}
						</button>
					);
				}}
			</For>
		</div>
	);
}
