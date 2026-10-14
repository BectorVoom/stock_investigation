/**
 * Total parser from the `NOTEBOOK_TEXT_MARKDOWN` subset to the typed tree.
 * Never throws on any string input; anything outside the subset is literal
 * text. Linear time: the scanner only moves forward (`indexOf` from the
 * current offset, no nested quantifiers), and inline pairing always takes
 * the nearest closer, so nesting depth stays tiny.
 */
import { type BlockNode, type InlineNode, isAllowedLinkTarget, type RichTextDoc } from "./model.ts";

function splitLines(source: string): string[] {
	return source.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

/** A `*` that touches another `*` belongs to a `**` pair, never to italics. */
function isLoneStar(text: string, index: number): boolean {
	return text[index] === "*" && text[index - 1] !== "*" && text[index + 1] !== "*";
}

/**
 * Parses one line's inline content. The scan visits each character a
 * constant number of times: after a pair is consumed the scan resumes past
 * its closer, and an unmatched opener is emitted literally and skipped.
 */
export function parseInline(text: string): readonly InlineNode[] {
	const nodes: InlineNode[] = [];
	let current = "";
	let i = 0;
	const flush = (): void => {
		if (current !== "") {
			nodes.push({ kind: "text", text: current });
			current = "";
		}
	};
	while (i < text.length) {
		const two = text.slice(i, i + 2);
		if (two === "**" || two === "~~") {
			const closer = text.indexOf(two, i + 2);
			if (closer < 0) {
				current += two;
				i += 2;
				continue;
			}
			flush();
			const inner = parseInline(text.slice(i + 2, closer));
			nodes.push({ kind: two === "**" ? "strong" : "strike", children: inner });
			i = closer + 2;
			continue;
		}
		if (text[i] === "`") {
			const closer = text.indexOf("`", i + 1);
			if (closer < 0) {
				current += "`";
				i += 1;
				continue;
			}
			flush();
			nodes.push({ kind: "code", text: text.slice(i + 1, closer) });
			i = closer + 1;
			continue;
		}
		if (text[i] === "*" && isLoneStar(text, i)) {
			let closer = -1;
			for (let j = i + 1; j < text.length; j += 1) {
				if (text[j] === "*" && isLoneStar(text, j)) {
					closer = j;
					break;
				}
			}
			if (closer < 0) {
				current += "*";
				i += 1;
				continue;
			}
			flush();
			nodes.push({ kind: "em", children: parseInline(text.slice(i + 1, closer)) });
			i = closer + 1;
			continue;
		}
		if (text[i] === "[") {
			const sep = text.indexOf("](", i + 1);
			if (sep < 0) {
				current += "[";
				i += 1;
				continue;
			}
			const end = text.indexOf(")", sep + 2);
			if (end < 0) {
				current += "[";
				i += 1;
				continue;
			}
			const labelText = text.slice(i + 1, sep);
			const href = text.slice(sep + 2, end).trim();
			if (labelText === "" || !isAllowedLinkTarget(href)) {
				// Outside the subset: the whole span stays literal text.
				current += text.slice(i, end + 1);
				i = end + 1;
				continue;
			}
			flush();
			nodes.push({ kind: "link", label: parseInline(labelText), href });
			i = end + 1;
			continue;
		}
		current += text[i] ?? "";
		i += 1;
	}
	flush();
	return nodes;
}

interface ListLine {
	readonly kind: "bullet" | "todo" | "ordered";
	readonly checked: boolean;
	readonly inline: readonly InlineNode[];
	readonly line: number;
}

function parseListLine(line: string, lineIndex: number): ListLine | null {
	if (line.startsWith("- [ ] ")) {
		return {
			kind: "todo",
			checked: false,
			inline: parseInline(line.slice(6)),
			line: lineIndex,
		};
	}
	if (line.startsWith("- [x] ") || line.startsWith("- [X] ")) {
		return { kind: "todo", checked: true, inline: parseInline(line.slice(6)), line: lineIndex };
	}
	if (line.startsWith("- ") || line.startsWith("* ")) {
		return { kind: "bullet", checked: false, inline: parseInline(line.slice(2)), line: lineIndex };
	}
	const ordered = /^(\d{1,9})\. (.*)$/.exec(line);
	if (ordered !== null) {
		return {
			kind: "ordered",
			checked: false,
			inline: parseInline(ordered[2] ?? ""),
			line: lineIndex,
		};
	}
	return null;
}

function parseHeading(line: string): BlockNode | null {
	const match = /^(#{1,3}) (.*)$/.exec(line);
	if (match === null) return null;
	const hashes = match[1] ?? "";
	const content = (match[2] ?? "").trim();
	if (content === "") return null;
	const level = hashes.length === 1 ? 1 : hashes.length === 2 ? 2 : 3;
	return { kind: "heading", level, inline: parseInline(content) };
}

/** True when the line opens some other block (so a paragraph run stops). */
function isBlockStart(line: string): boolean {
	const trimmed = line.trim();
	if (trimmed === "" || trimmed.startsWith("```") || /^-{3,}$/.test(trimmed)) return true;
	if (trimmed.startsWith(">")) return trimmed === ">" || trimmed.startsWith("> ");
	if (parseHeading(trimmed) !== null) return true;
	if (parseListLine(trimmed, 0) !== null) return true;
	return false;
}

/** Parses the whole source; total over strings (empty source is no blocks). */
export function parseRichText(source: string): RichTextDoc {
	const lines = splitLines(source);
	const blocks: BlockNode[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const trimmed = line.trim();
		if (trimmed === "") {
			i += 1;
			continue;
		}
		if (trimmed.startsWith("```")) {
			const language = trimmed.slice(3).trim().split(/\s+/)[0] ?? "";
			const code: string[] = [];
			let j = i + 1;
			while (j < lines.length && !(lines[j] ?? "").trim().startsWith("```")) {
				code.push(lines[j] ?? "");
				j += 1;
			}
			// An unclosed fence runs to the end; the closing line is consumed.
			blocks.push({ kind: "code", language, code: code.join("\n") });
			i = j + 1;
			continue;
		}
		if (/^-{3,}$/.test(trimmed)) {
			blocks.push({ kind: "divider" });
			i += 1;
			continue;
		}
		const heading = parseHeading(trimmed);
		if (heading !== null) {
			blocks.push(heading);
			i += 1;
			continue;
		}
		if (trimmed === ">" || trimmed.startsWith("> ")) {
			const quoted: (readonly InlineNode[])[] = [];
			while (i < lines.length) {
				const next = (lines[i] ?? "").trim();
				if (next !== ">" && !next.startsWith("> ")) break;
				quoted.push(parseInline(next === ">" ? "" : next.slice(2)));
				i += 1;
			}
			blocks.push({ kind: "quote", lines: quoted });
			continue;
		}
		const listLine = parseListLine(trimmed, i);
		if (listLine !== null) {
			const kind = listLine.kind;
			if (kind === "todo") {
				const items = [{ inline: listLine.inline, line: listLine.line, checked: listLine.checked }];
				i += 1;
				while (i < lines.length) {
					const next = parseListLine((lines[i] ?? "").trim(), i);
					if (next === null || next.kind !== "todo") break;
					items.push({ inline: next.inline, line: next.line, checked: next.checked });
					i += 1;
				}
				blocks.push({ kind: "todo", items });
			} else {
				const items = [{ inline: listLine.inline, line: listLine.line }];
				i += 1;
				while (i < lines.length) {
					const next = parseListLine((lines[i] ?? "").trim(), i);
					if (next === null || next.kind !== kind) break;
					items.push({ inline: next.inline, line: next.line });
					i += 1;
				}
				blocks.push({ kind, items });
			}
			continue;
		}
		// A paragraph: consecutive plain lines; one newline is a line break.
		const paragraph: (readonly InlineNode[])[] = [];
		while (i < lines.length && !isBlockStart(lines[i] ?? "")) {
			paragraph.push(parseInline((lines[i] ?? "").trim()));
			i += 1;
		}
		if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
	}
	return { blocks };
}
