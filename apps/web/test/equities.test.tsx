import {
	DEFAULT_HOME_DASHBOARD,
	type HomeDashboard,
	homeDashboardResponseSchema,
	putHomeDashboardRequestSchema,
} from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EquitiesView } from "../src/equities/EquitiesView.tsx";
import {
	APPLE_ID,
	createEquitiesServer,
	type EquitiesServer,
	makeCompany,
	NINTENDO_ID,
} from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE, errorResponse, jsonResponse } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";
import { freshDirectory, installDirectoryRoutes } from "./watchlistHarness.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");

/** The stock directory and Home routes the page also reads. */
function installPageRoutes(server: EquitiesServer): { dashboard: () => HomeDashboard } {
	let dashboard: HomeDashboard = structuredClone(DEFAULT_HOME_DASHBOARD);
	let version = 1;
	// MSFT is on the watchlist (the directory marks it), not tracked here; AAPL is tracked here.
	const directory = freshDirectory();
	installDirectoryRoutes(
		server.backend,
		() => directory,
		() => ["us:MSFT"],
	);
	server.backend.on("GET", /^\/api\/v1\/home\/dashboard$/, () =>
		jsonResponse(
			homeDashboardResponseSchema.parse({
				dashboard,
				version,
				updatedAt: "2026-10-31T00:00:00Z",
				origin: "saved",
			}),
		),
	);
	server.backend.on("PUT", /^\/api\/v1\/home\/dashboard$/, (request) => {
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

function renderPage(server: EquitiesServer) {
	return render(() => <EquitiesView api={server.api} visibility={ALWAYS_VISIBLE} />);
}

async function companiesTable(): Promise<HTMLTableElement> {
	return waitFor(() => {
		const element = document.querySelector('table[data-field="companies"]');
		if (!(element instanceof HTMLTableElement)) throw new Error("no table yet");
		return element;
	});
}

function companyRow(companyId: string): HTMLTableRowElement {
	const element = document.querySelector(`tr[data-company-id="${companyId}"]`);
	if (!(element instanceof HTMLTableRowElement)) throw new Error(`no row ${companyId}`);
	return element;
}

async function detail(): Promise<HTMLElement> {
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

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	resetGlobalFetchCalls();
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	assertOnlyIconFetches();
});

describe("Equities page (ADR-0048 §8)", () => {
	it("lists the tracked companies with identity and sync status", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		const table = await companiesTable();
		expect(table.querySelector("caption")?.textContent).toBe(
			"Tracked companies and their sync status",
		);
		expect(screen.getByText("2 of 20 companies")).toBeTruthy();
		const apple = companyRow(APPLE_ID);
		expect(apple.textContent).toContain("Apple Inc.");
		expect(apple.textContent).toContain("AAPL");
		expect(apple.textContent).toContain("CIK");
		expect(apple.textContent).toContain("0000320193");
		expect(apple.textContent).toContain("Sep 28");
		expect(apple.textContent).toContain("FY2024");
		expect(apple.querySelector('[data-field="sync-status"]')?.textContent).toBe(
			"Synced · Last synced 2 hours ago",
		);
		const nintendo = companyRow(NINTENDO_ID);
		expect(nintendo.textContent).toContain("EDINET code");
		expect(nintendo.textContent).toContain("Not resolved yet");
		expect(nintendo.querySelector('[data-field="sync-failure"]')?.textContent).toBe(
			"FINANCIAL_SOURCE_NOT_CONFIGURED: Not configured: set EDINET_API_KEY in apps/runner/.env, then restart the runner.",
		);
	});

	it("shows the first company's statements, switches statement and years, and lists filings", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		const shown = await detail();
		expect(screen.getByRole("heading", { name: "Statements of Apple Inc. (AAPL)" })).toBeTruthy();
		expect(companyRow(APPLE_ID).getAttribute("aria-current")).toBe("true");
		expect(shown.querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
			"income-statement",
		);
		const filings = shown.querySelector('table[data-field="filings"]');
		if (!(filings instanceof HTMLTableElement)) throw new Error("no filings");
		const amended = filings.querySelector('tr[data-filing-id="fil_2023_a"]');
		expect(amended?.textContent).toContain("Form 10-K/A");
		expect(amended?.textContent).toContain("Amends an earlier filing");
		expect(amended?.textContent).toContain("US GAAP");
		expect(within(filings).getAllByRole("link").length).toBe(6);

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
			expect(server.requests("GET", /\/statements\/balance-sheet\?years=10$/)).toHaveLength(1),
		);
	});

	it("opens a revised value's history from the page's table", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		const shown = await detail();
		const revised = shown.querySelector(
			'tr[data-metric="revenue"] td[data-fiscal-year="2023"] button',
		);
		if (!(revised instanceof HTMLButtonElement)) throw new Error("no revised value");
		fireEvent.click(revised);
		const dialog = await screen.findByRole("dialog", { name: "Revenue, FY2023" });
		await within(dialog).findByRole("table");
		expect(dialog.textContent).toContain("Values each filing reported");
	});

	it("selects another company and states its missing data", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		await detail();
		fireEvent.click(
			within(companyRow(NINTENDO_ID)).getByRole("button", {
				name: "Show the statements of 任天堂株式会社",
			}),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Statements of 任天堂株式会社 (7974)" }),
			).toBeTruthy(),
		);
		await waitFor(() => expect(document.body.textContent).toContain("No financial data yet."));
	});

	it("asks the runner to sync now and polls while the sync is queued", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		await companiesTable();
		fireEvent.click(
			within(companyRow(APPLE_ID)).getByRole("button", { name: "Sync Apple Inc. now" }),
		);
		await waitFor(() => expect(server.requests("POST", /\/eqc_apple\/sync$/)).toHaveLength(1));
		await waitFor(() =>
			expect(companyRow(APPLE_ID).getAttribute("data-sync-status")).toBe("queued"),
		);
		expect(
			within(companyRow(APPLE_ID))
				.getByRole("button", { name: "Sync Apple Inc. now" })
				.hasAttribute("disabled"),
		).toBe(true);
		expect(
			screen.getByText(/Apple Inc\. will be synced when the local runner next claims work\./),
		).toBeTruthy();
		// The list is read again at once (with its ETag).
		await waitFor(() =>
			expect(server.requests("GET", /\/equities\/companies$/).length).toBeGreaterThanOrEqual(2),
		);
	});

	it("stops tracking after a confirmation and keeps the data", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		await companiesTable();
		const remove = within(companyRow(NINTENDO_ID)).getByRole("button", {
			name: "Stop tracking 任天堂株式会社",
		});
		fireEvent.click(remove);
		const dialog = await screen.findByRole("dialog", { name: "Stop tracking 任天堂株式会社?" });
		expect(dialog.textContent).toContain("Its stored filings and values are kept");
		expect(server.requests("DELETE", /\/equities\/companies\//)).toHaveLength(0);
		fireEvent.click(within(dialog).getByRole("button", { name: "Stop tracking" }));
		await waitFor(() =>
			expect(server.requests("DELETE", /\/equities\/companies\/eqc_nintendo$/)).toHaveLength(1),
		);
		await waitFor(() =>
			expect(document.querySelector(`tr[data-company-id="${NINTENDO_ID}"]`)).toBeNull(),
		);
		expect(
			screen.getByText("Stopped tracking 任天堂株式会社. Its stored data is kept."),
		).toBeTruthy();
	});

	it("tracks a company picked in the stock search; tracked hits say Added", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		await companiesTable();
		const search = screen.getByRole("combobox", { name: "Search stocks" });
		// Apple is tracked here: listed as added and not pickable.
		fireEvent.input(search, { target: { value: "Apple" } });
		const apple = await waitFor(() => {
			const option = document.querySelector('[role="option"][data-stock-id="us:AAPL"]');
			if (option === null) throw new Error("no hit yet");
			return option;
		});
		expect(apple.getAttribute("aria-disabled")).toBe("true");
		// Microsoft is on the watchlist, which does not matter here: it can be tracked.
		fireEvent.input(search, { target: { value: "MICROSOFT" } });
		const microsoft = await waitFor(() => {
			const option = document.querySelector('[role="option"][data-stock-id="us:MSFT"]');
			if (!(option instanceof HTMLElement)) throw new Error("no hit yet");
			return option;
		});
		expect(microsoft.getAttribute("aria-disabled")).toBeNull();
		fireEvent.click(microsoft);
		expect(screen.getByText("To track: us:MSFT")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Track company" }));
		await waitFor(() => expect(server.requests("POST", /\/equities\/companies$/)).toHaveLength(1));
		expect(server.requests("POST", /\/equities\/companies$/)[0]?.body).toEqual({
			stockId: "us:MSFT",
		});
		await waitFor(() =>
			expect(document.querySelector('tr[data-company-id="eqc_msft"]')).not.toBeNull(),
		);
		expect(document.body.textContent).toContain("Tracking MSFT. Its first sync runs");
	});

	it("tracks an exact stock id and refuses one that is not a stock id", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		await companiesTable();
		const input = screen.getByLabelText("Stock id");
		const track = screen.getByRole("button", { name: "Track company" });
		fireEvent.input(input, { target: { value: "nasdaq:AAPL" } });
		expect(screen.getByText(/Enter us: followed by a US ticker/)).toBeTruthy();
		expect(track.hasAttribute("disabled")).toBe(true);
		fireEvent.input(input, { target: { value: "jp:8035" } });
		expect(track.hasAttribute("disabled")).toBe(false);
		fireEvent.click(track);
		await waitFor(() => expect(server.requests("POST", /\/equities\/companies$/)).toHaveLength(1));
		expect(server.requests("POST", /\/equities\/companies$/)[0]?.body).toEqual({
			stockId: "jp:8035",
		});
	});

	it("shows a refused track with its stable code", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		server.backend.on("POST", /^\/api\/v1\/equities\/companies$/, () =>
			errorResponse(409, "CONFLICT", "This company is already tracked."),
		);
		renderPage(server);
		await companiesTable();
		fireEvent.input(screen.getByLabelText("Stock id"), { target: { value: "us:KO" } });
		fireEvent.click(screen.getByRole("button", { name: "Track company" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("The company was not tracked.");
		expect(alert.querySelector("[data-error-code]")?.textContent).toBe("CONFLICT");
	});

	it("cannot track more than 20 companies", async () => {
		const companies = Array.from({ length: 20 }, (_, index) =>
			makeCompany({ companyId: `eqc_${index}`, symbol: `S${index}` }),
		);
		const server = createEquitiesServer({ companies });
		installPageRoutes(server);
		renderPage(server);
		await companiesTable();
		expect(document.querySelector('[data-field="track-limit"]')?.textContent).toBe(
			"You track 20 companies, the most there can be. Remove one to track another.",
		);
		fireEvent.input(screen.getByLabelText("Stock id"), { target: { value: "us:KO" } });
		expect(screen.getByRole("button", { name: "Track company" }).hasAttribute("disabled")).toBe(
			true,
		);
	});

	it("adds the shown statement and a metric chart to Home", async () => {
		const server = createEquitiesServer();
		const home = installPageRoutes(server);
		renderPage(server);
		await detail();
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
		const metric = screen.getByLabelText("Chart");
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
		// A second add of the same statement is not duplicated.
		fireEvent.click(screen.getByRole("button", { name: "Add this statement to Home" }));
		await waitFor(() => expect(screen.getByText(/is already on Home\./)).toBeTruthy());
		expect(
			home.dashboard().widgets.filter((widget) => widget.type === "financial-statement"),
		).toHaveLength(1);
	});

	it("never requests anything but our own API", async () => {
		const server = createEquitiesServer();
		installPageRoutes(server);
		renderPage(server);
		await detail();
		expect(server.backend.requests.every((request) => request.path.startsWith("/api/v1/"))).toBe(
			true,
		);
	});
});
