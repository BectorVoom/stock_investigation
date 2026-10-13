import { describe, expect, it } from "vitest";
import type { Result } from "../../src/result.ts";
import {
	applyUiCommand,
	type CommandContext,
	NO_REFERENCES,
	resolveCommandReferences,
	type UiCommandError,
	type UiCommandErrorCode,
} from "../../src/workspace/reducer.ts";
import {
	emptyWorkspaceState,
	UI_PROTOCOL_VERSION,
	type UiOperation,
	type WorkspaceState,
} from "../../src/workspace/types.ts";
import { deepFreeze } from "../support/deepFreeze.ts";
import { expectOk } from "../support/result.ts";
import { commandFor, context, createPanel, validateProps, WORKSPACE_ID } from "./support.ts";

/** Applies operations in order against frozen inputs; throws if any is rejected. */
function build(
	operations: readonly UiOperation[],
	ctx: CommandContext = context(),
): WorkspaceState {
	let state = deepFreeze(emptyWorkspaceState(WORKSPACE_ID));
	for (const operation of operations) {
		state = deepFreeze(
			expectOk(applyUiCommand(state, deepFreeze(commandFor(state, operation)), ctx)),
		);
	}
	return state;
}

function apply(
	state: WorkspaceState,
	operation: UiOperation,
	ctx: CommandContext = context(),
): Result<WorkspaceState, UiCommandError> {
	return applyUiCommand(state, deepFreeze(commandFor(state, operation)), ctx);
}

function expectRejected(
	result: Result<WorkspaceState, UiCommandError>,
	code: UiCommandErrorCode,
): UiCommandError {
	if (result.ok) throw new Error(`expected ${code}, but the command was applied`);
	expect(result.error.code).toBe(code);
	expect(result.error.detail).not.toBe("");
	return result.error;
}

const threePanels = (): WorkspaceState =>
	build([
		createPanel("a", { datasetRef: "ds_1", sourceIds: ["src_1"] }),
		createPanel("b", { datasetRef: "ds_1" }),
		createPanel("c", { datasetRef: "ds_2" }),
	]);

describe("emptyWorkspaceState", () => {
	it("starts at version 0 with nothing in it", () => {
		expect(emptyWorkspaceState("ws_9")).toEqual({
			workspaceId: "ws_9",
			version: 0,
			components: [],
			layout: { order: [], columns: 1 },
			focusedComponentId: null,
			selection: null,
			lastNavigation: null,
		});
	});
});

describe("applyUiCommand envelope checks (UI-006)", () => {
	const state = build([createPanel("a")]);

	it("rejects an unsupported protocol version", () => {
		const command = commandFor(state, createPanel("b"), {
			protocolVersion: UI_PROTOCOL_VERSION + 1,
		});
		expectRejected(applyUiCommand(state, command, context()), "PROTOCOL_VERSION_UNSUPPORTED");
	});

	it("rejects a command addressed to another workspace", () => {
		const command = commandFor(state, createPanel("b"), { workspaceId: "ws_other" });
		expectRejected(applyUiCommand(state, command, context()), "WORKSPACE_MISMATCH");
	});

	it.each([0, 2, 99])("rejects expected version %i when the workspace is at 1", (expected) => {
		const command = commandFor(state, createPanel("b"), { expectedWorkspaceVersion: expected });
		const error = expectRejected(applyUiCommand(state, command, context()), "VERSION_CONFLICT");
		expect(error.detail).toContain(String(expected));
	});

	it("checks the envelope before the operation", () => {
		// Both the version and the operation are wrong; the stale version must win.
		const command = commandFor(
			state,
			{ operation: "component.remove", componentId: "missing" },
			{ expectedWorkspaceVersion: 0 },
		);
		expectRejected(applyUiCommand(state, command, context()), "VERSION_CONFLICT");
	});

	it("a replayed command (same expected version) cannot be applied twice", () => {
		const start = build([]);
		const command = deepFreeze(commandFor(start, createPanel("a")));
		const once = expectOk(applyUiCommand(start, command, context()));
		expectRejected(applyUiCommand(once, command, context()), "VERSION_CONFLICT");
		expect(once.components).toHaveLength(1);
	});
});

describe("component.create", () => {
	it("appends the component and its layout slot and bumps the version by exactly one", () => {
		const empty = build([]);
		const next = expectOk(apply(empty, createPanel("a", { datasetRef: "ds_1" })));
		expect(next).toEqual({
			workspaceId: WORKSPACE_ID,
			version: 1,
			components: [
				{
					componentId: "a",
					componentType: "panel",
					schemaVersion: 1,
					props: { title: "Panel a", datasetRef: "ds_1" },
				},
			],
			layout: { order: ["a"], columns: 1 },
			focusedComponentId: null,
			selection: null,
			lastNavigation: null,
		});
	});

	it("leaves the input state untouched", () => {
		const empty = build([]);
		const before = structuredClone(empty);
		expectOk(apply(empty, createPanel("a")));
		expect(empty).toEqual(before);
	});

	it("keeps creation order in the layout", () => {
		expect(threePanels().layout.order).toEqual(["a", "b", "c"]);
		expect(threePanels().version).toBe(3);
	});

	it("rejects a duplicate component id", () => {
		expectRejected(apply(threePanels(), createPanel("b")), "COMPONENT_EXISTS");
	});

	it("rejects creation beyond the component limit", () => {
		const ctx = context({ maxComponents: 3 });
		const error = expectRejected(
			apply(threePanels(), createPanel("d"), ctx),
			"TOO_MANY_COMPONENTS",
		);
		expect(error.detail).toContain("3");
	});

	it("allows creation up to the component limit", () => {
		expect(apply(threePanels(), createPanel("d"), context({ maxComponents: 4 })).ok).toBe(true);
	});

	it("rejects an unknown component type (ARCH-017)", () => {
		expectRejected(
			apply(build([]), {
				operation: "component.create",
				componentId: "x",
				componentType: "iframe",
				schemaVersion: 1,
				props: { title: "t" },
			}),
			"UNKNOWN_COMPONENT_TYPE",
		);
	});

	it("rejects an unsupported schema version (SEC-007)", () => {
		expectRejected(
			apply(build([]), {
				operation: "component.create",
				componentId: "x",
				componentType: "panel",
				schemaVersion: 2,
				props: { title: "t" },
			}),
			"UNSUPPORTED_SCHEMA_VERSION",
		);
	});

	it("rejects invalid props", () => {
		expectRejected(
			apply(build([]), {
				operation: "component.create",
				componentId: "x",
				componentType: "panel",
				schemaVersion: 1,
				props: { title: 42 },
			}),
			"INVALID_PROPS",
		);
	});

	it("rejects a dataset the owner does not have", () => {
		const error = expectRejected(
			apply(build([]), createPanel("x", { datasetRef: "ds_foreign" })),
			"UNKNOWN_DATASET",
		);
		expect(error.detail).toContain("ds_foreign");
	});

	it("rejects a source that is not stored", () => {
		const error = expectRejected(
			apply(build([]), createPanel("x", { sourceIds: ["src_1", "src_invented"] })),
			"UNKNOWN_SOURCE",
		);
		expect(error.detail).toContain("src_invented");
	});

	it("stores the props returned by the validator, not the raw command props", () => {
		const normalizing: CommandContext = context({
			validateProps: (_type, version, props) => ({
				ok: true,
				value: {
					props: { ...props, normalized: true },
					schemaVersion: version,
					references: NO_REFERENCES,
				},
			}),
		});
		const next = expectOk(apply(build([]), createPanel("a"), normalizing));
		expect(next.components[0]?.props).toEqual({ title: "Panel a", normalized: true });
	});
});

describe("component.update", () => {
	it("shallow-merges the patch over the stored props and revalidates", () => {
		const state = threePanels();
		const next = expectOk(
			apply(state, {
				operation: "component.update",
				componentId: "a",
				props: { title: "Renamed", caption: "new" },
			}),
		);
		expect(next.components[0]).toEqual({
			componentId: "a",
			componentType: "panel",
			schemaVersion: 1,
			props: { title: "Renamed", datasetRef: "ds_1", sourceIds: ["src_1"], caption: "new" },
		});
		expect(next.components.slice(1)).toEqual(state.components.slice(1));
		expect(next.layout).toEqual(state.layout);
		expect(next.version).toBe(state.version + 1);
	});

	it("rejects an update to a missing component", () => {
		expectRejected(
			apply(threePanels(), { operation: "component.update", componentId: "zz", props: {} }),
			"COMPONENT_NOT_FOUND",
		);
	});

	it("rejects a patch that makes the merged props invalid", () => {
		expectRejected(
			apply(threePanels(), {
				operation: "component.update",
				componentId: "a",
				props: { title: "" },
			}),
			"INVALID_PROPS",
		);
	});

	it("checks references introduced by the patch", () => {
		const state = threePanels();
		const update = (props: { readonly [key: string]: string | readonly string[] }) =>
			apply(state, { operation: "component.update", componentId: "a", props });
		expectRejected(update({ datasetRef: "ds_foreign" }), "UNKNOWN_DATASET");
		expectRejected(update({ sourceIds: ["src_invented"] }), "UNKNOWN_SOURCE");
	});

	it("re-checks references the component already had", () => {
		// The source was deleted after the component was created.
		const ctx = context({ knownSourceIds: new Set(["src_2"]) });
		expectRejected(
			apply(threePanels(), { operation: "component.update", componentId: "a", props: {} }, ctx),
			"UNKNOWN_SOURCE",
		);
	});
});

describe("component.remove", () => {
	it("removes the component and its layout slot", () => {
		const next = expectOk(
			apply(threePanels(), { operation: "component.remove", componentId: "b" }),
		);
		expect(next.components.map((component) => component.componentId)).toEqual(["a", "c"]);
		expect(next.layout.order).toEqual(["a", "c"]);
		expect(next.version).toBe(4);
	});

	it("clears focus and selection that pointed at the removed component", () => {
		const state = build([
			createPanel("a"),
			createPanel("b"),
			{ operation: "component.focus", componentId: "b" },
			{ operation: "component.select", componentId: "b", itemKey: "row_3" },
		]);
		const next = expectOk(apply(state, { operation: "component.remove", componentId: "b" }));
		expect(next.focusedComponentId).toBeNull();
		expect(next.selection).toBeNull();
	});

	it("keeps focus and selection that point at other components", () => {
		const state = build([
			createPanel("a"),
			createPanel("b"),
			{ operation: "component.focus", componentId: "a" },
			{ operation: "component.select", componentId: "a", itemKey: "row_3" },
		]);
		const next = expectOk(apply(state, { operation: "component.remove", componentId: "b" }));
		expect(next.focusedComponentId).toBe("a");
		expect(next.selection).toEqual({ componentId: "a", itemKey: "row_3" });
	});

	it("rejects removing a missing component, including a second removal", () => {
		const state = threePanels();
		expectRejected(
			apply(state, { operation: "component.remove", componentId: "zz" }),
			"COMPONENT_NOT_FOUND",
		);
		const once = expectOk(apply(state, { operation: "component.remove", componentId: "a" }));
		expectRejected(
			apply(once, { operation: "component.remove", componentId: "a" }),
			"COMPONENT_NOT_FOUND",
		);
	});

	it("does not require the removed component's references to still exist", () => {
		const ctx = context({
			knownDatasetRefs: new Set(),
			knownSourceIds: new Set(),
		});
		expect(apply(threePanels(), { operation: "component.remove", componentId: "a" }, ctx).ok).toBe(
			true,
		);
	});
});

describe("component.focus and component.select", () => {
	it("focuses an existing component", () => {
		const next = expectOk(apply(threePanels(), { operation: "component.focus", componentId: "c" }));
		expect(next.focusedComponentId).toBe("c");
		expect(next.version).toBe(4);
		expect(next.components).toEqual(threePanels().components);
	});

	it("rejects focusing a missing component", () => {
		expectRejected(
			apply(threePanels(), { operation: "component.focus", componentId: "zz" }),
			"COMPONENT_NOT_FOUND",
		);
	});

	it("selects an item within a component", () => {
		const next = expectOk(
			apply(threePanels(), { operation: "component.select", componentId: "b", itemKey: "row_7" }),
		);
		expect(next.selection).toEqual({ componentId: "b", itemKey: "row_7" });
		expect(next.focusedComponentId).toBeNull();
	});

	it("clears the selection with a null item key", () => {
		const selected = build([
			createPanel("a"),
			{ operation: "component.select", componentId: "a", itemKey: "row_7" },
		]);
		const next = expectOk(
			apply(selected, { operation: "component.select", componentId: "a", itemKey: null }),
		);
		expect(next.selection).toBeNull();
		expect(next.version).toBe(selected.version + 1);
	});

	it("rejects selecting within a missing component", () => {
		expectRejected(
			apply(threePanels(), { operation: "component.select", componentId: "zz", itemKey: "k" }),
			"COMPONENT_NOT_FOUND",
		);
		expectRejected(
			apply(threePanels(), { operation: "component.select", componentId: "zz", itemKey: null }),
			"COMPONENT_NOT_FOUND",
		);
	});
});

describe("layout.update", () => {
	it("accepts any permutation of the component ids", () => {
		const next = expectOk(
			apply(threePanels(), { operation: "layout.update", order: ["c", "a", "b"], columns: 2 }),
		);
		expect(next.layout).toEqual({ order: ["c", "a", "b"], columns: 2 });
		expect(next.components).toEqual(threePanels().components);
		expect(next.version).toBe(4);
	});

	it("accepts the identity permutation with a column change", () => {
		const next = expectOk(
			apply(threePanels(), { operation: "layout.update", order: ["a", "b", "c"], columns: 2 }),
		);
		expect(next.layout).toEqual({ order: ["a", "b", "c"], columns: 2 });
	});

	it("accepts an empty order for an empty workspace", () => {
		expect(apply(build([]), { operation: "layout.update", order: [], columns: 2 }).ok).toBe(true);
	});

	it.each([
		["a missing id", ["a", "b"]],
		["a duplicated id", ["a", "b", "b"]],
		["a duplicate replacing another id", ["a", "a", "c"]],
		["an unknown id", ["a", "b", "zz"]],
		["an extra unknown id", ["a", "b", "c", "zz"]],
		["an extra duplicate", ["a", "b", "c", "a"]],
		["an empty order", []],
	])("rejects an order with %s", (_label, order) => {
		expectRejected(
			apply(threePanels(), { operation: "layout.update", order, columns: 1 }),
			"LAYOUT_MISMATCH",
		);
	});

	it("does not alias the command's order array into the state", () => {
		const order = ["c", "b", "a"];
		const state = threePanels();
		const next = expectOk(
			applyUiCommand(
				state,
				commandFor(state, { operation: "layout.update", order, columns: 1 }),
				context(),
			),
		);
		order.reverse();
		expect(next.layout.order).toEqual(["c", "b", "a"]);
	});
});

describe("dataset.bind", () => {
	it("points a component at another dataset the owner has", () => {
		const next = expectOk(
			apply(threePanels(), { operation: "dataset.bind", componentId: "a", datasetRef: "ds_3" }),
		);
		expect(next.components[0]?.props).toEqual({
			title: "Panel a",
			datasetRef: "ds_3",
			sourceIds: ["src_1"],
		});
		expect(next.version).toBe(4);
	});

	it("rejects binding a dataset the owner does not have", () => {
		expectRejected(
			apply(threePanels(), {
				operation: "dataset.bind",
				componentId: "a",
				datasetRef: "ds_foreign",
			}),
			"UNKNOWN_DATASET",
		);
	});

	it("rejects binding on a missing component", () => {
		expectRejected(
			apply(threePanels(), { operation: "dataset.bind", componentId: "zz", datasetRef: "ds_1" }),
			"COMPONENT_NOT_FOUND",
		);
	});

	it("rejects binding a component type that cannot hold a dataset", () => {
		const state = build([
			{
				operation: "component.create",
				componentId: "n",
				componentType: "note",
				schemaVersion: 1,
				props: { title: "Note" },
			},
		]);
		expectRejected(
			apply(state, { operation: "dataset.bind", componentId: "n", datasetRef: "ds_1" }),
			"INVALID_PROPS",
		);
	});
});

describe("dataset.refresh", () => {
	it("re-points every component bound to the dataset and no others", () => {
		const next = expectOk(
			apply(threePanels(), {
				operation: "dataset.refresh",
				datasetRef: "ds_1",
				replacementDatasetRef: "ds_3",
			}),
		);
		expect(next.components.map((component) => component.props.datasetRef)).toEqual([
			"ds_3",
			"ds_3",
			"ds_2",
		]);
		expect(next.version).toBe(4);
		expect(next.layout).toEqual(threePanels().layout);
	});

	it("rejects a refresh of a dataset nothing is bound to", () => {
		expectRejected(
			apply(threePanels(), {
				operation: "dataset.refresh",
				datasetRef: "ds_3",
				replacementDatasetRef: "ds_1",
			}),
			"DATASET_NOT_BOUND",
		);
	});

	it("rejects a replacement dataset the owner does not have, changing nothing", () => {
		const state = threePanels();
		const before = structuredClone(state);
		expectRejected(
			apply(state, {
				operation: "dataset.refresh",
				datasetRef: "ds_1",
				replacementDatasetRef: "ds_foreign",
			}),
			"UNKNOWN_DATASET",
		);
		expect(state).toEqual(before);
	});

	it("re-checks the other references of the refreshed components", () => {
		const ctx = context({ knownSourceIds: new Set() });
		expectRejected(
			apply(
				threePanels(),
				{ operation: "dataset.refresh", datasetRef: "ds_1", replacementDatasetRef: "ds_3" },
				ctx,
			),
			"UNKNOWN_SOURCE",
		);
	});
});

describe("navigation.open", () => {
	it("records an allowlisted view navigation", () => {
		const state = threePanels();
		const command = commandFor(state, {
			operation: "navigation.open",
			target: { kind: "view", view: "sources" },
		});
		const next = expectOk(applyUiCommand(state, deepFreeze(command), context()));
		expect(next.lastNavigation).toEqual({
			commandId: command.commandId,
			target: { kind: "view", view: "sources" },
		});
		expect(next.version).toBe(4);
		expect(next.components).toEqual(state.components);
	});

	it("opens evidence the owner stores", () => {
		const next = expectOk(
			apply(threePanels(), {
				operation: "navigation.open",
				target: { kind: "evidence", evidenceId: "ev_9" },
			}),
		);
		expect(next.lastNavigation?.target).toEqual({ kind: "evidence", evidenceId: "ev_9" });
	});

	it("rejects navigation to evidence that is not stored", () => {
		const error = expectRejected(
			apply(threePanels(), {
				operation: "navigation.open",
				target: { kind: "evidence", evidenceId: "ev_fabricated" },
			}),
			"UNKNOWN_EVIDENCE",
		);
		expect(error.detail).toContain("ev_fabricated");
	});
});

describe("applyUiCommand purity (ARCH-009)", () => {
	const operations: readonly UiOperation[] = [
		createPanel("d"),
		{ operation: "component.update", componentId: "a", props: { title: "T" } },
		{ operation: "component.remove", componentId: "b" },
		{ operation: "component.focus", componentId: "c" },
		{ operation: "component.select", componentId: "c", itemKey: "k" },
		{ operation: "layout.update", order: ["b", "c", "a"], columns: 2 },
		{ operation: "dataset.bind", componentId: "b", datasetRef: "ds_3" },
		{ operation: "dataset.refresh", datasetRef: "ds_1", replacementDatasetRef: "ds_2" },
		{ operation: "navigation.open", target: { kind: "view", view: "settings" } },
	];

	it.each(
		operations,
	)("$operation increments the version by exactly one and returns a new state", (operation) => {
		const state = threePanels();
		const before = structuredClone(state);
		const next = expectOk(apply(state, operation));
		expect(next.version).toBe(state.version + 1);
		expect(next).not.toBe(state);
		expect(next.workspaceId).toBe(state.workspaceId);
		// `state` is deep-frozen, so an in-place write would already have thrown.
		expect(state).toEqual(before);
	});

	it("is deterministic: the same state and command give the same result", () => {
		const state = threePanels();
		for (const operation of operations) {
			const command = deepFreeze(commandFor(state, operation));
			expect(applyUiCommand(state, command, context())).toEqual(
				applyUiCommand(state, command, context()),
			);
		}
	});

	it.each<[string, UiOperation]>([
		["COMPONENT_EXISTS", createPanel("a")],
		["COMPONENT_NOT_FOUND", { operation: "component.remove", componentId: "zz" }],
		["LAYOUT_MISMATCH", { operation: "layout.update", order: ["a"], columns: 1 }],
		["UNKNOWN_DATASET", { operation: "dataset.bind", componentId: "a", datasetRef: "nope" }],
		[
			"DATASET_NOT_BOUND",
			{ operation: "dataset.refresh", datasetRef: "x", replacementDatasetRef: "ds_1" },
		],
		[
			"UNKNOWN_EVIDENCE",
			{ operation: "navigation.open", target: { kind: "evidence", evidenceId: "x" } },
		],
	])("a command rejected with %s leaves the state exactly as it was", (code, operation) => {
		const state = threePanels();
		const before = structuredClone(state);
		const result = apply(state, operation);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe(code);
		expect(state).toEqual(before);
	});
});

describe("resolveCommandReferences", () => {
	it("lists the ids a create command would depend on, without checking they exist", () => {
		const state = build([]);
		const command = commandFor(
			state,
			createPanel("x", { datasetRef: "ds_unknown", sourceIds: ["s1", "s2"] }),
		);
		expect(resolveCommandReferences(state, command, validateProps)).toEqual({
			ok: true,
			value: { datasetRefs: ["ds_unknown"], sourceIds: ["s1", "s2"] },
		});
	});

	it("lists the merged references of an update", () => {
		const state = threePanels();
		const command = commandFor(state, {
			operation: "component.update",
			componentId: "a",
			props: { sourceIds: ["src_2"] },
		});
		expect(resolveCommandReferences(state, command, validateProps)).toEqual({
			ok: true,
			value: { datasetRefs: ["ds_1"], sourceIds: ["src_2"] },
		});
	});

	it("lists the references of every component touched by a refresh", () => {
		const state = threePanels();
		const command = commandFor(state, {
			operation: "dataset.refresh",
			datasetRef: "ds_1",
			replacementDatasetRef: "ds_9",
		});
		expect(resolveCommandReferences(state, command, validateProps)).toEqual({
			ok: true,
			value: { datasetRefs: ["ds_9", "ds_9"], sourceIds: ["src_1"] },
		});
	});

	it("reports evidence navigation as a source reference", () => {
		const state = build([]);
		const command = commandFor(state, {
			operation: "navigation.open",
			target: { kind: "evidence", evidenceId: "ev_42" },
		});
		expect(resolveCommandReferences(state, command, validateProps)).toEqual({
			ok: true,
			value: { datasetRefs: [], sourceIds: ["ev_42"] },
		});
	});

	it("reports no references for commands that introduce none", () => {
		const state = threePanels();
		for (const operation of [
			{ operation: "component.remove", componentId: "a" },
			{ operation: "component.focus", componentId: "a" },
			{ operation: "layout.update", order: ["c", "b", "a"], columns: 1 },
			{ operation: "navigation.open", target: { kind: "view", view: "settings" } },
		] satisfies UiOperation[]) {
			expect(resolveCommandReferences(state, commandFor(state, operation), validateProps)).toEqual({
				ok: true,
				value: NO_REFERENCES,
			});
		}
	});

	it("applies the same envelope and operation checks as applyUiCommand", () => {
		const state = threePanels();
		const stale = commandFor(state, createPanel("x"), { expectedWorkspaceVersion: 0 });
		const missing = commandFor(state, { operation: "component.focus", componentId: "zz" });
		const invalid = commandFor(state, createPanel("x", { title: "" }));
		expect(resolveCommandReferences(state, stale, validateProps)).toMatchObject({
			ok: false,
			error: { code: "VERSION_CONFLICT" },
		});
		expect(resolveCommandReferences(state, missing, validateProps)).toMatchObject({
			ok: false,
			error: { code: "COMPONENT_NOT_FOUND" },
		});
		expect(resolveCommandReferences(state, invalid, validateProps)).toMatchObject({
			ok: false,
			error: { code: "INVALID_PROPS" },
		});
	});
});
