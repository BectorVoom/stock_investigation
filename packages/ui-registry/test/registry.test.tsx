import {
	BASELINE_COMPONENT_DEFINITIONS,
	dataTablePropsSchema,
	effortSchema,
	financialTablePropsSchema,
	shortTextSchema,
	sourceListPropsSchema,
} from "@research/contracts";
import { cleanup } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import {
	BASELINE_REGISTRY_ENTRIES,
	createUiRegistry,
	defineRegistryEntry,
	pairDefinitionWithRenderer,
	SourceList,
} from "../src/index.ts";
import { BASELINE_TYPES, component, VALID_PROPS } from "./fixtures.ts";
import { expectOnlySafeLinks, renderComponent } from "./helpers.tsx";

afterEach(cleanup);

describe("baseline registry", () => {
	it("pairs every baseline component definition with a renderer, and nothing else", () => {
		const definedTypes = BASELINE_COMPONENT_DEFINITIONS.map(
			(definition) => definition.componentType,
		);
		const registeredTypes = BASELINE_REGISTRY_ENTRIES.map(
			(entry) => entry.definition.componentType,
		);
		expect(registeredTypes).toEqual(definedTypes);
		expect([...registeredTypes].sort()).toEqual([...BASELINE_TYPES].sort());
		for (const entry of BASELINE_REGISTRY_ENTRIES) {
			expect(BASELINE_COMPONENT_DEFINITIONS).toContain(entry.definition);
		}
	});

	it("exposes the same schema catalog the server validates with", () => {
		const registry = createUiRegistry(BASELINE_REGISTRY_ENTRIES);
		expect([...registry.catalog.componentTypes()].sort()).toEqual([...BASELINE_TYPES].sort());
		expect(registry.catalog.currentSchemaVersion("data-table")).toBe(1);
		expect(registry.catalog.currentSchemaVersion("nope")).toBeNull();
		expect(registry.rendererFor("nope")).toBeNull();
		expect(registry.rendererFor("line-chart")).not.toBeNull();
	});

	it("rejects a duplicate component type at composition time", () => {
		const [first] = BASELINE_REGISTRY_ENTRIES;
		if (first === undefined) throw new Error("baseline registry is empty");
		expect(() => createUiRegistry([...BASELINE_REGISTRY_ENTRIES, first])).toThrow(/duplicate/);
	});

	it("refuses to pair a definition with a schema it does not validate with", () => {
		const dataTable = BASELINE_COMPONENT_DEFINITIONS.find(
			(definition) => definition.componentType === "data-table",
		);
		if (dataTable === undefined) throw new Error("data-table definition missing");
		expect(() =>
			pairDefinitionWithRenderer(dataTable, financialTablePropsSchema, () => null),
		).toThrow(/not the definition's schema/);
		expect(() =>
			pairDefinitionWithRenderer(dataTable, dataTablePropsSchema, () => null),
		).not.toThrow();
	});
});

describe("fail-closed fallbacks", () => {
	it("renders a fallback for an unknown component type", () => {
		const container = renderComponent(component("hologram-view", { title: "x" }));
		const fallback = container.querySelector('[data-fallback="UNKNOWN_COMPONENT_TYPE"]');
		expect(fallback?.textContent).toContain("Cannot render: unknown component type");
		expect(fallback?.textContent).toContain("hologram-view");
	});

	it("renders a fallback for a schema version with no migration", () => {
		const container = renderComponent(
			component("data-table", VALID_PROPS["data-table"], { schemaVersion: 7 }),
		);
		const fallback = container.querySelector('[data-fallback="UNSUPPORTED_SCHEMA_VERSION"]');
		expect(fallback?.textContent).toContain("Cannot render: unsupported schema version");
		expect(fallback?.textContent).toContain("schema version 7");
		expect(container.querySelector("table")).toBeNull();
	});

	it("contains a renderer that throws instead of breaking the page", () => {
		const exploding = defineRegistryEntry(
			{
				componentType: "exploding-widget",
				schemaVersion: 1,
				propsSchema: sourceListPropsSchema,
				capabilities: ["sources"],
				requiredPermission: "owner",
				references: (props) => ({ datasetRefs: [], sourceIds: props.sourceIds }),
				migrations: {},
			},
			() => {
				throw new Error("renderer bug");
			},
		);
		const container = renderComponent(
			component("exploding-widget", VALID_PROPS["source-list"]),
			{},
			createUiRegistry([...BASELINE_REGISTRY_ENTRIES, exploding]),
		);
		expect(container.querySelector('[data-fallback="RENDERER_FAILED"]')).not.toBeNull();
	});
});

/**
 * UI-010 / FR-013 / hard gate 9: a made-up component type is added with one
 * registry entry (schema + renderer). `WorkspaceComponentView`, the catalog and
 * the baseline entries are untouched.
 */
describe("registry extension", () => {
	const metricCalloutPropsSchema = sourceListPropsSchema.extend({
		value: shortTextSchema,
		emphasis: effortSchema,
	});

	const metricCallout = defineRegistryEntry(
		{
			componentType: "metric-callout",
			schemaVersion: 2,
			propsSchema: metricCalloutPropsSchema,
			capabilities: ["sources"],
			requiredPermission: "owner",
			references: (props) => ({ datasetRefs: [], sourceIds: props.sourceIds }),
			// v1 had no `emphasis`; the tested migration supplies the default.
			migrations: { 1: (props) => ({ ...props, emphasis: "medium" }) },
		},
		(renderer) => (
			<div>
				<h3>{renderer.props.title}</h3>
				<p data-emphasis={renderer.props.emphasis}>{renderer.props.value}</p>
				<SourceList sourceIds={renderer.props.sourceIds} sources={renderer.context.sources} />
			</div>
		),
	);
	const extended = createUiRegistry([...BASELINE_REGISTRY_ENTRIES, metricCallout]);
	const calloutProps = {
		title: "Order backlog",
		value: "¥12bn",
		emphasis: "high",
		sourceIds: ["ev_a"],
	};

	it("renders the extra component type through the unchanged view", () => {
		const container = renderComponent(
			component("metric-callout", calloutProps, { schemaVersion: 2 }),
			{},
			extended,
		);
		expect(container.querySelector("[data-fallback]")).toBeNull();
		expect(container.querySelector("article")?.getAttribute("data-component-type")).toBe(
			"metric-callout",
		);
		expect(container.querySelector("h3")?.textContent).toBe("Order backlog");
		expect(container.querySelector('[data-emphasis="high"]')?.textContent).toBe("¥12bn");
		expect(expectOnlySafeLinks(container)).toHaveLength(1);
	});

	it("still renders every baseline type from the extended registry", () => {
		for (const componentType of BASELINE_TYPES) {
			const container = renderComponent(
				component(componentType, VALID_PROPS[componentType]),
				{},
				extended,
			);
			expect(container.querySelector("[data-fallback]")).toBeNull();
			cleanup();
		}
	});

	it("migrates stored v1 props through the entry's migration before rendering", () => {
		const container = renderComponent(
			component("metric-callout", { title: "Order backlog", value: "¥12bn", sourceIds: ["ev_a"] }),
			{},
			extended,
		);
		expect(container.querySelector('[data-emphasis="medium"]')?.textContent).toBe("¥12bn");
	});

	it("re-validates props with the extension's own schema", () => {
		const container = renderComponent(
			component("metric-callout", { ...calloutProps, emphasis: "extreme" }, { schemaVersion: 2 }),
			{},
			extended,
		);
		expect(container.querySelector('[data-fallback="INVALID_PROPS"]')).not.toBeNull();
	});

	it("is unknown to a registry that was not given the entry", () => {
		const container = renderComponent(
			component("metric-callout", calloutProps, { schemaVersion: 2 }),
		);
		expect(container.querySelector('[data-fallback="UNKNOWN_COMPONENT_TYPE"]')).not.toBeNull();
	});
});
