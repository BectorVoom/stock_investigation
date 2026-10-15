/**
 * Typed tree for the `WIDGET_TEXT_MARKDOWN` subset (ADR-0021): the
 * renderer and the serializer both read this, so the stored Markdown and
 * what the owner sees cannot drift apart. Anything outside the subset never
 * becomes a node: it stays literal text inside a `text` node.
 */

/** Inline content: formatting, code and links inside one line. */
export type InlineNode =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "strong"; readonly children: readonly InlineNode[] }
	| { readonly kind: "em"; readonly children: readonly InlineNode[] }
	| { readonly kind: "strike"; readonly children: readonly InlineNode[] }
	| { readonly kind: "code"; readonly text: string }
	| { readonly kind: "link"; readonly label: readonly InlineNode[]; readonly href: string };

/** One list item keeps its source line so a to-do toggle can rewrite it. */
export interface ListItem {
	readonly inline: readonly InlineNode[];
	readonly line: number;
}

export interface TodoItem extends ListItem {
	readonly checked: boolean;
}

export type BlockNode =
	| { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly inline: readonly InlineNode[] }
	| { readonly kind: "paragraph"; readonly lines: readonly (readonly InlineNode[])[] }
	| { readonly kind: "bullet"; readonly items: readonly ListItem[] }
	| { readonly kind: "ordered"; readonly items: readonly ListItem[] }
	| { readonly kind: "todo"; readonly items: readonly TodoItem[] }
	| { readonly kind: "quote"; readonly lines: readonly (readonly InlineNode[])[] }
	| { readonly kind: "code"; readonly language: string; readonly code: string }
	| { readonly kind: "divider" };

export interface RichTextDoc {
	readonly blocks: readonly BlockNode[];
}

/** Every link target the renderer turns into an anchor (anything else is text). */
export function isAllowedLinkTarget(target: string): boolean {
	const trimmed = target.trim();
	if (trimmed === "" || /[\s<>]/.test(trimmed)) return false;
	const lower = trimmed.toLowerCase();
	for (const scheme of ["https:", "http:", "mailto:"]) {
		if (lower.startsWith(scheme) && trimmed.length > scheme.length) return true;
	}
	return false;
}

/** Plain text of one inline run (accessible names, counters, previews). */
export function plainText(nodes: readonly InlineNode[]): string {
	let out = "";
	for (const node of nodes) {
		switch (node.kind) {
			case "text":
			case "code":
				out += node.text;
				break;
			case "strong":
			case "em":
			case "strike":
				out += plainText(node.children);
				break;
			case "link":
				out += plainText(node.label);
				break;
		}
	}
	return out;
}

/** All human-readable text of a document, in order (for no-loss checks). */
export function docTextChunks(doc: RichTextDoc): readonly string[] {
	const chunks: string[] = [];
	const inline = (nodes: readonly InlineNode[]): void => {
		for (const node of nodes) {
			switch (node.kind) {
				case "text":
				case "code":
					chunks.push(node.text);
					break;
				case "strong":
				case "em":
				case "strike":
					inline(node.children);
					break;
				case "link":
					inline(node.label);
					break;
			}
		}
	};
	for (const block of doc.blocks) {
		switch (block.kind) {
			case "heading":
				inline(block.inline);
				break;
			case "paragraph":
			case "quote":
				for (const line of block.lines) inline(line);
				break;
			case "bullet":
			case "ordered":
			case "todo":
				for (const item of block.items) inline(item.inline);
				break;
			case "code":
				chunks.push(block.code);
				break;
			case "divider":
				break;
		}
	}
	return chunks;
}
