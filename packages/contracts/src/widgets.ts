import {
	type DashboardWidget,
	dashboardWidgetSeriesIds,
	distinctDashboardSeriesIds,
	type JsonObject,
} from "@research/domain";
import { z } from "zod";
import {
	earningsCalendarDaysAheadSchema,
	MARKET_LIMITS,
	marketRangeSchema,
	marketSeriesIdSchema,
} from "./market.ts";
import { idSchema, isoDateSchema, isoDateTimeSchema } from "./primitives.ts";
import { evidenceSchema } from "./records.ts";

/**
 * The one widget specification of the app (ADR-0024): every type, its
 * fields, its label, description and sizes, and the generic core every
 * widget has — the same on Home and in the Notebook. Home takes every type
 * but `research` (`HOME_WIDGET_TYPES`); the Notebook takes all of them.
 *
 * Every widget has the four fields `@research/widget-grid` needs
 * (`widgetId`, `type`, `title`, `size`), so the grid, the frame, the drag
 * engine and the agent layer take any widget as it is.
 */

export const WIDGET_LIMITS = {
	/** One title rule for every widget (the domain's dashboard bound). */
	minTitleChars: MARKET_LIMITS.minWidgetTitle,
	maxTitleChars: MARKET_LIMITS.maxWidgetTitle,
	/** Characters of a text widget's Markdown source (`WIDGET_TEXT_MARKDOWN`). */
	maxTextChars: 8_000,
	maxCaptionChars: 200,
	maxUnitChars: 24,
	maxChartSeries: 6,
	maxChartPoints: 400,
	maxPointLabelChars: 40,
	/** Evidence copies one chart widget may carry (ADR-0026); a research component cites at most 40. */
	maxChartSources: 60,
	maxChartSourceIds: 40,
	maxTableColumns: 12,
	maxTableRows: 200,
	maxCellChars: 200,
	/** Distinct market series one page's market widgets may name (Home or one notebook). */
	maxMarketSeries: MARKET_LIMITS.maxSeries,
	/**
	 * UTF-8 bytes of all widgets' JSON without server-stamped metadata
	 * (`widgetContentBytes`). The per-widget caps alone allow far more than
	 * one request may carry, so this keeps a full page, metadata included
	 * (under 500 bytes per widget), inside `MAX_REQUEST_BODY_BYTES`.
	 */
	maxContentBytes: 850_000,
} as const;

export const widgetSizeSchema = z.enum(["small", "medium", "large"]);
export type WidgetSize = z.infer<typeof widgetSizeSchema>;

/** Every size, in picker order. */
export const WIDGET_SIZES: readonly WidgetSize[] = ["small", "medium", "large"];

/** The live market types: they name market series (or read the watchlist) and carry no numbers. */
export const MARKET_WIDGET_TYPES = [
	"market-metric",
	"line-chart",
	"stock-table",
	"indicator-table",
	"earnings-calendar",
] as const;
export type MarketWidgetType = (typeof MARKET_WIDGET_TYPES)[number];

/** Every widget type, in add-menu order. */
export const WIDGET_TYPES = [
	"text",
	"metric",
	"chart",
	"table",
	"research",
	...MARKET_WIDGET_TYPES,
] as const;
export const widgetTypeSchema = z.enum(WIDGET_TYPES);
export type WidgetType = z.infer<typeof widgetTypeSchema>;

/** The types Home takes: all but `research`, which shows one conversation's canvas component. */
export const HOME_WIDGET_TYPES = [
	"text",
	"metric",
	"chart",
	"table",
	...MARKET_WIDGET_TYPES,
] as const;
export type HomeWidgetType = (typeof HOME_WIDGET_TYPES)[number];

const finiteNumberSchema = z.number().finite();
export const widgetTitleSchema = z
	.string()
	.trim()
	.min(WIDGET_LIMITS.minTitleChars)
	.max(WIDGET_LIMITS.maxTitleChars);
const unitSchema = z.string().trim().max(WIDGET_LIMITS.maxUnitChars);
/** Optional axis titles of a `chart` widget, kept from the Chat component it was saved from. */
const chartAxisLabelSchema = z.string().trim().min(1).max(WIDGET_LIMITS.maxTitleChars).optional();
/** Optional x column kind of a `chart` widget (absent = "text"); line charts position dates/numbers by value. */
const chartXKindSchema = z.enum(["text", "number", "date"]).optional();

/** The generic part every widget shares (the `WidgetBase` of the package). */
export const WIDGET_CORE_SHAPE = {
	widgetId: idSchema,
	title: widgetTitleSchema,
	size: widgetSizeSchema,
};

/**
 * The rich-text format of a `text` widget (ADR-0021): a Markdown subset,
 * stored as the source string. Owner edits (the in-place editor) and agents
 * both write it; the renderer shows exactly this subset and prints anything
 * else as literal text. A single newline inside a paragraph is a line break,
 * so plain text written before this format renders as it did.
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
export const WIDGET_TEXT_MARKDOWN =
	"Markdown subset: # / ## / ### headings, **bold**, *italic*, ~~strike~~, `code`, [label](https://…) links, - bullet lists, 1. numbered lists, - [ ] / - [x] to-dos, > quotes, ``` code blocks, --- dividers; blank line between paragraphs. No HTML, images or tables.";

/**
 * One plotted value with the provenance a dataset cell has (ADR-0026): an
 * `assumption` or `derived` basis, or a cited source with its as-of date. A
 * point with neither is shown as a number whose basis is not stated.
 */
export const widgetChartPointSchema = z
	.strictObject({
		/** Category or date label on the x axis. */
		x: z.string().trim().min(1).max(WIDGET_LIMITS.maxPointLabelChars),
		y: finiteNumberSchema,
		basis: z.enum(["assumption", "derived"]).optional(),
		/** An evidence id this widget carries a copy of in `sources`. */
		sourceId: idSchema.optional(),
		asOf: z.union([isoDateSchema, isoDateTimeSchema]).optional(),
	})
	.refine((point) => point.sourceId === undefined || point.asOf !== undefined, {
		message: "a sourced value must carry an as-of date",
		path: ["asOf"],
	});

export const widgetChartSeriesSchema = z.strictObject({
	name: z.string().trim().min(1).max(WIDGET_LIMITS.maxTitleChars),
	points: z.array(widgetChartPointSchema).min(1).max(WIDGET_LIMITS.maxChartPoints),
});

export const widgetTableCellSchema = z.union([
	z.string().max(WIDGET_LIMITS.maxCellChars),
	finiteNumberSchema,
	z.null(),
]);

/** Type-specific fields per type (the discriminator included; everything but the core). */
export const WIDGET_CONTENT_SHAPES = {
	/** Rich text: a Markdown source in the `WIDGET_TEXT_MARKDOWN` subset. */
	text: {
		type: z.literal("text"),
		text: z.string().trim().min(1).max(WIDGET_LIMITS.maxTextChars),
	},
	/** One headline number. `value` null means "unavailable" and is shown as text. */
	metric: {
		type: z.literal("metric"),
		value: finiteNumberSchema.nullable(),
		unit: unitSchema,
		/** Change against the previous value, in `unit` (null when unknown). */
		change: finiteNumberSchema.nullable(),
		caption: z.string().trim().max(WIDGET_LIMITS.maxCaptionChars),
		asOf: isoDateSchema.nullable(),
	},
	/** A chart that carries its own data, so it can be edited and re-typed later. */
	chart: {
		type: z.literal("chart"),
		chartType: z.enum(["line", "bar"]),
		unit: unitSchema,
		series: z.array(widgetChartSeriesSchema).min(1).max(WIDGET_LIMITS.maxChartSeries),
		xLabel: chartAxisLabelSchema,
		yLabel: chartAxisLabelSchema,
		xKind: chartXKindSchema,
		/** The chart's own citations, as a research component's `sourceIds`. */
		sourceIds: z.array(idSchema).max(WIDGET_LIMITS.maxChartSourceIds).optional(),
		/**
		 * A copy of every evidence record the chart cites (points and
		 * `sourceIds`), so it renders the same on any page. The API accepts a
		 * copy only when it equals the owner's stored record (ADR-0026).
		 */
		sources: z.array(evidenceSchema).max(WIDGET_LIMITS.maxChartSources).optional(),
	},
	/** Structured rows; every row has exactly one cell per column. */
	table: {
		type: z.literal("table"),
		columns: z
			.array(z.string().trim().min(1).max(WIDGET_LIMITS.maxCellChars))
			.min(1)
			.max(WIDGET_LIMITS.maxTableColumns),
		rows: z
			.array(z.array(widgetTableCellSchema).max(WIDGET_LIMITS.maxTableColumns))
			.max(WIDGET_LIMITS.maxTableRows),
	},
	/**
	 * A research component of the same conversation's canvas (a report, a
	 * news card, a source list…), rendered through the component registry
	 * with its verification badges intact. Its content is read-only; title,
	 * size and position are the owner's. Notebook only.
	 */
	research: {
		type: z.literal("research"),
		componentId: idSchema,
	},
	/** One live series: latest value, change, one-year change and a sparkline. */
	"market-metric": {
		type: z.literal("market-metric"),
		seriesId: marketSeriesIdSchema,
	},
	"line-chart": {
		type: z.literal("line-chart"),
		seriesIds: z.array(marketSeriesIdSchema).min(1).max(MARKET_LIMITS.maxLineChartSeries),
		range: marketRangeSchema,
	},
	"stock-table": {
		type: z.literal("stock-table"),
		seriesIds: z.array(marketSeriesIdSchema).min(1).max(MARKET_LIMITS.maxTableSeries),
	},
	"indicator-table": {
		type: z.literal("indicator-table"),
		seriesIds: z.array(marketSeriesIdSchema).min(1).max(MARKET_LIMITS.maxTableSeries),
	},
	/**
	 * Earnings-date calendar (FR-018): the watchlist's upcoming announcements
	 * within `daysAhead`. No market series — every series walk treats it as
	 * zero series.
	 */
	"earnings-calendar": {
		type: z.literal("earnings-calendar"),
		daysAhead: earningsCalendarDaysAheadSchema,
	},
} as const;

/** The content fields of one type without its discriminator: an agent's `config`. */
export function widgetContentSchema(type: WidgetType): z.ZodType {
	const { type: _discriminator, ...content } = WIDGET_CONTENT_SHAPES[type];
	return z.strictObject(content);
}

/* ---------- Refinements every widget schema applies ---------- */

/**
 * Market series one widget names, in its own order (none for the content
 * types and the earnings calendar): the domain's one rule.
 */
export const widgetSeriesIds: (widget: DashboardWidget) => readonly string[] =
	dashboardWidgetSeriesIds;

/** Distinct market series of a page's widgets, first appearance first: the domain's one rule. */
export const distinctWidgetSeriesIds: (widgets: readonly DashboardWidget[]) => readonly string[] =
	distinctDashboardSeriesIds;

export const widgetSeriesNotRepeated = (widget: DashboardWidget): boolean => {
	const ids = widgetSeriesIds(widget);
	return new Set(ids).size === ids.length;
};
export const widgetSeriesNotRepeatedIssue = {
	message: "a widget must not repeat a series",
	path: ["seriesIds"],
};

export const widgetRowsMatchColumns = (widget: {
	readonly type: string;
	readonly columns?: readonly string[];
	readonly rows?: readonly (readonly unknown[])[];
}): boolean =>
	widget.type !== "table" ||
	(widget.rows ?? []).every((row) => row.length === (widget.columns ?? []).length);
/** Every evidence id a `chart` widget cites: its `sourceIds`, then its points', first appearance first. */
export function chartWidgetCitedIds(widget: {
	readonly sourceIds?: readonly string[];
	readonly series: readonly { readonly points: readonly { readonly sourceId?: string }[] }[];
}): readonly string[] {
	const ids = new Set(widget.sourceIds ?? []);
	for (const series of widget.series) {
		for (const point of series.points) if (point.sourceId !== undefined) ids.add(point.sourceId);
	}
	return [...ids];
}

type ChartPointLike = {
	readonly x: string;
	readonly y: number;
	readonly basis?: string;
	readonly sourceId?: string;
	readonly asOf?: string;
};
type ChartLike = {
	readonly type: string;
	readonly title: string;
	readonly sourceIds?: readonly string[];
	readonly series?: readonly { readonly points: readonly ChartPointLike[] }[];
};

function hasProvenance(point: ChartPointLike): boolean {
	return point.basis !== undefined || point.sourceId !== undefined || point.asOf !== undefined;
}

function provenanceKey(point: ChartPointLike): string {
	return JSON.stringify([
		point.x,
		point.y,
		point.basis ?? null,
		point.sourceId ?? null,
		point.asOf ?? null,
	]);
}

/**
 * ADR-0026: an AI agent (the notebook assistant, the Home MCP server) never
 * adds provenance. Every chart point it writes with a basis, source or as-of
 * date must already be on the page, identical (label, value and provenance),
 * and every chart `sourceIds` entry must already be cited there — so a real
 * citation cannot be attached to a number the agent made up. Returns the
 * title of the first chart that breaks the rule, or null.
 */
export function chartProvenanceAddedTo(
	next: readonly ChartLike[],
	previous: readonly ChartLike[],
): string | null {
	const knownPoints = new Set<string>();
	const knownSourceIds = new Set<string>();
	for (const widget of previous) {
		if (widget.type !== "chart") continue;
		for (const id of widget.sourceIds ?? []) knownSourceIds.add(id);
		for (const series of widget.series ?? []) {
			for (const point of series.points) {
				if (hasProvenance(point)) knownPoints.add(provenanceKey(point));
			}
		}
	}
	for (const widget of next) {
		if (widget.type !== "chart") continue;
		if ((widget.sourceIds ?? []).some((id) => !knownSourceIds.has(id))) return widget.title;
		for (const series of widget.series ?? []) {
			for (const point of series.points) {
				if (hasProvenance(point) && !knownPoints.has(provenanceKey(point))) return widget.title;
			}
		}
	}
	return null;
}

/** Why an agent's write that adds provenance to a chart is refused (ADR-0026). */
export function chartProvenanceRefusal(title: string): string {
	return `chart "${title}" would gain a source, basis or as-of date; only values copied from research carry them, so keep such points exactly as they are and add new points without them.`;
}

const chartCitationsShape = z.object({
	sourceIds: z.array(z.string()).optional(),
	series: z.array(z.object({ points: z.array(z.object({ sourceId: z.string().optional() })) })),
	sources: z.array(z.object({ evidenceId: z.string() })),
});

/**
 * An agent's chart config with the source copies its series no longer cite
 * left out, so changing a chart's numbers does not fail the "one copy per
 * citation" rule; a config of any other shape is returned as it is.
 */
export function pruneUncitedChartSources(config: JsonObject): JsonObject {
	const shape = chartCitationsShape.safeParse(config);
	const sources = config.sources;
	if (!shape.success || !Array.isArray(sources)) return config;
	const cited = new Set(chartWidgetCitedIds(shape.data));
	const kept = sources.filter((_, index) => {
		const id = shape.data.sources[index]?.evidenceId;
		return id !== undefined && cited.has(id);
	});
	return { ...config, sources: kept };
}

/** A chart carries exactly one copy of each record it cites, and no uncited copy. */
export const widgetChartSourcesMatch = (widget: {
	readonly type: string;
	readonly sourceIds?: readonly string[];
	readonly series?: readonly { readonly points: readonly { readonly sourceId?: string }[] }[];
	readonly sources?: readonly { readonly evidenceId: string }[];
}): boolean => {
	if (widget.type !== "chart" || widget.series === undefined) return true;
	const cited = chartWidgetCitedIds({ sourceIds: widget.sourceIds, series: widget.series });
	const copies = (widget.sources ?? []).map((source) => source.evidenceId);
	const copySet = new Set(copies);
	return (
		copySet.size === copies.length &&
		copies.length === cited.length &&
		cited.every((id) => copySet.has(id))
	);
};
export const widgetChartSourcesMatchIssue = {
	message: "a chart must carry exactly one copy of each source it cites, and no other",
	path: ["sources"],
};

export const widgetRowsMatchColumnsIssue = {
	message: "every table row needs exactly one cell per column",
	path: ["rows"],
};

/* ---------- The core ---------- */

const C = WIDGET_CORE_SHAPE;
const S = WIDGET_CONTENT_SHAPES;

/**
 * A widget without server-stamped metadata: what an agent command, an owner
 * edit or a Home dashboard holds. One strict member per type.
 */
export const widgetCoreSchema = z
	.discriminatedUnion("type", [
		z.strictObject({ ...C, ...S.text }),
		z.strictObject({ ...C, ...S.metric }),
		z.strictObject({ ...C, ...S.chart }),
		z.strictObject({ ...C, ...S.table }),
		z.strictObject({ ...C, ...S.research }),
		z.strictObject({ ...C, ...S["market-metric"] }),
		z.strictObject({ ...C, ...S["line-chart"] }),
		z.strictObject({ ...C, ...S["stock-table"] }),
		z.strictObject({ ...C, ...S["indicator-table"] }),
		z.strictObject({ ...C, ...S["earnings-calendar"] }),
	])
	.refine(widgetRowsMatchColumns, widgetRowsMatchColumnsIssue)
	.refine(widgetSeriesNotRepeated, widgetSeriesNotRepeatedIssue)
	.refine(widgetChartSourcesMatch, widgetChartSourcesMatchIssue);
export type WidgetCore = z.infer<typeof widgetCoreSchema>;

/** A widget of one of the live market types. */
export type MarketWidgetCore = Extract<WidgetCore, { readonly type: MarketWidgetType }>;

export function isMarketWidget<W extends { readonly type: string }>(
	widget: W,
): widget is Extract<W, { readonly type: MarketWidgetType }> {
	return (MARKET_WIDGET_TYPES as readonly string[]).includes(widget.type);
}

/** The Home widget: every type but `research`, the same fields and rules. */
export const homeWidgetSchema = z
	.discriminatedUnion("type", [
		z.strictObject({ ...C, ...S.text }),
		z.strictObject({ ...C, ...S.metric }),
		z.strictObject({ ...C, ...S.chart }),
		z.strictObject({ ...C, ...S.table }),
		z.strictObject({ ...C, ...S["market-metric"] }),
		z.strictObject({ ...C, ...S["line-chart"] }),
		z.strictObject({ ...C, ...S["stock-table"] }),
		z.strictObject({ ...C, ...S["indicator-table"] }),
		z.strictObject({ ...C, ...S["earnings-calendar"] }),
	])
	.refine(widgetRowsMatchColumns, widgetRowsMatchColumnsIssue)
	.refine(widgetSeriesNotRepeated, widgetSeriesNotRepeatedIssue)
	.refine(widgetChartSourcesMatch, widgetChartSourcesMatchIssue);
export type HomeWidget = z.infer<typeof homeWidgetSchema>;

export function isHomeWidgetType(type: string): type is HomeWidgetType {
	return (HOME_WIDGET_TYPES as readonly string[]).includes(type);
}

/** The core as a Home widget, or null for a type Home does not take (`research`). */
export function asHomeWidget(widget: WidgetCore): HomeWidget | null {
	return widget.type === "research" ? null : widget;
}

/* ---------- Content bytes ---------- */

const contentEncoder = new TextEncoder();

/**
 * UTF-8 bytes of the widgets' JSON, the named metadata keys left out (what
 * `WIDGET_LIMITS.maxContentBytes` bounds). One native stringify per widget,
 * minus each metadata member (`"key":value` and its comma; the widget's own
 * fields always remain): about twice as fast as a replacer, which is called
 * for every table cell.
 */
export function widgetContentBytes(
	widgets: readonly Readonly<Record<string, unknown>>[],
	metadataKeys: readonly string[] = [],
): number {
	let bytes = 0;
	for (const fields of widgets) {
		bytes += contentEncoder.encode(JSON.stringify(fields)).byteLength;
		for (const key of metadataKeys) {
			const value = fields[key];
			if (value === undefined) continue;
			bytes -=
				contentEncoder.encode(`${JSON.stringify(key)}:${JSON.stringify(value)}`).byteLength + 1;
		}
	}
	return bytes;
}

/* ---------- Presentation and agent metadata ---------- */

export interface WidgetTypeMeta {
	readonly label: string;
	/** What the owner reads (the market dialog's help line). */
	readonly description: string;
	/** What an agent also needs to write the type (format, series-id syntax, options). */
	readonly agentNote: string;
	readonly defaultSize: WidgetSize;
	readonly sizes: readonly WidgetSize[];
}

const SERIES_ID_HELP =
	"A series id looks like `fred:<FRED series id>` such as `fred:VIXCLS`, or `twelve-data:<symbol>` such as `twelve-data:AAPL` or `twelve-data:XAU/USD`.";
const LIVE_DATA_NOTE =
	"Live data: names market series by id and is refreshed from the provider; it never carries numbers of its own.";

/**
 * The one table of per-type presentation facts (ADR-0024): both pages' add
 * menus and dialogs, the MCP Home agent types and the notebook assistant
 * read their label, description, default size and sizes from here.
 */
export const WIDGET_TYPE_META: { readonly [T in WidgetType]: WidgetTypeMeta } = {
	text: {
		label: "Text",
		description: "Editable rich text: notes, explanations, summaries.",
		agentNote: WIDGET_TEXT_MARKDOWN,
		defaultSize: "medium",
		sizes: WIDGET_SIZES,
	},
	metric: {
		label: "Metric",
		description: "One headline number with unit, change and as-of date.",
		agentNote: "It carries its own value; for a live market value use market-metric.",
		defaultSize: "small",
		sizes: WIDGET_SIZES,
	},
	chart: {
		label: "Chart",
		description: "A line or bar chart that carries its own series data.",
		agentNote: "For live market data over time use line-chart.",
		defaultSize: "medium",
		sizes: WIDGET_SIZES,
	},
	table: {
		label: "Table",
		description: "Structured rows under named columns.",
		agentNote: "Every row has exactly one cell per column.",
		defaultSize: "medium",
		sizes: WIDGET_SIZES,
	},
	research: {
		label: "Research result",
		description:
			"A research component of this conversation (report, news card, source list), shown read-only with its verification badges.",
		agentNote: "Agents cannot create this type.",
		defaultSize: "large",
		sizes: ["medium", "large"],
	},
	"market-metric": {
		label: "Market metric",
		description: "One series: latest value, change, one-year change and a sparkline.",
		agentNote: `Exactly 1 series. ${LIVE_DATA_NOTE} ${SERIES_ID_HELP}`,
		defaultSize: "small",
		sizes: WIDGET_SIZES,
	},
	"line-chart": {
		label: "Line chart",
		description: "One to four series that share one unit, over a range, with a data table.",
		agentNote: `From 1 to 4 series sharing one unit. ${LIVE_DATA_NOTE} ${SERIES_ID_HELP}`,
		defaultSize: "medium",
		sizes: WIDGET_SIZES,
	},
	"stock-table": {
		label: "Stock table",
		description: "One row per series: last close, change and as-of date.",
		agentNote: `From 1 to 12 series. ${LIVE_DATA_NOTE} ${SERIES_ID_HELP}`,
		defaultSize: "medium",
		sizes: WIDGET_SIZES,
	},
	"indicator-table": {
		label: "Indicator table",
		description: "One row per series: latest, unit, previous, change and one-year change.",
		agentNote: `From 1 to 12 series. ${LIVE_DATA_NOTE} ${SERIES_ID_HELP}`,
		defaultSize: "large",
		sizes: WIDGET_SIZES,
	},
	"earnings-calendar": {
		label: "Earnings calendar",
		description:
			"A glanceable month grid of the Watchlist page's upcoming earnings announcement dates, with a short next list; calendar sync and export are in Settings.",
		agentNote:
			"No market series: it shows the Watchlist page's upcoming earnings dates. Choose daysAhead (30, 60, 90 or 180).",
		defaultSize: "large",
		sizes: WIDGET_SIZES,
	},
};

/** The description an agent reads: the owner's sentence plus how to write the type. */
export function widgetAgentDescription(type: WidgetType): string {
	const meta = WIDGET_TYPE_META[type];
	return `${meta.description} ${meta.agentNote}`;
}
