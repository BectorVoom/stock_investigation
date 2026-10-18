/**
 * Parser for the JPX earnings-announcement workbooks (FR-018, §6.2).
 *
 * The layout below was observed on the real file on 2026-10-13; the tests
 * build a SYNTHETIC workbook with this exact layout in-test (never the real
 * file). Sheet rows 1–4 are titles, row 5 is the header, data starts at row 6:
 *
 *   A: Scheduled Dates for Earnings Announcements — Excel serial, or `未定_Undecided`
 *   B: Code — numeric (7203) or string (130A)
 *   D: Issue Name — shared string, may have trailing spaces
 *   E: Fiscal Year-end — Excel serial
 *   I: Fiscal Year/Quarter — shared string (Second quarter, ...)
 *   (C: 会社名, H: 種別, K: Market Segment are not needed here.)
 *
 * Cells look like `<c r="B700" s="6"><v>7203</v></c>` (numeric) or
 * `<c r="D700" s="7" t="s"><v>123</v></c>` (shared-string index); trailing
 * rows can be empty (`<c r="A2910" s="11"/>`).
 *
 * Columns are located by header row text (the English halves), not by fixed
 * letters; the observed file separates the two languages with a newline
 * (`決算発表予定日\r\nScheduled Dates for Earnings Announcements`), and a
 * `日本語 / English` slash form is accepted too. A missing required header
 * fails the whole workbook (`MISSING_HEADERS`). The workbook is untrusted input
 * (SEC-001): entity decoding follows the one-pass approach of
 * `feed/xmlTree.ts` (predefined entities + numeric references only, so no DTD
 * can expand anything), element scanning is `indexOf`-based and linear (a
 * lazy `<tag>…</tag>` regex is quadratic on openers without a closer — an
 * opener without its closer fails the workbook as `MALFORMED_WORKBOOK`), and
 * row / shared-string / cell counts are bounded — past the bound the workbook
 * is rejected, never partially trusted. A header with zero parseable data
 * rows behind it is `MALFORMED_WORKBOOK` too (fail closed, never "no date
 * for any stock").
 */
import { earningsEventSchema } from "@research/contracts";
import { err, excelSerialToIsoDate, isValidIsoDate, ok, type Result } from "@research/domain";

export interface JpxWorkbookRow {
	readonly code: string;
	readonly name: string | null;
	/** Null when the source lists the announcement with the date undecided. */
	readonly announcementDate: string | null;
	readonly fiscalPeriodEnd: string;
	readonly fiscalPeriodLabel: string;
	readonly periodKey: string;
}

export type JpxWorkbookError = "MISSING_HEADERS" | "MALFORMED_WORKBOOK" | "LIMIT_EXCEEDED";

/** The real file holds ~2,900 data rows; this is headroom, not a target. */
export const MAX_JPX_DATA_ROWS = 20_000;
export const MAX_JPX_SHARED_STRINGS = 100_000;
export const MAX_JPX_CELLS = 1_000_000;

const UNDECIDED_TEXT = "未定_Undecided";
const JP_CODE_PATTERN = /^[0-9][0-9A-Z]{3}$/;
const PERIOD_KEY_PATTERN = /^[a-z0-9-]{1,48}$/;

const HEADER_DATE = "Scheduled Dates for Earnings Announcements";
const HEADER_CODE = "Code";
const HEADER_NAME = "Issue Name";
const HEADER_END = "Fiscal Year-end";
const HEADER_LABEL = "Fiscal Year/Quarter";

const PREDEFINED_ENTITIES: { readonly [name: string]: string } = {
	lt: "<",
	gt: ">",
	amp: "&",
	quot: '"',
	apos: "'",
};

/**
 * Decodes the five predefined XML entities and numeric character references
 * in one non-recursive pass (same approach as `feed/xmlTree.ts`:
 * `decodeXmlText`). Anything else (custom entities, DTD tricks) stays inert
 * literal text.
 */
export function decodeWorkbookText(text: string): string {
	return text.replace(
		/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|lt|gt|amp|quot|apos);/g,
		(match, body: string) => {
			if (!body.startsWith("#")) return PREDEFINED_ENTITIES[body] ?? match;
			const isHex = body[1] === "x";
			const codePoint = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
			if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) return "";
			if (codePoint >= 0xd800 && codePoint <= 0xdfff) return "";
			return String.fromCodePoint(codePoint);
		},
	);
}

/** `Second quarter` -> `second-quarter` for the `periodKey` suffix. */
export function slugFiscalKind(label: string): string {
	return label
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * The item's XML without its phonetic `<rPh>` runs: Excel shows the cell
 * text only, while the readings (kana) would be glued onto the name or break
 * a header match.
 */
function withoutPhoneticRuns(item: string): Result<string, JpxWorkbookError> {
	if (!item.includes("<rPh")) return ok(item);
	const phonetic = scanElements(item, "rPh", MAX_JPX_CELLS);
	if (!phonetic.ok) return phonetic;
	let kept = "";
	let position = 0;
	for (const run of phonetic.value) {
		kept += item.slice(position, run.start);
		position = run.end;
	}
	return ok(kept + item.slice(position));
}

function parseSharedStrings(xml: string): Result<string[], JpxWorkbookError> {
	const scanned = scanElements(xml, "si", MAX_JPX_SHARED_STRINGS);
	if (!scanned.ok) return scanned;
	const items: string[] = [];
	for (const item of scanned.value) {
		const visible = withoutPhoneticRuns(item.inner);
		if (!visible.ok) return visible;
		const runs = scanElements(visible.value, "t", MAX_JPX_CELLS);
		if (!runs.ok) return runs;
		let combined = "";
		for (const run of runs.value) combined += decodeWorkbookText(run.inner);
		items.push(combined);
	}
	return ok(items);
}

interface RawCell {
	readonly column: string;
	readonly kind: "empty" | "shared" | "literal" | "inline";
	readonly value: string;
}

interface ScannedElement {
	/** Offset of the opening `<` and of the first character after the element. */
	readonly start: number;
	readonly end: number;
	readonly attrs: string;
	readonly inner: string;
	readonly selfClosed: boolean;
}

/**
 * Bounded linear scan for `<tag …>…</tag>` and `<tag …/>` elements (SEC-001):
 * every step advances past what it consumed, so the scan is linear in the
 * input length. A lazy `<tag>[\s\S]*?</tag>` regex is quadratic on openers
 * without a closer (each attempt re-scans to the end of the up-to-16 MB
 * entry); here an opener without its closer fails the workbook as
 * `MALFORMED_WORKBOOK` at once. `limit` bounds the element count — past it
 * the workbook is rejected, never partially trusted.
 */
function scanElements(
	xml: string,
	tag: string,
	limit: number,
): Result<ScannedElement[], JpxWorkbookError> {
	const open = `<${tag}`;
	const close = `</${tag}>`;
	const out: ScannedElement[] = [];
	let position = 0;
	for (;;) {
		const start = xml.indexOf(open, position);
		if (start === -1) return ok(out);
		const afterName = xml[start + open.length] ?? "";
		if (
			afterName !== " " &&
			afterName !== "\t" &&
			afterName !== "\n" &&
			afterName !== "\r" &&
			afterName !== "/" &&
			afterName !== ">"
		) {
			// `<rows>`, `<rowspan>` … — not this element; skip past the name.
			position = start + open.length;
			continue;
		}
		const attrsEnd = xml.indexOf(">", start + open.length);
		if (attrsEnd === -1) return err("MALFORMED_WORKBOOK");
		const attrs = xml.slice(start + open.length, attrsEnd);
		if (attrs.endsWith("/")) {
			position = attrsEnd + 1;
			out.push({
				start,
				end: position,
				attrs: attrs.slice(0, -1),
				inner: "",
				selfClosed: true,
			});
		} else {
			const end = xml.indexOf(close, attrsEnd + 1);
			if (end === -1) return err("MALFORMED_WORKBOOK");
			position = end + close.length;
			out.push({
				start,
				end: position,
				attrs,
				inner: xml.slice(attrsEnd + 1, end),
				selfClosed: false,
			});
		}
		if (out.length > limit) return err("LIMIT_EXCEEDED");
	}
}

/** Text of the first `<tag …>…</tag>` run in a small cell body, or "". */
function extractSingleTagText(body: string, tag: string): string {
	const start = body.indexOf(`<${tag}`);
	if (start === -1) return "";
	const textStart = body.indexOf(">", start);
	if (textStart === -1) return "";
	const end = body.indexOf(`</${tag}>`, textStart + 1);
	if (end === -1) return "";
	return body.slice(textStart + 1, end);
}

function columnLetters(index: number): string {
	let letters = "";
	let remainder = index;
	do {
		letters = String.fromCharCode(65 + (remainder % 26)) + letters;
		remainder = Math.floor(remainder / 26) - 1;
	} while (remainder >= 0);
	return letters;
}

function parseRowCells(inner: string, startCells: number): Result<RawCell[], JpxWorkbookError> {
	if (startCells >= MAX_JPX_CELLS) return err("LIMIT_EXCEEDED");
	const scanned = scanElements(inner, "c", MAX_JPX_CELLS - startCells);
	if (!scanned.ok) return scanned;
	const cells: RawCell[] = [];
	let position = 0;
	for (const match of scanned.value) {
		const attrs = match.attrs;
		const body = match.selfClosed ? "" : match.inner;
		const ref = /r="([A-Z]+)[0-9]+"/.exec(attrs)?.[1] ?? columnLetters(position);
		position += 1;
		const kindAttr = /t="([a-zA-Z]+)"/.exec(attrs)?.[1] ?? "";
		if (body === "") {
			cells.push({ column: ref, kind: "empty", value: "" });
			continue;
		}
		if (kindAttr === "inlineStr") {
			cells.push({
				column: ref,
				kind: "inline",
				value: decodeWorkbookText(extractSingleTagText(body, "t")),
			});
			continue;
		}
		const value = extractSingleTagText(body, "v");
		if (kindAttr === "s") {
			cells.push({ column: ref, kind: "shared", value: value.trim() });
		} else {
			cells.push({ column: ref, kind: "literal", value: decodeWorkbookText(value) });
		}
	}
	return ok(cells);
}

/**
 * Whether a header cell names the wanted English column. The observed file
 * separates the languages with a newline (`決算発表予定日\r\nScheduled Dates
 * for Earnings Announcements`); a `日本語 / English` slash form is accepted
 * too. Either way the match is on whole lines/segments, so `Quarter` never
 * matches `Fiscal Year/Quarter` and `Code` never matches `Market Segment`.
 */
export function headerMatches(text: string, english: string): boolean {
	const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim());
	if (lines.includes(english)) return true;
	return lines.some((line) => line.endsWith(`/ ${english}`));
}

interface HeaderColumns {
	readonly date: string;
	readonly code: string;
	readonly name: string;
	readonly end: string;
	readonly label: string;
}

function cellText(cell: RawCell, shared: readonly string[]): string {
	if (cell.kind === "shared") {
		const index = Number(cell.value);
		if (!Number.isInteger(index) || index < 0 || index >= shared.length) return "";
		return shared[index] ?? "";
	}
	return cell.value;
}

function locateHeaders(cells: readonly RawCell[], shared: readonly string[]): HeaderColumns | null {
	const found: { [key: string]: string } = {};
	for (const cell of cells) {
		const text = cellText(cell, shared);
		if (headerMatches(text, HEADER_DATE)) found.date = cell.column;
		else if (headerMatches(text, HEADER_CODE)) found.code = cell.column;
		else if (headerMatches(text, HEADER_NAME)) found.name = cell.column;
		else if (headerMatches(text, HEADER_END)) found.end = cell.column;
		else if (headerMatches(text, HEADER_LABEL)) found.label = cell.column;
	}
	if (
		found.date === undefined ||
		found.code === undefined ||
		found.name === undefined ||
		found.end === undefined ||
		found.label === undefined
	) {
		return null;
	}
	return {
		date: found.date,
		code: found.code,
		name: found.name,
		end: found.end,
		label: found.label,
	};
}

function byColumn(cells: readonly RawCell[], column: string): RawCell | null {
	return cells.find((cell) => cell.column === column) ?? null;
}

function parseDataRow(
	cells: readonly RawCell[],
	shared: readonly string[],
	headers: HeaderColumns,
): JpxWorkbookRow | null {
	const codeCell = byColumn(cells, headers.code);
	if (codeCell === null) return null;
	const codeRaw = cellText(codeCell, shared).trim();
	let code: string;
	if (codeCell.kind === "shared" || codeCell.kind === "inline" || codeCell.kind === "literal") {
		code = codeRaw.toUpperCase();
	} else {
		const numeric = Number(codeRaw);
		if (codeRaw === "" || !Number.isInteger(numeric)) return null;
		code = String(numeric);
	}
	if (!JP_CODE_PATTERN.test(code)) return null;

	const dateCell = byColumn(cells, headers.date);
	if (dateCell === null) return null;
	const dateRaw = cellText(dateCell, shared).trim();
	let announcementDate: string | null;
	if (dateRaw === UNDECIDED_TEXT) {
		announcementDate = null;
	} else {
		const serial = Number(dateRaw);
		if (dateRaw === "" || !Number.isFinite(serial)) return null;
		const converted = excelSerialToIsoDate(serial);
		if (!converted.ok) return null;
		announcementDate = converted.value;
	}

	const endCell = byColumn(cells, headers.end);
	if (endCell === null) return null;
	const endRaw = cellText(endCell, shared).trim();
	const endSerial = Number(endRaw);
	if (endRaw === "" || !Number.isFinite(endSerial)) return null;
	const endConverted = excelSerialToIsoDate(endSerial);
	if (!endConverted.ok) return null;

	const labelCell = byColumn(cells, headers.label);
	if (labelCell === null) return null;
	const fiscalPeriodLabel = cellText(labelCell, shared).trim();
	if (fiscalPeriodLabel === "" || fiscalPeriodLabel.length > 80) return null;
	const periodKey = `fy${endConverted.value}-${slugFiscalKind(fiscalPeriodLabel)}`;
	if (!PERIOD_KEY_PATTERN.test(periodKey)) return null;

	const nameCell = byColumn(cells, headers.name);
	const nameRaw = nameCell === null ? "" : cellText(nameCell, shared).trim();
	const candidate = {
		periodKey,
		announcementDate,
		fiscalPeriodLabel,
		fiscalPeriodEnd: endConverted.value,
		timing: "unknown" as const,
	};
	// The contract schema is the last word: a row that cannot be stored is
	// skipped, never half-kept.
	if (!earningsEventSchema.safeParse(candidate).success) return null;
	if (announcementDate !== null && !isValidIsoDate(announcementDate)) return null;
	return {
		code,
		name: nameRaw === "" ? null : nameRaw,
		announcementDate,
		fiscalPeriodEnd: endConverted.value,
		fiscalPeriodLabel,
		periodKey,
	};
}

/**
 * Parses one workbook's sheet + shared strings into data rows. Rows that fail
 * per-row validation are skipped; structural failures (no headers, malformed
 * XML shape, bound overruns) fail the whole workbook.
 */
export function parseJpxWorkbook(
	sheetXml: string,
	sharedStringsXml: string,
): Result<JpxWorkbookRow[], JpxWorkbookError> {
	const shared = parseSharedStrings(sharedStringsXml);
	if (!shared.ok) return err(shared.error);
	const strings = shared.value;
	const rows: JpxWorkbookRow[] = [];
	const scanned = scanElements(sheetXml, "row", MAX_JPX_DATA_ROWS + 1_000);
	if (!scanned.ok) return scanned;
	let header: HeaderColumns | null = null;
	let seenCells = 0;
	let dataRows = 0;
	for (const match of scanned.value) {
		const inner = match.selfClosed ? "" : match.inner;
		if (inner === "") continue;
		const parsed = parseRowCells(inner, seenCells);
		if (!parsed.ok) return err(parsed.error);
		seenCells += parsed.value.length;
		if (header === null) {
			const located = locateHeaders(parsed.value, strings);
			if (located !== null) header = located;
			continue;
		}
		if (parsed.value.length > 0) dataRows += 1;
		if (rows.length >= MAX_JPX_DATA_ROWS) return err("LIMIT_EXCEEDED");
		const row = parseDataRow(parsed.value, strings, header);
		if (row !== null) rows.push(row);
	}
	if (header === null) return err("MISSING_HEADERS");
	// The header parsed but not one data row did: a schedule workbook always
	// lists announcements, so this is a shape change or corruption — fail
	// closed as MALFORMED_WORKBOOK rather than reading it as "no date for
	// any stock".
	if (dataRows > 0 && rows.length === 0) return err("MALFORMED_WORKBOOK");
	return ok(rows);
}
