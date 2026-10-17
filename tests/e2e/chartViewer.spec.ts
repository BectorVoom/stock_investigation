import { expect, type Page, test } from "@playwright/test";

/**
 * Detailed chart viewer end to end (ADR-0025): Home renders fixture market
 * data through the real runner loop (`marketFixtures.ts`), the line chart's
 * plot opens the viewer with the widget's series, and every control works on
 * exactly that held data — presets, custom From/To, intervals, wheel zoom,
 * the navigator, keyboard readout, Escape with focus return — plus the metric
 * entry point. Read-only: nothing here saves, so the dashboard is untouched
 * for the other specs sharing this database.
 */
test.describe.configure({ mode: "serial" });

let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await page.setViewportSize({ width: 1280, height: 720 });
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterAll(async () => {
	await page.close();
});

/** Sets a Shoelace control's value the way its `sl-*` listener expects. */
async function setSlValue(selector: string, value: string): Promise<void> {
	await page.evaluate(
		([sel, val]) => {
			const element = document.querySelector(sel);
			if (!(element instanceof HTMLElement)) throw new Error(`missing ${sel}`);
			Object.assign(element, { value: val });
			element.dispatchEvent(new Event("sl-change", { bubbles: true, composed: true }));
		},
		[selector, value] as [string, string],
	);
}

function viewer() {
	return page.locator("sl-dialog.chart-viewer");
}

async function rangeValues(): Promise<{ from: string; to: string }> {
	return page.evaluate(() => {
		const inputs = [
			...document.querySelectorAll("sl-dialog.chart-viewer input[type='date']"),
		].filter((input): input is HTMLInputElement => input instanceof HTMLInputElement);
		const [from, to] = [inputs[0], inputs[1]];
		if (from === undefined || to === undefined) throw new Error("no From/To inputs");
		return { from: from.value, to: to.value };
	});
}

async function tableRowCount(): Promise<number> {
	return viewer().locator("details", { hasText: "Data table:" }).locator("tbody tr").count();
}

test("fixture market data loads and the line chart opens the viewer filling the viewport", async () => {
	test.setTimeout(180_000);
	await page.goto("/#/home");
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();
	const status = page.locator('[data-field="home-status"]');
	await expect(status).toBeVisible({ timeout: 20_000 });
	if (!((await status.textContent()) ?? "").includes("Last successful refresh:")) {
		await page.getByRole("button", { name: "Refresh market data" }).click();
		await expect(status).toContainText("Last successful refresh:", { timeout: 120_000 });
	}
	const chart = page.locator('article[data-widget-id="w-vix-chart"]');
	await expect(chart.getByRole("img", { name: /Line chart: VIX/ })).toBeVisible();

	const open = chart.getByRole("button", { name: /^Open chart: Line chart: VIX\./ });
	await open.click();
	const dialog = viewer();
	await expect(dialog).toBeVisible();

	// The sheet fills the viewport minus a 1rem margin on every side.
	const panel = await page.evaluate(() => {
		const host = document.querySelector("sl-dialog.chart-viewer");
		const root = (host as unknown as { shadowRoot: ShadowRoot | null } | null)?.shadowRoot;
		const panelElement = root?.querySelector('[part="panel"]');
		if (!(panelElement instanceof HTMLElement)) throw new Error("no viewer panel");
		const rect = panelElement.getBoundingClientRect();
		return { width: rect.width, height: rect.height };
	});
	expect(panel.width).toBeGreaterThanOrEqual(1230);
	expect(panel.width).toBeLessThanOrEqual(1280);
	expect(panel.height).toBeGreaterThanOrEqual(660);
	expect(panel.height).toBeLessThanOrEqual(720);

	// The VIX fixture holds 2026-10-02…2026-10-08; the widget range (1y) is
	// the opening preset, clamped to the held data.
	await expect(dialog).toContainText("CBOE Volatility Index: VIX");
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });

	// A screenshot of the open viewer, for reading the layout. Chromium
	// only: Playwright's WebKit screenshot injects a <style> the app's CSP
	// refuses, which would log a console error this spec fails on.
	if (page.context().browser()?.browserType().name() === "chromium") {
		await page.screenshot({ path: test.info().outputPath("chart-viewer-open.png") });
	}
});

test("presets 1M then 1Y keep the clamped window, custom From/To narrows it", async () => {
	const dialog = viewer();
	await expect(dialog).toBeVisible();

	await dialog.getByRole("button", { name: "1M", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "1M", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	// Five days of data cannot fill a month: the window stays clamped.
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });

	await dialog.getByRole("button", { name: "1Y", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "1Y", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });

	// The precise control: any day within the held data.
	await dialog.getByLabel("From", { exact: true }).fill("2026-10-05");
	await dialog.getByLabel("To", { exact: true }).fill("2026-10-07");
	expect(await rangeValues()).toEqual({ from: "2026-10-05", to: "2026-10-07" });
	const stats = dialog.locator('section[aria-label="Statistics for the visible window"]');
	await expect(stats.getByRole("row", { name: /CBOE Volatility Index/ })).toContainText("3");

	// An invalid custom range is refused with an inline message.
	await dialog.getByLabel("From", { exact: true }).fill("2026-10-08");
	await expect(dialog.getByRole("alert")).toContainText("The From date is after the To date");
	expect(await rangeValues()).toEqual({ from: "2026-10-05", to: "2026-10-07" });
});

test("Weekly intervals show fewer bars in the data table", async () => {
	const dialog = viewer();
	await dialog.getByRole("button", { name: "Max" }).click();
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });

	const twin = dialog.locator("details", { hasText: "Data table:" });
	const twinOpen = await twin.evaluate((element) => (element as HTMLDetailsElement).open);
	if (!twinOpen) await twin.locator("summary").click();
	// The twin builds its rows on the `toggle` event, which fires after the
	// click resolves: wait for them instead of counting at once.
	await expect.poll(async () => tableRowCount(), { timeout: 10_000 }).toBe(5);
	const dailyRows = await tableRowCount();

	await setSlValue('sl-dialog.chart-viewer sl-select[label="Interval"]', "weekly");
	await expect.poll(async () => tableRowCount(), { timeout: 10_000 }).toBeLessThan(dailyRows);
	// 2026-10-02 is one ISO week, 2026-10-05…08 the next: two weekly bars.
	expect(await tableRowCount()).toBe(2);
});

test("wheel zoom narrows the window and dragging the navigator pans it", async () => {
	const dialog = viewer();
	await dialog.getByRole("button", { name: "Max" }).click();
	await setSlValue('sl-dialog.chart-viewer sl-select[label="Interval"]', "daily");
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });

	// The open data-table twin below the chart would swallow the hover, so
	// it is collapsed first.
	const twin = dialog.locator("details", { hasText: "Data table:" });
	if (await twin.evaluate((element) => (element as HTMLDetailsElement).open)) {
		await twin.locator("summary").click();
	}

	const chartSvg = dialog.locator('svg[aria-roledescription="interactive chart"]');
	await chartSvg.scrollIntoViewIfNeeded();
	// A synthetic wheel event at the chart centre: raw `mouse.wheel` routing
	// through the dialog overlay proved flaky, while this exercises the same
	// native wheel handler (anchor from the pointer coordinates, one zoom
	// step per event) deterministically.
	const chartBox = await chartSvg.boundingBox();
	if (chartBox === null) throw new Error("the viewer chart has no box");
	const before = await rangeValues();
	await chartSvg.dispatchEvent("wheel", {
		deltaY: -240,
		clientX: chartBox.x + chartBox.width / 2,
		clientY: chartBox.y + chartBox.height / 2,
	});
	await expect.poll(async () => rangeValues(), { timeout: 10_000 }).not.toEqual(before);
	const zoomed = await rangeValues();
	expect(zoomed.from >= before.from).toBe(true);
	expect(zoomed.to <= before.to).toBe(true);

	// Dragging the navigator window pans it with the same span. The zoom
	// above left the window against the newest edge, so the drag goes left,
	// where held data still has room.
	const windowBox = await page.evaluate(() => {
		const svg = document.querySelector('section[aria-label="Overview"] svg');
		const windowRect = svg?.querySelector('rect[fill-opacity="0.12"]');
		if (!(windowRect instanceof SVGRectElement)) throw new Error("no navigator window");
		const box = windowRect.getBoundingClientRect();
		return { x: box.x, y: box.y, width: box.width, height: box.height };
	});
	expect(windowBox.width).toBeGreaterThan(10);
	await page.mouse.move(windowBox.x + windowBox.width / 2, windowBox.y + windowBox.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		windowBox.x + windowBox.width / 2 - 150,
		windowBox.y + windowBox.height / 2,
		{
			steps: 10,
		},
	);
	await page.mouse.up();
	await expect.poll(async () => rangeValues(), { timeout: 10_000 }).not.toEqual(zoomed);
});

test("keyboard arrows move the readout and Escape closes with focus return", async () => {
	const dialog = viewer();
	const chartSvg = dialog.locator('svg[aria-roledescription="interactive chart"]');
	await chartSvg.focus();
	await page.keyboard.press("ArrowRight");
	const readout = dialog.locator('section[aria-label="Chart"] p[data-chart-part="readout"]');
	await expect(readout).not.toContainText("Point at the chart");
	const first = await readout.textContent();
	expect(first).toContain("2026-");
	// The keyboard move is announced in the polite live region.
	await expect(dialog.locator('p[aria-live="polite"]', { hasText: "2026-" })).toContainText(
		(first ?? "").slice(0, 20),
	);

	const opener = page
		.locator('article[data-widget-id="w-vix-chart"]')
		.getByRole("button", { name: /^Open chart: Line chart: VIX\./ });
	await page.keyboard.press("Escape");
	await expect(viewer()).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test("a metric widget opens the viewer with its series", async () => {
	const metric = page.locator('article[data-widget-id="w-vix"]');
	await metric.getByRole("button", { name: /^Open chart: CBOE Volatility Index: VIX, / }).click();
	const dialog = viewer();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("CBOE Volatility Index: VIX");
	// The metric entry point always opens at the 1y preset.
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });
	await page.keyboard.press("Escape");
	await expect(viewer()).toHaveCount(0);
	await expect(
		metric.getByRole("button", { name: /^Open chart: CBOE Volatility Index: VIX, / }),
	).toBeFocused();
});

/**
 * Opens the viewer from the line-chart widget at the given viewport size,
 * ready for layout assertions (dialog visible, opening preset applied).
 */
async function openViewerAt(width: number, height: number): Promise<void> {
	await page.setViewportSize({ width, height });
	if ((await viewer().count()) > 0) {
		await page.keyboard.press("Escape");
		await expect(viewer()).toHaveCount(0);
	}
	const chart = page.locator('article[data-widget-id="w-vix-chart"]');
	await expect(chart.getByRole("img", { name: /Line chart: VIX/ })).toBeVisible();
	await chart.getByRole("button", { name: /^Open chart: Line chart: VIX\./ }).click();
	await expect(viewer()).toBeVisible();
	await expect(viewer()).toContainText("CBOE Volatility Index: VIX");
}

/** Visible y tick labels that intersect a last-value tag (round-4 defect: "15.41" on "15.4"). */
async function tickTagOverlaps(): Promise<readonly string[]> {
	return page.evaluate(() => {
		const svg = document.querySelector('svg[aria-roledescription="interactive chart"]');
		if (!(svg instanceof SVGSVGElement)) throw new Error("no main chart svg");
		const boxOf = (element: Element): DOMRect | null => {
			if (!(element instanceof SVGElement)) return null;
			const box = element.getBoundingClientRect();
			return box.width === 0 && box.height === 0 ? null : box;
		};
		const ticks = [...svg.querySelectorAll('g[data-chart-part="y-axis"] text')];
		const tags = [...svg.querySelectorAll('g[data-chart-part="last-value-tag"]')];
		const bad: string[] = [];
		for (const tick of ticks) {
			const tickBox = boxOf(tick);
			if (tickBox === null) continue;
			for (const tag of tags) {
				const tagBox = boxOf(tag);
				if (tagBox === null) continue;
				const separated =
					tickBox.right <= tagBox.left ||
					tagBox.right <= tickBox.left ||
					tickBox.bottom <= tagBox.top ||
					tagBox.bottom <= tickBox.top;
				if (!separated) bad.push(`${tick.textContent ?? ""} vs ${tag.textContent ?? ""}`);
			}
		}
		return bad;
	});
}

/** Left/right edge gaps between the main and navigator SVGs, plus the navigator's letterbox check. */
async function navigatorAlignment(): Promise<{
	readonly leftGap: number;
	readonly rightGap: number;
	readonly viewBoxWidth: number;
	readonly elementWidth: number;
}> {
	return page.evaluate(() => {
		const main = document.querySelector('svg[aria-roledescription="interactive chart"]');
		const nav = document.querySelector('section[aria-label="Overview"] svg');
		if (!(main instanceof SVGSVGElement) || !(nav instanceof SVGSVGElement)) {
			throw new Error("missing chart section");
		}
		const mainBox = main.getBoundingClientRect();
		const navBox = nav.getBoundingClientRect();
		const viewBox = nav.viewBox.baseVal;
		return {
			leftGap: Math.abs(mainBox.left - navBox.left),
			rightGap: Math.abs(mainBox.right - navBox.right),
			viewBoxWidth: viewBox.width,
			elementWidth: navBox.width,
		};
	});
}

/** Bounding boxes of every painted mark of the main chart outside its SVG (1px tolerance). */ async function marksOutsideMainSvg(): Promise<
	readonly string[]
> {
	return page.evaluate(() => {
		const svg = document.querySelector('svg[aria-roledescription="interactive chart"]');
		if (!(svg instanceof SVGSVGElement)) throw new Error("no main chart svg");
		const frame = svg.getBoundingClientRect();
		const bad: string[] = [];
		const marks = svg.querySelectorAll("path, circle");
		marks.forEach((mark, index) => {
			const box = mark.getBoundingClientRect();
			if (box.width === 0 && box.height === 0) return;
			const tag = mark.tagName.toLowerCase();
			if (
				box.left < frame.left - 1 ||
				box.right > frame.right + 1 ||
				box.top < frame.top - 1 ||
				box.bottom > frame.bottom + 1
			) {
				bad.push(`${tag}[${index}]`);
			}
		});
		return bad;
	});
}

/** Overlapping pairs among the main SVG, the navigator SVG and the stats table. */
async function overlappingSections(): Promise<readonly string[]> {
	return page.evaluate(() => {
		const rectOf = (selector: string): DOMRect | null => {
			const element = document.querySelector(selector);
			return element instanceof Element ? element.getBoundingClientRect() : null;
		};
		const main = rectOf('svg[aria-roledescription="interactive chart"]');
		const nav = rectOf('section[aria-label="Overview"] svg');
		const stats = rectOf('section[aria-label="Statistics for the visible window"] table');
		if (main === null || nav === null || stats === null) throw new Error("missing layout section");
		const overlaps = (a: DOMRect, b: DOMRect): boolean =>
			!(
				a.bottom <= b.top + 1 ||
				b.bottom <= a.top + 1 ||
				a.right <= b.left + 1 ||
				b.right <= a.left + 1
			);
		const bad: string[] = [];
		if (overlaps(main, nav)) bad.push("main/nav");
		if (overlaps(main, stats)) bad.push("main/stats");
		if (overlaps(nav, stats)) bad.push("nav/stats");
		return bad;
	});
}

async function yCoverage(): Promise<{
	readonly covers: boolean;
	readonly tickMin: number | null;
	readonly tickMax: number | null;
	readonly dataMin: number | null;
	readonly dataMax: number | null;
}> {
	return page.evaluate(() => {
		const numbers = (text: string | null): number | null => {
			if (text === null) return null;
			const cleaned = text.replace("%", "").trim();
			const value = Number.parseFloat(cleaned);
			return Number.isFinite(value) ? value : null;
		};
		const tickTexts = [
			...document.querySelectorAll(
				'svg[aria-roledescription="interactive chart"] g[data-chart-part="y-axis"] text',
			),
		].map((node) => numbers(node.textContent));
		const ticks = tickTexts.filter((value): value is number => value !== null);
		// Statistics columns: Series(th) Open Close Change %change High Low Average MaxDD Bars.
		const rows = [
			...document.querySelectorAll(
				'section[aria-label="Statistics for the visible window"] tbody tr',
			),
		];
		const highs: number[] = [];
		const lows: number[] = [];
		for (const row of rows) {
			const cells = [...row.querySelectorAll("td")].map((cell) => cell.textContent);
			const high = numbers(cells[4]?.split(" ").at(0) ?? null);
			const low = numbers(cells[5]?.split(" ").at(0) ?? null);
			if (high !== null) highs.push(high);
			if (low !== null) lows.push(low);
		}
		const tickMin = ticks.length > 0 ? Math.min(...ticks) : null;
		const tickMax = ticks.length > 0 ? Math.max(...ticks) : null;
		const dataMin = lows.length > 0 ? Math.min(...lows) : null;
		const dataMax = highs.length > 0 ? Math.max(...highs) : null;
		const epsilon = 1e-9;
		const covers =
			tickMin !== null && tickMax !== null && dataMin !== null && dataMax !== null
				? tickMin <= dataMin + epsilon && tickMax >= dataMax - epsilon
				: false;
		return { covers, tickMin, tickMax, dataMin, dataMax };
	});
}

async function visibleXTickCount(): Promise<number> {
	return page.evaluate(() => {
		const svg = document.querySelector('svg[aria-roledescription="interactive chart"]');
		if (!(svg instanceof SVGSVGElement)) throw new Error("no main chart svg");
		const labels = svg.querySelectorAll('g[data-chart-part="x-axis"] text');
		let count = 0;
		labels.forEach((label) => {
			const box = label.getBoundingClientRect();
			if ((label.textContent ?? "").trim() !== "" && box.width > 0 && box.height > 0) count += 1;
		});
		return count;
	});
}

/** Visible date-axis labels of the main chart (fix round 5: never repeated). */
async function visibleXTickLabels(): Promise<readonly string[]> {
	return page.evaluate(() => {
		const svg = document.querySelector('svg[aria-roledescription="interactive chart"]');
		if (!(svg instanceof SVGSVGElement)) throw new Error("no main chart svg");
		const labels: string[] = [];
		svg.querySelectorAll('g[data-chart-part="x-axis"] text').forEach((label) => {
			const box = label.getBoundingClientRect();
			const text = (label.textContent ?? "").trim();
			if (text !== "" && box.width > 0 && box.height > 0) labels.push(text);
		});
		return labels;
	});
}

/**
 * The layout regression for the viewer (round-3 overflow defect): every mark
 * paints inside the main SVG, the main chart / navigator / statistics stack
 * without overlap, the y ticks cover the visible data range, and the date
 * axis labels render — at desktop and phone viewports alike. Round 5 adds
 * that the visible x tick labels are distinct (calendar boundaries, never
 * the repeated "Jul 2026" thinning of the old evenly spaced axis).
 */
async function expectViewerLayout(): Promise<void> {
	const dialog = viewer();
	await expect(dialog).toBeVisible();
	// The chart settles through a ResizeObserver round-trip after open and
	// viewport changes; poll until the geometry holds instead of sleeping.
	await expect.poll(async () => marksOutsideMainSvg(), { timeout: 10_000 }).toEqual([]);
	await expect.poll(async () => overlappingSections(), { timeout: 10_000 }).toEqual([]);
	// Round 4: last-value tags never sit on a tick label, and the navigator
	// spans the same horizontal range as the main chart (no letterbox).
	await expect.poll(async () => tickTagOverlaps(), { timeout: 10_000 }).toEqual([]);
	await expect
		.poll(
			async () => {
				const alignment = await navigatorAlignment();
				return (
					alignment.leftGap <= 2 &&
					alignment.rightGap <= 2 &&
					Math.abs(alignment.viewBoxWidth - alignment.elementWidth) <= 2
				);
			},
			{ timeout: 10_000 },
		)
		.toBe(true);
	const alignment = await navigatorAlignment();
	expect(alignment.leftGap).toBeLessThanOrEqual(2);
	expect(alignment.rightGap).toBeLessThanOrEqual(2);
	expect(Math.abs(alignment.viewBoxWidth - alignment.elementWidth)).toBeLessThanOrEqual(2);
	const coverage = await yCoverage();
	expect(
		coverage.covers,
		`y ticks [${coverage.tickMin}, ${coverage.tickMax}] cover data [${coverage.dataMin}, ${coverage.dataMax}]`,
	).toBe(true);
	expect(await visibleXTickCount()).toBeGreaterThanOrEqual(2);
	// Round 5: boundary ticks never repeat a label.
	const xLabels = await visibleXTickLabels();
	expect(xLabels.length).toBeGreaterThanOrEqual(2);
	expect(new Set(xLabels).size).toBe(xLabels.length);
}

test("viewer layout holds together at desktop 1280x720", async () => {
	await openViewerAt(1280, 720);
	await expectViewerLayout();
	await page.screenshot({ path: test.info().outputPath("chart-viewer-layout-1280.png") });
	await page.keyboard.press("Escape");
	await expect(viewer()).toHaveCount(0);
});

test("viewer layout holds together at phone 390x844", async () => {
	await openViewerAt(390, 844);
	await expectViewerLayout();
	await page.screenshot({ path: test.info().outputPath("chart-viewer-layout-390.png") });
	await page.keyboard.press("Escape");
	await expect(viewer()).toHaveCount(0);
	await page.setViewportSize({ width: 1280, height: 720 });
});

test("a failed chunk download shows its alert in view with Try again focused, and the opener retries", async ({
	browser,
}) => {
	// A page of its own: the blocked chunk logs network errors that are the
	// point of this test, not defects the shared page should report, and a
	// fresh page has not loaded the chunk yet.
	const failing = await browser.newPage();
	try {
		await failing.setViewportSize({ width: 1280, height: 720 });
		const chunkUrl = /\/assets\/ChartViewer-[^/]*\.js$/;
		let blocked = 0;
		await failing.route(chunkUrl, async (route) => {
			blocked += 1;
			await route.abort("internetdisconnected");
		});
		await failing.goto("/#/home");
		const open = failing
			.locator('article[data-widget-id="w-vix-chart"]')
			.getByRole("button", { name: /^Open chart: Line chart: VIX\./ });
		await expect(open).toBeVisible({ timeout: 20_000 });
		await open.click();
		// The line chart's plot is the opener; the alert is not below the
		// legend, readout and data table (off screen at 720 px) but in view.
		const alert = failing.locator("[data-chart-viewer-failure]");
		await expect(alert).toContainText("The chart viewer could not be loaded.");
		await expect(alert).toBeInViewport({ ratio: 1 });
		await expect(alert.getByRole("button", { name: "Try again" })).toBeFocused();
		// Pressing the opener again while the failure shows imports again.
		const attempts = blocked;
		await open.click();
		await expect.poll(() => blocked, { timeout: 10_000 }).toBeGreaterThan(attempts);
		await expect(alert).toBeInViewport({ ratio: 1 });
		await expect(alert.getByRole("button", { name: "Try again" })).toBeFocused();
		// The network is back: Try again opens the viewer, Escape returns focus.
		await failing.unroute(chunkUrl);
		await alert.getByRole("button", { name: "Try again" }).click();
		await expect(failing.locator("sl-dialog.chart-viewer")).toBeVisible();
		await expect(alert).toHaveCount(0);
		await failing.keyboard.press("Escape");
		await expect(failing.locator("sl-dialog.chart-viewer")).toHaveCount(0);
		await expect(open).toBeFocused();
	} finally {
		await failing.close();
	}
});

test("no console errors", async () => {
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
