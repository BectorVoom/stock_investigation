import { NOTEBOOK_LIMITS } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import { createSignal, type JSX, lazy, Show, Suspense } from "solid-js";
import { commonMessages } from "../../i18n/common.messages.ts";
import { richTextMessages } from "./richText.messages.ts";

/**
 * In-place WYSIWYG editor for a Text widget (ADR-0021 task W4b). This module
 * is the lazy boundary: it imports no ProseMirror itself, so the Notebook's
 * initial chunk stays small and the editor chunk loads on the first edit
 * (`import("./WysiwygEditor.tsx")` below). It owns the save rules —
 * debounced ~800 ms while typing and on leave, one save in flight, a failed
 * save keeps the editor open with the text — the length cap counter and the
 * leave guards; the formatting surface lives in `WysiwygEditor.tsx`.
 */

const SAVE_DEBOUNCE_MS = 800;
const MAX_CHARS = NOTEBOOK_LIMITS.maxTextChars;
/** Shows the quiet counter once the source gets this close to the cap. */
const COUNTER_WITHIN = 500;

const LazyEditor = lazy(() =>
	import("./WysiwygEditor.tsx").then((module) => ({ default: module.WysiwygEditor })),
);

export function RichTextEditor(props: {
	readonly initialText: string;
	readonly size: "small" | "medium" | "large";
	readonly onSaveText: (text: string) => Promise<boolean>;
	/** Leaves the editor after everything saved; the owner's text is never dropped. */
	readonly onDone: () => void;
}): JSX.Element {
	const m = useMessages(richTextMessages);
	const common = useMessages(commonMessages);
	let root: HTMLDivElement | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let leaveRequested = false;

	const [draft, setDraft] = createSignal(props.initialText);
	const [base, setBase] = createSignal(props.initialText);
	const [saving, setSaving] = createSignal(false);

	const clearTimer = (): void => {
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
	};

	const scheduleSave = (): void => {
		clearTimer();
		timer = setTimeout(() => {
			timer = undefined;
			void requestSave();
		}, SAVE_DEBOUNCE_MS);
	};

	/** Latest-wins save: one `onSaveText` in flight; a newer draft saves after. */
	const saveNow = async (text: string): Promise<void> => {
		setSaving(true);
		let ok = false;
		try {
			ok = await props.onSaveText(text);
		} catch {
			ok = false;
		}
		setSaving(false);
		// A failed save keeps the editor open with the draft intact; the
		// session's own notice says why, so the owner's text is never lost.
		if (ok) setBase(text);
		if (draft() !== text) {
			// A newer draft arrived while this save was in flight: save that one too.
			void saveNow(draft());
			return;
		}
		if (leaveRequested && draft() === base()) {
			leaveRequested = false;
			props.onDone();
		}
	};

	const requestSave = (): Promise<void> => {
		if (saving()) return Promise.resolve();
		if (draft() === base()) {
			if (leaveRequested) {
				leaveRequested = false;
				props.onDone();
			}
			return Promise.resolve();
		}
		return saveNow(draft());
	};

	/** Leave (Escape, or focus moving outside the editor): save, then close. */
	const leave = (): void => {
		clearTimer();
		if (saving() || draft() !== base()) {
			leaveRequested = true;
			if (!saving()) void requestSave();
			return;
		}
		props.onDone();
	};

	const onDocChange = (markdown: string): void => {
		const capped = markdown.length > MAX_CHARS ? markdown.slice(0, MAX_CHARS) : markdown;
		setDraft(capped);
		scheduleSave();
	};

	const onFocusOut = (event: FocusEvent): void => {
		const next = event.relatedTarget;
		if (next instanceof Node && root?.contains(next) === true) return;
		leave();
	};

	const counterVisible = (): boolean => draft().length >= MAX_CHARS - COUNTER_WITHIN;

	return (
		<div
			ref={(element) => {
				root = element;
			}}
			data-rich-text-editor
			class="relative rounded border border-blue-700 bg-white p-2"
			onFocusOut={onFocusOut}
		>
			<Suspense fallback={<div class="p-2 text-sm text-slate-600">{m().loadingEditor}</div>}>
				<LazyEditor
					initialText={props.initialText}
					size={props.size}
					onDocChange={onDocChange}
					onLeave={leave}
				/>
			</Suspense>
			{/* The hint teaches an empty note only: under written text it would
			    take a small widget's few lines for good. */}
			<Show when={saving() || draft() === "" || counterVisible()}>
				<div class="mt-1 flex items-baseline justify-between gap-2">
					<p class="text-2xs text-slate-600">
						<Show when={saving()} fallback={draft() === "" ? m().emptyHint : ""}>
							{common().saving}
						</Show>
					</p>
					<Show when={counterVisible()}>
						<p class="text-2xs text-slate-600">{m().characterCount(draft().length, MAX_CHARS)}</p>
					</Show>
				</div>
			</Show>
		</div>
	);
}
