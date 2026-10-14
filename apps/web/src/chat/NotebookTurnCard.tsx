import type { NotebookTurn } from "@research/contracts";
import { For, type JSX, Show } from "solid-js";
import { BUTTON, DisclosureSummary } from "../components/ui.tsx";

/**
 * One notebook-assistant turn, matched by `runId` (ADR-0020): one line per
 * change the assistant applied, the failure sentence when it applied
 * nothing, an Undo while the notebook still sits at the turn's version, and
 * a confirm row for every proposed removal the owner has not already kept.
 */

const CHANGE_LABEL: Record<NotebookTurn["changes"][number]["kind"], string> = {
	added: "Added",
	updated: "Updated",
	moved: "Moved",
	resized: "Resized",
	duplicated: "Duplicated",
};

/** Above this combined length the before → after text hides behind a disclosure. */
const LONG_CHANGE_CHARS = 160;

function ChangeLine(props: { readonly change: NotebookTurn["changes"][number] }): JSX.Element {
	const before = () => props.change.before ?? "";
	const after = () => props.change.after ?? "";
	const hasDiff = () => props.change.kind === "updated" && (before() !== "" || after() !== "");
	const long = () => before().length + after().length > LONG_CHANGE_CHARS;
	return (
		<li>
			<span>
				{CHANGE_LABEL[props.change.kind]} “{props.change.title}”
			</span>
			<Show when={hasDiff() && !long()}>
				<span class="text-slate-700">
					: {before()} → {after()}
				</span>
			</Show>
			<Show when={hasDiff() && long()}>
				<details class="group mt-0.5">
					<DisclosureSummary class="text-xs text-slate-700">Show changes</DisclosureSummary>
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
	const appliedNothing = () => props.turn.appliedVersion === null;
	const undoEnabled = () =>
		!appliedNothing() && props.notebookVersion === props.turn.appliedVersion;
	const pendingRemovals = () =>
		props.turn.proposedRemovals.filter((item) => !props.isKept(item.widgetId));
	return (
		<article
			aria-label={`Notebook changes for run ${props.turn.runId}`}
			data-notebook-turn={props.turn.runId}
			class="mt-2 rounded bg-slate-100 p-2 wrap-anywhere"
		>
			<Show
				when={!appliedNothing()}
				fallback={
					<p class="text-xs text-slate-700">
						{props.turn.failure?.message ?? "The assistant applied no changes."}
					</p>
				}
			>
				<Show
					when={props.turn.changes.length > 0}
					fallback={
						<p class="text-xs text-slate-700">
							{props.turn.failure?.message ?? "The assistant applied no changes."}
						</p>
					}
				>
					<ul
						aria-label="Notebook changes"
						class="list-disc space-y-0.5 pl-5 text-xs text-slate-900"
					>
						<For each={props.turn.changes}>{(change) => <ChangeLine change={change} />}</For>
					</ul>
				</Show>
			</Show>
			<Show when={pendingRemovals().length > 0}>
				<ul aria-label="Proposed removals" class="mt-1 space-y-1">
					<For each={pendingRemovals()}>
						{(item) => (
							<li
								data-proposed-removal={item.widgetId}
								class="flex flex-wrap items-center gap-2 text-xs text-slate-900"
							>
								<span>Remove “{item.title}”?</span>
								<button
									type="button"
									class={BUTTON}
									onClick={() => props.onRemove([item.widgetId])}
								>
									Remove
								</button>
								<button type="button" class={BUTTON} onClick={() => props.onKeep([item.widgetId])}>
									Keep
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
					{props.undoPending ? "Undoing…" : "Undo"}
				</button>
			</div>
		</article>
	);
}
