import { SCHEDULED_TASK_LIMITS, type ScheduledTask } from "@research/contracts";
import type { ScheduleWeekday } from "@research/domain";
import { useMessages } from "@research/i18n/solid";
import {
	createMemo,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import type { ApiClient } from "../api/client.ts";
import type { ApiFailure } from "../api/http.ts";
import {
	BUTTON,
	BUTTON_PRIMARY,
	ErrorNotice,
	Field,
	INPUT,
	LABEL,
	Select,
} from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { createRemote } from "../lib/remote.ts";
import { agentSettingsModelMessages } from "../settings/agentSettingsModel.messages.ts";
import { TaskFailure } from "./TaskParts.tsx";
import { tasksMessages } from "./tasks.messages.ts";
import { tasksModelMessages } from "./tasksModel.messages.ts";
import {
	browserTimeZone,
	defaultTaskDraft,
	draftFromTask,
	evaluateTaskDraft,
	SCHEDULE_CHOICES,
	type ScheduleChoice,
	type TaskDraft,
	taskConsentNeed,
	toggleWeekday,
	WEEKDAYS,
} from "./tasksModel.ts";
import type { TasksStore } from "./tasksStore.ts";

const HORIZONS = [3, 4, 5] as const;

function isScheduleChoice(value: string): value is ScheduleChoice {
	return SCHEDULE_CHOICES.some((choice) => choice === value);
}

function isHorizon(value: number): value is (typeof HORIZONS)[number] {
	return HORIZONS.some((years) => years === value);
}

/** The zones the runtime knows, for the time-zone suggestions (none where it cannot list them). */
function knownTimeZones(): readonly string[] {
	return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
}

/**
 * The one task editor (ADR-0033 §8), opened by New task and Edit on the
 * Tasks page and by New task in the widget: title, question, horizon,
 * markets, the schedule with its fields, the time zone (the browser's by
 * default) and — only while the backend saved in Settings → AI agent bills
 * per use — the spend consent. A native modal dialog like the widget
 * editors: focus moves in on open and back to the opener on close.
 */
export function TaskEditorDialog(props: {
	readonly api: ApiClient;
	readonly store: TasksStore;
	/** The task to edit, or null for a new one. */
	readonly task: ScheduledTask | null;
	readonly opener: HTMLElement | null;
	readonly onSaved: (task: ScheduledTask, created: boolean) => void;
	readonly onClose: () => void;
}): JSX.Element {
	const m = useMessages(tasksMessages);
	const text = useMessages(tasksModelMessages);
	const common = useMessages(commonMessages);
	const agentText = useMessages(agentSettingsModelMessages);
	const headingId = createUniqueId();
	const problemsId = createUniqueId();
	const zonesId = createUniqueId();
	const viewerZone = browserTimeZone();
	let dialog: HTMLDialogElement | undefined;
	let titleInput: HTMLInputElement | undefined;

	const agents = createRemote(() => props.api.listAgents());
	const settings = createRemote(() => props.api.getAgentSettings());
	const need = createMemo(() =>
		taskConsentNeed(agents.value(), settings.value()?.settings ?? null, agentText()),
	);

	const editing = props.task;
	const [draft, setDraft] = createSignal<TaskDraft>(
		editing === null
			? defaultTaskDraft(Date.now(), viewerZone)
			: draftFromTask(editing, { kind: "loading" }, Date.now()),
	);
	const patch = (change: Partial<TaskDraft>) => setDraft((current) => ({ ...current, ...change }));

	const [tried, setTried] = createSignal(false);
	const [saving, setSaving] = createSignal(false);
	const [failure, setFailure] = createSignal<ApiFailure | null>(null);
	const evaluation = createMemo(() => evaluateTaskDraft(draft(), need(), Date.now(), text()));
	const visibleProblems = () => (tried() ? evaluation().problems : []);
	/** A create re-sent unchanged reuses its key, so a retry cannot make a second task. */
	let pendingCreate: { readonly fingerprint: string; readonly key: string } | null = null;

	const closeToOpener = () => {
		props.opener?.focus();
	};
	onMount(() => {
		dialog?.showModal();
		titleInput?.focus();
	});
	onCleanup(() => {
		if (dialog?.open === true) dialog.close();
	});

	const save = async (): Promise<void> => {
		setTried(true);
		setFailure(null);
		const request = evaluateTaskDraft(draft(), need(), Date.now(), text()).request;
		if (request === null || saving()) return;
		setSaving(true);
		const task = editing;
		let result: Awaited<ReturnType<typeof props.api.createScheduledTask>>;
		if (task === null) {
			const fingerprint = JSON.stringify(request);
			const key =
				pendingCreate?.fingerprint === fingerprint
					? pendingCreate.key
					: props.api.newIdempotencyKey();
			pendingCreate = { fingerprint, key };
			result = await props.api.createScheduledTask(request, key);
			if (result.ok || result.error.kind !== "network") pendingCreate = null;
		} else {
			// The version on screen: the list keeps it current (a fired run
			// advances it), so an edit conflicts only with another edit.
			const latest = props.store.list()?.tasks.find((entry) => entry.taskId === task.taskId);
			result = await props.api.updateScheduledTask(task.taskId, {
				expectedVersion: latest?.version ?? task.version,
				...request,
			});
		}
		setSaving(false);
		if (!result.ok) {
			setFailure(result.error);
			if (result.error.code === "VERSION_CONFLICT") props.store.refresh();
			return;
		}
		props.store.putTask(result.value);
		props.onSaved(result.value, task === null);
		props.onClose();
		closeToOpener();
	};

	const agentFailure = () => {
		const agentsState = agents.state();
		if (agentsState.status === "error") return agentsState.error;
		const settingsState = settings.state();
		return settingsState.status === "error" ? settingsState.error : null;
	};

	return (
		<dialog
			ref={(element) => {
				dialog = element;
			}}
			aria-labelledby={headingId}
			class="m-auto w-full max-w-xl rounded bg-slate-100 p-4"
			onCancel={(event) => {
				event.preventDefault();
				props.onClose();
				closeToOpener();
			}}
			onClose={() => closeToOpener()}
		>
			<h3 id={headingId} class="text-base font-semibold text-slate-900">
				{editing === null ? m().newTaskHeading : m().editTaskHeading}
			</h3>
			<form
				class="mt-2 space-y-2"
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
			>
				<Field label={m().titleField}>
					{(id) => (
						<input
							id={id}
							ref={(element) => {
								titleInput = element;
							}}
							type="text"
							class={INPUT}
							maxLength={SCHEDULED_TASK_LIMITS.maxTitleChars}
							value={draft().title}
							onInput={(event) => patch({ title: event.currentTarget.value })}
						/>
					)}
				</Field>
				<Field label={m().questionField} hint={m().questionHint}>
					{(id) => (
						<textarea
							id={id}
							rows={3}
							class={INPUT}
							aria-describedby={`${id}-hint`}
							value={draft().question}
							onInput={(event) => patch({ question: event.currentTarget.value })}
						/>
					)}
				</Field>
				<div class="flex flex-wrap gap-3">
					<Field label={m().horizon} layoutClass="w-32">
						{(id) => (
							<Select
								id={id}
								onChange={(event) => {
									const years = Number(event.currentTarget.value);
									if (isHorizon(years)) patch({ horizonYears: years });
								}}
							>
								<For each={HORIZONS}>
									{(years) => (
										<option value={years} selected={draft().horizonYears === years}>
											{m().years(years)}
										</option>
									)}
								</For>
							</Select>
						)}
					</Field>
					<fieldset class="flex flex-wrap items-end gap-3 text-sm text-slate-900">
						<legend class={LABEL}>{m().markets}</legend>
						<label class="flex min-h-6 items-center gap-1">
							<input
								type="checkbox"
								checked={draft().markets.JP}
								onChange={(event) =>
									patch({ markets: { ...draft().markets, JP: event.currentTarget.checked } })
								}
							/>
							{m().japan}
						</label>
						<label class="flex min-h-6 items-center gap-1">
							<input
								type="checkbox"
								checked={draft().markets.US}
								onChange={(event) =>
									patch({ markets: { ...draft().markets, US: event.currentTarget.checked } })
								}
							/>
							{m().unitedStates}
						</label>
					</fieldset>
				</div>
				<div class="flex flex-wrap gap-3">
					<Field label={m().repeat} layoutClass="w-48">
						{(id) => (
							<Select
								id={id}
								onChange={(event) => {
									const value = event.currentTarget.value;
									if (isScheduleChoice(value)) patch({ choice: value });
								}}
							>
								<For each={SCHEDULE_CHOICES}>
									{(choice) => (
										<option value={choice} selected={draft().choice === choice}>
											{m().choice(choice)}
										</option>
									)}
								</For>
							</Select>
						)}
					</Field>
					<Show when={draft().choice === "once"}>
						<Field label={m().date} layoutClass="w-40">
							{(id) => (
								<input
									id={id}
									type="date"
									class={INPUT}
									value={draft().date}
									onInput={(event) => patch({ date: event.currentTarget.value })}
								/>
							)}
						</Field>
					</Show>
					<Show when={draft().choice === "monthly"}>
						<Field label={m().dayOfMonth} hint={m().dayOfMonthHint} layoutClass="w-40">
							{(id) => (
								<input
									id={id}
									type="number"
									min={1}
									max={31}
									class={INPUT}
									aria-describedby={`${id}-hint`}
									value={draft().dayOfMonth}
									onInput={(event) => patch({ dayOfMonth: event.currentTarget.value })}
								/>
							)}
						</Field>
					</Show>
					<Field label={m().time} layoutClass="w-28">
						{(id) => (
							<input
								id={id}
								type="time"
								class={INPUT}
								value={draft().time}
								onInput={(event) => patch({ time: event.currentTarget.value })}
							/>
						)}
					</Field>
				</div>
				<Show when={draft().choice === "weekly"}>
					{/* Seven columns on a phone (box above the day) so the week never wraps one day onto its own line. */}
					<fieldset class="grid grid-cols-7 gap-1 text-sm text-slate-900 sm:flex sm:flex-wrap sm:gap-3">
						<legend class={`${LABEL} mb-1`}>{m().days}</legend>
						<For each={WEEKDAYS}>
							{(day: ScheduleWeekday) => (
								<label class="flex min-h-6 flex-col items-center gap-0.5 sm:flex-row sm:gap-1">
									<input
										type="checkbox"
										checked={draft().days.includes(day)}
										onChange={() => patch({ days: toggleWeekday(draft().days, day) })}
									/>
									{text().weekday(day)}
								</label>
							)}
						</For>
					</fieldset>
				</Show>
				<Field label={m().timeZone} hint={m().timeZoneHint(viewerZone)}>
					{(id) => (
						<>
							<input
								id={id}
								type="text"
								class={INPUT}
								list={zonesId}
								autocomplete="off"
								spellcheck={false}
								aria-describedby={`${id}-hint`}
								value={draft().timeZone}
								onInput={(event) => patch({ timeZone: event.currentTarget.value })}
							/>
							<datalist id={zonesId}>
								<For each={knownTimeZones()}>{(zone) => <option value={zone} />}</For>
							</datalist>
						</>
					)}
				</Field>
				<p class="text-xs text-slate-700">{m().agentNote}</p>
				<Show when={agentFailure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().agentSettingsFailed}
							onRetry={() => {
								void agents.reload();
								void settings.reload();
							}}
						/>
					)}
				</Show>
				<Show when={need().kind === "loading" && agentFailure() === null}>
					<output aria-busy="true" class="block text-xs text-slate-700">
						{text().agentsLoading}
					</output>
				</Show>

				<Show when={visibleProblems().length > 0}>
					<div class="rounded border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800">
						<p id={`${problemsId}-intro`} class="font-medium text-slate-900">
							{m().beforeSave}
						</p>
						<ul id={problemsId} aria-labelledby={`${problemsId}-intro`} class="list-disc pl-4">
							<For each={visibleProblems()}>{(problem) => <li>{problem}</li>}</For>
						</ul>
					</div>
				</Show>
				<Show when={failure()}>
					{(error) => <TaskFailure failure={error()} title={m().notSaved} />}
				</Show>
				<div class="flex gap-2 pt-1">
					<button
						type="button"
						class={BUTTON}
						disabled={saving()}
						onClick={() => {
							props.onClose();
							closeToOpener();
						}}
					>
						{common().cancel}
					</button>
					<button
						type="submit"
						class={BUTTON_PRIMARY}
						disabled={saving() || need().kind === "loading"}
						aria-describedby={visibleProblems().length > 0 ? problemsId : undefined}
					>
						{saving() ? common().saving : editing === null ? m().createTask : m().saveTask}
					</button>
				</div>
			</form>
		</dialog>
	);
}
