import type { MarketFrequency, MarketSeries } from "@research/contracts";
import { type ChartPreset, dayNumberToIso, isoToDayNumber, presetWindow } from "@research/domain";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartViewer } from "../src/chartViewer/ChartViewer.tsx";
import { ensureHomeIconLibraries } from "../src/home/shoelace.ts";
import type { SlOptionElement } from "../src/home/sl-elements.d.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

function trendSeries(
	seriesId: string,
	title: string,
	unit: string,
	frequency: MarketFrequency,
	closes: readonly (readonly [string, number])[],
): MarketSeries {
	return {
		seriesId,
		provider: "fred",
		symbol: seriesId,
		title,
		unit,
		frequency,
		publisher: "Test Publisher",
		sourceUrl: "https://example.com/series",
		lastRefreshedAt: "2026-10-12T11:50:00Z",
		retrievedAt: "2026-10-12T11:50:00Z",
		unavailable: null,
		observations: closes.map(([observedOn, value]): [string, number] => [observedOn, value]),
	};
}

/** Ascending ISO dates ending at `lastIso`. */
function isoDays(lastIso: string, count: number): string[] {
	const lastMs = Date.parse(`${lastIso}T00:00:00Z`);
	return Array.from({ length: count }, (_, index) => {
		const ms = lastMs - (count - 1 - index) * 86_400_000;
		return new Date(ms).toISOString().slice(0, 10);
	});
}

/** 400 daily closes ending 2026-10-08, rising 0.5 per day from 100. */
function longSeries(): MarketSeries {
	const dates = isoDays("2026-10-08", 400);
	return trendSeries(
		"fred:LONG",
		"Long series",
		"Index",
		"daily",
		dates.map((observedOn, index): [string, number] => [observedOn, 100 + index * 0.5]),
	);
}

function vixSeries(): MarketSeries {
	return trendSeries("fred:VIXCLS", "CBOE Volatility Index: VIX", "Index", "daily", [
		["2026-10-06", 15.01],
		["2026-10-07", 15.08],
		["2026-10-08", 15.41],
	]);
}

function renderViewer(
	series: readonly MarketSeries[],
	initialPreset: ChartPreset = "max",
	onClose: () => void = () => {},
) {
	const [current] = createSignal(series);
	return render(() => (
		<ChartViewer
			open
			title="Test chart"
			series={current}
			initialPreset={initialPreset}
			onClose={onClose}
		/>
	));
}

function fromInput(): HTMLInputElement {
	const input = screen.getByLabelText("From");
	if (!(input instanceof HTMLInputElement)) throw new Error("no From date input");
	return input;
}

function toInput(): HTMLInputElement {
	const input = screen.getByLabelText("To");
	if (!(input instanceof HTMLInputElement)) throw new Error("no To date input");
	return input;
}

function intervalSelect(): HTMLElement {
	const select = document.querySelector('sl-select[label="Interval"]');
	if (!(select instanceof HTMLElement)) throw new Error("no Interval select");
	return select;
}

function valuesSelect(): HTMLElement {
	const select = document.querySelector('sl-select[label="Values"]');
	if (!(select instanceof HTMLElement)) throw new Error("no Values select");
	return select;
}

/** Sets a Shoelace select's value and notifies its `sl-change` listener. */
function setSelectValue(select: Element, value: string): void {
	Object.assign(select, { value });
	select.dispatchEvent(new Event("sl-change", { bubbles: true }));
}

/** An `sl-option` by its visible text (Solid sets dynamic values as properties). */
function optionByText(select: Element, text: string): SlOptionElement {
	const found = [...select.querySelectorAll("sl-option")].find(
		(option) => option.textContent === text,
	);
	if (!(found instanceof HTMLElement)) throw new Error(`no option "${text}"`);
	// The light-DOM contract of sl-option: value and disabled live as properties.
	return found as SlOptionElement;
}

function chartSvg(): SVGSVGElement {
	const svg = document.querySelector('svg[aria-roledescription="interactive chart"]');
	if (!(svg instanceof SVGSVGElement)) throw new Error("no interactive chart");
	return svg;
}

function readout(): string {
	return document.querySelector('[data-chart-part="readout"]')?.textContent ?? "";
}

function liveRegion(): string {
	return document.querySelector('p[aria-live="polite"]')?.textContent ?? "";
}

function isoOfDay(day: number): string {
	const iso = dayNumberToIso(day);
	if (!iso.ok) throw new Error("bad day number");
	return iso.value;
}

beforeEach(() => {
	resetGlobalFetchCalls();
	// Same-origin Shoelace icons, like every Home test: without this the
	// components fetch their built-in data: icons through global fetch.
	ensureHomeIconLibraries();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("chart viewer", () => {
	it("presets set From and To", () => {
		const series = longSeries();
		renderViewer([series]);
		expect(fromInput().value).toBe("2025-09-04");
		expect(toInput().value).toBe("2026-10-08");

		fireEvent.click(screen.getByRole("button", { name: "1M" }));
		const last = isoToDayNumber("2026-10-08");
		const first = isoToDayNumber("2025-09-04");
		if (!last.ok || !first.ok) throw new Error("bad fixture date");
		const expected = presetWindow("1m", first.value, last.value);
		expect(fromInput().value).toBe(isoOfDay(expected.from));
		expect(toInput().value).toBe("2026-10-08");
		expect(screen.getByRole("button", { name: "1M" }).getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(screen.getByRole("button", { name: "Max" }));
		expect(fromInput().value).toBe("2025-09-04");
	});

	it("a custom range applies, and an invalid range is refused", async () => {
		renderViewer([longSeries()]);
		fireEvent.change(fromInput(), { target: { value: "2026-10-01" } });
		expect(fromInput().value).toBe("2026-10-01");
		expect(toInput().value).toBe("2026-10-08");
		// Eight daily bars in the window.
		const stats = document.querySelector('section[aria-label="Statistics for the visible window"]');
		if (!(stats instanceof HTMLElement)) throw new Error("no statistics section");
		const row = within(stats).getByRole("row", { name: /Long series/ });
		expect(row.textContent).toContain("2026-10-01");
		expect(within(stats).getByRole("columnheader", { name: "Bars" }).textContent?.trim()).toBe(
			"Bars",
		);

		// From after To is refused with an inline message and nothing changes.
		fireEvent.change(fromInput(), { target: { value: "2026-10-09" } });
		await screen.findByRole("alert");
		expect(document.body.textContent).toContain("The From date is after the To date");
		expect(fromInput().value).toBe("2026-10-01");
	});

	it("names the Auto interval and disables finer-than-native options", () => {
		const monthly = trendSeries("fred:CPI", "Consumer Price Index", "Index", "monthly", [
			["2026-05-01", 320.1],
			["2026-06-01", 320.8],
			["2026-07-01", 321.2],
			["2026-08-01", 321.9],
			["2026-09-01", 322.5],
			["2026-10-01", 323.1],
		]);
		renderViewer([monthly]);
		const select = intervalSelect();
		expect(optionByText(select, "Auto (Monthly)").value).toBe("auto");
		for (const label of ["Daily — source is monthly", "Weekly — source is monthly"]) {
			expect(optionByText(select, label).disabled).toBe(true);
		}
		expect(optionByText(select, "Monthly").disabled).toBeFalsy();
	});

	it("disables Log for non-positive visible values", () => {
		const mixed = trendSeries("fred:MIXED", "Mixed signs", "Index", "daily", [
			["2026-10-06", 3],
			["2026-10-07", 0],
			["2026-10-08", -1],
		]);
		renderViewer([mixed]);
		const dialog = document.querySelector("sl-dialog");
		if (!(dialog instanceof HTMLElement)) throw new Error("no dialog");
		const log = optionByText(dialog, "Log — needs values above zero");
		expect(log.value).toBe("log");
		expect(log.disabled).toBe(true);
	});

	it("rebases % mode to zero at the first visible bar", () => {
		renderViewer([vixSeries()]);
		setSelectValue(valuesSelect(), "percent");
		const details = document.querySelector("details");
		if (!(details instanceof HTMLElement)) throw new Error("no data table twin");
		// The first visible bar is 0 %; later bars show signed percents.
		expect(details.textContent).toContain("0%");
		expect(details.textContent).toContain("+0.4664%");
		expect(details.textContent).toContain("+2.6649%");
		// A non-zero base is never reported as a zero base.
		expect(document.body.textContent?.includes("unavailable (zero base)")).toBe(false);
	});

	it("disables MA toggles for two series, with the reason stated", () => {
		const second = trendSeries("fred:SP500", "S&P 500", "Index", "daily", [
			["2026-10-06", 6651.21],
			["2026-10-07", 6671.06],
			["2026-10-08", 6692.34],
		]);
		renderViewer([vixSeries(), second]);
		for (const period of [20, 50, 200]) {
			const toggle = screen.getByRole("button", { name: `MA ${period}` });
			expect(toggle.hasAttribute("disabled")).toBe(true);
		}
		expect(document.body.textContent).toContain("Moving averages need exactly one series.");
	});

	it("enables MA toggles for exactly one series", () => {
		renderViewer([longSeries()]);
		const toggle = screen.getByRole("button", { name: "MA 20" });
		expect(toggle.hasAttribute("disabled")).toBe(false);
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-pressed")).toBe("true");
		expect(document.body.textContent).toContain("MA 20");
	});

	it("keyboard arrows move the readout and announce it", () => {
		renderViewer([vixSeries()]);
		const svg = chartSvg();
		svg.focus();
		expect(readout()).toContain("Point at the chart");
		fireEvent.keyDown(svg, { key: "ArrowRight" });
		expect(readout()).toContain("2026-10-06");
		expect(readout()).toContain("15.01");
		expect(liveRegion()).toBe(readout());
		fireEvent.keyDown(svg, { key: "ArrowRight" });
		expect(readout()).toContain("2026-10-07");
		expect(liveRegion()).toBe(readout());
		fireEvent.keyDown(svg, { key: "End" });
		expect(readout()).toContain("2026-10-08");
		expect(liveRegion()).toBe(readout());
	});

	it("wheel zoom narrows the window", async () => {
		renderViewer([longSeries()]);
		expect(fromInput().value).toBe("2025-09-04");
		expect(toInput().value).toBe("2026-10-08");
		fireEvent.wheel(chartSvg(), { deltaY: -100, clientX: 320 });
		// Without pointer coordinates (happy-dom) the zoom goes around the
		// centre, narrowing both ends of the window.
		await waitFor(() => expect(fromInput().value).not.toBe("2025-09-04"), { timeout: 2000 });
		expect(fromInput().value > "2025-09-04").toBe(true);
		expect(toInput().value < "2026-10-08").toBe(true);
	});

	it("shows hand-worked statistics for the visible window", () => {
		renderViewer([vixSeries()]);
		const stats = document.querySelector('section[aria-label="Statistics for the visible window"]');
		if (!(stats instanceof HTMLElement)) throw new Error("no statistics section");
		const row = within(stats).getByRole("row", { name: /CBOE Volatility Index/ });
		const text = row.textContent ?? "";
		expect(text).toContain("15.01");
		expect(text).toContain("15.41");
		expect(text).toContain("+0.40");
		expect(text).toContain("+2.66%");
		expect(text).toContain("2026-10-08");
		expect(text).toContain("2026-10-06");
		expect(text).toContain("15.17");
		expect(text).toContain("0%");
	});

	it("close returns focus to the opener", () => {
		const opener = document.createElement("button");
		opener.textContent = "Open chart";
		document.body.appendChild(opener);
		opener.focus();
		try {
			const onClose = vi.fn();
			renderViewer([vixSeries()], "max", onClose);
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(opener);
		} finally {
			opener.remove();
		}
	});
});
