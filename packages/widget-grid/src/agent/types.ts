import type { Result, WidgetBase, WidgetSize } from "../core/index.ts";

/**
 * The agent layer: how an AI agent reads and rearranges a widget grid.
 *
 * It is transport-neutral. A host builds a `WidgetAgentHost` over wherever
 * its widgets are stored, turns it into `WidgetAgentTool`s, and hands those
 * to whatever runs its agent — an MCP server, a function-calling loop, a
 * page-level tool registry. Nothing here touches the DOM or the network.
 *
 * Fail closed (ARCH-017): a command is applied only when it parses against
 * the versioned command schema, names a registered widget type, builds a
 * widget the host accepts, and yields a layout the host accepts. Anything
 * else is a typed failure and the stored layout is untouched.
 */

/** Version of the command protocol; a snapshot states the version it speaks. */
export const WIDGET_AGENT_PROTOCOL_VERSION = 1;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * One instruction from an agent. A discriminated union on `kind`; unknown
 * kinds and unknown fields are rejected.
 *
 * - `add`: a new widget of a registered `type`. `size` defaults to the type's
 *   default size; `config` is the type-specific configuration (the type's
 *   `configSchema`); `toIndex` is the 0-based position it should end at
 *   (default: last).
 * - `remove`: delete one widget.
 * - `move`: swap with the neighbour one position earlier or later.
 * - `reorder`: the widget ends at `toIndex` (0-based) of the result and the
 *   others keep their relative order — exactly what a drop does.
 * - `resize`: change the size to one the widget's type allows.
 * - `update`: rename and/or reconfigure. `config` keys replace the widget's
 *   current values key by key (a shallow merge); keys not given are kept.
 */
export type WidgetCommand =
	| {
			readonly kind: "add";
			readonly type: string;
			readonly title: string;
			readonly size?: WidgetSize;
			readonly config?: JsonObject;
			readonly toIndex?: number;
	  }
	| { readonly kind: "remove"; readonly widgetId: string }
	| {
			readonly kind: "move";
			readonly widgetId: string;
			readonly direction: "earlier" | "later";
	  }
	| { readonly kind: "reorder"; readonly widgetId: string; readonly toIndex: number }
	| { readonly kind: "resize"; readonly widgetId: string; readonly size: WidgetSize }
	| {
			readonly kind: "update";
			readonly widgetId: string;
			readonly title?: string;
			readonly config?: JsonObject;
	  };

export type WidgetCommandKind = WidgetCommand["kind"];

/** Stable failure codes an agent can branch on. */
export type WidgetAgentFailureCode =
	/** The input did not match the command schema. */
	| "INVALID_COMMAND"
	| "UNKNOWN_WIDGET_TYPE"
	| "SIZE_NOT_ALLOWED"
	/** The widget type or the host rejected the widget or the resulting layout. */
	| "INVALID_WIDGET"
	| "WIDGET_NOT_FOUND"
	| "DUPLICATE_WIDGET_ID"
	| "MOVE_AT_END"
	| "POSITION_OUT_OF_RANGE"
	| "TOO_MANY_WIDGETS"
	/** The layout changed between read and write; describe again and retry. */
	| "CONFLICT"
	/** The store could not be read or written. */
	| "STORE_UNAVAILABLE"
	| "UNKNOWN_TOOL";

export interface WidgetAgentFailure {
	readonly code: WidgetAgentFailureCode;
	/** One sentence an agent (or a person reading its log) can act on. */
	readonly message: string;
}

/**
 * One widget type as the agent layer sees it: what to tell an agent about it,
 * and how to build and read a widget of it. The Solid registry entry (label,
 * component…) is separate; a host usually derives both from one table.
 */
export interface WidgetAgentType<W extends WidgetBase> {
	readonly type: string;
	readonly label: string;
	readonly description: string;
	readonly defaultSize: WidgetSize;
	/** Sizes this type may take (non-empty). */
	readonly sizes: readonly WidgetSize[];
	/** JSON Schema of `config`, shown to agents verbatim. */
	readonly configSchema: JsonObject;
	/**
	 * Builds a validated widget from the generic fields plus `config`. The
	 * error text is shown to the agent, so it should say what to change.
	 */
	readonly build: (draft: {
		readonly widgetId: string;
		readonly title: string;
		readonly size: WidgetSize;
		readonly config: JsonObject;
	}) => Result<W, string>;
	/** The type-specific part of a widget as JSON (the inverse of `build`). */
	readonly configOf: (widget: W) => JsonObject;
}

/** A stored layout plus the revision a write must present (compare-and-set). */
export interface WidgetLayoutRecord<W extends WidgetBase, Revision> {
	readonly widgets: readonly W[];
	readonly revision: Revision;
}

/**
 * Where the widgets live. `write` must reject with `CONFLICT` when
 * `revision` is no longer current, so two writers never overwrite each other
 * silently.
 */
export interface WidgetLayoutStore<W extends WidgetBase, Revision> {
	readonly read: () => Promise<Result<WidgetLayoutRecord<W, Revision>, WidgetAgentFailure>>;
	readonly write: (
		widgets: readonly W[],
		revision: Revision,
	) => Promise<Result<WidgetLayoutRecord<W, Revision>, WidgetAgentFailure>>;
}

export interface WidgetSnapshotWidget {
	readonly widgetId: string;
	readonly type: string;
	readonly title: string;
	readonly size: WidgetSize;
	/** 0-based position in reading order. */
	readonly position: number;
	readonly config: JsonObject;
}

export interface WidgetSnapshotType {
	readonly type: string;
	readonly label: string;
	readonly description: string;
	readonly defaultSize: WidgetSize;
	readonly sizes: readonly WidgetSize[];
	readonly configSchema: JsonObject;
}

export interface WidgetSnapshotSize {
	readonly size: WidgetSize;
	/** The shape in words, e.g. "2 × 2". */
	readonly shape: string;
	/** Cells covered on a narrow and on a wide screen. */
	readonly narrow: { readonly columns: number; readonly rows: number };
	readonly wide: { readonly columns: number; readonly rows: number };
}

/** Everything an agent needs to decide its next command. Plain JSON. */
export interface WidgetSnapshot {
	readonly protocolVersion: typeof WIDGET_AGENT_PROTOCOL_VERSION;
	readonly grid: {
		readonly narrowColumns: number;
		readonly wideColumns: number;
		readonly maxWidgets: number;
		readonly sizes: readonly WidgetSnapshotSize[];
	};
	readonly widgetTypes: readonly WidgetSnapshotType[];
	/** In reading order (position 0 first). */
	readonly widgets: readonly WidgetSnapshotWidget[];
}

/** The two things an agent can do, independent of how it is connected. */
export interface WidgetAgentHost {
	readonly describe: () => Promise<Result<WidgetSnapshot, WidgetAgentFailure>>;
	/**
	 * Validates and applies one command, given as untrusted input, and
	 * returns the layout after it. All or nothing.
	 */
	readonly apply: (command: unknown) => Promise<Result<WidgetSnapshot, WidgetAgentFailure>>;
}

/**
 * One callable tool in the shape agent runtimes share (MCP `tools/list`
 * entries, function-calling definitions and WebMCP `registerTool` all take a
 * name, a description and a JSON Schema for the input).
 */
export interface WidgetAgentTool {
	readonly name: string;
	/** Short human-readable name. */
	readonly title: string;
	readonly description: string;
	/** JSON Schema (an object schema) of the tool input. */
	readonly inputSchema: JsonObject;
	/** True when the tool only reads. */
	readonly readOnly: boolean;
	/** Never throws: failures come back as `ok: false`. */
	readonly execute: (input: unknown) => Promise<WidgetAgentToolResult>;
}

export type WidgetAgentToolResult =
	| { readonly ok: true; readonly snapshot: WidgetSnapshot }
	| { readonly ok: false; readonly error: WidgetAgentFailure };
