/**
 * Total, linear-time parser for GitHub Flavored Markdown (GFM) pipe tables in
 * plain-text chat replies. Only pipe-table blocks (`header | header`, a
 * `| --- |` delimiter row with matching column count, and one or more pipe
 * body rows) become structured tables; everything else — including raw HTML
 * tags — stays literal text (UI-005, SEC-001).
 */

export type MarkdownTableAlignment = "left" | "center" | "right" | null;

export interface ParsedMarkdownTable {
	readonly columns: readonly string[];
	readonly alignments: readonly MarkdownTableAlignment[];
	readonly rows: readonly (readonly string[])[];
	readonly raw: string;
}

export type MarkdownTextSegment =
	| { readonly kind: "text"; readonly text: string }
	| ({ readonly kind: "table" } & ParsedMarkdownTable);

export const DEFAULT_MARKDOWN_TABLE_LIMITS = {
	maxColumns: 16,
	maxRows: 100,
} as const;

/**
 * Normalizes `rows` to a bounded `cols × rowCap` rectangle where every row has
 * exact length `Math.min(columnCount, maxColumns)`, padding short rows with
 * `pad` and truncating longer rows. Lean-verified in `ComparisonTable.lean`.
 */
export function rectangularizeTableRows<T>(
	columnCount: number,
	rows: readonly (readonly T[])[],
	pad: T,
	maxColumns: number,
	maxRows: number,
): readonly (readonly T[])[] {
	const cols = Math.min(Math.max(0, Math.trunc(columnCount)), Math.max(0, Math.trunc(maxColumns)));
	const rowCap = Math.max(0, Math.trunc(maxRows));
	if (cols === 0 || rowCap === 0) return [];
	const result: (readonly T[])[] = [];
	const limit = Math.min(rows.length, rowCap);
	for (let r = 0; r < limit; r += 1) {
		const source = rows[r] ?? [];
		const row: T[] = [];
		for (let c = 0; c < cols; c += 1) {
			const cell = source[c];
			row.push(cell === undefined ? pad : cell);
		}
		result.push(row);
	}
	return result;
}

/**
 * Splits a single line on unescaped `|` characters (`\|` unescapes to `|`),
 * stripping optional outer pipes and trimming each cell. Returns `null` when
 * the line contains no unescaped pipe or is inside a fenced code block line.
 */
export function splitMarkdownPipeCells(line: string): readonly string[] | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	const rawCells: string[] = [];
	let current = "";
	let sawPipe = false;
	for (let i = 0; i < trimmed.length; i += 1) {
		const ch = trimmed[i] ?? "";
		if (ch === "\\" && trimmed[i + 1] === "|") {
			current += "|";
			i += 1;
			continue;
		}
		if (ch === "|") {
			sawPipe = true;
			rawCells.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (!sawPipe) return null;
	rawCells.push(current);
	const startsWithPipe = trimmed.startsWith("|");
	const endsWithPipe = trimmed.endsWith("|") && !trimmed.endsWith("\\|") && rawCells.length > 1;
	const start = startsWithPipe ? 1 : 0;
	const end = endsWithPipe ? rawCells.length - 1 : rawCells.length;
	if (end <= start) return null;
	return rawCells.slice(start, end).map((cell) => cell.trim());
}

function parseDelimiterCell(cell: string): MarkdownTableAlignment | "invalid" {
	if (!/^:?-+:?$/.test(cell)) return "invalid";
	const left = cell.startsWith(":");
	const right = cell.endsWith(":");
	if (left && right) return "center";
	if (right) return "right";
	if (left) return "left";
	return null;
}

function parseDelimiterRow(
	line: string,
	expectedColumns: number,
): readonly MarkdownTableAlignment[] | null {
	if (expectedColumns < 1) return null;
	const cells = splitMarkdownPipeCells(line);
	if (cells === null || cells.length !== expectedColumns) return null;
	const alignments: MarkdownTableAlignment[] = [];
	for (const cell of cells) {
		const parsed = parseDelimiterCell(cell);
		if (parsed === "invalid") return null;
		alignments.push(parsed);
	}
	return alignments;
}

/**
 * Segments `source` into plain-text runs and GFM pipe tables in one linear
 * pass. Code fences (` ``` `) suppress pipe-table detection inside them so
 * fenced code stays literal text.
 */
export function parseMarkdownTables(
	source: string,
	options?: { readonly maxColumns?: number; readonly maxRows?: number },
): readonly MarkdownTextSegment[] {
	if (source === "") return [];
	const maxColumns = options?.maxColumns ?? DEFAULT_MARKDOWN_TABLE_LIMITS.maxColumns;
	const maxRows = options?.maxRows ?? DEFAULT_MARKDOWN_TABLE_LIMITS.maxRows;
	if (maxColumns < 1 || maxRows < 1) return [{ kind: "text", text: source }];

	const normalized = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	const segments: MarkdownTextSegment[] = [];
	let textLines: string[] = [];
	let inFence = false;

	const flushText = (): void => {
		if (textLines.length === 0) return;
		const joined = textLines.join("\n");
		textLines = [];
		if (joined !== "") {
			segments.push({ kind: "text", text: joined });
		}
	};

	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim().startsWith("```")) {
			inFence = !inFence;
			textLines.push(line);
			i += 1;
			continue;
		}
		if (!inFence && i + 2 < lines.length) {
			const headerCells = splitMarkdownPipeCells(line);
			const delimiterLine = lines[i + 1] ?? "";
			const firstBodyLine = lines[i + 2] ?? "";
			if (
				headerCells !== null &&
				headerCells.length >= 1 &&
				headerCells.some((cell) => cell !== "") &&
				!delimiterLine.trim().startsWith("```") &&
				!firstBodyLine.trim().startsWith("```")
			) {
				const alignments = parseDelimiterRow(delimiterLine, headerCells.length);
				const firstBody = alignments === null ? null : splitMarkdownPipeCells(firstBodyLine);
				if (alignments !== null && firstBody !== null) {
					const rawBodyRows: (readonly string[])[] = [firstBody];
					let end = i + 3;
					while (end < lines.length) {
						const candidate = lines[end] ?? "";
						if (candidate.trim().startsWith("```")) break;
						const parsedRow = splitMarkdownPipeCells(candidate);
						if (parsedRow === null) break;
						rawBodyRows.push(parsedRow);
						end += 1;
					}
					// Strip trailing blank lines before the table only when non-blank prose precedes it.
					while (
						textLines.length > 1 &&
						(textLines[textLines.length - 1] ?? "").trim() === "" &&
						textLines.slice(0, -1).some((prev) => prev.trim() !== "")
					) {
						textLines.pop();
					}
					if (textLines.length === 1 && (textLines[0] ?? "").trim() === "") {
						textLines = [];
					}
					flushText();

					const cols = Math.min(headerCells.length, Math.trunc(maxColumns));
					const columns = headerCells
						.slice(0, cols)
						.map((cell, idx) => (cell === "" ? `Column ${idx + 1}` : cell));
					const boundedAlignments = alignments.slice(0, cols);
					const rows = rectangularizeTableRows(cols, rawBodyRows, "", cols, maxRows);
					const raw = lines.slice(i, end).join("\n");
					segments.push({
						kind: "table",
						columns,
						alignments: boundedAlignments,
						rows,
						raw,
					});
					i = end;
					// Skip a single blank separator line immediately following the table if more content follows.
					if (i < lines.length && (lines[i] ?? "").trim() === "") {
						i += 1;
					}
					continue;
				}
			}
		}
		textLines.push(line);
		i += 1;
	}
	flushText();
	return segments;
}
