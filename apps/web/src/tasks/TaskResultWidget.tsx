import {
	isTerminalJobState,
	type ScheduledTask,
	type WidgetCore,
	type WidgetSize,
} from "@research/contracts";
import { useLocale, useMessages } from "@research/i18n/solid";
import { createEffect, createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import type { ApiClient } from "../api/client.ts";
import { ErrorNotice, IconButton } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { runStateMessages } from "../i18n/runState.messages.ts";
import type { VisibilitySource } from "../lib/polling.ts";
import { chatHash } from "../router.ts";
import { createClock } from "./clock.ts";
import { SkipLine, TASK_LINK, TaskOutcomeNotice } from "./TaskParts.tsx";
import { createTaskActions, outcomeStillCurrent, type TaskActionOutcome } from "./taskActions.ts";
import { taskResultMessages, type VerificationStatus } from "./taskResult.messages.ts";
import { resultStamp, taskResultFor } from "./taskResultStore.ts";
import { tasksMessages } from "./tasks.messages.ts";
import { tasksModelMessages } from "./tasksModel.messages.ts";
import { answeredText, browserTimeZone, lastRunText, nextRunText, skipView } from "./tasksModel.ts";
import { tasksStoreFor } from "./tasksStore.ts";

/**
 * How much of the answer each size shows (ADR-0038 §4): Small a glance,
 * Medium a paragraph or two, Large all of it — the frame's body scrolls.
 * These are the floors outside a frame (and before the first measure);
 * inside one, `fitAnswerToFrame` raises the clamp to the lines that fit.
 * Whole class names, so the stylesheet build finds them.
 */
const ANSWER_CLAMP: { readonly [S in WidgetSize]: string } = {
	small: "line-clamp-4",
	medium: "line-clamp-10",
	large: "",
};

/** Never colour alone: each status has a symbol and its word. */
const VERIFICATION_PRESENTATION: {
	readonly [S in VerificationStatus]: { readonly symbol: string; readonly classes: string };
} = {
	verified: { symbol: "✓", classes: "border-emerald-700 bg-emerald-50 text-emerald-900" },
	"partially-verified": { symbol: "◐", classes: "border-amber-700 bg-amber-50 text-amber-900" },
	unverified: { symbol: "?", classes: "border-slate-500 bg-slate-50 text-slate-800" },
};

const BADGE =
	"inline-flex items-center gap-1 rounded border px-1.5 py-px text-2xs font-medium leading-4";

/**
 * Clamps the answer to the whole lines that fit its frame's body, so Small
 * and Medium fill the frame instead of stopping at a fixed count (Medium
 * and Large frames are the same height). Re-measured when the frame or the
 * widget resizes. CSSOM, not a style attribute: CSP `style-src 'self'`.
 */
function fitAnswerToFrame(text: HTMLElement): () => void {
	const body = text.closest(".wg-body");
	const root = text.closest('[data-widget-kind="task-result"]');
	if (!(body instanceof HTMLElement) || !(root instanceof HTMLElement)) return () => {};
	const fit = (): void => {
		const lineHeight = Number.parseFloat(getComputedStyle(text).lineHeight);
		if (!Number.isFinite(lineHeight) || lineHeight <= 0) return;
		// What follows the answer (a skip line, an outcome) keeps its room.
		const below = root.getBoundingClientRect().bottom - text.getBoundingClientRect().bottom;
		const available =
			body.getBoundingClientRect().bottom - text.getBoundingClientRect().top - Math.max(0, below);
		text.style.setProperty(
			"-webkit-line-clamp",
			String(Math.max(2, Math.floor(available / lineHeight))),
		);
	};
	fit();
	if (typeof ResizeObserver !== "function") return () => {};
	const observer = new ResizeObserver(fit);
	observer.observe(body);
	observer.observe(root);
	return () => observer.disconnect();
}

/** True when the task's last run has not ended yet. */
function runUnfinished(task: ScheduledTask): boolean {
	return task.lastRun !== null && !isTerminalJobState(task.lastRun.state);
}

/** True when the task's last run ended without its answer. */
function runFailed(task: ScheduledTask): boolean {
	const run = task.lastRun;
	return run !== null && (run.state === "failed" || run.failureCode !== null);
}

/**
 * The `task-result` widget (ADR-0038) on Home and in the Notebook: one
 * scheduled task's latest answer, glanceable after the Apple widget
 * guidelines — the task's current title, a status line (when the answer
 * was given, its verification, a run in progress, a failed last run or the
 * last skip), the answer as plain text clamped by size, and Open chat and
 * Run now.
 *
 * The task's meta comes from the page's shared task list (`tasksStoreFor`,
 * already polled), the answer from one read per task shared by every widget
 * of that task (`taskResultFor`). The answer is read on mount and again only
 * when the list shows the task's last run moved on, with its ETag: the widget
 * adds no poll of its own.
 */
export function TaskResultWidget(props: {
	readonly widget: Extract<WidgetCore, { readonly type: "task-result" }>;
	readonly api: ApiClient;
	readonly visibility: VisibilitySource;
}): JSX.Element {
	const m = useMessages(taskResultMessages);
	const tasksText = useMessages(tasksMessages);
	const text = useMessages(tasksModelMessages);
	const runState = useMessages(runStateMessages);
	const common = useMessages(commonMessages);
	const locale = useLocale();
	const store = tasksStoreFor(props.api, props.visibility);
	onCleanup(store.attach());
	// The task is chosen when the widget is added and never edited (no
	// Edit…), so the widget reads one task for its whole life.
	const taskId = props.widget.taskId;
	const entry = taskResultFor(props.api, taskId);
	onCleanup(entry.attach());
	const actions = createTaskActions(props.api, store);
	const now = createClock();
	const viewerZone = browserTimeZone();
	const [outcome, setOutcome] = createSignal<TaskActionOutcome | null>(null);
	const [answerElement, setAnswerElement] = createSignal<HTMLElement | null>(null);
	// Effects run once the element is in the document, and again when the
	// owner changes the size from the menu.
	createEffect(() => {
		const element = answerElement();
		if (element === null) return;
		if (props.widget.size === "large") {
			element.style.removeProperty("-webkit-line-clamp");
			return;
		}
		onCleanup(fitAnswerToFrame(element));
	});

	const task = createMemo(
		() => store.list()?.tasks.find((candidate) => candidate.taskId === taskId) ?? null,
	);
	/** Gone from the loaded list, or the server said 404. */
	const deleted = () => entry.missing() || (store.list() !== null && task() === null);
	const stamp = createMemo(() => {
		const current = task();
		return current === null ? null : resultStamp(current);
	});
	createEffect(() => entry.sync(stamp()));
	// A 404 while the list still holds the task: the list is behind, so it is read again.
	createEffect(() => {
		if (entry.missing() && task() !== null) store.refresh();
	});

	const title = () => task()?.title ?? props.widget.title;
	const zone = () => task()?.timeZone ?? viewerZone;
	const result = () => entry.result();
	const skip = () => {
		const current = task();
		return current === null ? null : skipView(current, viewerZone, locale(), text());
	};
	/** "Running now (collecting)" or the failed last run with its code, when either applies. */
	const runLine = (): string | null => {
		const current = task();
		if (current === null || current.lastRun === null) return null;
		if (runUnfinished(current)) return m().runningNow(runState().name(current.lastRun.state));
		if (runFailed(current)) return lastRunText(current, (state) => runState().name(state), text());
		return null;
	};
	const shownOutcome = (): TaskActionOutcome | null => {
		const current = outcome();
		return current !== null && outcomeStillCurrent(current, store.list()?.tasks ?? null)
			? current
			: null;
	};
	const runNow = async (current: ScheduledTask): Promise<void> => {
		const done = await actions.runNow(current);
		if (done !== null) setOutcome(done);
	};

	return (
		<div class="flex flex-col gap-2" data-widget-kind="task-result" data-task-id={taskId}>
			{/* The frame shows no title (ADR-0024), so the body names itself. */}
			<div class="flex flex-wrap items-start justify-between gap-x-2 gap-y-1">
				<p
					class="line-clamp-2 min-w-0 flex-[1_1_10rem] break-words text-sm font-semibold text-slate-900"
					title={title()}
				>
					{title()}
				</p>
				<Show when={deleted() ? null : task()}>
					{(current) => (
						<div class="flex shrink-0 items-center gap-1">
							<a
								href={chatHash(current().workspaceId)}
								class={`${TASK_LINK} whitespace-nowrap text-xs`}
								aria-label={tasksText().openChatNamed(current().title)}
							>
								{tasksText().openChat}
							</a>
							<IconButton
								label={tasksText().runNowNamed(current().title)}
								icon="lightning-charge"
								disabled={actions.isBusy(current().taskId)}
								onClick={() => void runNow(current())}
							/>
						</div>
					)}
				</Show>
			</div>
			<Show
				when={!deleted()}
				fallback={
					<p class="text-sm text-slate-700" data-field="task-result-deleted">
						{m().deleted}
					</p>
				}
			>
				<Show when={store.failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={tasksText().loadFailed}
							iconRetry
							onRetry={() => store.refresh()}
						/>
					)}
				</Show>
				<Show when={entry.failure()}>
					{(error) => (
						<ErrorNotice
							failure={error()}
							title={m().resultFailed}
							iconRetry
							onRetry={() => entry.retry()}
						/>
					)}
				</Show>
				<Show
					when={result() !== undefined}
					fallback={
						<Show when={entry.failure() === null}>
							<output aria-busy="true" class="block text-sm text-slate-600">
								{common().loadingThing(m().resultThing)}
							</output>
						</Show>
					}
				>
					<Show
						when={result()}
						fallback={
							<div class="space-y-0.5 text-xs text-slate-700" data-field="task-result-empty">
								<p class="text-sm text-slate-800">{m().noResultYet}</p>
								<Show when={runLine() ?? nextLine(task())}>{(line) => <p>{line()}</p>}</Show>
							</div>
						}
					>
						{(answer) => (
							<>
								<p
									class="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-slate-700"
									data-field="task-result-status"
								>
									<span>
										{answeredText(answer().answeredAt, zone(), now(), viewerZone, locale(), text())}
									</span>
									<span aria-hidden="true">·</span>
									<VerificationBadge status={answer().verificationStatus} />
									<Show when={runLine()}>
										{(line) => (
											<>
												<span aria-hidden="true">·</span>
												<span data-field="task-result-run">{line()}</span>
											</>
										)}
									</Show>
								</p>
								<p
									ref={setAnswerElement}
									class={`whitespace-pre-wrap break-words text-sm text-slate-900 ${ANSWER_CLAMP[props.widget.size]}`}
									data-field="task-result-text"
								>
									{answer().text}
								</p>
							</>
						)}
					</Show>
				</Show>
				<Show when={skip()}>{(current) => <SkipLine skip={current()} compact />}</Show>
				<TaskOutcomeNotice outcome={shownOutcome()} compact />
			</Show>
		</div>
	);

	/** The next run in words, for a task that has not answered yet. */
	function nextLine(current: ScheduledTask | null): string | null {
		return current === null ? null : nextRunText(current, now(), viewerZone, locale(), text());
	}

	/** The verification status as a badge (symbol and word), or a plain note when none was recorded. */
	function VerificationBadge(badge: { readonly status: VerificationStatus | null }): JSX.Element {
		return (
			<Show
				when={badge.status}
				fallback={<span class="text-slate-600">{m().verificationNotRecorded}</span>}
			>
				{(status) => (
					<span
						class={`${BADGE} ${VERIFICATION_PRESENTATION[status()].classes}`}
						data-verification-status={status()}
					>
						<span aria-hidden="true">{VERIFICATION_PRESENTATION[status()].symbol}</span>
						{m().verification(status())}
					</span>
				)}
			</Show>
		);
	}
}
