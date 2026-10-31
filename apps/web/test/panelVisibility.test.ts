import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { createPanelVisibility } from "../src/lib/panelVisibility.ts";
import { createControllableVisibility } from "./fakeBackend.ts";

/**
 * A panel mounted but not displayed (the Notebook in a Chat-first
 * conversation below `lg`) counts as hidden for its polling and its market
 * re-check (ADR-0044 §4), and its listeners hear it being shown again.
 */
describe("createPanelVisibility", () => {
	it("is visible only while the tab is and the panel is shown, and notifies both changes", () => {
		const tab = createControllableVisibility();
		const [shown, setShown] = createSignal(false);
		const { panel, dispose } = createRoot((disposeRoot) => ({
			panel: createPanelVisibility(tab, shown),
			dispose: disposeRoot,
		}));
		const heard: boolean[] = [];
		const stop = panel.subscribe(() => heard.push(panel.isVisible()));
		expect(panel.isVisible()).toBe(false);
		setShown(true);
		expect(panel.isVisible()).toBe(true);
		tab.setVisible(false);
		expect(panel.isVisible()).toBe(false);
		tab.setVisible(true);
		setShown(false);
		expect(heard).toEqual([true, false, true, false]);
		stop();
		setShown(true);
		tab.setVisible(false);
		expect(heard).toHaveLength(4);
		dispose();
	});
});
