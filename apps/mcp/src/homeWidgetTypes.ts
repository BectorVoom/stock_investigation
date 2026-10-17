import {
	HOME_WIDGET_TYPES,
	type HomeWidget,
	type HomeWidgetType,
	homeWidgetSchema,
	pruneUncitedChartSources,
	WIDGET_TYPE_META,
	widgetAgentDescription,
	widgetContentSchema,
} from "@research/contracts";
import { isJsonObject, type JsonObject, type WidgetAgentType } from "@research/widget-grid/agent";
import { err, ok, type Result } from "@research/widget-grid/core";
import { z } from "zod";

/**
 * The Home dashboard's widget types as the agent layer sees them (ADR-0019,
 * ADR-0024): one `WidgetAgentType<HomeWidget>` per Home widget type, all
 * read from the one widget specification in contracts — the same tables the
 * notebook assistant reads. The `configSchema` of each type is the JSON
 * Schema of its content fields (`widgetContentSchema`); label, description
 * (series help included) and sizes come from `WIDGET_TYPE_META`. There is no
 * second hand-written schema or description to drift.
 */

const GENERIC_KEYS: ReadonlySet<string> = new Set(["widgetId", "type", "title", "size"]);

function configSchemaFor(type: HomeWidgetType): JsonObject {
	const generated: unknown = z.toJSONSchema(widgetContentSchema(type));
	if (!isJsonObject(generated)) {
		throw new Error(`the "${type}" widget config schema is not an object schema.`);
	}
	return generated;
}

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
		...(type === "chart" ? pruneUncitedChartSources(draft.config) : draft.config),
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

/** The type-specific part of a widget as JSON: everything but the four generic fields. */
function homeWidgetConfig(widget: HomeWidget): JsonObject {
	const config: { [key: string]: JsonObject[string] } = {};
	for (const [key, value] of Object.entries(widget)) {
		if (!GENERIC_KEYS.has(key)) config[key] = value;
	}
	return config;
}

export const HOME_WIDGET_AGENT_TYPES: readonly WidgetAgentType<HomeWidget>[] =
	HOME_WIDGET_TYPES.map((type) => {
		const meta = WIDGET_TYPE_META[type];
		return {
			type,
			label: meta.label,
			description: widgetAgentDescription(type),
			defaultSize: meta.defaultSize,
			sizes: meta.sizes,
			configSchema: configSchemaFor(type),
			build: (draft) => buildHomeWidget(type, draft),
			configOf: (widget) => {
				if (widget.type !== type) {
					throw new Error(`widget "${widget.widgetId}" is not a ${type} widget.`);
				}
				return homeWidgetConfig(widget);
			},
		};
	});
