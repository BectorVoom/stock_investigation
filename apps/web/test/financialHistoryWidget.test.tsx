import type { WidgetCore } from "@research/contracts";
import { LocaleProvider } from "@research/i18n/solid";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WidgetBody } from "../src/widgets/WidgetBody.tsx";
import {
	APPLE_ID,
	appleSeries,
	createEquitiesServer,
	type EquitiesServer,
	NINTENDO_ID,
	nintendoSynced,
	onlyEquitiesRequests,
} from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE, jsonResponse } from "./fakeBackend.ts";
import { assertOnlyIconFetches, resetGlobalFetchCalls } from "./setup.ts";

type HistoryWidget = Extract<WidgetCore, { readonly type: "financial-history" }>;

function historyWidget(overrides: Partial<HistoryWidget> = {}): HistoryWidget {
	return {
		widgetId: "w-fh",
		type: "financial-history",
		companyId: APPLE_ID,
		metric: "revenue",
		years: 5,
		title: "Apple Inc. (AAPL)",
		size: "medium",
		...overrides,
	};
}

function renderWidget(server: EquitiesServer, widget: HistoryWidget = historyWidget()) {
	const [current, setCurrent] = createSignal<WidgetCore>(widget);
	const saves: WidgetCore[] = [];
	render(() => (
		<WidgetBody
			widget={current()}
			view={null}
			api={server.api}
			visibility={ALWAYS_VISIBLE}
			market={null}
			editingDisabled={false}
			onSaveText={async () => true}
			onSaveMarketWidget={() => {}}
			onSaveWidget={async (next) => {
				saves.push(next);
				setCurrent(next);
				return true;
			}}
		/>
	));
	return { saves };
}

function root(): HTMLElement {
	const element = document.querySelector('[data-widget-kind="financial-history"]');
	if (!(element instanceof HTMLElement)) throw new Error("the widget is missing");
	return element;
}

async function chart(): Promise<HTMLElement> {
	return waitFor(() => {
		const element = root().querySelector('[data-field="financial-chart"]');
		if (!(element instanceof HTMLElement)) throw new Error("no chart yet");
		return element;
	});
}

/** The y axis tick texts (the axis title excluded). */
function yTicks(figure: HTMLElement): string[] {
	return [...figure.querySelectorAll('[data-chart-part="y-axis"] text:not([data-axis-title])')].map(
		(text) => text.textContent ?? "",
	);
}

beforeEach(() => resetGlobalFetchCalls());
afterEach(() => {
	cleanup();
	assertOnlyIconFetches();
});

describe("financial history widget (ADR-0048 §8)", () => {
	it("draws one bar per reported fiscal year with the shared bar plot", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		const figure = await chart();
		expect(root().textContent).toContain("Apple Inc. (AAPL)");
		const svg = figure.querySelector("svg[role='img']");
		expect(svg?.getAttribute("aria-label")).toContain("Revenue of Apple Inc.");
		expect(figure.querySelectorAll("path[data-bar]")).toHaveLength(5);
		expect(
			[...figure.querySelectorAll("path[data-bar] title")].map((title) => title.textContent),
		).toContain("FY2024 — Revenue: 391.035 USD billions");
		expect(figure.querySelector('[data-field="not-reported-years"]')).toBeNull();
	});

	it("counts the axis in one scale the title names, with plain ticks (never 400K on millions)", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		const figure = await chart();
		expect(figure.querySelector('[data-axis-title="y"]')?.textContent).toBe(
			"Revenue (USD billions)",
		);
		const ticks = yTicks(figure);
		expect(ticks).toContain("400");
		// Plain grouped digits: no K / M / B suffix on top of the title's scale.
		expect(ticks.every((tick) => /^-?[\d,.]+$/.test(tick))).toBe(true);
		// The data table keeps millions, like the statement tables.
		const twin = figure.querySelector('[data-field="history-table"]');
		expect(twin?.querySelector("caption")?.textContent).toBe(
			"Revenue by fiscal year, USD millions",
		);
	});

	it("charts a Japanese company's yen in JPY billions, and in 億円 in Japanese", async () => {
		const server = createEquitiesServer({ companies: [nintendoSynced()] });
		renderWidget(server, historyWidget({ companyId: NINTENDO_ID }));
		const figure = await chart();
		expect(figure.querySelector('[data-axis-title="y"]')?.textContent).toBe(
			"Revenue (JPY billions)",
		);
		expect(yTicks(figure)).toContain("2,000");
		expect(
			[...figure.querySelectorAll("path[data-bar] title")].map((title) => title.textContent),
		).toContain("FY2025 — Revenue: 1,164.922 JPY billions");
		cleanup();

		const ja = createEquitiesServer({ companies: [nintendoSynced()] });
		render(() => (
			<LocaleProvider locale={() => "ja"}>
				<WidgetBody
					widget={historyWidget({ companyId: NINTENDO_ID })}
					view={null}
					api={ja.api}
					visibility={ALWAYS_VISIBLE}
					market={null}
					editingDisabled={false}
					onSaveText={async () => true}
					onSaveMarketWidget={() => {}}
					onSaveWidget={async () => true}
				/>
			</LocaleProvider>
		));
		const jaFigure = await chart();
		expect(jaFigure.querySelector('[data-axis-title="y"]')?.textContent).toBe("売上高 (億円)");
		expect(yTicks(jaFigure)).toContain("20,000");
		expect(jaFigure.querySelector('[data-field="history-table"] caption')?.textContent).toBe(
			"会計年度ごとの売上高（百万円）",
		);
		expect(
			jaFigure.querySelector('[data-field="history-table"] tr[data-fiscal-year="2025"]')
				?.textContent,
		).toContain("1,164,922");
	});

	it("does not chart values in different currencies on one axis: the table names each currency", async () => {
		const server = createEquitiesServer();
		const series = appleSeries("revenue");
		const cells = series.cells.map((cell) =>
			cell.fiscalYear === 2024 ? { ...cell, currency: "JPY" } : cell,
		);
		server.backend.on("GET", /\/metrics\?/, () =>
			jsonResponse({ ...series, cells }, { headers: { ETag: '"mixed"' } }),
		);
		renderWidget(server);
		const withheld = await waitFor(() => {
			const element = root().querySelector('[data-field="financial-chart-withheld"]');
			if (!(element instanceof HTMLElement)) throw new Error("not yet");
			return element;
		});
		expect(root().querySelector("svg[role='img']")).toBeNull();
		expect(withheld.textContent).toContain("Not charted: the values are in different currencies.");
		const twin = withheld.querySelector('[data-field="history-table"]');
		expect(twin?.querySelector("caption")?.textContent).toBe(
			"Revenue by fiscal year, Millions; each value names its currency",
		);
		expect(twin?.querySelector('tr[data-fiscal-year="2024"]')?.textContent).toContain(
			"391,035 JPY",
		);
		expect(twin?.querySelector('tr[data-fiscal-year="2023"]')?.textContent).toContain(
			"383,285 USD",
		);
	});

	it("names a separate-only profit series as net income", async () => {
		const server = createEquitiesServer({ companies: [nintendoSynced()] });
		server.japaneseScope = () => "separate";
		renderWidget(
			server,
			historyWidget({ companyId: NINTENDO_ID, metric: "profit-attributable-to-owners" }),
		);
		const figure = await chart();
		expect(figure.querySelector("svg[role='img']")?.getAttribute("aria-label")).toContain(
			"Net income (separate) of 任天堂株式会社",
		);
	});

	it("keeps the picker focusable while its save is on its way, ignoring changes", async () => {
		const server = createEquitiesServer();
		const saves: WidgetCore[] = [];
		let finish: () => void = () => {};
		const [current, setCurrent] = createSignal<WidgetCore>(historyWidget());
		render(() => (
			<WidgetBody
				widget={current()}
				view={null}
				api={server.api}
				visibility={ALWAYS_VISIBLE}
				market={null}
				editingDisabled={false}
				onSaveText={async () => true}
				onSaveMarketWidget={() => {}}
				onSaveWidget={(next) => {
					saves.push(next);
					return new Promise<boolean>((resolve) => {
						finish = () => {
							setCurrent(next);
							resolve(true);
						};
					});
				}}
			/>
		));
		await chart();
		const picker = within(root()).getByLabelText("Metric");
		if (!(picker instanceof HTMLSelectElement)) throw new Error("no picker");
		picker.focus();
		picker.value = "free-cash-flow";
		fireEvent.change(picker);
		expect(picker.getAttribute("aria-disabled")).toBe("true");
		expect(picker.hasAttribute("disabled")).toBe(false);
		expect(document.activeElement).toBe(picker);
		// A change while saving is ignored and the picker keeps the chosen metric.
		picker.value = "total-assets";
		fireEvent.change(picker);
		expect(picker.value).toBe("free-cash-flow");
		expect(saves).toHaveLength(1);
		finish();
		await waitFor(() => expect(picker.getAttribute("aria-disabled")).toBeNull());
		expect(document.activeElement).toBe(picker);
	});

	it("leaves a missing year as a gap and names it as not reported — never 0", async () => {
		const server = createEquitiesServer();
		renderWidget(server, historyWidget({ metric: "cash-and-cash-equivalents" }));
		const figure = await chart();
		expect(figure.querySelectorAll("path[data-bar]")).toHaveLength(4);
		expect(figure.querySelector('[data-field="not-reported-years"]')?.textContent).toBe(
			"Not reported: FY2021",
		);
		const twin = figure.querySelector('[data-field="history-table"]');
		if (!(twin instanceof HTMLTableElement)) throw new Error("no data table");
		const missing = twin.querySelector('tr[data-fiscal-year="2021"]');
		expect(missing?.textContent).toContain("Not reported");
		expect(missing?.textContent).not.toMatch(/\b0\b/);
	});

	it("says so when no year has a value", async () => {
		const server = createEquitiesServer();
		renderWidget(server, historyWidget({ metric: "ordinary-income" }));
		const figure = await chart();
		expect(figure.querySelectorAll("path[data-bar]")).toHaveLength(0);
		expect(figure.textContent).toContain("Not reported: FY2020, FY2021, FY2022, FY2023, FY2024");
	});

	it("has a data-table twin with period ends, exact rounded values and filing links", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		const figure = await chart();
		const twin = figure.querySelector('[data-field="history-table"]');
		if (!(twin instanceof HTMLTableElement)) throw new Error("no data table");
		expect(twin.caption?.textContent).toBe("Revenue by fiscal year, USD millions");
		const latest = twin.querySelector('tr[data-fiscal-year="2024"]');
		if (!(latest instanceof HTMLTableRowElement)) throw new Error("no 2024 row");
		expect(latest.querySelector("th")?.getAttribute("scope")).toBe("row");
		expect(latest.textContent).toContain("Sep 28, 2024");
		expect(latest.textContent).toContain("391,035");
		expect(
			within(latest).getByRole("link", { hidden: true, name: "Open Form 10-K filed 2024-11-01" }),
		).toBeTruthy();
		expect(twin.querySelector('tr[data-fiscal-year="2023"]')?.textContent).toContain("revised");
	});

	it("switches the metric with a picker that saves the widget", async () => {
		const server = createEquitiesServer();
		const { saves } = renderWidget(server);
		await chart();
		const picker = within(root()).getByLabelText("Metric");
		if (!(picker instanceof HTMLSelectElement)) throw new Error("no picker");
		expect(picker.querySelectorAll("option")).toHaveLength(14);
		expect([...picker.querySelectorAll("optgroup")].map((group) => group.label)).toEqual([
			"Income statement",
			"Balance sheet",
			"Cash flow statement",
		]);
		picker.value = "free-cash-flow";
		fireEvent.change(picker);
		await waitFor(() => expect(saves).toHaveLength(1));
		expect(saves[0]).toMatchObject({ type: "financial-history", metric: "free-cash-flow" });
		await waitFor(() =>
			expect(server.requests("GET", /\/metrics\?years=5&metric=free-cash-flow$/)).toHaveLength(1),
		);
		await waitFor(() =>
			expect(root().querySelector("svg[role='img']")?.getAttribute("aria-label")).toContain(
				"Free cash flow",
			),
		);
	});

	it("reads only our equities API", async () => {
		const server = createEquitiesServer();
		renderWidget(server);
		await chart();
		expect(onlyEquitiesRequests(server.backend)).toBe(true);
		expect(server.backend.requests.map((request) => request.path)).toEqual([
			"/api/v1/equities/companies/eqc_apple/metrics?years=5&metric=revenue",
		]);
	});
});
