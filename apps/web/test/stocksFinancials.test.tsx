import type { EarningsEvent, EquityCompanyView } from "@research/contracts";
import { cleanup, fireEvent, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StockRoute } from "../src/router.ts";
import { makeCompany, NINTENDO, nintendoSynced } from "./equitiesHarness.ts";
import { errorResponse } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import { createStocksBackend, mountStocks, type StocksServer } from "./stocksHarness.tsx";
import { makeStock } from "./watchlistHarness.ts";

/**
 * The Stocks page's Financial statements and Company tabs (ADR-0049 §5,
 * §6): the Equities page's company detail, moved, and what the Company tab
 * reads. The watchlist is empty: every listed stock's statements are synced
 * (ADR-0058), and the tab takes the stock's company from its profile read.
 */

const NOW = Date.parse("2026-10-31T10:00:00Z");
const APPLE: StockRoute = { stockId: "us:AAPL", tab: "financials" };
const NINTENDO_ROUTE: StockRoute = { stockId: "jp:7974", tab: "financials" };

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
	it("shows the statements, switches statement and years", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		const shown = await statementShown();
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
		expect(filings.caption?.textContent).toBe("Stored annual filings of this company");
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
			"Pending: the server reads it again",
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
		).toBe("Amends 20240425000001");
		// A Japanese company's filings are J-Quants records of its earnings summaries (ADR-0059 §2).
		const newest = filings.querySelector('tr[data-filing-id="fil_jp_2025"]');
		if (!(newest instanceof HTMLElement)) throw new Error("no FY2025 filing");
		expect(newest.querySelector("th")?.textContent).toBe("Earnings summary (決算短信)");
		expect(newest.textContent).toContain("Japanese GAAP");
		expect(filings.querySelector('tr[data-filing-id="fil_jp_2024_a"] th')?.textContent).toBe(
			"Corrected earnings summary",
		);
		const record = within(newest).getByRole("link", {
			name: "Open the J-Quants record of the Earnings summary (決算短信) disclosed 2025-05-08 (needs a J-Quants API key)",
		});
		expect(record.getAttribute("href")).toBe(
			"https://api.jquants.com/v2/fins/summary?code=79740&date=2025-05-08",
		);
		// The statement says what J-Quants Free covers and leaves out.
		expect(panel().querySelector('[data-field="jquants-note"]')?.textContent).toContain(
			"about the last two fiscal years, about 12 weeks behind",
		);
		cleanup();
		// A company with a filing on record but no values or listed filings yet.
		const empty = serve([{ ...NINTENDO(), filingCount: 1 }]);
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
		// A company without values says so instead of an empty table.
		expect(panel().textContent).toContain("No financial data is stored yet.");
	});

	it("says a company removed elsewhere is gone instead of loading forever, and re-reads the profile", async () => {
		const api = serve();
		const gone = () =>
			errorResponse(404, "EQUITY_COMPANY_NOT_FOUND", "The company is not tracked.");
		api.backend.on("GET", /\/companies\/eqc_apple\/statements\//, gone);
		mountStocks(api.backend, { route: APPLE });
		await waitFor(() =>
			expect(document.querySelector('[data-field="statement-company-gone"]')).not.toBeNull(),
		);
		await waitFor(() =>
			expect(
				api.backend.requestsTo("GET", /^\/api\/v1\/stocks\/us%3AAAPL$/).length,
			).toBeGreaterThanOrEqual(2),
		);
		// The tab never reads the list of tracked companies (thousands, ADR-0058 §3).
		expect(api.backend.requestsTo("GET", /\/equities\/companies$/)).toHaveLength(0);
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

	it("offers no sync and shows no sync status, not even a failed sync (ADR-0054, ADR-0055 §4)", async () => {
		// Nintendo's last sync failed (no J-Quants key): the tab says nothing about it.
		const api = serve([makeCompany(), NINTENDO()]);
		mountStocks(api.backend, { route: NINTENDO_ROUTE });
		await waitFor(() =>
			expect(document.querySelector('[data-field="financials-none"]')).not.toBeNull(),
		);
		expect(within(panel()).queryByRole("button", { name: /^Sync/ })).toBeNull();
		expect(panel().textContent).not.toMatch(/Sync|JQUANTS_API_KEY|FINANCIAL_/);
		expect(panel().querySelector('[data-field="financials-none"]')?.textContent).toContain(
			"Source: SEC EDGAR (US) or earnings summaries (決算短信) via J-Quants (Japan).",
		);
		expect(api.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("says a listed stock's statements are on the way, on the Watchlist or not, and offers no button to sync them", async () => {
		// AAPL is listed but has no company yet: the server fetches its statements by itself.
		const api = serve([]);
		mountStocks(api.backend, { route: APPLE });
		const none = await waitFor(() => {
			const found = document.querySelector('[data-field="financials-none"]');
			if (!(found instanceof HTMLElement)) throw new Error("no empty state yet");
			return found;
		});
		expect(none.getAttribute("data-listed")).toBe("true");
		expect(panel().textContent).toContain(
			"No financial statements are stored for this stock yet. The server fetches the statements of every listed stock; they appear here once stored.",
		);
		// The statements do not depend on the Watchlist (ADR-0058); only the earnings line does.
		expect(none.textContent).not.toContain("Watchlist");
		expect(within(panel()).queryByRole("button")).toBeNull();
		cleanup();

		// KO is not in the stored stock list: no statements will come.
		const other = serve([]);
		mountStocks(other.backend, { route: { stockId: "us:KO", tab: "financials" } });
		await waitFor(() =>
			expect(
				document.querySelector('[data-field="financials-none"]')?.getAttribute("data-listed"),
			).toBe("false"),
		);
		expect(panel().textContent).toContain(
			"No financial statements are stored for this stock. The server fetches the statements of the stocks in the stored US and Japanese stock lists, and this stock is not in them.",
		);
		expect(within(panel()).queryByRole("button")).toBeNull();
		expect(other.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("re-reads a listed stock's profile sooner until its statements are stored, then shows them (ADR-0058 §6)", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const api = serve([makeCompany({ latestFiscalYear: null, filingCount: 0 })]);
			mountStocks(api.backend, { route: APPLE });
			const profileReads = () => api.backend.requestsTo("GET", /^\/api\/v1\/stocks\/us%3AAAPL$/);
			await vi.advanceTimersByTimeAsync(0);
			expect(document.querySelector('[data-field="financials-none"]')).not.toBeNull();
			const first = profileReads().length;
			// 5 s, then 10 s: two re-reads that still find nothing.
			await vi.advanceTimersByTimeAsync(5_000);
			expect(profileReads()).toHaveLength(first + 1);
			await vi.advanceTimersByTimeAsync(10_000);
			expect(profileReads()).toHaveLength(first + 2);
			// The server stored the statements: the next re-read shows them.
			api.equities.companies.splice(0, 1, makeCompany());
			await vi.advanceTimersByTimeAsync(20_000);
			expect(profileReads()).toHaveLength(first + 3);
			await vi.waitFor(() =>
				expect(document.querySelector("table[data-statement]")).not.toBeNull(),
			);
			expect(document.querySelector('[data-field="financials-none"]')).toBeNull();
			// Found: no sooner re-read any more.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(profileReads()).toHaveLength(first + 3);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps showing the stored statements of an untracked company (ADR-0055, ADR-0058)", async () => {
		// Apple's company is stored but not tracked; Apple is still listed: the server tracks it again.
		const api = serve([makeCompany({ tracked: false })]);
		mountStocks(api.backend, { route: APPLE });
		const shown = await statementShown();
		expect(shown.querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
			"income-statement",
		);
		expect(panel().querySelector('[data-field="financials-stored"]')?.textContent).toBe(
			"These statements were stored earlier. The server updates them by itself; newer statements appear here once stored.",
		);
		expect(panel().querySelector('[data-field="financials-none"]')).toBeNull();
		cleanup();

		// Its listing left the stored stock list: the statements are no longer updated.
		const delisted = serve([makeCompany({ tracked: false })]);
		delisted.server.directory.rows = delisted.server.directory.rows.filter(
			(row) => row.symbol !== "AAPL",
		);
		mountStocks(delisted.backend, { route: APPLE });
		await statementShown();
		expect(panel().querySelector('[data-field="financials-stored"]')?.textContent).toBe(
			"These statements were stored earlier and are no longer updated: the stock is no longer in the stored stock lists.",
		);
		expect(delisted.backend.requests.filter((request) => request.method !== "GET")).toEqual([]);
	});

	it("shows no line above a tracked company's statements", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		expect(panel().querySelector('[data-field="financials-stored"]')).toBeNull();
	});

	it("says statements are on the way for an untracked listed company with nothing stored", async () => {
		const api = serve([makeCompany({ tracked: false, latestFiscalYear: null, filingCount: 0 })]);
		mountStocks(api.backend, { route: APPLE });
		await waitFor(() =>
			expect(
				document.querySelector('[data-field="financials-none"]')?.getAttribute("data-listed"),
			).toBe("true"),
		);
		expect(document.querySelector('[data-field="company-detail"]')).toBeNull();
	});

	it("offers no Add to Home actions (Home's add menu places these widgets)", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		expect(within(panel()).queryAllByRole("button", { name: /Home/ })).toEqual([]);
		expect(within(panel()).queryByLabelText("Chart")).toBeNull();
	});

	it("never requests anything but our own API", async () => {
		const api = serve();
		mountStocks(api.backend, { route: APPLE });
		await statementShown();
		expect(api.backend.requests.every((request) => request.path.startsWith("/api/v1/"))).toBe(true);
	});
});

describe("Financial statements tab: next earnings date (ADR-0067)", () => {
	// NOW is 2026-10-31 (a Saturday).
	const NEXT: EarningsEvent = {
		periodKey: "2026-q4",
		announcementDate: "2026-11-05",
		fiscalPeriodLabel: "Q4 2026",
		fiscalPeriodEnd: "2026-09-27",
		timing: "after-close",
	};
	const EVENTS: EarningsEvent[] = [
		{
			periodKey: "2026-q3",
			announcementDate: "2026-07-30",
			fiscalPeriodLabel: "Q3 2026",
			fiscalPeriodEnd: "2026-06-27",
			timing: "after-close",
		},
		NEXT,
	];

	function earningsLine(): Promise<HTMLElement> {
		return waitFor(() => {
			const element = panel().querySelector('[data-field="next-earnings"]');
			if (!(element instanceof HTMLElement)) throw new Error("no earnings line");
			return element;
		});
	}

	function watched(events: EarningsEvent[]): StocksServer {
		const api = serve();
		api.server.stocks = [makeStock({ events })];
		return api;
	}

	it("shows a Watchlist stock's next announcement above its statements, past ones skipped", async () => {
		const api = watched(EVENTS);
		mountStocks(api.backend, { route: APPLE });
		const line = await earningsLine();
		expect(line.getAttribute("data-kind")).toBe("scheduled");
		expect(line.querySelector("dt")?.textContent).toBe("Next earnings date");
		expect(line.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-05");
		expect(line.querySelector("dd")?.textContent).toBe(
			"Thu, 5 November 2026 after market close · in 5 daysFor Q4 2026, fiscal year ending Sep 27, 2026Source: Finnhub",
		);
		expect(
			within(line)
				.getByRole("link", { name: /Finnhub/ })
				.getAttribute("href"),
		).toBe("https://finnhub.io/");
		// It comes first, then the statements; it reads nothing of its own.
		await statementShown();
		expect(panel().firstElementChild).toBe(line);
		expect(api.backend.requestsTo("GET", /earnings/)).toEqual([]);
	});

	it("words it in Japanese", async () => {
		const api = watched(EVENTS);
		mountStocks(api.backend, { route: APPLE, locale: "ja" });
		const line = await earningsLine();
		expect(line.querySelector("dt")?.textContent).toBe("次回決算発表日");
		expect(line.querySelector("dd")?.textContent).toBe(
			"2026年11月5日（木） 大引け後 · あと 5 日対象: Q4 2026（2026年9月期）出典: Finnhub",
		);
	});

	it("says when the next date is not decided", async () => {
		const undecided = watched([{ ...NEXT, announcementDate: null, timing: "unknown" }]);
		mountStocks(undecided.backend, { route: APPLE });
		const line = await earningsLine();
		expect(line.getAttribute("data-kind")).toBe("undecided");
		expect(line.querySelector("dd")?.textContent).toBe(
			"Not decided yetFor Q4 2026, fiscal year ending Sep 27, 2026Source: Finnhub",
		);
	});

	it("shows a stock outside the Watchlist from its market's calendar (ADR-0068)", async () => {
		const api = serve();
		api.calendarOf.set("us:AAPL", {
			source: "finnhub",
			publisher: "Finnhub",
			sourceUrl: "https://finnhub.io/",
			syncedAt: "2026-10-31T01:00:00.000Z",
			events: [{ ...NEXT, announcementDate: "2026-11-02", fiscalPeriodEnd: null }],
		});
		mountStocks(api.backend, { route: APPLE });
		const line = await earningsLine();
		await waitFor(() => expect(line.getAttribute("data-kind")).toBe("scheduled"));
		expect(line.querySelector("dd")?.textContent).toBe(
			"Mon, 2 November 2026 after market close · in 2 daysFor Q4 2026Source: Finnhub",
		);
		// From the profile the tab reads anyway: no request of its own.
		expect(api.backend.requestsTo("GET", /earnings/)).toEqual([]);
	});

	it("says none is listed, or not fetched yet, for a stock outside the Watchlist", async () => {
		const listed = serve();
		listed.calendarOf.set("us:AAPL", {
			source: "finnhub",
			publisher: "Finnhub",
			sourceUrl: "https://finnhub.io/",
			syncedAt: "2026-10-31T01:00:00.000Z",
			events: [],
		});
		mountStocks(listed.backend, { route: APPLE });
		const line = await earningsLine();
		await waitFor(() => expect(line.getAttribute("data-kind")).toBe("none"));
		expect(line.querySelector("dd")?.textContent).toBe(
			"The source lists no upcoming announcement yet.Source: Finnhub",
		);
		cleanup();

		mountStocks(serve().backend, { route: APPLE, locale: "ja" });
		const never = await earningsLine();
		await waitFor(() => expect(never.getAttribute("data-kind")).toBe("not-fetched"));
		expect(never.querySelector("dd")?.textContent).toBe(
			"まだ取得していません。次回の自動更新後に表示されます。",
		);
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
		// The AI-written summary (ADR-0060), the listing and the Business group.
		await waitFor(() => expect(tab?.querySelectorAll("section")).toHaveLength(3));
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
