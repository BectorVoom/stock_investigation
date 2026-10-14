/**
 * Canonical serializer: tree back to `NOTEBOOK_TEXT_MARKDOWN` source. The
 * editor stores whatever the owner typed, but the property tests pin the
 * round trip (serialize∘parse is a fixpoint) and the editor's list
 * continuation and to-do toggles build on the same canonical prefixes.
 */
import type { BlockNode, InlineNode, RichTextDoc } from "./model.ts";

export function serializeInline(nodes: readonly InlineNode[]): string {
	let out = "";
	for (const node of nodes) {
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
