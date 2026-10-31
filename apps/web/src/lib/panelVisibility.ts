import { type Accessor, createEffect, on, untrack } from "solid-js";
import type { VisibilitySource } from "./polling.ts";

/**
 * A panel's own visibility: visible only while the tab is (`base`) AND the
 * panel is displayed (`shown`, a reactive accessor — e.g. the Notebook panel
 * in a Chat-first conversation below `lg`, mounted but `display: none`).
 * Listeners hear both the tab's changes and every change of `shown`, so a
 * poller or a re-check pauses while the panel is not shown and catches up
 * the moment it is. Must be created under a Solid owner (the effect that
 * watches `shown` ends with it).
 */
export function createPanelVisibility(
	base: VisibilitySource,
	shown: Accessor<boolean>,
): VisibilitySource {
	const listeners = new Set<() => void>();
	createEffect(
		on(
			shown,
			() => {
				for (const listener of [...listeners]) listener();
			},
			{ defer: true },
		),
	);
	return {
		isVisible: () => base.isVisible() && untrack(shown),
		subscribe: (listener) => {
			listeners.add(listener);
			const stopBase = base.subscribe(listener);
			return () => {
				listeners.delete(listener);
				stopBase();
			};
		},
	};
}
