import {
	applyUiCommand,
	type CommandContext,
	emptyWorkspaceState,
	type JsonObject,
	NO_REFERENCES,
	UI_PROTOCOL_VERSION,
	type UiCommand,
	type UiOperation,
	type WorkspaceState,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	BASELINE_COMPONENT_DEFINITIONS,
	barChartPropsSchema,
	type ComponentDefinition,
	candlestickChartPropsSchema,
	companyProfilePropsSchema,
	createComponentCatalog,
	dataTablePropsSchema,
	defineComponent,
	financialTablePropsSchema,
	idSchema,
	imageGalleryPropsSchema,
	lineChartPropsSchema,
	newsCardPropsSchema,
	researchReportPropsSchema,
	shortTextSchema,
	sourceListPropsSchema,
	uiCommandSchema,
} from "../src/index.ts";
import { SECTION_7_EXAMPLE_COMMAND } from "./fixtures.ts";

const catalog = createComponentCatalog(BASELINE_COMPONENT_DEFINITIONS);

const BASELINE_TYPES = [
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

type BaselineType = (typeof BASELINE_TYPES)[number];

interface PropsFixture {
	readonly valid: JsonObject;
	/** The references a valid instance must report, so the reducer can check ownership. */
	readonly references: {
		readonly datasetRefs: readonly string[];
		readonly sourceIds: readonly string[];
		readonly assetRefs: readonly string[];
		readonly claims?: readonly {
			readonly claimId: string;
			readonly status: string;
			readonly claimType: string;
		}[];
	};
	readonly invalid: readonly (readonly [string, JsonObject])[];
}

const series = [{ key: "revenue", label: "Revenue" }];

/** UI-008: one valid and several invalid props fixtures for every registered component type. */
const FIXTURES: { readonly [T in BaselineType]: PropsFixture } = {
	"data-table": {
		valid: {
			title: "Demand scenarios",
			datasetRef: "ds_1",
			sourceIds: ["ev_1", "ev_2"],
			caption: "c",
		},
		references: { datasetRefs: ["ds_1"], sourceIds: ["ev_1", "ev_2"], assetRefs: [] },
		invalid: [
			["missing datasetRef", { title: "T", sourceIds: [] }],
			["missing sourceIds", { title: "T", datasetRef: "ds_1" }],
			["blank title", { title: "  ", datasetRef: "ds_1", sourceIds: [] }],
			["raw html key", { title: "T", datasetRef: "ds_1", sourceIds: [], html: "<b>x</b>" }],
			["inline rows instead of a dataset reference", { title: "T", rows: [[1, 2]], sourceIds: [] }],
			["malformed source id", { title: "T", datasetRef: "ds_1", sourceIds: ["not an id"] }],
		],
	},
	"financial-table": {
		valid: {
			title: "Valuation",
			datasetRef: "ds_1",
			sourceIds: ["ev_1"],
			methodologyNote: "Trailing PER = price / diluted EPS (FY2025, JGAAP).",
		},
		references: { datasetRefs: ["ds_1"], sourceIds: ["ev_1"], assetRefs: [] },
		invalid: [
			["missing methodology note", { title: "T", datasetRef: "ds_1", sourceIds: [] }],
			[
				"empty methodology note",
				{ title: "T", datasetRef: "ds_1", sourceIds: [], methodologyNote: "" },
			],
			[
				"unknown key",
				{ title: "T", datasetRef: "ds_1", sourceIds: [], methodologyNote: "m", x: 1 },
			],
		],
	},
	"line-chart": {
		valid: {
			title: "Revenue",
			datasetRef: "ds_1",
			xKey: "year",
			series,
			xLabel: "Fiscal year",
			yLabel: "Revenue",
			yUnit: "JPY bn",
			sourceIds: ["ev_1"],
		},
		references: { datasetRefs: ["ds_1"], sourceIds: ["ev_1"], assetRefs: [] },
		invalid: [
			[
				"missing y unit",
				{
					title: "T",
					datasetRef: "ds_1",
					xKey: "year",
					series,
					xLabel: "x",
					yLabel: "y",
					sourceIds: [],
				},
			],
			[
				"missing axis label",
				{
					title: "T",
					datasetRef: "ds_1",
					xKey: "year",
					series,
					yLabel: "y",
					yUnit: "u",
					sourceIds: [],
				},
			],
			[
				"no series",
				{
					title: "T",
					datasetRef: "ds_1",
					xKey: "year",
					series: [],
					xLabel: "x",
					yLabel: "y",
					yUnit: "u",
					sourceIds: [],
				},
			],
			[
				"inline data points",
				{
					title: "T",
					datasetRef: "ds_1",
					xKey: "year",
					series,
					xLabel: "x",
					yLabel: "y",
					yUnit: "u",
					sourceIds: [],
					points: [1, 2, 3],
				},
			],
		],
	},
	"bar-chart": {
		valid: {
			title: "Margin by segment",
			datasetRef: "ds_2",
			categoryKey: "segment",
			series,
			xLabel: "Segment",
			yLabel: "Net margin",
			yUnit: "%",
			sourceIds: [],
		},
		references: { datasetRefs: ["ds_2"], sourceIds: [], assetRefs: [] },
		invalid: [
			[
				"missing category key",
				{
					title: "T",
					datasetRef: "ds_2",
					series,
					xLabel: "x",
					yLabel: "y",
					yUnit: "%",
					sourceIds: [],
				},
			],
			[
				"too many series",
				{
					title: "T",
					datasetRef: "ds_2",
					categoryKey: "segment",
					series: Array.from({ length: 9 }, (_unused, index) => ({ key: `s${index}`, label: "S" })),
					xLabel: "x",
					yLabel: "y",
					yUnit: "%",
					sourceIds: [],
				},
			],
			[
				"malformed series key",
				{
					title: "T",
					datasetRef: "ds_2",
					categoryKey: "segment",
					series: [{ key: "not a key", label: "S" }],
					xLabel: "x",
					yLabel: "y",
					yUnit: "%",
					sourceIds: [],
				},
			],
		],
	},
	"candlestick-chart": {
		valid: {
			title: "Share price",
			datasetRef: "ds_3",
			dateKey: "day",
			openKey: "open",
			highKey: "high",
			lowKey: "low",
			closeKey: "close",
			priceUnit: "JPY",
			sourceIds: ["ev_3"],
		},
		references: { datasetRefs: ["ds_3"], sourceIds: ["ev_3"], assetRefs: [] },
		invalid: [
			[
				"missing price unit",
				{
					title: "T",
					datasetRef: "ds_3",
					dateKey: "day",
					openKey: "open",
					highKey: "high",
					lowKey: "low",
					closeKey: "close",
					sourceIds: [],
				},
			],
			[
				"missing close key",
				{
					title: "T",
					datasetRef: "ds_3",
					dateKey: "day",
					openKey: "open",
					highKey: "high",
					lowKey: "low",
					priceUnit: "JPY",
					sourceIds: [],
				},
			],
		],
	},
	"news-card": {
		valid: { headline: "Battery makers expand capacity", sourceId: "ev_1", summary: null },
		references: { datasetRefs: [], sourceIds: ["ev_1"], assetRefs: [] },
		invalid: [
			["missing source id", { headline: "H", summary: null }],
			[
				"a raw URL instead of a stored source",
				{ headline: "H", url: "https://x.example.org/", summary: null },
			],
			["missing summary field", { headline: "H", sourceId: "ev_1" }],
			["empty headline", { headline: "", sourceId: "ev_1", summary: null }],
			["oversized summary", { headline: "H", sourceId: "ev_1", summary: "s".repeat(501) }],
		],
	},
	"source-list": {
		valid: { title: "Sources", sourceIds: ["ev_1", "ev_2"] },
		references: { datasetRefs: [], sourceIds: ["ev_1", "ev_2"], assetRefs: [] },
		invalid: [
			["no sources", { title: "Sources", sourceIds: [] }],
			["missing title", { sourceIds: ["ev_1"] }],
			["raw links", { title: "Sources", sourceIds: ["ev_1"], links: ["https://x.example.org/"] }],
		],
	},
	"company-profile": {
		valid: {
			companyName: "Example Denki KK",
			ticker: "6999",
			exchange: "TSE",
			country: "JP",
			productsOrServices: ["Battery separators"],
			businessExposure: "About a third of segment revenue.",
			datasetRef: "ds_4",
			sourceIds: ["ev_1"],
		},
		references: { datasetRefs: ["ds_4"], sourceIds: ["ev_1"], assetRefs: [] },
		invalid: [
			[
				"no sources",
				{
					companyName: "C",
					ticker: "6999",
					exchange: "TSE",
					country: "JP",
					productsOrServices: [],
					businessExposure: "e",
					sourceIds: [],
				},
			],
			[
				"missing exchange",
				{
					companyName: "C",
					ticker: "6999",
					country: "JP",
					productsOrServices: [],
					businessExposure: "e",
					sourceIds: ["ev_1"],
				},
			],
			[
				"unsupported country",
				{
					companyName: "C",
					ticker: "ABC",
					exchange: "LSE",
					country: "GB",
					productsOrServices: [],
					businessExposure: "e",
					sourceIds: ["ev_1"],
				},
			],
			[
				"lower-case ticker",
				{
					companyName: "C",
					ticker: "abc",
					exchange: "NASDAQ",
					country: "US",
					productsOrServices: [],
					businessExposure: "e",
					sourceIds: ["ev_1"],
				},
			],
		],
	},
	"image-gallery": {
		valid: {
			title: "Plants",
			images: [
				{ assetRef: "asset_1", caption: "Exterior" },
				{ assetRef: "asset_2", caption: null },
			],
		},
		references: { datasetRefs: [], sourceIds: [], assetRefs: ["asset_1", "asset_2"] },
		invalid: [
			["no images", { title: "Plants", images: [] }],
			[
				"a raw image URL",
				{ title: "Plants", images: [{ url: "https://x.example.org/a.png", caption: null }] },
			],
			[
				"an extra src next to the asset reference",
				{
					title: "Plants",
					images: [{ assetRef: "asset_1", caption: null, src: "https://x.example.org/a.png" }],
				},
			],
			[
				"too many images",
				{
					title: "Plants",
					images: Array.from({ length: 13 }, () => ({ assetRef: "asset_1", caption: null })),
				},
			],
		],
	},
	"research-report": {
		valid: {
			title: "Storage demand outlook",
			generatedAt: "2026-10-11T00:05:00Z",
			dataCutoffAt: "2026-10-11T00:00:00Z",
			sections: [
				{
					heading: "Demand",
					statements: [
						{
							text: "Installations rose.",
							claimId: "cl_1",
							claimType: "observation",
							status: "supported",
							sourceIds: ["ev_1"],
						},
						{
							text: "Growth may slow.",
							claimId: "cl_2",
							claimType: "hypothesis",
							status: "conflicting",
							sourceIds: ["ev_2", "ev_1"],
						},
						{
							text: "Section introduction.",
							claimId: null,
							claimType: null,
							status: null,
							sourceIds: [],
						},
					],
				},
			],
			disclaimer: "Research aid, not investment advice.",
		},
		references: {
			datasetRefs: [],
			sourceIds: ["ev_1", "ev_2", "ev_1"],
			assetRefs: [],
			claims: [
				{ claimId: "cl_1", status: "supported", claimType: "observation" },
				{ claimId: "cl_2", status: "conflicting", claimType: "hypothesis" },
			],
		},
		invalid: [
			[
				"a 'supported' badge with no claim behind it",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					dataCutoffAt: "2026-10-11T00:00:00Z",
					sections: [
						{
							heading: "H",
							statements: [
								{
									text: "Trust me.",
									claimId: null,
									claimType: "observation",
									status: "supported",
									sourceIds: [],
								},
							],
						},
					],
					disclaimer: "d",
				},
			],
			[
				"a claim id without the badge it should carry",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					dataCutoffAt: "2026-10-11T00:00:00Z",
					sections: [
						{
							heading: "H",
							statements: [
								{ text: "t", claimId: "cl_1", claimType: null, status: null, sourceIds: [] },
							],
						},
					],
					disclaimer: "d",
				},
			],
			[
				"no sections",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					dataCutoffAt: "2026-10-11T00:00:00Z",
					sections: [],
					disclaimer: "d",
				},
			],
			[
				"missing disclaimer",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					dataCutoffAt: "2026-10-11T00:00:00Z",
					sections: [{ heading: "H", statements: [] }],
				},
			],
			[
				"missing data cut-off",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					sections: [{ heading: "H", statements: [] }],
					disclaimer: "d",
				},
			],
			[
				"a statement with raw html",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					dataCutoffAt: "2026-10-11T00:00:00Z",
					sections: [
						{
							heading: "H",
							statements: [
								{
									text: "t",
									html: "<b>t</b>",
									claimId: null,
									claimType: null,
									status: null,
									sourceIds: [],
								},
							],
						},
					],
					disclaimer: "d",
				},
			],
			[
				"an unknown claim status",
				{
					title: "R",
					generatedAt: "2026-10-11T00:05:00Z",
					dataCutoffAt: "2026-10-11T00:00:00Z",
					sections: [
						{
							heading: "H",
							statements: [
								{ text: "t", claimType: "observation", status: "verified", sourceIds: [] },
							],
						},
					],
					disclaimer: "d",
				},
			],
		],
	},
};

describe("baseline component catalog", () => {
	it("registers exactly the ten V1 component types, each at schema version 1", () => {
		expect([...catalog.componentTypes()].sort()).toEqual([...BASELINE_TYPES].sort());
		for (const componentType of BASELINE_TYPES) {
			expect(catalog.currentSchemaVersion(componentType)).toBe(1);
		}
	});

	it("requires the owner permission and declares capabilities for every type", () => {
		for (const definition of BASELINE_COMPONENT_DEFINITIONS) {
			expect(definition.requiredPermission).toBe("owner");
			expect(definition.capabilities.length).toBeGreaterThan(0);
		}
	});

	it.each(
		BASELINE_TYPES,
	)("%s accepts its valid props fixture and reports its references", (type) => {
		const fixture = FIXTURES[type];
		const result = catalog.validateProps(type, 1, fixture.valid);
		expect(result).toEqual({
			ok: true,
			value: { props: fixture.valid, schemaVersion: 1, references: fixture.references },
		});
	});

	const invalidCases = BASELINE_TYPES.flatMap((type) =>
		FIXTURES[type].invalid.map(([label, props]) => ({ type, label, props })),
	);

	it.each(invalidCases)("$type rejects props with $label", ({ type, props }) => {
		expect(catalog.validateProps(type, 1, props)).toEqual({ ok: false, error: "INVALID_PROPS" });
	});

	it.each(BASELINE_TYPES)("%s rejects empty props and another type's props", (type) => {
		expect(catalog.validateProps(type, 1, {})).toEqual({ ok: false, error: "INVALID_PROPS" });
		const other = type === "news-card" ? "image-gallery" : "news-card";
		expect(catalog.validateProps(type, 1, FIXTURES[other].valid)).toEqual({
			ok: false,
			error: "INVALID_PROPS",
		});
	});

	it("returns normalized props (trimmed title) rather than the raw input", () => {
		const result = catalog.validateProps("source-list", 1, {
			title: "  Sources  ",
			sourceIds: ["ev_1"],
		});
		expect(result).toEqual({
			ok: true,
			value: {
				props: { title: "Sources", sourceIds: ["ev_1"] },
				schemaVersion: 1,
				references: { datasetRefs: [], sourceIds: ["ev_1"], assetRefs: [] },
			},
		});
	});

	it("reports no dataset reference for a company profile without a metrics table", () => {
		const { datasetRef: _omitted, ...withoutDataset } = FIXTURES["company-profile"].valid;
		const result = catalog.validateProps("company-profile", 1, withoutDataset);
		expect(result.ok && result.value.references.datasetRefs).toEqual([]);
	});

	it("validates the props of the section 7 example command", () => {
		const command = uiCommandSchema.parse(SECTION_7_EXAMPLE_COMMAND);
		if (command.operation !== "component.create") throw new Error("example must be a create");
		expect(
			catalog.validateProps(command.componentType, command.schemaVersion, command.props),
		).toEqual({
			ok: true,
			value: {
				props: command.props,
				schemaVersion: 1,
				references: { datasetRefs: ["dataset_20"], sourceIds: ["source_11"], assetRefs: [] },
			},
		});
	});
});

describe("exported props schemas", () => {
	const SCHEMAS: { readonly [T in BaselineType]: z.ZodType } = {
		"data-table": dataTablePropsSchema,
		"financial-table": financialTablePropsSchema,
		"line-chart": lineChartPropsSchema,
		"bar-chart": barChartPropsSchema,
		"candlestick-chart": candlestickChartPropsSchema,
		"news-card": newsCardPropsSchema,
		"source-list": sourceListPropsSchema,
		"company-profile": companyProfilePropsSchema,
		"image-gallery": imageGalleryPropsSchema,
		"research-report": researchReportPropsSchema,
	};

	it.each(
		BASELINE_TYPES,
	)("%s: the exported schema accepts the valid fixture and rejects the invalid ones", (type) => {
		expect(SCHEMAS[type].safeParse(FIXTURES[type].valid).success).toBe(true);
		for (const [label, props] of FIXTURES[type].invalid) {
			expect({ label, accepted: SCHEMAS[type].safeParse(props).success }).toEqual({
				label,
				accepted: false,
			});
		}
	});
});

describe("catalog fail-closed behaviour (ARCH-017 / SEC-007)", () => {
	const valid = FIXTURES["data-table"].valid;

	it.each([
		"iframe",
		"html",
		"script",
		"Data-Table",
		"data-table ",
		"",
		"constructor",
		"__proto__",
		"toString",
	])("rejects the unknown component type %j", (componentType) => {
		expect(catalog.validateProps(componentType, 1, valid)).toEqual({
			ok: false,
			error: "UNKNOWN_COMPONENT_TYPE",
		});
		expect(catalog.currentSchemaVersion(componentType)).toBeNull();
	});

	it.each([
		2,
		3,
		99,
		0,
		-1,
		1.5,
		0.5,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		Number.NaN,
	])("rejects schema version %s for a version-1 component", (schemaVersion) => {
		expect(catalog.validateProps("data-table", schemaVersion, valid)).toEqual({
			ok: false,
			error: "UNSUPPORTED_SCHEMA_VERSION",
		});
	});

	it("reports the unknown type ahead of the schema version", () => {
		expect(catalog.validateProps("iframe", 99, valid)).toEqual({
			ok: false,
			error: "UNKNOWN_COMPONENT_TYPE",
		});
	});

	it("refuses to build a catalog with duplicate component types", () => {
		const [first] = BASELINE_COMPONENT_DEFINITIONS;
		if (first === undefined) throw new Error("baseline definitions are empty");
		expect(() => createComponentCatalog([...BASELINE_COMPONENT_DEFINITIONS, first])).toThrow(
			/duplicate component type "data-table"/,
		);
	});

	it("an empty catalog knows no component types", () => {
		const empty = createComponentCatalog([]);
		expect(empty.componentTypes()).toEqual([]);
		expect(empty.validateProps("data-table", 1, valid)).toEqual({
			ok: false,
			error: "UNKNOWN_COMPONENT_TYPE",
		});
	});
});

/* ---------- Extension and migration (FR-013 / UI-008 / UI-010 / hard gate 9) ---------- */

/** Version 1 props, as old commands and stored workspaces carry them. */
const noteCardV1 = { heading: "Supply risk", sourceId: "ev_1" };
/** The same content in the current (version 2) shape. */
const noteCardV2 = { title: "Supply risk", sourceIds: ["ev_1"], emphasis: "normal" };

const noteCardPropsV2 = z.strictObject({
	title: shortTextSchema,
	sourceIds: z.array(idSchema).min(1).max(10),
	emphasis: z.enum(["normal", "strong"]),
});

/**
 * A test-only component at schema version 2. Version 1 had `heading` and a single
 * `sourceId`; the migration renames the former and wraps the latter, as a real
 * migration written against version-1 input would.
 */
const noteCard: ComponentDefinition = defineComponent({
	componentType: "test-note-card",
	schemaVersion: 2,
	propsSchema: noteCardPropsV2,
	capabilities: ["sources"],
	requiredPermission: "owner",
	references: (props) => ({ ...NO_REFERENCES, sourceIds: props.sourceIds }),
	migrations: {
		1: (props) => ({
			title: props.heading ?? null,
			sourceIds: props.sourceId === undefined ? [] : [props.sourceId],
			emphasis: "normal",
		}),
	},
});

const extended = createComponentCatalog([...BASELINE_COMPONENT_DEFINITIONS, noteCard]);

describe("schema migration", () => {
	it("migrates version-1 props to the current version and validates the result", () => {
		expect(extended.validateProps("test-note-card", 1, noteCardV1)).toEqual({
			ok: true,
			value: {
				props: noteCardV2,
				schemaVersion: 2,
				references: { datasetRefs: [], sourceIds: ["ev_1"], assetRefs: [] },
			},
		});
	});

	it("accepts current-version props without running the migration", () => {
		expect(extended.validateProps("test-note-card", 2, noteCardV2)).toEqual({
			ok: true,
			value: {
				props: noteCardV2,
				schemaVersion: 2,
				references: { datasetRefs: [], sourceIds: ["ev_1"], assetRefs: [] },
			},
		});
	});

	it("does not guess: version-1 props declared as version 2 are invalid", () => {
		expect(extended.validateProps("test-note-card", 2, noteCardV1)).toEqual({
			ok: false,
			error: "INVALID_PROPS",
		});
	});

	it("rejects props that are still invalid after migration", () => {
		expect(extended.validateProps("test-note-card", 1, { sourceId: "ev_1" })).toEqual({
			ok: false,
			error: "INVALID_PROPS",
		});
		expect(extended.validateProps("test-note-card", 1, { heading: "H" })).toEqual({
			ok: false,
			error: "INVALID_PROPS",
		});
	});

	it.each([
		3,
		0,
		-1,
		1.5,
		Number.NaN,
	])("rejects schema version %s, for which no migration exists", (version) => {
		expect(extended.validateProps("test-note-card", version, noteCardV2)).toEqual({
			ok: false,
			error: "UNSUPPORTED_SCHEMA_VERSION",
		});
	});

	it("reports the current schema version of the extension", () => {
		expect(extended.currentSchemaVersion("test-note-card")).toBe(2);
	});

	it("chains migrations across several versions", () => {
		const v3 = createComponentCatalog([
			defineComponent({
				componentType: "test-counter",
				schemaVersion: 3,
				propsSchema: z.strictObject({ label: z.string(), steps: z.array(z.string()) }),
				capabilities: ["selection"],
				requiredPermission: "owner",
				references: () => NO_REFERENCES,
				migrations: {
					1: (props) => ({ label: props.name ?? null, steps: ["1->2"] }),
					2: (props) => ({
						...props,
						steps: [...(Array.isArray(props.steps) ? props.steps : []), "2->3"],
					}),
				},
			}),
		]);
		expect(v3.validateProps("test-counter", 1, { name: "n" })).toEqual({
			ok: true,
			value: {
				props: { label: "n", steps: ["1->2", "2->3"] },
				schemaVersion: 3,
				references: NO_REFERENCES,
			},
		});
		expect(v3.validateProps("test-counter", 2, { label: "n", steps: [] })).toEqual({
			ok: true,
			value: {
				props: { label: "n", steps: ["2->3"] },
				schemaVersion: 3,
				references: NO_REFERENCES,
			},
		});
		expect(v3.validateProps("test-counter", 3, { label: "n", steps: [] })).toEqual({
			ok: true,
			value: {
				props: { label: "n", steps: [] },
				schemaVersion: 3,
				references: NO_REFERENCES,
			},
		});
	});

	it("rejects an old version when a step of the migration chain is missing", () => {
		const gap = createComponentCatalog([
			defineComponent({
				componentType: "test-gap",
				schemaVersion: 3,
				propsSchema: z.strictObject({ label: z.string() }),
				capabilities: ["selection"],
				requiredPermission: "owner",
				references: () => NO_REFERENCES,
				// Only 2 -> 3 exists; version 1 cannot be upgraded.
				migrations: { 2: (props) => props },
			}),
		]);
		expect(gap.validateProps("test-gap", 1, { label: "n" })).toEqual({
			ok: false,
			error: "UNSUPPORTED_SCHEMA_VERSION",
		});
		expect(gap.validateProps("test-gap", 2, { label: "n" }).ok).toBe(true);
	});
});

describe("registering an extension is independent of the baseline (FR-013 / hard gate 9)", () => {
	it("adds the new type without changing how baseline types validate", () => {
		expect(extended.componentTypes()).toEqual([...catalog.componentTypes(), "test-note-card"]);
		for (const type of BASELINE_TYPES) {
			expect(extended.validateProps(type, 1, FIXTURES[type].valid)).toEqual(
				catalog.validateProps(type, 1, FIXTURES[type].valid),
			);
		}
	});

	it("does not leak the extension into a catalog built without it", () => {
		expect(catalog.validateProps("test-note-card", 2, noteCardV2)).toEqual({
			ok: false,
			error: "UNKNOWN_COMPONENT_TYPE",
		});
	});
});

/* ---------- Catalog + reducer integration ---------- */

function commandContext(componentCatalog = catalog): CommandContext {
	return {
		validateProps: componentCatalog.validateProps,
		knownDatasetRefs: new Set(["dataset_20", "ds_1"]),
		knownSourceIds: new Set(["source_11", "ev_1", "ev_2"]),
		knownAssetRefs: new Set(["asset_1"]),
		knownClaims: new Map(),
		maxComponents: 40,
	};
}

function applyAll(
	operations: readonly UiOperation[],
	context: CommandContext,
): ReturnType<typeof applyUiCommand> {
	let state: WorkspaceState = emptyWorkspaceState("ws_1");
	let last: ReturnType<typeof applyUiCommand> = { ok: true, value: state };
	for (const [index, operation] of operations.entries()) {
		const command: UiCommand = {
			protocolVersion: UI_PROTOCOL_VERSION,
			commandId: `cmd_${index}`,
			workspaceId: state.workspaceId,
			expectedWorkspaceVersion: state.version,
			...operation,
		};
		last = applyUiCommand(state, command, context);
		if (!last.ok) return last;
		state = last.value;
	}
	return last;
}

describe("catalog used as the reducer's props validator", () => {
	it("applies the section 7 example command to a workspace at version 4", () => {
		const command = uiCommandSchema.parse(SECTION_7_EXAMPLE_COMMAND);
		const state: WorkspaceState = { ...emptyWorkspaceState("ws_1"), version: 4 };
		const result = applyUiCommand(state, command, commandContext());
		expect(result).toEqual({
			ok: true,
			value: {
				...state,
				version: 5,
				components: [
					{
						componentId: "demand_table_1",
						componentType: "data-table",
						schemaVersion: 1,
						props: {
							title: "Demand scenarios",
							datasetRef: "dataset_20",
							sourceIds: ["source_11"],
						},
					},
				],
				layout: { order: ["demand_table_1"], columns: 1 },
			},
		});
	});

	it("rejects binding a dataset to a component type that has no dataset slot", () => {
		const result = applyAll(
			[
				{
					operation: "component.create",
					componentId: "card",
					componentType: "news-card",
					schemaVersion: 1,
					props: FIXTURES["news-card"].valid,
				},
				{ operation: "dataset.bind", componentId: "card", datasetRef: "ds_1" },
			],
			commandContext(),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "INVALID_PROPS" } });
	});

	it("rejects a gallery image that is not an approved asset", () => {
		const result = applyAll(
			[
				{
					operation: "component.create",
					componentId: "gallery",
					componentType: "image-gallery",
					schemaVersion: 1,
					props: { title: "Plants", images: [{ assetRef: "asset_unapproved", caption: null }] },
				},
			],
			commandContext(),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_ASSET" } });
	});

	it("rejects a report statement citing a source that is not stored", () => {
		const report = FIXTURES["research-report"].valid;
		const result = applyAll(
			[
				{
					operation: "component.create",
					componentId: "report",
					componentType: "research-report",
					schemaVersion: 1,
					props: {
						...report,
						sections: [
							{
								heading: "Demand",
								statements: [
									{
										text: "Invented.",
										claimId: "cl_1",
										claimType: "observation",
										status: "supported",
										sourceIds: ["ev_fabricated"],
									},
								],
							},
						],
					},
				},
			],
			commandContext(),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_SOURCE" } });
	});

	it("stores a migrated component in a form that re-validates under its recorded schema version", () => {
		// Loading a workspace, rendering it and importing an export all re-validate each stored
		// component as (componentType, schemaVersion, props). Whatever the reducer records after a
		// migrating create must therefore pass the catalog again, without a second migration.
		const result = applyAll(
			[
				{
					operation: "component.create",
					componentId: "note",
					componentType: "test-note-card",
					schemaVersion: 1,
					props: noteCardV1,
				},
			],
			commandContext(extended),
		);
		if (!result.ok) throw new Error(`create was rejected: ${result.error.code}`);
		const [stored] = result.value.components;
		if (stored === undefined) throw new Error("the component was not stored");
		expect(
			extended.validateProps(stored.componentType, stored.schemaVersion, stored.props),
		).toMatchObject({ ok: true, value: { props: noteCardV2 } });
	});

	it("keeps a component created from a version-1 command updatable afterwards", () => {
		// The stored props are already in the version-2 shape. Updating them must not run the
		// 1 -> 2 migration a second time over version-2 data.
		const result = applyAll(
			[
				{
					operation: "component.create",
					componentId: "note",
					componentType: "test-note-card",
					schemaVersion: 1,
					props: noteCardV1,
				},
				{ operation: "component.update", componentId: "note", props: { emphasis: "strong" } },
			],
			commandContext(extended),
		);
		if (!result.ok) {
			throw new Error(`update of a migrated component was rejected: ${result.error.code}`);
		}
		expect(result.value.components[0]?.props).toEqual({ ...noteCardV2, emphasis: "strong" });
	});
});
