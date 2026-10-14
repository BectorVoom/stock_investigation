import { z } from "zod";
import {
	addWidgetCommandSchema,
	configSchema,
	duplicateWidgetCommandSchema,
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
function jsonSchemaOf<T>(schema: z.ZodType<T>, configDescription?: string): JsonObject {
	const generated: unknown = z.toJSONSchema(schema, {
		unrepresentable: "any",
		override:
			configDescription === undefined
				? undefined
				: (ctx) => {
						// The `config` field is a `z.custom` (any JSON object), so it
						// would generate as `{}`. Describe it at the schema — by
						// identity, through `z.toJSONSchema`'s `override` — so the
						// model learns where the shape is defined.
						if (ctx.zodSchema === configSchema) {
							ctx.jsonSchema.type = "object";
							ctx.jsonSchema.description = configDescription;
						}
					},
	});
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
	const configDescription = `Type-specific configuration; its JSON Schema is the configSchema of the widget type in ${describeName}.`;

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
		configDescription?: string,
	): WidgetAgentTool => ({
		name: `${prefix}${kind}`,
		title,
		description: `${description} ${callFirst}`,
		inputSchema: jsonSchemaOf(schema, configDescription),
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
			configDescription,
		),
		commandTool(
			"remove",
			"Remove widget",
			"Delete one widget by its id.",
			removeWidgetCommandSchema.omit({ kind: true }),
		),
		commandTool(
			"duplicate",
			"Duplicate widget",
			"Copy a widget through its own type with a fresh id. The title defaults to “<title> (copy)”; toIndex is the 0-based position the copy should end at (default: right after the original).",
			duplicateWidgetCommandSchema.omit({ kind: true }),
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
			configDescription,
		),
	];
}
