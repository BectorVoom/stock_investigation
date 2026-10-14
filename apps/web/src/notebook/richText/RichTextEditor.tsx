import { NOTEBOOK_LIMITS } from "@research/contracts";
import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { isAllowedLinkTarget } from "./model.ts";

/**
 * In-place Markdown editor for a Text widget (ADR-0021): a plain textarea
 * over the stored Markdown source, so no editor library ships in the
 * Notebook's initial chunk and the app's `style-src 'self'` CSP holds
 * (positioning is classes only, never inline style attributes). Notion
 * behaviours on top: Enter continues lists and quotes, `/` on an empty
 * line opens the block menu, a selection shows the formatting toolbar with
 * link editing, and to-do toggling lives in the read view.
 */

const SAVE_DEBOUNCE_MS = 800;
const MAX_CHARS = NOTEBOOK_LIMITS.maxTextChars;
/** Shows the quiet counter once the source gets this close to the cap. */
const COUNTER_WITHIN = 500;

interface BlockOption {
	readonly id: string;
	readonly label: string;
	readonly hint: string;
	readonly insert: string;
}

const BLOCK_MENU: readonly BlockOption[] = [
	{ id: "text", label: "Text", hint: "Plain paragraph", insert: "" },
	{ id: "h1", label: "Heading 1", hint: "Large section heading", insert: "# " },
	{ id: "h2", label: "Heading 2", hint: "Medium section heading", insert: "## " },
	{ id: "h3", label: "Heading 3", hint: "Small section heading", insert: "### " },
	{ id: "bullet", label: "Bulleted list", hint: "Dash list item", insert: "- " },
	{ id: "numbered", label: "Numbered list", hint: "Counted list item", insert: "1. " },
	{ id: "todo", label: "To-do", hint: "Checkbox list item", insert: "- [ ] " },
	{ id: "quote", label: "Quote", hint: "Quoted paragraph", insert: "> " },
	{ id: "code", label: "Code", hint: "Fenced code block", insert: "```\n\n```" },
	{ id: "divider", label: "Divider", hint: "Horizontal rule", insert: "---" },
];

function menuFilter(lineBeforeCaret: string): string | null {
	const match = /^\/([a-z ]*)$/i.exec(lineBeforeCaret);
	return match === null ? null : (match[1] ?? "");
}

function matchingOptions(filter: string): readonly BlockOption[] {
	const query = filter.trim().toLowerCase();
	if (query === "") return BLOCK_MENU;
	return BLOCK_MENU.filter((option) => option.label.toLowerCase().includes(query));
}

const LIST_MARKER = /^(- \[ \] |- \[x\] |- \[[Xx]\] |- |\* |\d+\. |> )(.*)$/;

export function RichTextEditor(props: {
	readonly initialText: string;
	readonly readOnly: boolean;
	readonly onSaveText: (text: string) => Promise<boolean>;
	/** Leaves the editor after everything saved; the owner's text is never dropped. */
	readonly onDone: () => void;
}): JSX.Element {
	let area: HTMLTextAreaElement | undefined;
	let root: HTMLDivElement | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let leaveRequested = false;
	const menuId = createUniqueId();

	const [draft, setDraft] = createSignal(props.initialText);
	const [base, setBase] = createSignal(props.initialText);
	const [saving, setSaving] = createSignal(false);
	const [menuFilterText, setMenuFilterText] = createSignal<string | null>(null);
	const [menuActive, setMenuActive] = createSignal(0);
	const [hasSelection, setHasSelection] = createSignal(false);
	const [linkOpen, setLinkOpen] = createSignal(false);
	const [linkUrl, setLinkUrl] = createSignal("");
	const [linkError, setLinkError] = createSignal<string | null>(null);
	const [linkExisting, setLinkExisting] = createSignal<{ start: number; end: number } | null>(null);

	const options = (): readonly BlockOption[] =>
		menuFilterText() === null ? [] : matchingOptions(menuFilterText() ?? "");

	const refreshMenu = (value: string, caretPos: number): void => {
		const lineStart = value.lastIndexOf("\n", caretPos - 1) + 1;
		setMenuFilterText(menuFilter(value.slice(lineStart, caretPos)));
		setMenuActive(0);
	};

	const refreshSelection = (): void => {
		if (area === undefined) {
			setHasSelection(false);
			return;
		}
		setHasSelection((area.selectionStart ?? 0) !== (area.selectionEnd ?? 0));
	};

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
		setMenuFilterText(null);
		setLinkOpen(false);
		if (saving() || draft() !== base()) {
			leaveRequested = true;
			if (!saving()) void requestSave();
			return;
		}
		props.onDone();
	};

	const setValue = (value: string): void => {
		const capped = value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) : value;
		setDraft(capped);
		if (area !== undefined && area.value !== capped) area.value = capped;
	};

	const onInput = (): void => {
		if (area === undefined) return;
		setValue(area.value);
		refreshMenu(area.value, area.selectionStart ?? 0);
		refreshSelection();
		scheduleSave();
	};

	/** Replaces [start, end) and puts the caret where the caller says. */
	const replaceRange = (
		start: number,
		end: number,
		insert: string,
		caretStart: number,
		caretEnd: number,
	): void => {
		const value = draft();
		const next = value.slice(0, start) + insert + value.slice(end);
		setValue(next);
		if (area !== undefined) {
			area.focus();
			area.setSelectionRange(Math.min(caretStart, MAX_CHARS), Math.min(caretEnd, MAX_CHARS));
		}
		refreshMenu(next, Math.min(caretEnd, MAX_CHARS));
		refreshSelection();
		scheduleSave();
	};

	const wrapSelection = (prefix: string, suffix: string): void => {
		if (area === undefined) return;
		const start = area.selectionStart ?? 0;
		const end = area.selectionEnd ?? 0;
		if (start === end) return;
		const selected = draft().slice(start, end);
		replaceRange(
			start,
			end,
			`${prefix}${selected}${suffix}`,
			start + prefix.length,
			end + prefix.length,
		);
	};

	const openLinkPopover = (): void => {
		if (area === undefined) return;
		const start = area.selectionStart ?? 0;
		const end = area.selectionEnd ?? 0;
		if (start === end) return;
		const selected = draft().slice(start, end);
		const existing = /^\[(.+)\]\((.*)\)$/.exec(selected);
		if (existing !== null) {
			setLinkExisting({ start, end });
			setLinkUrl(existing[2] ?? "");
		} else {
			setLinkExisting(null);
			setLinkUrl("");
		}
		setLinkError(null);
		setLinkOpen(true);
	};

	const applyLink = (): void => {
		const url = linkUrl().trim();
		if (!isAllowedLinkTarget(url)) {
			setLinkError("Use an http(s) or mailto link, without spaces.");
			return;
		}
		const existing = linkExisting();
		if (existing !== null) {
			const selected = draft().slice(existing.start, existing.end);
			const label = /^\[(.+)\]\(.*\)$/.exec(selected)?.[1] ?? selected;
			const insert = `[${label}](${url})`;
			replaceRange(
				existing.start,
				existing.end,
				insert,
				existing.start,
				existing.start + insert.length,
			);
		} else {
			if (area === undefined) return;
			const start = area.selectionStart ?? 0;
			const end = area.selectionEnd ?? 0;
			const selected = draft().slice(start, end);
			const insert = `[${selected}](${url})`;
			replaceRange(start, end, insert, start, start + insert.length);
		}
		setLinkOpen(false);
	};

	const removeLink = (): void => {
		const existing = linkExisting();
		if (existing === null) {
			setLinkOpen(false);
			return;
		}
		const selected = draft().slice(existing.start, existing.end);
		const label = /^\[(.+)\]\(.*\)$/.exec(selected)?.[1] ?? selected;
		replaceRange(
			existing.start,
			existing.end,
			label,
			existing.start,
			existing.start + label.length,
		);
		setLinkOpen(false);
	};

	const chooseOption = (option: BlockOption): void => {
		if (area === undefined) return;
		const value = draft();
		const caretPos = area.selectionStart ?? 0;
		const lineStart = value.lastIndexOf("\n", caretPos - 1) + 1;
		const insert = option.insert;
		const caretEnd = option.id === "code" ? lineStart + 4 : lineStart + insert.length;
		replaceRange(lineStart, caretPos, insert, caretEnd, caretEnd);
		setMenuFilterText(null);
	};

	/** Enter continues a list or quote; Enter on a bare marker leaves it. */
	const handleEnter = (): void => {
		if (area === undefined) return;
		const value = draft();
		const caretPos = area.selectionStart ?? 0;
		const start = area.selectionStart ?? 0;
		const end = area.selectionEnd ?? 0;
		const lineStart = value.lastIndexOf("\n", caretPos - 1) + 1;
		const line = value.slice(lineStart, caretPos);
		if (line.trim() === "```") {
			replaceRange(start, end, "\n\n```", lineStart + 4, lineStart + 4);
			return;
		}
		const marker = LIST_MARKER.exec(line);
		if (marker === null) return;
		const prefix = marker[1] ?? "";
		const rest = marker[2] ?? "";
		if (rest === "") {
			// Bare marker: leave the list instead of adding an empty item.
			replaceRange(lineStart, caretPos, "", lineStart, lineStart);
			return;
		}
		let nextPrefix = prefix;
		if (/^\d+\. $/.test(prefix)) {
			const number = Number.parseInt(prefix, 10);
			nextPrefix = `${Number.isFinite(number) ? number + 1 : 1}. `;
		} else if (/^- \[[Xx]\] $/.test(prefix)) {
			nextPrefix = "- [ ] ";
		}
		replaceRange(
			start,
			end,
			`\n${nextPrefix}`,
			start + 1 + nextPrefix.length,
			start + 1 + nextPrefix.length,
		);
	};

	/** Backspace on a bare marker removes the marker instead of joining lines. */
	const handleBackspace = (): boolean => {
		if (area === undefined) return false;
		const value = draft();
		const caretPos = area.selectionStart ?? 0;
		if ((area.selectionStart ?? 0) !== (area.selectionEnd ?? 0)) return false;
		const lineStart = value.lastIndexOf("\n", caretPos - 1) + 1;
		const line = value.slice(lineStart, caretPos);
		if (/^(- |> |- \[ \] |- |\* |\d+\. )$/.test(line)) {
			replaceRange(lineStart, caretPos, "", lineStart, lineStart);
			return true;
		}
		return false;
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape") {
			// The editor leaves first; the panel must not clear selection too.
			event.stopPropagation();
			event.preventDefault();
			if (linkOpen()) {
				setLinkOpen(false);
				area?.focus();
				return;
			}
			if (menuFilterText() !== null) {
				setMenuFilterText(null);
				return;
			}
			leave();
			return;
		}
		if (menuFilterText() !== null) {
			const list = options();
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				if (list.length === 0) return;
				const delta = event.key === "ArrowDown" ? 1 : -1;
				setMenuActive((active) => (active + delta + list.length) % list.length);
				return;
			}
			if (event.key === "Enter") {
				const active = list[menuActive()];
				if (active !== undefined) {
					event.preventDefault();
					chooseOption(active);
				}
				return;
			}
		}
		const mod = event.ctrlKey || event.metaKey;
		if (props.readOnly && mod) return;
		if (mod && !event.altKey && event.key.toLowerCase() === "b") {
			event.preventDefault();
			wrapSelection("**", "**");
			return;
		}
		if (mod && !event.altKey && event.key.toLowerCase() === "i") {
			event.preventDefault();
			wrapSelection("*", "*");
			return;
		}
		if (mod && event.shiftKey && event.key.toLowerCase() === "x") {
			event.preventDefault();
			wrapSelection("~~", "~~");
			return;
		}
		if (mod && !event.altKey && event.key.toLowerCase() === "e") {
			event.preventDefault();
			wrapSelection("`", "`");
			return;
		}
		if (mod && !event.altKey && event.key.toLowerCase() === "k") {
			event.preventDefault();
			if (linkOpen()) applyLink();
			else openLinkPopover();
			return;
		}
		if (event.key === "Enter" && !mod && !event.shiftKey && !props.readOnly) {
			const before = menuFilterText();
			if (before !== null) return;
			const areaEl = area;
			if (areaEl !== null && areaEl !== undefined) {
				const start = areaEl.selectionStart ?? 0;
				const end = areaEl.selectionEnd ?? 0;
				if (start === end) {
					const value = draft();
					const lineStart = value.lastIndexOf("\n", start - 1) + 1;
					if (
						LIST_MARKER.test(value.slice(lineStart, start)) ||
						value.slice(lineStart, start).trim() === "```"
					) {
						event.preventDefault();
						handleEnter();
					}
				}
			}
			return;
		}
		if (event.key === "Backspace" && !props.readOnly && handleBackspace()) {
			event.preventDefault();
		}
	};

	const onFocusOut = (event: FocusEvent): void => {
		const next = event.relatedTarget;
		if (next instanceof Node && root?.contains(next) === true) return;
		leave();
	};

	const counterVisible = (): boolean => draft().length >= MAX_CHARS - COUNTER_WITHIN;
	const activeDescendant = (): string | undefined => {
		const list = options();
		if (menuFilterText() === null || list.length === 0) return undefined;
		return `${menuId}-option-${menuActive() % list.length}`;
	};

	return (
		<div
			ref={(element) => {
				root = element;
			}}
			data-rich-text-editor
			class="relative rounded border border-blue-700 bg-white p-2"
			onFocusOut={onFocusOut}
		>
			<Show when={hasSelection() && !props.readOnly}>
				<div role="toolbar" aria-label="Formatting" class="mb-1 flex flex-wrap gap-1">
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-800"
						aria-label="Bold"
						disabled={props.readOnly}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => wrapSelection("**", "**")}
					>
						B
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-800"
						aria-label="Italic"
						disabled={props.readOnly}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => wrapSelection("*", "*")}
					>
						<em>I</em>
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-800"
						aria-label="Strikethrough"
						disabled={props.readOnly}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => wrapSelection("~~", "~~")}
					>
						<s>S</s>
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-800"
						aria-label="Code"
						disabled={props.readOnly}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => wrapSelection("`", "`")}
					>
						{"</>"}
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-800"
						aria-label="Link"
						disabled={props.readOnly}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLinkPopover}
					>
						Link
					</button>
				</div>
			</Show>
			<textarea
				ref={(element) => {
					area = element;
					element.focus();
					element.setSelectionRange(element.value.length, element.value.length);
				}}
				class="rich-text-input block max-h-96 min-h-24 w-full rounded bg-white text-sm text-slate-900"
				rows={8}
				maxLength={MAX_CHARS}
				// `readOnly`, not `disabled`: disabling a focused field moves
				// focus to the body, which would read as "leave the editor".
				readOnly={props.readOnly}
				aria-label="Edit text as Markdown"
				aria-controls={menuFilterText() !== null ? menuId : undefined}
				aria-activedescendant={activeDescendant()}
				value={draft()}
				onInput={onInput}
				onKeyUp={refreshSelection}
				onMouseUp={refreshSelection}
				onSelect={refreshSelection}
				onKeyDown={onKeyDown}
			/>
			<Show when={menuFilterText() !== null}>
				<div
					id={menuId}
					role="listbox"
					aria-label="Insert block"
					class="rich-text-menu absolute right-2 left-2 z-10 max-h-56 overflow-y-auto rounded border border-slate-300 bg-white py-1 shadow-none"
				>
					<Show when={options().length === 0} fallback={null}>
						<div class="px-3 py-1 text-xs text-slate-600">No matching blocks</div>
					</Show>
					<For each={options()}>
						{(option, index) => (
							// Listbox options stay unfocused on purpose: the textarea keeps
							// focus and drives the active option (ArrowUp/Down, Enter).
							// biome-ignore lint/a11y/useFocusableInteractive: active-descendant pattern
							// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the textarea
							<div
								id={`${menuId}-option-${index()}`}
								role="option"
								aria-selected={index() === menuActive() % Math.max(options().length, 1)}
								classList={{
									"flex cursor-pointer items-baseline gap-2 px-3 py-1 text-sm": true,
									"bg-blue-50": index() === menuActive() % Math.max(options().length, 1),
								}}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => chooseOption(option)}
								onMouseMove={() => setMenuActive(index())}
							>
								<span class="font-medium text-slate-900">{option.label}</span>
								<span class="text-xs text-slate-600">{option.hint}</span>
							</div>
						)}
					</For>
				</div>
			</Show>
			<Show when={linkOpen()}>
				<div
					role="dialog"
					aria-label="Edit link"
					class="absolute right-2 left-2 z-10 rounded border border-slate-300 bg-white p-2"
				>
					<label class="block text-xs font-medium text-slate-700" for={`${menuId}-url`}>
						Link URL (http, https or mailto)
					</label>
					<input
						id={`${menuId}-url`}
						ref={(element) => {
							element.focus();
							element.select();
						}}
						type="text"
						inputmode="url"
						class="mt-1 block w-full rounded border border-slate-400 bg-white px-2 py-1 text-sm text-slate-900"
						value={linkUrl()}
						onInput={(event) => {
							setLinkUrl(event.currentTarget.value);
							setLinkError(null);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								applyLink();
							}
							if (event.key === "Escape") {
								event.stopPropagation();
								setLinkOpen(false);
								area?.focus();
							}
						}}
					/>
					<Show when={linkError()}>
						{(error) => (
							<p role="alert" class="mt-1 text-xs text-red-900">
								{error()}
							</p>
						)}
					</Show>
					<div class="mt-2 flex gap-2">
						<button
							type="button"
							class="rounded bg-blue-700 px-2 py-1 text-xs font-medium text-white"
							onMouseDown={(event) => event.preventDefault()}
							onClick={applyLink}
						>
							Save link
						</button>
						<Show when={linkExisting() !== null}>
							<button
								type="button"
								class="rounded border border-slate-300 px-2 py-1 text-xs text-slate-800"
								onMouseDown={(event) => event.preventDefault()}
								onClick={removeLink}
							>
								Remove link
							</button>
						</Show>
						<button
							type="button"
							class="rounded border border-slate-300 px-2 py-1 text-xs text-slate-800"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								setLinkOpen(false);
								area?.focus();
							}}
						>
							Cancel
						</button>
					</div>
				</div>
			</Show>
			<div class="mt-1 flex items-baseline justify-between gap-2">
				<p class="text-2xs text-slate-600">
					<Show
						when={saving()}
						fallback={"Markdown: # headings, **bold**, [label](https://…) links"}
					>
						Saving…
					</Show>
				</p>
				<Show when={counterVisible()}>
					<p class="text-2xs text-slate-600">
						{draft().length} / {MAX_CHARS} characters
					</p>
				</Show>
			</div>
		</div>
	);
}
