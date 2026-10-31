import type { WidgetCore } from "@research/contracts";
import { cleanup, fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WidgetBody } from "../src/widgets/WidgetBody.tsx";
import {
	APPLE_ID,
	createEquitiesServer,
	type EquitiesServer,
	onlyEquitiesRequests,
} from "./equitiesHarness.ts";
import { ALWAYS_VISIBLE } from "./fakeBackend.ts";
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
		).toContain("FY2024 — Revenue: 391,035 USD millions");
		expect(figure.querySelector('[data-field="not-reported-years"]')).toBeNull();
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
