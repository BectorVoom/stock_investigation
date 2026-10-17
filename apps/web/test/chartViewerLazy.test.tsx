import type { MarketSeries } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, ErrorBoundary } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { MetricWidget } from "../src/home/widgets/MetricWidget.tsx";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The viewer chunk's download can fail (offline, or an old chunk hash after
 * a new release). The mock below stands in for that network: while
 * `chunk.fail` is set, importing the viewer module rejects the way a
 * failed dynamic import does; cleared, the real module loads.
 */
const chunk = vi.hoisted(() => ({ fail: true }));

vi.mock("../src/chartViewer/ChartViewer.tsx", async (importOriginal) => {
	if (chunk.fail) {
		throw new TypeError("Failed to fetch dynamically imported module: ChartViewer-x.js");
	}
	return importOriginal();
});

const VIX: MarketSeries = {
	seriesId: "fred:VIXCLS",
	provider: "fred",
	symbol: "VIXCLS",
	title: "CBOE Volatility Index: VIX",
	unit: "Index",
	frequency: "daily",
	publisher: "Federal Reserve Bank of St. Louis",
	sourceUrl: "https://fred.stlouisfed.org/series/VIXCLS",
	lastRefreshedAt: "2026-10-12T11:50:00Z",
	retrievedAt: "2026-10-12T11:50:00Z",
	unavailable: null,
	observations: [
		["2026-10-06", 15.01],
		["2026-10-07", 15.08],
		["2026-10-08", 15.41],
	],
};

/**
 * A metric widget beside another widget, under a page-level boundary like
 * App.tsx's route boundary: a failure that escaped the viewer would replace
 * both widgets with the page fallback.
 */
function renderPage(): void {
	const [byId] = createSignal<ReadonlyMap<string, MarketSeries>>(new Map([[VIX.seriesId, VIX]]));
	render(() => (
		<ErrorBoundary fallback={<p data-test="page-fallback">Home could not be loaded.</p>}>
			<p data-test="other-widget">Other widget</p>
			<MetricWidget
				widget={{
					type: "market-metric",
					widgetId: "w-vix",
					title: "VIX",
					size: "small",
					seriesId: VIX.seriesId,
				}}
				seriesById={byId}
			/>
		</ErrorBoundary>
	));
}

function opener(): HTMLElement {
	return screen.getByRole("button", { name: /^Open chart: / });
}

async function failureAlert(): Promise<HTMLElement> {
	return waitFor(() => {
		const alert = screen.getByRole("alert");
		expect(alert.textContent).toContain("The chart viewer could not be loaded.");
		return alert;
	});
}

beforeEach(() => {
	resetGlobalFetchCalls();
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

// Ordered: the last test loads the chunk for real, and a loaded chunk stays
// loaded for the rest of the file (the module-level promise keeps it).
describe("chart viewer chunk that fails to load", () => {
	it("says Loading chart… at once, then keeps the failure inside the widget", async () => {
		chunk.fail = true;
		renderPage();
		fireEvent.click(opener());
		// The click is answered at once, before the chunk settles.
		expect(screen.getByRole("status").textContent).toContain("Loading chart…");
		const alert = await failureAlert();
		expect(within(alert).getByRole("button", { name: "Try again" })).toBeTruthy();
		expect(within(alert).getByRole("button", { name: "Close" })).toBeTruthy();
		// The page boundary never saw it: the other widget is still there.
		expect(document.querySelector('[data-test="page-fallback"]')).toBeNull();
		expect(document.querySelector('[data-test="other-widget"]')).not.toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("Close removes the notice, returns focus to the opener, and the opener works again", async () => {
		chunk.fail = true;
		renderPage();
		const button = opener();
		fireEvent.click(button);
		const alert = await failureAlert();
		within(alert).getByRole("button", { name: "Try again" }).focus();
		fireEvent.click(within(alert).getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("alert")).toBeNull();
		expect(document.activeElement).toBe(button);
		// Not stuck open: the next click tries the download again.
		fireEvent.click(button);
		expect(screen.getByRole("status").textContent).toContain("Loading chart…");
		await failureAlert();
	});

	it("Try again imports again and opens the viewer once the chunk loads", async () => {
		chunk.fail = true;
		renderPage();
		fireEvent.click(opener());
		const alert = await failureAlert();
		// The network is back.
		chunk.fail = false;
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await waitFor(() => expect(document.querySelector("sl-dialog.chart-viewer")).not.toBeNull(), {
			timeout: 5000,
		});
		expect(screen.queryByRole("alert")).toBeNull();
		expect(document.querySelector('[data-test="other-widget"]')).not.toBeNull();
	});
});
