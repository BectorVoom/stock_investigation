import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./primitives.ts";
import {
	distinctWidgetSeriesIds,
	WIDGET_CONTENT_SHAPES,
	WIDGET_CORE_SHAPE,
	WIDGET_LIMITS,
	type WidgetCore,
	widgetChartSourcesMatch,
	widgetChartSourcesMatchIssue,
	widgetContentBytes,
	widgetRowsMatchColumns,
	widgetRowsMatchColumnsIssue,
	widgetSeriesNotRepeated,
	widgetSeriesNotRepeatedIssue,
	widgetTitleSchema,
} from "./widgets.ts";

/**
 * The Notebook of one conversation (ADR-0020): a persistent, ordered list of
 * widgets of the one widget specification (`widgets.ts`, ADR-0024) that the
 * owner and the notebook assistant edit. It is a separate
 * document from the research canvas: canvas components are what research
 * runs produced (verified, agent-arranged); notebook widgets are what the
 * owner chose to keep and develop. A widget saved from a chat answer or a
 * canvas component is a self-contained copy of its data with provenance,
 * never a screenshot and never a live reference to a mutable record.
 *
 * Every widget has the four fields `@research/widget-grid` needs
 * (`widgetId`, `type`, `title`, `size`), so the grid, the frame, the drag
 * engine and the agent layer take notebook widgets as they are.
 */

export const NOTEBOOK_LIMITS = {
	...WIDGET_LIMITS,
	maxWidgets: 200,
	/** Bounds one owner instruction to the notebook assistant. */
	maxInstructionChars: 2_000,
	/** At most this many selected widgets travel with one instruction. */
	maxSelectedWidgets: 12,
	/** At most this many commands are applied from one assistant turn. */
	maxCommandsPerTurn: 12,
	maxReplyChars: 2_000,
	/** Undo depth: earlier notebook bodies kept per conversation. */
	maxRevisions: 20,
	/** Assistant turns returned with the notebook, newest last. */
	maxTurnsReturned: 30,
} as const;

/**
 * Where a widget came from. `owner`: made in the Notebook. `assistant`: made
 * by a notebook-assistant turn (`runId` is that turn). `chat`: saved by the
 * owner from a chat answer (`messageId`) or a canvas component
 * (`componentId`, with the producing `runId` when known).
 */
export const notebookWidgetOriginSchema = z.strictObject({
	kind: z.enum(["owner", "assistant", "chat"]),
	messageId: idSchema.nullable(),
	runId: idSchema.nullable(),
	componentId: idSchema.nullable(),
});
export type NotebookWidgetOrigin = z.infer<typeof notebookWidgetOriginSchema>;

/** Stamped by the server, never by an agent: who made it, when, how often it changed. */
const widgetMetaShape = {
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
	/** 1 on creation, +1 on every change of title, size or content. */
	revision: z.number().int().positive(),
	origin: notebookWidgetOriginSchema,
};

const C = WIDGET_CORE_SHAPE;
const M = widgetMetaShape;
const S = WIDGET_CONTENT_SHAPES;

/**
 * A stored notebook widget: a widget core of the one specification
 * (ADR-0024) plus the metadata the server stamps.
 */
export const notebookWidgetSchema = z
	.discriminatedUnion("type", [
		z.strictObject({ ...C, ...M, ...S.text }),
		z.strictObject({ ...C, ...M, ...S.metric }),
		z.strictObject({ ...C, ...M, ...S.chart }),
		z.strictObject({ ...C, ...M, ...S.table }),
		z.strictObject({ ...C, ...M, ...S.research }),
		z.strictObject({ ...C, ...M, ...S["market-metric"] }),
		z.strictObject({ ...C, ...M, ...S["line-chart"] }),
		z.strictObject({ ...C, ...M, ...S["stock-table"] }),
		z.strictObject({ ...C, ...M, ...S["indicator-table"] }),
		z.strictObject({ ...C, ...M, ...S["earnings-calendar"] }),
		z.strictObject({ ...C, ...M, ...S["scheduled-tasks"] }),
		z.strictObject({ ...C, ...M, ...S["task-result"] }),
		z.strictObject({ ...C, ...M, ...S["watchlist-prices"] }),
	])
	.refine(widgetRowsMatchColumns, widgetRowsMatchColumnsIssue)
	.refine(widgetSeriesNotRepeated, widgetSeriesNotRepeatedIssue)
	.refine(widgetChartSourcesMatch, widgetChartSourcesMatchIssue);
export type NotebookWidget = z.infer<typeof notebookWidgetSchema>;

export const notebookSchema = z
	.strictObject({
		widgets: z.array(notebookWidgetSchema).max(NOTEBOOK_LIMITS.maxWidgets),
	})
	.refine(
		(notebook) =>
			new Set(notebook.widgets.map((widget) => widget.widgetId)).size === notebook.widgets.length,
		{ message: "widget ids must be distinct", path: ["widgets"] },
	);
export type Notebook = z.infer<typeof notebookSchema>;

export const EMPTY_NOTEBOOK: Notebook = { widgets: [] };

const WIDGET_META_KEYS: readonly string[] = Object.keys(widgetMetaShape);

/** UTF-8 bytes of the widgets' JSON, server-stamped metadata left out (what `maxContentBytes` bounds). */
export function notebookContentBytes(widgets: readonly WidgetCore[]): number {
	return widgetContentBytes(widgets, WIDGET_META_KEYS);
}

export interface NotebookCapacityProblem {
	readonly code: "TOO_MANY_WIDGETS" | "NOTEBOOK_TOO_LARGE" | "TOO_MANY_SERIES";
	readonly message: string;
}

/**
 * Why `next` cannot be stored, or null. One rule for the owner's saves, the
 * assistant's commands (runner and API) and the client. A notebook already
 * over the byte cap may still shrink or be rearranged; it may not grow.
 */
export function notebookCapacityProblem(
	next: readonly WidgetCore[],
	previous: readonly WidgetCore[],
): NotebookCapacityProblem | null {
	if (next.length > NOTEBOOK_LIMITS.maxWidgets) {
		return {
			code: "TOO_MANY_WIDGETS",
			message: `A notebook holds at most ${NOTEBOOK_LIMITS.maxWidgets} widgets. Remove one before adding another.`,
		};
	}
	const series = distinctWidgetSeriesIds(next).length;
	if (
		series > NOTEBOOK_LIMITS.maxMarketSeries &&
		series > distinctWidgetSeriesIds(previous).length
	) {
		return {
			code: "TOO_MANY_SERIES",
			message: `A notebook's market widgets name at most ${NOTEBOOK_LIMITS.maxMarketSeries} distinct series. Remove a series before adding another.`,
		};
	}
	const bytes = notebookContentBytes(next);
	if (bytes > NOTEBOOK_LIMITS.maxContentBytes && bytes > notebookContentBytes(previous)) {
		return {
			code: "NOTEBOOK_TOO_LARGE",
			message: `A notebook holds at most ${Math.floor(NOTEBOOK_LIMITS.maxContentBytes / 1000)} KB of widget content. Remove a widget or shorten a large table, chart or text first.`,
		};
	}
	return null;
}

/* ---------- Owner API ---------- */

/** One recorded change of an assistant turn, for the chat card (preview/diff). */
export const notebookChangeSchema = z.strictObject({
	widgetId: idSchema,
	kind: z.enum(["added", "updated", "moved", "resized", "duplicated"]),
	title: widgetTitleSchema,
	/** Short plain-text rendering before / after (text widgets: the text, truncated). */
	before: z.string().max(600).nullable(),
	after: z.string().max(600).nullable(),
});
export type NotebookChange = z.infer<typeof notebookChangeSchema>;

/**
 * The outcome of one notebook-assistant turn (`runId` is its job).
 * `appliedVersion` is the notebook version the turn produced, null when it
 * applied nothing. Removals are never applied by the assistant: they are
 * returned in `proposedRemovals` for the owner to confirm.
 */
export const notebookTurnSchema = z.strictObject({
	runId: idSchema,
	baseVersion: z.number().int().nonnegative(),
	appliedVersion: z.number().int().positive().nullable(),
	changes: z.array(notebookChangeSchema).max(NOTEBOOK_LIMITS.maxCommandsPerTurn * 2),
	proposedRemovals: z
		.array(z.strictObject({ widgetId: idSchema, title: widgetTitleSchema }))
		.max(NOTEBOOK_LIMITS.maxCommandsPerTurn),
	failure: z
		.strictObject({ code: z.string().min(1).max(80), message: z.string().max(400) })
		.nullable(),
	createdAt: isoDateTimeSchema,
});
export type NotebookTurn = z.infer<typeof notebookTurnSchema>;

export const notebookResponseSchema = z.strictObject({
	workspaceId: idSchema,
	notebook: notebookSchema,
	/** 0 for a conversation whose notebook was never saved. */
	version: z.number().int().nonnegative(),
	updatedAt: isoDateTimeSchema.nullable(),
	/** True when an earlier body is kept, so `undo` at this version restores it. */
	undoAvailable: z.boolean(),
	/** The latest assistant turns, oldest first. */
	turns: z.array(notebookTurnSchema).max(NOTEBOOK_LIMITS.maxTurnsReturned),
});
export type NotebookResponse = z.infer<typeof notebookResponseSchema>;

/**
 * Owner save with compare-and-set. The server keeps `createdAt`/`origin` of
 * widgets it already stores, stamps `updatedAt`/`revision` of changed ones,
 * and stamps new ones (the client's `origin` of a new widget is kept).
 */
export const putNotebookRequestSchema = z.strictObject({
	notebook: notebookSchema,
	expectedVersion: z.number().int().nonnegative(),
});
export type PutNotebookRequest = z.infer<typeof putNotebookRequestSchema>;

/** Restores the body kept before `expectedVersion`, as a new version. */
export const undoNotebookRequestSchema = z.strictObject({
	expectedVersion: z.number().int().positive(),
});
export type UndoNotebookRequest = z.infer<typeof undoNotebookRequestSchema>;

/** An instruction to the notebook assistant (Idempotency-Key header required). */
export const notebookAssistRequestSchema = z.strictObject({
	instruction: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxInstructionChars),
	/** The explicit context target; empty means "the notebook as a whole". */
	selectedWidgetIds: z.array(idSchema).max(NOTEBOOK_LIMITS.maxSelectedWidgets),
	/** The notebook version the owner was looking at. */
	notebookVersion: z.number().int().nonnegative(),
});
export type NotebookAssistRequest = z.infer<typeof notebookAssistRequestSchema>;
