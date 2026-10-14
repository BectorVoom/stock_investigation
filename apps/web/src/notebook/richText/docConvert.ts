import type { Mark, Node as PmNode } from "prosemirror-model";
import {
	type BlockNode,
	type InlineNode,
	isAllowedLinkTarget,
	type RichTextDoc,
} from "./model.ts";
import { richTextSchema } from "./schema.ts";

/**
 * Conversion between the typed tree (`model.ts`) and ProseMirror documents.
 * Every editor change flows through here: Markdown → `parser.ts` model →
 * ProseMirror doc on open, and doc → model → `serializer.ts` on every edit,
 * so the stored text is always the canonical `NOTEBOOK_TEXT_MARKDOWN` form.
 * Total: unknown nodes, marks and attributes degrade to plain text or are
 * skipped, never thrown on.
 */

const types = richTextSchema.nodes;
const markTypes = richTextSchema.marks;

function pushText(out: PmNode[], text: string, marks: readonly Mark[]): void {
	for (const [index, part] of text.split("\n").entries()) {
		if (index > 0) out.push(types.hard_break.create());
		if (part !== "") out.push(richTextSchema.text(part, marks));
	}
}

function pushInline(out: PmNode[], node: InlineNode, outer: readonly Mark[]): void {
	if (node.kind === "text") {
		pushText(out, node.text, outer);
		return;
	}
	if (node.kind === "code") {
		pushText(out, node.text, [...outer, markTypes.code.create()]);
		return;
	}
	if (node.kind === "link") {
		if (!isAllowedLinkTarget(node.href)) {
			for (const child of node.label) pushInline(out, child, outer);
			return;
		}
		const withLink: readonly Mark[] = [...outer, markTypes.link.create({ href: node.href })];
		for (const child of node.label) pushInline(out, child, withLink);
		return;
	}
	const inner = markTypes[node.kind].create();
	const withMark: readonly Mark[] = [...outer, inner];
	for (const child of node.children) pushInline(out, child, withMark);
}

function inlineToPm(nodes: readonly InlineNode[]): PmNode[] {
	const out: PmNode[] = [];
	for (const node of nodes) pushInline(out, node, []);
	return out;
}

/** Paragraph lines joined with hard breaks (matches the read view's `<br>`). */
function linesToParagraph(lines: readonly (readonly InlineNode[])[]): PmNode {
	const out: PmNode[] = [];
	for (const [index, line] of lines.entries()) {
		if (index > 0) out.push(types.hard_break.create());
		out.push(...inlineToPm(line));
	}
	return types.paragraph.create(null, out);
}

function blockToPm(block: BlockNode): PmNode {
	switch (block.kind) {
		case "heading":
			return types.heading.create({ level: block.level }, inlineToPm(block.inline));
		case "paragraph":
			return linesToParagraph(block.lines.length === 0 ? [[]] : block.lines);
		case "bullet":
		case "ordered": {
			const list = block.kind === "bullet" ? types.bullet_list : types.ordered_list;
			return list.create(
				null,
				block.items.map((entry) =>
					types.list_item.create(null, linesToParagraph([entry.inline])),
				),
			);
		}
		case "todo": {
			return types.todo_list.create(
				null,
				block.items.map((entry) =>
					types.todo_item.create(
						{ checked: entry.checked },
						linesToParagraph([entry.inline]),
					),
				),
			);
		}
		case "quote":
			return types.blockquote.create(
				null,
				linesToParagraph(block.lines.length === 0 ? [[]] : block.lines),
			);
		case "code":
			return types.code_block.create(
				{ language: block.language },
				block.code === "" ? null : richTextSchema.text(block.code),
			);
		case "divider":
			return types.horizontal_rule.create();
	}
}

/** The typed document as a ProseMirror doc (empty source is one empty paragraph). */
export function modelToPm(doc: RichTextDoc): PmNode {
	const blocks: PmNode[] = [];
	for (const block of doc.blocks) blocks.push(blockToPm(block));
	if (blocks.length === 0) blocks.push(types.paragraph.create());
	return richTextSchema.topNodeType.create(null, blocks);
}

/** Outermost first: link, strong, em, strike, code innermost. */
function markRank(mark: Mark): number {
	switch (mark.type.name) {
		case "link":
			return 0;
		case "strong":
			return 1;
		case "em":
			return 2;
		case "strike":
			return 3;
		default:
			return 4;
	}
}

function wrapText(text: string, marks: readonly Mark[]): InlineNode {
	const sorted = [...marks].sort((a, b) => markRank(a) - markRank(b));
	let node: InlineNode = { kind: "text", text };
	for (let index = sorted.length - 1; index >= 0; index -= 1) {
		const mark = sorted[index];
		if (mark === undefined) continue;
		if (mark.type.name === "link") {
			const href = mark.attrs.href;
			if (typeof href !== "string" || !isAllowedLinkTarget(href)) continue;
			node = { kind: "link", label: [node], href };
		} else if (mark.type.name === "strong") {
			node = { kind: "strong", children: [node] };
		} else if (mark.type.name === "em") {
			node = { kind: "em", children: [node] };
		} else if (mark.type.name === "strike") {
			node = { kind: "strike", children: [node] };
		} else if (mark.type.name === "code") {
			// Code is a leaf in the model; a mark stack above it (bold `x`)
			// wraps outside, exactly as the parser nests it.
			if (node.kind === "text") node = { kind: "code", text: node.text };
			else node = { kind: "strong", children: [node] };
		}
	}
	return node;
}

/**
 * Inline content of one textblock: hard breaks split paragraph lines (they
 * are dropped inside headings, whose model form is a single run).
 */
function pmLinesToModel(node: PmNode, keepBreaks: boolean): readonly (readonly InlineNode[])[] {
	const lines: InlineNode[][] = [[]];
	node.forEach((child) => {
		if (child.type.name === "hard_break") {
			if (keepBreaks) lines.push([]);
			return;
		}
		if (!child.isText || child.text === undefined || child.text === "") return;
		const current = lines[lines.length - 1];
		if (current === undefined) return;
		current.push(wrapText(child.text, child.marks));
	});
	return lines;
}

function pmBlockToModel(node: PmNode): BlockNode | null {
	switch (node.type.name) {
		case "paragraph": {
			const lines = pmLinesToModel(node, true);
			while (lines.length > 1 && (lines[lines.length - 1]?.length ?? 1) === 0)
				lines.pop();
			if (lines.every((line) => line.length === 0)) return null;
			return { kind: "paragraph", lines };
		}
		case "heading": {
			if (node.textContent === "") return null;
			const inline = pmLinesToModel(node, false)[0] ?? [];
			const level = node.attrs.level === 2 ? 2 : node.attrs.level === 3 ? 3 : 1;
			return { kind: "heading", level, inline };
		}
		case "bullet_list":
		case "ordered_list": {
			const items: { readonly inline: readonly InlineNode[]; readonly line: number }[] = [];
			node.forEach((item) => {
				if (item.type.name !== "list_item") return;
				const first = item.firstChild;
				items.push({
					inline: first === null ? [] : (pmLinesToModel(first, false)[0] ?? []),
					// Editing items carry no source line; to-do toggles in the
					// read view resolve lines from the saved source instead.
					line: -1,
				});
			});
			if (items.length === 0) return null;
			return node.type.name === "bullet_list"
				? { kind: "bullet", items }
				: { kind: "ordered", items };
		}
		case "todo_list": {
			const items: { readonly inline: readonly InlineNode[]; readonly line: number; readonly checked: boolean }[] = [];
			node.forEach((item) => {
				if (item.type.name !== "todo_item") return;
				const first = item.firstChild;
				items.push({
					inline: first === null ? [] : (pmLinesToModel(first, false)[0] ?? []),
					line: -1,
					checked: item.attrs.checked === true,
				});
			});
			if (items.length === 0) return null;
			return { kind: "todo", items };
		}
		case "blockquote": {
			const lines: InlineNode[][] = [];
			node.forEach((child) => {
				if (child.type.name !== "paragraph") return;
				for (const line of pmLinesToModel(child, true)) lines.push([...line]);
			});
			while (lines.length > 1 && (lines[lines.length - 1]?.length ?? 1) === 0)
				lines.pop();
			if (lines.every((line) => line.length === 0)) return null;
			return { kind: "quote", lines };
		}
		case "code_block": {
			const language = node.attrs.language;
			return {
				kind: "code",
				language: typeof language === "string" ? language : "",
				code: node.textContent,
			};
		}
		case "horizontal_rule":
			return { kind: "divider" };
		default:
			return null;
	}
}

/** A ProseMirror doc back to the typed tree (editing empties fall away). */
export function pmToModel(doc: PmNode): RichTextDoc {
	const blocks: BlockNode[] = [];
	doc.forEach((child) => {
		const block = pmBlockToModel(child);
		if (block !== null) blocks.push(block);
	});
	return { blocks };
}
