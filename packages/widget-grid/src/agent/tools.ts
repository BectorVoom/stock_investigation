import { z } from "zod";
import {
	addWidgetCommandSchema,
	isJsonObject,
	moveWidgetCommandSchema,
	removeWidgetCommandSchema,
	reorderWidgetCommandSchema,
	resizeWidgetCommandSchema,
	updateWidgetCommandSchema,
} from "./commands.ts";
import type {
	JsonObject,
	WidgetAgentHost,
	WidgetAgentTool,
	WidgetAgentToolResult,
	WidgetCommandKind,
} from "./types.ts";

/**
 * Turns a host into tools in the shape agent runtimes share: a name, a
 * description and a JSON Schema for the input. Each command kind gets one
 * tool whose `inputSchema` is generated with zod 4's `z.toJSONSchema` from
 * the same member schema the command parser uses (minus `kind`, which
 * `execute` adds back) — there is no second hand-written schema to drift.
 */

export interface CreateWidgetAgentToolsOptions {
	readonly prefix?: string;
}

/** A JSON Schema (an object schema) as plain JSON. */
function jsonSchemaOf<T>(schema: z.ZodType<T>): JsonObject {
	const generated: unknown = z.toJSONSchema(schema, { unrepresentable: "any" });
	if (isJsonObject(generated)) return generated;
	return { type: "object" };
}

const describeInputSchema = z.strictObject({});

export function createWidgetAgentTools(
	host: WidgetAgentHost,
	options?: CreateWidgetAgentToolsOptions,
): readonly WidgetAgentTool[] {
	const prefix = options?.prefix ?? "widgets_";
	const describeName = `${prefix}describe`;
	const callFirst = `Call ${describeName} first to learn ids, types and config schemas.`;

	const commandExecute =
		(kind: WidgetCommandKind) =>
		async (input: unknown): Promise<WidgetAgentToolResult> => {
			try {
				const fields: JsonObject = isJsonObject(input) ? input : {};
				const result = await host.apply({ ...fields, kind });
				if (!result.ok) return { ok: false, error: result.error };
				return { ok: true, snapshot: result.value };
			} catch {
				return {
					ok: false,
					error: { code: "STORE_UNAVAILABLE", message: "the widget tool failed unexpectedly." },
				};
			}
		};

	const commandTool = (
		kind: WidgetCommandKind,
		title: string,
		description: string,
		schema: z.ZodType<unknown>,
	): WidgetAgentTool => ({
		name: `${prefix}${kind}`,
		title,
		description: `${description} ${callFirst}`,
		inputSchema: jsonSchemaOf(schema),
		readOnly: false,
		execute: commandExecute(kind),
	});

	return [
		{
			name: describeName,
			title: "Describe widgets",
			description: `Read the current widget grid: sizes, widget types with their config schemas, and every widget in order with its id, position and config. Positions are 0-based. ${callFirst}`,
			inputSchema: jsonSchemaOf(describeInputSchema),
			readOnly: true,
			execute: async (): Promise<WidgetAgentToolResult> => {
				try {
					const result = await host.describe();
					if (!result.ok) return { ok: false, error: result.error };
					return { ok: true, snapshot: result.value };
				} catch {
					return {
						ok: false,
						error: { code: "STORE_UNAVAILABLE", message: "the widget tool failed unexpectedly." },
					};
				}
			},
		},
		commandTool(
			"add",
			"Add widget",
			"Add a widget of a registered type. The size defaults to the type's default; toIndex is the 0-based position it should end at (default: last).",
			addWidgetCommandSchema.omit({ kind: true }),
		),
		commandTool(
			"remove",
			"Remove widget",
			"Delete one widget by its id.",
			removeWidgetCommandSchema.omit({ kind: true }),
		),
		commandTool(
			"move",
			"Move widget",
			"Swap a widget with its neighbour one position earlier or later.",
			moveWidgetCommandSchema.omit({ kind: true }),
		),
		commandTool(
			"reorder",
			"Reorder widget",
			"Move a widget to an absolute 0-based position; the others keep their relative order — exactly what a drop does.",
			reorderWidgetCommandSchema.omit({ kind: true }),
		),
		commandTool(
			"resize",
			"Resize widget",
			"Change a widget's size to one its type allows.",
			resizeWidgetCommandSchema.omit({ kind: true }),
		),
		commandTool(
			"update",
			"Update widget",
			"Rename a widget and/or reconfigure it: config keys replace the widget's current values key by key, keys not given are kept.",
			updateWidgetCommandSchema.omit({ kind: true }),
		),
	];
}
