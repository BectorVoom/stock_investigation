import type { JsonObject } from "../json.ts";
import { err, ok, type Result } from "../result.ts";
import {
	UI_PROTOCOL_VERSION,
	type UiCommand,
	type WorkspaceComponent,
	type WorkspaceState,
} from "./types.ts";

/** Ids a component's props point at; each must resolve to something the owner already stores. */
export interface ComponentReferences {
	readonly datasetRefs: readonly string[];
	readonly sourceIds: readonly string[];
	readonly assetRefs: readonly string[];
	/**
	 * Verification results the props display. Each must equal the stored claim's
	 * own status and type, so props can never award a claim a badge it did not earn.
	 */
	readonly claims?: readonly ClaimReference[];
}

/** A claim as some component's props present it. */
export interface ClaimReference {
	readonly claimId: string;
	readonly status: string;
	readonly claimType: string;
}

/** Stored verification result of claims the owner holds. A `Map` satisfies it. */
export interface ClaimLookup {
	get(claimId: string): { readonly status: string; readonly claimType: string } | undefined;
}

export const NO_REFERENCES: ComponentReferences = { datasetRefs: [], sourceIds: [], assetRefs: [] };

export type PropsRejection =
	| "UNKNOWN_COMPONENT_TYPE"
	| "UNSUPPORTED_SCHEMA_VERSION"
	| "INVALID_PROPS";

export interface ValidatedProps {
	/** Props in the form of `schemaVersion` (already migrated if an older version was submitted). */
	readonly props: JsonObject;
	/** The schema version `props` conform to; this is what must be stored with them. */
	readonly schemaVersion: number;
	readonly references: ComponentReferences;
}

/** Supplied by the component registry; the reducer itself knows no component types (ARCH-006). */
export type PropsValidator = (
	componentType: string,
	schemaVersion: number,
	props: JsonObject,
) => Result<ValidatedProps, PropsRejection>;

export type UiCommandErrorCode =
	| "PROTOCOL_VERSION_UNSUPPORTED"
	| "WORKSPACE_MISMATCH"
	| "VERSION_CONFLICT"
	| "COMPONENT_EXISTS"
	| "COMPONENT_NOT_FOUND"
	| "TOO_MANY_COMPONENTS"
	| "LAYOUT_MISMATCH"
	| "DATASET_NOT_BOUND"
	| "UNKNOWN_DATASET"
	| "UNKNOWN_SOURCE"
	| "UNKNOWN_ASSET"
	| "UNKNOWN_EVIDENCE"
	| "UNKNOWN_CLAIM"
	| "CLAIM_MISMATCH"
	| PropsRejection;

export interface UiCommandError {
	readonly code: UiCommandErrorCode;
	readonly detail: string;
}

/** Membership test for ids the owner stores. A `Set` satisfies it. */
export interface IdLookup {
	has(id: string): boolean;
}

export interface CommandContext {
	readonly validateProps: PropsValidator;
	readonly knownDatasetRefs: IdLookup;
	/** Evidence ids the owner stores; props `sourceIds` and evidence navigation must be in it. */
	readonly knownSourceIds: IdLookup;
	readonly knownAssetRefs: IdLookup;
	/** Claims the owner stores, with the status and type verification gave them. */
	readonly knownClaims: ClaimLookup;
	readonly maxComponents: number;
}

function fail(code: UiCommandErrorCode, detail: string): Result<never, UiCommandError> {
	return err({ code, detail });
}

function findComponent(state: WorkspaceState, componentId: string): WorkspaceComponent | undefined {
	return state.components.find((component) => component.componentId === componentId);
}

interface Prepared {
	readonly nextState: WorkspaceState;
	readonly references: ComponentReferences;
}

function mergeReferences(all: readonly ComponentReferences[]): ComponentReferences {
	const claims = all.flatMap((refs) => refs.claims ?? []);
	return {
		datasetRefs: all.flatMap((refs) => refs.datasetRefs),
		sourceIds: all.flatMap((refs) => refs.sourceIds),
		assetRefs: all.flatMap((refs) => refs.assetRefs),
		...(claims.length === 0 ? {} : { claims }),
	};
}

function replaceComponent(state: WorkspaceState, next: WorkspaceComponent): WorkspaceState {
	return {
		...state,
		components: state.components.map((component) =>
			component.componentId === next.componentId ? next : component,
		),
	};
}

function revalidate(
	component: WorkspaceComponent,
	props: JsonObject,
	validateProps: PropsValidator,
): Result<{ component: WorkspaceComponent; references: ComponentReferences }, UiCommandError> {
	const validated = validateProps(component.componentType, component.schemaVersion, props);
	if (!validated.ok) {
		return fail(validated.error, `props rejected for component "${component.componentId}"`);
	}
	return ok({
		component: {
			...component,
			schemaVersion: validated.value.schemaVersion,
			props: validated.value.props,
		},
		references: validated.value.references,
	});
}

/** Computes the post-command state without checking that referenced ids exist. */
function prepare(
	state: WorkspaceState,
	command: UiCommand,
	validateProps: PropsValidator,
	maxComponents: number,
): Result<Prepared, UiCommandError> {
	switch (command.operation) {
		case "component.create": {
			if (findComponent(state, command.componentId) !== undefined) {
				return fail("COMPONENT_EXISTS", `component "${command.componentId}" already exists`);
			}
			if (state.components.length >= maxComponents) {
				return fail("TOO_MANY_COMPONENTS", `workspace is limited to ${maxComponents} components`);
			}
			const validated = validateProps(command.componentType, command.schemaVersion, command.props);
			if (!validated.ok) {
				return fail(
					validated.error,
					`props rejected for component type "${command.componentType}"`,
				);
			}
			const component: WorkspaceComponent = {
				componentId: command.componentId,
				componentType: command.componentType,
				// Store the version the props were migrated to, not the one the command arrived in;
				// otherwise the next revalidation would migrate already-migrated props again.
				schemaVersion: validated.value.schemaVersion,
				props: validated.value.props,
			};
			return ok({
				nextState: {
					...state,
					components: [...state.components, component],
					layout: { ...state.layout, order: [...state.layout.order, component.componentId] },
				},
				references: validated.value.references,
			});
		}
		case "component.update":
		case "dataset.bind": {
			const existing = findComponent(state, command.componentId);
			if (existing === undefined) {
				return fail("COMPONENT_NOT_FOUND", `component "${command.componentId}" does not exist`);
			}
			const patch: JsonObject =
				command.operation === "dataset.bind" ? { datasetRef: command.datasetRef } : command.props;
			const next = revalidate(existing, { ...existing.props, ...patch }, validateProps);
			if (!next.ok) return next;
			return ok({
				nextState: replaceComponent(state, next.value.component),
				references: next.value.references,
			});
		}
		case "dataset.refresh": {
			const bound = state.components.filter(
				(component) => component.props.datasetRef === command.datasetRef,
			);
			if (bound.length === 0) {
				return fail("DATASET_NOT_BOUND", `no component is bound to "${command.datasetRef}"`);
			}
			let nextState = state;
			const references: ComponentReferences[] = [];
			for (const component of bound) {
				const next = revalidate(
					component,
					{ ...component.props, datasetRef: command.replacementDatasetRef },
					validateProps,
				);
				if (!next.ok) return next;
				nextState = replaceComponent(nextState, next.value.component);
				references.push(next.value.references);
			}
			return ok({ nextState, references: mergeReferences(references) });
		}
		case "component.remove": {
			if (findComponent(state, command.componentId) === undefined) {
				return fail("COMPONENT_NOT_FOUND", `component "${command.componentId}" does not exist`);
			}
			const isRemoved = (id: string) => id === command.componentId;
			return ok({
				nextState: {
					...state,
					components: state.components.filter((component) => !isRemoved(component.componentId)),
					layout: { ...state.layout, order: state.layout.order.filter((id) => !isRemoved(id)) },
					focusedComponentId:
						state.focusedComponentId === command.componentId ? null : state.focusedComponentId,
					selection: state.selection?.componentId === command.componentId ? null : state.selection,
				},
				references: NO_REFERENCES,
			});
		}
		case "component.focus":
		case "component.select": {
			if (findComponent(state, command.componentId) === undefined) {
				return fail("COMPONENT_NOT_FOUND", `component "${command.componentId}" does not exist`);
			}
			if (command.operation === "component.focus") {
				return ok({
					nextState: { ...state, focusedComponentId: command.componentId },
					references: NO_REFERENCES,
				});
			}
			return ok({
				nextState: {
					...state,
					selection:
						command.itemKey === null
							? null
							: { componentId: command.componentId, itemKey: command.itemKey },
				},
				references: NO_REFERENCES,
			});
		}
		case "layout.update": {
			const current = new Set(state.components.map((component) => component.componentId));
			const proposed = new Set(command.order);
			const isPermutation =
				proposed.size === command.order.length &&
				proposed.size === current.size &&
				command.order.every((id) => current.has(id));
			if (!isPermutation) {
				return fail("LAYOUT_MISMATCH", "layout order must list every component exactly once");
			}
			return ok({
				nextState: { ...state, layout: { order: [...command.order], columns: command.columns } },
				references: NO_REFERENCES,
			});
		}
		case "navigation.open":
			return ok({
				nextState: {
					...state,
					lastNavigation: { commandId: command.commandId, target: command.target },
				},
				references:
					command.target.kind === "evidence"
						? { ...NO_REFERENCES, sourceIds: [command.target.evidenceId] }
						: NO_REFERENCES,
			});
	}
}

function checkEnvelope(state: WorkspaceState, command: UiCommand): Result<void, UiCommandError> {
	if (command.protocolVersion !== UI_PROTOCOL_VERSION) {
		return fail(
			"PROTOCOL_VERSION_UNSUPPORTED",
			`protocol version ${command.protocolVersion} is not supported`,
		);
	}
	if (command.workspaceId !== state.workspaceId) {
		return fail("WORKSPACE_MISMATCH", "command targets a different workspace");
	}
	if (command.expectedWorkspaceVersion !== state.version) {
		return fail(
			"VERSION_CONFLICT",
			`expected version ${command.expectedWorkspaceVersion}, workspace is at ${state.version}`,
		);
	}
	return ok(undefined);
}

/**
 * Ids the command would make the workspace depend on. The application layer
 * resolves these against storage (owner-scoped) before calling `applyUiCommand`.
 */
export function resolveCommandReferences(
	state: WorkspaceState,
	command: UiCommand,
	validateProps: PropsValidator,
): Result<ComponentReferences, UiCommandError> {
	const envelope = checkEnvelope(state, command);
	if (!envelope.ok) return envelope;
	const prepared = prepare(state, command, validateProps, Number.MAX_SAFE_INTEGER);
	return prepared.ok ? ok(prepared.value.references) : prepared;
}

/**
 * Pure, total transition for one UI command (UI-004/UI-006). Either returns the
 * next state at `version + 1` or a typed rejection; the input state is never mutated.
 */
export function applyUiCommand(
	state: WorkspaceState,
	command: UiCommand,
	context: CommandContext,
): Result<WorkspaceState, UiCommandError> {
	const envelope = checkEnvelope(state, command);
	if (!envelope.ok) return envelope;
	const prepared = prepare(state, command, context.validateProps, context.maxComponents);
	if (!prepared.ok) return prepared;
	const { references, nextState } = prepared.value;
	const unknownDataset = references.datasetRefs.find((ref) => !context.knownDatasetRefs.has(ref));
	if (unknownDataset !== undefined) {
		return fail("UNKNOWN_DATASET", `dataset "${unknownDataset}" is not available to this owner`);
	}
	const unknownSource = references.sourceIds.find((id) => !context.knownSourceIds.has(id));
	if (unknownSource !== undefined) {
		return command.operation === "navigation.open"
			? fail("UNKNOWN_EVIDENCE", `evidence "${unknownSource}" is not stored`)
			: fail("UNKNOWN_SOURCE", `source "${unknownSource}" is not stored`);
	}
	const unknownAsset = references.assetRefs.find((ref) => !context.knownAssetRefs.has(ref));
	if (unknownAsset !== undefined) {
		return fail("UNKNOWN_ASSET", `asset "${unknownAsset}" is not an approved asset`);
	}
	for (const presented of references.claims ?? []) {
		const stored = context.knownClaims.get(presented.claimId);
		if (stored === undefined) {
			return fail("UNKNOWN_CLAIM", `claim "${presented.claimId}" is not stored`);
		}
		if (stored.status !== presented.status || stored.claimType !== presented.claimType) {
			return fail(
				"CLAIM_MISMATCH",
				`claim "${presented.claimId}" is ${stored.claimType}/${stored.status}, not as presented`,
			);
		}
	}
	return ok({ ...nextState, version: state.version + 1 });
}
