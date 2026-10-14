import {
	HOME_WIDGET_TYPE_META,
	HOME_WIDGET_TYPES,
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
 * `size`) — there is no second hand-written schema to drift. Members are
 * keyed by their own discriminator value, so the order of the contract's
 * members no longer matters. Label, description and default size come from
 * the one shared table (`HOME_WIDGET_TYPE_META`); only the series-id help
 * and the limits are written here, beside the `build`/`configOf` code they
 * describe.
 */

const GENERIC_FIELDS = { type: true, widgetId: true, title: true, size: true } as const;

function toJsonObject(generated: unknown, type: HomeWidgetType): JsonObject {
	if (!isJsonObject(generated)) {
		throw new Error(`the "${type}" widget config schema is not an object schema.`);
	}
	return generated;
}

/**
 * One pass over the contract's members, keyed by each member's own
 * discriminator value, so the order of the contract's members no longer
 * matters. Every member shares the generic fields, so the union is read
 * through one structural interface and `.omit` stays callable without a
 * cast; the stored key is always the member's own discriminator. Any
 * `HomeWidgetType` without a member fails fast at startup with the type
 * named, instead of describing the wrong type.
 */
interface ContractMember {
	readonly shape: { readonly type: { readonly value: HomeWidgetType } };
	omit(mask: typeof GENERIC_FIELDS): z.ZodType;
}

const configSchemaByType = new Map<HomeWidgetType, JsonObject>();
for (const member of homeWidgetSchema.options) {
	const contractMember: ContractMember = member;
	const type = contractMember.shape.type.value;
	configSchemaByType.set(
		type,
		toJsonObject(z.toJSONSchema(contractMember.omit(GENERIC_FIELDS)), type),
	);
}
for (const type of HOME_WIDGET_TYPES) {
	if (configSchemaByType.get(type) === undefined) {
		throw new Error(`homeWidgetSchema has no "${type}" widget member.`);
	}
}

function configSchemaFor(type: HomeWidgetType): JsonObject {
	const found = configSchemaByType.get(type);
	if (found === undefined) {
		throw new Error(`homeWidgetSchema has no "${type}" widget member.`);
	}
	return found;
}

const metricConfigSchema = configSchemaFor("metric");
const lineChartConfigSchema = configSchemaFor("line-chart");
const stockTableConfigSchema = configSchemaFor("stock-table");
const indicatorTableConfigSchema = configSchemaFor("indicator-table");
const earningsCalendarConfigSchema = configSchemaFor("earnings-calendar");

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
