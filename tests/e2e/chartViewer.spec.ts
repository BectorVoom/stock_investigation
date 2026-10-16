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

	const open = chart.getByRole("button", { name: "Open chart: VIX" });
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
	const dailyRows = await tableRowCount();
	expect(dailyRows).toBe(5);

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
		.getByRole("button", { name: "Open chart: VIX" });
	await page.keyboard.press("Escape");
	await expect(viewer()).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test("a metric widget opens the viewer with its series", async () => {
	const metric = page.locator('article[data-widget-id="w-vix"]');
	await metric.getByRole("button", { name: "Open chart: CBOE Volatility Index: VIX" }).click();
	const dialog = viewer();
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("CBOE Volatility Index: VIX");
	// The metric entry point always opens at the 1y preset.
	expect(await rangeValues()).toEqual({ from: "2026-10-02", to: "2026-10-08" });
	await page.keyboard.press("Escape");
	await expect(viewer()).toHaveCount(0);
	await expect(
		metric.getByRole("button", { name: "Open chart: CBOE Volatility Index: VIX" }),
	).toBeFocused();
});

test("no console errors", async () => {
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});
