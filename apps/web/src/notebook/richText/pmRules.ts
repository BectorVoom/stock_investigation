import { baseKeymap, lift, setBlockType, splitBlock, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import {
	InputRule,
	inputRules,
	textblockTypeInputRule,
	wrappingInputRule,
} from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import { Fragment, type MarkType, type NodeType, type Node as PmNode } from "prosemirror-model";
import { liftListItem, splitListItem } from "prosemirror-schema-list";
import { type EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { richTextSchema } from "./schema.ts";

const nodes = richTextSchema.nodes;
const markTypes = richTextSchema.marks;

/**
 * Marks `**x**`, `*x*`, `~~x~~` and `` `x` `` as the closing delimiter
 * lands. Each pattern requires the opener not to touch the same delimiter
 * character (`**bold**` must not match `*bold*` early), like the reference
 * ProseMirror markdown rules do.
 */
function markRule(pattern: RegExp, markType: MarkType): InputRule {
	return new InputRule(
		pattern,
		(state, match, start, end) => {
			const inner = match[1] ?? "";
			if (inner === "") return null;
			// The typed closer is not in the document yet: anchor on the
			// inner text (whose delimiters contain no such characters, so
			// the first occurrence is the opener's end).
			const textStart = start + match[0].indexOf(inner);
			const textEnd = textStart + inner.length;
			const tr = state.tr.delete(textEnd, end).delete(start, textStart);
			tr.addMark(start, start + inner.length, markType.create());
			// Keep typing plain afterwards: without this the next
			// keystroke inherits the just-applied mark at the boundary.
			tr.removeStoredMark(markType);
			return tr;
		},
		{ inCodeMark: false },
	);
}

function dividerRule(): InputRule {
	return new InputRule(/^--- $/, (state, _match, start, end) => {
		void end;
		// The whole block is exactly `--- `: swap the block itself for a
		// divider plus a fresh paragraph (offsets inside the old textblock
		// cannot host blocks, so resolve the block range instead).
		const $start = state.doc.resolve(start);
		if ($start.parent.type !== nodes.paragraph) return null;
		if ($start.depth < 1 || $start.node(-1).type !== state.doc.type) return null;
		const blockStart = $start.before();
		const blockEnd = $start.after();
		const hr = nodes.horizontal_rule.create();
		const paragraph = nodes.paragraph.create();
		const tr = state.tr.replaceWith(blockStart, blockEnd, Fragment.from([hr, paragraph]));
		tr.setSelection(TextSelection.create(tr.doc, blockStart + hr.nodeSize + 1));
		return tr;
	});
}

/**
 * Block markdown shortcuts at the start of a block (`# `, `- `, `1. `,
 * `[] ` / `- [ ] `, `> `, ` ``` `, `--- `) plus the inline mark rules.
 * ProseMirror core sets no inline style attributes and none of these rules do:
 * the app's `style-src 'self'` CSP holds.
 */
export function richTextInputRules(): InputRule[] {
	return [
		textblockTypeInputRule(/^(#{1,3}) $/, nodes.heading, (match) => {
			const hashes = match[1] ?? "#";
			return { level: hashes.length === 1 ? 1 : hashes.length === 2 ? 2 : 3 };
		}),
		wrappingInputRule(/^(-|\*) $/, nodes.bullet_list),
		wrappingInputRule(/^(\d+)\. $/, nodes.ordered_list),
		wrappingInputRule(/^(- \[\]|\[\]) $/, nodes.todo_list),
		wrappingInputRule(/^> $/, nodes.blockquote),
		textblockTypeInputRule(/^``` $/, nodes.code_block),
		dividerRule(),
		markRule(/(?<![*])\*\*([^*]+)\*\*$/, markTypes.strong),
		markRule(/(?<![*])\*([^*]+)\*$/, markTypes.em),
		markRule(/(?<![~])~~([^~]+)~~$/, markTypes.strike),
		markRule(/(?<![`])`([^`]+)`$/, markTypes.code),
	];
}

/** Enter on an empty list item leaves the list; elsewhere it splits it. */
function enterInListItem(
	state: EditorState,
	dispatch: ((tr: Transaction) => void) | undefined,
	itemType: NodeType,
): boolean {
	const { $from } = state.selection;
	if (!state.selection.empty) return false;
	if ($from.parent.type.name !== "paragraph" || $from.parent.content.size !== 0) return false;
	if ($from.depth < 3 || $from.node(-1).type !== itemType) return false;
	const item = $from.node(-1);
	const list = $from.node(-2);
	const itemPos = $from.before(-1);
	const listPos = $from.before(-2);
	if (dispatch === undefined) return true;
	if (list.childCount === 1) {
		const paragraph = nodes.paragraph.create();
		const tr = state.tr.replaceWith(listPos, listPos + list.nodeSize, paragraph);
		tr.setSelection(TextSelection.create(tr.doc, listPos + 1));
		dispatch(tr.scrollIntoView());
		return true;
	}
	const itemIndex = $from.index(-2);
	if (itemIndex === list.childCount - 1) {
		const paragraph = nodes.paragraph.create();
		const listEnd = $from.after(-2);
		const tr = state.tr.delete(itemPos, itemPos + item.nodeSize);
		tr.insert(listEnd - item.nodeSize, paragraph);
		tr.setSelection(TextSelection.create(tr.doc, listEnd - item.nodeSize + 1));
		dispatch(tr.scrollIntoView());
		return true;
	}
	const tr = state.tr.delete(itemPos, itemPos + item.nodeSize);
	tr.setSelection(TextSelection.near(tr.doc.resolve(itemPos)));
	dispatch(tr.scrollIntoView());
	return true;
}

export interface WysiwygKeyCallbacks {
	readonly isMenuOpen: () => boolean;
	readonly isLinkOpen: () => boolean;
	readonly menuMove: (delta: number) => void;
	readonly menuConfirm: () => void;
	readonly closeOverlay: () => void;
	readonly openLink: () => void;
	readonly leave: () => void;
}

/**
 * Enter/Backspace/marks/Escape for the subset schema. Lists are flat (one
 * paragraph per item), so Enter splits the item and an empty item exits;
 * headings split into a trailing paragraph; Backspace at a block start
 * lifts back to a paragraph.
 */
export function richTextKeymap(callbacks: WysiwygKeyCallbacks) {
	return keymap({
		Escape: () => {
			if (callbacks.isLinkOpen() || callbacks.isMenuOpen()) {
				callbacks.closeOverlay();
				return true;
			}
			callbacks.leave();
			return true;
		},
		ArrowUp: () => {
			if (!callbacks.isMenuOpen()) return false;
			callbacks.menuMove(-1);
			return true;
		},
		ArrowDown: () => {
			if (!callbacks.isMenuOpen()) return false;
			callbacks.menuMove(1);
			return true;
		},
		Enter: (state, dispatch, view) => {
			if (callbacks.isMenuOpen()) {
				callbacks.menuConfirm();
				return true;
			}
			const { $from } = state.selection;
			if ($from.parent.type === nodes.code_block) return false;
			if ($from.parent.type === nodes.heading) {
				// Enter after a heading starts a paragraph, not another
				// heading: split first, then turn the trailing half into one.
				if (dispatch === undefined || view === undefined) return true;
				if (!splitBlock(state, dispatch)) return false;
				setBlockType(nodes.paragraph)(view.state, view.dispatch);
				return true;
			}
			if (enterInListItem(state, dispatch, nodes.list_item)) return true;
			if (enterInListItem(state, dispatch, nodes.todo_item)) return true;
			if (
				state.selection.empty &&
				$from.parent.type === nodes.paragraph &&
				$from.parent.textContent === "---"
			) {
				if (dispatch === undefined) return true;
				const start = $from.start();
				const hr = nodes.horizontal_rule.create();
				const paragraph = nodes.paragraph.create();
				const tr = state.tr.delete(start, $from.pos);
				tr.replaceWith(start, start, Fragment.from([hr, paragraph]));
				tr.setSelection(TextSelection.create(tr.doc, start + hr.nodeSize + 1));
				dispatch(tr.scrollIntoView());
				return true;
			}
			if (splitListItem(nodes.list_item)(state, dispatch)) return true;
			if (splitListItem(nodes.todo_item)(state, dispatch)) return true;
			return false;
		},
		Backspace: (state, dispatch) => {
			const { $from } = state.selection;
			if (!state.selection.empty || $from.parentOffset !== 0) return false;
			const parent = $from.parent;
			if (parent.type === nodes.heading) return setBlockType(nodes.paragraph)(state, dispatch);
			if (parent.type === nodes.code_block) {
				if (dispatch === undefined) return true;
				const lines = parent.textContent.split("\n");
				const content: PmNode[] = [];
				for (const [index, line] of lines.entries()) {
					if (index > 0) content.push(nodes.hard_break.create());
					if (line !== "") content.push(richTextSchema.text(line));
				}
				const blockPos = $from.before();
				const tr = state.tr.replaceWith(
					blockPos,
					blockPos + parent.nodeSize,
					nodes.paragraph.create(null, Fragment.from(content)),
				);
				tr.setSelection(TextSelection.create(tr.doc, blockPos + 1));
				dispatch(tr.scrollIntoView());
				return true;
			}
			if ($from.depth < 2) return false;
			const grand = $from.node(-1);
			if (grand.type === nodes.list_item) return liftListItem(nodes.list_item)(state, dispatch);
			if (grand.type === nodes.todo_item) return liftListItem(nodes.todo_item)(state, dispatch);
			if (grand.type === nodes.blockquote) return lift(state, dispatch);
			return false;
		},
		"Mod-b": toggleMark(markTypes.strong),
		"Mod-i": toggleMark(markTypes.em),
		"Mod-e": toggleMark(markTypes.code),
		"Shift-Mod-x": toggleMark(markTypes.strike),
		"Mod-k": () => {
			callbacks.openLink();
			return true;
		},
	});
}

/** History (undo/redo) plus the platform base keymap as the fallback chain. */
export function richTextHistoryKeymap() {
	return keymap({ "Mod-z": undo, "Shift-Mod-z": redo, "Mod-y": redo });
}

export function richTextPlugins(callbacks: WysiwygKeyCallbacks) {
	return [
		richTextKeymap(callbacks),
		richTextHistoryKeymap(),
		keymap(baseKeymap),
		inputRules({ rules: richTextInputRules() }),
		history(),
	];
}
