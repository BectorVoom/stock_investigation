import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN } from "../e2e/fixtures.ts";
import { marketFailureFile } from "../e2e/marketFixtures.ts";
import { countByRule, formatSummaryTable, type ReviewFinding } from "./reviewMath.ts";

/**
 * Scripted UI review of the Home page (`bun run review:ui`, with
 * `chatReview.spec.ts`). REVIEW, not a gate: drives Home through populated,
 * dialog, menu, unavailable, stale-after-failed-refresh and small-viewport
 * states at 1440/820/390 px, records PNGs plus APPENDED findings in
 * `test-results/ui-review/<engine>/findings.json`, and prints a summary
 * table. Runs after `chatReview.spec.ts` (alphabetical, one worker) against
 * the same server stack; the market refresh uses the fixture market sources,
 * so every number is fixture data.
 */
const REVIEW_BROWSER = parseBrowser(process.env.REVIEW_BROWSER, "REVIEW_BROWSER");
const OUT = process.env.UIREVIEW_OUT ?? `test-results/ui-review/${REVIEW_BROWSER}`;
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	"X-Research-Csrf": "1",
	"Content-Type": "application/json",
};

type Finding = ReviewFinding;
const findings: Finding[] = [];
const consoleProblems: string[] = [];

/** Focused geometry/naming audit for Home states (the chat audit covers chat). */
async function audit(page: Page, state: string): Promise<void> {
	const found = await page.evaluate(() => {
		const out: { rule: string; detail: string }[] = [];
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const describe = (el: Element): string => {
			const label = el.getAttribute("aria-label") ?? "";
			const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 50);
			return `<${el.tagName.toLowerCase()}${label ? ` aria-label="${label}"` : ""}> "${text}"`;
		};
		const visible = (el: Element): boolean => {
			const rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) return false;
			const style = getComputedStyle(el);
			if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0)
				return false;
			if (rect.width <= 1 && rect.height <= 1) return false;
			if (el.closest("[inert]") !== null) return false;
			return true;
		};
		const inViewport = (rect: DOMRect): boolean =>
			rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;

		const doc = document.documentElement;
		if (doc.scrollWidth > vw + 1)
			out.push({
				rule: "horizontal-overflow",
				detail: `document is ${doc.scrollWidth}px wide in a ${vw}px viewport`,
			});

		const interactive = Array.from(
			document.querySelectorAll("button, a[href], input, textarea, select, summary"),
		).filter(visible);
		for (const el of interactive) {
			const rect = el.getBoundingClientRect();
			if (!inViewport(rect)) continue;
			const inlineLink = el.tagName === "A" && getComputedStyle(el).display === "inline";
			if (!inlineLink && (rect.width < 24 || rect.height < 24)) {
				const isCheck =
					el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
				if (!isCheck)
					out.push({
						rule: "small-target",
						detail: `${describe(el)} is ${Math.round(rect.width)}x${Math.round(rect.height)}px (< 24x24)`,
					});
			}
			const name =
				(el.getAttribute("aria-label") ?? "").trim() ||
				(el.textContent ?? "").trim() ||
				(el.getAttribute("title") ?? "").trim() ||
				(el instanceof HTMLInputElement ||
				el instanceof HTMLTextAreaElement ||
				el instanceof HTMLSelectElement
					? (el.labels?.[0]?.textContent ?? "").trim() ||
						(el.getAttribute("placeholder") ?? "").trim()
					: "");
			if (name === "") out.push({ rule: "no-accessible-name", detail: describe(el) });
		}

		let previous = 0;
		for (const heading of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6")).filter(
			visible,
		)) {
			const level = Number(heading.tagName.slice(1));
			if (previous !== 0 && level > previous + 1)
				out.push({
					rule: "heading-skip",
					detail: `h${previous} -> h${level}: ${describe(heading)}`,
				});
			previous = level;
		}

		// Widget content wider than its card without a scroll container.
		for (const el of Array.from(document.querySelectorAll("article *"))) {
			if (!visible(el)) continue;
			if (!(el instanceof HTMLElement) || el.children.length > 0) continue;
			let boxed: Element | null = el;
			let scrollable = false;
			while (boxed !== null) {
				const overflowX = getComputedStyle(boxed).overflowX;
				if (overflowX === "auto" || overflowX === "scroll") {
					scrollable = true;
					break;
				}
				boxed = boxed.parentElement;
			}
			if (!scrollable && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0)
				out.push({
					rule: "content-wider-than-box",
					detail: `${describe(el)} content ${el.scrollWidth}px in a ${el.clientWidth}px box`,
				});
		}
		return out;
	});
	for (const item of found) findings.push({ state, ...item });
}

async function shot(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** Home shows fixture numbers: refresh once through the real runner loop if needed. */
async function refreshState(page: Page): Promise<string> {
	const data = (await (await page.request.get(`${E2E_ORIGIN}/api/v1/home/data`)).json()) as {
		refresh: {
			activeRunId: string | null;
			activeRunState: string | null;
			lastSucceededAt: string | null;
		};
	};
	const activeRunId = data.refresh.activeRunId;
	if (activeRunId === null) return `idle last=${data.refresh.lastSucceededAt}`;
	return `active=${activeRunId} state=${data.refresh.activeRunState}`;
}

async function ensurePopulated(page: Page): Promise<void> {
	await page.goto("/#/home");
	await expect(page.getByRole("heading", { level: 2, name: "Home" })).toBeVisible({
		timeout: 20_000,
	});
	const status = page.locator('[data-field="home-status"]');
	await expect(status).toBeVisible({ timeout: 20_000 });
	const deadline = Date.now() + 150_000;
	let lastRefresh = "";
	for (;;) {
		const text = (await status.textContent()) ?? "";
		if (text.includes("Last successful refresh:")) return;
		if (text.includes("No market-data refresh") && !text.includes("Refreshing")) {
			// The page may auto-queue its one refresh at any moment; only
			// click while no refresh is active (the button disables itself).
			const button = page.getByRole("button", { name: "Refresh market data" });
			await button.waitFor({ state: "visible" });
			if (await button.isEnabled()) await button.click();
		}
		if (Date.now() > deadline) {
			throw new Error(`market refresh did not finish: status=${text} ${lastRefresh}`);
		}
		lastRefresh = await refreshState(page);
		await page.waitForTimeout(3_000);
	}
}

test("UI review of the Home page", async ({ browser }) => {
	test.setTimeout(600_000);
	mkdirSync(OUT, { recursive: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning")
			consoleProblems.push(`${message.type()}: ${message.text()}`);
	});
	page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));

	/* ---------- H0. Loading skeletons ---------- */
	let delayHomeData = true;
	await context.route("**/api/v1/home/data", async (route) => {
		try {
			if (delayHomeData) await new Promise((resolve) => setTimeout(resolve, 1500));
			await route.continue();
		} catch {
			// The page moved on (e.g. a superseded poll); nothing to do.
		}
	});
	await page.goto("/#/home");
	await page.waitForTimeout(700);
	await shot(page, "H0-loading");
	await audit(page, "H loading");
	delayHomeData = false;

	await ensurePopulated(page);

	/* ---------- H1. Populated desktop ---------- */
	await page.waitForTimeout(600);
	await shot(page, "H1-desktop-populated");
	await audit(page, "H desktop populated");

	/* ---------- H2. Add-widget dialog ---------- */
	await page.getByRole("button", { name: "Add widget" }).click();
	const dialog = page.locator("sl-dialog");
	await expect(dialog).toBeAttached();
	await page.waitForTimeout(400);
	await shot(page, "H2-add-dialog");
	await audit(page, "H add dialog");
	const focusInside = await page.evaluate(() => {
		const open = document.querySelector("sl-dialog");
		if (open === null) return "no-dialog";
		// The focused control lives in a Shoelace shadow root, which
		// Node.contains does not pierce — walk up through shadow hosts.
		let node: Node | null = document.activeElement;
		while (node !== null) {
			if (node === open) return "inside";
			const root = node.getRootNode();
			node = root instanceof ShadowRoot ? root.host : node.parentNode;
		}
		return "outside";
	});
	if (focusInside !== "inside")
		findings.push({
			state: "H add dialog",
			rule: "dialog-focus",
			detail: `after opening, focus is ${focusInside}`,
		});
	await page.keyboard.press("Escape");
	await page.waitForTimeout(400);
	if ((await dialog.count()) > 0) {
		findings.push({
			state: "H add dialog",
			rule: "dialog-escape",
			detail: "Escape does not close the dialog",
		});
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	}

	/* ---------- H3. Widget menu ---------- */
	const actions = page.locator("article[data-widget-id] sl-button", { hasText: "Actions" }).first();
	await actions.scrollIntoViewIfNeeded();
	await actions.click();
	await expect(page.getByRole("menuitem", { name: "Edit widget" })).toBeVisible();
	await page.waitForTimeout(300);
	await shot(page, "H3-widget-menu");
	await audit(page, "H widget menu");
	await page.keyboard.press("Escape");

	/* ---------- H4. Unavailable series ---------- */
	const dashboardResponse = await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`);
	const dashboardBody = (await dashboardResponse.json()) as {
		dashboard: { schemaVersion: 1; widgets: Record<string, unknown>[] };
		version: number;
	};
	const withUnavailable = {
		...dashboardBody.dashboard,
		widgets: [
			...dashboardBody.dashboard.widgets,
			{
				widgetId: `w-review-unavailable-${Date.now()}`,
				type: "metric",
				title: "Review unavailable",
				size: "small",
				seriesId: "fred:UNRATE",
			},
		],
	};
	await page.request
		.put(`${E2E_ORIGIN}/api/v1/home/dashboard`, {
			headers: WRITE_HEADERS,
			data: { dashboard: withUnavailable, expectedVersion: dashboardBody.version },
		})
		.then((response) => {
			if (!response.ok()) throw new Error(`dashboard PUT failed: ${response.status()}`);
		});
	const queued = await page.request.post(`${E2E_ORIGIN}/api/v1/home/refresh`, {
		headers: { ...WRITE_HEADERS, "Idempotency-Key": `rk-review-${Date.now()}` },
		data: {},
	});
	if (!queued.ok() && queued.status() !== 202) {
		throw new Error(`refresh POST failed: ${queued.status()}`);
	}
	await page.reload();
	await expect(page.locator('[data-field="home-status"]')).toContainText(
		"Last successful refresh:",
		{
			timeout: 120_000,
		},
	);
	const missing = page.getByRole("article", { name: "Review unavailable" });
	await expect(missing).toContainText("unavailable (");
	await shot(page, "H4-unavailable");
	await audit(page, "H unavailable");

	/* ---------- H5/H6. Small viewports ---------- */
	for (const [name, width, height] of [
		["tablet", 820, 1180],
		["phone", 390, 844],
	] as const) {
		await page.setViewportSize({ width, height });
		await page.goto("/#/home");
		await page.waitForTimeout(1200);
		await shot(page, `H-${name}-top`);
		await audit(page, `H ${name} top`);
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await page.waitForTimeout(500);
		await shot(page, `H-${name}-bottom`);
		await audit(page, `H ${name} bottom`);
	}
	await page.setViewportSize({ width: 1440, height: 900 });

	/* ---------- H5. Stale data after a failed refresh ---------- */
	// VIX already holds stored observations from the populated refresh; fail
	// its next refresh through the fixture failure file so the widgets show
	// the stored values with their as-of date plus the amber "last refresh
	// failed" note instead of "unavailable".
	writeFileSync(marketFailureFile(), JSON.stringify({ seriesIds: ["fred:VIXCLS"] }));
	try {
		const staleQueued = await page.request.post(`${E2E_ORIGIN}/api/v1/home/refresh`, {
			headers: { ...WRITE_HEADERS, "Idempotency-Key": `rk-review-stale-${Date.now()}` },
			data: {},
		});
		if (!staleQueued.ok() && staleQueued.status() !== 202) {
			throw new Error(`refresh POST failed: ${staleQueued.status()}`);
		}
		// A same-URL goto is a no-op navigation (no reload, no hash change),
		// which would leave the stopped poller idle on the old data: reload.
		await page.reload();
		await expect(page.locator('[data-field="home-status"]')).toContainText(
			"Last successful refresh:",
			{
				timeout: 180_000,
			},
		);
		const staleVix = page.locator('article[data-widget-id="w-vix"]');
		await expect(staleVix).toContainText("15.41");
		await expect(staleVix).toContainText("last refresh failed (");
		// The reload restores the pre-reload scroll position (the bottom of
		// the small-viewport states): back to the top so the shot shows the
		// toolbar and the stale metric, like every other state.
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.waitForTimeout(300);
		await shot(page, "H5-stale");
		await audit(page, "H stale");
	} finally {
		try {
			rmSync(marketFailureFile(), { force: true });
		} catch {
			// Best effort: globalSetup removes a leftover before the next run.
		}
	}

	const pageStyles = await page.evaluate(() =>
		[...document.querySelectorAll("style")].map((node) => (node.textContent ?? "").trim()),
	);
	const appAuthoredStyles = pageStyles.filter((text) => text !== "" && text !== "body {}");
	for (const problem of consoleProblems) {
		if (
			problem.startsWith("error: Refused to apply a stylesheet") &&
			appAuthoredStyles.length === 0
		)
			continue;
		findings.push({ state: "console", rule: "console", detail: problem.slice(0, 300) });
	}
	let previous: Finding[] = [];
	try {
		previous = JSON.parse(readFileSync(`${OUT}/findings.json`, "utf8")) as Finding[];
	} catch {
		previous = [];
	}
	writeFileSync(`${OUT}/findings.json`, JSON.stringify([...previous, ...findings], null, 2));
	for (const line of formatSummaryTable(countByRule(findings))) console.log(line);
	console.log(`ui-review (home): ${findings.length} findings, screenshots in ${OUT}/`);
	await context.close();
});
