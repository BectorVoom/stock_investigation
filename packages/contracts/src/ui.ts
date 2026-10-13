import {
	type ComponentReferences,
	err,
	type JsonObject,
	NO_REFERENCES,
	ok,
	type PropsValidator,
	type Result,
	UI_PROTOCOL_VERSION,
	type UiCommand,
	type UiOperation,
	type WorkspaceComponent,
	type WorkspaceState,
} from "@research/domain";
import { z } from "zod";
import {
	idSchema,
	isoDateTimeSchema,
	jsonObjectSchema,
	marketSchema,
	shortTextSchema,
} from "./primitives.ts";
import { claimStatusSchema, claimTypeSchema } from "./records.ts";

/* ---------- UI command protocol (section 7) ---------- */

const componentIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/, "invalid component id");
const componentTypeSchema = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/, "invalid component type");

const navigationTargetSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("view"),
		view: z.enum(["workspace", "sources", "settings"]),
	}),
	z.strictObject({ kind: z.literal("evidence"), evidenceId: idSchema }),
]);

/** The operation part of a command, without the envelope the server stamps on runner output. */
export const uiOperationSchema = z.discriminatedUnion("operation", [
	z.strictObject({
		operation: z.literal("component.create"),
		componentId: componentIdSchema,
		componentType: componentTypeSchema,
		schemaVersion: z.number().int().positive(),
		props: jsonObjectSchema,
	}),
	z.strictObject({
		operation: z.literal("component.update"),
		componentId: componentIdSchema,
		props: jsonObjectSchema,
	}),
	z.strictObject({ operation: z.literal("component.remove"), componentId: componentIdSchema }),
	z.strictObject({ operation: z.literal("component.focus"), componentId: componentIdSchema }),
	z.strictObject({
		operation: z.literal("component.select"),
		componentId: componentIdSchema,
		itemKey: z.string().min(1).max(120).nullable(),
	}),
	z.strictObject({
		operation: z.literal("layout.update"),
		order: z.array(componentIdSchema).max(60),
		columns: z.union([z.literal(1), z.literal(2)]),
	}),
	z.strictObject({
		operation: z.literal("dataset.bind"),
		componentId: componentIdSchema,
		datasetRef: idSchema,
	}),
	z.strictObject({
		operation: z.literal("dataset.refresh"),
		datasetRef: idSchema,
		replacementDatasetRef: idSchema,
	}),
	z.strictObject({ operation: z.literal("navigation.open"), target: navigationTargetSchema }),
]) satisfies z.ZodType<UiOperation>;

const envelopeShape = {
	protocolVersion: z.literal(UI_PROTOCOL_VERSION),
	commandId: idSchema,
	workspaceId: idSchema,
	expectedWorkspaceVersion: z.number().int().nonnegative(),
};

/**
 * Full command = envelope + operation. Built per-operation (rather than as an
 * intersection) so unknown keys are rejected on the combined object.
 */
export const uiCommandSchema: z.ZodType<UiCommand> = z.discriminatedUnion(
	"operation",
	// The tuple shape of `options` is preserved by `map` only as an array; the cast-free
	// way to keep the discriminated-union typing is to extend each member explicitly.
	[
		uiOperationSchema.options[0].extend(envelopeShape),
		uiOperationSchema.options[1].extend(envelopeShape),
		uiOperationSchema.options[2].extend(envelopeShape),
		uiOperationSchema.options[3].extend(envelopeShape),
		uiOperationSchema.options[4].extend(envelopeShape),
		uiOperationSchema.options[5].extend(envelopeShape),
		uiOperationSchema.options[6].extend(envelopeShape),
		uiOperationSchema.options[7].extend(envelopeShape),
		uiOperationSchema.options[8].extend(envelopeShape),
	],
);

const workspaceComponentSchema = z.strictObject({
	componentId: componentIdSchema,
	componentType: componentTypeSchema,
	schemaVersion: z.number().int().positive(),
	props: jsonObjectSchema,
}) satisfies z.ZodType<WorkspaceComponent>;

/** Typed as the domain state (readonly arrays) so values flow both ways without casts. */
export const MAX_WORKSPACE_COMPONENTS = 40;

export const workspaceStateSchema: z.ZodType<WorkspaceState> = z
	.strictObject({
		workspaceId: idSchema,
		version: z.number().int().nonnegative(),
		components: z.array(workspaceComponentSchema).max(60),
		layout: z.strictObject({
			order: z.array(componentIdSchema).max(60),
			columns: z.union([z.literal(1), z.literal(2)]),
		}),
		focusedComponentId: componentIdSchema.nullable(),
		selection: z
			.strictObject({ componentId: componentIdSchema, itemKey: z.string().min(1).max(120) })
			.nullable(),
		lastNavigation: z
			.strictObject({ commandId: idSchema, target: navigationTargetSchema })
			.nullable(),
	})
	// The invariants the reducer maintains, enforced on any state that arrives from outside
	// (an import file, or a stored row): unique component ids, a layout that lists each exactly
	// once, and focus/selection that point at existing components.
	.superRefine((state, context) => {
		const ids = state.components.map((component) => component.componentId);
		const unique = new Set(ids);
		const fail = (message: string, path: string) =>
			context.addIssue({ code: "custom", message, path: [path] });
		if (unique.size !== ids.length) fail("component ids must be unique", "components");
		if (ids.length > MAX_WORKSPACE_COMPONENTS) {
			fail(`a workspace holds at most ${MAX_WORKSPACE_COMPONENTS} components`, "components");
		}
		const order = state.layout.order;
		if (
			order.length !== ids.length ||
			new Set(order).size !== order.length ||
			!order.every((id) => unique.has(id))
		) {
			fail("layout order must list every component exactly once", "layout");
		}
		if (state.focusedComponentId !== null && !unique.has(state.focusedComponentId)) {
			fail("focused component does not exist", "focusedComponentId");
		}
		if (state.selection !== null && !unique.has(state.selection.componentId)) {
			fail("selected component does not exist", "selection");
		}
	});

/* ---------- Component catalog (schema half of the registry) ---------- */

export type ComponentCapability = "dataset" | "sources" | "selection";

/**
 * Schema-side description of a component type. The Worker validates commands
 * with it; the SPA pairs it with a renderer in `@research/ui-registry`.
 */
export interface ComponentDefinition<Props extends JsonObject = JsonObject> {
	readonly componentType: string;
	/** Current props schema version. */
	readonly schemaVersion: number;
	readonly propsSchema: z.ZodType<Props>;
	readonly capabilities: readonly ComponentCapability[];
	/** Who may create/update this component. V1 has a single role. */
	readonly requiredPermission: "owner";
	readonly references: (props: Props) => ComponentReferences;
	/** `migrations[n]` upgrades props from schema version n to n + 1. */
	readonly migrations: { readonly [fromVersion: number]: (props: JsonObject) => JsonObject };
}

export interface ComponentCatalog {
	readonly validateProps: PropsValidator;
	readonly componentTypes: () => readonly string[];
	readonly currentSchemaVersion: (componentType: string) => number | null;
}

/** Type-erases a definition so heterogeneous definitions fit one list. */
export function defineComponent<Props extends JsonObject>(
	definition: ComponentDefinition<Props>,
): ComponentDefinition {
	return {
		...definition,
		references: (props) => {
			const parsed = definition.propsSchema.safeParse(props);
			return parsed.success ? definition.references(parsed.data) : NO_REFERENCES;
		},
	};
}

/**
 * Builds the validator the workspace reducer uses. Unknown types and schema
 * versions without a tested migration chain are rejected (ARCH-017 / SEC-007).
 */
export function createComponentCatalog(
	definitions: readonly ComponentDefinition[],
): ComponentCatalog {
	const byType = new Map<string, ComponentDefinition>();
	for (const definition of definitions) {
		if (byType.has(definition.componentType)) {
			throw new Error(`duplicate component type "${definition.componentType}"`);
		}
		byType.set(definition.componentType, definition);
	}

	const migrate = (
		definition: ComponentDefinition,
		fromVersion: number,
		props: JsonObject,
	): Result<JsonObject, "UNSUPPORTED_SCHEMA_VERSION"> => {
		// `Number.isInteger` also rejects NaN, which would otherwise slip past both comparisons.
		if (
			!Number.isInteger(fromVersion) ||
			fromVersion > definition.schemaVersion ||
			fromVersion < 1
		) {
			return err("UNSUPPORTED_SCHEMA_VERSION");
		}
		let current = props;
		for (let version = fromVersion; version < definition.schemaVersion; version += 1) {
			const step = definition.migrations[version];
			if (step === undefined) return err("UNSUPPORTED_SCHEMA_VERSION");
			current = step(current);
		}
		return ok(current);
	};

	return {
		validateProps: (componentType, schemaVersion, props) => {
			const definition = byType.get(componentType);
			if (definition === undefined) return err("UNKNOWN_COMPONENT_TYPE");
			const migrated = migrate(definition, schemaVersion, props);
			if (!migrated.ok) return migrated;
			const parsed = definition.propsSchema.safeParse(migrated.value);
			if (!parsed.success) return err("INVALID_PROPS");
			return ok({
				props: parsed.data,
				schemaVersion: definition.schemaVersion,
				references: definition.references(parsed.data),
			});
		},
		componentTypes: () => [...byType.keys()],
		currentSchemaVersion: (componentType) => byType.get(componentType)?.schemaVersion ?? null,
	};
}

/* ---------- V1 component props ---------- */

const titleSchema = shortTextSchema;
const sourceIdsSchema = z.array(idSchema).max(40);
const columnKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const axisLabelSchema = z.string().min(1).max(80);
const seriesSchema = z
	.array(z.strictObject({ key: columnKeySchema, label: z.string().min(1).max(80) }))
	.min(1)
	.max(8);

export const dataTablePropsSchema = z.strictObject({
	title: titleSchema,
	datasetRef: idSchema,
	sourceIds: sourceIdsSchema,
	caption: z.string().max(400).optional(),
});

export const financialTablePropsSchema = z.strictObject({
	title: titleSchema,
	datasetRef: idSchema,
	sourceIds: sourceIdsSchema,
	/** Shown under the table, e.g. accounting basis or the PER definition used. */
	methodologyNote: z.string().min(1).max(600),
});

export const lineChartPropsSchema = z.strictObject({
	title: titleSchema,
	datasetRef: idSchema,
	xKey: columnKeySchema,
	series: seriesSchema,
	xLabel: axisLabelSchema,
	yLabel: axisLabelSchema,
	yUnit: z.string().min(1).max(40),
	sourceIds: sourceIdsSchema,
});

export const barChartPropsSchema = z.strictObject({
	title: titleSchema,
	datasetRef: idSchema,
	categoryKey: columnKeySchema,
	series: seriesSchema,
	xLabel: axisLabelSchema,
	yLabel: axisLabelSchema,
	yUnit: z.string().min(1).max(40),
	sourceIds: sourceIdsSchema,
});

export const candlestickChartPropsSchema = z.strictObject({
	title: titleSchema,
	datasetRef: idSchema,
	dateKey: columnKeySchema,
	openKey: columnKeySchema,
	highKey: columnKeySchema,
	lowKey: columnKeySchema,
	closeKey: columnKeySchema,
	priceUnit: z.string().min(1).max(40),
	sourceIds: sourceIdsSchema,
});

export const newsCardPropsSchema = z.strictObject({
	headline: z.string().min(1).max(300),
	/** The stored evidence this card presents; its URL and dates come from that record. */
	sourceId: idSchema,
	summary: z.string().max(500).nullable(),
});

export const sourceListPropsSchema = z.strictObject({
	title: titleSchema,
	sourceIds: sourceIdsSchema.min(1),
});

export const companyProfilePropsSchema = z.strictObject({
	companyName: shortTextSchema,
	ticker: z.string().regex(/^[A-Z0-9.-]{1,12}$/),
	exchange: z.string().min(1).max(20),
	country: marketSchema,
	productsOrServices: z.array(shortTextSchema).max(12),
	businessExposure: z.string().min(1).max(1000),
	/** Optional metrics table (PER, margin, positions) rendered inside the profile. */
	datasetRef: idSchema.optional(),
	sourceIds: sourceIdsSchema.min(1),
});

export const researchReportPropsSchema = z.strictObject({
	title: titleSchema,
	generatedAt: isoDateTimeSchema,
	/** Data cut-off: nothing retrieved after this instant informed the report. */
	dataCutoffAt: isoDateTimeSchema,
	sections: z
		.array(
			z.strictObject({
				heading: z.string().min(1).max(160),
				statements: z
					.array(
						z
							.strictObject({
								text: z.string().min(1).max(1000),
								/**
								 * The stored claim this statement presents. Null marks a free-form note,
								 * which carries no verification badge at all.
								 */
								claimId: idSchema.nullable(),
								claimType: claimTypeSchema.nullable(),
								status: claimStatusSchema.nullable(),
								sourceIds: sourceIdsSchema,
							})
							// A type/status badge exists exactly when a stored claim backs it; the server
							// then checks both against that claim (see ComponentReferences.claims).
							.refine(
								(statement) =>
									(statement.claimId === null) === (statement.status === null) &&
									(statement.claimId === null) === (statement.claimType === null),
								{ message: "claimType and status require a claimId, and vice versa" },
							),
					)
					.max(40),
			}),
		)
		.min(1)
		.max(12),
	disclaimer: z.string().min(1).max(600),
});

const datasetAndSources = (props: {
	readonly datasetRef: string;
	readonly sourceIds: readonly string[];
}): ComponentReferences => ({
	datasetRefs: [props.datasetRef],
	sourceIds: props.sourceIds,
});

const chartCapabilities = ["dataset", "sources"] as const;

/** The nine V1 component types. Extensions append their own definitions at the composition roots. */
export const BASELINE_COMPONENT_DEFINITIONS: readonly ComponentDefinition[] = [
	defineComponent({
		componentType: "data-table",
		schemaVersion: 1,
		propsSchema: dataTablePropsSchema,
		capabilities: ["dataset", "sources", "selection"],
		requiredPermission: "owner",
		references: datasetAndSources,
		migrations: {},
	}),
	defineComponent({
		componentType: "financial-table",
		schemaVersion: 1,
		propsSchema: financialTablePropsSchema,
		capabilities: ["dataset", "sources", "selection"],
		requiredPermission: "owner",
		references: datasetAndSources,
		migrations: {},
	}),
	defineComponent({
		componentType: "line-chart",
		schemaVersion: 1,
		propsSchema: lineChartPropsSchema,
		capabilities: chartCapabilities,
		requiredPermission: "owner",
		references: datasetAndSources,
		migrations: {},
	}),
	defineComponent({
		componentType: "bar-chart",
		schemaVersion: 1,
		propsSchema: barChartPropsSchema,
		capabilities: chartCapabilities,
		requiredPermission: "owner",
		references: datasetAndSources,
		migrations: {},
	}),
	defineComponent({
		componentType: "candlestick-chart",
		schemaVersion: 1,
		propsSchema: candlestickChartPropsSchema,
		capabilities: chartCapabilities,
		requiredPermission: "owner",
		references: datasetAndSources,
		migrations: {},
	}),
	defineComponent({
		componentType: "news-card",
		schemaVersion: 1,
		propsSchema: newsCardPropsSchema,
		capabilities: ["sources"],
		requiredPermission: "owner",
		references: (props) => ({ ...NO_REFERENCES, sourceIds: [props.sourceId] }),
		migrations: {},
	}),
	defineComponent({
		componentType: "source-list",
		schemaVersion: 1,
		propsSchema: sourceListPropsSchema,
		capabilities: ["sources"],
		requiredPermission: "owner",
		references: (props) => ({ ...NO_REFERENCES, sourceIds: props.sourceIds }),
		migrations: {},
	}),
	defineComponent({
		componentType: "company-profile",
		schemaVersion: 1,
		propsSchema: companyProfilePropsSchema,
		capabilities: ["dataset", "sources"],
		requiredPermission: "owner",
		references: (props) => ({
			datasetRefs: props.datasetRef === undefined ? [] : [props.datasetRef],
			sourceIds: props.sourceIds,
		}),
		migrations: {},
	}),
	defineComponent({
		componentType: "research-report",
		schemaVersion: 1,
		propsSchema: researchReportPropsSchema,
		capabilities: ["sources"],
		requiredPermission: "owner",
		references: (props) => {
			const statements = props.sections.flatMap((section) => section.statements);
			return {
				...NO_REFERENCES,
				sourceIds: statements.flatMap((statement) => statement.sourceIds),
				claims: statements.flatMap((statement) =>
					statement.claimId === null || statement.status === null || statement.claimType === null
						? []
						: [
								{
									claimId: statement.claimId,
									status: statement.status,
									claimType: statement.claimType,
								},
							],
				),
			};
		},
		migrations: {},
	}),
];

export type DataTableProps = z.infer<typeof dataTablePropsSchema>;
export type FinancialTableProps = z.infer<typeof financialTablePropsSchema>;
export type LineChartProps = z.infer<typeof lineChartPropsSchema>;
export type BarChartProps = z.infer<typeof barChartPropsSchema>;
export type CandlestickChartProps = z.infer<typeof candlestickChartPropsSchema>;
export type NewsCardProps = z.infer<typeof newsCardPropsSchema>;
export type SourceListProps = z.infer<typeof sourceListPropsSchema>;
export type CompanyProfileProps = z.infer<typeof companyProfilePropsSchema>;
export type ResearchReportProps = z.infer<typeof researchReportPropsSchema>;
