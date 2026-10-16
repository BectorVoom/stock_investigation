import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MarketFrequency, MarketSeries } from "@research/contracts";
import { type ChartPreset, dayNumberToIso, isoToDayNumber, presetWindow } from "@research/domain";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChartViewer } from "../src/chartViewer/ChartViewer.tsx";
import { Navigator, navigatorViewX } from "../src/chartViewer/Navigator.tsx";
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

function scaleSelect(): HTMLElement {
	const select = document.querySelector('sl-select[label="Scale"]');
	if (!(select instanceof HTMLElement)) throw new Error("no Scale select");
	return select;
}

function navigatorSvg(): SVGSVGElement {
	const svg = document.querySelector('section[aria-label="Overview"] svg');
	if (!(svg instanceof SVGSVGElement)) throw new Error("no overview navigator");
	return svg;
}

/** Fake an element's measured rect (happy-dom reports zeros). */
function mockRect(
	element: Element,
	rect: {
		readonly left: number;
		readonly top: number;
		readonly width: number;
		readonly height: number;
	},
): void {
	vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
		left: rect.left,
		top: rect.top,
		width: rect.width,
		height: rect.height,
		right: rect.left + rect.width,
		bottom: rect.top + rect.height,
		x: rect.left,
		y: rect.top,
		toJSON: () => ({}),
	} as DOMRect);
}

/** Queue `requestAnimationFrame` callbacks for a manual flush. */
function mockFrames(): { readonly flush: () => void; readonly queued: () => number } {
	const queued: FrameRequestCallback[] = [];
	vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
		(callback: FrameRequestCallback): number => {
			queued.push(callback);
			return queued.length;
		},
	);
	return {
		queued: () => queued.length,
		flush: () => {
			for (const callback of queued.splice(0)) callback(0);
		},
	};
}

function appStylesheet(): string {
	return readFileSync(join(process.cwd(), "apps/web/src/styles.css"), "utf8");
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
		const expectedResult = presetWindow("1m", first.value, last.value);
		if (!expectedResult.ok) throw new Error("bad preset");
		const expected = expectedResult.value;
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
			// Focus moves into the dialog before closing, so the test proves
			// restoration instead of observing an opener that never lost focus.
			chartSvg().focus();
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(opener);
		} finally {
			opener.remove();
		}
	});

	it("captures the opener when the dialog opens, not at mount", async () => {
		const opener = document.createElement("button");
		opener.textContent = "Open chart";
		document.body.appendChild(opener);
		try {
			const [open, setOpen] = createSignal(false);
			const onClose = vi.fn(() => setOpen(false));
			// Mounts closed while focus is on the body; the opener is focused later.
			render(() => (
				<ChartViewer
					open={open()}
					title="Test chart"
					series={() => [vixSeries()]}
					initialPreset="max"
					onClose={onClose}
				/>
			));
			opener.focus();
			setOpen(true);
			await screen.findByRole("button", { name: "Close" });
			chartSvg().focus();
			fireEvent.click(screen.getByRole("button", { name: "Close" }));
			expect(onClose).toHaveBeenCalledTimes(1);
			expect(document.activeElement).toBe(opener);
		} finally {
			opener.remove();
		}
	});

	it("switches a selected Log back to Linear when the window regains non-positive values", async () => {
		const series = trendSeries("fred:LOG", "Log probe", "USD", "daily", [
			["2026-10-06", 0],
			["2026-10-07", 100],
			["2026-10-08", 110],
		]);
		renderViewer([series]);
		// Narrow to the positive bars, where Log is allowed.
		fireEvent.change(fromInput(), { target: { value: "2026-10-07" } });
		setSelectValue(scaleSelect(), "log");
		expect(document.body.textContent).not.toContain("switched back to Linear");
		// Max reintroduces the zero: Log must not silently omit it.
		fireEvent.click(screen.getByRole("button", { name: "Max" }));
		await screen.findByRole("status");
		expect(document.body.textContent).toContain("switched back to Linear");
		expect(document.body.textContent).not.toContain(
			"Switch to Linear or zoom to a positive range.",
		);
	});

	it("leaves Log for Linear when percent mode introduces a zero baseline", async () => {
		renderViewer([vixSeries()]);
		setSelectValue(scaleSelect(), "log");
		expect(document.body.textContent).not.toContain("switched back to Linear");
		// Percent mode rebases to 0 % at the first visible bar.
		setSelectValue(valuesSelect(), "percent");
		await screen.findByRole("status");
		expect(document.body.textContent).toContain("switched back to Linear");
	});

	it("reads raw values with units in percent mode, with rebased percents alongside", () => {
		renderViewer([vixSeries()]);
		setSelectValue(valuesSelect(), "percent");
		const svg = chartSvg();
		svg.focus();
		fireEvent.keyDown(svg, { key: "End" });
		const text = readout();
		// The raw close with its unit, the previous-bar return from raw
		// closes, and the rebased value — never a rebased number in USD.
		expect(text).toContain("2026-10-08");
		expect(text).toContain("15.41 Index");
		expect(text).toContain("(+2.19%)");
		expect(text).toContain("rebased +2.6649%");
		expect(text).not.toContain("21 USD");
		const details = document.querySelector("details");
		if (!(details instanceof HTMLElement)) throw new Error("no data table twin");
		expect(details.textContent).toContain("15.41 Index (+2.6649%)");
		expect(details.textContent).toContain("% change from the first visible bar");
	});

	it("maps navigator pointers with one uniform scale (no letterbox)", () => {
		// Pure conversion: the viewBox follows the measured element width,
		// so element pixels scale uniformly onto the scene.
		expect(navigatorViewX(0, { left: 0, width: 600 }, 600)).toBeCloseTo(0, 5);
		expect(navigatorViewX(300, { left: 0, width: 600 }, 600)).toBeCloseTo(300, 5);
		expect(navigatorViewX(500, { left: 0, width: 1000 }, 600)).toBeCloseTo(300, 5);
		expect(navigatorViewX(320, { left: 20, width: 600 }, 600)).toBeCloseTo(300, 5);
	});

	it("resizes (not pans) the window from a handle", async () => {
		const dates = isoDays("2026-10-08", 101);
		const closes = dates.map((observedOn, index): [string, number] => [observedOn, 1 + index]);
		renderViewer([trendSeries("fred:SPAN", "Span", "Index", "daily", closes)]);
		fireEvent.change(fromInput(), { target: { value: dates[20] } });
		fireEvent.change(toInput(), { target: { value: dates[40] } });
		const before = { from: fromInput().value, to: toInput().value };
		expect(before).toEqual({ from: dates[20], to: dates[40] });

		const svg = navigatorSvg();
		// The viewBox follows the measured width (600 in happy-dom, where
		// the container reports no size), so the element is mocked at the
		// same width: one element pixel is one viewBox unit, no dead margin.
		mockRect(svg, { left: 0, top: 0, width: 600, height: 56 });
		const handle = svg.querySelector('rect[fill-opacity="0.12"]');
		if (!(handle instanceof SVGRectElement)) throw new Error("no window rect");
		const left = Number(handle.getAttribute("x"));
		// Press the left handle and drag it 20 px right: the start moves by
		// about three days while the end stays fixed.
		fireEvent.pointerDown(svg, { clientX: left + 2 });
		fireEvent.pointerMove(svg, { clientX: left + 22, buttons: 1 });
		await waitFor(() => expect(fromInput().value).not.toBe(before.from), { timeout: 2000 });
		expect(toInput().value).toBe(before.to);
		expect(fromInput().value > before.from).toBe(true);
	});

	it("accumulates drag distance across moves in one frame", () => {
		const frames = mockFrames();
		renderViewer([longSeries()]);
		fireEvent.click(screen.getByRole("button", { name: "1M" }));
		expect(fromInput().value).toBe("2026-09-08");
		const svg = chartSvg();
		// One day per pixel, so three moves of 4, 5 and 6 px pan 15 days.
		mockRect(svg, { left: 0, top: 0, width: 30, height: 320 });
		fireEvent.pointerDown(svg, { clientX: 100 });
		fireEvent.pointerMove(svg, { clientX: 104, buttons: 1 });
		fireEvent.pointerMove(svg, { clientX: 109, buttons: 1 });
		fireEvent.pointerMove(svg, { clientX: 115, buttons: 1 });
		expect(frames.queued()).toBe(1);
		frames.flush();
		// Three moves of 4, 5 and 6 px at one day per pixel: back 15 days.
		expect(fromInput().value).toBe("2026-08-24");
	});

	it("widens a bar-less weekend range to neighbouring bars", () => {
		const series = trendSeries("fred:WEEK", "Week", "Index", "daily", [
			["2026-09-28", 10],
			["2026-09-29", 11],
			["2026-09-30", 12],
			["2026-10-01", 13],
			["2026-10-02", 14],
			["2026-10-05", 15],
			["2026-10-06", 16],
		]);
		renderViewer([series]);
		fireEvent.change(fromInput(), { target: { value: "2026-10-03" } });
		fireEvent.change(toInput(), { target: { value: "2026-10-04" } });
		// Saturday–Sunday holds no bars: Friday through Monday instead.
		expect(fromInput().value).toBe("2026-10-02");
		expect(toInput().value).toBe("2026-10-05");
		const stats = document.querySelector('section[aria-label="Statistics for the visible window"]');
		if (!(stats instanceof HTMLElement)) throw new Error("no statistics section");
		expect(within(stats).getByRole("row", { name: /Week/ }).textContent).toContain("2026-10-02");
	});

	it("grows a one-week view to two yearly bars on an interval switch", () => {
		const months: (readonly [string, number])[] = [];
		for (let year = 2024; year <= 2026; year += 1) {
			const lastMonth = year === 2026 ? 10 : 12;
			for (let month = 1; month <= lastMonth; month += 1) {
				months.push([`${year}-${String(month).padStart(2, "0")}-01`, 300 + months.length]);
			}
		}
		renderViewer([trendSeries("fred:MY", "Monthly", "Index", "monthly", months)], "1w");
		setSelectValue(intervalSelect(), "yearly");
		// One week holds a single yearly bar: the window grows to two.
		expect(fromInput().value < "2026-01-01").toBe(true);
	});

	it("positions an older window against the full held extent in the navigator", () => {
		// A dense daily series plus a shorter monthly one reaching back into
		// the previous year: the overview must span both.
		const dates = isoDays("2026-04-10", 100);
		const dense = trendSeries(
			"fred:DENSE",
			"Dense",
			"Index",
			"daily",
			dates.map((observedOn, index): [string, number] => [observedOn, 50 + index * 0.1]),
		);
		const older = trendSeries("fred:OLD", "Older", "Index", "monthly", [
			["2025-06-01", 9],
			["2025-07-01", 9.5],
			["2025-08-01", 10],
			["2025-09-01", 10.5],
			["2025-10-01", 11],
			["2025-11-01", 11.5],
			["2025-12-01", 12],
		]);
		renderViewer([dense, older]);
		fireEvent.change(fromInput(), { target: { value: "2025-06-01" } });
		fireEvent.change(toInput(), { target: { value: "2025-08-01" } });
		const windowRect = navigatorSvg().querySelector('rect[fill-opacity="0.12"]');
		if (!(windowRect instanceof SVGRectElement)) throw new Error("no window rect");
		// Two months of eleven held months fill a sixth of the overview, not
		// a collapsed sliver against the edge.
		expect(Number(windowRect.getAttribute("width"))).toBeGreaterThan(20);
		expect(Number(windowRect.getAttribute("x"))).toBeLessThan(100);
	});

	it("cancels a queued navigator update on unmount", () => {
		const frames = mockFrames();
		const onWindow = vi.fn();
		const { unmount } = render(() => (
			<Navigator
				days={[1, 2, 3, 4, 5]}
				values={[1, 2, 3, 4, 5]}
				window={{ from: 2, to: 4 }}
				extent={{ from: 1, to: 5 }}
				minSpanDays={0}
				onWindow={onWindow}
				windowLabel="Overview"
			/>
		));
		const svg = document.querySelector('svg[role="img"]');
		if (!(svg instanceof SVGSVGElement)) throw new Error("no navigator");
		mockRect(svg, { left: 0, top: 0, width: 1000, height: 56 });
		// Press inside the window, then drag: the move queues one frame.
		fireEvent.pointerDown(svg, { clientX: 500 });
		fireEvent.pointerMove(svg, { clientX: 520, buttons: 1 });
		expect(frames.queued()).toBe(1);
		unmount();
		expect(() => frames.flush()).not.toThrow();
		expect(onWindow).not.toHaveBeenCalled();
	});

	it("budgets Auto bars from the drawable plot width", () => {
		const dates = isoDays("2026-10-08", 280);
		const closes = dates.map((observedOn, index): [string, number] => [
			observedOn,
			100 + index * 0.1,
		]);
		renderViewer([trendSeries("fred:A280", "Auto probe", "Index", "daily", closes)]);
		// 279 days need 200 daily bars: over the 189-bar plot budget, so Weekly.
		expect(optionByText(intervalSelect(), "Auto (Weekly)").value).toBe("auto");
	});

	it("draws the horizontal crosshair for a zero value", () => {
		renderViewer([vixSeries()]);
		setSelectValue(valuesSelect(), "percent");
		const svg = chartSvg();
		svg.focus();
		// Home lands on the first visible bar: 0 % in percent mode.
		fireEvent.keyDown(svg, { key: "Home" });
		expect(document.querySelectorAll('g[data-chart-part="crosshair"] line').length).toBe(2);
	});

	it("revalidates interval options when the series change native frequency", async () => {
		const daily = trendSeries("fred:D", "Daily", "Index", "daily", [
			["2026-10-06", 1],
			["2026-10-07", 2],
			["2026-10-08", 3],
		]);
		const monthly = trendSeries("fred:M", "Monthly", "Index", "monthly", [
			["2026-05-01", 1],
			["2026-06-01", 2],
			["2026-07-01", 3],
			["2026-08-01", 4],
			["2026-09-01", 5],
			["2026-10-01", 6],
		]);
		const [current, setCurrent] = createSignal<readonly MarketSeries[]>([daily]);
		render(() => (
			<ChartViewer
				open
				title="Test chart"
				series={current}
				initialPreset="max"
				onClose={() => {}}
			/>
		));
		setSelectValue(intervalSelect(), "daily");
		setCurrent([monthly]);
		// Daily is now finer than the source: disabled with its reason, and
		// the stale explicit pick falls back to Auto.
		await waitFor(
			() => expect(optionByText(intervalSelect(), "Daily — source is monthly").disabled).toBe(true),
			{ timeout: 2000 },
		);
		expect(optionByText(intervalSelect(), "Auto (Monthly)").value).toBe("auto");
	});

	it("docks the crosshair date label inside the plot at the edges", () => {
		renderViewer([vixSeries()]);
		const svg = chartSvg();
		svg.focus();
		fireEvent.keyDown(svg, { key: "Home" });
		const atHome = [
			...(document.querySelector('g[data-chart-part="crosshair"]')?.querySelectorAll("text") ?? []),
		].find((text) => text.textContent === "2026-10-06");
		expect(atHome?.getAttribute("text-anchor")).toBe("start");
		expect(Number(atHome?.getAttribute("x"))).toBeGreaterThanOrEqual(8);
		fireEvent.keyDown(svg, { key: "End" });
		const atEnd = [
			...(document.querySelector('g[data-chart-part="crosshair"]')?.querySelectorAll("text") ?? []),
		].find((text) => text.textContent === "2026-10-08");
		expect(atEnd?.getAttribute("text-anchor")).toBe("end");
	});

	it("sizes the sheet to the viewport and gives the chart the remaining height", () => {
		const css = appStylesheet();
		expect(css).toContain("--width: calc(100vw - 2rem)");
		expect(css).not.toContain("72rem");
		expect(css).toMatch(/\.chart-viewer::part\(panel\)[^}]*height: calc\(100dvh - 2rem\)/s);
		expect(css).toMatch(/\.chart-viewer-main[^}]*flex: 1/s);
		expect(css).toMatch(/\.chart-viewer-main[^}]*min-height: 16rem/s);
	});

	it("declares touch-action none on both gesture surfaces", () => {
		renderViewer([vixSeries()]);
		const css = appStylesheet();
		expect(css).toMatch(/\.chart-viewer-gesture[^}]*touch-action: none/s);
		expect(document.querySelectorAll("svg.chart-viewer-gesture").length).toBe(2);
		expect(document.querySelector("svg[style]")).toBeNull();
	});
});
