import {
	NOTEBOOK_CONTENT_SHAPES,
	NOTEBOOK_LIMITS,
	NOTEBOOK_WIDGET_TYPE_META,
	NOTEBOOK_WIDGET_TYPES,
	type Notebook,
	type NotebookChange,
	type NotebookWidget,
	type NotebookWidgetCore,
	type NotebookWidgetOrigin,
	type NotebookWidgetType,
	notebookWidgetCoreSchema,
} from "@research/contracts";
import {
	createWidgetAgentHost,
	isJsonObject,
	type JsonObject,
	parseWidgetCommand,
	type WidgetAgentFailure,
	type WidgetAgentType,
	type WidgetSnapshot,
} from "@research/widget-grid/agent";
import { err, ok, type Result } from "@research/widget-grid/core";
import { z } from "zod";

/**
 * The notebook as the widget-grid agent layer sees it (ADR-0020). Both the
 * runner (to pre-check a model's commands against its copy) and the API (to
 * apply them to the stored notebook) use these functions, so one set of
 * rules decides what an assistant turn may do.
 *
 * Commands are applied through `createWidgetAgentHost` over an in-memory
 * store, one by one, all or nothing. A `remove` is never applied here: the
 * assistant proposes removals and the owner confirms them.
 */

const GENERIC_KEYS: ReadonlySet<string> = new Set(["widgetId", "type", "title", "size"]);

function contentSchemaFor(type: NotebookWidgetType): JsonObject {
	const { type: _discriminator, ...content } = NOTEBOOK_CONTENT_SHAPES[type];
	const generated: unknown = z.toJSONSchema(z.strictObject(content));
	if (!isJsonObject(generated)) {
		throw new Error(`the "${type}" notebook widget config schema is not an object schema.`);
	}
	return generated;
}

const CONFIG_SCHEMAS: ReadonlyMap<NotebookWidgetType, JsonObject> = new Map(
	NOTEBOOK_WIDGET_TYPES.map((type) => [type, contentSchemaFor(type)] as const),
);

/** What the agent types need from the conversation the notebook belongs to. */
export interface NotebookAgentContext {
	/** Canvas component ids of the same conversation (`research` widgets must name one). */
	readonly knownComponentIds: ReadonlySet<string>;
	readonly newWidgetId: () => string;
}

/** The type-specific part of a widget as JSON: everything but the four generic fields. */
export function notebookWidgetConfig(widget: NotebookWidgetCore): JsonObject {
	const config: { [key: string]: JsonObject[string] } = {};
	for (const [key, value] of Object.entries(widget)) {
		if (!GENERIC_KEYS.has(key)) config[key] = value;
	}
	return config;
}

function buildCore(
	type: NotebookWidgetType,
	draft: {
		readonly widgetId: string;
		readonly title: string;
		readonly size: NotebookWidgetCore["size"];
		readonly config: JsonObject;
	},
	context: NotebookAgentContext,
): Result<NotebookWidgetCore, string> {
	// Generic fields win over same-named config keys, so config cannot smuggle them in.
	const parsed = notebookWidgetCoreSchema.safeParse({
		...draft.config,
		widgetId: draft.widgetId,
		title: draft.title,
		size: draft.size,
		type,
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field =
			issue === undefined || issue.path.length === 0 ? "widget" : issue.path.map(String).join(".");
		return err(`invalid ${type} widget: "${field}" ${issue?.message ?? "is invalid"}.`);
	}
	if (parsed.data.type === "research" && !context.knownComponentIds.has(parsed.data.componentId)) {
		return err(
			`invalid research widget: "componentId" must name a canvas component of this conversation.`,
		);
	}
	return ok(parsed.data);
}

export function notebookWidgetAgentTypes(
	context: NotebookAgentContext,
): readonly WidgetAgentType<NotebookWidgetCore>[] {
	return NOTEBOOK_WIDGET_TYPES.map((type) => {
		const meta = NOTEBOOK_WIDGET_TYPE_META[type];
		const configSchema = CONFIG_SCHEMAS.get(type);
		if (configSchema === undefined) throw new Error(`no config schema for "${type}".`);
		return {
			type,
			label: meta.label,
			description: meta.description,
			defaultSize: meta.defaultSize,
			sizes: meta.sizes,
			configSchema,
			build: (draft) => buildCore(type, draft, context),
			configOf: (widget) => {
				if (widget.type !== type) {
					throw new Error(`widget "${widget.widgetId}" is not a ${type} widget.`);
				}
				return notebookWidgetConfig(widget);
			},
		};
	});
}

/** A stored widget without the server-stamped metadata. */
export function toNotebookWidgetCore(widget: NotebookWidget): NotebookWidgetCore {
	const { createdAt: _c, updatedAt: _u, revision: _r, origin: _o, ...core } = widget;
	return core;
}

export interface NotebookCommandFailure {
	/** 0-based index of the command that failed. */
	readonly index: number;
	readonly failure: WidgetAgentFailure;
}

export interface AppliedNotebookCommands {
	readonly widgets: readonly NotebookWidgetCore[];
	readonly snapshot: WidgetSnapshot;
	/** One entry per change, in command order (moves and resizes included). */
	readonly changes: readonly NotebookChange[];
}

/** Snapshot of the notebook for an agent: what `describe` returns. */
export async function describeNotebook(
	notebook: Notebook,
	context: NotebookAgentContext,
): Promise<Result<WidgetSnapshot, WidgetAgentFailure>> {
	const widgets = notebook.widgets.map(toNotebookWidgetCore);
	const host = createWidgetAgentHost({
		store: {
			read: async () => ok({ widgets, revision: 0 }),
			write: async () =>
				err({ code: "STORE_UNAVAILABLE", message: "describe never writes." } as const),
		},
		types: notebookWidgetAgentTypes(context),
		newWidgetId: context.newWidgetId,
		limits: { maxWidgets: NOTEBOOK_LIMITS.maxWidgets },
	});
	return host.describe();
}

/** JSON with object keys sorted, so equal widgets compare equal whatever their key order. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, current: unknown) => {
		if (typeof current !== "object" || current === null || Array.isArray(current)) return current;
		return Object.fromEntries(
			Object.entries(current).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
		);
	});
}

const PREVIEW_CHARS = 600;

function preview(widget: NotebookWidgetCore | undefined): string | null {
	if (widget === undefined) return null;
	const text =
		widget.type === "text"
			? widget.text
			: widget.type === "metric"
				? `${widget.value ?? "unavailable"} ${widget.unit}`.trim()
				: widget.type === "chart"
					? `${widget.chartType} chart, ${widget.series.length} series`
					: widget.type === "table"
						? `${widget.columns.length} columns, ${widget.rows.length} rows`
						: `research component ${widget.componentId}`;
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

function changesOf(
	kind: string,
	before: readonly NotebookWidgetCore[],
	after: readonly NotebookWidgetCore[],
): NotebookChange[] {
	const previous = new Map(before.map((widget) => [widget.widgetId, widget] as const));
	const changes: NotebookChange[] = [];
	for (const [position, widget] of after.entries()) {
		const old = previous.get(widget.widgetId);
		if (old === undefined) {
			changes.push({
				widgetId: widget.widgetId,
				kind: kind === "duplicate" ? "duplicated" : "added",
				title: widget.title,
				before: null,
				after: preview(widget),
			});
			continue;
		}
		if (old.size !== widget.size) {
			changes.push({
				widgetId: widget.widgetId,
				kind: "resized",
				title: widget.title,
				before: old.size,
				after: widget.size,
			});
		}
		const { size: _oldSize, ...oldRest } = old;
		const { size: _newSize, ...newRest } = widget;
		if (canonicalJson(oldRest) !== canonicalJson(newRest)) {
			changes.push({
				widgetId: widget.widgetId,
				kind: "updated",
				title: widget.title,
				before: preview(old),
				after: preview(widget),
			});
		}
		if ((kind === "move" || kind === "reorder") && before[position]?.widgetId !== widget.widgetId) {
			const from = before.findIndex((candidate) => candidate.widgetId === widget.widgetId);
			// Only the widget the command names is reported as moved, not every one it displaced.
			if (changes.every((change) => change.kind !== "moved")) {
				changes.push({
					widgetId: widget.widgetId,
					kind: "moved",
					title: widget.title,
					before: `position ${from + 1}`,
					after: `position ${position + 1}`,
				});
			}
		}
	}
	return changes;
}

/**
 * Applies untrusted widget commands to `notebook`, in order, all or nothing.
 * A `remove` is refused (the owner confirms removals); so is anything the
 * command schema, the widget types or the layout rules reject.
 */
export async function applyNotebookCommands(
	notebook: Notebook,
	commands: readonly unknown[],
	context: NotebookAgentContext,
): Promise<Result<AppliedNotebookCommands, NotebookCommandFailure>> {
	if (commands.length > NOTEBOOK_LIMITS.maxCommandsPerTurn) {
		return err({
			index: NOTEBOOK_LIMITS.maxCommandsPerTurn,
			failure: {
				code: "INVALID_COMMAND",
				message: `at most ${NOTEBOOK_LIMITS.maxCommandsPerTurn} commands are applied per turn.`,
			},
		});
	}
	let widgets: readonly NotebookWidgetCore[] = notebook.widgets.map(toNotebookWidgetCore);
	let revision = 0;
	const host = createWidgetAgentHost({
		store: {
			read: async () => ok({ widgets, revision }),
			write: async (next, seen) => {
				if (seen !== revision) {
					return err({
						code: "CONFLICT",
						message: "the notebook changed; describe again.",
					} as const);
				}
				widgets = next;
				revision += 1;
				return ok({ widgets, revision });
			},
		},
		types: notebookWidgetAgentTypes(context),
		newWidgetId: context.newWidgetId,
		limits: { maxWidgets: NOTEBOOK_LIMITS.maxWidgets },
	});
	const described = await host.describe();
	if (!described.ok) return err({ index: 0, failure: described.error });
	let snapshot = described.value;
	const changes: NotebookChange[] = [];
	for (const [index, command] of commands.entries()) {
		const parsed = parseWidgetCommand(command);
		if (!parsed.ok) return err({ index, failure: parsed.error });
		if (parsed.value.kind === "remove") {
			return err({
				index,
				failure: {
					code: "INVALID_COMMAND",
					message: "removals are proposed to the owner, never applied by the assistant.",
				},
			});
		}
		const before = widgets;
		const applied = await host.apply(parsed.value);
		if (!applied.ok) return err({ index, failure: applied.error });
		snapshot = applied.value;
		changes.push(...changesOf(parsed.value.kind, before, widgets));
	}
	return ok({ widgets, snapshot, changes });
}

/**
 * Stamps the server-owned metadata onto `next`: widgets already in
 * `previous` keep `createdAt` and `origin`; a changed one gets `updatedAt =
 * now` and `revision + 1`; a new one is stamped with `now`, revision 1 and
 * `originForNew`. Never trusts metadata from the caller.
 */
export function stampNotebook(
	previous: Notebook,
	next: readonly NotebookWidgetCore[],
	now: string,
	originForNew: (widget: NotebookWidgetCore) => NotebookWidgetOrigin,
): Notebook {
	const stored = new Map(previous.widgets.map((widget) => [widget.widgetId, widget] as const));
	return {
		widgets: next.map((core): NotebookWidget => {
			const old = stored.get(core.widgetId);
			if (old === undefined) {
				return { ...core, createdAt: now, updatedAt: now, revision: 1, origin: originForNew(core) };
			}
			const unchanged = canonicalJson(toNotebookWidgetCore(old)) === canonicalJson(core);
			return {
				...core,
				createdAt: old.createdAt,
				updatedAt: unchanged ? old.updatedAt : now,
				revision: unchanged ? old.revision : old.revision + 1,
				origin: old.origin,
			};
		}),
	};
}
