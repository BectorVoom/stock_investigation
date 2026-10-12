import {
	type ApprovedAsset,
	type ComponentCatalog,
	type ComponentDefinition,
	createComponentCatalog,
	type Dataset,
	defineComponent,
	type Evidence,
	type WorkspaceView,
} from "@research/contracts";
import { type Component, createMemo, Show } from "solid-js";
import { CannotRender } from "./parts/states.tsx";

export type WorkspaceState = WorkspaceView["state"];
export type WorkspaceComponent = WorkspaceState["components"][number];
export type JsonObject = WorkspaceComponent["props"];
export type PropsRejection =
	| "UNKNOWN_COMPONENT_TYPE"
	| "UNSUPPORTED_SCHEMA_VERSION"
	| "INVALID_PROPS";

/**
 * Everything a renderer may read. Renderers resolve dataset, source and asset
 * ids against these maps only: an id that is absent is rendered as unavailable,
 * never guessed (DATA-011).
 */
export interface RenderContext {
	readonly datasets: ReadonlyMap<string, Dataset>;
	readonly sources: ReadonlyMap<string, Evidence>;
	readonly assets: ReadonlyMap<string, ApprovedAsset>;
	readonly selection: WorkspaceState["selection"];
	/** `itemKey` null clears the selection. */
	readonly onSelect: (componentId: string, itemKey: string | null) => void;
}

export interface RendererProps<Props> {
	readonly componentId: string;
	readonly props: Props;
	readonly context: RenderContext;
}

export type ComponentRenderer<Props> = Component<RendererProps<Props>>;

/**
 * A contracts `ComponentDefinition` paired with its Solid renderer. The
 * renderer stored here is type-erased: it re-validates the raw props with the
 * entry's own schema (the frontend trust boundary, section 7) and only then
 * calls the typed renderer.
 */
export interface ComponentRegistryEntry {
	readonly definition: ComponentDefinition;
	readonly renderer: ComponentRenderer<JsonObject>;
}

type PropsSchema<Props extends JsonObject> = ComponentDefinition<Props>["propsSchema"];

function validatingRenderer<Props extends JsonObject>(
	componentType: string,
	propsSchema: PropsSchema<Props>,
	Renderer: ComponentRenderer<Props>,
): ComponentRenderer<JsonObject> {
	return (erased) => {
		const validProps = createMemo((): Props | null => {
			const parsed = propsSchema.safeParse(erased.props);
			return parsed.success ? parsed.data : null;
		});
		return (
			<Show
				when={validProps()}
				fallback={<CannotRender reason="INVALID_PROPS" componentType={componentType} />}
			>
				{(props) => (
					<Renderer componentId={erased.componentId} props={props()} context={erased.context} />
				)}
			</Show>
		);
	};
}

/** Registers a new component type: typed definition + typed renderer (UI-010). */
export function defineRegistryEntry<Props extends JsonObject>(
	definition: ComponentDefinition<Props>,
	renderer: ComponentRenderer<Props>,
): ComponentRegistryEntry {
	return {
		definition: defineComponent(definition),
		renderer: validatingRenderer(definition.componentType, definition.propsSchema, renderer),
	};
}

/**
 * Pairs an already type-erased definition (e.g. one of
 * `BASELINE_COMPONENT_DEFINITIONS`) with a typed renderer. The typed schema
 * must be the very schema object the definition validates with, so the
 * renderer's props type cannot drift from what the server accepted.
 */
export function pairDefinitionWithRenderer<Props extends JsonObject>(
	definition: ComponentDefinition,
	propsSchema: PropsSchema<Props>,
	renderer: ComponentRenderer<Props>,
): ComponentRegistryEntry {
	if (definition.propsSchema !== propsSchema) {
		throw new Error(
			`props schema passed for "${definition.componentType}" is not the definition's schema`,
		);
	}
	return {
		definition,
		renderer: validatingRenderer(definition.componentType, propsSchema, renderer),
	};
}

export type ResolvedComponent =
	| {
			readonly ok: true;
			readonly renderer: ComponentRenderer<JsonObject>;
			readonly props: JsonObject;
	  }
	| { readonly ok: false; readonly reason: PropsRejection };

export interface UiRegistry {
	/** Schema half, identical to what the Worker validates commands with. */
	readonly catalog: ComponentCatalog;
	readonly rendererFor: (componentType: string) => ComponentRenderer<JsonObject> | null;
	/** Migrates + validates stored props and finds the renderer; fails closed (ARCH-017). */
	readonly resolve: (component: WorkspaceComponent) => ResolvedComponent;
}

export function createUiRegistry(entries: readonly ComponentRegistryEntry[]): UiRegistry {
	// Throws on duplicate component types, so a bad composition root fails at start-up.
	const catalog = createComponentCatalog(entries.map((entry) => entry.definition));
	const renderers = new Map(
		entries.map((entry) => [entry.definition.componentType, entry.renderer] as const),
	);
	const rendererFor = (componentType: string) => renderers.get(componentType) ?? null;
	return {
		catalog,
		rendererFor,
		resolve: (component) => {
			const validated = catalog.validateProps(
				component.componentType,
				component.schemaVersion,
				component.props,
			);
			if (!validated.ok) return { ok: false, reason: validated.error };
			const renderer = rendererFor(component.componentType);
			if (renderer === null) return { ok: false, reason: "UNKNOWN_COMPONENT_TYPE" };
			return { ok: true, renderer, props: validated.value.props };
		},
	};
}
