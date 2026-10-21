import {
	NOTEBOOK_LIMITS,
	type NotebookWidgetOrigin,
	notebookWidgetOriginSchema,
	type WidgetCore,
	widgetCoreSchema,
} from "@research/contracts";
import { parseJsonOrNull } from "@research/domain";
import { type Accessor, createSignal } from "solid-js";
import { z } from "zod";
import {
	browserLocalStorage,
	type KeyValueStorage,
	readStoredText,
	writeStoredText,
} from "../lib/browserStorage.ts";
import { duplicateWidget } from "./widgetModel.ts";

/**
 * The app's one widget clipboard (ADR-0023), separate from the system
 * clipboard: a widget is structured data the server validates, and browsers
 * only allow plain text and HTML on the system clipboard. It holds widget
 * cores and origins plus the page they came from (a conversation id, or
 * `HOME_CLIPBOARD_SCOPE`), in memory and in `localStorage`, so a widget cut
 * in one chat can be pasted into another, or between Home and a notebook
 * (ADR-0024) — after a reload or in another tab.
 */

/** The clipboard scope of the Home page: never a conversation id, so research widgets never paste there. */
export const HOME_CLIPBOARD_SCOPE = "home";

/** Storage key of the persisted clipboard (one clipboard for the whole app). */
export const WIDGET_CLIPBOARD_STORAGE_KEY = "research.notebookWidgetClipboard.v1";

export interface WidgetClipboardEntry {
	readonly core: WidgetCore;
	readonly origin: NotebookWidgetOrigin;
}

export interface WidgetClipboardContent {
	readonly sourceWorkspaceId: string;
	readonly entries: readonly WidgetClipboardEntry[];
}

const widgetClipboardEntrySchema = z.strictObject({
	core: widgetCoreSchema,
	origin: notebookWidgetOriginSchema,
});

const widgetClipboardSchema = z.strictObject({
	version: z.literal(1),
	sourceWorkspaceId: z.string().min(1),
	entries: z.array(widgetClipboardEntrySchema).max(NOTEBOOK_LIMITS.maxWidgets),
});

/**
 * Parses unknown data (a storage read) into clipboard content. Invalid or
 * absent data means an empty clipboard — never a throw.
 */
export function parseWidgetClipboard(raw: unknown): WidgetClipboardContent | null {
	const parsed = widgetClipboardSchema.safeParse(raw);
	if (!parsed.success) return null;
	if (parsed.data.entries.length === 0) return null;
	return {
		sourceWorkspaceId: parsed.data.sourceWorkspaceId,
		entries: parsed.data.entries,
	};
}

/** Parses stored JSON text; invalid or absent text means an empty clipboard. */
export function parseWidgetClipboardJson(raw: string | null): WidgetClipboardContent | null {
	return raw === null ? null : parseWidgetClipboard(parseJsonOrNull(raw));
}

function serializeWidgetClipboard(content: WidgetClipboardContent): string {
	return JSON.stringify({
		version: 1,
		sourceWorkspaceId: content.sourceWorkspaceId,
		entries: [...content.entries],
	});
}

export interface ClipboardPaste {
	/** What to insert, in clipboard order, under fresh ids. */
	readonly entries: readonly WidgetClipboardEntry[];
	/** Research widgets left out because the target is another workspace. */
	readonly skippedResearch: number;
}

function ownerOrigin(): NotebookWidgetOrigin {
	return { kind: "owner", messageId: null, runId: null, componentId: null };
}

/**
 * Turns the clipboard into what to insert for a target workspace: every
 * entry under a fresh id (a deep copy through `duplicateWidget`).
 * Within the same workspace the original origin is kept (cut + paste is a
 * move); elsewhere the widget becomes owner-made. A `research` widget shows a
 * research component of its own chat, so it is skipped outside that chat.
 */
export function resolveClipboardPaste(
	clipboard: WidgetClipboardContent | null,
	targetWorkspaceId: string,
): ClipboardPaste {
	if (clipboard === null) return { entries: [], skippedResearch: 0 };
	const crossWorkspace = clipboard.sourceWorkspaceId !== targetWorkspaceId;
	const entries: WidgetClipboardEntry[] = [];
	let skippedResearch = 0;
	for (const entry of clipboard.entries) {
		if (entry.core.type === "research" && crossWorkspace) {
			skippedResearch += 1;
			continue;
		}
		entries.push({
			core: duplicateWidget(entry.core),
			origin: crossWorkspace ? ownerOrigin() : entry.origin,
		});
	}
	return { entries, skippedResearch };
}

/** "1 widget" / "2 widgets" for the clipboard announcements. */
export function clipboardCountText(count: number, verb: "Cut" | "Copied" | "Pasted"): string {
	return `${verb} ${count} widget${count === 1 ? "" : "s"}.`;
}

/** The announcement after Remove (no confirmation: Undo restores). */
export function removedCountText(count: number): string {
	return `Removed ${count} widget${count === 1 ? "" : "s"}. Undo restores ${count === 1 ? "it" : "them"}.`;
}

/** The notice when research widgets stayed behind in their own chat. */
export function skippedResearchNoticeText(skipped: number): string {
	return skipped === 1
		? "1 research result stays in its own chat and was not pasted."
		: `${skipped} research results stay in their own chat and were not pasted.`;
}

/** The `Storage`-like surface the store needs (a fake in tests). */
export type WidgetClipboardStorage = KeyValueStorage;

export interface WidgetClipboardStore {
	/** The current content; null while the clipboard is empty. */
	readonly content: Accessor<WidgetClipboardContent | null>;
	readonly isEmpty: Accessor<boolean>;
	/** Fills the clipboard (in notebook order) and persists it. */
	readonly set: (sourceWorkspaceId: string, entries: readonly WidgetClipboardEntry[]) => void;
	/** Re-reads the persisted clipboard (another tab may have changed it). */
	readonly reload: () => void;
}

/**
 * The reactive shell around the pure parse/transform above: a Solid signal
 * holding the current content (so Paste buttons enable reactively), written
 * through to storage (`browserStorage.ts`: storage may throw or be full — the
 * in-memory copy still holds). Cross-tab refresh arrives through `reload`
 * (the app singleton wires it to the `storage` event below).
 */
export function createWidgetClipboardStore(
	storage: WidgetClipboardStorage | null,
): WidgetClipboardStore {
	const readStored = (): WidgetClipboardContent | null =>
		parseWidgetClipboardJson(readStoredText(storage, WIDGET_CLIPBOARD_STORAGE_KEY));
	const [content, setContent] = createSignal<WidgetClipboardContent | null>(readStored());
	const isEmpty = (): boolean => content() === null;

	const set = (sourceWorkspaceId: string, entries: readonly WidgetClipboardEntry[]): void => {
		const next: WidgetClipboardContent | null =
			entries.length === 0 ? null : { sourceWorkspaceId, entries: [...entries] };
		setContent(next);
		// A refused write leaves the in-memory copy, which still holds for this visit.
		writeStoredText(
			storage,
			WIDGET_CLIPBOARD_STORAGE_KEY,
			next === null ? null : serializeWidgetClipboard(next),
		);
	};

	const reload = (): void => {
		setContent(readStored());
	};

	return { content, isEmpty, set, reload };
}

let singleton: WidgetClipboardStore | null = null;
let subscribed = false;

/**
 * The module-level singleton: one clipboard for the app, shared across
 * chats. Read from storage on first use, so a paste after a reload works,
 * and refreshed from the `storage` event (another tab) for the app's
 * lifetime — the listener is module-level, never tied to one panel's mount,
 * so navigating between chats never unwires it.
 */
export function widgetClipboard(): WidgetClipboardStore {
	if (singleton === null) singleton = createWidgetClipboardStore(browserLocalStorage());
	if (
		!subscribed &&
		typeof window !== "undefined" &&
		typeof window.addEventListener === "function"
	) {
		subscribed = true;
		window.addEventListener("storage", (event: StorageEvent) => {
			if (event.key !== null && event.key !== WIDGET_CLIPBOARD_STORAGE_KEY) return;
			singleton?.reload();
		});
	}
	return singleton;
}

/** Forgets the singleton (tests); the next use re-reads storage. */
export function resetWidgetClipboard(): void {
	singleton = null;
}
