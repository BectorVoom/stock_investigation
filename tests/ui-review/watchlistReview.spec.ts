import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN } from "../e2e/fixtures.ts";
import { countByRule, formatSummaryTable, type ReviewFinding } from "./reviewMath.ts";

/**
 * Scripted UI review of the Watchlist page (`bun run review:ui`, with
 * `chatReview.spec.ts` and `homeReview.spec.ts`). REVIEW, not a gate: drives
 * Watchlist through loading, populated, add-form, remove-dialog, feed and
 * small-viewport states at 1440/820/390 px, records PNGs plus APPENDED
 * findings in `test-results/ui-review/<engine>/findings.json`, and prints a
 * summary table. Runs after `homeReview.spec.ts` (alphabetical, one worker)
 * against the same server stack; earnings dates come from the fixture
 * Finnhub/JPX sources, so every date is fixture data.
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

/** Focused geometry/naming audit for Watchlist states (same checks as the Home audit). */
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
		return out;
	});
	for (const item of found) findings.push({ state, ...item });
}

async function shot(page: Page, name: string): Promise<void> {
	await page.screenshot({ path: `${OUT}/${name}.png` });
}

async function watchlistState(page: Page): Promise<{
	lastSucceededAt: string | null;
	activeRunId: string | null;
}> {
	const data = (await (await page.request.get(`${E2E_ORIGIN}/api/v1/watchlist`)).json()) as {
		stocks: { stockId: string }[];
		refresh: { activeRunId: string | null; lastSucceededAt: string | null };
	};
	return { lastSucceededAt: data.refresh.lastSucceededAt, activeRunId: data.refresh.activeRunId };
}

/** The watchlist holds AAPL + 7203 with completed fixture dates. */
async function ensurePopulated(page: Page): Promise<void> {
	for (const [market, symbol] of [
		["US", "AAPL"],
		["JP", "7203"],
	] as const) {
		await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/stocks`, {
			headers: WRITE_HEADERS,
			data: { market, symbol },
		});
	}
	const state = await watchlistState(page);
	if (state.lastSucceededAt === null && state.activeRunId === null) {
		await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/refresh`, {
			headers: { ...WRITE_HEADERS, "Idempotency-Key": `rk-review-watch-${Date.now()}` },
			data: {},
		});
	}
	const deadline = Date.now() + 150_000;
	for (;;) {
		const current = await watchlistState(page);
		if (current.lastSucceededAt !== null) return;
		if (Date.now() > deadline) {
			throw new Error(`earnings refresh did not finish: ${JSON.stringify(current)}`);
		}
		await page.waitForTimeout(3_000);
	}
}

test("UI review of the Watchlist page", async ({ browser }) => {
	test.setTimeout(600_000);
	mkdirSync(OUT, { recursive: true });
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error" || message.type() === "warning")
			consoleProblems.push(`${message.type()}: ${message.text()}`);
	});
	page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));

	/* ---------- W0. Loading ---------- */
	let delayWatchlist = true;
	await context.route("**/api/v1/watchlist", async (route) => {
		try {
			if (delayWatchlist) await new Promise((resolve) => setTimeout(resolve, 1500));
			await route.continue();
		} catch {
			// The page moved on; nothing to do.
		}
	});
	await page.goto("/#/watchlist");
	await page.waitForTimeout(700);
	await shot(page, "W0-loading");
	await audit(page, "W loading");
	delayWatchlist = false;

	await ensurePopulated(page);
	await page.goto("/#/watchlist");
	await expect(page.locator('[data-field="watchlist-status"]')).toContainText(
		"Last successful refresh:",
		{ timeout: 30_000 },
	);

	/* ---------- W1. Populated desktop ---------- */
	await page.waitForTimeout(600);
	await shot(page, "W1-desktop-populated");
	await audit(page, "W desktop populated");

	/* ---------- W2. Add form with problems ---------- */
	await page.getByLabel("Symbol").fill("bad!");
	await page.waitForTimeout(300);
	await shot(page, "W2-add-problems");
	await audit(page, "W add problems");
	await page.getByLabel("Symbol").fill("");

	/* ---------- W3. Remove confirmation ---------- */
	await page.locator('tr[data-stock-id="us:AAPL"] button', { hasText: "Remove" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await page.waitForTimeout(400);
	await shot(page, "W3-remove-dialog");
	await audit(page, "W remove dialog");
	const focusInside = await page.evaluate(() => {
		const open = document.querySelector("dialog");
		if (open === null) return "no-dialog";
		return open.contains(document.activeElement) ? "inside" : "outside";
	});
	if (focusInside !== "inside")
		findings.push({
			state: "W remove dialog",
			rule: "dialog-focus",
			detail: `after opening, focus is ${focusInside}`,
		});
	await page.keyboard.press("Escape");
	await page.waitForTimeout(400);
	if ((await dialog.count()) > 0) {
		findings.push({
			state: "W remove dialog",
			rule: "dialog-escape",
			detail: "Escape does not close the dialog",
		});
		await page.keyboard.press("Escape");
		await page.waitForTimeout(300);
	}
	// The stock is still registered: Escape cancels, nothing is removed.
	await expect(page.locator('tr[data-stock-id="us:AAPL"]')).toBeVisible();

	/* ---------- W4. Subscription link shown once ---------- */
	await page.getByRole("button", { name: "Create subscription link" }).click();
	const issued = page.getByLabel("Subscription link (shown once)");
	await expect(issued).toBeVisible({ timeout: 30_000 });
	await page.waitForTimeout(400);
	await shot(page, "W4-feed-issued");
	await audit(page, "W feed issued");

	/* ---------- W5/W6. Small viewports ---------- */
	for (const [name, width, height] of [
		["tablet", 820, 1180],
		["phone", 390, 844],
	] as const) {
		await page.setViewportSize({ width, height });
		await page.goto("/#/watchlist");
		await page.waitForTimeout(1200);
		await shot(page, `W-${name}-top`);
		await audit(page, `W ${name} top`);
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await page.waitForTimeout(500);
		await shot(page, `W-${name}-bottom`);
		await audit(page, `W ${name} bottom`);
	}
	await page.setViewportSize({ width: 1440, height: 900 });

	/* ---------- W7. The Home earnings-calendar widget ---------- */
	const dashboardUrl = `${E2E_ORIGIN}/api/v1/home/dashboard`;
	const original = (await (await page.request.get(dashboardUrl)).json()) as {
		dashboard: { schemaVersion: number; widgets: { widgetId: string }[] };
		version: number;
	};
	const withCalendar = await page.request.put(dashboardUrl, {
		headers: WRITE_HEADERS,
		data: {
			dashboard: {
				schemaVersion: original.dashboard.schemaVersion,
				// First, so the widget is inside the first viewport at every width.
				widgets: [
					{
						type: "earnings-calendar",
						widgetId: "w-review-earnings",
						title: "Earnings calendar",
						size: "large",
						daysAhead: 180,
					},
					...original.dashboard.widgets.filter((entry) => entry.widgetId !== "w-review-earnings"),
				],
			},
			expectedVersion: original.version,
		},
	});
	if (!withCalendar.ok()) {
		throw new Error(`the review dashboard was not saved: ${withCalendar.status()}`);
	}
	const savedVersion = ((await withCalendar.json()) as { version: number }).version;
	for (const [name, width, height] of [
		["desktop", 1440, 900],
		["phone", 390, 844],
	] as const) {
		await page.setViewportSize({ width, height });
		await page.goto("/#/home");
		const widget = page.locator('[data-widget-id="w-review-earnings"]');
		await widget.getByRole("button", { name: "Refresh earnings dates" }).waitFor({
			timeout: 60_000,
		});
		// The glanceable widget: a compact month grid (not a table of rows).
		await expect(widget.getByRole("table")).toContainText("earnings announcements");
		await widget.scrollIntoViewIfNeeded();
		await page.waitForTimeout(1200);
		await shot(page, `W7-home-widget-${name}`);
		await audit(page, `W7 home widget ${name}`);
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	// Leave the dashboard as the other review specs expect it.
	await page.request.put(dashboardUrl, {
		headers: WRITE_HEADERS,
		data: { dashboard: original.dashboard, expectedVersion: savedVersion },
	});

	/* ---------- W8. The Google Calendar card: disconnected and connected ---------- */
	await page.goto("/#/watchlist");
	await expect(page.locator('[data-field="watchlist-status"]')).toContainText(
		"Last successful refresh:",
		{ timeout: 30_000 },
	);
	const card = page.locator("[data-calendar-section]");
	await card.getByRole("button", { name: "Connect Google Calendar" }).waitFor({
		timeout: 30_000,
	});
	await card.scrollIntoViewIfNeeded();
	await page.waitForTimeout(600);
	await shot(page, "W8-google-disconnected");
	await audit(page, "W google disconnected");
	await card.getByRole("button", { name: "Connect Google Calendar" }).click();
	const signIn = card.getByRole("link", { name: "Open Google sign-in" });
	await signIn.waitFor({ timeout: 60_000 });
	await expect(signIn).toHaveAttribute(
		"href",
		/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
	);
	await card.scrollIntoViewIfNeeded();
	await page.waitForTimeout(400);
	await shot(page, "W8-google-connecting");
	await audit(page, "W google connecting");
	// The scripted runner completes the sign-in: the card lands connected
	// (and the automatic sync follows on its own).
	await card.getByText(/Connected since/).waitFor({ timeout: 120_000 });
	await card.scrollIntoViewIfNeeded();
	await page.waitForTimeout(600);
	await shot(page, "W8-google-connected");
	await audit(page, "W google connected");

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
	console.log(`ui-review (watchlist): ${findings.length} findings, screenshots in ${OUT}/`);
	await context.close();
});
