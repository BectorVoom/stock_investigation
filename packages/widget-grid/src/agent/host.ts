import {
	applyWidgetLayoutEdit,
	DEFAULT_WIDGET_LAYOUT_LIMITS,
	type WidgetLayoutEdit,
	type WidgetLayoutError,
	type WidgetLayoutLimits,
} from "../core/layout.ts";
import {
	WIDGET_GRID_METRICS,
	WIDGET_SIZE_SHAPES,
	WIDGET_SIZE_SPANS,
	WIDGET_SIZES,
} from "../core/sizes.ts";
import { err, ok, type Result, type WidgetBase } from "../core/types.ts";
import { parseWidgetCommand } from "./commands.ts";
import type {
	JsonObject,
	WidgetAgentFailure,
	WidgetAgentHost,
	WidgetAgentType,
	WidgetCommand,
	WidgetLayoutRecord,
	WidgetLayoutStore,
	WidgetSnapshot,
	WidgetSnapshotWidget,
} from "./types.ts";
import { WIDGET_AGENT_PROTOCOL_VERSION } from "./types.ts";

/**
 * The agent host: `describe` returns the snapshot an agent decides from,
 * `apply` validates and applies one untrusted command, all or nothing. Fail
 * closed: a command is applied only when it parses, names a registered type,
 * builds a widget the host accepts, yields a layout the host accepts, and the
 * store accepts the write at the revision that was read. Anything else is a
 * typed failure and the stored layout is untouched. Never throws: a throwing
 * store, `build` or `configOf` becomes a typed failure.
 */

export interface CreateWidgetAgentHostOptions<W extends WidgetBase, Revision> {
	readonly store: WidgetLayoutStore<W, Revision>;
	readonly types: readonly WidgetAgentType<W>[];
	readonly newWidgetId: () => string;
	readonly limits?: WidgetLayoutLimits;
	/** Whole-layout rules beyond the per-widget checks; a rejection names why. */
	readonly validateLayout?: (widgets: readonly W[]) => Result<void, string>;
}

function unreadableWidget(widgetId: string, type: string): WidgetAgentFailure {
	return {
		code: "INVALID_WIDGET",
		message: `widget "${widgetId}" could not be read as type "${type}".`,
	};
}

export function createWidgetAgentHost<W extends WidgetBase, Revision>(
	options: CreateWidgetAgentHostOptions<W, Revision>,
): WidgetAgentHost {
	const { store, types, newWidgetId } = options;
	const limits = options.limits ?? DEFAULT_WIDGET_LAYOUT_LIMITS;
	const validateLayout = options.validateLayout;

	const typeOf = (type: string): WidgetAgentType<W> | undefined =>
		types.find((entry) => entry.type === type);

	const snapshotOf = (widgets: readonly W[]): Result<WidgetSnapshot, WidgetAgentFailure> => {
		const snapshotWidgets: WidgetSnapshotWidget[] = [];
		for (const [position, widget] of widgets.entries()) {
			const agentType = typeOf(widget.type);
			// A widget whose stored type is not registered is still listed,
			// with an empty config; it can be moved, reordered and removed.
			let config: JsonObject = {};
			if (agentType !== undefined) {
				try {
					config = agentType.configOf(widget);
				} catch {
					return err(unreadableWidget(widget.widgetId, widget.type));
				}
			}
			snapshotWidgets.push({
				widgetId: widget.widgetId,
				type: widget.type,
				title: widget.title,
				size: widget.size,
				position,
				config,
			});
		}
		return ok({
			protocolVersion: WIDGET_AGENT_PROTOCOL_VERSION,
			grid: {
				narrowColumns: WIDGET_GRID_METRICS.narrowColumns,
				wideColumns: WIDGET_GRID_METRICS.wideColumns,
				maxWidgets: limits.maxWidgets,
				sizes: WIDGET_SIZES.map((size) => ({
					size,
					shape: WIDGET_SIZE_SHAPES[size],
					narrow: { ...WIDGET_SIZE_SPANS[size].narrow },
					wide: { ...WIDGET_SIZE_SPANS[size].wide },
				})),
			},
			widgetTypes: types.map((entry) => ({
				type: entry.type,
				label: entry.label,
				description: entry.description,
				defaultSize: entry.defaultSize,
				sizes: [...entry.sizes],
				configSchema: entry.configSchema,
			})),
			widgets: snapshotWidgets,
		});
	};

	const buildEdit = (
		command: WidgetCommand,
		widgets: readonly W[],
	): Result<WidgetLayoutEdit<W>, WidgetAgentFailure> => {
		switch (command.kind) {
			case "add": {
				const agentType = typeOf(command.type);
				if (agentType === undefined) {
					return err({
						code: "UNKNOWN_WIDGET_TYPE",
						message: `unknown widget type "${command.type}".`,
					});
				}
				const size = command.size ?? agentType.defaultSize;
				if (!agentType.sizes.includes(size)) {
					return err({
						code: "SIZE_NOT_ALLOWED",
						message: `size "${size}" is not allowed for widget type "${command.type}".`,
					});
				}
				let widgetId: string;
				try {
					widgetId = newWidgetId();
				} catch {
					return err({
						code: "STORE_UNAVAILABLE",
						message: "a new widget id could not be allocated.",
					});
				}
				if (widgetId.length === 0) {
					return err({ code: "INVALID_WIDGET", message: "the new widget id is empty." });
				}
				let widget: W;
				try {
					const built = agentType.build({
						widgetId,
						title: command.title,
						size,
						config: command.config ?? {},
					});
					if (!built.ok) return err({ code: "INVALID_WIDGET", message: built.error });
					widget = built.value;
				} catch {
					return err({
						code: "INVALID_WIDGET",
						message: `widget type "${command.type}" rejected the widget.`,
					});
				}
				return ok({ kind: "add", widget, toIndex: command.toIndex });
			}
			case "remove": {
				return ok({ kind: "remove", widgetId: command.widgetId });
			}
			case "move": {
				return ok({
					kind: "move",
					widgetId: command.widgetId,
					direction: command.direction,
				});
			}
			case "reorder": {
				return ok({ kind: "reorder", widgetId: command.widgetId, toIndex: command.toIndex });
			}
			case "resize": {
				const current = widgets.find((widget) => widget.widgetId === command.widgetId);
				if (current === undefined) {
					return err({
						code: "WIDGET_NOT_FOUND",
						message: `no widget with id "${command.widgetId}".`,
					});
				}
				const agentType = typeOf(current.type);
				if (agentType === undefined) {
					return err({
						code: "UNKNOWN_WIDGET_TYPE",
						message: `widget "${command.widgetId}" has unknown type "${current.type}".`,
					});
				}
				if (!agentType.sizes.includes(command.size)) {
					return err({
						code: "SIZE_NOT_ALLOWED",
						message: `size "${command.size}" is not allowed for widget type "${current.type}".`,
					});
				}
				return ok({ kind: "resize", widgetId: command.widgetId, size: command.size });
			}
			case "update": {
				const current = widgets.find((widget) => widget.widgetId === command.widgetId);
				if (current === undefined) {
					return err({
						code: "WIDGET_NOT_FOUND",
						message: `no widget with id "${command.widgetId}".`,
					});
				}
				const agentType = typeOf(current.type);
				if (agentType === undefined) {
					return err({
						code: "UNKNOWN_WIDGET_TYPE",
						message: `widget "${command.widgetId}" has unknown type "${current.type}".`,
					});
				}
				let config: JsonObject;
				try {
					config = { ...agentType.configOf(current), ...(command.config ?? {}) };
				} catch {
					return err(unreadableWidget(current.widgetId, current.type));
				}
				let widget: W;
				try {
					const built = agentType.build({
						widgetId: current.widgetId,
						title: command.title ?? current.title,
						size: current.size,
						config,
					});
					if (!built.ok) return err({ code: "INVALID_WIDGET", message: built.error });
					widget = built.value;
				} catch {
					return err({
						code: "INVALID_WIDGET",
						message: `widget type "${current.type}" rejected the widget.`,
					});
				}
				return ok({ kind: "replace", widget });
			}
			case "duplicate": {
				const index = widgets.findIndex((widget) => widget.widgetId === command.widgetId);
				const current = index === -1 ? undefined : widgets[index];
				if (current === undefined) {
					return err({
						code: "WIDGET_NOT_FOUND",
						message: `no widget with id "${command.widgetId}".`,
					});
				}
				const agentType = typeOf(current.type);
				if (agentType === undefined) {
					return err({
						code: "UNKNOWN_WIDGET_TYPE",
						message: `widget "${command.widgetId}" has unknown type "${current.type}".`,
					});
				}
				if (!agentType.sizes.includes(current.size)) {
					return err({
						code: "SIZE_NOT_ALLOWED",
						message: `size "${current.size}" is not allowed for widget type "${current.type}".`,
					});
				}
				// The default copy title can exceed the 200-character title
				// limit when the original is already long; trim it the same way
				// the command schema trims titles.
				const title = (command.title ?? `${current.title} (copy)`).trim().slice(0, 200);
				if (title.length === 0) {
					return err({ code: "INVALID_WIDGET", message: "the duplicate title is empty." });
				}
				let config: JsonObject;
				try {
					config = agentType.configOf(current);
				} catch {
					return err(unreadableWidget(current.widgetId, current.type));
				}
				let widgetId: string;
				try {
					widgetId = newWidgetId();
				} catch {
					return err({
						code: "STORE_UNAVAILABLE",
						message: "a new widget id could not be allocated.",
					});
				}
				if (widgetId.length === 0) {
					return err({ code: "INVALID_WIDGET", message: "the new widget id is empty." });
				}
				let widget: W;
				try {
					const built = agentType.build({
						widgetId,
						title,
						size: current.size,
						config,
					});
					if (!built.ok) return err({ code: "INVALID_WIDGET", message: built.error });
					widget = built.value;
				} catch {
					return err({
						code: "INVALID_WIDGET",
						message: `widget type "${current.type}" rejected the widget.`,
					});
				}
				// A duplicate is an `add` of a copy right after the original —
				// no new layout edit kind, so the proved Lean dashboard model
				// still covers it.
				return ok({ kind: "add", widget, toIndex: command.toIndex ?? index + 1 });
			}
		}
	};

	const layoutFailure = (
		error: WidgetLayoutError,
		command: WidgetCommand,
		count: number,
	): WidgetAgentFailure => {
		switch (error) {
			case "DUPLICATE_WIDGET_ID":
				return { code: error, message: "a widget with that id already exists." };
			case "WIDGET_NOT_FOUND": {
				const id = command.kind === "add" ? command.type : command.widgetId;
				return { code: error, message: `no widget with id "${id}".` };
			}
			case "MOVE_AT_END":
				if (command.kind === "move") {
					return {
						code: error,
						message: `widget "${command.widgetId}" cannot move "${command.direction}" from here.`,
					};
				}
				return { code: error, message: "the widget is already at that end." };
			case "POSITION_OUT_OF_RANGE": {
				const toIndex =
					command.kind === "add" || command.kind === "duplicate"
						? (command.toIndex ?? count)
						: command.kind === "reorder"
							? command.toIndex
							: count;
				return {
					code: error,
					message: `position ${toIndex} is out of range for ${count} widgets.`,
				};
			}
			case "TOO_MANY_WIDGETS":
				return {
					code: error,
					message: `the grid already holds the maximum of ${limits.maxWidgets} widgets.`,
				};
			case "INVALID_WIDGET":
				return { code: error, message: "the widget is invalid." };
		}
	};

	const describe = async (): Promise<Result<WidgetSnapshot, WidgetAgentFailure>> => {
		try {
			const read = await store.read();
			if (!read.ok) return err(read.error);
			return snapshotOf(read.value.widgets);
		} catch {
			return err({ code: "STORE_UNAVAILABLE", message: "the widget store could not be read." });
		}
	};

	const apply = async (command: unknown): Promise<Result<WidgetSnapshot, WidgetAgentFailure>> => {
		try {
			const parsed = parseWidgetCommand(command);
			if (!parsed.ok) return err(parsed.error);
			let record: WidgetLayoutRecord<W, Revision>;
			try {
				const read = await store.read();
				if (!read.ok) return err(read.error);
				record = read.value;
			} catch {
				return err({ code: "STORE_UNAVAILABLE", message: "the widget store could not be read." });
			}
			const edit = buildEdit(parsed.value, record.widgets);
			if (!edit.ok) return err(edit.error);
			const applied = applyWidgetLayoutEdit(record.widgets, edit.value, limits);
			if (!applied.ok)
				return err(layoutFailure(applied.error, parsed.value, record.widgets.length));
			if (validateLayout !== undefined) {
				let validation: Result<void, string>;
				try {
					validation = validateLayout(applied.value);
				} catch {
					return err({ code: "INVALID_WIDGET", message: "the resulting layout was rejected." });
				}
				if (!validation.ok) return err({ code: "INVALID_WIDGET", message: validation.error });
			}
			let written: WidgetLayoutRecord<W, Revision>;
			try {
				const result = await store.write(applied.value, record.revision);
				if (!result.ok) return err(result.error);
				written = result.value;
			} catch {
				return err({
					code: "STORE_UNAVAILABLE",
					message: "the widget store could not be written.",
				});
			}
			return snapshotOf(written.widgets);
		} catch {
			return err({
				code: "STORE_UNAVAILABLE",
				message: "the widget store failed before the command could be applied.",
			});
		}
	};

	return { describe, apply };
}
