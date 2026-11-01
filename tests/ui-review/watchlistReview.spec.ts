import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { parseBrowser } from "../e2e/engines.ts";
import { E2E_ORIGIN } from "../e2e/fixtures.ts";
import { waitForSync } from "../e2e/marketSync.ts";
import { countByRule, formatSummaryTable, type ReviewFinding } from "./reviewMath.ts";

/**
 * Scripted UI review of the Registered stocks page (`bun run review:ui`, with
 * `chatReview.spec.ts` and `homeReview.spec.ts`). REVIEW, not a gate: drives
 * Registered stocks through loading, populated, stock-lists, remove-dialog,
 * feed and small-viewport states — plus the Stocks page's search and its
 * Add to Watchlist dialog, where stocks are added (ADR-0050) — at
 * 1440/820/390 px, records PNGs plus APPENDED
 * findings in `test-results/ui-review/<engine>/findings.json`, and prints a
 * summary table. Runs after `homeReview.spec.ts` (alphabetical, one worker)
 * against the same server stack; earnings dates come from the fixture
 * Finnhub/JPX sources, so every date is fixture data. The review requests no
 * refresh: the API queues the never-refreshed stocks' earnings dates at the
 * runner's next claim (ADR-0051). Registered stocks shows its lists only
 * and starts no sync (ADR-0054), so the review stocks sit in one list, the
 * remove confirmation is the Stocks page's Remove from Watchlist, and the
 * Google card shows the server's sync after the connect.
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

interface WatchlistState {
	readonly stocks: readonly { readonly stockId: string; readonly lastRefreshedAt: string | null }[];
	readonly lists: readonly { readonly listId: string; readonly title: string }[];
	readonly refresh: {
		readonly activeRunId: string | null;
		readonly lastSucceededAt: string | null;
	};
}

async function watchlistState(page: Page): Promise<WatchlistState> {
	return (await (
		await page.request.get(`${E2E_ORIGIN}/api/v1/watchlist`)
	).json()) as WatchlistState;
}

const REVIEW_STOCKS = [
	["US", "AAPL"],
	["JP", "7203"],
] as const;

/** The review's list on Registered stocks, which shows its lists' stocks only (ADR-0054). */
const REVIEW_LIST = "Review";

/**
 * The watchlist holds AAPL + 7203 with fixture dates, both in the review
 * list: each new stock is never refreshed, so the server fetches its dates
 * at the runner's next claim; this waits until no run is active and both
 * carry a stamp.
 */
async function ensurePopulated(page: Page): Promise<void> {
	const existing = (await watchlistState(page)).lists.find((list) => list.title === REVIEW_LIST);
	let listId = existing?.listId ?? null;
	if (listId === null) {
		const created = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/lists`, {
			headers: WRITE_HEADERS,
			data: { title: REVIEW_LIST },
		});
		listId =
			((await created.json()) as WatchlistState).lists.find((list) => list.title === REVIEW_LIST)
				?.listId ?? null;
	}
	if (listId === null) throw new Error("the review list was not created");
	for (const [market, symbol] of REVIEW_STOCKS) {
		// A list add puts the stock on the watchlist first; a repeat is refused harmlessly.
		await page.request.post(
			`${E2E_ORIGIN}/api/v1/watchlist/lists/${encodeURIComponent(listId)}/stocks`,
			{ headers: WRITE_HEADERS, data: { market, symbol } },
		);
	}
	const ids = REVIEW_STOCKS.map(([market, symbol]) => `${market.toLowerCase()}:${symbol}`);
	await waitForSync(
		() => watchlistState(page),
		(current) =>
			ids.every(
				(stockId) =>
					(current.stocks.find((stock) => stock.stockId === stockId)?.lastRefreshedAt ?? null) !==
					null,
			),
		"the review stocks' earnings dates",
		{ timeoutMs: 150_000 },
	);
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
	await page.goto("/#/registered");
	await page.waitForTimeout(700);
	await shot(page, "W0-loading");
	await audit(page, "W loading");
	delayWatchlist = false;

	await ensurePopulated(page);
	await page.goto("/#/registered");
	// The review list's tab shows both stocks (symbol, market, Remove from list).
	await expect(page.locator('table[data-field="stocks"] tbody tr')).toHaveCount(
		REVIEW_STOCKS.length,
		{ timeout: 30_000 },
	);

	/* ---------- W1. Populated desktop ---------- */
	await page.waitForTimeout(600);
	await shot(page, "W1-desktop-populated");
	await audit(page, "W desktop populated");

	/* ---------- W2. Stock lists (ADR-0050 §4: Registered stocks has no add form) ---------- */
	// The server queued the fixture stock lists at the runner's claim (ADR-0054 §2).
	const stockLists = page.getByRole("region", { name: "Market stock lists", exact: true });
	const lists = stockLists.locator('[data-field="directory-status"]');
	await expect(lists.locator('p[data-market="JP"]')).toContainText("stocks, as of", {
		timeout: 120_000,
	});
	await expect(lists.locator('p[data-market="US"]')).toContainText(
		/^US list: [\d,]+ stocks, retrieved /,
		{ timeout: 120_000 },
	);
	await stockLists.scrollIntoViewIfNeeded();
	await page.waitForTimeout(300);
	await shot(page, "W2-stock-lists");
	await audit(page, "W stock lists");

	/* ---------- W2b. The Stocks page's search with its list open (ADR-0050 §1) ---------- */
	await page.goto("/#/stocks");
	const search = page.getByRole("combobox", { name: "Search stocks" });
	await search.fill("toyota");
	const listbox = page.getByRole("listbox", { name: "Matching stocks" });
	await expect(listbox.locator('[data-stock-id="jp:7203"]')).toBeVisible({ timeout: 30_000 });
	await search.press("ArrowDown");
	await page.waitForTimeout(300);
	await shot(page, "W2b-search-open");
	await audit(page, "W search open");
	await search.press("Escape");
	await search.press("Escape");
	await expect(search).toHaveValue("");

	/* ---------- W2c. The Add to Watchlist dialog (ADR-0050 §2), cancelled ---------- */
	await page.goto("/#/stocks/jp:6758");
	await page
		.locator('[data-field="stock-watchlist"]')
		.getByRole("button", { name: "Add to Watchlist" })
		.click({ timeout: 30_000 });
	const addDialog = page.getByRole("dialog", { name: "Add 6758 to the Watchlist" });
	await expect(addDialog).toBeVisible();
	await page.waitForTimeout(400);
	await shot(page, "W2c-add-to-watchlist-dialog");
	await audit(page, "W add to watchlist dialog");
	await page.keyboard.press("Escape");
	await expect(addDialog).toHaveCount(0);

	/* ---------- W3. Remove from Watchlist confirmation (the Stocks page, ADR-0054) ---------- */
	await page.goto("/#/stocks/us:AAPL");
	await page.locator('[data-field="stock-remove-from-watchlist"]').click({ timeout: 30_000 });
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
	await expect(page.locator('[data-field="stock-watchlist-status"]')).toHaveText(
		/^On the Watchlist/,
	);

	/* ---------- W4. Subscription link shown once (Settings → Calendar, ADR-0022) ---------- */
	await page.goto("/#/settings/calendar");
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
		await page.goto("/#/registered");
		await page.waitForTimeout(1200);
		await shot(page, `W-${name}-top`);
		await audit(page, `W ${name} top`);
		await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
		await page.waitForTimeout(500);
		await shot(page, `W-${name}-bottom`);
		await audit(page, `W ${name} bottom`);
		await page.goto("/#/settings/calendar");
		await page.waitForTimeout(1200);
		await shot(page, `W-${name}-settings-calendar`);
		await audit(page, `W ${name} settings calendar`);
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
		await widget.getByRole("table").waitFor({ timeout: 60_000 });
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

	/* ---------- W8. The Google Calendar card (Settings → Calendar): disconnected and connected ---------- */
	await page.goto("/#/settings/calendar");
	const card = page.getByRole("region", { name: "Calendar" });
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
	// The scripted runner completes the sign-in: the card lands connected,
	// and the server's sync follows at the runner's next claim (ADR-0054 §3).
	await card.getByText(/Connected since/).waitFor({ timeout: 120_000 });
	await card.getByText(/Last synced/).waitFor({ timeout: 120_000 });
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
