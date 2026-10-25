import type { ScheduledTask } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import {
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	on,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { BUTTON, ErrorNotice } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { TASKS_HASH } from "../router.ts";
import { TASK_LINK } from "./TaskParts.tsx";
import { taskResultMessages } from "./taskResult.messages.ts";
import { tasksMessages } from "./tasks.messages.ts";
import { tasksModelMessages } from "./tasksModel.messages.ts";
import { browserTimeZone, orderTasks, scheduleText } from "./tasksModel.ts";
import { tasksStoreFor } from "./tasksStore.ts";

/**
 * The add menu's "Task result" dialog (ADR-0038 §5): the owner's tasks, each
 * a button with its title and schedule in words; choosing one places the
 * widget. With no tasks it says so and links to the Tasks page. A native
 * modal dialog like the other widget dialogs: focus moves in on open (the
 * first task, else Cancel), Escape or Cancel closes, and focus returns to
 * the opener. The list is the shared tasks store, so a page that already
 * polls it sends no second request.
 */
export function TaskResultDialog(props: {
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
	readonly opener: HTMLElement | null;
	/** Places the widget; resolves true once saved (the dialog then closes). */
	readonly onChoose: (task: ScheduledTask) => Promise<boolean>;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(taskResultMessages);
	const tasksText = useMessages(tasksMessages);
	const text = useMessages(tasksModelMessages);
	const common = useMessages(commonMessages);
	const store = tasksStoreFor(props.api, props.visibility);
	onCleanup(store.attach());
	const headingId = createUniqueId();
	const introId = createUniqueId();
	const viewerZone = browserTimeZone();
	const [saving, setSaving] = createSignal(false);
	let dialog: HTMLDialogElement | undefined;
	let list: HTMLUListElement | undefined;
	let cancelButton: HTMLButtonElement | undefined;

	const tasks = createMemo(() => orderTasks(store.list()?.tasks ?? []));

	const close = (): void => {
		props.onClose();
		props.opener?.focus();
	};
	const choose = async (task: ScheduledTask): Promise<void> => {
		if (saving()) return;
		setSaving(true);
		const saved = await props.onChoose(task);
		setSaving(false);
		// A refused save (busy, the page full) keeps the dialog open; the page says why.
		if (saved) close();
	};
	/** The first task when there is one, else Cancel: where focus starts. */
	const focusStart = (): void => {
		const first = list?.querySelector("button");
		if (first instanceof HTMLButtonElement) first.focus();
		else cancelButton?.focus();
	};

	onMount(() => {
		dialog?.showModal();
		focusStart();
	});
	// The list may arrive after the dialog opened: focus moves to its first
	// task then, unless the owner already moved it inside the dialog.
	createEffect(
		on(
			() => store.list() !== null,
			(loaded) => {
				if (loaded && document.activeElement === cancelButton) focusStart();
			},
			{ defer: true },
		),
	);
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			aria-describedby={introId}
			class="m-auto w-full max-w-md rounded bg-slate-100 p-4"
			data-task-result-dialog=""
			onCancel={(event) => {
				event.preventDefault();
				close();
			}}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				{m().chooseHeading}
			</h3>
			<p id={introId} class="mt-1 text-xs text-slate-700">
				{m().chooseIntro}
			</p>
			<div class="mt-2 space-y-2">
				<Show when={store.failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={tasksText().loadFailed}
							onRetry={() => store.refresh()}
						/>
					)}
				</Show>
				<Show
					when={store.list() !== null}
					fallback={
						<Show when={store.failure() === null}>
							<output aria-busy="true" class="block text-sm text-slate-600">
								{common().loadingThing(tasksText().tasksThing)}
							</output>
						</Show>
					}
				>
					<Show
						when={tasks().length > 0}
						fallback={
							<div class="space-y-1 rounded border border-dashed border-slate-300 px-3 py-2">
								<p class="text-sm text-slate-800">{m().noTasks}</p>
								<a href={TASKS_HASH} class={`${TASK_LINK} text-sm`} onClick={() => props.onClose()}>
									{m().openTasks}
								</a>
							</div>
						}
					>
						<ul
							ref={(element) => {
								list = element;
							}}
							aria-label={m().chooseList}
							class="max-h-80 space-y-1 overflow-y-auto"
						>
							<For each={tasks()}>
								{(task) => (
									<li>
										<button
											type="button"
											class="flex min-h-11 w-full flex-col items-start rounded bg-white px-3 py-2 text-left hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
											disabled={saving()}
											data-task-id={task.taskId}
											onClick={() => void choose(task)}
										>
											<span class="break-words text-sm font-medium text-slate-900">
												{task.title}
											</span>
											<span class="text-xs text-slate-700">
												{scheduleText(task.schedule, task.timeZone, viewerZone, text())}
											</span>
										</button>
									</li>
								)}
							</For>
						</ul>
					</Show>
				</Show>
			</div>
			<div class="mt-3 flex gap-2">
				<button
					ref={(element) => {
						cancelButton = element;
					}}
					type="button"
					class={BUTTON}
					onClick={() => close()}
				>
					{common().cancel}
				</button>
			</div>
		</dialog>
	);
}
