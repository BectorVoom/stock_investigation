/**
 * Canonical serializer: tree back to `NOTEBOOK_TEXT_MARKDOWN` source. The
 * editor stores whatever the owner typed, but the property tests pin the
 * round trip (serialize∘parse is a fixpoint) and the editor's list
 * continuation and to-do toggles build on the same canonical prefixes.
 */
import type { BlockNode, InlineNode, RichTextDoc } from "./model.ts";

/**
 * Canonical mark order, outermost first: a link spans its whole label, so
 * it stays outside any formatting that covers only part of that label
 * (keeping `[**label** text](url)` as one link); formatting follows
 * strong > em > strike, and inline code is always the innermost leaf.
 * ProseMirror stores marks as an unordered set (sorted by its own schema
 * rank), so a same-range overlap (`~~[a](url)~~` vs `[~~a~~](url)`) cannot
 * survive the document round trip unless both sides agree on one order.
 * This rank is that agreement: `pmToModel` rebuilds same-range stacks in
 * this order, and the serializer reorders single-child chains here, so
 * either source form canonicalizes to the same string.
 */
function canonicalRank(kind: InlineNode["kind"]): number {
	switch (kind) {
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

interface ChainMark {
	readonly kind: "link" | "strong" | "em" | "strike";
	readonly href: string;
	readonly at: number;
}

/** Collects a single-child chain (same text range) from the node downward. */
function collectChain(node: InlineNode, marks: ChainMark[]): InlineNode {
	let current = node;
	while (true) {
		if (current.kind === "strong" || current.kind === "em" || current.kind === "strike") {
			if (current.children.length !== 1) return current;
			const child = current.children[0];
			if (child === undefined) return current;
			if (
				child.kind !== "text" &&
				child.kind !== "code" &&
				child.kind !== "link" &&
				child.kind !== "strong" &&
				child.kind !== "em" &&
				child.kind !== "strike"
			)
				return current;
			marks.push({ kind: current.kind, href: "", at: marks.length });
			current = child;
			continue;
		}
		if (current.kind === "link") {
			if (current.label.length !== 1) return current;
			const child = current.label[0];
			if (child === undefined) return current;
			if (
				child.kind !== "text" &&
				child.kind !== "code" &&
				child.kind !== "link" &&
				child.kind !== "strong" &&
				child.kind !== "em" &&
				child.kind !== "strike"
			)
				return current;
			marks.push({ kind: "link", href: current.href, at: marks.length });
			current = child;
			continue;
		}
		return current;
	}
}

/** Reorders one single-child chain into the canonical nesting. */
function canonicalizeNode(node: InlineNode): InlineNode {
	switch (node.kind) {
		case "text":
		case "code":
			return node;
		case "strong":
		case "em":
		case "strike": {
			const children = node.children.map(canonicalizeNode);
			const rebuilt: InlineNode =
				node.kind === "strong"
					? { kind: "strong", children }
					: node.kind === "em"
						? { kind: "em", children }
						: { kind: "strike", children };
			if (children.length !== 1) return rebuilt;
			const marks: ChainMark[] = [];
			const inner = collectChain(rebuilt, marks);
			if (marks.length < 2) return rebuilt;
			const sorted = [...marks].sort(
				(a, b) => canonicalRank(a.kind) - canonicalRank(b.kind) || a.at - b.at,
			);
			return rebuildChain(sorted, canonicalizeNode(inner));
		}
		case "link": {
			const label = node.label.map(canonicalizeNode);
			const rebuilt: InlineNode = { kind: "link", label, href: node.href };
			if (label.length !== 1) return rebuilt;
			const marks: ChainMark[] = [];
			const inner = collectChain(rebuilt, marks);
			if (marks.length < 2) return rebuilt;
			const sorted = [...marks].sort(
				(a, b) => canonicalRank(a.kind) - canonicalRank(b.kind) || a.at - b.at,
			);
			return rebuildChain(sorted, canonicalizeNode(inner));
		}
	}
}

function rebuildChain(sorted: readonly ChainMark[], inner: InlineNode): InlineNode {
	let node = inner;
	for (let index = sorted.length - 1; index >= 0; index -= 1) {
		const mark = sorted[index];
		if (mark === undefined) continue;
		if (mark.kind === "link") node = { kind: "link", label: [node], href: mark.href };
		else if (mark.kind === "strong") node = { kind: "strong", children: [node] };
		else if (mark.kind === "em") node = { kind: "em", children: [node] };
		else node = { kind: "strike", children: [node] };
	}
	return node;
}

function canonicalizeInline(nodes: readonly InlineNode[]): readonly InlineNode[] {
	return nodes.map(canonicalizeNode);
}

export function serializeInline(nodes: readonly InlineNode[]): string {
	let out = "";
	for (const node of canonicalizeInline(nodes)) {
		switch (node.kind) {
			case "text":
				out += node.text;
				break;
			case "strong":
				out += `**${serializeInline(node.children)}**`;
				break;
			case "em":
				out += `*${serializeInline(node.children)}*`;
				break;
			case "strike":
				out += `~~${serializeInline(node.children)}~~`;
				break;
			case "code":
				out += `\`${node.text}\``;
				break;
			case "link":
				out += `[${serializeInline(node.label)}](${node.href})`;
				break;
		}
	}
	return out;
}

function serializeBlock(block: BlockNode): string {
	switch (block.kind) {
		case "heading":
			return `${"#".repeat(block.level)} ${serializeInline(block.inline)}`;
		case "paragraph":
			return block.lines.map(serializeInline).join("\n");
		case "bullet":
			return block.items.map((item) => `- ${serializeInline(item.inline)}`).join("\n");
		case "ordered":
			return block.items
				.map((item, index) => `${index + 1}. ${serializeInline(item.inline)}`)
				.join("\n");
		case "todo":
			return block.items
				.map((item) => `- [${item.checked ? "x" : " "}] ${serializeInline(item.inline)}`)
				.join("\n");
		case "quote":
			return block.lines.map((line) => `> ${serializeInline(line)}`).join("\n");
		case "code":
			return `\`\`\`${block.language}\n${block.code}\n\`\`\``;
		case "divider":
			return "---";
	}
}

export function serializeRichText(doc: RichTextDoc): string {
	return doc.blocks.map(serializeBlock).join("\n\n");
}

/**
 * Rewrites one to-do line (`- [ ] ` ↔ `- [x] `) by its source line index,
 * so a checkbox toggles and saves without opening the editor. Returns the
 * source unchanged when the line is not a to-do item.
 */
export function toggleTodoLine(source: string, lineIndex: number): string {
	const lines = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
	const line = lines[lineIndex];
	if (line === undefined) return source;
	const trimmed = line.trim();
	if (trimmed.startsWith("- [ ] ")) {
		lines[lineIndex] = line.replace("- [ ] ", "- [x] ");
	} else if (trimmed.startsWith("- [x] ") || trimmed.startsWith("- [X] ")) {
		const marker = trimmed.startsWith("- [x] ") ? "- [x] " : "- [X] ";
		lines[lineIndex] = line.replace(marker, "- [ ] ");
	} else {
		return source;
	}
	return lines.join("\n");
}
