import type { NotebookTurn } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { For, type JSX, Show } from "solid-js";
import { BUTTON, DisclosureSummary } from "../components/ui.tsx";
import { commonMessages } from "../i18n/common.messages.ts";
import { notebookTurnMessages } from "./notebookTurn.messages.ts";

/**
 * One notebook-assistant turn, matched by `runId` (ADR-0020): one line per
 * change the assistant applied, the failure sentence when it applied
 * nothing, an Undo while the notebook still sits at the turn's version, and
 * a confirm row for every proposed removal the owner has not already kept.
 */

/** Above this combined length the before → after text hides behind a disclosure. */
const LONG_CHANGE_CHARS = 160;

function ChangeLine(props: { readonly change: NotebookTurn["changes"][number] }): JSX.Element {
	const m = useMessages(notebookTurnMessages);
	const before = () => props.change.before ?? "";
	const after = () => props.change.after ?? "";
	const hasDiff = () => props.change.kind === "updated" && (before() !== "" || after() !== "");
	const long = () => before().length + after().length > LONG_CHANGE_CHARS;
	return (
		<li>
			<span>{m().change(props.change.kind, props.change.title)}</span>
			<Show when={hasDiff() && !long()}>
				<span class="text-slate-700">
					: {before()} → {after()}
				</span>
			</Show>
			<Show when={hasDiff() && long()}>
				<details class="group mt-0.5">
					<DisclosureSummary class="text-xs text-slate-700">{m().showChanges}</DisclosureSummary>
					<p class="mt-0.5 whitespace-pre-wrap text-xs text-slate-700">
						{before()} → {after()}
					</p>
				</details>
			</Show>
		</li>
	);
}

export function NotebookTurnCard(props: {
	readonly turn: NotebookTurn;
	/** The notebook version on screen: Undo is enabled only while it equals the turn's version. */
	readonly notebookVersion: number;
	/** Proposed removals the owner already kept (declined) stay dismissed. */
	readonly isKept: (widgetId: string) => boolean;
	readonly onUndo: () => void;
	readonly undoPending: boolean;
	readonly onRemove: (widgetIds: readonly string[]) => void;
	readonly onKeep: (widgetIds: readonly string[]) => void;
}): JSX.Element {
	const m = useMessages(notebookTurnMessages);
	const common = useMessages(commonMessages);
	const appliedNothing = () => props.turn.appliedVersion === null;
	const undoEnabled = () =>
		!appliedNothing() && props.notebookVersion === props.turn.appliedVersion;
	const pendingRemovals = () =>
		props.turn.proposedRemovals.filter((item) => !props.isKept(item.widgetId));
	return (
		<article
			aria-label={m().turn(props.turn.runId)}
			data-notebook-turn={props.turn.runId}
			class="mt-2 rounded bg-slate-100 p-2 wrap-anywhere"
		>
			<Show
				when={!appliedNothing()}
				fallback={
					<p class="text-xs text-slate-700">{props.turn.failure?.message ?? m().noChanges}</p>
				}
			>
				<Show
					when={props.turn.changes.length > 0}
					fallback={
						<p class="text-xs text-slate-700">{props.turn.failure?.message ?? m().noChanges}</p>
					}
				>
					<ul aria-label={m().changes} class="list-disc space-y-0.5 pl-5 text-xs text-slate-900">
						<For each={props.turn.changes}>{(change) => <ChangeLine change={change} />}</For>
					</ul>
				</Show>
			</Show>
			<Show when={pendingRemovals().length > 0}>
				<ul aria-label={m().proposedRemovals} class="mt-1 space-y-1">
					<For each={pendingRemovals()}>
						{(item) => (
							<li
								data-proposed-removal={item.widgetId}
								class="flex flex-wrap items-center gap-2 text-xs text-slate-900"
							>
								<span>{m().removeQuestion(item.title)}</span>
								<button
									type="button"
									class={BUTTON}
									onClick={() => props.onRemove([item.widgetId])}
								>
									{common().remove}
								</button>
								<button type="button" class={BUTTON} onClick={() => props.onKeep([item.widgetId])}>
									{m().keep}
								</button>
							</li>
						)}
					</For>
				</ul>
			</Show>
			<div class="mt-1">
				<button
					type="button"
					class={BUTTON}
					disabled={!undoEnabled() || props.undoPending}
					onClick={() => props.onUndo()}
				>
					{props.undoPending ? m().undoing : common().undo}
				</button>
			</div>
		</article>
	);
}
