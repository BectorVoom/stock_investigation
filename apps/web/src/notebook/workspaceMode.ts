import { parseJson } from "@research/domain";
import { type Accessor, createEffect, createSignal } from "solid-js";
import { browserLocalStorage, readStoredText, writeStoredText } from "../lib/browserStorage.ts";
import type { WorkspaceMode } from "./types.ts";

/**
 * The two states of an open conversation live above the layout (ADR-0020):
 * the mode is remembered per workspace id in `localStorage` — a
 * convenience, like a collapsed panel — and every access is guarded, so a
 * storage failure means `"chat"` (Chat-first), never a throw.
 */

function readKey(key: string): string | null {
	return readStoredText(browserLocalStorage(), key);
}

/** A convenience that cannot be kept still holds for this visit, so a refusal is ignored. */
function writeKey(key: string, value: string): void {
	writeStoredText(browserLocalStorage(), key, value);
}

function modeKey(workspaceId: string): string {
	return `research.workspace-mode.${workspaceId}`;
}

function suggestKey(workspaceId: string): string {
	return `research.notebook-suggest-dismissed.${workspaceId}`;
}

function keepKey(workspaceId: string): string {
	return `research.notebook-kept-removals.${workspaceId}`;
}

/** The remembered mode, or `"chat"` for a conversation never seen (or when storage fails). */
export function readWorkspaceMode(workspaceId: string): WorkspaceMode {
	return readKey(modeKey(workspaceId)) === "notebook" ? "notebook" : "chat";
}

export function writeWorkspaceMode(workspaceId: string, mode: WorkspaceMode): void {
	writeKey(modeKey(workspaceId), mode);
}

/** Whether the owner dismissed the "notebook is taking shape" suggestion for this workspace. */
export function isNotebookSuggestDismissed(workspaceId: string): boolean {
	return readKey(suggestKey(workspaceId)) === "1";
}

export function dismissNotebookSuggest(workspaceId: string): void {
	writeKey(suggestKey(workspaceId), "1");
}

/**
 * Assistant-proposed removals the owner kept (declined), keyed by
 * `${runId}:${widgetId}`, remembered per workspace so the confirm row never
 * returns for them.
 */
export function readKeptRemovals(workspaceId: string): Readonly<Record<string, true>> {
	const raw = readKey(keepKey(workspaceId));
	if (raw === null) return {};
	const parsed = parseJson(raw);
	if (!parsed.ok) return {};
	const value = parsed.value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const kept: Record<string, true> = {};
	for (const [key, flag] of Object.entries(value)) {
		if (flag === true) kept[key] = true;
	}
	return kept;
}

function keptRemovalKey(runId: string, widgetId: string): string {
	return `${runId}:${widgetId}`;
}

export function isKeptRemoval(
	kept: Readonly<Record<string, true>>,
	runId: string,
	widgetId: string,
): boolean {
	return kept[keptRemovalKey(runId, widgetId)] === true;
}

export function rememberKeptRemoval(
	workspaceId: string,
	kept: Readonly<Record<string, true>>,
	runId: string,
	widgetId: string,
): Readonly<Record<string, true>> {
	const next = { ...kept, [keptRemovalKey(runId, widgetId)]: true as const };
	writeKey(keepKey(workspaceId), JSON.stringify(next));
	return next;
}

/**
 * Reactive mode for one open conversation: follows the workspace id (a new
 * conversation reads its own remembered mode) and persists every change.
 * The workspace id is an accessor because the conversation can change
 * without remounting the page.
 */
export function createWorkspaceMode(
	workspaceId: Accessor<string | null>,
): readonly [Accessor<WorkspaceMode>, (mode: WorkspaceMode) => void] {
	const [mode, setModeSignal] = createSignal<WorkspaceMode>("chat");
	createEffect(() => {
		const id = workspaceId();
		setModeSignal(id === null ? "chat" : readWorkspaceMode(id));
	});
	const setMode = (next: WorkspaceMode): void => {
		setModeSignal(next);
		const id = workspaceId();
		if (id !== null) writeWorkspaceMode(id, next);
	};
	return [mode, setMode] as const;
}
