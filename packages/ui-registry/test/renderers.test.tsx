import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { cellBasis, type RenderContext, type WorkspaceComponent } from "../src/index.ts";
import { ResearchReport } from "../src/renderers/ResearchReport.tsx";
import {
	BASELINE_TYPES,
	type BaselineType,
	component,
	makeContext,
	STALE_DATASET,
	VALID_PROPS,
} from "./fixtures.ts";
import { expectOnlySafeLinks, renderComponent, texts } from "./helpers.tsx";

afterEach(cleanup);

type Props = WorkspaceComponent["props"];

interface Case {
	readonly props: Props;
	readonly context?: Partial<RenderContext>;
	readonly expectText: string;
	/**
	 * When the missing-source state shows behind a chip's card, the
	 * aria-label fragment of the chip to open before asserting.
	 */
	readonly chipLabel?: string;
}

interface Scenario {
	/** Text that must be visible when the valid fixture renders. */
	readonly validText: readonly string[];
	/** Props whose referenced data is absent from the render context, and what must show. */
	readonly missing: Case;
	/** Props (or data) containing an unavailable value, and the explicit text shown for it. */
	readonly unavailable: Case;
	readonly invalidProps: Props;
	/** Hrefs the valid fixture must link to. */
	readonly links: readonly string[];
}

const SOURCE_A = "https://example.com/reports/grid-storage";
const SOURCE_B = "https://filings.example.org/annual/2025";

const SCENARIOS: { readonly [T in BaselineType]: Scenario } = {
	"data-table": {
		validText: ["Demand scenarios", "Base case (GWh)", "2029", "310"],
		missing: {
			props: { ...VALID_PROPS["data-table"], datasetRef: "ds_gone" },
			expectText: 'Data unavailable — dataset "ds_gone" is not available in this workspace.',
		},
		unavailable: { props: VALID_PROPS["data-table"], expectText: "N/A — not yet published" },
		invalidProps: { title: "No dataset ref", sourceIds: [] },
		links: [SOURCE_A],
	},
	"financial-table": {
		validText: ["Valuation", "Trailing PER (x)", "18.25", "Methodology: Trailing PER = price"],
		missing: {
			props: { ...VALID_PROPS["financial-table"], datasetRef: "ds_gone" },
			expectText: 'Data unavailable — dataset "ds_gone"',
		},
		unavailable: { props: VALID_PROPS["financial-table"], expectText: "N/A — EPS is not positive" },
		invalidProps: { ...VALID_PROPS["financial-table"], methodologyNote: "" },
		links: [SOURCE_B],
	},
	"line-chart": {
		validText: ["Demand trajectory", "Installed demand (GWh)", "Base case", "Bull case"],
		missing: {
			props: { ...VALID_PROPS["line-chart"], datasetRef: "ds_gone" },
			expectText: 'Data unavailable — dataset "ds_gone"',
		},
		unavailable: {
			props: VALID_PROPS["line-chart"],
			expectText: "2 points unavailable — not plotted (never drawn as 0)",
		},
		invalidProps: { ...VALID_PROPS["line-chart"], series: [] },
		links: [SOURCE_A],
	},
	"bar-chart": {
		validText: ["Demand by year", "Installed demand (GWh)"],
		missing: {
			props: { ...VALID_PROPS["bar-chart"], datasetRef: "ds_gone" },
			expectText: 'Data unavailable — dataset "ds_gone"',
		},
		unavailable: {
			props: VALID_PROPS["bar-chart"],
			expectText: "2 points unavailable — not plotted (never drawn as 0)",
		},
		invalidProps: { ...VALID_PROPS["bar-chart"], yUnit: "" },
		links: [SOURCE_A],
	},
	"candlestick-chart": {
		validText: ["Example Electric daily price", "Price (JPY)", "Close below open"],
		missing: {
			props: { ...VALID_PROPS["candlestick-chart"], datasetRef: "ds_gone" },
			expectText: 'Data unavailable — dataset "ds_gone"',
		},
		unavailable: {
			props: VALID_PROPS["candlestick-chart"],
			expectText: "1 point unavailable — not plotted (never drawn as 0)",
		},
		invalidProps: { ...VALID_PROPS["candlestick-chart"], closeKey: "not a key!" },
		links: [SOURCE_B],
	},
	"news-card": {
		validText: ["Utilities accelerate storage tenders", "Three utilities announced tenders"],
		missing: {
			props: { ...VALID_PROPS["news-card"], sourceId: "ev_gone" },
			expectText: "Source unavailable (id ev_gone)",
			chipLabel: "unavailable",
		},
		unavailable: {
			props: { ...VALID_PROPS["news-card"], summary: null },
			expectText: "N/A — no summary stored for this article",
		},
		invalidProps: { headline: "", sourceId: "ev_a", summary: null },
		links: [SOURCE_A],
	},
	"source-list": {
		validText: ["Key sources", "Grid storage outlook 2026", "filings.example.org"],
		missing: {
			props: { title: "Key sources", sourceIds: ["ev_gone"] },
			expectText: "Source unavailable (id ev_gone)",
		},
		// The disclosure rows carry title and host only; dates live on the card.
		unavailable: { props: VALID_PROPS["source-list"], expectText: "2 sources" },
		invalidProps: { title: "Key sources", sourceIds: [] },
		links: [SOURCE_A, SOURCE_B],
	},
	"company-profile": {
		validText: ["Example Electric Co.", "6501", "TSE", "Japan", "Grid-scale inverters"],
		missing: {
			props: { ...VALID_PROPS["company-profile"], datasetRef: "ds_gone" },
			expectText: 'Data unavailable — dataset "ds_gone"',
		},
		unavailable: {
			props: VALID_PROPS["company-profile"],
			expectText: "N/A — EPS is not positive",
		},
		invalidProps: { ...VALID_PROPS["company-profile"], ticker: "lower case" },
		links: [SOURCE_B],
	},
	"research-report": {
		validText: [
			"Storage demand report",
			"Demand drivers",
			"Research aid only; not investment advice.",
			"Data cut-off: 2026-10-04",
		],
		missing: {
			props: VALID_PROPS["research-report"],
			expectText: "Source unavailable (id ev_unknown)",
			chipLabel: "unavailable",
		},
		unavailable: {
			props: VALID_PROPS["research-report"],
			expectText: "No sources cited for this statement.",
		},
		invalidProps: { ...VALID_PROPS["research-report"], disclaimer: "" },
		links: [SOURCE_A, SOURCE_B],
	},
};

describe.each(BASELINE_TYPES)("%s renderer", (componentType) => {
	const scenario = SCENARIOS[componentType];

	/** A chip's card opens on click; open the one naming the missing source. */
	function openChipByLabel(container: HTMLElement, wanted: string | undefined): void {
		if (wanted === undefined) return;
		const chip = [...container.querySelectorAll("[data-citation-chip]")].find((entry) =>
			entry.getAttribute("aria-label")?.includes(wanted),
		);
		if (!(chip instanceof HTMLElement)) throw new Error(`no chip labelled ${wanted}`);
		fireEvent.click(chip);
	}

	it("renders the valid fixture without a fallback", () => {
		const container = renderComponent(component(componentType, VALID_PROPS[componentType]));
		expect(container.querySelector("[data-fallback]")).toBeNull();
		for (const text of scenario.validText) {
			expect(container.textContent).toContain(text);
		}
		expect(container.querySelector("h3")).not.toBeNull();
	});

	it("shows an explicit state when referenced data is missing", () => {
		const container = renderComponent(
			component(componentType, scenario.missing.props),
			scenario.missing.context,
		);
		openChipByLabel(container, scenario.missing.chipLabel);
		expect(container.querySelector("[data-fallback]")).toBeNull();
		expect(container.textContent).toContain(scenario.missing.expectText);
	});

	it("renders unavailable values explicitly instead of blank or zero", () => {
		const container = renderComponent(
			component(componentType, scenario.unavailable.props),
			scenario.unavailable.context,
		);
		openChipByLabel(container, scenario.unavailable.chipLabel);
		expect(container.textContent).toContain(scenario.unavailable.expectText);
	});

	it("renders a fallback for invalid props instead of throwing", () => {
		const container = renderComponent(component(componentType, scenario.invalidProps));
		const fallback = container.querySelector('[data-fallback="INVALID_PROPS"]');
		expect(fallback?.textContent).toContain("Cannot render: invalid props");
		expect(fallback?.textContent).toContain(componentType);
		expect(container.querySelector("h3")).toBeNull();
	});

	it("renders its sources as safe https links", () => {
		const container = renderComponent(component(componentType, VALID_PROPS[componentType]));
		// Chips open their cards one at a time; collect every link shown, then
		// every link already in the document. All must be safe https links.
		const hrefs = new Set<string>();
		for (const chip of container.querySelectorAll("[data-citation-chip]")) {
			if (chip instanceof HTMLElement) {
				fireEvent.click(chip);
				for (const anchor of container.querySelectorAll("[data-citation-card] a")) {
					const href = anchor.getAttribute("href");
					if (href !== null) hrefs.add(href);
				}
			}
		}
		for (const anchor of expectOnlySafeLinks(container)) {
			const href = anchor.getAttribute("href");
			if (href !== null) hrefs.add(href);
		}
		for (const link of scenario.links) {
			expect(hrefs).toContain(link);
		}
	});
});

describe("provenance details", () => {
	it("shows the N sources disclosure with numbered rows matching the chips", () => {
		const container = renderComponent(component("source-list", VALID_PROPS["source-list"]));
		expect(container.textContent).toContain("2 sources");
		const rows = [...container.querySelectorAll('ol[aria-label="Sources"] > li')];
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("1."),
			expect.stringContaining("2."),
		]);
		expect(rows[0]?.textContent).toContain("Grid storage outlook 2026");
		expect(rows[0]?.textContent).toContain("example.com");
		expect(rows[0]?.querySelector("a")?.getAttribute("href")).toBe(SOURCE_A);
		expect(rows[1]?.textContent).toContain("Annual securities report FY2025");
		expect(rows[1]?.querySelector("a")?.getAttribute("href")).toBe(SOURCE_B);
	});

	it("shows title, publisher and all three dates on a source card", () => {
		const container = renderComponent(component("news-card", VALID_PROPS["news-card"]));
		const chip = container.querySelector("[data-citation-chip]");
		if (!(chip instanceof HTMLElement)) throw new Error("expected a citation chip");
		fireEvent.click(chip);
		const card = container.querySelector("[data-citation-card]");
		expect(card?.textContent).toContain("Grid storage outlook 2026");
		expect(card?.textContent).toContain("Example Energy Review");
		expect(card?.textContent).toContain("example.com");
		expect(card?.textContent).toContain("published");
		expect(card?.textContent).toContain("2026-09-01");
		expect(card?.textContent).toContain("retrieved");
		expect(card?.textContent).toContain("2026-10-01");
		expect(card?.textContent).toContain("data as of");
		expect(card?.textContent).toContain("2026-06-30");
		expect(card?.querySelector("a")?.getAttribute("href")).toBe(SOURCE_A);
	});

	it("says date not stated on the card when a date is missing, and omits data as of", () => {
		const container = renderComponent(component("financial-table", VALID_PROPS["financial-table"]));
		// EVIDENCE_B has no publication date and no as-of date: said
		// explicitly, not left blank.
		const chip = container.querySelector(
			'[data-citation-chip][aria-label="Source 1: Annual securities report FY2025"]',
		);
		if (!(chip instanceof HTMLElement)) throw new Error("expected a citation chip");
		fireEvent.click(chip);
		const card = container.querySelector("[data-citation-card]");
		expect(card?.textContent).toContain("date not stated");
		expect(card?.textContent).toContain("retrieved");
		expect(card?.textContent).not.toContain("data as of");
	});

	it("shows an as-of date and a citation chip on sourced numeric cells", () => {
		const container = renderComponent(component("financial-table", VALID_PROPS["financial-table"]));
		const perCell = [...container.querySelectorAll("td")].find((cell) =>
			cell.textContent?.includes("18.25"),
		);
		expect(perCell?.textContent).toContain("as of 2026-09-30");
		const chip = perCell?.querySelector("[data-citation-chip]");
		expect(chip?.tagName).toBe("BUTTON");
		expect(chip?.textContent).toBe("1");
		expect(chip?.getAttribute("aria-label")).toBe("Source 1: Annual securities report FY2025");
	});

	it("marks a cell whose source id does not resolve as a chip opening an unavailable card", () => {
		const container = renderComponent(component("financial-table", VALID_PROPS["financial-table"]));
		const marginCell = [...container.querySelectorAll("td")].find((cell) =>
			cell.textContent?.includes("7.4"),
		);
		const chip = marginCell?.querySelector("[data-citation-chip]");
		expect(chip?.tagName).toBe("BUTTON");
		expect(chip?.getAttribute("aria-label")).toBe("Source 2: unavailable");
		expect(marginCell?.querySelector("a")).toBeNull();
		if (!(chip instanceof HTMLElement)) throw new Error("expected a citation chip");
		fireEvent.click(chip);
		expect(container.querySelector("[data-citation-card]")?.textContent).toContain(
			"Source unavailable (id ev_missing)",
		);
	});

	it("says so when a component cites no sources at all", () => {
		const container = renderComponent(
			component("data-table", { title: "Empty", datasetRef: "ds_empty", sourceIds: [] }),
		);
		expect(container.textContent).toContain("No sources cited for this component.");
	});
});

describe("tables", () => {
	it("shows an empty state for a dataset with no rows", () => {
		const container = renderComponent(
			component("data-table", { ...VALID_PROPS["data-table"], datasetRef: "ds_empty" }),
		);
		expect(container.textContent).toContain("No rows — this dataset is empty.");
	});

	it("keeps a real zero distinct from an unavailable value", () => {
		const container = renderComponent(component("financial-table", VALID_PROPS["financial-table"]));
		const cells = texts(container, "tbody td");
		expect(cells.some((text) => text.startsWith("-2.1"))).toBe(true);
		expect(cells.filter((text) => text.includes("N/A"))).toHaveLength(1);
		expect(cells.some((text) => text.trim() === "" || text.trim() === "0")).toBe(false);
	});
});

describe("position labelling (FR-007 / DATA-006)", () => {
	const WITHHELD = "N/A — not shown: no security-level US margin-buy balance exists";

	/** Every component type that can display a dataset column, pointed at the positions dataset. */
	const LINE_CHART = component("line-chart", {
		...VALID_PROPS["line-chart"],
		datasetRef: "ds_positions",
		xKey: "security",
		series: [
			{ key: "jpBuy", label: "Margin buy balance" },
			{ key: "usBuy", label: "Buy balance" },
		],
		yUnit: "shares",
	});
	const BAR_CHART = component("bar-chart", {
		...VALID_PROPS["bar-chart"],
		datasetRef: "ds_positions",
		categoryKey: "security",
		series: [
			{ key: "usShort", label: "Short interest" },
			{ key: "usBuy", label: "Buy balance" },
		],
		yUnit: "shares",
	});
	const FINANCIAL_TABLE = component("financial-table", {
		...VALID_PROPS["financial-table"],
		datasetRef: "ds_positions",
	});

	/** Every component type that can display a dataset column, and the figures it must still show. */
	const CONSUMERS: readonly {
		readonly name: string;
		readonly consumer: WorkspaceComponent;
		readonly stillShown: readonly string[];
	}[] = [
		{
			name: "data-table",
			consumer: component("data-table", {
				title: "Positions",
				datasetRef: "ds_positions",
				sourceIds: ["ev_b"],
			}),
			stillShown: ["120,000", "45,000"],
		},
		{ name: "financial-table", consumer: FINANCIAL_TABLE, stillShown: ["120,000", "45,000"] },
		{
			name: "company-profile",
			consumer: component("company-profile", {
				...VALID_PROPS["company-profile"],
				datasetRef: "ds_positions",
			}),
			stillShown: ["120,000", "45,000"],
		},
		{ name: "line-chart", consumer: LINE_CHART, stillShown: ["120,000", "80,000"] },
		{ name: "bar-chart", consumer: BAR_CHART, stillShown: ["45,000", "30,000"] },
	];

	it.each(CONSUMERS)("$name never shows a figure from a US margin-buy column", (entry) => {
		const container = renderComponent(entry.consumer);
		expect(container.querySelector("[data-fallback]")).toBeNull();

		// Neither figure of the column appears anywhere: not in a cell, a chart title/tooltip,
		// a readout, nor in the chart's data-table twin.
		const everything = `${container.textContent} ${[...container.querySelectorAll("title")]
			.map((title) => title.textContent)
			.join(" ")}`;
		expect(everything).not.toContain("99,999");
		expect(everything).not.toContain("99999");
		expect(everything).not.toContain("77,777");
		expect(everything).not.toContain("77777");
		// The withholding is stated, with its reason, for both rows.
		expect(container.textContent?.split(WITHHELD).length).toBe(3);
		// The legitimate columns are untouched.
		for (const figure of entry.stillShown) expect(everything).toContain(figure);
		// The withheld cells lose their provenance and basis too.
		const withheldCells = [...container.querySelectorAll("td")].filter((cell) =>
			cell.textContent?.includes(WITHHELD),
		);
		expect(withheldCells).toHaveLength(2);
		for (const cell of withheldCells) {
			expect(cell.querySelector("a, time, [data-cell-basis]")).toBeNull();
		}
	});

	it("plots nothing for a withheld series and says so instead of listing it in the legend", () => {
		const line = renderComponent(LINE_CHART);
		expect(line.querySelectorAll("circle[data-point]")).toHaveLength(2);
		expect(line.querySelector('[data-series="Buy balance"]')).toBeNull();
		expect(line.querySelector("[data-withheld-series]")?.textContent).toBe(
			'Series "Buy balance" — not shown: no security-level US margin-buy balance exists.',
		);
		expect(line.querySelector("svg[role='img']")?.getAttribute("aria-label")).not.toContain(
			"Buy balance,",
		);
		expect(line.querySelector('ul[aria-label="Legend"]')).toBeNull();
		cleanup();

		const bar = renderComponent(BAR_CHART);
		expect(bar.querySelectorAll("path[data-bar]")).toHaveLength(2);
		expect(texts(bar, "path[data-bar] title")).toEqual([
			"Example Corp — Short interest: 45,000 shares",
			"Sample Inc — Short interest: 30,000 shares",
		]);
	});

	it("withholds a series that is only labelled as US margin buy by the chart props", () => {
		const container = renderComponent(
			component("bar-chart", {
				...VALID_PROPS["bar-chart"],
				datasetRef: "ds_positions",
				categoryKey: "security",
				series: [
					{ key: "usShort", label: "Short interest" },
					{ key: "jpBuy", label: "US margin purchases (NYSE)" },
				],
				yUnit: "shares",
			}),
		);
		// The innocuously named column is withheld because the chart presents it as a US margin-buy figure.
		expect(container.querySelectorAll("path[data-bar]")).toHaveLength(2);
		expect(container.textContent).not.toContain("120,000");
		expect(container.textContent).not.toContain("80,000");
		expect(container.querySelector("[data-withheld-series]")?.textContent).toContain(
			'"US margin purchases (NYSE)"',
		);
		expect(container.textContent).toContain(WITHHELD);
	});

	it("shows distinct JP and US caveats on a financial table", () => {
		const container = renderComponent(FINANCIAL_TABLE);
		expect(
			container.querySelector('[data-position-caveat="jp-margin-balance"]')?.textContent,
		).toContain("Japan margin trading balances");
		expect(
			container.querySelector('[data-position-caveat="us-short-interest"]')?.textContent,
		).toContain("no security-level US margin-buy balance exists");
	});

	it("adds no position caveat to an ordinary profitability table", () => {
		const container = renderComponent(component("financial-table", VALID_PROPS["financial-table"]));
		expect(container.querySelector("[data-position-caveat]")).toBeNull();
	});

	it("withholds no ordinary column", () => {
		const container = renderComponent(component("data-table", VALID_PROPS["data-table"]));
		expect(container.textContent).not.toContain("not shown");
	});
});

describe("basis of displayed numbers (hard gate 6)", () => {
	function cellOf(container: HTMLElement, rowLabel: string, columnIndex: number): Element {
		const row = [...container.querySelectorAll("tbody tr")].find(
			(candidate) => candidate.querySelector("th")?.textContent === rowLabel,
		);
		// Data cells only: the Select cell holds a row button, while sourced
		// cells now hold citation chips (also buttons).
		const cell = row?.querySelectorAll('td:not(:has(button[aria-label^="Select row"]))')[
			columnIndex
		];
		if (cell === undefined) throw new Error(`no cell ${columnIndex} in row ${rowLabel}`);
		return cell;
	}

	it("marks an assumption next to its number in a table", () => {
		const container = renderComponent(component("data-table", VALID_PROPS["data-table"]));
		const bull2026 = cellOf(container, "2026", 1);
		expect(bull2026.textContent).toContain("140");
		const marker = bull2026.querySelector("[data-cell-basis]");
		expect(marker?.getAttribute("data-cell-basis")).toBe("assumption");
		expect(marker?.textContent).toBe("assumption");
		// An assumption has no source link and no as-of date to borrow credibility from.
		expect(bull2026.querySelector("a, time")).toBeNull();
	});

	it("marks a derived value next to its number in a table", () => {
		const container = renderComponent(component("data-table", VALID_PROPS["data-table"]));
		const base2027 = cellOf(container, "2027", 0);
		expect(base2027.textContent).toContain("150");
		const marker = base2027.querySelector("[data-cell-basis]");
		expect(marker?.getAttribute("data-cell-basis")).toBe("derived");
		expect(marker?.textContent).toBe("derived");
	});

	it("shows a sourced number with its chip and as-of date and no basis marker", () => {
		const container = renderComponent(component("data-table", VALID_PROPS["data-table"]));
		const base2026 = cellOf(container, "2026", 0);
		expect(base2026.textContent).toContain("120");
		expect(base2026.querySelector("time")?.textContent).toBe("2026-06-30");
		expect(base2026.textContent).toContain("as of 2026-06-30");
		const chip = base2026.querySelector("[data-citation-chip]");
		expect(chip?.tagName).toBe("BUTTON");
		expect(chip?.textContent).toBe("1");
		expect(chip?.getAttribute("aria-label")).toBe("Source 1: Grid storage outlook 2026");
		expect(base2026.querySelector("[data-cell-basis]")).toBeNull();
	});

	it("puts no marker on text, unavailable or withheld cells", () => {
		const container = renderComponent(component("data-table", VALID_PROPS["data-table"]));
		expect(container.querySelectorAll("th [data-cell-basis]")).toHaveLength(0);
		expect(cellOf(container, "2027", 1).textContent).toBe("N/A — not yet published");
		expect(cellOf(container, "2027", 1).querySelector("[data-cell-basis]")).toBeNull();
		// 140, 150, 185, 230 and 310 are marked; the sourced 120 and the two unavailable cells are not.
		expect(texts(container, "[data-cell-basis]")).toEqual([
			"assumption",
			"derived",
			"assumption",
			"assumption",
			"assumption",
		]);
	});

	it("carries the same markers into a chart's data table and says so beside the plot", () => {
		const container = renderComponent(component("line-chart", VALID_PROPS["line-chart"]));
		const table = container.querySelector("details table");
		expect(texts(table ?? container, '[data-cell-basis="assumption"]')).toHaveLength(4);
		expect(texts(table ?? container, '[data-cell-basis="derived"]')).toEqual(["derived"]);
		expect(
			table?.querySelector(
				'[data-citation-chip][aria-label="Source 1: Grid storage outlook 2026"]',
			),
		).not.toBeNull();
		expect(container.querySelector("[data-chart-basis-note]")?.textContent).toBe(
			"Not sourced measurements: 4 assumptions, 1 derived value. Each is marked in the data table.",
		);
	});

	it("counts only the plotted columns in a chart's basis note", () => {
		// The bar fixture plots the bull column only: 140 and 310 are assumptions.
		const container = renderComponent(component("bar-chart", VALID_PROPS["bar-chart"]));
		expect(container.querySelector("[data-chart-basis-note]")?.textContent).toBe(
			"Not sourced measurements: 2 assumptions. Each is marked in the data table.",
		);
	});

	it("adds no basis note to a chart whose values are all sourced", () => {
		const container = renderComponent(
			component("candlestick-chart", VALID_PROPS["candlestick-chart"]),
		);
		expect(container.querySelector("[data-chart-basis-note]")).toBeNull();
		expect(container.querySelectorAll("details [data-cell-basis]")).toHaveLength(0);
		expect(container.querySelectorAll("details td time").length).toBeGreaterThan(0);
	});

	it("shows the basis markers in a company profile's metrics table too", () => {
		const container = renderComponent(
			component("company-profile", { ...VALID_PROPS["company-profile"], datasetRef: "ds_demand" }),
		);
		expect(container.querySelectorAll('[data-cell-basis="assumption"]')).toHaveLength(4);
	});

	it("classifies cells without rendering", () => {
		expect(cellBasis({ v: 1, sourceId: "ev_a", asOf: "2026-01-01" })).toBe("sourced");
		expect(cellBasis({ v: 1, basis: "assumption" })).toBe("assumption");
		expect(cellBasis({ v: 1, basis: "derived", sourceId: "ev_a", asOf: "2026-01-01" })).toBe(
			"derived",
		);
		expect(cellBasis({ v: 0 })).toBe("unstated");
		expect(cellBasis({ v: "text" })).toBeNull();
		expect(cellBasis({ v: null, reason: "missing" })).toBeNull();
		expect(cellBasis(undefined)).toBeNull();
	});
});

describe("stale data: a number column holding text", () => {
	it("renders the cell as unavailable instead of echoing the text as a figure", () => {
		const container = renderComponent(
			component("data-table", { title: "Stale", datasetRef: "ds_stale", sourceIds: [] }),
		);
		expect(container.textContent).toContain("N/A — value is not numeric");
		expect(container.textContent).not.toContain("about 260");
		// The genuine number in the same column is still shown.
		expect(texts(container, "tbody td").some((text) => text.startsWith("120"))).toBe(true);
	});

	it("flags a stored number that has neither a source nor a declared basis", () => {
		const container = renderComponent(
			component("data-table", { title: "Stale", datasetRef: "ds_stale", sourceIds: [] }),
		);
		const marker = container.querySelector('[data-cell-basis="unstated"]');
		expect(marker?.textContent).toBe("unsourced — basis not stated");
		expect(marker?.closest("td")?.textContent).toContain("120");
	});

	it("says so when a sourced number is missing its as-of date", () => {
		const container = renderComponent(
			component("data-table", { title: "Stale", datasetRef: "ds_undated", sourceIds: [] }),
			{
				datasets: new Map([
					[
						"ds_undated",
						{
							...STALE_DATASET,
							datasetId: "ds_undated",
							rows: [{ year: { v: "2026" }, base: { v: 120, sourceId: "ev_a" } }],
						},
					],
				]),
			},
		);
		const cell = container.querySelector("tbody td:last-child");
		expect(cell?.querySelector("[data-as-of-missing]")?.textContent?.trim()).toBe(
			"as-of date not stated",
		);
		const chip = cell?.querySelector("[data-citation-chip]");
		expect(chip?.tagName).toBe("BUTTON");
		expect(chip?.getAttribute("aria-label")).toBe("Source 1: Grid storage outlook 2026");
		if (!(chip instanceof HTMLElement)) throw new Error("expected a citation chip");
		fireEvent.click(chip);
		expect(container.querySelector("[data-citation-card] a")?.getAttribute("href")).toBe(SOURCE_A);
		expect(cell?.querySelector("[data-cell-basis]")).toBeNull();
	});

	it("does not plot it and counts it as unavailable", () => {
		const container = renderComponent(
			component("bar-chart", {
				...VALID_PROPS["bar-chart"],
				datasetRef: "ds_stale",
				series: [{ key: "base", label: "Base case" }],
			}),
		);
		expect(container.querySelectorAll("path[data-bar]")).toHaveLength(1);
		expect(
			container.querySelector("[data-unavailable-count]")?.getAttribute("data-unavailable-count"),
		).toBe("1");
		expect(container.textContent).not.toContain("about 260");
		expect(container.querySelector("details table")?.textContent).toContain(
			"N/A — value is not numeric",
		);
		expect(container.querySelector("[data-chart-basis-note]")?.textContent).toBe(
			"Not sourced measurements: 1 value with no stated basis. Each is marked in the data table.",
		);
	});
});

describe("research-report", () => {
	it("badges claim-backed statements, keeping unsupported and conflicting visibly distinct", () => {
		const container = renderComponent(component("research-report", VALID_PROPS["research-report"]));
		const claimStatements = [...container.querySelectorAll("li[data-claim-id]")];
		expect(claimStatements.map((item) => item.getAttribute("data-claim-id"))).toEqual([
			"claim_obs",
			"claim_fc",
			"claim_inf",
		]);
		expect(texts(container, "[data-claim-type]")).toEqual(["Observation", "Forecast", "Inference"]);
		const statuses = [...container.querySelectorAll("[data-claim-status]")];
		expect(statuses.map((badge) => badge.getAttribute("data-claim-status"))).toEqual([
			"supported",
			"unsupported",
			"conflicting",
		]);
		expect(statuses.map((badge) => badge.textContent)).toEqual([
			"✓Supported",
			"✕Unsupported",
			"≠Conflicting evidence",
		]);
		const classNames = new Set(statuses.map((badge) => badge.getAttribute("class")));
		expect(classNames.size).toBe(3);
		// Unsupported and conflicting statements stay in the document.
		expect(container.textContent).toContain("Demand will triple by 2030.");
		expect(container.textContent).toContain("Pricing is stabilising.");
	});

	it("marks a statement without a claim as an unverified note with no badge at all", () => {
		const container = renderComponent(component("research-report", VALID_PROPS["research-report"]));
		const notes = [...container.querySelectorAll('li[data-statement-kind="note"]')];
		expect(notes).toHaveLength(1);
		const [note] = notes;
		expect(note?.textContent).toContain("Supply chains may localise.");
		expect(note?.querySelector("[data-unverified-note]")?.textContent).toBe(
			"Unverified note — not checked against stored evidence",
		);
		expect(note?.querySelector("[data-claim-type], [data-claim-status]")).toBeNull();
		expect(note?.hasAttribute("data-claim-id")).toBe(false);
		// Its cited source is still listed as a chip (and honestly reported as
		// unresolvable once its card opens).
		expect(
			note?.querySelector('[data-citation-chip][aria-label="Source 3: unavailable"]'),
		).not.toBeNull();
	});

	it("rejects props that give a free-form statement a status or type", () => {
		const [section] = VALID_PROPS["research-report"].sections;
		for (const statement of [
			{ text: "Trust me.", claimId: null, claimType: null, status: "supported", sourceIds: [] },
			{ text: "Trust me.", claimId: null, claimType: "observation", status: null, sourceIds: [] },
			{ text: "Trust me.", claimId: "claim_obs", claimType: null, status: null, sourceIds: [] },
		]) {
			const container = renderComponent(
				component("research-report", {
					...VALID_PROPS["research-report"],
					sections: [{ heading: section.heading, statements: [statement] }],
				}),
			);
			expect(container.querySelector('[data-fallback="INVALID_PROPS"]')).not.toBeNull();
			expect(container.querySelector("[data-claim-status]")).toBeNull();
			cleanup();
		}
	});

	it("never renders a supported badge for a free-form statement, even past the schema", () => {
		// Defence in depth: the renderer is handed props the schema would have refused.
		const { container } = render(() => (
			<ResearchReport
				componentId="report_direct"
				context={makeContext()}
				props={{
					title: "Direct",
					generatedAt: "2026-10-05T12:00:00Z",
					dataCutoffAt: "2026-10-04T00:00:00Z",
					disclaimer: "Research aid only.",
					sections: [
						{
							heading: "Notes",
							statements: [
								{
									text: "Unbacked but dressed up as verified.",
									claimId: null,
									claimType: "observation",
									status: "supported",
									sourceIds: [],
								},
							],
						},
					],
				}}
			/>
		));
		expect(container.textContent).toContain("Unbacked but dressed up as verified.");
		expect(container.querySelector("[data-claim-status]")).toBeNull();
		expect(container.querySelector("[data-claim-type]")).toBeNull();
		expect(container.textContent).not.toContain("Supported");
		expect(container.querySelector("[data-unverified-note]")).not.toBeNull();
	});
});
