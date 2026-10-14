import type { NotebookWidget } from "@research/contracts";
import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { parseRichText } from "../richText/parser.ts";
import { RichTextEditor } from "../richText/RichTextEditor.tsx";
import { RichTextView } from "../richText/RichTextView.tsx";
import { toggleTodoLine } from "../richText/serializer.ts";

/**
 * A Text widget: the `NOTEBOOK_TEXT_MARKDOWN` source rendered without
 * `innerHTML`, edited in place Notion-style. Clicking the body (or Enter
 * on the focused body) swaps the read view for the editor; the editor
 * saves through `onSaveText` and closes itself when the save lands.
 */
export function TextWidget(props: {
	readonly widget: Extract<NotebookWidget, { readonly type: "text" }>;
	/** True while the notebook saves: the body stays read-only. */
	readonly editingDisabled: boolean;
	/** Saves a new Markdown source; resolves false when the save failed. */
	readonly onSaveText: (widgetId: string, text: string) => Promise<boolean>;
}): JSX.Element {
	const [editing, setEditing] = createSignal(false);
	const size = () => props.widget.size;
	const doc = () => parseRichText(props.widget.text);

	const open = (): void => {
		if (!props.editingDisabled) setEditing(true);
	};

	const openFromBody = (event: MouseEvent): void => {
		const target = event.target;
		// Links navigate and checkboxes toggle; neither opens the editor.
		if (target instanceof HTMLElement && target.closest("a,input,button") !== null) return;
		open();
	};

	const openFromKeyboard = (event: KeyboardEvent): void => {
		if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			open();
		}
	};

	/** To-do checkboxes toggle and save even when not editing. */
	const toggleTodo = (line: number): void => {
		if (props.editingDisabled) return;
		const next = toggleTodoLine(props.widget.text, line);
		if (next !== props.widget.text) void props.onSaveText(props.widget.widgetId, next);
	};

	const view = (): JSX.Element => (
		<RichTextView
			doc={doc()}
			onToggleTodo={props.editingDisabled ? null : toggleTodo}
			checkboxesDisabled={props.editingDisabled}
		/>
	);

	/**
	 * The read body: clickable (and Enter-operable) when edits are allowed,
	 * plain text otherwise. Links navigate and checkboxes toggle instead of
	 * opening the editor (see `openFromBody`).
	 */
	const readBody = (): JSX.Element => (
		<Show
			when={!props.editingDisabled}
			fallback={
				<div data-text-view class="rich-text-view rounded">
					{view()}
				</div>
			}
		>
			{/* biome-ignore lint/a11y/useSemanticElements: the rendered note (headings, lists, links) forbids a real button */}
			<div
				data-text-view
				tabIndex={0}
				role="button"
				aria-label="Edit note"
				class="rich-text-view rounded"
				onClick={openFromBody}
				onKeyDown={openFromKeyboard}
			>
				{view()}
			</div>
		</Show>
	);

	return (
		<div
			data-widget-body="text"
			classList={{
				"text-xs text-slate-800": size() === "small",
				"text-sm text-slate-900": size() !== "small",
				"max-w-prose": size() === "large",
			}}
		>
			<Show
				when={editing()}
				fallback={
					<Show when={size() === "small"} fallback={readBody()}>
						<div class="relative max-h-24 overflow-hidden">
							{readBody()}
							<div
								aria-hidden="true"
								class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-white to-transparent"
							/>
						</div>
					</Show>
				}
			>
				<RichTextEditor
					initialText={props.widget.text}
					readOnly={props.editingDisabled}
					onSaveText={(text) => props.onSaveText(props.widget.widgetId, text)}
					onDone={() => setEditing(false)}
				/>
			</Show>
		</div>
	);
}
