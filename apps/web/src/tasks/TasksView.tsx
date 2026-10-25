import type { ScheduledTask } from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import {
	BUTTON,
	BUTTON_DANGER,
	BUTTON_PRIMARY,
	ConfirmDialog,
	Empty,
	ErrorNotice,
	Loading,
	Section,
} from "../components/ui.tsx";
import { runStateMessages } from "../i18n/runState.messages.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { chatHash } from "../router.ts";
import { createClock } from "./clock.ts";
import { showTaskResultOnHome } from "./showOnHome.ts";
import { TaskEditorDialog } from "./TaskEditorDialog.tsx";
import { SkipLine, TASK_LINK, TaskOutcomeNotice } from "./TaskParts.tsx";
import {
	createTaskActions,
	outcomeStillCurrent,
	subjectOf,
	type TaskActionOutcome,
} from "./taskActions.ts";
import { tasksMessages } from "./tasks.messages.ts";
import { tasksModelMessages } from "./tasksModel.messages.ts";
import {
	browserTimeZone,
	lastRunText,
	nextRunText,
	orderTasks,
	scheduleText,
	skipView,
} from "./tasksModel.ts";
import { tasksStoreFor } from "./tasksStore.ts";

/** The editor's state: closed, a new task, or one task being edited. */
type EditorState =
	| { readonly kind: "new" }
	| { readonly kind: "edit"; readonly task: ScheduledTask };

/**
 * The Tasks page (`#/tasks`, ADR-0033 §8): every scheduled task with its
 * schedule in words, next run, last run (with "Open chat") and last skip
 * (with its fix); New task and Edit open the one editor dialog; each task
 * has Pause/Resume, Run now, Show result on Home (ADR-0038 §5) and Delete
 * (after confirmation). The list is
 * the store the widgets share, polled with its ETag while visible.
 */
export function TasksView(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const m = useMessages(tasksMessages);
	const text = useMessages(tasksModelMessages);
	const runState = useMessages(runStateMessages);
	const locale = useLocale();
	const store = tasksStoreFor(props.api, props.visibility);
	onCleanup(store.attach());
	const actions = createTaskActions(props.api, store);
	const now = createClock();
	const viewerZone = browserTimeZone();

	const [outcome, setOutcome] = createSignal<TaskActionOutcome | null>(null);
	const [editor, setEditor] = createSignal<EditorState | null>(null);
	const [deleting, setDeleting] = createSignal<ScheduledTask | null>(null);
	const [opener, setOpener] = createSignal<HTMLElement | null>(null);
	/** Tasks whose Show result on Home is in flight (their button waits). */
	const [showing, setShowing] = createSignal<ReadonlySet<string>>(new Set());

	const tasks = createMemo(() => orderTasks(store.list()?.tasks ?? []));
	const counts = () => {
		const list = store.list();
		if (list === null) return null;
		const active = list.tasks.filter((task) => task.status === "active").length;
		return m().counts(active, list.limits.maxActive, list.tasks.length, list.limits.maxTasks);
	};

	const openerOf = (event: MouseEvent): HTMLElement | null =>
		event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
	const openEditor = (state: EditorState, event: MouseEvent) => {
		setOpener(openerOf(event));
		setEditor(state);
	};
	/** The last action's notice while the list still shows what it said (a fired or skipped task retires it). */
	const shownOutcome = (): TaskActionOutcome | null => {
		const current = outcome();
		return current !== null && outcomeStillCurrent(current, store.list()?.tasks ?? null)
			? current
			: null;
	};
	const act = async (run: () => Promise<TaskActionOutcome | null>): Promise<void> => {
		const result = await run();
		if (result !== null) setOutcome(result);
	};
	/** Show result on Home (ADR-0038 §5): one request chain per task at a time. */
	const showOnHome = async (task: ScheduledTask): Promise<void> => {
		if (showing().has(task.taskId)) return;
		setShowing((current) => new Set([...current, task.taskId]));
		const shown = await showTaskResultOnHome(props.api, task);
		setShowing((current) => new Set([...current].filter((id) => id !== task.taskId)));
		switch (shown.kind) {
			case "added":
			case "already":
				setOutcome({ kind: "on-home", title: task.title, already: shown.kind === "already" });
				return;
			case "full":
				setOutcome({ kind: "home-full", title: task.title, problem: shown.problem.code });
				return;
			case "failed":
				setOutcome({ kind: "failed", action: "show-on-home", failure: shown.failure });
				return;
		}
	};
	const confirmDelete = async (): Promise<void> => {
		const task = deleting();
		if (task === null) return;
		const result = await actions.remove(task);
		setDeleting(null);
		opener()?.focus();
		if (result !== null) setOutcome(result);
	};

	const newTaskButton = (
		<button
			type="button"
			class={BUTTON_PRIMARY}
			onClick={(event) => openEditor({ kind: "new" }, event)}
		>
			{m().newTask}
		</button>
	);

	return (
		<div class="space-y-3">
			<Section
				title={m().listTitle}
				actions={
					<div class="flex flex-wrap items-center gap-2">
						<Show when={counts()}>
							{(line) => <span class="text-xs text-slate-700">{line()}</span>}
						</Show>
						{newTaskButton}
					</div>
				}
			>
				<div class="mt-2 space-y-2">
					<TaskOutcomeNotice outcome={shownOutcome()} />
					<Show when={store.failure()}>
						{(error) => (
							<ErrorNotice
								failure={error()}
								title={m().loadFailed}
								onRetry={() => store.refresh()}
							/>
						)}
					</Show>
					<Show
						when={store.list() !== null}
						fallback={
							<Show when={store.failure() === null}>
								<Loading label={m().tasksThing} />
							</Show>
						}
					>
						<Show when={tasks().length > 0} fallback={<Empty>{m().empty}</Empty>}>
							<ul aria-label={m().taskList} class="divide-y divide-slate-200">
								<For each={tasks()}>
									{(task) => (
										<TaskRow
											task={task}
											now={now()}
											viewerZone={viewerZone}
											busy={actions.isBusy(task.taskId)}
											onEdit={(event) => openEditor({ kind: "edit", task }, event)}
											onTogglePause={() =>
												void act(() => actions.setPaused(task, task.status === "active"))
											}
											onRunNow={() => void act(() => actions.runNow(task))}
											showingOnHome={showing().has(task.taskId)}
											onShowOnHome={() => void showOnHome(task)}
											onDelete={(event) => {
												setOpener(openerOf(event));
												setDeleting(task);
											}}
										/>
									)}
								</For>
							</ul>
						</Show>
					</Show>
					<p class="text-xs text-slate-700">{m().agentNote}</p>
				</div>
			</Section>

			<Show when={editor()}>
				{(state) => (
					<TaskEditorDialog
						api={props.api}
						store={store}
						task={state().kind === "edit" ? taskOf(state()) : null}
						opener={opener()}
						onSaved={(task, created) =>
							setOutcome({
								kind: created ? "created" : "saved",
								title: task.title,
								subject: subjectOf(task),
							})
						}
						onClose={() => setEditor(null)}
					/>
				)}
			</Show>
			<Show when={deleting()}>
				{(task) => (
					<ConfirmDialog
						title={m().deleteTitle(task().title)}
						opener={opener()}
						confirmLabel={m().deleteConfirm}
						pending={actions.isBusy(task().taskId)}
						failure={null}
						onConfirm={() => void confirmDelete()}
						onCancel={() => setDeleting(null)}
					>
						{m().deleteBody}
					</ConfirmDialog>
				)}
			</Show>
		</div>
	);

	/** One task's row: what it asks, when it runs, how it last went, and its actions. */
	function TaskRow(row: {
		readonly task: ScheduledTask;
		readonly now: number;
		readonly viewerZone: string;
		readonly busy: boolean;
		readonly onEdit: (event: MouseEvent) => void;
		readonly onTogglePause: () => void;
		readonly onRunNow: () => void;
		readonly showingOnHome: boolean;
		readonly onShowOnHome: () => void;
		readonly onDelete: (event: MouseEvent) => void;
	}): JSX.Element {
		const headingId = `task-${row.task.taskId}`;
		const skip = () => skipView(row.task, row.viewerZone, locale(), text());
		const statusWord = () =>
			row.task.status === "paused"
				? text().statusPaused
				: row.task.status === "completed"
					? text().statusCompleted
					: null;
		return (
			<li class="py-2" data-task-id={row.task.taskId}>
				{/* On a phone the actions follow the text, so they never split the
				    schedule from the question it belongs to; from sm up they sit on the right. */}
				<article
					aria-labelledby={headingId}
					class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
				>
					<div class="min-w-0 space-y-1">
						<div>
							<h4 id={headingId} class="text-sm font-semibold text-slate-900">
								{row.task.title}
								<Show when={statusWord()}>
									{(word) => (
										<span class="ml-2 rounded-full bg-slate-200 px-2 py-0.5 text-2xs font-medium text-slate-800">
											{word()}
										</span>
									)}
								</Show>
							</h4>
							<p class="text-xs text-slate-700">
								{scheduleText(row.task.schedule, row.task.timeZone, row.viewerZone, text())}
							</p>
						</div>
						<p class="line-clamp-2 text-sm text-slate-800">{row.task.question}</p>
						<p class="text-xs text-slate-800" data-field="task-next-run">
							{nextRunText(row.task, row.now, row.viewerZone, locale(), text())}
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
						<Show when={skip()}>{(current) => <SkipLine skip={current()} />}</Show>
					</div>
					<div class="flex shrink-0 flex-wrap gap-1">
						<button
							type="button"
							class={BUTTON}
							aria-label={m().editNamed(row.task.title)}
							disabled={row.busy}
							onClick={(event) => row.onEdit(event)}
						>
							{m().edit}
						</button>
						<Show when={row.task.status !== "completed"}>
							<button
								type="button"
								class={BUTTON}
								aria-label={
									row.task.status === "active"
										? m().pauseNamed(row.task.title)
										: m().resumeNamed(row.task.title)
								}
								disabled={row.busy}
								onClick={() => row.onTogglePause()}
							>
								{row.task.status === "active" ? m().pause : m().resume}
							</button>
						</Show>
						<button
							type="button"
							class={BUTTON}
							aria-label={m().runNowNamed(row.task.title)}
							disabled={row.busy}
							onClick={() => row.onRunNow()}
						>
							{m().runNow}
						</button>
						<button
							type="button"
							class={BUTTON}
							aria-label={m().showOnHomeNamed(row.task.title)}
							disabled={row.showingOnHome}
							onClick={() => row.onShowOnHome()}
						>
							{m().showOnHome}
						</button>
						<button
							type="button"
							class={BUTTON_DANGER}
							aria-label={m().deleteNamed(row.task.title)}
							disabled={row.busy}
							onClick={(event) => row.onDelete(event)}
						>
							{m().delete}
						</button>
					</div>
				</article>
			</li>
		);
	}
}

function taskOf(state: EditorState): ScheduledTask | null {
	return state.kind === "edit" ? state.task : null;
}
