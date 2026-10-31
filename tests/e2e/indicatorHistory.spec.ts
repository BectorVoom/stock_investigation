import { expect, type Locator, type Page, test } from "@playwright/test";
import { homeDashboardResponseSchema, materialImportSchema } from "@research/contracts";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * The Indicator table's history (ADR-0044 §1) end to end: two imported
 * material series (database-only, so no provider and no runner is involved)
 * on a wide and a narrow Indicator table. The wide table shows each row's
 * Trend sparkline with its range (5Y for the monthly series, 1Y for the
 * daily one); the narrow one hides the Trend column by its container width
 * (asserted on computed layout, not classes); a tap on a row name opens the
 * detailed chart viewer at that row's range. The dashboard is restored
 * afterwards for the specs that share this database.
 */
test.describe.configure({ mode: "serial" });

const HEADERS = {
	Origin: E2E_ORIGIN,
	"X-Research-Csrf": "1",
	"Content-Type": "application/json",
};

const MONTHLY_ID = "materials:IHMONTHLY";
const DAILY_ID = "materials:IHDAILY";

/** `count` month starts ending 2026-09-01, rising by 1.25 each. */
interface Observation {
	readonly observedOn: string;
	readonly valueDecimal: string;
	readonly materialsSourceUpdatedAt: string;
}

/** The import's decimal text: two places at most, no trailing zeros ("101.5", "100"). */
function canonicalDecimal(value: number): string {
	return String(Number(value.toFixed(2)));
}

/** The source's own update time of every synthetic observation. */
const SOURCE_UPDATED_AT = "2026-10-30T10:00:00.000Z";

function monthlyObservations(count: number): Observation[] {
	return Array.from({ length: count }, (_, index) => {
		const date = new Date(Date.UTC(2026, 8 - (count - 1 - index), 1));
		return {
			observedOn: date.toISOString().slice(0, 10),
			valueDecimal: canonicalDecimal(100 + index * 1.25),
			materialsSourceUpdatedAt: SOURCE_UPDATED_AT,
		};
	});
}

/** `count` days ending 2026-10-30, falling by 0.05 each. */
function dailyObservations(count: number): Observation[] {
	const last = Date.UTC(2026, 9, 30);
	return Array.from({ length: count }, (_, index) => {
		const date = new Date(last - (count - 1 - index) * 86_400_000);
		return {
			observedOn: date.toISOString().slice(0, 10),
			valueDecimal: canonicalDecimal(90 - index * 0.05),
			materialsSourceUpdatedAt: SOURCE_UPDATED_AT,
		};
	});
}

const IMPORT = materialImportSchema.parse({
	schemaVersion: 1,
	series: [
		{
			seriesId: MONTHLY_ID,
			material: "Lithium",
			product: "Lithium carbonate",
			grade: "Synthetic battery grade",
			basis: "Synthetic monthly average",
			sourceId: "synthetic-ih",
			title: "Synthetic lithium carbonate (monthly)",
			unit: "USD/t",
			frequency: "monthly",
			publisher: "Synthetic indicator source",
			sourceUrl: "https://example.com/materials/lithium",
			retrievedAt: "2026-10-30T12:00:00.000Z",
			observations: monthlyObservations(120),
		},
		{
			seriesId: DAILY_ID,
			material: "Cobalt",
			product: "Cobalt metal",
			grade: "Synthetic 99.8%",
			basis: "Synthetic daily close",
			sourceId: "synthetic-ih",
			title: "Synthetic cobalt metal (daily)",
			unit: "USD/kg",
			frequency: "daily",
			publisher: "Synthetic indicator source",
			sourceUrl: "https://example.com/materials/cobalt",
			retrievedAt: "2026-10-30T12:00:00.000Z",
			observations: dailyObservations(500),
		},
	],
});

let page: Page;
let restore: { version: number; widgets: unknown } | null = null;

test.beforeAll(async ({ browser }) => {
	page = await browser.newPage();
	await page.setViewportSize({ width: 1280, height: 900 });
	const imported = await page.request.post(`${E2E_ORIGIN}/api/v1/materials/imports`, {
		headers: HEADERS,
		data: IMPORT,
	});
	expect(imported.status()).toBe(201);
	const read = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	const stored = homeDashboardResponseSchema.parse(await read.json());
	restore = { version: stored.version, widgets: stored.dashboard.widgets };
	const saved = await page.request.put(`${E2E_ORIGIN}/api/v1/home/dashboard`, {
		headers: HEADERS,
		data: {
			expectedVersion: stored.version,
			dashboard: {
				schemaVersion: 2,
				widgets: [
					{
						widgetId: "ih-wide",
						type: "indicator-table",
						title: "Indicator history",
						size: "large",
						seriesIds: [MONTHLY_ID, DAILY_ID],
					},
					{
						widgetId: "ih-medium",
						type: "indicator-table",
						title: "Medium indicators",
						size: "medium",
						seriesIds: [MONTHLY_ID, DAILY_ID],
					},
					{
						widgetId: "ih-narrow",
						type: "indicator-table",
						title: "Narrow indicators",
						size: "small",
						seriesIds: [MONTHLY_ID],
					},
				],
			},
		},
	});
	expect(saved.ok()).toBe(true);
});

test.afterAll(async () => {
	if (restore !== null) {
		const read = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
		const stored = homeDashboardResponseSchema.parse(await read.json());
		await page.request.put(`${E2E_ORIGIN}/api/v1/home/dashboard`, {
			headers: HEADERS,
			data: {
				expectedVersion: stored.version,
				dashboard: { schemaVersion: 2, widgets: restore.widgets },
			},
		});
	}
	await page.close();
});

function viewer(): Locator {
	return page.locator("sl-dialog.chart-viewer");
}

async function viewerRange(): Promise<{ from: string; to: string }> {
	return page.evaluate(() => {
		const inputs = [
			...document.querySelectorAll("sl-dialog.chart-viewer input[type='date']"),
		].filter((input): input is HTMLInputElement => input instanceof HTMLInputElement);
		const [from, to] = [inputs[0], inputs[1]];
		if (from === undefined || to === undefined) throw new Error("no From/To inputs");
		return { from: from.value, to: to.value };
	});
}

/** The computed `display` of the Trend header and cells of one widget's table. */
async function trendDisplays(widget: Locator): Promise<string[]> {
	return widget.evaluate((article) =>
		[...article.querySelectorAll("thead th:nth-child(7), [data-field='indicator-trend']")].map(
			(cell) => getComputedStyle(cell).display,
		),
	);
}

test("a wide Indicator table draws each row's Trend with its range", async () => {
	await page.goto("/#/home");
	const wide = page.locator('article[data-widget-id="ih-wide"]');
	await expect(wide).toContainText("Synthetic lithium carbonate (monthly)");
	const header = wide.getByRole("columnheader", { name: "Trend", exact: true });
	await expect(header).toBeVisible();
	expect(await trendDisplays(wide)).toEqual(["table-cell", "table-cell", "table-cell"]);
	const monthly = wide.locator("[data-field='indicator-trend'][data-trend-preset='5y']");
	// The range name is shown; the direction over it is what a screen reader hears.
	await expect(monthly.locator("span[aria-hidden='true']")).toHaveText("5Y");
	await expect(monthly.locator(".sr-only")).toHaveText("up over 5 years");
	const monthlyLine = monthly.locator("svg[data-sparkline-direction='up']");
	await expect(monthlyLine).toBeVisible();
	const box = await monthlyLine.boundingBox();
	expect(box?.width).toBe(72);
	expect(box?.height).toBe(24);
	const daily = wide.locator("[data-field='indicator-trend'][data-trend-preset='1y']");
	await expect(daily.locator("span[aria-hidden='true']")).toHaveText("1Y");
	await expect(daily.locator(".sr-only")).toHaveText("down over 1 year");
	await expect(daily.locator("svg[data-sparkline-direction='down']")).toBeVisible();
	await wide.screenshot({ path: "test-results/indicator-history-wide-en.png" });
});

test("a narrow Indicator table hides the Trend column by its container width", async () => {
	const narrow = page.locator('article[data-widget-id="ih-narrow"]');
	await expect(narrow).toContainText("Synthetic lithium carbonate (monthly)");
	expect(await trendDisplays(narrow)).toEqual(["none", "none"]);
	await expect(narrow.getByRole("columnheader", { name: "Trend", exact: true })).toBeHidden();
	// The rest of the row still shows.
	await expect(narrow.getByRole("columnheader", { name: "Latest value" })).toBeVisible();
	await narrow.screenshot({ path: "test-results/indicator-history-narrow-en.png" });
});

test("a Medium Indicator table hides the Trend column and keeps Source in view", async () => {
	const medium = page.locator('article[data-widget-id="ih-medium"]');
	await expect(medium).toContainText("Synthetic lithium carbonate (monthly)");
	const layout = await medium.evaluate((article) => {
		const table = article.querySelector("table");
		const scroller = table?.parentElement;
		if (!(table instanceof HTMLElement) || !(scroller instanceof HTMLElement)) {
			throw new Error("no table");
		}
		return {
			visible: scroller.clientWidth,
			table: table.scrollWidth,
			trend: [
				...table.querySelectorAll("thead th:nth-child(7), [data-field='indicator-trend']"),
			].map((cell) => getComputedStyle(cell).display),
		};
	});
	// A Medium frame has no room for the Trend column (measured: 697 px of
	// table in a 582 px frame, Source cut off): hidden there, and every other
	// column, Source included, fits without scrolling.
	expect(layout.trend).toEqual(["none", "none", "none"]);
	expect(layout.table).toBeLessThanOrEqual(layout.visible);
	const source = medium.getByRole("columnheader", { name: "Source", exact: true });
	await expect(source).toBeInViewport({ ratio: 1 });
	await medium.screenshot({ path: "test-results/indicator-history-medium-en.png" });
});

test("a row name opens the chart viewer at the row's Trend range", async () => {
	const wide = page.locator('article[data-widget-id="ih-wide"]');
	await wide.getByRole("button", { name: /^Open chart:\s*Synthetic lithium carbonate/ }).click();
	await expect(viewer()).toBeVisible();
	await expect(viewer().getByRole("button", { name: "5Y", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(await viewerRange()).toEqual({ from: "2021-09-01", to: "2026-09-01" });
	await page.keyboard.press("Escape");
	await expect(viewer()).toBeHidden();

	await wide.getByRole("button", { name: /^Open chart:\s*Synthetic cobalt metal/ }).click();
	await expect(viewer()).toBeVisible();
	await expect(viewer().getByRole("button", { name: "1Y", exact: true })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	expect(await viewerRange()).toEqual({ from: "2025-10-30", to: "2026-10-30" });
	await page.keyboard.press("Escape");
	await expect(viewer()).toBeHidden();
});

test("the Trend column reads in Japanese", async ({ browser }) => {
	const context = await browser.newContext({
		locale: "ja-JP",
		viewport: { width: 1280, height: 900 },
	});
	const ja = await context.newPage();
	try {
		await ja.goto(`${E2E_ORIGIN}/#/home`);
		const wide = ja.locator('article[data-widget-id="ih-wide"]');
		await expect(wide.getByRole("columnheader", { name: "推移", exact: true })).toBeVisible();
		await expect(
			wide.locator(
				"[data-field='indicator-trend'][data-trend-preset='5y'] span[aria-hidden='true']",
			),
		).toHaveText("5年");
		await wide.screenshot({ path: "test-results/indicator-history-wide-ja.png" });
	} finally {
		await context.close();
	}
});
