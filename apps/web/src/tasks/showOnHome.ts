import {
	type HomeCapacityProblem,
	type HomeWidget,
	homeCapacityProblem,
	type ScheduledTask,
} from "@research/contracts";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import { taskResultWidget } from "../widgets/widgetModel.ts";

/** What "Show result on Home" did. */
export type ShowOnHomeOutcome =
	| { readonly kind: "added" }
	| { readonly kind: "already" }
	/** Home is at one of its bounds: nothing was saved. */
	| { readonly kind: "full"; readonly problem: HomeCapacityProblem }
	| { readonly kind: "failed"; readonly failure: ApiFailure };

/**
 * A compare-and-set lost to another save (Home open in another tab) is
 * re-read and tried again this many times in all before it is reported.
 */
const MAX_ATTEMPTS = 3;

/**
 * Appends a Task result widget for `task` to the Home dashboard (ADR-0038
 * §5) through Home's own API: read the dashboard and its version, append,
 * check Home's bounds as the Home page does, save with compare-and-set. A
 * dashboard already showing the task is left as it is.
 */
export async function showTaskResultOnHome(
	api: ApiClient,
	task: ScheduledTask,
): Promise<ShowOnHomeOutcome> {
	for (let attempt = 1; ; attempt += 1) {
		const current = await api.getHomeDashboard();
		if (!current.ok) return { kind: "failed", failure: current.error };
		const widgets = current.value.dashboard.widgets;
		if (widgets.some((widget) => widget.type === "task-result" && widget.taskId === task.taskId)) {
			return { kind: "already" };
		}
		const next: HomeWidget[] = [...widgets, taskResultWidget(task.taskId, task.title)];
		const problem = homeCapacityProblem(next);
		if (problem !== null) return { kind: "full", problem };
		// The client checks the whole request against the contract before it is sent.
		const saved = await api.saveHomeDashboard(
			{ schemaVersion: 2, widgets: next },
			current.value.version,
		);
		if (saved.ok) return { kind: "added" };
		if (saved.error.code !== "VERSION_CONFLICT" || attempt >= MAX_ATTEMPTS) {
			return { kind: "failed", failure: saved.error };
		}
	}
}
