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

	it("asks the runner to sync now from the tab and says so there", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		const sync = within(panel()).getByRole("button", { name: "Sync Apple Inc. now" });
		fireEvent.click(sync);
		await waitFor(() =>
			expect(api.backend.requestsTo("POST", /\/eqc_apple\/sync$/)).toHaveLength(1),
		);
		await waitFor(() =>
			expect(
				panel().querySelector('[data-field="financials-sync"]')?.getAttribute("data-sync-status"),
			).toBe("queued"),
		);
		expect(sync.hasAttribute("disabled")).toBe(true);
		await waitFor(() =>
			expect(panel().querySelector('[data-field="financials-outcome"]')?.textContent).toBe(
				"Apple Inc. will be synced when the local runner next claims work.",
			),
		);
		// The list is read again at once (with its ETag), then polled while queued.
		await waitFor(() =>
			expect(api.backend.requestsTo("GET", /\/equities\/companies$/).length).toBeGreaterThanOrEqual(
				2,
			),
		);
	});

	it("offers to sync a stock whose company is not tracked, and not at the limit", async () => {
		const api = createStocksBackend({ companies: [] });
		mountStocks(api.backend, { route: APPLE });
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-not-tracked"]')).not.toBeNull(),
		);
		expect(panel().textContent).toContain(
			"Annual financial statements are not synced for this stock.",
		);
		fireEvent.click(within(panel()).getByRole("button", { name: "Sync financial statements" }));
		await waitFor(() =>
			expect(api.backend.requestsTo("POST", /^\/api\/v1\/equities\/companies$/)[0]?.body).toEqual({
				stockId: "us:AAPL",
			}),
		);
		// The page's list now holds it: the tab shows its (queued) sync and statements.
		await waitFor(() =>
			expect(panel().querySelector('[data-field="financials-sync"]')).not.toBeNull(),
		);
		await waitFor(() =>
			expect(panel().querySelector('[data-field="financials-outcome"]')?.textContent).toContain(
				"Syncing the statements of AAPL.",
			),
		);
		cleanup();

		const full = createStocksBackend({
			companies: Array.from({ length: 20 }, (_, index) =>
				makeCompany({ companyId: `eqc_${index}`, symbol: `S${index}` }),
			),
		});
		mountStocks(full.backend, { route: { stockId: "us:KO", tab: "financials" } });
		const button = await waitFor(() =>
			within(panel()).getByRole("button", { name: "Sync financial statements" }),
		);
		await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
		expect(panel().querySelector('[data-field="track-limit"]')?.textContent).toBe(
			"Statements are synced for 20 companies, the most there can be. Stop syncing one to sync another.",
		);
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
	it("lists the listing, the filer with its SEC link, the key figures and the workspace state", async () => {
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
		const filer = document.querySelector('[data-field="company-filer"]');
		if (!(filer instanceof HTMLElement)) throw new Error("no filer");
		const cik = within(filer).getByRole("link", { name: /Open the filer on SEC EDGAR/ });
		expect(cik.getAttribute("href")).toBe(
			"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193",
		);
		expect(filer.textContent).toContain("Sep 28");
		expect(filer.textContent).toContain("FY2024");
		const figures = await waitFor(() => {
			const element = document.querySelector('[data-field="company-key-figures"]');
			if (!(element instanceof HTMLElement) || element.querySelector("dl") === null) {
				throw new Error("no key figures yet");
			}
			return element;
		});
		expect(figures.textContent).toContain("FY2024, from the stored annual statements.");
		expect(figures.textContent).toContain("USD millions");
		expect(figures.querySelectorAll("dt")).toHaveLength(7);
		// A missing value says why, never blank and never 0.
		for (const value of figures.querySelectorAll("dd")) expect(value.textContent).not.toBe("");
		const workspace = document.querySelector('[data-field="company-workspace"]');
		expect(workspace?.textContent).toContain("Not on the Watchlist");
	});

	it("reads the key figures from the statement entries the Financial statements tab shares", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		const before = api.backend.requestsTo("GET", /\/statements\/income-statement\?years=5$/).length;
		expect(before).toBe(1);
		fireEvent.click(screen.getByRole("tab", { name: "Company" }));
		// The revenue comes from the kept answer of the Financial statements tab.
		await waitFor(() =>
			expect(document.querySelector('[data-field="company-key-figures"]')?.textContent).toContain(
				"Revenue",
			),
		);
		await waitFor(() =>
			expect(api.backend.requestsTo("GET", /\/statements\/cash-flow\?years=5$/)).toHaveLength(1),
		);
		// The income statement was answered within the fresh window: the
		// Company tab shows the kept answer and asks nothing (ADR-0049 §3, §6).
		expect(api.backend.requestsTo("GET", /\/statements\/income-statement\?years=5$/)).toHaveLength(
			1,
		);
	});

	it("says what is missing: a stock in no list, a company not tracked", async () => {
		const api = serve([]);
		mountStocks(api.backend, { route: { stockId: "us:ZZZZ", tab: "company" } });
		await waitFor(() =>
			expect(document.querySelector('[data-field="not-in-directory"]')?.textContent).toBe(
				"Not in the stored stock list",
			),
		);
		expect(document.querySelector('[data-field="company-filer"]')?.textContent).toContain(
			"Statements are not synced for this stock",
		);
		expect(document.querySelector('[data-field="company-key-figures"]')).toBeNull();
		expect(api.backend.requestsTo("GET", /\/statements\//)).toHaveLength(0);
		fireEvent.click(screen.getByRole("button", { name: "Open Financial statements" }));
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-not-tracked"]')).not.toBeNull(),
		);
		// Focus follows to the Financial statements tab, not a button in the now-hidden panel.
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole("tab", { name: "Financial statements" }),
			),
		);
	});

	it("says a company removed elsewhere is gone instead of loading the key figures forever", async () => {
		const api = serve();
		const gone = () =>
			errorResponse(404, "EQUITY_COMPANY_NOT_FOUND", "The company is not tracked.");
		api.backend.on("GET", /\/companies\/eqc_apple\/statements\//, gone);
		mountStocks(api.backend, { route: { stockId: "us:AAPL", tab: "company" } });
		await waitFor(() =>
			expect(document.querySelector('[data-field="key-figures-company-gone"]')?.textContent).toBe(
				"This company's statements are no longer synced. Choose another stock in the table.",
			),
		);
		expect(
			document.querySelector('[data-field="company-key-figures"] [aria-busy="true"]'),
		).toBeNull();
		// The list is read again at once, rather than at the next five-minute poll.
		await waitFor(() =>
			expect(api.backend.requestsTo("GET", /\/equities\/companies$/).length).toBeGreaterThanOrEqual(
				2,
			),
		);
	});
});
