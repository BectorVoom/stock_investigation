import { inflateSync } from "node:zlib";

/**
 * Minimal text reader for JPX's one-page statistics PDFs (ADR-0076: the
 * daily short-selling summary). It understands exactly what those files
 * need: zlib-compressed (`/FlateDecode`) content streams whose numbers are
 * drawn as literal strings. It is not a PDF parser — no object table, no
 * fonts, no CID text — and it fails closed: an untrusted file (SEC-001)
 * is capped in total inflated bytes, binary streams (font programs) are
 * dropped, and the caller checks every token it reads.
 *
 * The Rust runner's `crates/research-finance/src/jpx_stats.rs` implements
 * the same rules; both are specified in docs/external-apis/apis/jpx.md.
 */

/** Total inflated bytes of one file's streams; past it the file is refused. */
export const MAX_PDF_INFLATED_BYTES = 4_194_304;

const STREAM = Buffer.from("stream", "latin1");
const END_STREAM = Buffer.from("endstream", "latin1");
const END = Buffer.from("end", "latin1");

const LF = 0x0a;
const CR = 0x0d;
const OPEN = 0x28;
const CLOSE = 0x29;
const BACKSLASH = 0x5c;
const LESS = 0x3c;
const GREATER = 0x3e;

/** PDF white-space bytes (ISO 32000-1 §7.2.2). */
function isWhite(byte: number): boolean {
	return (
		byte === 0x00 || byte === 0x09 || byte === LF || byte === 0x0c || byte === CR || byte === 0x20
	);
}

/** PDF delimiter bytes (ISO 32000-1 §7.2.2). */
function isDelimiter(byte: number): boolean {
	return (
		byte === OPEN ||
		byte === CLOSE ||
		byte === LESS ||
		byte === GREATER ||
		byte === 0x5b ||
		byte === 0x5d ||
		byte === 0x7b ||
		byte === 0x7d ||
		byte === 0x2f ||
		byte === 0x25
	);
}

/** Tab, LF, CR or printable ASCII: a content stream, not a font program. */
function isTextStream(bytes: Uint8Array): boolean {
	for (const byte of bytes) {
		if (byte === 0x09 || byte === LF || byte === CR) continue;
		if (byte < 0x20 || byte > 0x7e) return false;
	}
	return true;
}

function startsAt(bytes: Uint8Array, at: number, needle: Uint8Array): boolean {
	if (at < 0 || at + needle.length > bytes.length) return false;
	for (let i = 0; i < needle.length; i += 1) {
		if (bytes[at + i] !== needle[i]) return false;
	}
	return true;
}

/**
 * The inflated streams of a PDF, in file order: every `stream` keyword (not
 * `endstream`) followed by an end of line starts one, which runs to the next
 * `endstream`. A stream that does not inflate as one complete zlib stream is
 * skipped; null when the streams together inflate past
 * `MAX_PDF_INFLATED_BYTES`.
 */
export function pdfStreams(pdf: Uint8Array): Uint8Array[] | null {
	const bytes = Buffer.from(pdf.buffer, pdf.byteOffset, pdf.byteLength);
	const streams: Uint8Array[] = [];
	let total = 0;
	let from = 0;
	for (;;) {
		const at = bytes.indexOf(STREAM, from);
		if (at < 0) break;
		from = at + STREAM.length;
		if (startsAt(bytes, at - END.length, END)) continue;
		let start: number;
		if (bytes[from] === CR && bytes[from + 1] === LF) start = from + 2;
		else if (bytes[from] === LF) start = from + 1;
		else continue;
		const end = bytes.indexOf(END_STREAM, start);
		if (end < 0) break;
		from = end;
		let inflated: Buffer;
		try {
			inflated = inflateSync(bytes.subarray(start, end), {
				maxOutputLength: MAX_PDF_INFLATED_BYTES - total + 1,
			});
		} catch (error) {
			if (error instanceof RangeError) return null;
			continue;
		}
		total += inflated.length;
		if (total > MAX_PDF_INFLATED_BYTES) return null;
		streams.push(inflated);
	}
	return streams;
}

/** The escape of `\X` inside a literal string, for a non-octal, non-EOL `X`. */
function escaped(byte: number): number {
	switch (byte) {
		case 0x6e:
			return LF;
		case 0x72:
			return CR;
		case 0x74:
			return 0x09;
		case 0x62:
			return 0x08;
		case 0x66:
			return 0x0c;
		default:
			return byte;
	}
}

function isOctal(byte: number | undefined): byte is number {
	return byte !== undefined && byte >= 0x30 && byte <= 0x37;
}

/**
 * The text of one content stream: each text object (`BT` … `ET`) yields one
 * token, its literal strings concatenated as Latin-1 characters (a number
 * that one `TJ` array splits into kerned pieces reads whole). Literal
 * strings outside a text object and hex strings are skipped; empty objects
 * yield nothing.
 */
export function pdfTextTokens(stream: Uint8Array): string[] {
	const tokens: string[] = [];
	const n = stream.length;
	let inText = false;
	let current = "";
	let i = 0;
	while (i < n) {
		const byte = stream[i] ?? 0;
		if (byte === OPEN) {
			let depth = 1;
			let text = "";
			i += 1;
			while (i < n) {
				const c = stream[i] ?? 0;
				if (c === BACKSLASH) {
					i += 1;
					if (i >= n) break;
					const e = stream[i] ?? 0;
					if (isOctal(e)) {
						let value = 0;
						let digits = 0;
						let d = stream[i];
						while (digits < 3 && isOctal(d)) {
							value = value * 8 + (d - 0x30);
							i += 1;
							digits += 1;
							d = stream[i];
						}
						text += String.fromCharCode(value & 0xff);
						continue;
					}
					if (e === CR) {
						i += 1;
						if (stream[i] === LF) i += 1;
						continue;
					}
					if (e === LF) {
						i += 1;
						continue;
					}
					text += String.fromCharCode(escaped(e));
					i += 1;
					continue;
				}
				if (c === OPEN) depth += 1;
				else if (c === CLOSE) {
					depth -= 1;
					if (depth === 0) {
						i += 1;
						break;
					}
				}
				text += String.fromCharCode(c);
				i += 1;
			}
			if (inText) current += text;
			continue;
		}
		if (byte === LESS) {
			if (stream[i + 1] === LESS) {
				i += 2;
				continue;
			}
			const close = stream.indexOf(GREATER, i + 1);
			i = close < 0 ? n : close + 1;
			continue;
		}
		const before = i === 0 ? null : (stream[i - 1] ?? null);
		const after = i + 2 < n ? (stream[i + 2] ?? null) : null;
		const bounded =
			(before === null || isWhite(before) || isDelimiter(before)) &&
			(after === null || isWhite(after));
		if (bounded && byte === 0x42 && stream[i + 1] === 0x54) {
			// BT
			inText = true;
			current = "";
			i += 2;
			continue;
		}
		if (bounded && byte === 0x45 && stream[i + 1] === 0x54) {
			// ET
			if (inText && current !== "") tokens.push(current);
			inText = false;
			current = "";
			i += 2;
			continue;
		}
		i += 1;
	}
	return tokens;
}

/**
 * Every text token of a PDF's content streams, in file order; null when the
 * file is refused (`pdfStreams`).
 */
export function readPdfTextTokens(pdf: Uint8Array): string[] | null {
	const streams = pdfStreams(pdf);
	if (streams === null) return null;
	const tokens: string[] = [];
	for (const stream of streams) {
		if (isTextStream(stream)) tokens.push(...pdfTextTokens(stream));
	}
	return tokens;
}
