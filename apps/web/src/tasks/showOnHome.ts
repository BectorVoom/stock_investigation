import type { ScheduledTask } from "@research/contracts";
import type { ApiClient } from "../api/client.ts";
import { type ShowOnHomeOutcome, showWidgetOnHome } from "../widgets/showOnHome.ts";
import { taskResultWidget } from "../widgets/widgetModel.ts";

export type { ShowOnHomeOutcome };

/**
 * Appends a Task result widget for `task` to the Home dashboard (ADR-0038
 * §5); a dashboard already showing the task is left as it is.
 */
export function showTaskResultOnHome(
	api: ApiClient,
	task: ScheduledTask,
): Promise<ShowOnHomeOutcome> {
	return showWidgetOnHome(
		api,
		(widget) => widget.type === "task-result" && widget.taskId === task.taskId,
		() => taskResultWidget(task.taskId, task.title),
	);
}
