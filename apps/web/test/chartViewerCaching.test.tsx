import type { MarketSeries } from "@research/contracts";
import { resampleSeries } from "@research/domain";
import { unionBarDays } from "@research/ui-registry";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartViewer } from "../src/chartViewer/ChartViewer.tsx";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

/**
 * The window-change bench cases (`scripts/bench.ts`) time functions that
 * take the memoized bars and union as inputs, so they cannot see a wiring
 * regression where the viewer resamples or re-merges on every pan or zoom.
 * This test counts the real calls through pass-through spies instead.
 */
vi.mock("@research/domain", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@research/domain")>();
	return { ...actual, resampleSeries: vi.fn(actual.resampleSeries) };
});
vi.mock("@research/ui-registry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@research/ui-registry")>();
	return { ...actual, unionBarDays: vi.fn(actual.unionBarDays) };
});

/** Ascending ISO dates ending at `lastIso`. */
function isoDays(lastIso: string, count: number): string[] {
	const lastMs = Date.parse(`${lastIso}T00:00:00Z`);
	return Array.from({ length: count }, (_, index) =>
		new Date(lastMs - (count - 1 - index) * 86_400_000).toISOString().slice(0, 10),
	);
}

function dailySeries(seriesId: string, offset: number): MarketSeries {
	return {
		seriesId,
		provider: "fred",
		symbol: seriesId,
		title: seriesId,
		unit: "Index",
		frequency: "daily",
		publisher: "Test Publisher",
		sourceUrl: "https://example.com/series",
		lastRefreshedAt: "2026-10-12T11:50:00Z",
		retrievedAt: "2026-10-12T11:50:00Z",
		unavailable: null,
		observations: isoDays("2026-10-08", 400).map((observedOn, index): [string, number] => [
			observedOn,
			100 + offset + index * 0.5,
		]),
	};
}

function chartSvg(): SVGSVGElement {
	const svg = document.querySelector('svg[aria-roledescription="interactive chart"]');
	if (!(svg instanceof SVGSVGElement)) throw new Error("no interactive chart");
	return svg;
}

function fromValue(): string {
	const input = screen.getByLabelText("From");
	if (!(input instanceof HTMLInputElement)) throw new Error("no From date input");
	return input.value;
}

beforeEach(() => {
	resetGlobalFetchCalls();
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

describe("chart viewer per-interval cache", () => {
	it("never resamples or re-merges the union on a pan or zoom at a fixed interval (fix round 7)", () => {
		const resample = vi.mocked(resampleSeries);
		const union = vi.mocked(unionBarDays);
		const [series] = createSignal([dailySeries("fred:A", 0), dailySeries("fred:B", 10)]);
		render(() => (
			<ChartViewer open title="Two series" series={series} initialPreset="1y" onClose={() => {}} />
		));
		// An explicit interval: Auto would legitimately resample once per new
		// interval as the span changes.
		const select = document.querySelector('sl-select[label="Interval"]');
		if (!(select instanceof HTMLElement)) throw new Error("no Interval select");
		Object.assign(select, { value: "daily" });
		select.dispatchEvent(new Event("sl-change", { bubbles: true }));
		fireEvent.click(screen.getByRole("button", { name: "3M" }));
		const resampled = resample.mock.calls.length;
		const merged = union.mock.calls.length;
		// Once per series and once for the union at Daily, nothing more.
		expect(resampled).toBeGreaterThanOrEqual(2);
		expect(merged).toBeGreaterThanOrEqual(1);

		const svg = chartSvg();
		svg.focus();
		const start = fromValue();
		fireEvent.keyDown(svg, { key: "ArrowLeft", shiftKey: true });
		fireEvent.keyDown(svg, { key: "ArrowLeft", shiftKey: true });
		fireEvent.keyDown(svg, { key: "+" });
		fireEvent.keyDown(svg, { key: "+" });
		fireEvent.keyDown(svg, { key: "-" });
		fireEvent.keyDown(svg, { key: "ArrowRight", shiftKey: true });
		fireEvent.click(screen.getByRole("button", { name: "1M" }));
		fireEvent.click(screen.getByRole("button", { name: "6M" }));
		// The gestures did move the window…
		expect(fromValue()).not.toBe(start);
		// …and every one of them re-sliced the cached bars only.
		expect(resample.mock.calls.length).toBe(resampled);
		expect(union.mock.calls.length).toBe(merged);
	});
});
