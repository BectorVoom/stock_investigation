import { z } from "zod";
import {
	HOME_WIDGET_CONFIG_SHAPES,
	HOME_WIDGET_TYPE_META,
	type HomeWidget,
	type HomeWidgetType,
	homeWidgetSeriesIds,
	MARKET_LIMITS,
} from "./market.ts";
import { idSchema, isoDateSchema, isoDateTimeSchema } from "./primitives.ts";

/**
 * The Notebook of one conversation (ADR-0020): a persistent, ordered list of
 * widgets that the owner and the notebook assistant edit. It is a separate
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
	maxWidgets: 200,
	/**
	 * UTF-8 bytes of all widgets' JSON without the server-stamped metadata.
	 * The per-widget caps alone allow far more than one request may carry, so
	 * this keeps a full notebook, metadata included (under 500 bytes per
	 * widget), inside `MAX_REQUEST_BODY_BYTES`: a notebook the assistant
	 * grew is always one the owner can still save.
	 */
	maxContentBytes: 850_000,
	maxTitleChars: 120,
	/** Characters of a text widget's Markdown source (`NOTEBOOK_TEXT_MARKDOWN`). */
	maxTextChars: 8_000,
	/** Distinct market series one notebook's market widgets may name (ADR-0021). */
	maxMarketSeries: MARKET_LIMITS.maxSeries,
	maxCaptionChars: 200,
	maxUnitChars: 24,
	maxChartSeries: 6,
	maxChartPoints: 400,
	maxPointLabelChars: 40,
	maxTableColumns: 12,
	maxTableRows: 200,
	maxCellChars: 200,
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

export const notebookWidgetSizeSchema = z.enum(["small", "medium", "large"]);
export type NotebookWidgetSize = z.infer<typeof notebookWidgetSizeSchema>;

/**
 * The Home dashboard's widget types, usable in a notebook (ADR-0021). They
 * carry no data of their own: like on Home they name market series (or, for
 * the earnings calendar, read the watchlist) and render live, refreshed data
 * through the same Home widget components. `market-metric` is Home's
 * `metric`, renamed because the notebook's own `metric` is a static number.
 */
export const NOTEBOOK_MARKET_WIDGET_TYPES = [
	"market-metric",
	"line-chart",
	"stock-table",
	"indicator-table",
	"earnings-calendar",
] as const;
export type NotebookMarketWidgetType = (typeof NOTEBOOK_MARKET_WIDGET_TYPES)[number];

/** The Home widget type each notebook market widget type renders as. */
export const NOTEBOOK_MARKET_HOME_TYPE: {
	readonly [T in NotebookMarketWidgetType]: HomeWidgetType;
} = {
	"market-metric": "metric",
	"line-chart": "line-chart",
	"stock-table": "stock-table",
	"indicator-table": "indicator-table",
	"earnings-calendar": "earnings-calendar",
};

export const NOTEBOOK_WIDGET_TYPES = [
	"text",
	"metric",
	"chart",
	"table",
	"research",
	...NOTEBOOK_MARKET_WIDGET_TYPES,
] as const;
export const notebookWidgetTypeSchema = z.enum(NOTEBOOK_WIDGET_TYPES);
export type NotebookWidgetType = z.infer<typeof notebookWidgetTypeSchema>;

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

const finiteNumberSchema = z.number().finite();
const titleSchema = z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxTitleChars);
const unitSchema = z.string().trim().max(NOTEBOOK_LIMITS.maxUnitChars);

/** The generic part every widget shares (the `WidgetBase` of the package). */
const widgetCoreShape = {
	widgetId: idSchema,
	title: titleSchema,
	size: notebookWidgetSizeSchema,
};

/** Stamped by the server, never by an agent: who made it, when, how often it changed. */
const widgetMetaShape = {
	createdAt: isoDateTimeSchema,
	updatedAt: isoDateTimeSchema,
	/** 1 on creation, +1 on every change of title, size or content. */
	revision: z.number().int().positive(),
	origin: notebookWidgetOriginSchema,
};

/**
 * The rich-text format of a `text` widget (ADR-0021): a Markdown subset,
 * stored as the source string. Owner edits (the in-place editor) and the
 * notebook assistant both write it; the renderer shows exactly this subset
 * and prints anything else as literal text. A single newline inside a
 * paragraph is a line break, so plain text written before this format
 * renders as it did.
 *
 * - Headings: `# `, `## `, `### ` at the start of a line.
 * - Inline: `**bold**`, `*italic*`, `~~strike~~`, `` `code` ``,
 *   `[label](https://…)` links (only `https:`, `http:` and `mailto:`
 *   targets are links; any other target renders as plain text).
 * - Blocks: `- ` bullet lists, `1. ` numbered lists, `- [ ] ` / `- [x] `
 *   to-do items, `> ` quotes, fenced ``` code blocks, `---` dividers;
 *   paragraphs are separated by a blank line.
 * - No raw HTML, no images, no tables (use a `table` widget).
 */
export const NOTEBOOK_TEXT_MARKDOWN =
	"Markdown subset: # / ## / ### headings, **bold**, *italic*, ~~strike~~, `code`, [label](https://…) links, - bullet lists, 1. numbered lists, - [ ] / - [x] to-dos, > quotes, ``` code blocks, --- dividers; blank line between paragraphs. No HTML, images or tables.";

/** Rich text: a Markdown source in the `NOTEBOOK_TEXT_MARKDOWN` subset. */
const textContentShape = {
	type: z.literal("text"),
	text: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxTextChars),
};

/** One headline number. `value` null means "unavailable" and is shown as text. */
const metricContentShape = {
	type: z.literal("metric"),
	value: finiteNumberSchema.nullable(),
	unit: unitSchema,
	/** Change against the previous value, in `unit` (null when unknown). */
	change: finiteNumberSchema.nullable(),
	caption: z.string().trim().max(NOTEBOOK_LIMITS.maxCaptionChars),
	asOf: isoDateSchema.nullable(),
};

export const notebookChartPointSchema = z.strictObject({
	/** Category or date label on the x axis. */
	x: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxPointLabelChars),
	y: finiteNumberSchema,
});

export const notebookChartSeriesSchema = z.strictObject({
	name: z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxTitleChars),
	points: z.array(notebookChartPointSchema).min(1).max(NOTEBOOK_LIMITS.maxChartPoints),
});

/** A chart that carries its own data, so it can be edited and re-typed later. */
const chartContentShape = {
	type: z.literal("chart"),
	chartType: z.enum(["line", "bar"]),
	unit: unitSchema,
	series: z.array(notebookChartSeriesSchema).min(1).max(NOTEBOOK_LIMITS.maxChartSeries),
};

export const notebookTableCellSchema = z.union([
	z.string().max(NOTEBOOK_LIMITS.maxCellChars),
	finiteNumberSchema,
	z.null(),
]);

/** Structured rows; every row has exactly one cell per column. */
const tableContentShape = {
	type: z.literal("table"),
	columns: z
		.array(z.string().trim().min(1).max(NOTEBOOK_LIMITS.maxCellChars))
		.min(1)
		.max(NOTEBOOK_LIMITS.maxTableColumns),
	rows: z
		.array(z.array(notebookTableCellSchema).max(NOTEBOOK_LIMITS.maxTableColumns))
		.max(NOTEBOOK_LIMITS.maxTableRows),
};

/**
 * A research component of the same conversation's canvas (a report, a news
 * card, a source list…), rendered through the component registry with its
 * verification badges intact. Its content is read-only; title, size and
 * position are the owner's.
 */
const researchContentShape = {
	type: z.literal("research"),
	componentId: idSchema,
};

/** Market widgets: exactly the Home widget fields (`HOME_WIDGET_CONFIG_SHAPES`). */
const marketMetricContentShape = {
	type: z.literal("market-metric"),
	...HOME_WIDGET_CONFIG_SHAPES.metric,
};
const lineChartContentShape = {
	type: z.literal("line-chart"),
	...HOME_WIDGET_CONFIG_SHAPES["line-chart"],
};
const stockTableContentShape = {
	type: z.literal("stock-table"),
	...HOME_WIDGET_CONFIG_SHAPES["stock-table"],
};
const indicatorTableContentShape = {
	type: z.literal("indicator-table"),
	...HOME_WIDGET_CONFIG_SHAPES["indicator-table"],
};
const earningsCalendarContentShape = {
	type: z.literal("earnings-calendar"),
	...HOME_WIDGET_CONFIG_SHAPES["earnings-calendar"],
};

/** Market series one notebook widget names, in its own order (none for other types). */
export function notebookWidgetSeriesIds(widget: {
	readonly type: string;
	readonly seriesId?: string;
	readonly seriesIds?: readonly string[];
}): readonly string[] {
	if (widget.type === "market-metric")
		return widget.seriesId === undefined ? [] : [widget.seriesId];
	if (
		widget.type === "line-chart" ||
		widget.type === "stock-table" ||
		widget.type === "indicator-table"
	) {
		return widget.seriesIds ?? [];
	}
	return [];
}

/** Distinct market series of a notebook's widgets, first appearance first. */
export function notebookMarketSeriesIds(
	widgets: readonly Parameters<typeof notebookWidgetSeriesIds>[0][],
): readonly string[] {
	const seen = new Set<string>();
	for (const widget of widgets) {
		for (const seriesId of notebookWidgetSeriesIds(widget)) seen.add(seriesId);
	}
	return [...seen];
}

const seriesNotRepeated = (widget: {
	readonly type: string;
	readonly seriesId?: string;
	readonly seriesIds?: readonly string[];
}): boolean => {
	const ids = notebookWidgetSeriesIds(widget);
	return new Set(ids).size === ids.length;
};
const seriesNotRepeatedIssue = {
	message: "a widget must not repeat a series",
	path: ["seriesIds"],
};

const rowsMatchColumns = (widget: {
	readonly type: string;
	readonly columns?: readonly string[];
	readonly rows?: readonly (readonly unknown[])[];
}): boolean =>
	widget.type !== "table" ||
	(widget.rows ?? []).every((row) => row.length === (widget.columns ?? []).length);
const rowsMatchColumnsIssue = {
	message: "every table row needs exactly one cell per column",
	path: ["rows"],
};

/**
 * A widget without the server-stamped metadata: what an agent command or
 * an owner edit produces. One strict member per type.
 */
export const notebookWidgetCoreSchema = z
	.discriminatedUnion("type", [
		z.strictObject({ ...widgetCoreShape, ...textContentShape }),
		z.strictObject({ ...widgetCoreShape, ...metricContentShape }),
		z.strictObject({ ...widgetCoreShape, ...chartContentShape }),
		z.strictObject({ ...widgetCoreShape, ...tableContentShape }),
		z.strictObject({ ...widgetCoreShape, ...researchContentShape }),
		z.strictObject({ ...widgetCoreShape, ...marketMetricContentShape }),
		z.strictObject({ ...widgetCoreShape, ...lineChartContentShape }),
		z.strictObject({ ...widgetCoreShape, ...stockTableContentShape }),
		z.strictObject({ ...widgetCoreShape, ...indicatorTableContentShape }),
		z.strictObject({ ...widgetCoreShape, ...earningsCalendarContentShape }),
	])
	.refine(rowsMatchColumns, rowsMatchColumnsIssue)
	.refine(seriesNotRepeated, seriesNotRepeatedIssue);
export type NotebookWidgetCore = z.infer<typeof notebookWidgetCoreSchema>;

/** A stored widget: the core plus the metadata the server stamps. */
export const notebookWidgetSchema = z
	.discriminatedUnion("type", [
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...textContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...metricContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...chartContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...tableContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...researchContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...marketMetricContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...lineChartContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...stockTableContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...indicatorTableContentShape }),
		z.strictObject({ ...widgetCoreShape, ...widgetMetaShape, ...earningsCalendarContentShape }),
	])
	.refine(rowsMatchColumns, rowsMatchColumnsIssue)
	.refine(seriesNotRepeated, seriesNotRepeatedIssue);
export type NotebookWidget = z.infer<typeof notebookWidgetSchema>;

/** Type-specific content fields per type (everything except core and meta). */
export const NOTEBOOK_CONTENT_SHAPES = {
	text: textContentShape,
	metric: metricContentShape,
	chart: chartContentShape,
	table: tableContentShape,
	research: researchContentShape,
	"market-metric": marketMetricContentShape,
	"line-chart": lineChartContentShape,
	"stock-table": stockTableContentShape,
	"indicator-table": indicatorTableContentShape,
	"earnings-calendar": earningsCalendarContentShape,
} as const;

/** A notebook widget of one of the market types (ADR-0021). */
export type NotebookMarketWidgetCore = Extract<
	NotebookWidgetCore,
	{ readonly type: NotebookMarketWidgetType }
>;

export function isNotebookMarketWidget(
	widget: NotebookWidgetCore,
): widget is NotebookMarketWidgetCore {
	return (NOTEBOOK_MARKET_WIDGET_TYPES as readonly string[]).includes(widget.type);
}

/**
 * The Home widget a notebook market widget renders as: same id, size and
 * fields, Home's type name, and the title cut to Home's title limit (the
 * Home components use it only as an accessible name).
 */
export function notebookWidgetAsHomeWidget(widget: NotebookMarketWidgetCore): HomeWidget {
	const base = {
		widgetId: widget.widgetId,
		title: widget.title.slice(0, MARKET_LIMITS.maxWidgetTitle),
		size: widget.size,
	};
	switch (widget.type) {
		case "market-metric":
			return { ...base, type: "metric", seriesId: widget.seriesId };
		case "line-chart":
			return { ...base, type: "line-chart", seriesIds: widget.seriesIds, range: widget.range };
		case "stock-table":
			return { ...base, type: "stock-table", seriesIds: widget.seriesIds };
		case "indicator-table":
			return { ...base, type: "indicator-table", seriesIds: widget.seriesIds };
		case "earnings-calendar":
			return { ...base, type: "earnings-calendar", daysAhead: widget.daysAhead };
	}
}

/** The inverse of `notebookWidgetAsHomeWidget`: a Home widget edit back as notebook content. */
export function homeWidgetAsNotebookWidget(widget: HomeWidget): NotebookMarketWidgetCore {
	const base = { widgetId: widget.widgetId, title: widget.title, size: widget.size };
	switch (widget.type) {
		case "metric":
			return { ...base, type: "market-metric", seriesId: widget.seriesId };
		case "line-chart":
			return { ...base, type: "line-chart", seriesIds: [...widget.seriesIds], range: widget.range };
		case "stock-table":
			return { ...base, type: "stock-table", seriesIds: [...widget.seriesIds] };
		case "indicator-table":
			return { ...base, type: "indicator-table", seriesIds: [...widget.seriesIds] };
		case "earnings-calendar":
			return { ...base, type: "earnings-calendar", daysAhead: widget.daysAhead };
	}
}

/** Same as `homeWidgetSeriesIds` for the Home widget a notebook widget renders as. */
export function notebookHomeWidgetSeriesIds(widget: NotebookMarketWidgetCore): readonly string[] {
	return homeWidgetSeriesIds(notebookWidgetAsHomeWidget(widget));
}

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
const contentEncoder = new TextEncoder();

/** UTF-8 bytes of the widgets' JSON, server-stamped metadata left out (what `maxContentBytes` bounds). */
export function notebookContentBytes(widgets: readonly NotebookWidgetCore[]): number {
	let bytes = 0;
	for (const widget of widgets) {
		const fields: Readonly<Record<string, unknown>> = widget;
		// One native stringify per widget, minus each metadata member (`"key":value`
		// and its comma; the widget's own fields always remain): about twice as
		// fast as a replacer, which is called for every table cell.
		bytes += contentEncoder.encode(JSON.stringify(widget)).byteLength;
		for (const key of WIDGET_META_KEYS) {
			const value = fields[key];
			if (value === undefined) continue;
			bytes -=
				contentEncoder.encode(`${JSON.stringify(key)}:${JSON.stringify(value)}`).byteLength + 1;
		}
	}
	return bytes;
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
	next: readonly NotebookWidgetCore[],
	previous: readonly NotebookWidgetCore[],
): NotebookCapacityProblem | null {
	if (next.length > NOTEBOOK_LIMITS.maxWidgets) {
		return {
			code: "TOO_MANY_WIDGETS",
			message: `A notebook holds at most ${NOTEBOOK_LIMITS.maxWidgets} widgets. Remove one before adding another.`,
		};
	}
	const series = notebookMarketSeriesIds(next).length;
	if (
		series > NOTEBOOK_LIMITS.maxMarketSeries &&
		series > notebookMarketSeriesIds(previous).length
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

const LIVE_DATA_NOTE =
	"Live data: names market series by id and is refreshed from the provider, like the Home widget of the same kind; it never carries numbers of its own.";

/** Notebook metadata of a market widget type, read from Home's one table. */
function marketMeta(
	homeType: HomeWidgetType,
	label?: string,
): {
	readonly label: string;
	readonly description: string;
	readonly defaultSize: NotebookWidgetSize;
	readonly sizes: readonly NotebookWidgetSize[];
} {
	const meta = HOME_WIDGET_TYPE_META[homeType];
	return {
		label: label ?? meta.label,
		description:
			homeType === "earnings-calendar"
				? `${meta.description} Live data from the Watchlist page.`
				: `${meta.description} ${LIVE_DATA_NOTE}`,
		defaultSize: meta.defaultSize,
		sizes: meta.sizes,
	};
}

/** Label, description and allowed sizes per type: one table for the UI and the agent layer. */
export const NOTEBOOK_WIDGET_TYPE_META: {
	readonly [T in NotebookWidgetType]: {
		readonly label: string;
		readonly description: string;
		readonly defaultSize: NotebookWidgetSize;
		readonly sizes: readonly NotebookWidgetSize[];
	};
} = {
	text: {
		label: "Text",
		description: `Editable rich text: notes, explanations, summaries. ${NOTEBOOK_TEXT_MARKDOWN}`,
		defaultSize: "medium",
		sizes: ["small", "medium", "large"],
	},
	metric: {
		label: "Metric",
		description: "One headline number with unit, change and as-of date.",
		defaultSize: "small",
		sizes: ["small", "medium", "large"],
	},
	chart: {
		label: "Chart",
		description: "A line or bar chart that carries its own series data.",
		defaultSize: "medium",
		sizes: ["small", "medium", "large"],
	},
	table: {
		label: "Table",
		description: "Structured rows under named columns.",
		defaultSize: "medium",
		sizes: ["small", "medium", "large"],
	},
	research: {
		label: "Research result",
		description:
			"A research component of this conversation (report, news card, source list), shown read-only with its verification badges. Agents cannot create this type.",
		defaultSize: "large",
		sizes: ["medium", "large"],
	},
	"market-metric": marketMeta("metric", "Market metric"),
	"line-chart": marketMeta("line-chart"),
	"stock-table": marketMeta("stock-table"),
	"indicator-table": marketMeta("indicator-table"),
	"earnings-calendar": marketMeta("earnings-calendar"),
};

/* ---------- Owner API ---------- */

/** One recorded change of an assistant turn, for the chat card (preview/diff). */
export const notebookChangeSchema = z.strictObject({
	widgetId: idSchema,
	kind: z.enum(["added", "updated", "moved", "resized", "duplicated"]),
	title: titleSchema,
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
		.array(z.strictObject({ widgetId: idSchema, title: titleSchema }))
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
