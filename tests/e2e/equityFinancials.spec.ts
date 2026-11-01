import { type ChildProcess, spawn } from "node:child_process";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	type EquityCompanyView,
	equityCompanyListSchema,
	equityFilingResultSchema,
	homeDashboardResponseSchema,
	watchlistResponseSchema,
} from "@research/contracts";
import {
	EQUITY_CONCEPT_MAPPINGS,
	type EquityMetricCode,
	fiscalYearOfPeriodEnd,
	isAnnualDuration,
} from "@research/domain";
import { z } from "zod";
import edinetCompletion from "../../examples/fixtures/equity-sync/e2e-edinet.json" with {
	type: "json",
};
import { baseChildEnv, suiteRunnerSettings } from "../../scripts/testEnv.ts";
import { E2E_ORIGIN, E2E_PORT } from "./fixtures.ts";

/**
 * Financial statements end to end (ADR-0048, ADR-0054 §1): a US and a
 * Japanese stock put on the Watchlist (and one list) through the API as an
 * isolated owner; the server tracks them at the runner's next claim and the
 * REAL runner loop syncs them from the canned SEC and EDINET completions
 * (`tests/e2e/equitySyncFixtures.ts`; no keys, no network), then they are
 * read in the browser — the list's rows on Registered stocks, each name
 * opening the Stocks page's Financial statements tab with its read-only
 * sync line (ADR-0049), the statement switch, a revised value's history,
 * Add to Home for a statement and a chart — and Home
 * showing both widgets after a reload. Every request the page makes stays on
 * our origin: nothing in the browser reaches SEC or EDINET. The pages run
 * under their Content-Security-Policy without errors.
 */
test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let runner: ChildProcess | null = null;
const owner = `e2e-equity-financials-${Date.now()}@example.test`;
const consoleErrors: string[] = [];
const requestedUrls: string[] = [];
const WRITE_HEADERS = {
	Origin: E2E_ORIGIN,
	[CSRF_HEADER]: CSRF_HEADER_VALUE,
	"Content-Type": "application/json",
};

test.beforeAll(async ({ browser }) => {
	context = await browser.newContext({ extraHTTPHeaders: { "X-E2E-Owner": owner } });
	page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	page.on("pageerror", (error) => consoleErrors.push(error.message));
	page.on("request", (request) => requestedUrls.push(request.url()));
	await page.setViewportSize({ width: 1440, height: 900 });
	runner = spawn("node", ["tests/e2e/runnerHarness.ts"], {
		cwd: new URL("../..", import.meta.url).pathname,
		env: {
			...baseChildEnv(),
			...suiteRunnerSettings(),
			E2E_PORT: String(E2E_PORT),
			E2E_RUNNER_OWNER: owner,
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
});

test.afterAll(async () => {
	if (runner !== null && runner.exitCode === null) {
		const exited = new Promise<void>((resolve) => runner?.once("exit", () => resolve()));
		runner.kill("SIGTERM");
		await exited;
	}
	runner = null;
	await context.close();
});

/** Puts a stock on the Watchlist and in `listId`: the server then tracks its company. */
async function watch(listId: string, market: "US" | "JP", symbol: string): Promise<void> {
	const answer = await page.request.post(
		`${E2E_ORIGIN}/api/v1/watchlist/lists/${encodeURIComponent(listId)}/stocks`,
		{ headers: WRITE_HEADERS, data: { market, symbol } },
	);
	expect(answer.status()).toBe(200);
}

async function createList(title: string): Promise<string> {
	const answer = await page.request.post(`${E2E_ORIGIN}/api/v1/watchlist/lists`, {
		headers: WRITE_HEADERS,
		data: { title },
	});
	expect(answer.status()).toBe(201);
	const listId = watchlistResponseSchema.parse(await answer.json()).lists[0]?.listId ?? "";
	expect(listId).not.toBe("");
	return listId;
}

/**
 * How many as-filed values the revisions read lists for one metric-year of
 * the EDINET fixture: every fact, in either scope, of every filing whose
 * concept the metric maps for the filing's standard and whose annual period
 * falls in the fiscal year. Derived from the file the fixture runner serves,
 * so the expectation follows the fixture when it is re-recorded.
 */
function fixtureRevisionCount(metric: EquityMetricCode, fiscalYear: number): number {
	const filings = z.array(equityFilingResultSchema).parse(edinetCompletion.filings);
	let count = 0;
	for (const filing of filings) {
		const concepts = new Set(
			EQUITY_CONCEPT_MAPPINGS.filter(
				(mapping) => mapping.metric === metric && mapping.standard === filing.accountingStandard,
			).map((mapping) => mapping.concept),
		);
		for (const fact of filing.facts) {
			if (!concepts.has(fact.concept) || fact.periodStart === null) continue;
			if (!isAnnualDuration(fact.periodStart, fact.periodEnd)) continue;
			if (fiscalYearOfPeriodEnd(fact.periodEnd) === fiscalYear) count += 1;
		}
	}
	return count;
}

async function companies(): Promise<readonly EquityCompanyView[]> {
	const answer = await page.request.get(`${E2E_ORIGIN}/api/v1/equities/companies`);
	expect(answer.status()).toBe(200);
	return equityCompanyListSchema.parse(await answer.json()).companies;
}

test("Watchlist stocks sync from the fixture sources and their values reach the page and Home", async () => {
	test.setTimeout(240_000);
	await page.goto("/#/registered");
	await expect(page.getByRole("heading", { name: "Registered stocks", level: 2 })).toBeVisible();

	const listId = await createList("Statements");
	await watch(listId, "US", "AAPL");
	await watch(listId, "JP", "7974");
	// The claim tracks both (ADR-0054 §1); the runner then claims one
	// financial-sync job at a time, and values appear once each company's
	// first filings are stored.
	let synced: readonly EquityCompanyView[] = [];
	await expect
		.poll(
			async () => {
				synced = (await companies()).filter(
					(company) => company.filingCount > 0 && company.latestFiscalYear !== null,
				);
				return synced.map((company) => `${company.market}:${company.symbol}`).sort();
			},
			{ timeout: 180_000, intervals: [1_000, 2_000, 5_000] },
		)
		.toEqual(["JP:7974", "US:AAPL"]);
	const companyOf = (symbol: string): EquityCompanyView => {
		const company = synced.find((entry) => entry.symbol === symbol);
		if (company === undefined) throw new Error(`${symbol} was not synced`);
		return company;
	};
	const apple = companyOf("AAPL");
	const nintendo = companyOf("7974");

	await page.reload();
	const table = page.locator('table[data-field="stocks"]');
	const appleRow = table.locator('tr[data-stock-id="us:AAPL"]');
	const nintendoRow = table.locator('tr[data-stock-id="jp:7974"]');
	await expect(appleRow).toContainText("AAPL");
	await expect(nintendoRow).toContainText("7974");

	// The Japanese company's income statement: yen millions, ordinary income reported.
	await nintendoRow.locator('a[data-show-stock="jp:7974"]').click();
	await expect(page).toHaveURL(/#\/stocks\/jp:7974$/);
	await page.getByRole("tab", { name: "Financial statements" }).click();
	const financials = page.locator("#stock-panel-financials");
	// Synced by the server: no sync line, nothing to press (ADR-0055 §4).
	const detail = financials.locator('[data-field="company-detail"]');
	await expect(detail).toHaveAttribute("data-company-id", nintendo.companyId);
	await expect(financials.locator('[data-field="financials-sync"]')).toHaveCount(0);
	await expect(financials.getByRole("button", { name: /sync/i })).toHaveCount(0);
	const statement = detail.locator("table[data-statement]");
	await expect(statement).toHaveAttribute("data-statement", "income-statement");
	await expect(statement.locator("caption")).toHaveText("Income statement, JPY millions");
	await expect(
		statement.locator('tr[data-metric="ordinary-income"] [data-value-button]').first(),
	).toBeVisible();

	// Switch statements with the segmented control.
	const statements = financials.locator('[data-segmented="equities-statement"]');
	await statements.getByRole("button", { name: "Balance sheet" }).click();
	await expect(statement).toHaveAttribute("data-statement", "balance-sheet");
	await statements.getByRole("button", { name: "Cash flow statement" }).click();
	await expect(statement).toHaveAttribute("data-statement", "cash-flow");
	await statements.getByRole("button", { name: "Income statement" }).click();

	// The restated revenue of FY2024 (the fixture's amendment, S100SYA4, and
	// the next year's report restate the original S100SY24) opens its
	// revision history: every as-filed value in both scopes, exactly one of
	// them the current value.
	const revised = statement.locator(
		'tr[data-metric="revenue"] td[data-fiscal-year="2024"] [data-value-button]',
	);
	await expect(revised.locator('[data-mark="revised"]')).toBeVisible();
	await revised.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	const history = dialog.locator('table[data-field="revisions"]');
	const expectedRows = fixtureRevisionCount("revenue", 2024);
	expect(expectedRows).toBeGreaterThan(1);
	await expect(history.locator("tbody tr")).toHaveCount(expectedRows, { timeout: 10_000 });
	await expect(history.locator('tr[data-current="true"]')).toHaveCount(1);
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();

	// The US company, chosen back on Registered stocks: Add the statement and
	// a chart to Home.
	await page.getByRole("link", { name: "Choose another stock" }).click();
	await expect(page).toHaveURL(/#\/registered$/);
	await appleRow.locator('a[data-show-stock="us:AAPL"]').click();
	await expect(page).toHaveURL(/#\/stocks\/us:AAPL$/);
	await page.getByRole("tab", { name: "Financial statements" }).click();
	await expect(detail).toHaveAttribute("data-company-id", apple.companyId);
	await expect(statement.locator("caption")).toHaveText("Income statement, USD millions");
	await financials.getByRole("button", { name: "Add this statement to Home" }).click();
	await expect(financials.locator('[data-field="financials-outcome"]')).toContainText("to Home.");
	await financials.getByLabel("Chart").selectOption("revenue");
	await financials.getByRole("button", { name: "Add chart to Home" }).click();
	await expect(financials.locator('[data-field="financials-outcome"]')).toContainText("Revenue of");

	const stored = homeDashboardResponseSchema.parse(
		await (await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`)).json(),
	);
	expect(stored.dashboard.widgets.map((widget) => widget.type)).toEqual(
		expect.arrayContaining(["financial-statement", "financial-history"]),
	);

	// Home after a reload: both widgets read their values from our API.
	await page.goto("/#/home");
	await page.reload();
	const statementWidget = page.locator('[data-widget-kind="financial-statement"]');
	await expect(statementWidget.locator("table[data-statement]")).toBeVisible({ timeout: 30_000 });
	await expect(
		statementWidget.locator('tr[data-metric="revenue"] [data-value-button]').first(),
	).toBeVisible();
	const historyWidget = page.locator('[data-widget-kind="financial-history"]');
	await expect(historyWidget.locator("path[data-bar]").first()).toBeVisible();

	// The widget's statement switch saves through Home's own save and survives a reload.
	await statementWidget
		.locator('[data-segmented="statement"]')
		.getByRole("button", { name: "Balance sheet" })
		.click();
	await expect(statementWidget.locator("table[data-statement]")).toHaveAttribute(
		"data-statement",
		"balance-sheet",
	);
	await expect
		.poll(async () => {
			const home = homeDashboardResponseSchema.parse(
				await (await page.request.get(`${E2E_ORIGIN}/api/v1/home/dashboard`)).json(),
			);
			const widget = home.dashboard.widgets.find((entry) => entry.type === "financial-statement");
			return widget?.type === "financial-statement" ? widget.statement : null;
		})
		.toBe("balance-sheet");
	await page.reload();
	await expect(
		page.locator('[data-widget-kind="financial-statement"] table[data-statement]'),
	).toHaveAttribute("data-statement", "balance-sheet", { timeout: 30_000 });

	// The browser never left our origin (no SEC, no EDINET).
	const outside = requestedUrls.filter(
		(url) => !url.startsWith(E2E_ORIGIN) && !url.startsWith("data:"),
	);
	expect(outside).toEqual([]);
	expect(consoleErrors).toEqual([]);
});
