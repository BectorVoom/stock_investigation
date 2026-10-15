import { type HomeWidget, homeDashboardSchema, idSchema, MARKET_LIMITS } from "@research/contracts";
import {
	createMcpToolServer,
	createWidgetAgentHost,
	createWidgetAgentTools,
	type McpToolServer,
	type WidgetAgentFailure,
} from "@research/widget-grid/agent";
import { err, ok, type Result } from "@research/widget-grid/core";
import { createHomeDashboardStore, type HomeStoreFetch } from "./homeStore.ts";
import { HOME_WIDGET_AGENT_TYPES } from "./homeWidgetTypes.ts";

/**
 * The Home MCP server over a supplied store (ADR-0019): store → host → tools
 * → `createMcpToolServer`. `validateLayout` runs the contract's
 * `homeDashboardSchema`, so the 30-series limit and the "no repeated series"
 * rule come back as a clear `INVALID_WIDGET` before any write; `newWidgetId`
 * produces ids the contract's `idSchema` accepts. `main.ts` adds only the
 * stdio transport.
 */

export const HOME_MCP_SERVER_NAME = "research-home-widgets";
export const HOME_MCP_SERVER_VERSION = "0.1.0";

export interface CreateHomeMcpServerOptions {
	readonly apiOrigin: string;
	readonly fetch?: HomeStoreFetch;
	readonly timeoutMs?: number;
}

function layoutFailure(widgets: readonly HomeWidget[]): Result<void, WidgetAgentFailure> {
	const parsed = homeDashboardSchema.safeParse({ schemaVersion: 2, widgets: [...widgets] });
	if (parsed.success) return ok(undefined);
	const issue = parsed.error.issues[0];
	if (issue === undefined) {
		return err({ code: "INVALID_WIDGET", message: "the resulting dashboard is invalid." });
	}
	const field = issue.path.length > 0 ? issue.path.map(String).join(".") : "dashboard";
	return err({
		code: "INVALID_WIDGET",
		message: `the resulting dashboard is invalid: "${field}" ${issue.message}.`,
	});
}

let widgetSeq = 0;

/** Fresh ids the contract accepts (`idSchema`): `w-` plus time, randomness and a counter. */
export function newHomeWidgetId(): string {
	widgetSeq += 1;
	const random = Math.floor(Math.random() * 36 * 36 * 36)
		.toString(36)
		.padStart(3, "0");
	const candidate = `w-mcp-${Date.now().toString(36)}-${widgetSeq.toString(36)}${random}`;
	if (!idSchema.safeParse(candidate).success) {
		throw new Error("the new widget id was rejected by the contract.");
	}
	return candidate;
}

export function createHomeMcpServer(options: CreateHomeMcpServerOptions): McpToolServer {
	const store = createHomeDashboardStore({
		apiOrigin: options.apiOrigin,
		fetch: options.fetch,
		timeoutMs: options.timeoutMs,
	});
	const host = createWidgetAgentHost<HomeWidget, number>({
		store,
		types: HOME_WIDGET_AGENT_TYPES,
		limits: { maxWidgets: MARKET_LIMITS.maxWidgets },
		validateLayout: (widgets) => {
			const checked = layoutFailure(widgets);
			if (!checked.ok) return err(checked.error.message);
			return ok(undefined);
		},
		newWidgetId: newHomeWidgetId,
	});
	return createMcpToolServer({
		name: HOME_MCP_SERVER_NAME,
		version: HOME_MCP_SERVER_VERSION,
		tools: createWidgetAgentTools(host),
	});
}
