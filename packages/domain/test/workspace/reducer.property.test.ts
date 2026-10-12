import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JsonObject } from "../../src/json.ts";
import { applyUiCommand } from "../../src/workspace/reducer.ts";
import {
	emptyWorkspaceState,
	UI_PROTOCOL_VERSION,
	type UiCommand,
	type UiOperation,
	type WorkspaceState,
} from "../../src/workspace/types.ts";
import { deepFreeze } from "../support/deepFreeze.ts";
import { context, KNOWN_DATASETS, KNOWN_SOURCES, WORKSPACE_ID } from "./support.ts";

/**
 * An abstract intent. `pick` values are resolved against the state the command
 * will meet, so every generated sequence is valid by construction.
 */
type Intent =
	| {
			readonly kind: "create";
			readonly dataset: string | null;
			readonly sources: readonly string[];
	  }
	| { readonly kind: "update"; readonly pick: number; readonly title: string }
	| { readonly kind: "remove"; readonly pick: number }
	| { readonly kind: "focus"; readonly pick: number }
	| { readonly kind: "select"; readonly pick: number; readonly itemKey: string | null }
	| { readonly kind: "layout"; readonly keys: readonly number[]; readonly columns: 1 | 2 }
	| { readonly kind: "bind"; readonly pick: number; readonly dataset: string }
	| { readonly kind: "refresh"; readonly pick: number; readonly dataset: string }
	| { readonly kind: "navigate"; readonly evidence: string | null };

const dataset = fc.constantFrom(...KNOWN_DATASETS);
const pick = fc.nat({ max: 1000 });

const intent: fc.Arbitrary<Intent> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant("create" as const),
			dataset: fc.option(dataset, { nil: null }),
			sources: fc.subarray([...KNOWN_SOURCES]),
		}),
	},
	fc.record({
		kind: fc.constant("update" as const),
		pick,
		title: fc.string({ minLength: 1, maxLength: 12 }),
	}),
	fc.record({ kind: fc.constant("remove" as const), pick }),
	fc.record({ kind: fc.constant("focus" as const), pick }),
	fc.record({
		kind: fc.constant("select" as const),
		pick,
		itemKey: fc.option(fc.constantFrom("row_1", "row_2"), { nil: null }),
	}),
	fc.record({
		kind: fc.constant("layout" as const),
		keys: fc.array(fc.nat(), { minLength: 12, maxLength: 12 }),
		columns: fc.constantFrom<1 | 2>(1, 2),
	}),
	fc.record({ kind: fc.constant("bind" as const), pick, dataset }),
	fc.record({ kind: fc.constant("refresh" as const), pick, dataset }),
	fc.record({
		kind: fc.constant("navigate" as const),
		evidence: fc.option(fc.constantFrom(...KNOWN_SOURCES), { nil: null }),
	}),
);

const MAX_COMPONENTS = 12;

/** Turns an intent into a concrete operation that is valid for `state`, or null if none applies. */
function resolve(state: WorkspaceState, wanted: Intent, serial: number): UiOperation | null {
	const ids = state.components.map((component) => component.componentId);
	const chosen = (index: number): string | undefined => ids[index % Math.max(1, ids.length)];
	switch (wanted.kind) {
		case "create": {
			if (ids.length >= MAX_COMPONENTS) return null;
			return {
				operation: "component.create",
				componentId: `c${serial}`,
				componentType: "panel",
				schemaVersion: 1,
				props: {
					title: `Panel ${serial}`,
					sourceIds: wanted.sources,
					...(wanted.dataset === null ? {} : { datasetRef: wanted.dataset }),
				},
			};
		}
		case "layout": {
			const order = ids
				.map((id, index) => ({ id, key: wanted.keys[index] ?? 0 }))
				.sort((a, b) => a.key - b.key || a.id.localeCompare(b.id))
				.map((entry) => entry.id);
			return { operation: "layout.update", order, columns: wanted.columns };
		}
		case "navigate":
			return {
				operation: "navigation.open",
				target:
					wanted.evidence === null
						? { kind: "view", view: "workspace" }
						: { kind: "evidence", evidenceId: wanted.evidence },
			};
		default: {
			const componentId = chosen(wanted.pick);
			if (componentId === undefined) return null;
			switch (wanted.kind) {
				case "update":
					return { operation: "component.update", componentId, props: { title: wanted.title } };
				case "remove":
					return { operation: "component.remove", componentId };
				case "focus":
					return { operation: "component.focus", componentId };
				case "select":
					return { operation: "component.select", componentId, itemKey: wanted.itemKey };
				case "bind":
					return { operation: "dataset.bind", componentId, datasetRef: wanted.dataset };
				case "refresh": {
					const bound = state.components.find((component) => component.componentId === componentId)
						?.props.datasetRef;
					if (typeof bound !== "string") return null;
					return {
						operation: "dataset.refresh",
						datasetRef: bound,
						replacementDatasetRef: wanted.dataset,
					};
				}
			}
		}
	}
}

function envelope(state: WorkspaceState, operation: UiOperation, serial: number): UiCommand {
	return {
		protocolVersion: UI_PROTOCOL_VERSION,
		commandId: `cmd_${serial}`,
		workspaceId: state.workspaceId,
		expectedWorkspaceVersion: state.version,
		...operation,
	};
}

function assertInvariants(state: WorkspaceState): void {
	const ids = state.components.map((component) => component.componentId);
	expect(new Set(ids).size).toBe(ids.length);
	expect([...state.layout.order].sort()).toEqual([...ids].sort());
	expect(ids.length).toBeLessThanOrEqual(MAX_COMPONENTS);
	if (state.focusedComponentId !== null) expect(ids).toContain(state.focusedComponentId);
	if (state.selection !== null) expect(ids).toContain(state.selection.componentId);
	for (const component of state.components) {
		const ref = component.props.datasetRef;
		if (ref !== undefined) expect(KNOWN_DATASETS).toContain(ref);
	}
}

interface Run {
	readonly state: WorkspaceState;
	readonly applied: number;
}

function run(intents: readonly Intent[]): Run {
	const ctx = context({ maxComponents: MAX_COMPONENTS });
	let state = deepFreeze(emptyWorkspaceState(WORKSPACE_ID));
	let applied = 0;
	intents.forEach((wanted, serial) => {
		const operation = resolve(state, wanted, serial);
		if (operation === null) return;
		const result = applyUiCommand(state, deepFreeze(envelope(state, operation, serial)), ctx);
		if (!result.ok) {
			throw new Error(
				`valid ${operation.operation} was rejected: ${result.error.code} (${result.error.detail})`,
			);
		}
		expect(result.value.version).toBe(state.version + 1);
		state = deepFreeze(result.value);
		applied += 1;
		assertInvariants(state);
	});
	return { state, applied };
}

describe("applyUiCommand properties", () => {
	it("valid command sequences keep the layout a permutation of the component ids", () => {
		fc.assert(
			fc.property(fc.array(intent, { maxLength: 40 }), (intents) => {
				const { state, applied } = run(intents);
				expect(state.version).toBe(applied);
				assertInvariants(state);
			}),
			{ numRuns: 300 },
		);
	});

	it("the version always equals the number of applied commands", () => {
		fc.assert(
			fc.property(fc.array(intent, { maxLength: 40 }), (intents) => {
				const { state, applied } = run(intents);
				expect(state.version).toBe(applied);
				expect(state.workspaceId).toBe(WORKSPACE_ID);
			}),
			{ numRuns: 300 },
		);
	});

	it("is deterministic: replaying the same sequence from scratch gives the same state", () => {
		fc.assert(
			fc.property(fc.array(intent, { maxLength: 30 }), (intents) => {
				expect(run(intents).state).toEqual(run(intents).state);
			}),
			{ numRuns: 150 },
		);
	});

	/** Operations that are frequently invalid for the state they meet. */
	const hostileId = fc.constantFrom(
		"c0",
		"c1",
		"c2",
		"c3",
		"ghost",
		"",
		"__proto__",
		"constructor",
	);
	const hostileOperation: fc.Arbitrary<UiOperation> = fc.oneof(
		fc.record({
			operation: fc.constant("component.create" as const),
			componentId: hostileId,
			componentType: fc.constantFrom("panel", "note", "iframe", "script"),
			schemaVersion: fc.constantFrom(0, 1, 2),
			props: fc.oneof<fc.Arbitrary<JsonObject>[]>(
				fc.constant({ title: "ok" }),
				fc.constant({}),
				fc.constant({ title: 7 }),
				fc.record({
					title: fc.constant("ok"),
					datasetRef: fc.constantFrom("ds_1", "ds_stolen"),
					sourceIds: fc.subarray(["src_1", "src_fabricated"]),
					assetRefs: fc.subarray(["asset_1", "asset_unapproved"]),
				}),
			),
		}),
		fc.record({
			operation: fc.constant("component.update" as const),
			componentId: hostileId,
			props: fc.constantFrom<JsonObject>(
				{ title: "" },
				{ title: "x" },
				{ datasetRef: "ds_stolen" },
				{},
			),
		}),
		fc.record({ operation: fc.constant("component.remove" as const), componentId: hostileId }),
		fc.record({ operation: fc.constant("component.focus" as const), componentId: hostileId }),
		fc.record({
			operation: fc.constant("component.select" as const),
			componentId: hostileId,
			itemKey: fc.option(fc.constant("k"), { nil: null }),
		}),
		fc.record({
			operation: fc.constant("layout.update" as const),
			order: fc.array(hostileId, { maxLength: 5 }),
			columns: fc.constantFrom<1 | 2>(1, 2),
		}),
		fc.record({
			operation: fc.constant("dataset.bind" as const),
			componentId: hostileId,
			datasetRef: fc.constantFrom("ds_1", "ds_stolen"),
		}),
		fc.record({
			operation: fc.constant("dataset.refresh" as const),
			datasetRef: fc.constantFrom("ds_1", "ds_2", "ds_stolen"),
			replacementDatasetRef: fc.constantFrom("ds_3", "ds_stolen"),
		}),
		fc.record({
			operation: fc.constant("navigation.open" as const),
			target: fc.record({
				kind: fc.constant("evidence" as const),
				evidenceId: fc.constantFrom("ev_9", "ev_fabricated"),
			}),
		}),
	);

	it("a rejected command leaves the state deep-equal, and an accepted one keeps every invariant", () => {
		fc.assert(
			fc.property(
				fc.array(intent, { maxLength: 15 }),
				hostileOperation,
				fc.record({
					versionOffset: fc.constantFrom(0, 0, 0, -1, 1),
					workspaceId: fc.constantFrom(WORKSPACE_ID, WORKSPACE_ID, "ws_other"),
					protocolVersion: fc.constantFrom(UI_PROTOCOL_VERSION, UI_PROTOCOL_VERSION, 2),
				}),
				(intents, operation, tamper) => {
					const { state } = run(intents);
					const snapshot = structuredClone(state);
					const command: UiCommand = deepFreeze({
						protocolVersion: tamper.protocolVersion,
						commandId: "cmd_hostile",
						workspaceId: tamper.workspaceId,
						expectedWorkspaceVersion: state.version + tamper.versionOffset,
						...operation,
					});
					const result = applyUiCommand(state, command, context({ maxComponents: MAX_COMPONENTS }));
					// `state` is frozen: a mutating reducer would have thrown before reaching here.
					expect(state).toEqual(snapshot);
					if (result.ok) {
						expect(tamper).toEqual({
							versionOffset: 0,
							workspaceId: WORKSPACE_ID,
							protocolVersion: UI_PROTOCOL_VERSION,
						});
						expect(result.value.version).toBe(state.version + 1);
						assertInvariants(result.value);
						// Nothing the owner does not hold may ever be referenced by accepted state.
						const serialized = JSON.stringify(result.value);
						for (const forbidden of [
							"ds_stolen",
							"src_fabricated",
							"asset_unapproved",
							"ev_fabricated",
						]) {
							expect(serialized).not.toContain(forbidden);
						}
					} else {
						expect(result.error.detail.length).toBeGreaterThan(0);
					}
				},
			),
			{ numRuns: 600 },
		);
	});

	it("never accepts a command whose expected version is not the current version", () => {
		fc.assert(
			fc.property(
				fc.array(intent, { maxLength: 15 }),
				fc.integer({ min: -5, max: 5 }).filter((offset) => offset !== 0),
				(intents, offset) => {
					const { state } = run(intents);
					const command: UiCommand = {
						protocolVersion: UI_PROTOCOL_VERSION,
						commandId: "cmd_stale",
						workspaceId: state.workspaceId,
						expectedWorkspaceVersion: state.version + offset,
						operation: "navigation.open",
						target: { kind: "view", view: "workspace" },
					};
					expect(applyUiCommand(state, command, context())).toMatchObject({
						ok: false,
						error: { code: "VERSION_CONFLICT" },
					});
				},
			),
			{ numRuns: 200 },
		);
	});
});
