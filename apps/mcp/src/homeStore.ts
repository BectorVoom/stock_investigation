import {
	apiErrorBodySchema,
	asHomeWidget,
	CSRF_HEADER,
	CSRF_HEADER_VALUE,
	type HomeWidget,
	hasChartProvenance,
	homeDashboardResponseSchema,
	withEarnedChartProvenance,
} from "@research/contracts";
import type {
	WidgetAgentFailure,
	WidgetLayoutRecord,
	WidgetLayoutStore,
} from "@research/widget-grid/agent";
import { err, ok, type Result } from "@research/widget-grid/core";

/**
 * The Home dashboard as a widget-layout store (ADR-0019): `read` is
 * `GET /home/dashboard` (the version is the revision), `write` is the
 * versioned `PUT`, so every agent edit passes the same schema validation, the
 * same limits and the same audit log as an edit made in the browser. No new
 * API route. Writes are never retried here: a retried PUT after an unknown
 * outcome could conflict with itself — the agent re-describes and retries.
 */

export type HomeStoreFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CreateHomeDashboardStoreOptions {
	readonly apiOrigin: string;
	readonly fetch?: HomeStoreFetch;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function unreachable(apiOrigin: string, timeoutMs: number, timedOut: boolean): WidgetAgentFailure {
	return {
		code: "STORE_UNAVAILABLE",
		message: timedOut
			? `the workspace API at ${apiOrigin} did not answer within ${Math.round(timeoutMs / 1000)} s; it seems not to be running.`
			: `the workspace API at ${apiOrigin} could not be reached; it seems not to be running.`,
	};
}

function badAnswer(apiOrigin: string, status: number): WidgetAgentFailure {
	return {
		code: "STORE_UNAVAILABLE",
		message: `the workspace API at ${apiOrigin} answered HTTP ${status} without a usable dashboard; it may not be running correctly.`,
	};
}

/** The body as JSON, or null when it is empty, not JSON, or unreadable. Never throws. */
async function readJsonBody(response: Response): Promise<unknown> {
	try {
		const text = await response.text();
		if (text === "") return null;
		return JSON.parse(text);
	} catch {
		return null;
	}
}

export function createHomeDashboardStore(
	options: CreateHomeDashboardStoreOptions,
): WidgetLayoutStore<HomeWidget, number> {
	const apiOrigin = options.apiOrigin.replace(/\/+$/, "");
	const fetchImpl: HomeStoreFetch =
		options.fetch ?? ((input, init) => globalThis.fetch(input, init));
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const dashboardUrl = `${apiOrigin}/api/v1/home/dashboard`;

	// The dashboard as last read or written, so a write can be checked
	// against the page the agent's commands started from (ADR-0026).
	let lastSeen: WidgetLayoutRecord<HomeWidget, number> | null = null;

	const read = async (): Promise<
		Result<WidgetLayoutRecord<HomeWidget, number>, WidgetAgentFailure>
	> => {
		let response: Response;
		try {
			response = await fetchImpl(dashboardUrl, {
				method: "GET",
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (cause) {
			const timedOut = cause instanceof Error && cause.name === "TimeoutError";
			return err(unreachable(apiOrigin, timeoutMs, timedOut));
		}
		const body: unknown = await readJsonBody(response);
		if (response.status !== 200 || body === null) return err(badAnswer(apiOrigin, response.status));
		const parsed = homeDashboardResponseSchema.safeParse(body);
		if (!parsed.success) return err(badAnswer(apiOrigin, response.status));
		lastSeen = { widgets: [...parsed.data.dashboard.widgets], revision: parsed.data.version };
		return ok(lastSeen);
	};

	const write = async (
		widgets: readonly HomeWidget[],
		revision: number,
	): Promise<Result<WidgetLayoutRecord<HomeWidget, number>, WidgetAgentFailure>> => {
		// ADR-0026: provenance the agent did not carry over unchanged is
		// removed before the write. Only a page that carries provenance at all
		// needs the page it started from; ordinary writes cost no extra request.
		let toWrite = widgets;
		if (hasChartProvenance(widgets)) {
			if (lastSeen === null || lastSeen.revision !== revision) {
				const current = await read();
				if (!current.ok) return current;
			}
			toWrite = withEarnedChartProvenance(widgets, lastSeen?.widgets ?? []).flatMap((widget) => {
				const home = asHomeWidget(widget);
				return home === null ? [] : [home];
			});
		}
		let response: Response;
		try {
			response = await fetchImpl(dashboardUrl, {
				method: "PUT",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Origin: apiOrigin,
					[CSRF_HEADER]: CSRF_HEADER_VALUE,
				},
				body: JSON.stringify({
					dashboard: { schemaVersion: 2, widgets: [...toWrite] },
					expectedVersion: revision,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (cause) {
			const timedOut = cause instanceof Error && cause.name === "TimeoutError";
			return err(unreachable(apiOrigin, timeoutMs, timedOut));
		}
		const body: unknown = await readJsonBody(response);
		if (response.status === 200 && body !== null) {
			const parsed = homeDashboardResponseSchema.safeParse(body);
			if (parsed.success) {
				lastSeen = { widgets: [...parsed.data.dashboard.widgets], revision: parsed.data.version };
				return ok(lastSeen);
			}
			return err(badAnswer(apiOrigin, response.status));
		}
		if (body !== null) {
			const failure = apiErrorBodySchema.safeParse(body);
			if (failure.success) {
				const { code, message } = failure.data.error;
				if (response.status === 409 && code === "VERSION_CONFLICT") {
					return err({
						code: "CONFLICT",
						message: "the dashboard changed elsewhere; describe again and retry.",
					});
				}
				if (code === "VALIDATION_FAILED") {
					return err({
						code: "INVALID_WIDGET",
						message: `the workspace refused the dashboard: ${message}`,
					});
				}
			}
		}
		return err(badAnswer(apiOrigin, response.status));
	};

	return { read, write };
}
