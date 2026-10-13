import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { E2E_ORIGIN } from "./fixtures.ts";

/**
 * Home dashboard end to end (FR-017): Home is the landing page, a
 * market-data refresh runs through the REAL runner loop with the REAL FRED
 * and Twelve Data adapters served from REAL recorded provider responses
 * (`tests/e2e/marketFixtures.ts` — fixtures, never live data), widgets show
 * the fixture numbers with unit, as-of date and source, and an added widget
 * survives a reload until it is removed.
 */
test.describe.configure({ mode: "serial" });

let browserRef: Browser;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
	browserRef = browser;
	page = await browser.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterAll(async () => {
	await page.close();
});

/** Sets a Shoelace control's value the way its `sl-*` listener expects. */
async function setSlValue(selector: string, value: string | readonly string[]): Promise<void> {
	await page.evaluate(
		([sel, val]) => {
			const element = document.querySelector(sel);
			if (!(element instanceof HTMLElement)) throw new Error(`missing ${sel}`);
			Object.assign(element, { value: val });
			element.dispatchEvent(new Event("sl-change", { bubbles: true, composed: true }));
		},
		[selector, value] as [string, string | readonly string[]],
	);
}

/**
 * F1/F2: clicks a Shoelace select's shadow combobox at its center with real
 * mouse events — what a person clicks. (Clicking the select host's center
 * can land on the label, which opens nothing, and CSS cannot pierce shadow
 * roots.) Resolves only once the listbox reports open, so the test never
 * proceeds with a select that missed.
 */
async function openSelectViaCombobox(
	target: Page,
	scope: string,
	selectLabel: string,
): Promise<void> {
	const point = await target.evaluate(
		([scopeSelector, label]) => {
			const scope =
				scopeSelector === "dialog" ? document : (document.querySelector(scopeSelector) ?? document);
			const select = scope.querySelector(`sl-select[label="${label}"]`);
			const root = (select as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null)?.shadowRoot;
			const combo = (root?.querySelector('[part="combobox"]') as HTMLElement | null) ?? null;
			if (combo === null) return null;
			const rect = combo.getBoundingClientRect();
			return [rect.x + rect.width / 2, rect.y + rect.height / 2];
		},
		[scope, selectLabel] as [string, string],
	);
	if (point === null) throw new Error(`no combobox for select ${selectLabel}`);
	await target.mouse.click(point[0] ?? 0, point[1] ?? 0);
	await target.waitForFunction(
		([scopeSelector, label]) => {
			const root =
				scopeSelector === "dialog" ? document : (document.querySelector(scopeSelector) ?? document);
			const sel = root.querySelector(`sl-select[label="${label}"]`);
			return sel !== null && (sel as unknown as { open: boolean }).open === true;
		},
		[scope, selectLabel] as [string, string],
		{ timeout: 10_000 },
	);
}

/** F1/F2: resolves once the select's listbox reports closed (or is gone). */
async function waitSelectClosed(target: Page, scope: string, selectLabel: string): Promise<void> {
	await target.waitForFunction(
		([scopeSelector, label]) => {
			const root =
				scopeSelector === "dialog" ? document : (document.querySelector(scopeSelector) ?? document);
			const sel = root.querySelector(`sl-select[label="${label}"]`);
			// A missing select means its dialog closed — let the dialog
			// assertion after this report that instead of timing out here.
			if (sel === null) return true;
			return (sel as unknown as { open: boolean }).open === false;
		},
		[scope, selectLabel] as [string, string],
		{ timeout: 10_000 },
	);
}

test("Home is the landing page and the first navigation item", async () => {
	await page.goto("/");
	await expect(page.getByRole("heading", { level: 1, name: "Research workspace" })).toBeVisible();
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();
	const nav = page.getByRole("navigation", { name: "Views" });
	const items = nav.getByRole("link");
	await expect(items.first()).toHaveText("Home");
	await expect(items.first()).toHaveAttribute("aria-current", "page");

	// An unknown hash opens Home too; chat links keep working.
	await page.goto("/#/nope");
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();
	await page.goto("/#/chat");
	await expect(page.getByRole("heading", { level: 2, name: "Chat" })).toBeVisible();
});

test("a market-data refresh runs through the real runner loop and widgets show fixture numbers", async () => {
	test.setTimeout(180_000);
	await page.goto("/#/home");
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();

	await page.getByRole("button", { name: "Refresh market data" }).click();
	const status = page.locator('[data-field="home-status"]');
	await expect(status).toContainText("Refreshing market data…", { timeout: 30_000 });
	await expect(status).toContainText("Last successful refresh:", { timeout: 120_000 });

	// VIX (FRED recorded response): latest close with unit, as-of date and source.
	const vix = page.locator('article[data-widget-id="w-vix"]');
	await expect(vix).toContainText("15.41");
	await expect(vix).toContainText("Index");
	await expect(vix).toContainText("2026-10-08");
	await expect(vix).toContainText("Federal Reserve Bank of St. Louis (FRED)");
	await expect(
		vix.getByRole("link", { name: "Federal Reserve Bank of St. Louis (FRED)" }),
	).toHaveAttribute("href", "https://fred.stlouisfed.org/series/VIXCLS");

	// Gold (Twelve Data recorded response).
	const gold = page.locator('article[data-widget-id="w-gold"]');
	await expect(gold).toContainText("4,168.44");
	await expect(gold).toContainText("USD per XAU (troy ounce of gold)");

	// Watchlist (Twelve Data recorded AAPL close).
	const watchlist = page.locator('article[data-widget-id="w-watchlist"]');
	await expect(watchlist.getByRole("row", { name: /AAPL/ })).toContainText("336.64");

	// The line chart drew from the fixture points and twins its data table.
	const chart = page.locator('article[data-widget-id="w-vix-chart"]');
	await expect(chart.getByRole("img", { name: /Line chart: VIX/ })).toBeVisible();
	await expect(chart.locator("path").first()).toBeVisible();

	// FRED attribution whenever a FRED series is shown.
	await expect(page.locator("body")).toContainText(
		"This product uses the FRED® API but is not endorsed or certified",
	);
});

test("an added widget survives a reload until it is removed", async () => {
	test.setTimeout(120_000);
	const title = `E2E gold ${Date.now()}`;
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();

	await page.getByRole("button", { name: "Add widget" }).click();
	const dialog = page.locator("sl-dialog", { hasText: "Add widget" });
	await expect(dialog).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await setSlValue('sl-dialog sl-select[label="Series"]', "twelve-data:XAU/USD");
	await dialog.getByRole("button", { name: "Add widget" }).click();
	const added = page.getByRole("article", {
		name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await expect(added).toContainText("4,168.44", { timeout: 30_000 });

	await page.reload();
	await expect(page.getByRole("article", { name: title })).toContainText("4,168.44");

	await page
		.getByRole("article", { name: title })
		.getByRole("button", { name: `${title} actions` })
		.click();
	await page.getByRole("menuitem", { name: "Remove widget" }).click();
	await expect(page.getByRole("article", { name: title })).toHaveCount(0);

	await page.reload();
	await expect(page.getByRole("article", { name: title })).toHaveCount(0);
});

/**
 * H1: the widget dialog survives real select interaction. Every Shoelace
 * event bubbles and is composed, and sl-select emits sl-after-hide whenever
 * its listbox closes — choosing an option the way a person does (clicking
 * the select, then the option) must not close the dialog or throw the form
 * away. Covered for the mouse path on every dialog select, the chart's range
 * select, and the keyboard path.
 */
test("H1: the dialog stays open through real mouse and keyboard select use", async () => {
	test.setTimeout(180_000);
	const title = `E2E H1 ${Date.now()}`;
	async function dialogAttached(): Promise<void> {
		await expect(page.locator("sl-dialog", { hasText: "Add widget" })).toBeAttached();
	}
	async function clickCombobox(scope: string, selectLabel: string): Promise<void> {
		// Clicks the shadow combobox at its center with real mouse events —
		// what a person clicks. (The select host's center can land on the
		// label, which opens nothing, and CSS cannot pierce shadow roots.)
		const point = await page.evaluate(
			([scopeSelector, label]) => {
				const scope =
					scopeSelector === "dialog"
						? document
						: (document.querySelector(scopeSelector) ?? document);
				const select = scope.querySelector(`sl-select[label="${label}"]`);
				const root = (select as (HTMLElement & { shadowRoot: ShadowRoot | null }) | null)
					?.shadowRoot;
				const combo = (root?.querySelector('[part="combobox"]') as HTMLElement | null) ?? null;
				if (combo === null) return null;
				const rect = combo.getBoundingClientRect();
				return [rect.x + rect.width / 2, rect.y + rect.height / 2];
			},
			[scope, selectLabel] as [string, string],
		);
		if (point === null) throw new Error(`no combobox for select ${selectLabel}`);
		await page.mouse.click(point[0] ?? 0, point[1] ?? 0);
	}
	async function pickOption(selectLabel: string, optionValue: string): Promise<void> {
		// sl-option elements are light-DOM children of their sl-select.
		await clickCombobox("dialog", selectLabel);
		await page.locator(`sl-dialog sl-option[value="${optionValue}"]`).click();
		// The bubbled sl-after-hide from the closing listbox must not close
		// the dialog: it stays attached with the form intact.
		await dialogAttached();
		// The closing popup animates out on top of the dialog; the next pick
		// must wait until it is truly gone, or its overlay swallows the click.
		await listboxClosed("dialog", selectLabel);
	}
	async function listboxClosed(scope: string, selectLabel: string): Promise<void> {
		await page.waitForFunction(
			([scopeSelector, label]) => {
				const root =
					scopeSelector === "dialog"
						? document
						: (document.querySelector(scopeSelector) ?? document);
				const sel = root.querySelector(`sl-select[label="${label}"]`);
				if (sel === null) return false;
				if ((sel as unknown as { open: boolean }).open) return false;
				const opt = sel.querySelector("sl-option");
				if (opt === null) return true;
				const rect = (opt as HTMLElement).getBoundingClientRect();
				return rect.width === 0 && rect.height === 0;
			},
			[scope, selectLabel] as [string, string],
			{ timeout: 10_000 },
		);
	}

	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();

	// Mouse path on every dialog select.
	await page.getByRole("button", { name: "Add widget" }).click();
	await dialogAttached();
	await pickOption("Widget type", "metric");
	await pickOption("Size", "small");
	await pickOption("Series", "twelve-data:XAU/USD");
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await page.locator("sl-dialog").getByRole("button", { name: "Add widget" }).click();
	const added = page.getByRole("article", {
		name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await expect(added).toContainText("4,168.44", { timeout: 30_000 });

	// The chart's range select saves through a real click too. (Option labels
	// always live in the light DOM, so the selected value is asserted.)
	const chart = page.locator('article[data-widget-id="w-vix-chart"]');
	const chartScope = 'article[data-widget-id="w-vix-chart"]';
	const rangeValue = () =>
		page.evaluate(() => {
			const sel: unknown = document.querySelector(
				'article[data-widget-id="w-vix-chart"] sl-select[label="Range"]',
			);
			return sel !== null && typeof sel === "object" && "value" in sel
				? String(sel.value)
				: "missing";
		});
	await clickCombobox(chartScope, "Range");
	await chart.locator('sl-option[value="3m"]').click();
	await listboxClosed(chartScope, "Range");
	await expect.poll(rangeValue, { timeout: 30_000 }).toBe("3m");
	await clickCombobox(chartScope, "Range");
	await chart.locator('sl-option[value="1y"]').click();
	await listboxClosed(chartScope, "Range");
	await expect.poll(rangeValue, { timeout: 30_000 }).toBe("1y");

	// Keyboard path: focus the Size select, open with ArrowDown, jump to the
	// last option with End, choose with Enter — the dialog stays open.
	await page.getByRole("button", { name: "Add widget" }).click();
	await dialogAttached();
	await page.evaluate(() => {
		const select = document.querySelector('sl-dialog sl-select[label="Size"]');
		if (!(select instanceof HTMLElement)) throw new Error("missing Size select");
		select.focus();
	});
	await page.keyboard.press("ArrowDown");
	await page.keyboard.press("End");
	await page.keyboard.press("Enter");
	await dialogAttached();
	const sizeValue = await page.evaluate(() => {
		const select = document.querySelector('sl-dialog sl-select[label="Size"]');
		if (select === null) throw new Error("dialog closed during keyboard select use");
		return "value" in select ? String(select.value) : "unknown";
	});
	expect(sizeValue).toBe("large");
	await page.keyboard.press("Escape");
	await expect(page.locator("sl-dialog")).toHaveCount(0);

	// The H1 probe widget is removed so later runs start clean.
	await added.getByRole("button", { name: `${title} actions` }).click();
	await page.getByRole("menuitem", { name: "Remove widget" }).click();
	await expect(added).toHaveCount(0);
});

test("F2: Escape with an open listbox closes only the listbox, keeping the dialog and its form", async () => {
	test.setTimeout(120_000);
	const title = `E2E F2 ${Date.now()}`;
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();

	await page.getByRole("button", { name: "Add widget" }).click();
	const dialog = page.locator("sl-dialog", { hasText: "Add widget" });
	await expect(dialog).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await openSelectViaCombobox(page, "dialog", "Widget type");

	// First Escape closes only the listbox: the dialog stays attached with
	// the form intact and the listbox gone.
	await page.keyboard.press("Escape");
	await waitSelectClosed(page, "dialog", "Widget type");
	await expect(dialog).toBeAttached();
	await expect(page.locator('sl-dialog sl-input[label="Title"] input')).toHaveValue(title);

	// Second Escape closes the dialog.
	await page.keyboard.press("Escape");
	await expect(page.locator("sl-dialog")).toHaveCount(0);
});

test("every Home icon ships with the build and every sl-icon renders its SVG", async () => {
	test.setTimeout(120_000);
	// A fresh page: sl-icon caches resolved icons in memory, so only a new
	// page performs the real fetches this test audits.
	const fresh = await browserRef.newPage();
	const iconResponses: { url: string; status: number; contentType: string }[] = [];
	fresh.on("response", (response) => {
		const url = response.url();
		if (new URL(url).pathname.startsWith("/icons/")) {
			iconResponses.push({
				url,
				status: response.status(),
				contentType: response.headers()["content-type"] ?? "",
			});
		}
	});
	const freshErrors: string[] = [];
	fresh.on("console", (message) => {
		if (message.type() === "error") freshErrors.push(message.text());
	});
	fresh.on("pageerror", (error) => freshErrors.push(error.message));
	try {
		await fresh.goto("/#/home");
		await expect(fresh.getByRole("heading", { level: 2, name: "Home" })).toBeVisible();
		await expect(fresh.locator("article[data-widget-id]").first()).toBeVisible();

		// Open the dialog (close icon), a select (expand icon) and a widget
		// menu (caret + submenu chevrons) — every icon path Home can reach.
		await fresh.getByRole("button", { name: "Add widget" }).click();
		const dialog = fresh.locator("sl-dialog");
		await expect(dialog).toBeAttached();
		await openSelectViaCombobox(fresh, "dialog", "Widget type");
		await expect(fresh.locator("sl-popup").first()).toBeAttached();
		// F1: on Chromium the first Escape closes only the select listbox
		// (CloseWatcher); the modal dialog stays open and would swallow the
		// click below. Close the listbox, then the dialog, and only then
		// touch anything behind it.
		await fresh.keyboard.press("Escape");
		await waitSelectClosed(fresh, "dialog", "Widget type");
		await fresh.keyboard.press("Escape");
		await expect(fresh.locator("sl-dialog")).toHaveCount(0);
		await fresh.locator("article[data-widget-id] button[data-widget-actions]").first().click();
		await expect(fresh.getByRole("menuitem", { name: "Edit widget" })).toBeVisible();

		// Every sl-icon on the page — including the ones inside Shoelace
		// shadow roots — resolves to an inline <svg>. A missing icon file
		// leaves its sl-icon without one, which fails here, never silently.
		await expect
			.poll(
				async () =>
					fresh.evaluate(() => {
						let total = 0;
						let resolved = 0;
						const visit = (root: Document | ShadowRoot): void => {
							for (const icon of root.querySelectorAll("sl-icon")) {
								total += 1;
								if (icon.shadowRoot?.querySelector("svg") !== null) resolved += 1;
							}
							for (const host of root.querySelectorAll("*")) {
								if (host.shadowRoot !== null) visit(host.shadowRoot);
							}
						};
						visit(document);
						return total > 0 ? `${resolved}/${total}` : "none";
					}),
				{ timeout: 15_000 },
			)
			.toMatch(/^([1-9][0-9]*)\/\1$/);
		const unresolved = await fresh.evaluate(() => {
			const names: string[] = [];
			const visit = (root: Document | ShadowRoot): void => {
				for (const icon of root.querySelectorAll("sl-icon")) {
					if (icon.shadowRoot?.querySelector("svg") === null) {
						names.push(
							`${icon.getAttribute("library") ?? "?"}/${icon.getAttribute("name") ?? "?"}`,
						);
					}
					if (icon.shadowRoot !== null) visit(icon.shadowRoot);
				}
				for (const host of root.querySelectorAll("*")) {
					if (host.shadowRoot !== null && host.tagName !== "SL-ICON") visit(host.shadowRoot);
				}
			};
			visit(document);
			return names;
		});
		expect(unresolved).toEqual([]);

		// Every icon request the page made answered 200 as SVG…
		expect(iconResponses.length).toBeGreaterThan(0);
		for (const response of iconResponses) {
			expect(`${response.url} -> ${response.status}`).toBe(`${response.url} -> 200`);
			expect(response.contentType).toContain("svg");
		}
		const requested = new Set(
			iconResponses.map((response) => new URL(response.url).pathname.split("/").pop()),
		);
		// Widget frames, menus and buttons are native now (ADR-0016), so the
		// kit no longer reaches for `caret` (sl-button) or the menu-item
		// submenu chevrons — only the select expand icon and dialog close.
		for (const name of ["chevron-down", "x-lg"]) {
			expect(requested.has(`${name}.svg`), `no request was made for ${name}.svg`).toBe(true);
		}

		// …and every SVG file shipped in the build answers 200 as SVG.
		const iconsDir = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"..",
			"apps",
			"web",
			"public",
			"icons",
		);
		const shipped = readdirSync(iconsDir).filter((file) => file.endsWith(".svg"));
		expect(shipped.length).toBeGreaterThan(0);
		for (const file of shipped) {
			const response = await fresh.request.get(`${E2E_ORIGIN}/icons/${file}`);
			expect(response.ok(), `/icons/${file} did not answer 200`).toBe(true);
			expect(response.headers()["content-type"] ?? "").toContain("svg");
		}
		expect(freshErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
			[],
		);
	} finally {
		await fresh.close();
	}
	expect(consoleErrors.filter((text) => !text.includes("422") && !text.includes("403"))).toEqual(
		[],
	);
});

test("widget sizes are fixed: identical boxes per size, 240 px small, 496 px medium and large", async () => {
	test.setTimeout(120_000);
	const groups = {
		small: ["w-vix", "w-gold", "w-dgs10", "w-sp500"],
		medium: ["w-vix-chart", "w-watchlist"],
		// The default dashboard holds one large widget; a second large widget
		// (an indicator table, whose default size is large) is added below so
		// the Large equality is not vacuous, then removed again.
		large: ["w-us-economy"],
	} as const;
	const expectedHeight = { small: 240, medium: 496, large: 496 } as const;

	async function boxes(ids: readonly string[]): Promise<{ width: number; height: number }[]> {
		return page.evaluate((list) => {
			return list.map((id) => {
				const element = document.querySelector(`article[data-widget-id="${id}"]`);
				if (!(element instanceof HTMLElement)) throw new Error(`missing widget ${id}`);
				const rect = element.getBoundingClientRect();
				return { width: rect.width, height: rect.height };
			});
		}, ids);
	}

	// A second large widget for the Large equality, removed afterwards.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	const sizeTitle = `E2E size ${Date.now()}`;
	await page.getByRole("button", { name: "Add widget" }).click();
	await expect(page.locator("sl-dialog", { hasText: "Add widget" })).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(sizeTitle);
	await setSlValue('sl-dialog sl-select[label="Widget type"]', "indicator-table");
	await setSlValue('sl-dialog sl-select[label="Series"]', ["fred:CPIAUCSL"]);
	await page.locator("sl-dialog").getByRole("button", { name: "Add widget" }).click();
	const secondLarge = page.getByRole("article", {
		name: new RegExp(sizeTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
	});
	await expect(secondLarge).toBeVisible({ timeout: 30_000 });
	const secondLargeId = (await secondLarge.getAttribute("data-widget-id")) ?? "missing-large-id";

	for (const viewport of [
		{ width: 1440, height: 900 },
		{ width: 390, height: 844 },
	] as const) {
		await page.setViewportSize(viewport);
		await page.goto("/#/home");
		await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
		for (const size of ["small", "medium", "large"] as const) {
			const ids = size === "large" ? [...groups.large, secondLargeId] : [...groups[size]];
			const measured = await boxes(ids);
			for (const box of measured) {
				expect(Math.round(box.width)).toBe(Math.round(measured[0]?.width ?? 0));
				expect(Math.round(box.height)).toBe(Math.round(measured[0]?.height ?? 0));
				expect(Math.round(box.height)).toBe(expectedHeight[size]);
			}
		}
		if (viewport.width === 390) {
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth);
			expect(overflow).toBeLessThanOrEqual(viewport.width + 1);
		}
	}

	// The size probe widget is removed so later runs start clean.
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/home");
	await expect(secondLarge).toBeVisible();
	await secondLarge.getByRole("button", { name: `${sizeTitle} actions` }).click();
	await page.getByRole("menuitem", { name: "Remove widget" }).click();
	await expect(secondLarge).toHaveCount(0);
	await page.setViewportSize({ width: 1280, height: 720 });
});

test("every button in Home main is icon-only with an accessible name, while header navigation keeps text", async () => {
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	const buttons = await page.evaluate(() => {
		const main = document.querySelector("main");
		if (!(main instanceof HTMLElement)) throw new Error("no main content");
		return [...main.querySelectorAll("button")].map((button) => ({
			text: (button.textContent ?? "").trim(),
			name: button.getAttribute("aria-label") ?? "",
		}));
	});
	expect(buttons.length).toBeGreaterThan(0);
	for (const button of buttons) {
		expect(button.text).toBe("");
		expect(button.name).not.toBe("");
	}
	expect(buttons.map((button) => button.name)).toEqual(
		expect.arrayContaining(["Add widget", "Refresh market data", "Reset to default arrangement"]),
	);
	const navText = await page.evaluate(() => {
		const nav = document.querySelector('nav[aria-label="Views"]');
		return nav !== null ? (nav.textContent ?? "").trim() : "";
	});
	expect(navText).toContain("Home");
	expect(navText).toContain("Chat");
});

test("a tall widget body scrolls inside its frame and is keyboard-focusable", async () => {
	test.setTimeout(180_000);
	await page.goto("/#/home");
	const chart = page.locator('article[data-widget-id="w-vix-chart"]');
	await expect(chart).toBeVisible();
	// The chart needs data for its long data-table twin: refresh once if the
	// page has never seen a successful refresh.
	const status = page.locator('[data-field="home-status"]');
	await expect(status).toBeVisible({ timeout: 20_000 });
	if (!((await status.textContent()) ?? "").includes("Last successful refresh:")) {
		const refresh = page.getByRole("button", { name: "Refresh market data" });
		if (await refresh.isEnabled()) await refresh.click();
		await expect(status).toContainText("Last successful refresh:", { timeout: 120_000 });
	}
	// Open the 1-year data-table twin so the body overflows its frame.
	const isOpen = await chart.locator("details").evaluate((el) => (el as HTMLDetailsElement).open);
	if (!isOpen) await chart.locator("summary", { hasText: "Data table:" }).click();
	const scroller = chart.locator('div[tabindex="0"]');
	await expect(scroller).toBeAttached();
	expect(await scroller.getAttribute("aria-labelledby")).toBe(
		await chart.locator("h3").getAttribute("id"),
	);
	// Keyboard-focusable: programmatic focus (what Tab does) lands on it.
	await scroller.focus();
	expect(await page.evaluate(() => document.activeElement?.getAttribute("tabindex"))).toBe("0");
	// The tall content scrolls inside the frame: the article box is unchanged
	// while the body scrolls.
	const before = await chart.boundingBox();
	expect(before).not.toBeNull();
	const scrolled = await chart.evaluate((article) => {
		const body = article.querySelector('div[tabindex="0"]');
		if (!(body instanceof HTMLElement)) throw new Error("no scroll container");
		const overflows = body.scrollHeight > body.clientHeight + 1;
		body.scrollTop = body.scrollHeight;
		return { overflows, scrollTop: body.scrollTop };
	});
	expect(scrolled.overflows).toBe(true);
	expect(scrolled.scrollTop).toBeGreaterThan(0);
	const after = await chart.boundingBox();
	expect(Math.round(after?.height ?? 0)).toBe(496);
	expect(Math.round(after?.height ?? 0)).toBe(Math.round(before?.height ?? -1));
});
