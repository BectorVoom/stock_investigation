import type { JsonObject } from "../json.ts";

export const UI_PROTOCOL_VERSION = 1;

export interface WorkspaceComponent {
	readonly componentId: string;
	readonly componentType: string;
	readonly schemaVersion: number;
	readonly props: JsonObject;
}

export interface WorkspaceLayout {
	/** Every component id exactly once, in display order. */
	readonly order: readonly string[];
	readonly columns: 1 | 2;
}

export type NavigationTarget =
	| { readonly kind: "view"; readonly view: "workspace" | "sources" | "settings" }
	| { readonly kind: "evidence"; readonly evidenceId: string };

export interface WorkspaceState {
	readonly workspaceId: string;
	/** Monotonic; incremented by exactly one per applied command. */
	readonly version: number;
	readonly components: readonly WorkspaceComponent[];
	readonly layout: WorkspaceLayout;
	readonly focusedComponentId: string | null;
	readonly selection: { readonly componentId: string; readonly itemKey: string } | null;
	readonly lastNavigation: {
		readonly commandId: string;
		readonly target: NavigationTarget;
	} | null;
}

export interface UiCommandEnvelope {
	readonly protocolVersion: number;
	readonly commandId: string;
	readonly workspaceId: string;
	readonly expectedWorkspaceVersion: number;
}

export type UiOperation =
	| {
			readonly operation: "component.create";
			readonly componentId: string;
			readonly componentType: string;
			readonly schemaVersion: number;
			readonly props: JsonObject;
	  }
	/** `props` is a shallow patch merged over the stored props, then revalidated as a whole. */
	| {
			readonly operation: "component.update";
			readonly componentId: string;
			readonly props: JsonObject;
	  }
	| { readonly operation: "component.remove"; readonly componentId: string }
	| { readonly operation: "component.focus"; readonly componentId: string }
	| {
			readonly operation: "component.select";
			readonly componentId: string;
			readonly itemKey: string | null;
	  }
	| {
			readonly operation: "layout.update";
			readonly order: readonly string[];
			readonly columns: 1 | 2;
	  }
	| {
			readonly operation: "dataset.bind";
			readonly componentId: string;
			readonly datasetRef: string;
	  }
	/** Re-points every component bound to `datasetRef` at an immutable successor snapshot. */
	| {
			readonly operation: "dataset.refresh";
			readonly datasetRef: string;
			readonly replacementDatasetRef: string;
	  }
	| { readonly operation: "navigation.open"; readonly target: NavigationTarget };

export type UiCommand = UiCommandEnvelope & UiOperation;

export type UiOperationName = UiOperation["operation"];

export function emptyWorkspaceState(workspaceId: string): WorkspaceState {
	return {
		workspaceId,
		version: 0,
		components: [],
		layout: { order: [], columns: 1 },
		focusedComponentId: null,
		selection: null,
		lastNavigation: null,
	};
}
