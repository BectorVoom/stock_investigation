import type { WidgetCore, WidgetSize } from "@research/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINANCIAL_RECHECK_MS } from "../src/equities/financialStore.ts";
import { WidgetBody } from "../src/widgets/WidgetBody.tsx";
import {
	APPLE_ID,
	appleStatement,
	createEquitiesServer,
	type EquitiesServer,
	makeCompany,
	NINTENDO_ID,
	nintendoSynced,
	onlyEquitiesRequests,
} from "./equitiesHarness.ts";
import {
	ALWAYS_VISIBLE,
	createControllableVisibility,
	errorResponse,
	jsonResponse,
} from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

type StatementWidget = Extract<WidgetCore, { readonly type: "financial-statement" }>;

function statementWidget(overrides: Partial<StatementWidget> = {}): StatementWidget {
	return {
		widgetId: "w-fs",
		type: "financial-statement",
		companyId: APPLE_ID,
		statement: "income-statement",
		years: 5,
		title: "Apple Inc. (AAPL)",
		size: "large" satisfies WidgetSize,
		...overrides,
	};
}

/** Renders through the shared body, with a page save that stores the widget like a page would. */
function renderWidget(
	server: EquitiesServer,
	options: {
		readonly widget?: StatementWidget;
		readonly save?: (widget: WidgetCore) => Promise<boolean>;
		readonly visibility?: typeof ALWAYS_VISIBLE;
	} = {},
) {
	const [widget, setWidget] = createSignal<WidgetCore>(options.widget ?? statementWidget());
	const saves: WidgetCore[] = [];
	const save =
		options.save ??
		(async (next: WidgetCore) => {
			setWidget(next);
			return true;
		});
	render(() => (
		<WidgetBody
			widget={widget()}
			view={null}
			api={server.api}
			visibility={options.visibility ?? ALWAYS_VISIBLE}
			market={null}
			editingDisabled={false}
			onSaveText={async () => true}
			onSaveMarketWidget={() => {}}
			onSaveWidget={(next) => {
				saves.push(next);
				return save(next);
			}}
		/>
	));
	return { saves, setWidget };
}

function root(): HTMLElement {
	const element = document.querySelector('[data-widget-kind="financial-statement"]');
	if (!(element instanceof HTMLElement)) throw new Error("the widget is missing");
	return element;
}

async function table(): Promise<HTMLTableElement> {
	const found = await waitFor(() => {
		const element = root().querySelector("table[data-statement]");
		if (!(element instanceof HTMLTableElement)) throw new Error("no table yet");
		return element;
	});
	return found;
}

function row(metric: string): HTMLTableRowElement {
	const element = root().querySelector(`tr[data-metric="${metric}"]`);
	if (!(element instanceof HTMLTableRowElement)) throw new Error(`no row ${metric}`);
	return element;
}

function cell(metric: string, year: number): HTMLTableCellElement {
	const element = row(metric).querySelector(`td[data-fiscal-year="${year}"]`);
	if (!(element instanceof HTMLTableCellElement)) throw new Error(`no cell ${metric} ${year}`);
	return element;
}

beforeEach(() => resetGlobalFetchCalls());
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	assertOnlyIconFetches();
});

describe("financial statement widget (ADR-0048 §8)", () => {
	it("shows the company, the newest period end, years oldest → newest and USD millions", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		const shown = await table();
		expect(root().textContent).toContain("Apple Inc. (AAPL)");
		expect(root().querySelector('[data-field="latest-period"]')?.textContent).toBe(
			"Latest fiscal year ended Sep 28, 2024",
		);
		expect(shown.caption?.textContent).toBe("Income statement, USD millions");
		const headers = [...shown.querySelectorAll("thead th")].map((th) => th.textContent);
		expect(headers[0]).toBe("Metric");
		expect(headers.slice(1).map((text) => text?.slice(0, 6))).toEqual([
			"FY2020",
			"FY2021",
			"FY2022",
			"FY2023",
			"FY2024",
		]);
		expect(headers.at(-1)).toContain("Sep 28, 2024");
		// Every header and row header carries its scope.
		expect(
			[...shown.querySelectorAll("thead th")].every((th) => th.getAttribute("scope") === "col"),
		).toBe(true);
		expect(row("revenue").querySelector("th")?.getAttribute("scope")).toBe("row");
		expect(row("revenue").querySelector("th")?.textContent).toBe("Revenue");
		// Whole millions from the exact decimal text.
		expect(cell("revenue", 2024).textContent).toBe("391,035");
		expect(cell("operating-income", 2020).textContent).toBe("66,288");
	});

	it("says why a value is missing — never blank, never 0", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		await table();
		for (const year of [2020, 2021, 2022, 2023, 2024]) {
			const missing = cell("ordinary-income", year);
			expect(missing.textContent).toBe("Not reported");
			expect(missing.querySelector("[data-unavailable]")?.className).toContain("italic");
			expect(missing.querySelector("button")).toBeNull();
		}
	});

	it("marks a revised value and opens its revision history from the API", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		await table();
		const revised = cell("revenue", 2023);
		expect(revised.querySelector('[data-mark="revised"]')?.textContent).toBe("revised");
		expect(root().textContent).toContain("Revised: filings reported different values.");
		const button = within(revised).getByRole("button", {
			name: "Revenue, FY2023: 383,285 USD millions. Show details (revised)",
		});
		fireEvent.click(button);
		const dialog = await screen.findByRole("dialog", { name: "Revenue, FY2023" });
		expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
		expect(within(dialog).getByText("383,285,000,000 USD")).toBeTruthy();
		const history = await within(dialog).findByRole("table");
		const lines = within(history).getAllByRole("row").slice(1);
		expect(lines).toHaveLength(2);
		expect(lines[0]?.textContent).toContain("Form 10-K/A");
		expect(lines[0]?.textContent).toContain("Current");
		expect(lines[1]?.textContent).toContain("383,933,000,000 USD");
		expect(server.requests("GET", /\/revisions\?metric=revenue&fiscalYear=2023$/)).toHaveLength(1);
		// The value's filing is a link to SEC.
		const filing = within(dialog).getByRole("link", { name: "Open Form 10-K/A filed 2023-12-15" });
		expect(filing.getAttribute("href")).toContain("https://www.sec.gov/");
		expect(filing.getAttribute("rel")).toBe("noopener noreferrer");
		fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.activeElement).toBe(button);
	});

	it("opens a plain value's details without a revisions request", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		await table();
		fireEvent.click(within(cell("revenue", 2024)).getByRole("button"));
		const dialog = await screen.findByRole("dialog", { name: "Revenue, FY2024" });
		expect(within(dialog).getByText("us-gaap:revenue")).toBeTruthy();
		expect(within(dialog).getByText("Consolidated")).toBeTruthy();
		expect(
			within(dialog).getByRole("link", { name: "Open Form 10-K filed 2024-11-01" }),
		).toBeTruthy();
		expect(server.requests("GET", /\/revisions\?/)).toHaveLength(0);
	});

	it("switches statements with a segmented control that saves the widget", async () => {
		const server = createEquitiesServer();
		const { saves } = renderWidget(server);
		await table();
		const control = root().querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no statement switch");
		const buttons = within(control).getAllByRole("button");
		expect(buttons.map((button) => button.textContent)).toEqual([
			"Income",
			"Balance sheet",
			"Cash flow",
		]);
		expect(buttons[0]?.getAttribute("aria-pressed")).toBe("true");
		fireEvent.click(within(control).getByRole("button", { name: "Cash flow" }));
		await waitFor(() =>
			expect(root().querySelector("table[data-statement]")?.getAttribute("data-statement")).toBe(
				"cash-flow",
			),
		);
		expect(saves.at(-1)).toMatchObject({ type: "financial-statement", statement: "cash-flow" });
		expect(
			within(control).getByRole("button", { name: "Cash flow" }).getAttribute("aria-pressed"),
		).toBe("true");
		// Free cash flow is derived and says so.
		expect(cell("free-cash-flow", 2024).querySelector('[data-mark="derived"]')?.textContent).toBe(
			"derived",
		);
		expect(root().textContent).toContain("Derived: operating cash flow minus capital expenditures");
		// Negative investing cash flow keeps its sign.
		expect(cell("net-cash-from-investing-activities", 2022).textContent).toBe("−22,354");
	});

	it("returns the switch to the stored statement when the save is refused", async () => {
		const server = createEquitiesServer();
		renderWidget(server, { save: async () => false });
		await table();
		const control = root().querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no statement switch");
		fireEvent.click(within(control).getByRole("button", { name: "Balance sheet" }));
		await waitFor(() =>
			expect(
				within(control).getByRole("button", { name: "Income" }).getAttribute("aria-pressed"),
			).toBe("true"),
		);
	});

	it("lists the cited filings as links and reads only our equities API", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		await table();
		const footer = root().querySelector('[data-field="widget-footer"]');
		if (!(footer instanceof HTMLElement)) throw new Error("no sources");
		expect(footer.textContent).toContain("Sources: 6 filings");
		const links = within(footer).getAllByRole("link", { hidden: true });
		expect(links).toHaveLength(6);
		expect(
			links.every((link) => link.getAttribute("href")?.startsWith("https://www.sec.gov/")),
		).toBe(true);
		expect(onlyEquitiesRequests(server.backend)).toBe(true);
		expect(server.backend.requests.map((request) => request.path)).toEqual([
			"/api/v1/equities/companies/eqc_apple/statements/income-statement?years=5",
		]);
	});

	it("shares one read with its ETag and re-checks every five minutes while visible", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const server = createEquitiesServer();
		const visibility = createControllableVisibility();
		renderWidget(server, { visibility });
		renderWidget(server, { visibility, widget: statementWidget({ widgetId: "w-fs-2" }) });
		await vi.advanceTimersByTimeAsync(0);
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(FINANCIAL_RECHECK_MS);
		const reads = server.requests("GET", /\/statements\/income-statement/);
		expect(reads).toHaveLength(2);
		expect(reads[1]?.headers["if-none-match"]).toBe('"st-eqc_apple-income-statement-5-1"');
		// Hidden: no timer at all; back to visible: one catch-up read.
		visibility.setVisible(false);
		await vi.advanceTimersByTimeAsync(FINANCIAL_RECHECK_MS * 3);
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(2);
		visibility.setVisible(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(server.requests("GET", /\/statements\/income-statement/)).toHaveLength(3);
	});

	it("says when the company has no values yet, and links to Equities", async () => {
		const server = createEquitiesServer();
		renderWidget(server, { widget: statementWidget({ companyId: NINTENDO_ID }) });
		const empty = await waitFor(() => {
			const element = root().querySelector('[data-field="financial-no-data"]');
			if (element === null) throw new Error("not yet");
			return element;
		});
		expect(empty.textContent).toContain("No financial data yet.");
		expect(within(root()).getByRole("link", { name: "Open Equities" }).getAttribute("href")).toBe(
			"#/equities",
		);
	});

	it("says a company that is not the owner's is not tracked", async () => {
		const server = createEquitiesServer();
		renderWidget(server, { widget: statementWidget({ companyId: "eqc_gone" }) });
		await waitFor(() =>
			expect(root().querySelector('[data-field="financial-not-found"]')?.textContent).toBe(
				"This company is not tracked. Remove this widget from its menu.",
			),
		);
	});

	it("shows a failed read with its code and retries", async () => {
		const server = createEquitiesServer();
		let fail = true;
		server.backend.on("GET", /\/statements\//, () =>
			fail
				? errorResponse(500, "INTERNAL", "Internal server error.")
				: errorResponse(404, "EQUITY_COMPANY_NOT_FOUND", "The company is not tracked."),
		);
		renderWidget(server);
		const alert = await within(root()).findByRole("alert");
		expect(alert.textContent).toContain("Could not load the financial statement.");
		expect(alert.querySelector("[data-error-code]")?.textContent).toBe("INTERNAL");
		fail = false;
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		await waitFor(() =>
			expect(root().querySelector('[data-field="financial-not-found"]')).not.toBeNull(),
		);
	});

	it("treats only the API's own not-tracked code as a missing company, not any 404", async () => {
		const server = createEquitiesServer();
		server.backend.on("GET", /\/statements\//, () =>
			errorResponse(404, "NOT_FOUND", "No route matches."),
		);
		renderWidget(server);
		const alert = await within(root()).findByRole("alert");
		expect(alert.textContent).toContain("Could not load the financial statement.");
		expect(alert.querySelector("[data-error-code]")?.textContent).toBe("NOT_FOUND");
		expect(root().querySelector('[data-field="financial-not-found"]')).toBeNull();
	});

	it("keeps the switch focusable while its save is on its way, ignoring presses", async () => {
		const server = createEquitiesServer();
		let finish: (saved: boolean) => void = () => {};
		const { saves, setWidget } = renderWidget(server, {
			save: (next) =>
				new Promise<boolean>((resolve) => {
					finish = (saved) => {
						if (saved) setWidget(next);
						resolve(saved);
					};
				}),
		});
		await table();
		const control = root().querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no statement switch");
		const cashFlow = within(control).getByRole("button", { name: "Cash flow" });
		cashFlow.focus();
		fireEvent.click(cashFlow);
		const balance = within(control).getByRole("button", { name: "Balance sheet" });
		// Waiting: announced as unavailable, still focusable, and a press does nothing.
		expect(balance.getAttribute("aria-disabled")).toBe("true");
		expect(balance.hasAttribute("disabled")).toBe(false);
		expect(document.activeElement).toBe(cashFlow);
		balance.focus();
		expect(document.activeElement).toBe(balance);
		fireEvent.click(balance);
		expect(saves).toHaveLength(1);
		finish(true);
		await waitFor(() => expect(balance.getAttribute("aria-disabled")).toBeNull());
		expect(saves.map((saved) => saved.type === "financial-statement" && saved.statement)).toEqual([
			"cash-flow",
		]);
		expect(document.activeElement).toBe(balance);
	});

	it("waits, focusable, while the page saves something else", async () => {
		const server = createEquitiesServer();
		const saves: WidgetCore[] = [];
		render(() => (
			<WidgetBody
				widget={statementWidget()}
				view={null}
				api={server.api}
				visibility={ALWAYS_VISIBLE}
				market={null}
				editingDisabled={true}
				onSaveText={async () => true}
				onSaveMarketWidget={() => {}}
				onSaveWidget={async (next) => {
					saves.push(next);
					return true;
				}}
			/>
		));
		await table();
		const control = root().querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no statement switch");
		const balance = within(control).getByRole("button", { name: "Balance sheet" });
		expect(balance.getAttribute("aria-disabled")).toBe("true");
		fireEvent.click(balance);
		expect(saves).toHaveLength(0);
	});

	it("shows a Japanese company's statement in JPY millions", async () => {
		const server = createEquitiesServer({ companies: [makeCompany(), nintendoSynced()] });
		renderWidget(server, {
			widget: statementWidget({ companyId: NINTENDO_ID, title: "任天堂株式会社 (7974)" }),
		});
		const shown = await table();
		expect(shown.caption?.textContent).toBe("Income statement, JPY millions");
		expect(root().textContent).toContain("任天堂株式会社 (7974)");
		expect(root().querySelector('[data-field="latest-period"]')?.textContent).toBe(
			"Latest fiscal year ended Mar 31, 2025",
		);
		expect(cell("revenue", 2025).textContent).toBe("1,164,922");
		// Japanese GAAP reports ordinary income.
		expect(cell("ordinary-income", 2025).textContent).toBe("372,315");
		expect(row("profit-attributable-to-owners").querySelector("th")?.textContent).toBe(
			"Profit attributable to owners of parent",
		);
		const footer = root().querySelector('[data-field="widget-footer"]');
		if (!(footer instanceof HTMLElement)) throw new Error("no sources");
		const links = within(footer).getAllByRole("link", { hidden: true });
		expect(links.length).toBeGreaterThan(0);
		expect(
			links.every((link) =>
				link.getAttribute("href")?.startsWith("https://disclosure2.edinet-fsa.go.jp/"),
			),
		).toBe(true);
	});

	it("names a separate-only filer's profit as net income, and marks separate values in a mixed row", async () => {
		const server = createEquitiesServer({ companies: [nintendoSynced()] });
		server.japaneseScope = () => "separate";
		renderWidget(server, { widget: statementWidget({ companyId: NINTENDO_ID }) });
		await table();
		expect(row("profit-attributable-to-owners").querySelector("th")?.textContent).toBe(
			"Net income (separate)",
		);
		// Every value is separate: nothing to tell apart, so no cell is marked.
		expect(root().querySelector('[data-mark="separate"]')).toBeNull();
		cleanup();

		const mixed = createEquitiesServer({ companies: [nintendoSynced()] });
		mixed.japaneseScope = (year) => (year <= 2022 ? "separate" : "consolidated");
		renderWidget(mixed, { widget: statementWidget({ companyId: NINTENDO_ID }) });
		await table();
		expect(row("profit-attributable-to-owners").querySelector("th")?.textContent).toBe(
			"Profit attributable to owners of parent",
		);
		expect(
			cell("profit-attributable-to-owners", 2021).querySelector('[data-mark="separate"]')
				?.textContent,
		).toBe("separate");
		expect(
			cell("profit-attributable-to-owners", 2025).querySelector('[data-mark="separate"]'),
		).toBeNull();
		expect(
			within(cell("profit-attributable-to-owners", 2022))
				.getByRole("button")
				.getAttribute("aria-label"),
		).toBe(
			"Profit attributable to owners of parent, FY2022: 477,691 JPY millions. Show details (separate)",
		);
		expect(root().textContent).toContain(
			"Separate: from the company's own (parent-only) statement, not the consolidated one.",
		);
	});

	it("shows a non-zero amount under half a million as <1, never as 0, and explains it", async () => {
		const server = createEquitiesServer();
		const small = appleStatement("income-statement");
		const rows = small.rows.map((entry) =>
			entry.metric !== "operating-income"
				? entry
				: {
						...entry,
						cells: entry.cells.map((value) =>
							value.fiscalYear === 2024
								? { ...value, valueDecimal: "-400000" }
								: value.fiscalYear === 2023
									? { ...value, valueDecimal: "0" }
									: value,
						),
					},
		);
		server.backend.on("GET", /\/statements\/income-statement/, () =>
			jsonResponse({ ...small, rows }, { headers: { ETag: '"small"' } }),
		);
		renderWidget(server);
		await table();
		expect(cell("operating-income", 2024).textContent).toBe("−<1");
		expect(cell("operating-income", 2023).textContent).toBe("0");
		expect(root().textContent).toContain("<1: under half a million, not zero.");
	});

	it("keeps the switch read-only where nothing can be saved", async () => {
		const server = createEquitiesServer();
		render(() => (
			<WidgetBody
				widget={statementWidget()}
				view={null}
				api={server.api}
				visibility={ALWAYS_VISIBLE}
				market={null}
				editingDisabled={false}
				onSaveText={async () => true}
				onSaveMarketWidget={() => {}}
			/>
		));
		await table();
		const control = root().querySelector('[data-segmented="statement"]');
		if (!(control instanceof HTMLElement)) throw new Error("no statement switch");
		expect(
			within(control)
				.getAllByRole("button")
				.every((button) => button.hasAttribute("disabled")),
		).toBe(true);
	});
});
