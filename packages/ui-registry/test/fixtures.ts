import {
	type ApprovedAsset,
	approvedAssetSchema,
	type Dataset,
	datasetSchema,
	type Evidence,
	evidenceSchema,
} from "@research/contracts";
import type { RenderContext, WorkspaceComponent } from "../src/index.ts";

/** Fixtures are parsed with the contract schemas so the tests cannot drift from the API. */

export const EVIDENCE_A: Evidence = evidenceSchema.parse({
	evidenceId: "ev_a",
	sourceUrl: "https://example.com/reports/grid-storage",
	title: "Grid storage outlook 2026",
	publisher: "Example Energy Review",
	publishedAt: "2026-09-01T09:00:00Z",
	retrievedAt: "2026-10-01T08:30:00Z",
	effectiveAt: "2026-06-30T00:00:00Z",
	excerpt: null,
	checksum: "a".repeat(64),
	sourceClass: "news",
});

export const EVIDENCE_B: Evidence = evidenceSchema.parse({
	evidenceId: "ev_b",
	sourceUrl: "https://filings.example.org/annual/2025",
	title: "Annual securities report FY2025",
	publisher: "Example Filing Agency",
	publishedAt: null,
	retrievedAt: "2026-10-02T10:00:00Z",
	effectiveAt: null,
	excerpt: null,
	checksum: "b".repeat(64),
	sourceClass: "regulatory-filing",
});

export const DEMAND_DATASET: Dataset = datasetSchema.parse({
	datasetId: "ds_demand",
	title: "Grid storage demand by year",
	createdAt: "2026-10-03T00:00:00Z",
	columns: [
		{ key: "year", label: "Year", kind: "text" },
		{ key: "base", label: "Base case", kind: "number", unit: "GWh" },
		{ key: "bull", label: "Bull case", kind: "number", unit: "GWh" },
	],
	rows: [
		{
			year: { v: "2026" },
			base: { v: 120, sourceId: "ev_a", asOf: "2026-06-30" },
			bull: { v: 140, basis: "assumption" },
		},
		{
			year: { v: "2027" },
			base: { v: 150, basis: "derived" },
			bull: { v: null, reason: "not yet published" },
		},
		{
			year: { v: "2028" },
			base: { v: 185, basis: "assumption" },
			bull: { v: null, reason: "estimate withheld" },
		},
		{
			year: { v: "2029" },
			base: { v: 230, basis: "assumption" },
			bull: { v: 310, basis: "assumption" },
		},
	],
});

/**
 * Stored before the cell rules were tightened: a number column holding text,
 * and a bare number with neither a source nor a declared basis. The contract
 * schema now rejects both, so it is built by hand to check that renderers stay
 * honest with stale data.
 */
export const STALE_DATASET: Dataset = {
	datasetId: "ds_stale",
	title: "Stale demand estimates",
	createdAt: "2026-01-03T00:00:00Z",
	columns: [
		{ key: "year", label: "Year", kind: "text" },
		{ key: "base", label: "Base case", kind: "number", unit: "GWh" },
	],
	rows: [
		{ year: { v: "2026" }, base: { v: 120 } },
		{ year: { v: "2027" }, base: { v: "about 260" } },
	],
};

/** Position figures, including a column that claims to be a US margin-buy balance (FR-007). */
export const POSITIONS_DATASET: Dataset = datasetSchema.parse({
	datasetId: "ds_positions",
	title: "Positions",
	createdAt: "2026-10-03T00:00:00Z",
	columns: [
		{ key: "security", label: "Security", kind: "text" },
		{ key: "jpBuy", label: "Margin buy balance", kind: "number", unit: "shares" },
		{ key: "usShort", label: "Short interest", kind: "number", unit: "shares" },
		{ key: "usBuy", label: "US margin buy balance", kind: "number", unit: "shares" },
	],
	rows: [
		{
			security: { v: "Example Corp" },
			jpBuy: { v: 120000, sourceId: "ev_b", asOf: "2026-09-26" },
			usShort: { v: 45000, sourceId: "ev_b", asOf: "2026-09-15" },
			usBuy: { v: 99999, sourceId: "ev_b", asOf: "2026-09-30" },
		},
		{
			security: { v: "Sample Inc" },
			jpBuy: { v: 80000, sourceId: "ev_b", asOf: "2026-09-26" },
			usShort: { v: 30000, sourceId: "ev_b", asOf: "2026-09-15" },
			usBuy: { v: 77777, basis: "assumption" },
		},
	],
});

export const EMPTY_DATASET: Dataset = datasetSchema.parse({
	datasetId: "ds_empty",
	title: "Nothing collected yet",
	createdAt: "2026-10-03T00:00:00Z",
	columns: [
		{ key: "year", label: "Year", kind: "text" },
		{ key: "base", label: "Base case", kind: "number", unit: "GWh" },
	],
	rows: [],
});

export const FINANCIAL_DATASET: Dataset = datasetSchema.parse({
	datasetId: "ds_fin",
	title: "Valuation metrics",
	createdAt: "2026-10-03T00:00:00Z",
	columns: [
		{ key: "company", label: "Company", kind: "text" },
		{ key: "per", label: "Trailing PER", kind: "number", unit: "x" },
		{ key: "margin", label: "Net profit margin", kind: "number", unit: "%" },
	],
	rows: [
		{
			company: { v: "Example Electric" },
			per: { v: 18.25, sourceId: "ev_b", asOf: "2026-09-30T06:00:00Z" },
			margin: { v: 7.4, sourceId: "ev_missing", asOf: "2026-03-31" },
		},
		{
			company: { v: "Sample Batteries" },
			per: { v: null, reason: "EPS is not positive" },
			margin: { v: -2.1, sourceId: "ev_b", asOf: "2026-03-31" },
		},
	],
});

/** A market price is a sourced measurement: it carries its source and the day it is as of. */
function price(value: number, day: string) {
	return { v: value, sourceId: "ev_b", asOf: day };
}

export const PRICE_DATASET: Dataset = datasetSchema.parse({
	datasetId: "ds_price",
	title: "Daily prices",
	createdAt: "2026-10-03T00:00:00Z",
	columns: [
		{ key: "day", label: "Date", kind: "date" },
		{ key: "o", label: "Open", kind: "number", unit: "JPY" },
		{ key: "h", label: "High", kind: "number", unit: "JPY" },
		{ key: "l", label: "Low", kind: "number", unit: "JPY" },
		{ key: "c", label: "Close", kind: "number", unit: "JPY" },
	],
	rows: [
		{
			day: { v: "2026-09-28" },
			o: price(1000, "2026-09-28"),
			h: price(1050, "2026-09-28"),
			l: price(990, "2026-09-28"),
			c: price(1040, "2026-09-28"),
		},
		{
			day: { v: "2026-09-29" },
			o: price(1040, "2026-09-29"),
			h: price(1045, "2026-09-29"),
			l: price(1001, "2026-09-29"),
			c: price(1010, "2026-09-29"),
		},
		{
			day: { v: "2026-09-30" },
			o: price(1010, "2026-09-30"),
			h: price(1030, "2026-09-30"),
			l: price(1000, "2026-09-30"),
			c: { v: null, reason: "market closed early" },
		},
	],
});

export const ASSET_A: ApprovedAsset = approvedAssetSchema.parse({
	assetId: "asset_a",
	imageUrl: "https://images.example.com/plant.jpg",
	altText: "Battery plant exterior",
	permissionBasis: "Press kit, reuse permitted with credit",
	sourceEvidenceId: "ev_a",
	createdAt: "2026-10-03T00:00:00Z",
});

export function mapBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> {
	return new Map(items.map((item) => [keyOf(item), item] as const));
}

export function makeContext(overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		datasets: mapBy(
			[
				DEMAND_DATASET,
				EMPTY_DATASET,
				FINANCIAL_DATASET,
				PRICE_DATASET,
				STALE_DATASET,
				POSITIONS_DATASET,
			],
			(dataset) => dataset.datasetId,
		),
		sources: mapBy([EVIDENCE_A, EVIDENCE_B], (evidence) => evidence.evidenceId),
		assets: mapBy([ASSET_A], (asset) => asset.assetId),
		selection: null,
		onSelect: () => {},
		...overrides,
	};
}

export function component(
	componentType: string,
	props: WorkspaceComponent["props"],
	overrides: Partial<WorkspaceComponent> = {},
): WorkspaceComponent {
	return {
		componentId: `${componentType.replaceAll("-", "_")}_1`,
		componentType,
		schemaVersion: 1,
		props,
		...overrides,
	};
}

export const BASELINE_TYPES = [
	"data-table",
	"financial-table",
	"line-chart",
	"bar-chart",
	"candlestick-chart",
	"news-card",
	"source-list",
	"company-profile",
	"image-gallery",
	"research-report",
] as const;
export type BaselineType = (typeof BASELINE_TYPES)[number];

/** One valid props object per baseline component type. */
export const VALID_PROPS = {
	"data-table": {
		title: "Demand scenarios",
		datasetRef: "ds_demand",
		sourceIds: ["ev_a"],
		caption: "Base and bull demand, GWh",
	},
	"financial-table": {
		title: "Valuation",
		datasetRef: "ds_fin",
		sourceIds: ["ev_b"],
		methodologyNote: "Trailing PER = price / diluted EPS (TTM); N/A when EPS is not positive.",
	},
	"line-chart": {
		title: "Demand trajectory",
		datasetRef: "ds_demand",
		xKey: "year",
		series: [
			{ key: "base", label: "Base case" },
			{ key: "bull", label: "Bull case" },
		],
		xLabel: "Year",
		yLabel: "Installed demand",
		yUnit: "GWh",
		sourceIds: ["ev_a"],
	},
	"bar-chart": {
		title: "Demand by year",
		datasetRef: "ds_demand",
		categoryKey: "year",
		series: [{ key: "bull", label: "Bull case" }],
		xLabel: "Year",
		yLabel: "Installed demand",
		yUnit: "GWh",
		sourceIds: ["ev_a"],
	},
	"candlestick-chart": {
		title: "Example Electric daily price",
		datasetRef: "ds_price",
		dateKey: "day",
		openKey: "o",
		highKey: "h",
		lowKey: "l",
		closeKey: "c",
		priceUnit: "JPY",
		sourceIds: ["ev_b"],
	},
	"news-card": {
		headline: "Utilities accelerate storage tenders",
		sourceId: "ev_a",
		summary: "Three utilities announced tenders totalling 4 GWh.",
	},
	"source-list": { title: "Key sources", sourceIds: ["ev_a", "ev_b"] },
	"company-profile": {
		companyName: "Example Electric Co.",
		ticker: "6501",
		exchange: "TSE",
		country: "JP",
		productsOrServices: ["Grid-scale inverters", "Battery management systems"],
		businessExposure: "About a fifth of segment revenue comes from storage integration.",
		datasetRef: "ds_fin",
		sourceIds: ["ev_b"],
	},
	"image-gallery": {
		title: "Plant photos",
		images: [{ assetRef: "asset_a", caption: "Main assembly hall" }],
	},
	"research-report": {
		title: "Storage demand report",
		generatedAt: "2026-10-05T12:00:00Z",
		dataCutoffAt: "2026-10-04T00:00:00Z",
		sections: [
			{
				heading: "Demand drivers",
				statements: [
					{
						text: "Utility tenders rose year over year.",
						claimId: "claim_obs",
						claimType: "observation",
						status: "supported",
						sourceIds: ["ev_a"],
					},
					{
						text: "Demand will triple by 2030.",
						claimId: "claim_fc",
						claimType: "forecast",
						status: "unsupported",
						sourceIds: [],
					},
					{
						text: "Pricing is stabilising.",
						claimId: "claim_inf",
						claimType: "inference",
						status: "conflicting",
						sourceIds: ["ev_a", "ev_b"],
					},
					{
						// A free-form note: no stored claim, so no type or status.
						text: "Supply chains may localise.",
						claimId: null,
						claimType: null,
						status: null,
						sourceIds: ["ev_unknown"],
					},
				],
			},
		],
		disclaimer: "Research aid only; not investment advice.",
	},
} as const satisfies Record<BaselineType, WorkspaceComponent["props"]>;
