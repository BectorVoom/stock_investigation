import type { ScheduledTask, WidgetCore } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { Empty, ErrorNotice, IconButton } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { runStateMessages } from "../i18n/runState.messages.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { chatHash, TASKS_HASH } from "../router.ts";
import { createClock } from "./clock.ts";
import { TaskEditorDialog } from "./TaskEditorDialog.tsx";
import { SkipLine, TASK_LINK, TaskOutcomeNotice } from "./TaskParts.tsx";
import { createTaskActions, type TaskActionOutcome } from "./taskActions.ts";
import { tasksMessages } from "./tasks.messages.ts";
import { tasksModelMessages } from "./tasksModel.messages.ts";
import {
	browserTimeZone,
	lastRunText,
	nextRunText,
	scheduleText,
	skipView,
	widgetTasks,
} from "./tasksModel.ts";
import { tasksStoreFor } from "./tasksStore.ts";

/**
 * The `scheduled-tasks` widget (ADR-0033 §9) on Home and in the Notebook,
 * glanceable after the Apple widget guidelines: the tasks by next run, each
 * with its title, schedule in words, next run (relative within a day), last
 * run with a link to its chat and the last skip; Pause/Resume and Run now
 * as icon buttons; New task (the Tasks page's editor) and Open Tasks in the
 * header line. Small shows the next task only, Medium up to four, Large up
 * to eight and then "N more". Everything else — editing, deleting, the
 * whole question — is the Tasks page's.
 *
 * Every widget of a page reads one shared list (`tasksStoreFor`): several
 * widgets never multiply the poll.
 */
export function ScheduledTasksWidget(props: {
	readonly widget: Extract<WidgetCore, { readonly type: "scheduled-tasks" }>;
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const m = useMessages(tasksMessages);
	const text = useMessages(tasksModelMessages);
	const runState = useMessages(runStateMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const store = tasksStoreFor(props.api, props.visibility);
	onCleanup(store.attach());
	const actions = createTaskActions(props.api, store);
	const now = createClock();
	const viewerZone = browserTimeZone();

	const [outcome, setOutcome] = createSignal<TaskActionOutcome | null>(null);
	const [editorOpen, setEditorOpen] = createSignal(false);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);

	const view = createMemo(() => widgetTasks(store.list()?.tasks ?? [], props.widget.size));
	const summary = () => {
		const list = store.list();
		if (list === null || list.tasks.length === 0) return null;
		const active = list.tasks.filter((task) => task.status === "active").length;
		return m().tasksSummary(active, list.tasks.length);
	};
	const act = async (run: () => Promise<TaskActionOutcome | null>): Promise<void> => {
		const result = await run();
		if (result !== null) setOutcome(result);
	};
	const openEditor = (event: MouseEvent) => {
		setOpener(event.currentTarget instanceof HTMLElement ? event.currentTarget : null);
		setEditorOpen(true);
	};

	return (
		<div class="flex flex-col gap-2" data-widget-kind="scheduled-tasks">
			<div class="flex flex-wrap items-center justify-between gap-2">
				<span class="text-xs font-semibold text-slate-900">{summary()}</span>
				<div class="flex items-center gap-1">
					<IconButton label={m().newTask} icon="plus-lg" onClick={openEditor} />
					<a href={TASKS_HASH} class={`${TASK_LINK} text-xs`}>
						{m().openTasks}
					</a>
				</div>
			</div>
			<Show when={store.failure()}>
				{(error) => (
					<ErrorNotice
						failure={error()}
						title={m().loadFailed}
						iconRetry
						onRetry={() => store.refresh()}
					/>
				)}
			</Show>
			<Show
				when={store.list() !== null}
				fallback={
					<Show when={store.failure() === null}>
						<output aria-busy="true" class="block text-sm text-slate-600">
							{common().loadingThing(m().tasksThing)}
						</output>
					</Show>
				}
			>
				<Show when={view().shown.length > 0} fallback={<Empty>{m().widgetEmpty}</Empty>}>
					<ul aria-label={m().taskList} class="space-y-2">
						<For each={view().shown}>
							{(task) => (
								<WidgetTaskRow
									task={task}
									busy={actions.isBusy(task.taskId)}
									onTogglePause={() =>
										void act(() => actions.setPaused(task, task.status === "active"))
									}
									onRunNow={() => void act(() => actions.runNow(task))}
								/>
							)}
						</For>
					</ul>
					<Show when={view().more > 0}>
						<a href={TASKS_HASH} class={`${TASK_LINK} text-xs`}>
							{m().more(view().more)}
						</a>
					</Show>
				</Show>
			</Show>
			<TaskOutcomeNotice outcome={outcome()} compact />
			<Show when={editorOpen()}>
				<TaskEditorDialog
					api={props.api}
					store={store}
					task={null}
					opener={opener()}
					onSaved={(task) => setOutcome({ kind: "created", title: task.title })}
					onClose={() => setEditorOpen(false)}
				/>
			</Show>
		</div>
	);

	/** One task, glanceable: what and when, how it last went, two quick actions. */
	function WidgetTaskRow(row: {
		readonly task: ScheduledTask;
		readonly busy: boolean;
		readonly onTogglePause: () => void;
		readonly onRunNow: () => void;
	}): JSX.Element {
		const skip = () => skipView(row.task, viewerZone, locale(), text());
		return (
			<li class="flex items-start justify-between gap-2" data-task-id={row.task.taskId}>
				<div class="min-w-0 space-y-0.5">
					<p class="truncate text-sm font-medium text-slate-900">{row.task.title}</p>
					<p class="text-xs text-slate-700">
						{scheduleText(row.task.schedule, row.task.timeZone, viewerZone, text())}
					</p>
					<p class="text-xs text-slate-800" data-field="task-next-run">
						{nextRunText(row.task, now(), viewerZone, locale(), text())}
					</p>
					<p class="flex flex-wrap items-center gap-x-2 text-xs text-slate-700">
						<span data-field="task-last-run">
							{lastRunText(row.task, (state) => runState().name(state), text())}
						</span>
						<a
							href={chatHash(row.task.workspaceId)}
							class={TASK_LINK}
							aria-label={m().openChatNamed(row.task.title)}
						>
							{m().openChat}
						</a>
					</p>
					<Show when={skip()}>{(current) => <SkipLine skip={current()} compact />}</Show>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<Show when={row.task.status !== "completed"}>
						<IconButton
							label={
								row.task.status === "active"
									? m().pauseNamed(row.task.title)
									: m().resumeNamed(row.task.title)
							}
							icon={row.task.status === "active" ? "pause-fill" : "play-fill"}
							disabled={row.busy}
							onClick={() => row.onTogglePause()}
						/>
					</Show>
					<IconButton
						label={m().runNowNamed(row.task.title)}
						icon="lightning-charge"
						disabled={row.busy}
						onClick={() => row.onRunNow()}
					/>
				</div>
			</li>
		);
	}
}
