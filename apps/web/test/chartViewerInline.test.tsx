import type { MarketSeries } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal, ErrorBoundary } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The chart viewer inline in a page region (ADR-0049 §4): the same
 * content as the dialog with no heading of its own (the title only names
 * the region) and no data-table twin, without a dialog, focus trap,
 * Escape-to-close or Close button, in the viewer's own lazy chunk with a
 * failure that stays in the region and imports again on Try again.
 *
 * The mock stands in for the network as in `chartViewerLazy.test.tsx`:
 * while `chunk.fail` is set, importing the viewer module rejects.
 */
const chunk = vi.hoisted(() => ({ fail: false, attempts: 0 }));

vi.mock("../src/chartViewer/ChartViewer.tsx", async (importOriginal) => {
	chunk.attempts += 1;
	if (chunk.fail) {
		throw new TypeError("Failed to fetch dynamically imported module: ChartViewer-x.js");
	}
	return importOriginal();
});

const { LazyInlineChartViewer } = await import("../src/chartViewer/LazyChartViewer.tsx");

/** Ascending ISO dates ending at `lastIso`. */
function isoDays(lastIso: string, count: number): string[] {
	const lastMs = Date.parse(`${lastIso}T00:00:00Z`);
	return Array.from({ length: count }, (_, index) =>
		new Date(lastMs - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
	);
}

const SERIES: MarketSeries = {
	seriesId: "twelve-data:AAPL",
	provider: "twelve-data",
	symbol: "AAPL",
	title: "AAPL",
	unit: "USD",
	frequency: "daily",
	publisher: "Twelve Data",
	sourceUrl: "https://twelvedata.com/stocks/AAPL",
	lastRefreshedAt: "2026-10-30T21:00:00Z",
	retrievedAt: "2026-10-30T21:00:00Z",
	unavailable: null,
	observations: isoDays("2026-10-30", 600).map((day, index): [string, number] => [
		day,
		100 + index * 0.25,
	]),
};

function renderInline(): void {
	const [series] = createSignal<readonly MarketSeries[]>([SERIES]);
	render(() => (
		<ErrorBoundary fallback={<p data-test="page-fallback">The page could not be loaded.</p>}>
			<section aria-label="Chart tab">
				<h3>Apple Inc. · AAPL</h3>
				<LazyInlineChartViewer
					title="Apple Inc. · AAPL — daily closes"
					series={series}
					initialPreset="1y"
				/>
			</section>
		</ErrorBoundary>
	));
}

function fromInput(): HTMLInputElement {
	const input = screen.getByLabelText("From");
	if (!(input instanceof HTMLInputElement)) throw new Error("no From date input");
	return input;
}

async function inlineViewer(): Promise<HTMLElement> {
	return waitFor(
		() => {
			const found = document.querySelector("section.chart-viewer-inline");
			if (!(found instanceof HTMLElement)) throw new Error("no inline viewer yet");
			return found;
		},
		{ timeout: 5000 },
	);
}

beforeEach(() => {
	resetGlobalFetchCalls();
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

// Ordered: the failure tests run first, then the chunk loads for real and
// stays loaded for the rest of the file (the module-level promise keeps it).
describe("inline chart viewer chunk", () => {
	it("says Loading chart… in the region, then keeps a failure there with Try again", async () => {
		chunk.fail = true;
		renderInline();
		const region = screen.getByRole("region", { name: "Chart tab" });
		expect(within(region).getByRole("status").textContent).toContain("Loading chart…");
		const alert = await waitFor(() => within(region).getByRole("alert"));
		expect(alert.textContent).toContain("The chart viewer could not be loaded.");
		// In the page, not a viewport notice; no Close (there is nothing to close).
		expect(alert.classList.contains("fixed")).toBe(false);
		expect(within(alert).queryByRole("button", { name: "Close" })).toBeNull();
		// The page boundary never saw it.
		expect(document.querySelector('[data-test="page-fallback"]')).toBeNull();

		const attempts = chunk.attempts;
		chunk.fail = false;
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await inlineViewer();
		expect(chunk.attempts).toBeGreaterThan(attempts);
		expect(within(region).queryByRole("alert")).toBeNull();
	});
});

describe("inline chart viewer (ADR-0049 §4)", () => {
	it("shows the viewer with no heading of its own, no dialog and no Close button", async () => {
		renderInline();
		const viewer = await inlineViewer();
		// The title names the region for assistive technology; it is not shown.
		expect(viewer.getAttribute("aria-label")).toBe("Apple Inc. · AAPL — daily closes");
		expect(within(viewer).queryByRole("heading", { level: 4 })).toBeNull();
		expect(document.querySelector("sl-dialog")).toBeNull();
		expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
		// What the dialog has but the twin: presets, From/To, controls, chart, overview, statistics.
		expect(screen.getByRole("button", { name: "1Y" }).getAttribute("aria-pressed")).toBe("true");
		expect(fromInput().value).toBe("2025-10-30");
		for (const name of ["Chart", "Overview", "Statistics for the visible window"]) {
			expect(document.querySelector(`section[aria-label="${name}"]`)).not.toBeNull();
		}
		expect(document.querySelector('sl-select[label="Interval"]')).not.toBeNull();
		expect(screen.queryByText(/^Data table:/)).toBeNull();
		expect(viewer.querySelector("details")).toBeNull();
	});

	it("changes its window with a preset and keeps it; Escape closes nothing", async () => {
		renderInline();
		const viewer = await inlineViewer();
		fireEvent.click(screen.getByRole("button", { name: "3M" }));
		expect(screen.getByRole("button", { name: "3M" }).getAttribute("aria-pressed")).toBe("true");
		expect(fromInput().value).toBe("2026-07-30");

		const plot = viewer.querySelector('section[aria-label="Chart"] svg[tabindex="0"]');
		const target = plot instanceof SVGSVGElement ? plot : viewer;
		fireEvent.keyDown(target, { key: "Escape" });
		fireEvent.keyDown(document, { key: "Escape" });
		expect(document.querySelector("section.chart-viewer-inline")).toBe(viewer);
		expect(screen.getByRole("button", { name: "3M" }).getAttribute("aria-pressed")).toBe("true");
	});
});
