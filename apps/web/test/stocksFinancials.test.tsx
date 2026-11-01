import {
	DEFAULT_HOME_DASHBOARD,
	type EquityCompanyView,
	type HomeDashboard,
	homeDashboardResponseSchema,
	putHomeDashboardRequestSchema,
} from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockRoute } from "../src/router.ts";
import { APPLE_ID, makeCompany, NINTENDO, nintendoSynced } from "./equitiesHarness.ts";
import { errorResponse, jsonResponse } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import { createStocksBackend, mountStocks, type StocksServer } from "./stocksHarness.tsx";

/**
 * The Stocks page's Financial statements and Company tabs (ADR-0049 §5,
 * §6): the Equities page's company detail, moved, and what the Company tab
 * reads. The companies are tracked only (the watchlist is empty), as on the
 * Equities page before.
 */

const NOW = Date.parse("2026-10-31T10:00:00Z");
const APPLE: StockRoute = { stockId: "us:AAPL", tab: "financials" };
const NINTENDO_ROUTE: StockRoute = { stockId: "jp:7974", tab: "financials" };

/** The Home routes "Add to Home" writes to. */
function installHomeRoutes(api: StocksServer): { dashboard: () => HomeDashboard } {
	let dashboard: HomeDashboard = structuredClone(DEFAULT_HOME_DASHBOARD);
	let version = 1;
	api.backend.on("GET", /^\/api\/v1\/home\/dashboard$/, () =>
		jsonResponse(
			homeDashboardResponseSchema.parse({
				dashboard,
				version,
				updatedAt: "2026-10-31T00:00:00Z",
				origin: "saved",
			}),
		),
	);
	api.backend.on("PUT", /^\/api\/v1\/home\/dashboard$/, (request) => {
		dashboard = putHomeDashboardRequestSchema.parse(request.body).dashboard;
		version += 1;
		return jsonResponse(
			homeDashboardResponseSchema.parse({
				dashboard,
				version,
				updatedAt: "2026-10-31T10:00:00Z",
				origin: "saved",
			}),
		);
	});
	return { dashboard: () => dashboard };
}

function serve(companies: EquityCompanyView[] = [makeCompany(), NINTENDO()]): StocksServer {
	const api = createStocksBackend({ companies });
	api.server.stocks = [];
	return api;
}

function panel(): HTMLElement {
	const element = document.querySelector('[data-field="stock-financials-tab"]');
	if (!(element instanceof HTMLElement)) throw new Error("no Financial statements tab");
	return element;
}

async function statementShown(): Promise<HTMLElement> {
	return waitFor(() => {
		const element = document.querySelector('[data-field="company-detail"]');
		if (
			!(element instanceof HTMLElement) ||
			element.querySelector("table[data-statement]") === null
		) {
			throw new Error("no statement yet");
		}
		return element;
	});
}

/** Opens "Filings (n)" and answers its table once read. */
async function openFilings(): Promise<HTMLTableElement> {
	const details = document.querySelector('[data-field="company-filings"]');
	if (!(details instanceof HTMLDetailsElement)) throw new Error("no filings disclosure");
	details.open = true;
	fireEvent(details, new Event("toggle"));
	return waitFor(() => {
		const element = details.querySelector('table[data-field="filings"]');
		if (!(element instanceof HTMLTableElement)) throw new Error("no filings yet");
		return element;
	});
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	resetGlobalFetchCalls();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("Financial statements tab (ADR-0049 §5)", () => {
	it("heads the tab with the sync status, then the statements; switches statement and years", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		const shown = await statementShown();
		expect(panel().querySelector('[data-field="sync-status"]')?.textContent).toBe(
			"Sync: Synced · Last synced 2 hours ago",
		);
		expect(shown.querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
			"income-statement",
		);
		const statements = document.querySelector('[data-segmented="equities-statement"]');
		if (!(statements instanceof HTMLElement)) throw new Error("no statement switch");
		fireEvent.click(within(statements).getByRole("button", { name: "Balance sheet" }));
		await waitFor(() =>
			expect(document.querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
				"balance-sheet",
			),
		);
		const years = document.querySelector('[data-segmented="equities-years"]');
		if (!(years instanceof HTMLElement)) throw new Error("no years switch");
		fireEvent.click(within(years).getByRole("button", { name: "10 years" }));
		await waitFor(() =>
			expect(api.backend.requestsTo("GET", /\/statements\/balance-sheet\?years=10$/)).toHaveLength(
				1,
			),
		);
	});

	it("reads the filings only when their disclosure opens, newest first, whatever the statement", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		const details = document.querySelector('[data-field="company-filings"]');
		expect(details?.querySelector("summary")?.textContent).toBe("Filings (6)");
		expect(details).toHaveProperty("open", false);
		expect(api.backend.requestsTo("GET", /\/filings$/)).toHaveLength(0);
		const filings = await openFilings();
		expect(api.backend.requestsTo("GET", /\/filings$/)).toHaveLength(1);
		expect(filings.caption?.textContent).toBe("Stored annual reports of this company");
		const rows = [...filings.querySelectorAll("tbody tr")];
		expect(rows.map((row) => row.getAttribute("data-filing-id"))).toEqual([
			"fil_2025",
			"fil_2024",
			"fil_2023_a",
			"fil_2023",
			"fil_2022",
			"fil_2021",
			"fil_2020",
		]);
		const pending = filings.querySelector('tr[data-filing-id="fil_2025"]');
		expect(pending?.querySelector('[data-field="filing-facts"]')?.textContent).toBe(
			"Pending: read again by the next sync",
		);
		expect(pending?.querySelector("th")?.getAttribute("scope")).toBe("row");
		expect(
			filings.querySelector('tr[data-filing-id="fil_2024"] [data-field="filing-facts"]')
				?.textContent,
		).toBe("Read24 values");
		const amended = filings.querySelector('tr[data-filing-id="fil_2023_a"]');
		expect(amended?.textContent).toContain("Form 10-K/A");
		expect(amended?.textContent).toContain("US GAAP");
		expect(amended?.querySelector('[data-field="filing-amendment"]')?.textContent).toBe(
			"Amends 0000320193-23-000123",
		);
		const link = within(pending instanceof HTMLElement ? pending : filings).getByRole("link", {
			name: "Open Form 10-K filed 2025-11-01",
		});
		expect(link.getAttribute("href")).toBe(
			"https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/",
		);
		// The filings do not follow the statement switch: one read, the same rows.
		const statements = document.querySelector('[data-segmented="equities-statement"]');
		if (!(statements instanceof HTMLElement)) throw new Error("no statement switch");
		fireEvent.click(within(statements).getByRole("button", { name: "Cash flow statement" }));
		await waitFor(() =>
			expect(document.querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
				"cash-flow",
			),
		);
		expect(api.backend.requestsTo("GET", /\/filings$/)).toHaveLength(1);
	});

	it("says a filing had no machine-readable values, and a company without filings has none yet", async () => {
		const api = serve([nintendoSynced(), makeCompany()]);
		mountStocks(api.backend, { route: NINTENDO_ROUTE });
		await statementShown();
		const filings = await openFilings();
		expect(
			filings.querySelector('tr[data-filing-id="fil_jp_2022"] [data-field="filing-facts"]')
				?.textContent,
		).toBe("No machine-readable values");
		expect(
			filings.querySelector('tr[data-filing-id="fil_jp_2024_a"] [data-field="filing-amendment"]')
				?.textContent,
		).toBe("Amends S100N024");
		cleanup();
		const empty = serve([NINTENDO()]);
		mountStocks(empty.backend, { route: NINTENDO_ROUTE });
		await waitFor(() =>
			expect(document.querySelector('[data-field="company-filings"]')).not.toBeNull(),
		);
		await openFilings().catch(() => undefined);
		await waitFor(() =>
			expect(document.querySelector('[data-field="company-filings"]')?.textContent).toContain(
				"No filings are stored yet.",
			),
		);
		// A tracked company without values says so instead of an empty table.
		expect(panel().textContent).toContain("No financial data yet.");
	});

	it("says a company removed elsewhere is gone instead of loading forever, and re-reads the list", async () => {
		const api = serve();
		const gone = () =>
			errorResponse(404, "EQUITY_COMPANY_NOT_FOUND", "The company is not tracked.");
		api.backend.on("GET", /\/companies\/eqc_apple\/statements\//, gone);
		mountStocks(api.backend, { route: APPLE });
		await waitFor(() =>
			expect(document.querySelector('[data-field="statement-company-gone"]')).not.toBeNull(),
		);
		await waitFor(() =>
			expect(api.backend.requestsTo("GET", /\/equities\/companies$/).length).toBeGreaterThanOrEqual(
				2,
			),
		);
	});

	it("opens a revised value's history from the tab's table", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		const shown = await statementShown();
		const revised = shown.querySelector(
			'tr[data-metric="revenue"] td[data-fiscal-year="2023"] button',
		);
		if (!(revised instanceof HTMLButtonElement)) throw new Error("no revised value");
		fireEvent.click(revised);
		const dialog = await screen.findByRole("dialog", { name: "Revenue, FY2023" });
		await within(dialog).findByRole("table");
		expect(dialog.textContent).toContain("Values each filing reported");
	});

	it("offers no sync from the tab: a synced company shows its status only (ADR-0054)", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		expect(within(panel()).queryByRole("button", { name: /^Sync/ })).toBeNull();
		expect(panel().querySelector('[data-field="financials-sync"]')?.textContent).toContain(
			"Synced",
		);
		expect(api.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("says when an unsynced stock's statements come, and offers no button to sync them", async () => {
		// AAPL is on the Watchlist but has no company yet: the server's first sync is on its way.
		const api = createStocksBackend({ companies: [] });
		mountStocks(api.backend, { route: APPLE });
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-not-tracked"]')).not.toBeNull(),
		);
		expect(panel().textContent).toContain(
			"The server syncs the annual financial statements of every Watchlist stock. This stock's first sync runs when the local runner next takes work.",
		);
		expect(within(panel()).queryByRole("button")).toBeNull();
		cleanup();

		// KO is not on the Watchlist: it is synced once it is added.
		const other = createStocksBackend({ companies: [] });
		mountStocks(other.backend, { route: { stockId: "us:KO", tab: "financials" } });
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-not-tracked"]')).not.toBeNull(),
		);
		expect(panel().textContent).toContain(
			"Annual financial statements are synced for Watchlist stocks. Add this stock to the Watchlist to sync its statements.",
		);
		expect(within(panel()).queryByRole("button")).toBeNull();
		expect(other.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("adds the shown statement and a metric chart to Home", async () => {
		const api = serve();
		const home = installHomeRoutes(api);
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		fireEvent.click(screen.getByRole("button", { name: "Add this statement to Home" }));
		await waitFor(() =>
			expect(
				screen.getByText(/Added Income statement — Apple Inc\. \(AAPL\) to Home\./),
			).toBeTruthy(),
		);
		expect(home.dashboard().widgets.at(-1)).toMatchObject({
			type: "financial-statement",
			companyId: APPLE_ID,
			statement: "income-statement",
			years: 5,
			title: "Apple Inc. (AAPL)",
			size: "large",
		});
		const metric = within(panel()).getByLabelText("Chart");
		if (!(metric instanceof HTMLSelectElement)) throw new Error("no metric select");
		metric.value = "free-cash-flow";
		fireEvent.change(metric);
		fireEvent.click(screen.getByRole("button", { name: "Add chart to Home" }));
		await waitFor(() =>
			expect(home.dashboard().widgets.at(-1)).toMatchObject({
				type: "financial-history",
				companyId: APPLE_ID,
				metric: "free-cash-flow",
				size: "medium",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Add this statement to Home" }));
		await waitFor(() => expect(screen.getByText(/is already on Home\./)).toBeTruthy());
		expect(
			home.dashboard().widgets.filter((widget) => widget.type === "financial-statement"),
		).toHaveLength(1);
	});

	it("never requests anything but our own API", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		expect(api.backend.requests.every((request) => request.path.startsWith("/api/v1/"))).toBe(true);
	});
});

describe("Company tab (ADR-0049 §6)", () => {
	it("lists the stored listing, then the Business group (ADR-0053)", async () => {
		const api = serve();
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		const listing = await waitFor(() => {
			const element = document.querySelector('[data-field="company-listing"]');
			if (!(element instanceof HTMLElement) || !(element.textContent ?? "").includes("Nasdaq")) {
				throw new Error("no listing yet");
			}
			return element;
		});
		expect(listing.textContent).toContain("Apple Inc.");
		expect(listing.textContent).toContain("us:AAPL");
		const tab = document.querySelector('[data-field="stock-company-tab"]');
		await waitFor(() => expect(tab?.querySelectorAll("section")).toHaveLength(2));
		// The tab reads only the stock's profile: no statement is requested for it.
		expect(api.backend.requestsTo("GET", /\/statements\//)).toHaveLength(0);
	});

	it("says a stock is not in the stored stock list", async () => {
		const api = serve([]);
		mountStocks(api.backend, { route: { stockId: "us:ZZZZ", tab: "company" } });
		await waitFor(() =>
			expect(document.querySelector('[data-field="not-in-directory"]')?.textContent).toBe(
				"Not in the stored stock list",
			),
		);
		expect(api.backend.requestsTo("GET", /\/statements\//)).toHaveLength(0);
	});
});
