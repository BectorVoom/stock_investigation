import { useMessages } from "@research/i18n/solid";
import { type JSX, Match, Show, Switch } from "solid-js";
import type { ApiFailure } from "../api/http.ts";
import { ErrorNotice, Notice } from "../components/ui.tsx";
import { SETTINGS_AGENT_HASH } from "../router.ts";
import type { TaskActionOutcome } from "./taskActions.ts";
import { tasksMessages } from "./tasks.messages.ts";
import { tasksModelMessages } from "./tasksModel.messages.ts";
import { type SkipView, taskFailureHint } from "./tasksModel.ts";

/** The app's inline link look (the earnings widget's), with the 24 / 44 px target floor. */
export const TASK_LINK =
	"inline-flex min-h-6 items-center text-blue-800 underline decoration-blue-300 underline-offset-2 hover:decoration-blue-800 pointer-coarse:min-h-11";

/** A refused task write: its stable code and message, plus the sentence that says what to do. */
export function TaskFailure(props: {
	readonly failure: ApiFailure;
	readonly title: string;
	readonly iconRetry?: boolean;
	readonly onRetry?: () => void;
}): JSX.Element {
	const text = useMessages(tasksModelMessages);
	const hint = () => taskFailureHint(props.failure, text());
	return (
		<div>
			<ErrorNotice
				failure={props.failure}
				title={props.title}
				onRetry={props.onRetry}
				iconRetry={props.iconRetry}
			/>
			<Show when={hint()}>
				{(sentence) => <p class="mt-1 text-xs text-red-900">{sentence()}</p>}
			</Show>
		</div>
	);
}

/**
 * What the last action did: a polite note, or the failure with its code.
 * `compact` (the widget) states success as one plain line, no box in the card.
 */
export function TaskOutcomeNotice(props: {
	readonly outcome: TaskActionOutcome | null;
	readonly compact?: boolean;
}): JSX.Element {
	const m = useMessages(tasksMessages);
	const done = (): string | null => {
		const outcome = props.outcome;
		if (outcome === null) return null;
		switch (outcome.kind) {
			case "created":
				return m().created(outcome.title);
			case "saved":
				return m().saved(outcome.title);
			case "paused":
				return m().paused(outcome.title);
			case "resumed":
				return m().resumed(outcome.title);
			case "deleted":
				return m().deleted(outcome.title);
			case "run":
				return outcome.replayed ? m().runReplayed(outcome.title) : m().runQueued(outcome.title);
			case "failed":
				return null;
		}
	};
	const failed = () => (props.outcome?.kind === "failed" ? props.outcome : null);
	const failureTitle = (action: "pause" | "resume" | "run" | "delete"): string => {
		if (action === "pause") return m().notPaused;
		if (action === "resume") return m().notResumed;
		if (action === "run") return m().notRun;
		return m().notDeleted;
	};
	return (
		<Switch>
			<Match when={failed()}>
				{(outcome) => (
					<TaskFailure failure={outcome().failure} title={failureTitle(outcome().action)} />
				)}
			</Match>
			<Match when={done()}>
				{(sentence) => (
					<Show
						when={props.compact}
						fallback={
							<Notice tone="success" data-task-outcome="">
								{sentence()}
							</Notice>
						}
					>
						<output class="block text-xs text-emerald-900" data-task-outcome="">
							{sentence()}
						</output>
					</Show>
				)}
			</Match>
		</Switch>
	);
}

/** A skipped occurrence: when, why, and the fix — a link when it lives in Settings → AI agent. */
export function SkipLine(props: {
	readonly skip: SkipView;
	readonly compact?: boolean;
}): JSX.Element {
	const m = useMessages(tasksMessages);
	return (
		<p class="text-xs text-amber-900" data-field="task-skip">
			{props.skip.headline} {props.skip.reason} <Show when={!props.compact}>{props.skip.fix} </Show>
			<Show when={props.skip.settingsFix}>
				<a href={SETTINGS_AGENT_HASH} class={TASK_LINK}>
					{m().fixInSettings}
				</a>
			</Show>
		</p>
	);
}
