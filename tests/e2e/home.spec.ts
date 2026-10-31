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

	// ADR-0024: the type is chosen in the add menu, then its dialog opens.
	await page.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Market metric", exact: true }).click();
	const dialog = page.locator("sl-dialog");
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
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
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
		await expect(page.locator("sl-dialog", { hasText: /Add [a-z ]*widget/ })).toBeAttached();
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
	await page.getByRole("menuitem", { name: "Market metric", exact: true }).click();
	await dialogAttached();
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
	await page.getByRole("menuitem", { name: "Market metric", exact: true }).click();
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
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
	await expect(added).toHaveCount(0);
});

test("F2: Escape with an open listbox closes only the listbox, keeping the dialog and its form", async () => {
	test.setTimeout(120_000);
	const title = `E2E F2 ${Date.now()}`;
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();

	await page.getByRole("button", { name: "Add widget" }).click();
	await page.getByRole("menuitem", { name: "Market metric", exact: true }).click();
	const dialog = page.locator("sl-dialog");
	await expect(dialog).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(title);
	await openSelectViaCombobox(page, "dialog", "Size");

	// First Escape closes only the listbox: the dialog stays attached with
	// the form intact and the listbox gone.
	await page.keyboard.press("Escape");
	await waitSelectClosed(page, "dialog", "Size");
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
		await fresh.getByRole("menuitem", { name: "Market metric", exact: true }).click();
		const dialog = fresh.locator("sl-dialog");
		await expect(dialog).toBeAttached();
		await openSelectViaCombobox(fresh, "dialog", "Size");
		await expect(fresh.locator("sl-popup").first()).toBeAttached();
		// F1: on Chromium the first Escape closes only the select listbox
		// (CloseWatcher); the modal dialog stays open and would swallow the
		// click below. Close the listbox, then the dialog, and only then
		// touch anything behind it.
		await fresh.keyboard.press("Escape");
		await waitSelectClosed(fresh, "dialog", "Size");
		await fresh.keyboard.press("Escape");
		await expect(fresh.locator("sl-dialog")).toHaveCount(0);
		await fresh.locator("article[data-widget-id] button[data-widget-actions]").first().click();
		await expect(fresh.getByRole("menuitem", { name: "Edit…" })).toBeVisible();

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
		// Widget frames, menus and buttons are native now (ADR-0017), so the
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

test("widget sizes are fixed: identical boxes per size, 272 px small, 560 px medium and large", async () => {
	test.setTimeout(120_000);
	const groups = {
		small: ["w-vix", "w-gold", "w-dgs10", "w-sp500"],
		medium: ["w-vix-chart", "w-watchlist"],
		// The default dashboard holds one large widget; a second large widget
		// (an indicator table, whose default size is large) is added below so
		// the Large equality is not vacuous, then removed again.
		large: ["w-us-economy"],
	} as const;
	const expectedHeight = { small: 272, medium: 560, large: 560 } as const;

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
	await page.getByRole("menuitem", { name: "Indicator table", exact: true }).click();
	await expect(page.locator("sl-dialog")).toBeAttached();
	await page.locator('sl-dialog sl-input[label="Title"] input').fill(sizeTitle);
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
	await page.getByRole("menuitem", { name: "Remove", exact: true }).click();
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
		// The chart-viewer openers (ADR-0025) wrap real content — the plot,
		// the value block, a row name — so they are the exception to the
		// icon-only rule: a hidden "Open chart: " prefix plus that visible
		// content is their accessible name, with no aria-label.
		if (button.text.startsWith("Open chart:")) {
			expect(button.name).toBe("");
			continue;
		}
		expect(button.text).toBe("");
		expect(button.name).not.toBe("");
	}
	expect(buttons.map((button) => button.name)).toEqual(
		expect.arrayContaining(["Add widget", "Refresh market data", "Reset to default arrangement"]),
	);
	// Home has no Paste widgets button (Paste after and ⌘V still paste).
	expect(buttons.map((button) => button.name)).not.toContain("Paste widgets");
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
	expect(Math.round(after?.height ?? 0)).toBe(560);
	expect(Math.round(after?.height ?? 0)).toBe(Math.round(before?.height ?? -1));
});

test("widget frames and bodies inherit the page font size (no shrink from the frame)", async () => {
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	const sizes = await page.evaluate(() => {
		const main = document.querySelector("main");
		const body = document.querySelector("article[data-widget-id] .wg-body");
		if (!(main instanceof HTMLElement)) throw new Error("no main content");
		if (!(body instanceof HTMLElement)) throw new Error("no widget body");
		const article = body.closest("article");
		if (!(article instanceof HTMLElement)) throw new Error("no widget article");
		return {
			mainFont: getComputedStyle(main).fontSize,
			articleFont: getComputedStyle(article).fontSize,
			bodyFont: getComputedStyle(body).fontSize,
		};
	});
	expect(sizes.articleFont).toBe(sizes.mainFont);
	expect(sizes.bodyFont).toBe(sizes.mainFont);
});

/**
 * Drag and drop repositioning (HIG Drag and drop): every widget header is the
 * handle, the others reflow around the dragged widget, and the drop saves
 * exactly one reorder PUT. Real mouse via `page.mouse`.
 */
async function widgetIds(): Promise<string[]> {
	return page.evaluate(() =>
		[...document.querySelectorAll("article[data-widget-id]")].map(
			(article) => article.getAttribute("data-widget-id") ?? "",
		),
	);
}

/** Visual order (top to bottom, left to right) plus the CSS `order` values. */
async function visualSnapshot(): Promise<{ ids: string[]; orders: (string | null)[] }> {
	return page.evaluate(() => {
		const articles = [...document.querySelectorAll("article[data-widget-id]")].filter(
			(node): node is HTMLElement => node instanceof HTMLElement,
		);
		const boxes = articles.map((article) => ({
			id: article.getAttribute("data-widget-id") ?? "",
			top: article.getBoundingClientRect().top,
			left: article.getBoundingClientRect().left,
			order: article.style.order === "" ? null : article.style.order,
		}));
		boxes.sort((a, b) => (a.top === b.top ? a.left - b.left : a.top - b.top));
		return { ids: boxes.map((entry) => entry.id), orders: boxes.map((entry) => entry.order) };
	});
}

/**
 * The drag handle's center. Frames carry no visible title (owner, 2026-10-15),
 * so the header is a compact control cluster and its grip is the handle.
 */
async function headerCenter(widgetId: string): Promise<{ x: number; y: number }> {
	const handle = page.locator(`article[data-widget-id="${widgetId}"] .wg-grip`);
	await expect(handle).toBeVisible();
	const box = await handle.boundingBox();
	if (box === null) throw new Error(`no header box for ${widgetId}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function articleCenter(widgetId: string): Promise<{ x: number; y: number }> {
	const article = page.locator(`article[data-widget-id="${widgetId}"]`);
	const box = await article.boundingBox();
	if (box === null) throw new Error(`no article box for ${widgetId}`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Counts dashboard PUTs only while `work` runs (exactly-one assertions). */
async function countPutsDuring(work: () => Promise<void>): Promise<number> {
	let puts = 0;
	const handler = (request: { method(): string; url(): string }) => {
		if (request.method() === "PUT" && /\/home\/dashboard$/.test(request.url())) puts += 1;
	};
	page.on("request", handler);
	try {
		await work();
		// The drop's save is one PUT; wait until it lands before asserting.
		await expect.poll(() => puts, { timeout: 30_000 }).toBeGreaterThan(0);
		// One more beat for a stray second PUT to show itself.
		await page.waitForTimeout(500);
		return puts;
	} finally {
		page.off("request", handler);
	}
}

/** Starts every drag test at the top so header coordinates are in-viewport. */
async function scrollHomeTop(): Promise<void> {
	await page.evaluate(() => window.scrollTo(0, 0));
}

test("dragging the first widget onto the third reorders with exactly one PUT and survives a reload", async () => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	await scrollHomeTop();
	const before = await widgetIds();
	expect(before.length).toBeGreaterThanOrEqual(3);
	const dragged = before[0] ?? "";
	const target = before[2] ?? "";
	const from = await headerCenter(dragged);
	const to = await articleCenter(target);
	const puts = await countPutsDuring(async () => {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		// Past the target center (midpoint rule needs the far half).
		await page.mouse.move(to.x + 20, to.y + 10, { steps: 12 });
		await page.mouse.up();
	});
	expect(puts).toBe(1);
	const after = await widgetIds();
	expect(after.filter((id) => id !== dragged)).toEqual(before.filter((id) => id !== dragged));
	expect(after.indexOf(dragged)).toBe(2);
	await page.reload();
	await expect(page.locator(`article[data-widget-id="${dragged}"]`)).toBeVisible();
	expect(await widgetIds()).toEqual(after);
});

test("a Medium widget drags before the first Small", async () => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix-chart"]')).toBeVisible();
	await scrollHomeTop();
	const before = await widgetIds();
	const medium = "w-vix-chart";
	const firstSmall = before.find((id) => id !== medium) ?? "";
	const from = await headerCenter(medium);
	const to = await articleCenter(firstSmall);
	const puts = await countPutsDuring(async () => {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x - 20, to.y - 20, { steps: 12 });
		await page.mouse.up();
	});
	expect(puts).toBe(1);
	const after = await widgetIds();
	expect(after[0]).toBe(medium);
});

test("Escape mid-drag cancels: original order, no PUT", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/home");
	await expect(page.locator("article[data-widget-id]").first()).toBeVisible();
	await scrollHomeTop();
	const before = await widgetIds();
	const dragged = before[0] ?? "";
	const target = before[2] ?? "";
	const from = await headerCenter(dragged);
	const to = await articleCenter(target);
	let puts = 0;
	const handler = (request: { method(): string; url(): string }) => {
		if (request.method() === "PUT" && /\/home\/dashboard$/.test(request.url())) puts += 1;
	};
	page.on("request", handler);
	try {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(to.x + 20, to.y + 10, { steps: 8 });
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await page.waitForTimeout(500);
	} finally {
		page.off("request", handler);
	}
	expect(puts).toBe(0);
	expect(await widgetIds()).toEqual(before);
});

test("press-and-release without movement saves nothing", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/home");
	await expect(page.locator("article[data-widget-id]").first()).toBeVisible();
	await scrollHomeTop();
	const before = await widgetIds();
	const from = await headerCenter(before[0] ?? "");
	let puts = 0;
	const handler = (request: { method(): string; url(): string }) => {
		if (request.method() === "PUT" && /\/home\/dashboard$/.test(request.url())) puts += 1;
	};
	page.on("request", handler);
	try {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.up();
		await page.waitForTimeout(500);
	} finally {
		page.off("request", handler);
	}
	expect(puts).toBe(0);
	expect(await widgetIds()).toEqual(before);
});

test("a held pointer is stable: no flip-flopping between samples", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/home");
	await expect(page.locator("article[data-widget-id]").first()).toBeVisible();
	await scrollHomeTop();
	const ids = await widgetIds();
	const dragged = ids[0] ?? "";
	const target = ids[2] ?? "";
	const from = await headerCenter(dragged);
	const to = await articleCenter(target);
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	await page.mouse.move(to.x + 20, to.y + 10, { steps: 12 });
	// Pointer moves coalesce on requestAnimationFrame: let the frame that
	// holds the final position run before the first sample. Without this a
	// slow engine (WebKit under load) is sampled before that frame, and the
	// one legitimate move to the target reads as a flip-flop.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);
	const first = await visualSnapshot();
	// The held pointer must then change nothing, sampled repeatedly.
	for (let sample = 0; sample < 5; sample += 1) {
		await page.waitForTimeout(100);
		expect(await visualSnapshot()).toEqual(first);
	}
	await page.keyboard.press("Escape");
	await page.mouse.up();
	await page.waitForTimeout(300);
	expect(await widgetIds()).toEqual(ids);
});

test("the actions button still opens its menu, and Move later works and is announced", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/home");
	await expect(page.locator("article[data-widget-id]").first()).toBeVisible();
	const before = await widgetIds();
	const first = before[0] ?? "";
	await expect(
		page.locator(`article[data-widget-id="${first}"] button[data-widget-actions]`),
	).toBeVisible();
	await page.locator(`article[data-widget-id="${first}"] button[data-widget-actions]`).click();
	await expect(page.getByRole("menuitem", { name: "Move later" })).toBeVisible();
	const puts = await countPutsDuring(async () => {
		await page.getByRole("menuitem", { name: "Move later" }).click();
	});
	expect(puts).toBe(1);
	const after = await widgetIds();
	expect(after.indexOf(first)).toBe(1);
	// The move announcer is the package's polite region (`wg-visually-hidden`);
	// the board's action region (cut / copy / paste / remove) is a second one.
	const live = page.locator("output.wg-visually-hidden[aria-live='polite']");
	await expect(live).toContainText(/Moved “.+” to position 2 of /);
});

/** Restores the default dashboard so scrolled-drag tests start deterministic. */
async function resetDashboardToDefaults(): Promise<void> {
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	const reset = page.getByRole("button", { name: "Reset to default arrangement" });
	await expect(reset).toBeEnabled({ timeout: 30_000 });
	await reset.click();
	const dialog = page.locator("sl-dialog", { hasText: "Undo restores" });
	await expect(dialog).toBeAttached();
	await dialog.getByRole("button", { name: "Reset widgets" }).click();
	await expect
		.poll(() => widgetIds(), { timeout: 30_000 })
		.toEqual([
			"w-vix",
			"w-gold",
			"w-dgs10",
			"w-sp500",
			"w-vix-chart",
			"w-watchlist",
			"w-us-economy",
		]);
}

test("dragging the first widget to the last widget below the fold drops it last, after a reload too", async () => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await resetDashboardToDefaults();
	await scrollHomeTop();
	const before = await widgetIds();
	const dragged = before[0] ?? "";
	expect(dragged).toBe("w-vix");
	const from = await headerCenter(dragged);
	const puts = await countPutsDuring(async () => {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x, from.y + 30, { steps: 4 });
		// Ride the bottom edge: the edge auto-scroll carries the page down
		// while the pointer rests in the zone, staling nothing.
		await page.mouse.move(720, 880, { steps: 10 });
		await page.waitForTimeout(1500);
		// The last (Large, "US economy") widget is now on screen: drop on
		// its lower half, past its center.
		const box = await page.locator('article[data-widget-id="w-us-economy"]').boundingBox();
		if (box === null) throw new Error("the US economy widget never scrolled into view");
		await page.mouse.move(box.x + box.width / 2, box.y + (box.height * 3) / 4, { steps: 10 });
		await page.waitForTimeout(300);
		await page.mouse.up();
	});
	expect(puts).toBe(1);
	const after = await widgetIds();
	expect(after.filter((id) => id !== dragged)).toEqual(before.filter((id) => id !== dragged));
	expect(after[after.length - 1]).toBe(dragged);
	await page.reload();
	await expect(page.locator(`article[data-widget-id="${dragged}"]`)).toBeVisible();
	expect(await widgetIds()).toEqual(after);
});

test("a wheel scroll in the middle of a drag still drops over the intended widget", async () => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await resetDashboardToDefaults();
	await scrollHomeTop();
	const before = await widgetIds();
	const dragged = before[0] ?? "";
	// The last (Large, "US economy") widget: dropping on its lower half
	// ends last no matter how the pointer approached, so the assertion is
	// deterministic while still proving the scrolled decision was right.
	const targetId = "w-us-economy";
	const from = await headerCenter(dragged);
	let puts = 0;
	const handler = (request: { method(): string; url(): string }) => {
		if (request.method() === "PUT" && /\/home\/dashboard$/.test(request.url())) puts += 1;
	};
	page.on("request", handler);
	try {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x, from.y + 40, { steps: 4 });
		await page.waitForTimeout(300);
		// Scroll the page under the held pointer without moving the mouse:
		// the cached slots are page coordinates, so the decision stays right.
		await page.mouse.wheel(0, 800);
		await page.waitForTimeout(400);
		let box = await page.locator(`article[data-widget-id="${targetId}"]`).boundingBox();
		if (box === null) {
			await page.locator(`article[data-widget-id="${targetId}"]`).scrollIntoViewIfNeeded();
			box = await page.locator(`article[data-widget-id="${targetId}"]`).boundingBox();
		}
		if (box === null) throw new Error(`the ${targetId} widget has no box`);
		await page.mouse.move(box.x + box.width / 2, box.y + (box.height * 3) / 4, { steps: 10 });
		await page.waitForTimeout(300);
		await page.mouse.up();
		await expect.poll(() => puts, { timeout: 30_000 }).toBeGreaterThan(0);
		await page.waitForTimeout(500);
	} finally {
		page.off("request", handler);
	}
	expect(puts).toBe(1);
	const after = await widgetIds();
	expect(after.filter((id) => id !== dragged)).toEqual(before.filter((id) => id !== dragged));
	expect(after[after.length - 1]).toBe(dragged);
	await page.reload();
	await expect(page.locator(`article[data-widget-id="${dragged}"]`)).toBeVisible();
	expect(await widgetIds()).toEqual(after);
});

test("holding a drag near the bottom edge auto-scrolls, and Escape stops it", async () => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await resetDashboardToDefaults();
	await scrollHomeTop();
	const before = await widgetIds();
	const dragged = before[0] ?? "";
	const from = await headerCenter(dragged);
	let puts = 0;
	const handler = (request: { method(): string; url(): string }) => {
		if (request.method() === "PUT" && /\/home\/dashboard$/.test(request.url())) puts += 1;
	};
	page.on("request", handler);
	try {
		await page.mouse.move(from.x, from.y);
		await page.mouse.down();
		await page.mouse.move(from.x, from.y + 30, { steps: 4 });
		await page.waitForTimeout(300);
		const startY = await page.evaluate(() => window.scrollY);
		expect(startY).toBe(0);
		// Rest the pointer inside the 80 px bottom zone without moving it:
		// the page keeps scrolling every frame, with no pointer movement.
		await page.mouse.move(720, 885, { steps: 5 });
		await page.waitForTimeout(600);
		const midY = await page.evaluate(() => window.scrollY);
		expect(midY).toBeGreaterThan(startY);
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await page.waitForTimeout(300);
		const endY = await page.evaluate(() => window.scrollY);
		await page.waitForTimeout(400);
		expect(await page.evaluate(() => window.scrollY)).toBe(endY);
	} finally {
		page.off("request", handler);
	}
	expect(puts).toBe(0);
	expect(await widgetIds()).toEqual(before);
});

test("a touch pointer drag reorders (synthetic touch pointer events)", async () => {
	test.setTimeout(120_000);
	await page.goto("/#/home");
	await expect(page.locator("article[data-widget-id]").first()).toBeVisible();
	await scrollHomeTop();
	const supported = await page.evaluate(() => typeof PointerEvent !== "undefined");
	test.skip(!supported, "this engine has no PointerEvent constructor");
	const before = await widgetIds();
	const dragged = before[0] ?? "";
	const target = before[2] ?? "";
	const from = await headerCenter(dragged);
	const to = await articleCenter(target);
	let puts = 0;
	const handler = (request: { method(): string; url(): string }) => {
		if (request.method() === "PUT" && /\/home\/dashboard$/.test(request.url())) puts += 1;
	};
	page.on("request", handler);
	try {
		await page.evaluate(
			([sx, sy, tx, ty]) => {
				const start = document.elementFromPoint(sx, sy);
				const handle = start instanceof Element ? start.closest("[data-widget-drag-handle]") : null;
				if (!(handle instanceof HTMLElement)) throw new Error("no drag handle at press point");
				const down = new PointerEvent("pointerdown", {
					bubbles: true,
					clientX: sx,
					clientY: sy,
					button: 0,
					pointerId: 7,
					isPrimary: true,
					pointerType: "touch",
				});
				handle.dispatchEvent(down);
				window.dispatchEvent(
					new PointerEvent("pointermove", {
						bubbles: true,
						clientX: tx,
						clientY: ty,
						pointerId: 7,
						isPrimary: true,
						pointerType: "touch",
					}),
				);
			},
			[from.x, from.y, to.x + 20, to.y + 10] as [number, number, number, number],
		);
		await page.waitForTimeout(300);
		await page.evaluate(
			([tx, ty]) => {
				window.dispatchEvent(
					new PointerEvent("pointerup", {
						bubbles: true,
						clientX: tx,
						clientY: ty,
						pointerId: 7,
						isPrimary: true,
						pointerType: "touch",
					}),
				);
			},
			[to.x + 20, to.y + 10] as [number, number],
		);
		await expect.poll(() => puts, { timeout: 30_000 }).toBe(1);
	} finally {
		page.off("request", handler);
	}
	// The PUT is counted when it is SENT; the DOM order follows once the
	// server copy renders (until then the new order is shown through CSS
	// `order`), so the DOM order is polled rather than read once.
	await expect.poll(async () => (await widgetIds()).indexOf(dragged), { timeout: 30_000 }).toBe(2);
});

test("an edit made through the API appears when the tab becomes visible again", async () => {
	test.setTimeout(120_000);
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto("/#/home");
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	const before = await widgetIds();
	expect(before.length).toBeGreaterThanOrEqual(3);

	// As an agent would: change the stored dashboard through the existing
	// owner API (same-origin Origin plus the CSRF header, local-dev mode).
	const read = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	expect(read.ok()).toBe(true);
	const stored = (await read.json()) as {
		dashboard: { schemaVersion: 1; widgets: { widgetId: string }[] };
		version: number;
	};
	const firstWidget = stored.dashboard.widgets[0];
	if (firstWidget === undefined) throw new Error("the stored dashboard is empty");
	const reordered = [...stored.dashboard.widgets.slice(1), firstWidget];
	const saved = await page.request.put(`${E2E_ORIGIN}/api/v1/home/dashboard`, {
		headers: {
			Origin: E2E_ORIGIN,
			"X-Research-Csrf": "1",
			"Content-Type": "application/json",
		},
		data: {
			dashboard: { schemaVersion: 2, widgets: reordered },
			expectedVersion: stored.version,
		},
	});
	expect(saved.ok()).toBe(true);
	const expected = reordered.map((widget) => widget.widgetId);

	// The open page has not re-read yet: the old order is still on screen.
	expect(await widgetIds()).toEqual(before);
	// Becoming visible again adopts the stored order without navigation.
	await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
	await expect.poll(async () => widgetIds(), { timeout: 30_000 }).toEqual(expected);

	// Restore the order this test found, so later tests start deterministic.
	const reread = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	const current = (await reread.json()) as {
		dashboard: { schemaVersion: 1; widgets: { widgetId: string }[] };
		version: number;
	};
	const byId = new Map(current.dashboard.widgets.map((widget) => [widget.widgetId, widget]));
	const restored = before.map((id) => {
		const widget = byId.get(id);
		if (widget === undefined) throw new Error(`the stored dashboard lost ${id}`);
		return widget;
	});
	const putBack = await page.request.put(`${E2E_ORIGIN}/api/v1/home/dashboard`, {
		headers: {
			Origin: E2E_ORIGIN,
			"X-Research-Csrf": "1",
			"Content-Type": "application/json",
		},
		data: {
			dashboard: { schemaVersion: 2, widgets: restored },
			expectedVersion: current.version,
		},
	});
	expect(putBack.ok()).toBe(true);
	await page.reload();
	await expect(page.locator('article[data-widget-id="w-vix"]')).toBeVisible();
	expect(await widgetIds()).toEqual(before);
});
