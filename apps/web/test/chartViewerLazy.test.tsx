import type { MarketSeries } from "@research/contracts";
import { WIDGET_BODY_CLASS, WidgetFrame } from "@research/widget-grid";
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
const chunk = vi.hoisted(() => ({ fail: true, attempts: 0 }));

vi.mock("../src/chartViewer/ChartViewer.tsx", async (importOriginal) => {
	chunk.attempts += 1;
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

/** Two metric widgets in their frames (focusable `.wg-body`), live through `byId`. */
function renderFramedMetrics(
	byId: () => ReadonlyMap<string, MarketSeries>,
	seriesIds: readonly string[],
): void {
	render(() => (
		<>
			{seriesIds.map((seriesId, index) => {
				const widget = {
					type: "market-metric",
					widgetId: `w-${index}`,
					title: seriesId,
					size: "small",
					seriesId,
				} as const;
				return (
					<WidgetFrame widget={widget}>
						<MetricWidget widget={widget} seriesById={byId} />
					</WidgetFrame>
				);
			})}
		</>
	));
}

function openViewers(): number {
	return document.querySelectorAll("sl-dialog.chart-viewer[open]").length;
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

	it("shows the failure at a fixed place on the page with Try again focused (fix round 8)", async () => {
		chunk.fail = true;
		renderPage();
		fireEvent.click(opener());
		// The loading status is not below the widget's content (off screen
		// in a short viewport) but fixed at the top of the viewport.
		const status = screen.getByRole("status");
		expect(status.closest(".fixed")).not.toBeNull();
		const alert = await failureAlert();
		expect(alert.classList.contains("fixed")).toBe(true);
		expect(alert.parentElement?.parentElement).toBe(document.body);
		// Focus moves to Try again, so a keyboard user lands on the way out.
		await waitFor(() =>
			expect(document.activeElement).toBe(within(alert).getByRole("button", { name: "Try again" })),
		);
	});

	it("a press on the opener while the failure shows imports again (fix round 8)", async () => {
		chunk.fail = true;
		renderPage();
		const button = opener();
		fireEvent.click(button);
		await failureAlert();
		const attempts = chunk.attempts;
		fireEvent.click(button);
		// Answered as a fresh open: the alert gives way to the loading status
		// while the chunk is imported once more, and the failure returns.
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.getByRole("status").textContent).toContain("Loading chart…");
		await failureAlert();
		expect(chunk.attempts).toBeGreaterThan(attempts);
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

// After the describe above: the chunk is loaded, but each open still waits
// a microtask for it, the window in which a reload or a second press lands.
describe("chart viewer opened while its chunk is still pending", () => {
	const GOLD: MarketSeries = { ...VIX, seriesId: "twelve-data:XAU/USD", title: "Gold spot" };

	it("returns focus to the widget's new opener when a reload replaced it during the download (fix round 8)", async () => {
		chunk.fail = false;
		const [byId, setById] = createSignal<ReadonlyMap<string, MarketSeries>>(
			new Map([[VIX.seriesId, VIX]]),
		);
		renderFramedMetrics(byId, [VIX.seriesId]);
		const first = opener();
		fireEvent.click(first);
		// A reload before the chunk arrives drops and restores the
		// observations: the opener button is a new element.
		setById(new Map([[VIX.seriesId, { ...VIX, observations: [] }]]));
		setById(new Map([[VIX.seriesId, VIX]]));
		const second = opener();
		expect(first.isConnected).toBe(false);
		expect(second).not.toBe(first);
		const dialog = await waitFor(
			() => {
				const found = document.querySelector("sl-dialog.chart-viewer");
				if (!(found instanceof HTMLElement)) throw new Error("no viewer yet");
				return found;
			},
			{ timeout: 5000 },
		);
		dialog.dispatchEvent(
			new CustomEvent("sl-request-close", { detail: { source: "close-button" }, cancelable: true }),
		);
		expect(document.querySelector("sl-dialog.chart-viewer")).toBeNull();
		expect(document.activeElement).toBe(second);
		expect(second.closest(`.${WIDGET_BODY_CLASS}`)).not.toBeNull();
	});

	it("keeps one viewer when two widgets are pressed during one download (fix round 8)", async () => {
		chunk.fail = false;
		const [byId] = createSignal<ReadonlyMap<string, MarketSeries>>(
			new Map([
				[VIX.seriesId, VIX],
				[GOLD.seriesId, GOLD],
			]),
		);
		renderFramedMetrics(byId, [VIX.seriesId, GOLD.seriesId]);
		const [vix, gold] = screen.getAllByRole("button", { name: /^Open chart: / });
		if (vix === undefined || gold === undefined) throw new Error("two openers expected");
		fireEvent.click(vix);
		fireEvent.click(gold);
		await waitFor(() => expect(openViewers()).toBe(1), { timeout: 5000 });
		// Settled: the later press wins, the earlier one is closed for good.
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(openViewers()).toBe(1);
		expect(document.querySelectorAll("sl-dialog.chart-viewer")).toHaveLength(1);
		expect(document.querySelector("sl-dialog.chart-viewer")?.getAttribute("label")).toBe(
			GOLD.title,
		);
	});
});
