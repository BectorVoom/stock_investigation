import type { JsonObject, JsonValue } from "../../src/json.ts";
import { err, ok } from "../../src/result.ts";
import type {
	CommandContext,
	ComponentReferences,
	PropsValidator,
} from "../../src/workspace/reducer.ts";
import {
	UI_PROTOCOL_VERSION,
	type UiCommand,
	type UiOperation,
	type WorkspaceState,
} from "../../src/workspace/types.ts";

export const WORKSPACE_ID = "ws_1";

function strings(value: JsonValue | undefined): readonly string[] {
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string");
	return [];
}

/**
 * A stand-in component registry, deliberately independent of `@research/contracts`:
 * - "panel" needs a string `title`; may carry `datasetRef`, `sourceIds`.
 * - "note" needs a string `title` and rejects `datasetRef` (it cannot be bound to data).
 * Only schema version 1 exists.
 */
export const validateProps: PropsValidator = (componentType, schemaVersion, props) => {
	if (componentType !== "panel" && componentType !== "note") return err("UNKNOWN_COMPONENT_TYPE");
	if (schemaVersion !== 1) return err("UNSUPPORTED_SCHEMA_VERSION");
	if (typeof props.title !== "string" || props.title === "") return err("INVALID_PROPS");
	if (componentType === "note" && props.datasetRef !== undefined) return err("INVALID_PROPS");
	const references: ComponentReferences = {
		datasetRefs: strings(props.datasetRef),
		sourceIds: strings(props.sourceIds),
	};
	return ok({ props, schemaVersion, references });
};

export const KNOWN_DATASETS = ["ds_1", "ds_2", "ds_3"] as const;
export const KNOWN_SOURCES = ["src_1", "src_2", "ev_9"] as const;

export function context(overrides: Partial<CommandContext> = {}): CommandContext {
	return {
		validateProps,
		knownDatasetRefs: new Set(KNOWN_DATASETS),
		knownSourceIds: new Set(KNOWN_SOURCES),
		knownClaims: new Map(),
		maxComponents: 40,
		...overrides,
	};
}

let commandCounter = 0;

/** Wraps an operation in an envelope that targets `state` at its current version. */
export function commandFor(
	state: WorkspaceState,
	operation: UiOperation,
	envelope: Partial<Omit<UiCommand, "operation">> = {},
): UiCommand {
	commandCounter += 1;
	return {
		protocolVersion: UI_PROTOCOL_VERSION,
		commandId: `cmd_${commandCounter}`,
		workspaceId: state.workspaceId,
		expectedWorkspaceVersion: state.version,
		...envelope,
		...operation,
	};
}

export function createPanel(componentId: string, props: JsonObject = {}): UiOperation {
	return {
		operation: "component.create",
		componentId,
		componentType: "panel",
		schemaVersion: 1,
		props: { title: `Panel ${componentId}`, ...props },
	};
}
