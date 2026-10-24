import { NOTEBOOK_LIMITS } from "@research/contracts";
import type { MessagesOf } from "@research/i18n";
import { useMessages } from "@research/i18n/solid";
import { lift, setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { DOMSerializer, Fragment } from "prosemirror-model";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import {
	createEffect,
	createSignal,
	createUniqueId,
	For,
	type JSX,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { commonMessages } from "../../i18n/common.messages.ts";
import { notebookWidgetMessages } from "../widgets/notebookWidgets.messages.tsx";
import { modelToPm, pmToModel } from "./docConvert.ts";
import { isAllowedLinkTarget } from "./model.ts";
import { parseRichText } from "./parser.ts";
import { sanitizePastedHTML } from "./pasteSanitize.ts";
import { richTextPlugins } from "./pmRules.ts";
import { type BlockOptionId, richTextMessages } from "./richText.messages.ts";
import { richTextSchema, todoItemDOM } from "./schema.ts";
import { serializeRichText } from "./serializer.ts";

/**
 * The WYSIWYG editing surface (ADR-0021 task W4b): what the owner edits IS
 * the formatted text — headings look like headings while typing, bold is
 * bold, links are links, to-dos are checkboxes. ProseMirror ships in a
 * lazily imported chunk (see `RichTextEditor.tsx`), converts through the
 * typed tree on every edit (Markdown → parser model → doc on open, doc →
 * model → serializer for saves), and sets no inline style attributes and no
 * injected `<style>` (needed ProseMirror CSS lives in `styles.css`), so
 * the app's `style-src 'self'` CSP holds.
 */

const MAX_CHARS = NOTEBOOK_LIMITS.maxTextChars;
const nodes = richTextSchema.nodes;
const markTypes = richTextSchema.marks;

/** Live views by mount element, so happy-dom tests can drive the editor. */
const testViews = new WeakMap<HTMLDivElement, EditorView>();

/**
 * Test hook: the live ProseMirror view hosted by a `data-wysiwyg-mount`
 * element (undefined once destroyed). DOM tests drive typing, selections
 * and keys through it; the rest (toolbar buttons, popover inputs, the block
 * menu) goes through the rendered DOM like a person would.
 */
export function wysiwygViewFor(element: HTMLDivElement): EditorView | undefined {
	return testViews.get(element);
}

type RichTextWords = MessagesOf<typeof richTextMessages>;

interface BlockOption {
	readonly id: BlockOptionId;
	readonly label: string;
	readonly hint: string;
}

const BLOCK_MENU: readonly BlockOptionId[] = [
	"text",
	"h1",
	"h2",
	"h3",
	"bullet",
	"numbered",
	"todo",
	"quote",
	"code",
	"divider",
];

/**
 * The "/" menu's options for a typed filter, labelled in the current
 * language. The filter matches the shown label or the English one, so
 * "/head" keeps working whatever the UI language.
 */
function matchingOptions(filter: string, words: RichTextWords): readonly BlockOption[] {
	const query = filter.trim().toLowerCase();
	const english = richTextMessages.en;
	return BLOCK_MENU.filter(
		(id) =>
			query === "" ||
			words.blockLabel(id).toLowerCase().includes(query) ||
			english.blockLabel(id).toLowerCase().includes(query),
	).map((id) => ({ id, label: words.blockLabel(id), hint: words.blockHint(id) }));
}

/**
 * A to-do item rendered like the schema's own DOM, plus the checkbox's
 * accessible name in the current language. Without `update`, ProseMirror
 * redraws the view whenever the node's markup (its `checked`) changes, as
 * it does for schema-rendered nodes.
 */
function todoItemView(checked: boolean, toggleLabel: string): NodeView {
	const rendered = DOMSerializer.renderSpec(document, todoItemDOM(checked, toggleLabel));
	return { dom: rendered.dom, contentDOM: rendered.contentDOM ?? null };
}

function serializeDoc(doc: ReturnType<typeof modelToPm>): string {
	return serializeRichText(pmToModel(doc));
}

export function WysiwygEditor(props: {
	readonly initialText: string;
	readonly size: "small" | "medium" | "large";
	readonly onDocChange: (markdown: string) => void;
	/** Leaves the editor (Escape, or focus moving outside): the loader saves, then closes. */
	readonly onLeave: () => void;
}): JSX.Element {
	const m = useMessages(richTextMessages);
	const common = useMessages(commonMessages);
	const widgetWords = useMessages(notebookWidgetMessages);
	let mount: HTMLDivElement | undefined;
	let root: HTMLDivElement | undefined;
	let view: EditorView | undefined;
	const menuId = createUniqueId();
	let lastMarkdown = props.initialText;

	const [hasSelection, setHasSelection] = createSignal(false);
	const [menuFilter, setMenuFilter] = createSignal<string | null>(null);
	const [menuActive, setMenuActive] = createSignal(0);
	const [linkOpen, setLinkOpen] = createSignal(false);
	const [linkUrl, setLinkUrl] = createSignal("");
	const [linkError, setLinkError] = createSignal<string | null>(null);
	const [linkRange, setLinkRange] = createSignal<{
		readonly from: number;
		readonly to: number;
	} | null>(null);

	const options = (): readonly BlockOption[] =>
		menuFilter() === null ? [] : matchingOptions(menuFilter() ?? "", m());

	const syncFromState = (): void => {
		const current = view;
		if (current === undefined) return;
		const { state } = current;
		setHasSelection(!state.selection.empty);
		const { $from } = state.selection;
		const cursor = state.selection instanceof TextSelection ? state.selection.$cursor : null;
		if (
			cursor !== null &&
			cursor.pos === $from.end() &&
			($from.parent.type === nodes.paragraph || $from.parent.type === nodes.heading) &&
			$from.parent.type !== nodes.code_block
		) {
			const text = $from.parent.textContent;
			// Letters of any script, so a Japanese filter ("/見出し") keeps the menu open.
			const match = /^\/([\p{L} ]*)$/iu.exec(text);
			if (match !== null) {
				const next = match[1] ?? "";
				if (menuFilter() !== next) setMenuActive(0);
				setMenuFilter(next);
				syncMenuAria();
				return;
			}
		}
		setMenuFilter(null);
		syncMenuAria();
	};

	/** The active-descendant wiring lives on the editable element (classes only). */
	const syncMenuAria = (): void => {
		const dom = view?.dom;
		if (dom === undefined) return;
		const list = options();
		if (menuFilter() === null || list.length === 0) {
			dom.removeAttribute("aria-controls");
			dom.removeAttribute("aria-activedescendant");
			dom.removeAttribute("aria-expanded");
			return;
		}
		dom.setAttribute("aria-controls", menuId);
		dom.setAttribute("aria-activedescendant", `${menuId}-option-${menuActive() % list.length}`);
		dom.setAttribute("aria-expanded", "true");
	};

	const closeOverlay = (): void => {
		// Focus home BEFORE unmounting the popover/menu: removing the
		// focused input moves focus to the body, which reads as "leave".
		view?.focus();
		setMenuFilter(null);
		setLinkOpen(false);
		setLinkError(null);
		syncMenuAria();
	};

	const applyMark = (kind: "strong" | "em" | "strike" | "code"): void => {
		const current = view;
		if (current === undefined) return;
		const markType =
			kind === "strong"
				? markTypes.strong
				: kind === "em"
					? markTypes.em
					: kind === "strike"
						? markTypes.strike
						: markTypes.code;
		toggleMark(markType)(current.state, current.dispatch);
		current.focus();
	};

	const openLinkPopover = (): void => {
		const current = view;
		if (current === undefined) return;
		const { from, to } = current.state.selection;
		if (from === to) return;
		let href = "";
		current.state.doc.nodesBetween(from, to, (node) => {
			if (href !== "" || !node.isText) return true;
			for (const mark of node.marks) {
				if (mark.type === markTypes.link) {
					const candidate = mark.attrs.href;
					if (typeof candidate === "string" && isAllowedLinkTarget(candidate) && href === "")
						href = candidate;
				}
			}
			return true;
		});
		setLinkRange({ from, to });
		setLinkUrl(href);
		setLinkError(null);
		setLinkOpen(true);
	};

	const applyLink = (): void => {
		const current = view;
		const range = linkRange();
		if (current === undefined || range === null) return;
		const url = linkUrl().trim();
		if (!isAllowedLinkTarget(url)) {
			setLinkError(m().invalidLink);
			return;
		}
		// Focus home before the popover unmounts (see `closeOverlay`).
		current.focus();
		const tr = current.state.tr.addMark(range.from, range.to, markTypes.link.create({ href: url }));
		current.dispatch(tr);
		setLinkOpen(false);
	};

	const removeLink = (): void => {
		const current = view;
		const range = linkRange();
		if (current === undefined || range === null) {
			setLinkOpen(false);
			return;
		}
		// Focus home before the popover unmounts (see `closeOverlay`).
		current.focus();
		current.dispatch(current.state.tr.removeMark(range.from, range.to, markTypes.link));
		setLinkOpen(false);
	};

	/** Lifts an in-quote/in-list paragraph to the document level (one dispatch per level). */
	const liftParagraphToDoc = (): boolean => {
		const current = view;
		if (current === undefined) return false;
		for (let guard = 0; guard < 5; guard += 1) {
			const { $from } = current.state.selection;
			if ($from.parent.type.name !== "paragraph") return false;
			if ($from.depth >= 1 && $from.node(-1).type === current.state.doc.type) return true;
			if ($from.depth < 2) return false;
			const grand = $from.node(-1);
			let ok = false;
			if (grand.type === nodes.list_item)
				ok = liftListItem(nodes.list_item)(current.state, current.dispatch);
			else if (grand.type === nodes.todo_item)
				ok = liftListItem(nodes.todo_item)(current.state, current.dispatch);
			else if (grand.type === nodes.blockquote) ok = lift(current.state, current.dispatch);
			if (!ok) return false;
		}
		return false;
	};

	const convertListType = (target: "bullet" | "ordered" | "todo"): void => {
		const current = view;
		if (current === undefined) return;
		const { $from } = current.state.selection;
		if ($from.depth < 2) return;
		const list = $from.node(-2);
		if (
			list.type !== nodes.bullet_list &&
			list.type !== nodes.ordered_list &&
			list.type !== nodes.todo_list
		)
			return;
		const targetList =
			target === "bullet"
				? nodes.bullet_list
				: target === "ordered"
					? nodes.ordered_list
					: nodes.todo_list;
		const targetItem = target === "todo" ? nodes.todo_item : nodes.list_item;
		const listPos = $from.before(-2);
		let tr = current.state.tr;
		const items: { readonly pos: number; readonly size: number; readonly checked: boolean }[] = [];
		list.forEach((child, offset) => {
			items.push({
				pos: listPos + 1 + offset,
				size: child.nodeSize,
				checked: child.attrs.checked === true,
			});
		});
		for (const item of items) {
			tr = tr.setNodeMarkup(
				item.pos,
				targetItem,
				target === "todo" ? { checked: item.checked } : undefined,
			);
		}
		tr = tr.setNodeMarkup(listPos, targetList);
		current.dispatch(tr);
	};

	const applyBlockOption = (id: string): void => {
		const current = view;
		if (current === undefined) return;
		if (id === "bullet" || id === "ordered" || id === "todo") {
			const { $from } = current.state.selection;
			const list = $from.depth >= 2 ? $from.node(-2) : null;
			const same =
				(id === "bullet" && list?.type === nodes.bullet_list) ||
				(id === "ordered" && list?.type === nodes.ordered_list) ||
				(id === "todo" && list?.type === nodes.todo_list);
			if (same) {
				current.focus();
				return;
			}
			if (
				list?.type === nodes.bullet_list ||
				list?.type === nodes.ordered_list ||
				list?.type === nodes.todo_list
			) {
				convertListType(id);
				current.focus();
				return;
			}
			if (!liftParagraphToDoc()) return;
			const listType =
				id === "bullet"
					? nodes.bullet_list
					: id === "ordered"
						? nodes.ordered_list
						: nodes.todo_list;
			wrapInList(listType)(current.state, current.dispatch);
			current.focus();
			return;
		}
		if (id === "quote") {
			const { $from } = current.state.selection;
			if ($from.depth >= 2 && $from.node(-1).type === nodes.blockquote) {
				current.focus();
				return;
			}
			if (!liftParagraphToDoc()) return;
			wrapIn(nodes.blockquote)(current.state, current.dispatch);
			current.focus();
			return;
		}
		if (id === "divider") {
			if (!liftParagraphToDoc()) return;
			const { $from } = current.state.selection;
			const blockPos = $from.before();
			const block = $from.parent;
			const hr = nodes.horizontal_rule.create();
			const paragraph = nodes.paragraph.create();
			const tr = current.state.tr.replaceWith(
				blockPos,
				blockPos + block.nodeSize,
				Fragment.from([hr, paragraph]),
			);
			tr.setSelection(TextSelection.create(tr.doc, blockPos + hr.nodeSize + 1));
			current.dispatch(tr.scrollIntoView());
			current.focus();
			return;
		}
		if (!liftParagraphToDoc()) return;
		if (id === "text") setBlockType(nodes.paragraph)(current.state, current.dispatch);
		else if (id === "h1")
			setBlockType(nodes.heading, { level: 1 })(current.state, current.dispatch);
		else if (id === "h2")
			setBlockType(nodes.heading, { level: 2 })(current.state, current.dispatch);
		else if (id === "h3")
			setBlockType(nodes.heading, { level: 3 })(current.state, current.dispatch);
		else if (id === "code") setBlockType(nodes.code_block)(current.state, current.dispatch);
		current.focus();
	};

	const chooseOption = (option: BlockOption): void => {
		const current = view;
		if (current === undefined) return;
		const { $from } = current.state.selection;
		current.dispatch(current.state.tr.delete($from.start(), $from.pos));
		applyBlockOption(option.id);
	};

	const menuConfirm = (): void => {
		const list = options();
		if (list.length === 0) return;
		const active = list[menuActive() % list.length];
		if (active !== undefined) chooseOption(active);
	};

	onMount(() => {
		const element = mount;
		if (element === undefined) return;
		const callbacks = {
			isMenuOpen: () => menuFilter() !== null,
			isLinkOpen: () => linkOpen(),
			menuMove: (delta: number) => {
				const list = options();
				if (list.length === 0) return;
				setMenuActive((active) => (active + delta + list.length) % list.length);
				syncMenuAria();
			},
			menuConfirm: () => menuConfirm(),
			closeOverlay: () => {
				closeOverlay();
				view?.focus();
			},
			openLink: () => openLinkPopover(),
			leave: () => props.onLeave(),
		};
		const state = EditorState.create({
			schema: richTextSchema,
			doc: modelToPm(parseRichText(props.initialText)),
			plugins: richTextPlugins(callbacks),
		});
		lastMarkdown = serializeDoc(state.doc);
		const next = new EditorView(element, {
			state,
			attributes: {
				"aria-label": widgetWords().editNote,
				role: "textbox",
				"aria-multiline": "true",
			},
			dispatchTransaction: (tr) => {
				const current = view;
				if (current === undefined) return;
				const applied = current.state.apply(tr);
				if (tr.docChanged) {
					const markdown = serializeDoc(applied.doc);
					// The length cap behaves like `maxLength`: growth past it
					// is dropped, shrinks and selections still apply.
					if (markdown.length > MAX_CHARS && markdown.length > lastMarkdown.length) return;
					if (markdown !== lastMarkdown) {
						lastMarkdown = markdown;
						props.onDocChange(markdown);
					}
				}
				current.updateState(applied);
				syncFromState();
			},
			handleClickOn: (targetView, pos, _node, _nodePos, event) => {
				const target = event.target;
				if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return false;
				event.preventDefault();
				// Focus home before the toggle re-renders the checkbox away:
				// removing the focused input moves focus to the body, which
				// reads as "leave the editor".
				targetView.focus();
				const $pos = targetView.state.doc.resolve(pos);
				for (let depth = $pos.depth; depth >= 0; depth -= 1) {
					const node = $pos.node(depth);
					if (node.type !== nodes.todo_item) continue;
					const itemPos = $pos.before(depth);
					const checked = node.attrs.checked === true;
					targetView.dispatch(
						targetView.state.tr.setNodeMarkup(itemPos, undefined, { checked: !checked }),
					);
					return true;
				}
				return false;
			},
			nodeViews: {
				todo_item: (node) => todoItemView(node.attrs.checked === true, m().toggleTodo),
			},
			transformPastedHTML: (html) => sanitizePastedHTML(html),
			transformPastedText: (text) => {
				const remaining = MAX_CHARS - lastMarkdown.length;
				if (remaining <= 0) return "";
				return text.length > remaining ? text.slice(0, remaining) : text;
			},
			handleDOMEvents: {
				// A checkbox mousedown must not move focus (nor the caret):
				// the toggle re-renders the input, and losing it to the body
				// reads as "leave the editor". The click still fires, so
				// `handleClickOn` toggles through the document.
				mousedown: (_view, event) => {
					const target = event.target;
					if (target instanceof HTMLInputElement && target.type === "checkbox") {
						event.preventDefault();
						return true;
					}
					return false;
				},
			},
		});
		view = next;
		testViews.set(element, next);
		next.focus();
		syncFromState();
		onCleanup(() => {
			next.destroy();
			if (view === next) view = undefined;
			testViews.delete(element);
		});
	});

	createEffect(() => {
		syncFromState();
	});

	const onFocusOut = (event: FocusEvent): void => {
		const next = event.relatedTarget;
		if (next instanceof Node && root?.contains(next) === true) return;
		props.onLeave();
	};

	return (
		<div
			ref={(element) => {
				root = element;
			}}
			class="relative"
			onFocusOut={onFocusOut}
		>
			<Show when={hasSelection() && !linkOpen()}>
				<div role="toolbar" aria-label={m().formatting} class="mb-1 flex flex-wrap gap-1">
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs font-semibold text-slate-800"
						aria-label={m().bold}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => applyMark("strong")}
					>
						B
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-800"
						aria-label={m().italic}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => applyMark("em")}
					>
						<em>I</em>
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-800"
						aria-label={m().strikethrough}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => applyMark("strike")}
					>
						<s>S</s>
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 font-mono text-xs text-slate-800"
						aria-label={m().code}
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => applyMark("code")}
					>
						{"</>"}
					</button>
					<button
						type="button"
						class="rounded border border-slate-300 px-2 py-0.5 text-xs text-slate-800"
						aria-label={m().link}
						onMouseDown={(event) => event.preventDefault()}
						onClick={openLinkPopover}
					>
						{m().link}
					</button>
				</div>
			</Show>
			<div
				ref={(element) => {
					mount = element;
				}}
				data-wysiwyg-mount
				classList={{
					"overflow-y-auto rounded bg-white text-slate-900": true,
					"max-h-48": props.size === "small",
					"max-h-96": props.size !== "small",
					"text-xs": props.size === "small",
					"text-sm": props.size !== "small",
				}}
			/>
			<Show when={menuFilter() !== null}>
				<div
					id={menuId}
					role="listbox"
					aria-label={m().insertBlock}
					class="absolute right-2 left-2 z-10 max-h-56 overflow-y-auto rounded border border-slate-300 bg-white py-1"
				>
					<Show when={options().length === 0} fallback={null}>
						<div class="px-3 py-1 text-xs text-slate-600">{m().noMatchingBlocks}</div>
					</Show>
					<For each={options()}>
						{(option, index) => (
							// Listbox options stay unfocused on purpose: the editor keeps
							// focus and drives the active option (ArrowUp/Down, Enter).
							// biome-ignore lint/a11y/useFocusableInteractive: active-descendant pattern
							// biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the editor
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
					aria-label={m().editLink}
					class="absolute right-2 left-2 z-10 rounded border border-slate-300 bg-white p-2"
				>
					<label class="block text-xs font-medium text-slate-700" for={`${menuId}-url`}>
						{m().linkUrl}
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
								closeOverlay();
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
							{m().saveLink}
						</button>
						<button
							type="button"
							class="rounded border border-slate-300 px-2 py-1 text-xs text-slate-800"
							onMouseDown={(event) => event.preventDefault()}
							onClick={removeLink}
						>
							{m().removeLink}
						</button>
						<button
							type="button"
							class="rounded border border-slate-300 px-2 py-1 text-xs text-slate-800"
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => {
								view?.focus();
								setLinkOpen(false);
							}}
						>
							{common().cancel}
						</button>
					</div>
				</div>
			</Show>
		</div>
	);
}
