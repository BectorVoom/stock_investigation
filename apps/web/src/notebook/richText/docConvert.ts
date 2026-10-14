import type { Mark, Node as PmNode } from "prosemirror-model";
import { type BlockNode, type InlineNode, isAllowedLinkTarget, type RichTextDoc } from "./model.ts";
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
				block.items.map((entry) => types.list_item.create(null, linesToParagraph([entry.inline]))),
			);
		}
		case "todo": {
			return types.todo_list.create(
				null,
				block.items.map((entry) =>
					types.todo_item.create({ checked: entry.checked }, linesToParagraph([entry.inline])),
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

/** Canonical order, outermost first: link spans its label, then strong, em, strike; code is always the leaf. */
function canonicalRank(typeName: string): number {
	switch (typeName) {
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

function markKey(mark: Mark): string | null {
	switch (mark.type.name) {
		case "strong":
		case "em":
		case "strike":
		case "code":
			return mark.type.name;
		case "link": {
			const href = mark.attrs.href;
			if (typeof href !== "string" || !isAllowedLinkTarget(href)) return null;
			return `link:${href}`;
		}
		default:
			return null;
	}
}

interface Segment {
	readonly text: string;
	/** Non-code marks, as keys, in no particular order. */
	readonly keys: readonly string[];
	readonly byKey: ReadonlyMap<string, Mark>;
	readonly hasCode: boolean;
}

function segmentOf(text: string, marks: readonly Mark[]): Segment | null {
	if (text === "") return null;
	const byKey = new Map<string, Mark>();
	let hasCode = false;
	for (const mark of marks) {
		const key = markKey(mark);
		if (key === null) continue;
		if (key === "code") {
			hasCode = true;
			continue;
		}
		if (!byKey.has(key)) byKey.set(key, mark);
	}
	return { text, keys: [...byKey.keys()], byKey, hasCode };
}

function keyRank(key: string): number {
	if (key.startsWith("link:")) return 0;
	return canonicalRank(key);
}

interface OpenFrame {
	readonly key: string;
	readonly mark: Mark;
	readonly children: InlineNode[];
}

function pushLeaf(into: InlineNode[], leaf: InlineNode): void {
	const last = into[into.length - 1];
	if (leaf.kind === "text" && last?.kind === "text") {
		into[into.length - 1] = { kind: "text", text: `${last.text}${leaf.text}` };
		return;
	}
	if (leaf.kind === "code" && last?.kind === "code") {
		into[into.length - 1] = { kind: "code", text: `${last.text}${leaf.text}` };
		return;
	}
	into.push(leaf);
}

function closeFrame(stack: OpenFrame[], topChildren: InlineNode[]): void {
	const frame = stack.pop();
	if (frame === undefined) return;
	const target = stack.length === 0 ? topChildren : stack[stack.length - 1]?.children;
	if (target === undefined) return;
	const children: readonly InlineNode[] = frame.children;
	let node: InlineNode;
	if (frame.mark.type.name === "link") {
		const href = frame.mark.attrs.href;
		node = {
			kind: "link",
			label: children,
			href: typeof href === "string" ? href : "",
		};
	} else if (frame.mark.type.name === "strong") {
		node = { kind: "strong", children };
	} else if (frame.mark.type.name === "em") {
		node = { kind: "em", children };
	} else {
		node = { kind: "strike", children };
	}
	// An empty wrapper carries no range (a bare caret or a split point):
	// drop it rather than serializing `****` for nothing.
	if (children.length === 0) return;
	pushLeaf(target, node);
}

/**
 * Rebuilds one line's inline tree from flat marked segments. Marks already
 * open stay open (so a mark spanning several segments — a link around
 * `[**label** text]` — stays one parent); newly appearing marks open
 * inside, in canonical order (the tie-break for a truly same-range
 * overlap, matching the serializer). Adjacent leaves merge, so arbitrary
 * ProseMirror text splits never surface as `**a****b**`.
 */
function buildLine(segments: readonly Segment[]): InlineNode[] {
	const top: InlineNode[] = [];
	const stack: OpenFrame[] = [];
	for (const segment of segments) {
		const present = new Set(segment.keys);
		let keep = 0;
		while (keep < stack.length && present.has(stack[keep]?.key ?? "")) keep += 1;
		while (stack.length > keep) closeFrame(stack, top);
		const fresh = segment.keys.filter((key) => {
			for (const frame of stack) if (frame.key === key) return false;
			return true;
		});
		fresh.sort((a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0));
		for (const key of fresh) {
			const mark = segment.byKey.get(key);
			if (mark === undefined) continue;
			stack.push({ key, mark, children: [] });
		}
		const target = stack.length === 0 ? top : stack[stack.length - 1]?.children;
		if (target === undefined) continue;
		pushLeaf(
			target,
			segment.hasCode ? { kind: "code", text: segment.text } : { kind: "text", text: segment.text },
		);
	}
	while (stack.length > 0) closeFrame(stack, top);
	return top;
}

/**
 * Inline content of one textblock: hard breaks split paragraph lines (they
 * are dropped inside headings, whose model form is a single run).
 */
function pmLinesToModel(node: PmNode, keepBreaks: boolean): InlineNode[][] {
	const lines: Segment[][] = [[]];
	node.forEach((child) => {
		if (child.type.name === "hard_break") {
			if (keepBreaks) lines.push([]);
			return;
		}
		if (!child.isText || child.text === undefined || child.text === "") return;
		const current = lines[lines.length - 1];
		if (current === undefined) return;
		const segment = segmentOf(child.text, child.marks);
		if (segment !== null) current.push(segment);
	});
	return lines.map(buildLine);
}

function pmBlockToModel(node: PmNode): BlockNode | null {
	switch (node.type.name) {
		case "paragraph": {
			const lines = pmLinesToModel(node, true);
			while (lines.length > 1 && (lines[lines.length - 1]?.length ?? 1) === 0) lines.pop();
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
			const items: {
				readonly inline: readonly InlineNode[];
				readonly line: number;
				readonly checked: boolean;
			}[] = [];
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
			while (lines.length > 1 && (lines[lines.length - 1]?.length ?? 1) === 0) lines.pop();
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
