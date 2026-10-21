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

function rejectedWidget(type: string): WidgetAgentFailure {
	return { code: "INVALID_WIDGET", message: `widget type "${type}" rejected the widget.` };
}

const ID_UNAVAILABLE: WidgetAgentFailure = {
	code: "STORE_UNAVAILABLE",
	message: "a new widget id could not be allocated.",
};
const STORE_UNREADABLE: WidgetAgentFailure = {
	code: "STORE_UNAVAILABLE",
	message: "the widget store could not be read.",
};

/**
 * Calls host-supplied code (`configOf`, `build`, `newWidgetId`,
 * `validateLayout`), any of which may throw; a throw becomes `failure`, so
 * the host keeps its never-throws contract in one place.
 */
function guarded<T>(run: () => T, failure: WidgetAgentFailure): Result<T, WidgetAgentFailure> {
	try {
		return ok(run());
	} catch {
		return err(failure);
	}
}

/** `guarded` for the store's promises. */
async function guardedAsync<T>(
	run: () => Promise<Result<T, WidgetAgentFailure>>,
	failure: WidgetAgentFailure,
): Promise<Result<T, WidgetAgentFailure>> {
	try {
		return await run();
	} catch {
		return err(failure);
	}
}

export function createWidgetAgentHost<W extends WidgetBase, Revision>(
	options: CreateWidgetAgentHostOptions<W, Revision>,
): WidgetAgentHost {
	const { store, types, newWidgetId } = options;
	const limits = options.limits ?? DEFAULT_WIDGET_LAYOUT_LIMITS;
	const validateLayout = options.validateLayout;

	const typeOf = (type: string): WidgetAgentType<W> | undefined =>
		types.find((entry) => entry.type === type);

	const configOf = (
		agentType: WidgetAgentType<W>,
		widget: W,
	): Result<JsonObject, WidgetAgentFailure> =>
		guarded(() => agentType.configOf(widget), unreadableWidget(widget.widgetId, widget.type));

	const allocateWidgetId = (): Result<string, WidgetAgentFailure> => {
		const allocated = guarded(newWidgetId, ID_UNAVAILABLE);
		if (allocated.ok && allocated.value.length === 0) {
			return err({ code: "INVALID_WIDGET", message: "the new widget id is empty." });
		}
		return allocated;
	};

	const buildWidget = (
		agentType: WidgetAgentType<W>,
		input: Parameters<WidgetAgentType<W>["build"]>[0],
	): Result<W, WidgetAgentFailure> => {
		const built = guarded(() => agentType.build(input), rejectedWidget(agentType.type));
		if (!built.ok) return built;
		return built.value.ok
			? ok(built.value.value)
			: err({ code: "INVALID_WIDGET", message: built.value.error });
	};

	const snapshotOf = (widgets: readonly W[]): Result<WidgetSnapshot, WidgetAgentFailure> => {
		const snapshotWidgets: WidgetSnapshotWidget[] = [];
		for (const [position, widget] of widgets.entries()) {
			const agentType = typeOf(widget.type);
			// A widget whose stored type is not registered is still listed,
			// with an empty config; it can be moved, reordered and removed.
			let config: JsonObject = {};
			if (agentType !== undefined) {
				const read = configOf(agentType, widget);
				if (!read.ok) return read;
				config = read.value;
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
				const widgetId = allocateWidgetId();
				if (!widgetId.ok) return widgetId;
				const widget = buildWidget(agentType, {
					widgetId: widgetId.value,
					title: command.title,
					size,
					config: command.config ?? {},
				});
				if (!widget.ok) return widget;
				return ok({ kind: "add", widget: widget.value, toIndex: command.toIndex });
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
				const config = configOf(agentType, current);
				if (!config.ok) return config;
				const widget = buildWidget(agentType, {
					widgetId: current.widgetId,
					title: command.title ?? current.title,
					size: current.size,
					config: { ...config.value, ...(command.config ?? {}) },
				});
				if (!widget.ok) return widget;
				return ok({ kind: "replace", widget: widget.value });
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
				const config = configOf(agentType, current);
				if (!config.ok) return config;
				const widgetId = allocateWidgetId();
				if (!widgetId.ok) return widgetId;
				const widget = buildWidget(agentType, {
					widgetId: widgetId.value,
					title,
					size: current.size,
					config: config.value,
				});
				if (!widget.ok) return widget;
				// A duplicate is an `add` of a copy right after the original —
				// no new layout edit kind, so the proved Lean dashboard model
				// still covers it.
				return ok({ kind: "add", widget: widget.value, toIndex: command.toIndex ?? index + 1 });
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

	const readRecord = (): Promise<Result<WidgetLayoutRecord<W, Revision>, WidgetAgentFailure>> =>
		guardedAsync(() => store.read(), STORE_UNREADABLE);

	const describe = async (): Promise<Result<WidgetSnapshot, WidgetAgentFailure>> => {
		const read = await readRecord();
		return read.ok ? snapshotOf(read.value.widgets) : read;
	};

	const apply = async (command: unknown): Promise<Result<WidgetSnapshot, WidgetAgentFailure>> => {
		try {
			const parsed = parseWidgetCommand(command);
			if (!parsed.ok) return err(parsed.error);
			const read = await readRecord();
			if (!read.ok) return read;
			const record = read.value;
			const edit = buildEdit(parsed.value, record.widgets);
			if (!edit.ok) return err(edit.error);
			const applied = applyWidgetLayoutEdit(record.widgets, edit.value, limits);
			if (!applied.ok)
				return err(layoutFailure(applied.error, parsed.value, record.widgets.length));
			if (validateLayout !== undefined) {
				const validation = guarded(() => validateLayout(applied.value), {
					code: "INVALID_WIDGET",
					message: "the resulting layout was rejected.",
				});
				if (!validation.ok) return validation;
				if (!validation.value.ok) {
					return err({ code: "INVALID_WIDGET", message: validation.value.error });
				}
			}
			const written = await guardedAsync(() => store.write(applied.value, record.revision), {
				code: "STORE_UNAVAILABLE",
				message: "the widget store could not be written.",
			});
			return written.ok ? snapshotOf(written.value.widgets) : written;
		} catch {
			// Last line of the never-throws contract: anything not guarded above.
			return err({
				code: "STORE_UNAVAILABLE",
				message: "the widget store failed before the command could be applied.",
			});
		}
	};

	return { describe, apply };
}
