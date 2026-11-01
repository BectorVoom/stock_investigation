import { expect, type Page } from "@playwright/test";
import { stockDirectoryStatusResponseSchema, type WatchMarket } from "@research/contracts";

/**
 * Stocks page steps shared by the browser specs (ADR-0050): stocks are
 * added from the Stocks page — its "Find a stock" search opens a stock and
 * the "Add to Watchlist" button beside the heading adds it. Registered
 * stocks has no add form any more (only each list's own Add stock dialog).
 * The steps act on the page as it is: the caller navigates, so the
 * real-network specs can use their own origin.
 */

/** The stock id as a URL pattern: `#/stocks/<stockId>` with no tab. */
function stockUrl(stockId: string): RegExp {
	return new RegExp(`#/stocks/${stockId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/**
 * Types `query` into "Find a stock" (the Stocks page must be open) and
 * picks the hit `stockId`, which opens that stock and clears the box.
 */
export async function openStockFromSearch(
	page: Page,
	query: string,
	stockId: string,
): Promise<void> {
	const box = page.getByRole("combobox", { name: "Search stocks" });
	await box.fill(query);
	const option = page
		.getByRole("listbox", { name: "Matching stocks" })
		.locator(`[data-stock-id="${stockId}"]`);
	await expect(option).toBeVisible({ timeout: 30_000 });
	await option.click();
	await expect(page).toHaveURL(stockUrl(stockId));
	await expect(box).toHaveValue("");
}

/**
 * Puts the stock the Stocks page shows on the watchlist alone: "Add to
 * Watchlist", then the dialog's Add with no list ticked. Like any new
 * stock, it is never refreshed, so the server queues its earnings dates at
 * the runner's next claim (ADR-0051). The stock must not be on
 * the watchlist yet (the button would read "Add to a list" or be absent).
 */
export async function addShownStockToWatchlist(page: Page, symbol: string): Promise<void> {
	const part = page.locator('[data-field="stock-watchlist"]');
	await part.getByRole("button", { name: "Add to Watchlist" }).click({ timeout: 30_000 });
	const dialog = page.getByRole("dialog", { name: `Add ${symbol} to the Watchlist` });
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Add", exact: true }).click();
	await expect(dialog).toHaveCount(0, { timeout: 30_000 });
	await expect(part.locator('[data-field="stock-watchlist-status"]')).toHaveText(
		/^On the Watchlist/,
	);
}

/**
 * Waits until `market`'s stock list is stored, reading the API's directory
 * status (Registered stocks queues a missing list when it opens and shows
 * no stock-lists area since 2026-11-01). Returns the stored market status.
 */
export async function waitForStoredStockList(
	page: Page,
	origin: string,
	market: WatchMarket,
	timeout = 120_000,
): Promise<{ readonly entryCount: number; readonly asOf: string | null }> {
	let stored: { entryCount: number; asOf: string | null } | null = null;
	await expect
		.poll(
			async () => {
				const answer = await page.request.get(`${origin}/api/v1/watchlist/directory`);
				if (!answer.ok()) return 0;
				const status = stockDirectoryStatusResponseSchema.parse(await answer.json());
				const entry = status.markets.find((candidate) => candidate.market === market);
				if (entry === undefined || entry.retrievedAt === null) return 0;
				stored = { entryCount: entry.entryCount, asOf: entry.asOf };
				return entry.entryCount;
			},
			{ timeout, intervals: [1_000] },
		)
		.toBeGreaterThan(0);
	if (stored === null) throw new Error(`the ${market} stock list was not stored`);
	return stored;
}
