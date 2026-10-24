import type { WidgetCore } from "@research/contracts";
import { useMessages } from "@research/i18n/solid";
import type { JSX } from "solid-js";
import { createSignal, Show } from "solid-js";
import { parseRichText } from "../richText/parser.ts";
import { RichTextEditor } from "../richText/RichTextEditor.tsx";
import { RichTextView } from "../richText/RichTextView.tsx";
import { toggleTodoLine } from "../richText/serializer.ts";
import { notebookWidgetMessages } from "./notebookWidgets.messages.tsx";

/**
 * A Text widget: the `WIDGET_TEXT_MARKDOWN` source rendered without
 * `innerHTML`, edited in place Notion-style. Clicking the body (or Enter
 * on the focused body) swaps the read view for the WYSIWYG editor; the
 * editor saves through `onSaveText` and closes itself when the save lands.
 * Focus moves into the editor on open and back to the body on leave.
 */
export function TextWidget(props: {
	readonly widget: Extract<WidgetCore, { readonly type: "text" }>;
	/**
	 * True while the notebook saves: a closed body does not open. An open
	 * editor stays editable — the session queues edits made during a save,
	 * and the editor saves its newest draft after the one in flight.
	 */
	readonly editingDisabled: boolean;
	/** Saves a new Markdown source; resolves false when the save failed. */
	readonly onSaveText: (widgetId: string, text: string) => Promise<boolean>;
}): JSX.Element {
	const m = useMessages(notebookWidgetMessages);
	const [editing, setEditing] = createSignal(false);
	let body: HTMLDivElement | undefined;
	const size = () => props.widget.size;
	const doc = () => parseRichText(props.widget.text);

	const open = (): void => {
		if (!props.editingDisabled) setEditing(true);
	};

	const close = (): void => {
		setEditing(false);
		// The editor leaves first (Escape stops propagation, so the panel
		// keeps its selection); return focus to the body it came from.
		const element = body;
		if (element !== undefined) {
			setTimeout(() => {
				element.focus({ preventScroll: true });
			}, 0);
		}
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
				ref={(element) => {
					body = element;
				}}
				tabIndex={0}
				role="button"
				aria-label={m().editNote}
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
				// Every size shows the whole note; the frame body scrolls.
				fallback={readBody()}
			>
				<RichTextEditor
					initialText={props.widget.text}
					size={size()}
					onSaveText={(text) => props.onSaveText(props.widget.widgetId, text)}
					onDone={close}
				/>
			</Show>
		</div>
	);
}
