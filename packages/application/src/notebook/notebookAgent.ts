import {
	type MarketWidgetCore,
	NOTEBOOK_LIMITS,
	type Notebook,
	type NotebookCapacityProblem,
	type NotebookChange,
	type NotebookWidget,
	type NotebookWidgetOrigin,
	notebookCapacityProblem,
	reconcileChartDraft,
	WIDGET_TYPE_META,
	WIDGET_TYPES,
	type WidgetCore,
	type WidgetType,
	widgetAgentDescription,
	widgetContentSchema,
	widgetCoreSchema,
	widgetOwnerPlaced,
	widgetSeriesIds,
	withEarnedChartProvenance,
} from "@research/contracts";
import {
	createWidgetAgentHost,
	isJsonObject,
	type JsonObject,
	parseWidgetCommand,
	type WidgetAgentFailure,
	type WidgetAgentType,
	type WidgetCommand,
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

function contentSchemaFor(type: WidgetType): JsonObject {
	const generated: unknown = z.toJSONSchema(widgetContentSchema(type));
	if (!isJsonObject(generated)) {
		throw new Error(`the "${type}" notebook widget config schema is not an object schema.`);
	}
	return generated;
}

const CONFIG_SCHEMAS: ReadonlyMap<WidgetType, JsonObject> = new Map(
	WIDGET_TYPES.map((type) => [type, contentSchemaFor(type)] as const),
);

/** What the agent types need from the conversation the notebook belongs to. */
export interface NotebookAgentContext {
	/** Canvas component ids of the same conversation (`research` widgets must name one). */
	readonly knownComponentIds: ReadonlySet<string>;
	readonly newWidgetId: () => string;
}

/** The type-specific part of a widget as JSON: everything but the four generic fields. */
export function notebookWidgetConfig(widget: WidgetCore): JsonObject {
	const config: { [key: string]: JsonObject[string] } = {};
	for (const [key, value] of Object.entries(widget)) {
		if (!GENERIC_KEYS.has(key)) config[key] = value;
	}
	return config;
}

function buildCore(
	type: WidgetType,
	draft: {
		readonly widgetId: string;
		readonly title: string;
		readonly size: WidgetCore["size"];
		readonly config: JsonObject;
	},
	context: NotebookAgentContext,
): Result<WidgetCore, string> {
	// Generic fields win over same-named config keys, so config cannot smuggle them in.
	const assembled = {
		...draft.config,
		widgetId: draft.widgetId,
		title: draft.title,
		size: draft.size,
		type,
	};
	const parsed = widgetCoreSchema.safeParse(
		type === "chart" ? reconcileChartDraft(assembled) : assembled,
	);
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
): readonly WidgetAgentType<WidgetCore>[] {
	return WIDGET_TYPES.map((type) => {
		const meta = WIDGET_TYPE_META[type];
		const configSchema = CONFIG_SCHEMAS.get(type);
		if (configSchema === undefined) throw new Error(`no config schema for "${type}".`);
		return {
			type,
			label: meta.label,
			description: widgetAgentDescription(type),
			defaultSize: meta.defaultSize,
			sizes: meta.sizes,
			configSchema,
			build: (draft) => buildCore(type, draft, context),
			ownerPlaced: widgetOwnerPlaced(type),
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
export function toNotebookWidgetCore(widget: NotebookWidget): WidgetCore {
	const { createdAt: _c, updatedAt: _u, revision: _r, origin: _o, ...core } = widget;
	return core;
}

export interface NotebookCommandFailure {
	/** 0-based index of the command that failed. */
	readonly index: number;
	readonly failure: WidgetAgentFailure | NotebookCapacityProblem;
}

export interface AppliedNotebookCommands {
	readonly widgets: readonly WidgetCore[];
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Equality of parsed JSON data, key order ignored and a key holding
 * `undefined` counted as absent (as `JSON.stringify` drops it). Stops at the
 * first difference and builds no strings: comparing every widget of a full
 * notebook this way is several times cheaper than comparing serialisations.
 * Widget data is schema-bounded, so the recursion is a few levels deep.
 */
function jsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left)) {
		if (!Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index += 1) {
			if (!jsonEqual(left[index], right[index])) return false;
		}
		return true;
	}
	if (!isRecord(left) || !isRecord(right)) return false;
	let leftKeys = 0;
	for (const key of Object.keys(left)) {
		if (left[key] === undefined) continue;
		leftKeys += 1;
		if (!jsonEqual(left[key], right[key])) return false;
	}
	let rightKeys = 0;
	for (const key of Object.keys(right)) {
		if (right[key] !== undefined) rightKeys += 1;
	}
	return leftKeys === rightKeys;
}

const PREVIEW_CHARS = 600;

function preview(widget: WidgetCore | undefined): string | null {
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
						: widget.type === "research"
							? `research component ${widget.componentId}`
							: widget.type === "scheduled-tasks"
								? WIDGET_TYPE_META[widget.type].label
								: widget.type === "task-result"
									? `${WIDGET_TYPE_META[widget.type].label} of task ${widget.taskId}`
									: marketPreview(widget);
	return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

/** A market widget's live content in one line: its type label and what it shows. */
function marketPreview(widget: MarketWidgetCore): string {
	const label = WIDGET_TYPE_META[widget.type].label;
	if (widget.type === "earnings-calendar") return `${label}, next ${widget.daysAhead} days`;
	const series = widgetSeriesIds(widget).join(", ");
	return widget.type === "line-chart"
		? `${label} of ${series}, ${widget.range}`
		: `${label} of ${series}`;
}

/** True when anything but the size differs (the size has its own change kind). */
function contentDiffers(old: WidgetCore, next: WidgetCore): boolean {
	return !jsonEqual({ ...old, size: next.size }, next);
}

function changesOf(
	command: WidgetCommand,
	before: readonly WidgetCore[],
	after: readonly WidgetCore[],
): NotebookChange[] {
	const previous = new Map(before.map((widget) => [widget.widgetId, widget] as const));
	const changes: NotebookChange[] = [];
	for (const widget of after) {
		const old = previous.get(widget.widgetId);
		if (old === undefined) {
			changes.push({
				widgetId: widget.widgetId,
				kind: command.kind === "duplicate" ? "duplicated" : "added",
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
		// Layout edits keep every widget they do not touch as the same object,
		// so only the edited one is compared (a full notebook is ~1 MB).
		if (old !== widget && contentDiffers(old, widget)) {
			changes.push({
				widgetId: widget.widgetId,
				kind: "updated",
				title: widget.title,
				before: preview(old),
				after: preview(widget),
			});
		}
	}
	// The widget the command names is the one reported as moved, not the
	// neighbours it displaced.
	if (command.kind === "move" || command.kind === "reorder") {
		const from = before.findIndex((widget) => widget.widgetId === command.widgetId);
		const to = after.findIndex((widget) => widget.widgetId === command.widgetId);
		const moved = after[to];
		if (moved !== undefined && from !== to) {
			changes.push({
				widgetId: moved.widgetId,
				kind: "moved",
				title: moved.title,
				before: `position ${from + 1}`,
				after: `position ${to + 1}`,
			});
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
	let widgets: readonly WidgetCore[] = notebook.widgets.map(toNotebookWidgetCore);
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
		changes.push(...changesOf(parsed.value, before, widgets));
	}
	// The widget count is the layout rule above; the byte cap is decided on
	// the turn's result, since only the whole notebook can exceed it.
	const capacity = notebookCapacityProblem(widgets, notebook.widgets);
	if (capacity !== null) return err({ index: commands.length - 1, failure: capacity });
	// ADR-0026: provenance the assistant did not carry over unchanged is
	// removed, so a real citation never ends up on a number it wrote.
	const earned = withEarnedChartProvenance(widgets, notebook.widgets.map(toNotebookWidgetCore));
	return ok({ widgets: earned, snapshot, changes });
}

/**
 * Stamps the server-owned metadata onto `next`: widgets already in
 * `previous` keep `createdAt` and `origin`; a changed one gets `updatedAt =
 * now` and `revision + 1`; a new one is stamped with `now`, revision 1 and
 * `originForNew`. Never trusts metadata from the caller.
 */
export function stampNotebook(
	previous: Notebook,
	next: readonly WidgetCore[],
	now: string,
	originForNew: (widget: WidgetCore) => NotebookWidgetOrigin,
): Notebook {
	const stored = new Map(previous.widgets.map((widget) => [widget.widgetId, widget] as const));
	return {
		widgets: next.map((core): NotebookWidget => {
			const old = stored.get(core.widgetId);
			if (old === undefined) {
				return { ...core, createdAt: now, updatedAt: now, revision: 1, origin: originForNew(core) };
			}
			const unchanged = jsonEqual(toNotebookWidgetCore(old), core);
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
