import {
	HOME_WIDGET_TYPE_META,
	type HomeWidget,
	type HomeWidgetType,
	homeWidgetSchema,
} from "@research/contracts";
import { isJsonObject, type JsonObject, type WidgetAgentType } from "@research/widget-grid/agent";
import { err, ok, type Result } from "@research/widget-grid/core";
import { z } from "zod";

/**
 * The Home dashboard's widget types as the agent layer sees them (ADR-0019):
 * one `WidgetAgentType<HomeWidget>` per Home widget type. The `configSchema`
 * of each type is generated with `z.toJSONSchema` from the matching member of
 * `homeWidgetSchema` minus the generic fields (`type`, `widgetId`, `title`,
 * `size`) — there is no second hand-written schema to drift. Each member is
 * taken by position and checked by its discriminator, so a reordered contract
 * fails fast at startup instead of describing the wrong type. Label,
 * description and default size come from the one shared table
 * (`HOME_WIDGET_TYPE_META`); only the series-id help and the limits are
 * written here, beside the `build`/`configOf` code they describe.
 */

const GENERIC_FIELDS = { type: true, widgetId: true, title: true, size: true } as const;

function checkedMember(index: number, type: HomeWidgetType): void {
	const member = homeWidgetSchema.options[index];
	if (member === undefined || member.shape.type.value !== type) {
		throw new Error(`homeWidgetSchema member ${index} is not a "${type}" widget.`);
	}
}

function toJsonObject(generated: unknown, type: HomeWidgetType): JsonObject {
	if (!isJsonObject(generated)) {
		throw new Error(`the "${type}" widget config schema is not an object schema.`);
	}
	return generated;
}

checkedMember(0, "metric");
const metricMember = homeWidgetSchema.options[0];
if (metricMember === undefined) throw new Error("homeWidgetSchema member 0 is missing.");
const metricConfigSchema = toJsonObject(
	z.toJSONSchema(metricMember.omit(GENERIC_FIELDS)),
	"metric",
);

checkedMember(1, "line-chart");
const lineChartMember = homeWidgetSchema.options[1];
if (lineChartMember === undefined) throw new Error("homeWidgetSchema member 1 is missing.");
const lineChartConfigSchema = toJsonObject(
	z.toJSONSchema(lineChartMember.omit(GENERIC_FIELDS)),
	"line-chart",
);

checkedMember(2, "stock-table");
const stockTableMember = homeWidgetSchema.options[2];
if (stockTableMember === undefined) throw new Error("homeWidgetSchema member 2 is missing.");
const stockTableConfigSchema = toJsonObject(
	z.toJSONSchema(stockTableMember.omit(GENERIC_FIELDS)),
	"stock-table",
);

checkedMember(3, "indicator-table");
const indicatorTableMember = homeWidgetSchema.options[3];
if (indicatorTableMember === undefined) throw new Error("homeWidgetSchema member 3 is missing.");
const indicatorTableConfigSchema = toJsonObject(
	z.toJSONSchema(indicatorTableMember.omit(GENERIC_FIELDS)),
	"indicator-table",
);

checkedMember(4, "earnings-calendar");
const earningsCalendarMember = homeWidgetSchema.options[4];
if (earningsCalendarMember === undefined) throw new Error("homeWidgetSchema member 4 is missing.");
const earningsCalendarConfigSchema = toJsonObject(
	z.toJSONSchema(earningsCalendarMember.omit(GENERIC_FIELDS)),
	"earnings-calendar",
);

interface DraftWidget {
	readonly widgetId: string;
	readonly title: string;
	readonly size: HomeWidget["size"];
	readonly config: JsonObject;
}

/**
 * Validates an assembled widget against the contract. The generic fields stay
 * authoritative (a same-named config key cannot smuggle another value in, and
 * no stray `config` key reaches the strict object); issues become one
 * sentence naming the offending field, so the agent knows what to change.
 */
function buildHomeWidget(type: HomeWidgetType, draft: DraftWidget): Result<HomeWidget, string> {
	const parsed = homeWidgetSchema.safeParse({
		...draft.config,
		widgetId: draft.widgetId,
		title: draft.title,
		size: draft.size,
		type,
	});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		if (issue === undefined) {
			return err(`invalid ${type} widget: the widget is not an object.`);
		}
		const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "widget";
		return err(`invalid ${type} widget: "${field}" ${issue.message}.`);
	}
	return ok(parsed.data);
}

const SERIES_ID_HELP =
	"A series id looks like `fred:<FRED series id>` such as `fred:VIXCLS`, or `twelve-data:<symbol>` such as `twelve-data:AAPL` or `twelve-data:XAU/USD`.";

function entry(options: {
	readonly type: HomeWidgetType;
	readonly configSchema: JsonObject;
	readonly series: string;
	readonly configOf: (widget: HomeWidget) => JsonObject;
}): WidgetAgentType<HomeWidget> {
	const meta = HOME_WIDGET_TYPE_META[options.type];
	return {
		type: options.type,
		label: meta.label,
		description: `${meta.description} ${options.series}`,
		defaultSize: meta.defaultSize,
		sizes: meta.sizes,
		configSchema: options.configSchema,
		build: (draft) => buildHomeWidget(options.type, draft),
		configOf: (widget) => {
			if (widget.type !== options.type) {
				throw new Error(`widget "${widget.widgetId}" is not a ${options.type} widget.`);
			}
			return options.configOf(widget);
		},
	};
}

function mismatch(type: HomeWidgetType, widget: HomeWidget): Error {
	return new Error(`widget "${widget.widgetId}" is not a ${type} widget.`);
}

export const HOME_WIDGET_AGENT_TYPES: readonly WidgetAgentType<HomeWidget>[] = [
	entry({
		type: "metric",
		configSchema: metricConfigSchema,
		series: `Exactly 1 series. ${SERIES_ID_HELP}`,
		configOf: (widget) => {
			if (widget.type !== "metric") throw mismatch("metric", widget);
			return { seriesId: widget.seriesId };
		},
	}),
	entry({
		type: "line-chart",
		configSchema: lineChartConfigSchema,
		series: `From 1 to 4 series sharing one unit. ${SERIES_ID_HELP}`,
		configOf: (widget) => {
			if (widget.type !== "line-chart") throw mismatch("line-chart", widget);
			return { seriesIds: [...widget.seriesIds], range: widget.range };
		},
	}),
	entry({
		type: "stock-table",
		configSchema: stockTableConfigSchema,
		series: `From 1 to 12 series. ${SERIES_ID_HELP}`,
		configOf: (widget) => {
			if (widget.type !== "stock-table") throw mismatch("stock-table", widget);
			return { seriesIds: [...widget.seriesIds] };
		},
	}),
	entry({
		type: "indicator-table",
		configSchema: indicatorTableConfigSchema,
		series: `From 1 to 12 series. ${SERIES_ID_HELP}`,
		configOf: (widget) => {
			if (widget.type !== "indicator-table") throw mismatch("indicator-table", widget);
			return { seriesIds: [...widget.seriesIds] };
		},
	}),
	entry({
		type: "earnings-calendar",
		configSchema: earningsCalendarConfigSchema,
		series:
			"No market series: it shows the Watchlist page's upcoming earnings dates. Choose daysAhead (30, 60, 90 or 180).",
		configOf: (widget) => {
			if (widget.type !== "earnings-calendar") throw mismatch("earnings-calendar", widget);
			return { daysAhead: widget.daysAhead };
		},
	}),
];
