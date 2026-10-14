import { z } from "zod";
import { err, ok, type Result } from "../core/index.ts";
import type { JsonObject, WidgetAgentFailure, WidgetCommand } from "./types.ts";

/**
 * The versioned command schema: a zod discriminated union on `kind` built
 * from `z.strictObject` members, so unknown kinds and unknown fields are
 * rejected. Untrusted input enters the agent layer only through
 * `parseWidgetCommand`.
 */

const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 20_000;

/** Whether `value` is a plain JSON object of bounded depth and size. */
export function isJsonObject(value: unknown): value is JsonObject {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	// Iterative on purpose: a recursive check overflows the stack on a few
	// thousand nested arrays, which fits inside any transport limit.
	const pending: { readonly value: unknown; readonly depth: number }[] = [{ value, depth: 0 }];
	let nodes = 0;
	for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
		nodes += 1;
		if (nodes > MAX_JSON_NODES || entry.depth > MAX_JSON_DEPTH) return false;
		const current = entry.value;
		if (current === null || typeof current === "string" || typeof current === "boolean") {
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current)) return false;
			continue;
		}
		if (typeof current !== "object") return false;
		if (Array.isArray(current)) {
			for (const child of current) pending.push({ value: child, depth: entry.depth + 1 });
			continue;
		}
		const childPrototype: unknown = Object.getPrototypeOf(current);
		if (childPrototype !== Object.prototype && childPrototype !== null) return false;
		for (const child of Object.values(current)) {
			pending.push({ value: child, depth: entry.depth + 1 });
		}
	}
	return true;
}

const widgetIdSchema = z.string().min(1).max(120);
const widgetTypeSchema = z.string().min(1).max(80);
const titleSchema = z.string().trim().min(1).max(200);
const toIndexSchema = z.number().int().min(0).max(1000);
const sizeSchema = z.enum(["small", "medium", "large"]);
const directionSchema = z.enum(["earlier", "later"]);
/**
 * Type-specific configuration: any JSON object at the command boundary; the
 * widget type's `build` validates it. Exported so tool schemas can describe
 * it at the schema (by identity in `z.toJSONSchema`'s `override`) instead of
 * patching the generated object.
 */
export const configSchema = z.custom<JsonObject>(isJsonObject, {
	message: "must be a JSON object",
});

export const addWidgetCommandSchema = z.strictObject({
	kind: z.literal("add"),
	type: widgetTypeSchema,
	title: titleSchema,
	size: sizeSchema.optional(),
	config: configSchema.optional(),
	toIndex: toIndexSchema.optional(),
});

export const removeWidgetCommandSchema = z.strictObject({
	kind: z.literal("remove"),
	widgetId: widgetIdSchema,
});

export const moveWidgetCommandSchema = z.strictObject({
	kind: z.literal("move"),
	widgetId: widgetIdSchema,
	direction: directionSchema,
});

export const reorderWidgetCommandSchema = z.strictObject({
	kind: z.literal("reorder"),
	widgetId: widgetIdSchema,
	toIndex: toIndexSchema,
});

export const resizeWidgetCommandSchema = z.strictObject({
	kind: z.literal("resize"),
	widgetId: widgetIdSchema,
	size: sizeSchema,
});

export const updateWidgetCommandSchema = z.strictObject({
	kind: z.literal("update"),
	widgetId: widgetIdSchema,
	title: titleSchema.optional(),
	config: configSchema.optional(),
});

export const duplicateWidgetCommandSchema = z.strictObject({
	kind: z.literal("duplicate"),
	widgetId: widgetIdSchema,
	title: titleSchema.optional(),
	toIndex: toIndexSchema.optional(),
});

/**
 * The command protocol. `z.infer` of this schema is `WidgetCommand`. The
 * members stay plain `z.strictObject`s so tools can derive their input
 * schemas with `.omit({ kind: true })`; the update rule (neither `title` nor
 * `config` is invalid) lives as a union-level refinement instead of a member
 * refinement, which `.omit()` rejects.
 */
export const widgetCommandSchema = z
	.discriminatedUnion("kind", [
		addWidgetCommandSchema,
		removeWidgetCommandSchema,
		moveWidgetCommandSchema,
		reorderWidgetCommandSchema,
		resizeWidgetCommandSchema,
		updateWidgetCommandSchema,
		duplicateWidgetCommandSchema,
	])
	.refine(
		(value) => value.kind !== "update" || value.title !== undefined || value.config !== undefined,
		{ message: 'at least one of "title" or "config" is required' },
	) satisfies z.ZodType<WidgetCommand>;

/**
 * Parses untrusted input into a command. On failure returns
 * `INVALID_COMMAND` with a message naming the offending field (from the zod
 * issue path, or the unknown key, or the discriminator) — never the raw zod
 * dump.
 */
export function parseWidgetCommand(input: unknown): Result<WidgetCommand, WidgetAgentFailure> {
	const parsed = widgetCommandSchema.safeParse(input);
	if (parsed.success) return ok(parsed.data);
	const issue = parsed.error.issues[0];
	if (issue === undefined) {
		return err({
			code: "INVALID_COMMAND",
			message: "invalid command: the command is not an object.",
		});
	}
	if (issue.code === "unrecognized_keys") {
		const keys = issue.keys.map((key) => `"${key}"`).join(", ");
		return err({ code: "INVALID_COMMAND", message: `invalid command: unknown field ${keys}.` });
	}
	const field =
		issue.path.length > 0
			? issue.path.map(String).join(".")
			: issue.code === "invalid_union"
				? "kind"
				: "command";
	return err({ code: "INVALID_COMMAND", message: `invalid command: "${field}" ${issue.message}` });
}
