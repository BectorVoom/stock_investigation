import { UI_PROTOCOL_VERSION } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	MAX_WORKSPACE_COMPONENTS,
	uiCommandSchema,
	uiOperationSchema,
	workspaceStateSchema,
} from "../src/index.ts";
import { SECTION_7_EXAMPLE_COMMAND, workspaceState } from "./fixtures.ts";
import { expectAccepted, expectRejected, repeat, without } from "./support.ts";

const envelope = {
	protocolVersion: 1,
	commandId: "cmd_1",
	workspaceId: "ws_1",
	expectedWorkspaceVersion: 0,
};

/** One valid example of each of the nine baseline operations (section 7). */
const OPERATIONS = {
	"component.create": {
		operation: "component.create",
		componentId: "table_1",
		componentType: "data-table",
		schemaVersion: 1,
		props: { title: "T", datasetRef: "ds_1", sourceIds: [] },
	},
	"component.update": {
		operation: "component.update",
		componentId: "table_1",
		props: { title: "U" },
	},
	"component.remove": { operation: "component.remove", componentId: "table_1" },
	"component.focus": { operation: "component.focus", componentId: "table_1" },
	"component.select": { operation: "component.select", componentId: "table_1", itemKey: "row_2" },
	"layout.update": { operation: "layout.update", order: ["table_1", "chart_1"], columns: 2 },
	"dataset.bind": { operation: "dataset.bind", componentId: "table_1", datasetRef: "ds_2" },
	"dataset.refresh": {
		operation: "dataset.refresh",
		datasetRef: "ds_1",
		replacementDatasetRef: "ds_2",
	},
	"navigation.open": { operation: "navigation.open", target: { kind: "view", view: "sources" } },
} as const;

const operationNames = Object.keys(OPERATIONS) as readonly (keyof typeof OPERATIONS)[];

describe("uiCommandSchema: documented example", () => {
	it("parses the section 7 example command unchanged", () => {
		expect(expectAccepted(uiCommandSchema, SECTION_7_EXAMPLE_COMMAND)).toEqual(
			SECTION_7_EXAMPLE_COMMAND,
		);
	});

	it("uses protocol version 1", () => {
		expect(UI_PROTOCOL_VERSION).toBe(1);
	});
});

describe("uiCommandSchema: allowed operations", () => {
	it("covers exactly the nine baseline operations", () => {
		expect([...operationNames].sort()).toEqual(
			[
				"component.create",
				"component.update",
				"component.remove",
				"component.focus",
				"component.select",
				"layout.update",
				"dataset.bind",
				"dataset.refresh",
				"navigation.open",
			].sort(),
		);
	});

	it.each(operationNames)("accepts %s with an envelope", (name) => {
		const command = { ...envelope, ...OPERATIONS[name] };
		expect(expectAccepted(uiCommandSchema, command)).toEqual(command);
	});

	it.each(operationNames)("accepts %s as a bare operation", (name) => {
		expect(expectAccepted(uiOperationSchema, OPERATIONS[name])).toEqual(OPERATIONS[name]);
	});

	it("accepts navigation to stored evidence and each allowlisted view", () => {
		for (const view of ["workspace", "sources", "settings"]) {
			expectAccepted(uiCommandSchema, {
				...envelope,
				operation: "navigation.open",
				target: { kind: "view", view },
			});
		}
		expectAccepted(uiCommandSchema, {
			...envelope,
			operation: "navigation.open",
			target: { kind: "evidence", evidenceId: "ev_1" },
		});
	});

	it("accepts clearing a selection with a null item key", () => {
		expectAccepted(uiCommandSchema, {
			...envelope,
			...OPERATIONS["component.select"],
			itemKey: null,
		});
	});
});

describe("uiCommandSchema: rejections (ARCH-017 / SEC-007 / hard gate 4)", () => {
	it.each([
		"component.eval",
		"component.exec",
		"script.run",
		"source.register",
		"source.delete",
		"research.start",
		"navigation.goto",
		"COMPONENT.CREATE",
		"component.create ",
		"",
	])("rejects the unknown operation %j", (operation) => {
		expectRejected(uiCommandSchema, { ...envelope, ...OPERATIONS["component.remove"], operation });
		expectRejected(uiOperationSchema, { ...OPERATIONS["component.remove"], operation });
	});

	it("rejects a command with no operation", () => {
		expectRejected(uiCommandSchema, envelope);
		expectRejected(uiCommandSchema, { ...envelope, componentId: "table_1" });
	});

	it.each(operationNames)("rejects unknown extra keys on %s", (name) => {
		expectRejected(uiCommandSchema, {
			...envelope,
			...OPERATIONS[name],
			html: "<script>x</script>",
		});
		expectRejected(uiCommandSchema, { ...envelope, ...OPERATIONS[name], onClick: "alert(1)" });
		expectRejected(uiOperationSchema, { ...OPERATIONS[name], extra: true });
	});

	it("rejects keys that belong to a different operation", () => {
		expectRejected(uiCommandSchema, {
			...envelope,
			...OPERATIONS["component.remove"],
			props: { title: "smuggled" },
		});
		expectRejected(uiCommandSchema, {
			...envelope,
			...OPERATIONS["component.focus"],
			componentType: "data-table",
		});
	});

	it("rejects envelope fields on a bare operation", () => {
		expectRejected(uiOperationSchema, { ...envelope, ...OPERATIONS["component.remove"] });
	});

	it.each([0, 2, 1.5, -1, "1", null])("rejects protocolVersion %j", (protocolVersion) => {
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["component.remove"], protocolVersion },
			["protocolVersion"],
		);
	});

	it.each([
		"protocolVersion",
		"commandId",
		"workspaceId",
		"expectedWorkspaceVersion",
	] as const)("rejects a command without %s", (key) => {
		expectRejected(
			uiCommandSchema,
			{ ...without(envelope, key), ...OPERATIONS["component.remove"] },
			[key],
		);
	});

	it("rejects a negative, fractional or non-numeric expected version", () => {
		for (const expectedWorkspaceVersion of [-1, 0.5, "4", null, Number.NaN]) {
			expectRejected(
				uiCommandSchema,
				{ ...envelope, ...OPERATIONS["component.remove"], expectedWorkspaceVersion },
				["expectedWorkspaceVersion"],
			);
		}
	});

	it("rejects malformed command and workspace ids", () => {
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["component.remove"], commandId: "" },
			["commandId"],
		);
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["component.remove"], workspaceId: "ws 1; DROP" },
			["workspaceId"],
		);
	});

	it.each([
		"",
		"1table",
		"has space",
		"a/b",
		"<img>",
		"x".repeat(65),
	])("rejects the malformed component id %j", (componentId) => {
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["component.remove"], componentId },
			["componentId"],
		);
	});

	it.each([
		"",
		"Data-Table",
		"data_table",
		"script<",
		"x",
		"9lives",
	])("rejects the malformed component type %j", (componentType) => {
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["component.create"], componentType },
			["componentType"],
		);
	});

	it("rejects a non-positive or fractional schema version", () => {
		for (const schemaVersion of [0, -1, 1.5, "1"]) {
			expectRejected(
				uiCommandSchema,
				{ ...envelope, ...OPERATIONS["component.create"], schemaVersion },
				["schemaVersion"],
			);
		}
	});

	it("rejects props that are not a JSON object", () => {
		for (const props of ["<div/>", ["a"], null, 3]) {
			expectRejected(uiCommandSchema, { ...envelope, ...OPERATIONS["component.create"], props }, [
				"props",
			]);
		}
		expectRejected(uiCommandSchema, {
			...envelope,
			...OPERATIONS["component.create"],
			props: { title: "T", render: () => "<b>x</b>" },
		});
	});

	it("rejects a layout with three columns, a non-array order, or too many entries", () => {
		expectRejected(uiCommandSchema, { ...envelope, ...OPERATIONS["layout.update"], columns: 3 }, [
			"columns",
		]);
		expectRejected(uiCommandSchema, { ...envelope, ...OPERATIONS["layout.update"], order: "a,b" }, [
			"order",
		]);
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["layout.update"], order: repeat("table_1", 61) },
			["order"],
		);
	});

	it("rejects navigation to arbitrary URLs or unknown views", () => {
		for (const target of [
			{ kind: "url", url: "https://evil.example.org/" },
			{ kind: "view", view: "admin" },
			{ kind: "view", view: "sources", url: "https://evil.example.org/" },
			{ kind: "evidence", evidenceId: "../../etc/passwd" },
			"https://evil.example.org/",
			null,
		]) {
			expectRejected(uiCommandSchema, { ...envelope, operation: "navigation.open", target });
		}
	});

	it("rejects an empty selection key (null is the way to clear)", () => {
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...OPERATIONS["component.select"], itemKey: "" },
			["itemKey"],
		);
		expectRejected(
			uiCommandSchema,
			{ ...envelope, ...without(OPERATIONS["component.select"], "itemKey") },
			["itemKey"],
		);
	});

	it("rejects non-object input", () => {
		for (const value of [
			null,
			undefined,
			"component.remove",
			1,
			[],
			[OPERATIONS["component.remove"]],
		]) {
			expectRejected(uiCommandSchema, value);
		}
	});
});

describe("workspaceStateSchema", () => {
	it("accepts a stored workspace state", () => {
		expect(expectAccepted(workspaceStateSchema, workspaceState)).toEqual(workspaceState);
	});

	it("accepts focus, selection and last navigation", () => {
		expectAccepted(workspaceStateSchema, {
			...workspaceState,
			focusedComponentId: "demand_table_1",
			selection: { componentId: "demand_table_1", itemKey: "row_1" },
			lastNavigation: { commandId: "cmd_9", target: { kind: "evidence", evidenceId: "ev_1" } },
		});
	});

	it("rejects a negative or fractional version", () => {
		expectRejected(workspaceStateSchema, { ...workspaceState, version: -1 }, ["version"]);
		expectRejected(workspaceStateSchema, { ...workspaceState, version: 1.5 }, ["version"]);
	});

	it("rejects unknown top-level and component keys", () => {
		expectRejected(workspaceStateSchema, { ...workspaceState, script: "alert(1)" });
		expectRejected(workspaceStateSchema, {
			...workspaceState,
			components: [{ ...workspaceState.components[0], renderer: "custom" }],
		});
	});

	it("rejects more than three layout columns and oversized component lists", () => {
		expectRejected(
			workspaceStateSchema,
			{ ...workspaceState, layout: { ...workspaceState.layout, columns: 3 } },
			["layout", "columns"],
		);
		expectRejected(
			workspaceStateSchema,
			{ ...workspaceState, components: repeat(workspaceState.components[0], 61) },
			["components"],
		);
	});

	it("requires the nullable fields to be present", () => {
		for (const key of ["focusedComponentId", "selection", "lastNavigation"] as const) {
			expectRejected(workspaceStateSchema, without(workspaceState, key), [key]);
		}
	});

	it("caps a workspace at 40 components by policy", () => {
		expect(MAX_WORKSPACE_COMPONENTS).toBe(40);
	});
});
