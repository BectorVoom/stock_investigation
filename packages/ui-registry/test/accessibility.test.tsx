import { cleanup, fireEvent, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { component, VALID_PROPS } from "./fixtures.ts";
import { renderComponent } from "./helpers.tsx";

afterEach(cleanup);

describe("accessibility: tables", () => {
	it("is a captioned table with column and row headers", () => {
		renderComponent(component("data-table", VALID_PROPS["data-table"]));
		const table = screen.getByRole("table", { name: "Base and bull demand, GWh" });
		expect(table.querySelector("caption")?.textContent).toBe("Base and bull demand, GWh");
		const columnHeaders = within(table).getAllByRole("columnheader");
		expect(columnHeaders.map((header) => header.textContent)).toEqual([
			"Select",
			"Year",
			"Base case (GWh)",
			"Bull case (GWh)",
		]);
		for (const header of columnHeaders) expect(header.getAttribute("scope")).toBe("col");
		const rowHeaders = within(table).getAllByRole("rowheader");
		expect(rowHeaders.map((header) => header.textContent)).toEqual([
			"2026",
			"2027",
			"2028",
			"2029",
		]);
		for (const header of rowHeaders) expect(header.getAttribute("scope")).toBe("row");
	});

	it("falls back to the dataset title as caption when none is given", () => {
		renderComponent(
			component("data-table", { title: "T", datasetRef: "ds_demand", sourceIds: [] }),
		);
		expect(screen.getByRole("table", { name: "Grid storage demand by year" })).toBeDefined();
	});

	it("selects rows with real buttons and reports the selection state", () => {
		const onSelect = vi.fn();
		renderComponent(component("data-table", VALID_PROPS["data-table"]), {
			onSelect,
			selection: { componentId: "data_table_1", itemKey: "row-1" },
		});
		const first = screen.getByRole("button", { name: "Select row 1" });
		const second = screen.getByRole("button", { name: "Select row 2" });
		expect(first.tagName).toBe("BUTTON");
		expect(first.getAttribute("aria-pressed")).toBe("false");
		expect(second.getAttribute("aria-pressed")).toBe("true");

		fireEvent.click(first);
		expect(onSelect).toHaveBeenLastCalledWith("data_table_1", "row-0");
		// Activating the selected row clears the selection.
		fireEvent.click(second);
		expect(onSelect).toHaveBeenLastCalledWith("data_table_1", null);
	});

	it("ignores a selection that belongs to another component", () => {
		renderComponent(component("data-table", VALID_PROPS["data-table"]), {
			selection: { componentId: "someone_else", itemKey: "row-0" },
		});
		expect(screen.getByRole("button", { name: "Select row 1" }).getAttribute("aria-pressed")).toBe(
			"false",
		);
	});
});

describe("accessibility: structure", () => {
	it("wraps each component in a named article with a heading", () => {
		renderComponent(component("news-card", VALID_PROPS["news-card"]));
		const article = screen.getByRole("article", { name: "Component news_card_1" });
		expect(
			within(article).getByRole("heading", {
				level: 3,
				name: "Utilities accelerate storage tenders",
			}),
		).toBeDefined();
	});

	it("labels the sources region and each report section", () => {
		renderComponent(component("research-report", VALID_PROPS["research-report"]));
		expect(screen.getByRole("heading", { level: 3, name: "Storage demand report" })).toBeDefined();
		expect(screen.getByRole("heading", { level: 4, name: "Demand drivers" })).toBeDefined();
		expect(screen.getAllByRole("list", { name: "Statement sources" }).length).toBeGreaterThan(0);
		expect(screen.getByRole("note").textContent).toBe("Research aid only; not investment advice.");
	});

	it("gives approved images alt text and unapproved ones a named placeholder", () => {
		renderComponent(
			component("image-gallery", {
				title: "Plant photos",
				images: [
					{ assetRef: "asset_a", caption: null },
					{ assetRef: "asset_gone", caption: null },
				],
			}),
		);
		expect(screen.getByRole("img", { name: "Battery plant exterior" })).toBeDefined();
		expect(
			screen.getByRole("img", { name: "Image unavailable: asset asset_gone is not approved" }),
		).toBeDefined();
	});

	it("names the fallback so assistive technology announces why nothing rendered", () => {
		renderComponent(component("no-such-type", {}));
		expect(screen.getByRole("status").textContent).toContain(
			"Cannot render: unknown component type",
		);
	});
});

describe("accessibility: links", () => {
	it("gives in-cell source links a descriptive accessible name", () => {
		renderComponent(component("financial-table", VALID_PROPS["financial-table"]));
		expect(
			screen.getAllByRole("link", { name: "Source: Annual securities report FY2025" }).length,
		).toBeGreaterThan(0);
	});
});
