/**
 * Decodes a fetched body by the charset it declares, so a Shift_JIS or
 * EUC-JP feed or page is not garbled (docs/external-apis/apis/web-feeds-and-pages.md
 * section 3). Runtime-neutral (Worker and Node): web-standard `TextDecoder`
 * only. The Rust twin is `research_net::charset::decode_body`; both apply the
 * same steps, and `packages/adapters/test/charsetCases.ts` and the Rust
 * unit tests share their cases.
 *
 * The first source that names a supported encoding wins:
 *  1. a byte-order mark (`EF BB BF` UTF-8, `FF FE` UTF-16LE, `FE FF` UTF-16BE);
 *  2. the `charset` parameter of `Content-Type`;
 *  3. in the first 1,024 bytes: an XML declaration's `encoding` (only at the
 *     very start), else the `charset` of the first `<meta …>` that has one
 *     (`<meta charset=…>` or `content="…; charset=…"`);
 *  4. otherwise UTF-8.
 * A label the decoder does not know (or WHATWG's "replacement" encoding) is
 * skipped and the next source tried. Decoding is non-fatal: an invalid
 * sequence becomes U+FFFD. Byte limits are applied before this, to the bytes.
 */

/** How far into the body the XML declaration and HTML meta are looked for. */
export const CHARSET_SNIFF_BYTES = 1_024;

const UTF8 = "utf-8";

function isXmlSpace(byte: number | undefined): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function isHtmlSpace(byte: number | undefined): boolean {
	return isXmlSpace(byte) || byte === 0x0c;
}

function lowerAscii(byte: number): number {
	return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

/** Index of `word` (lower-case ASCII) in `bytes[from, to)`, ASCII case-insensitive; -1 when absent. */
function indexOfAscii(
	bytes: Uint8Array,
	word: string,
	from: number,
	to: number,
	caseInsensitive: boolean,
): number {
	outer: for (let start = from; start + word.length <= to; start += 1) {
		for (let offset = 0; offset < word.length; offset += 1) {
			const byte = bytes[start + offset] ?? -1;
			const actual = caseInsensitive ? lowerAscii(byte) : byte;
			if (actual !== word.charCodeAt(offset)) continue outer;
		}
		return start;
	}
	return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
	let text = "";
	for (let index = start; index < end; index += 1) text += String.fromCharCode(bytes[index] ?? 0);
	return text;
}

/** A label the decoder supports, as given; null for an unknown one or "replacement". */
function supported(label: string): string | null {
	try {
		// The constructor trims ASCII whitespace and matches labels case-insensitively;
		// it throws a RangeError for an unknown label and for "replacement".
		new TextDecoder(label);
		return label;
	} catch {
		return null;
	}
}

function bomLabel(bytes: Uint8Array): string | null {
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return UTF8;
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	return null;
}

/** The `charset` parameter of a `Content-Type` value, unquoted; null when absent or empty. */
export function contentTypeCharset(contentType: string | null): string | null {
	if (contentType === null) return null;
	for (const parameter of contentType.split(";").slice(1)) {
		const equals = parameter.indexOf("=");
		if (equals === -1) continue;
		if (parameter.slice(0, equals).trim().toLowerCase() !== "charset") continue;
		let value = parameter.slice(equals + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
			value = value.slice(1, -1).trim();
		}
		return value === "" ? null : value;
	}
	return null;
}

/** `<?xml … encoding="x" … ?>` at the very start of `bytes[0, end)`. */
function xmlDeclarationLabel(bytes: Uint8Array, end: number): string | null {
	if (indexOfAscii(bytes, "<?xml", 0, end, false) !== 0 || !isXmlSpace(bytes[5])) return null;
	const close = indexOfAscii(bytes, "?>", 5, end, false);
	if (close === -1) return null;
	const name = indexOfAscii(bytes, "encoding", 5, close, false);
	if (name === -1) return null;
	let index = name + "encoding".length;
	while (index < close && isXmlSpace(bytes[index])) index += 1;
	if (bytes[index] !== 0x3d) return null;
	index += 1;
	while (index < close && isXmlSpace(bytes[index])) index += 1;
	const quote = bytes[index];
	if (quote !== 0x22 && quote !== 0x27) return null;
	const valueStart = index + 1;
	let valueEnd = valueStart;
	while (valueEnd < close && bytes[valueEnd] !== quote) valueEnd += 1;
	if (valueEnd >= close || valueEnd === valueStart) return null;
	return latin1(bytes, valueStart, valueEnd);
}

const META_VALUE_END = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x22, 0x27, 0x3b, 0x3e, 0x2f]);

/** The `charset` of the first `<meta …>` in `bytes[0, end)` that names one. */
function metaCharsetLabel(bytes: Uint8Array, end: number): string | null {
	let from = 0;
	for (;;) {
		const tag = indexOfAscii(bytes, "<meta", from, end, true);
		if (tag === -1) return null;
		const after = bytes[tag + 5];
		from = tag + 5;
		if (!(isHtmlSpace(after) || after === 0x2f)) continue;
		let tagEnd = from;
		while (tagEnd < end && bytes[tagEnd] !== 0x3e) tagEnd += 1;
		let search = from;
		for (;;) {
			const name = indexOfAscii(bytes, "charset", search, tagEnd, true);
			if (name === -1) break;
			search = name + "charset".length;
			let index = search;
			while (index < tagEnd && isHtmlSpace(bytes[index])) index += 1;
			if (bytes[index] !== 0x3d) continue;
			index += 1;
			while (index < tagEnd && isHtmlSpace(bytes[index])) index += 1;
			if (bytes[index] === 0x22 || bytes[index] === 0x27) index += 1;
			while (index < tagEnd && isHtmlSpace(bytes[index])) index += 1;
			let valueEnd = index;
			while (valueEnd < tagEnd && !META_VALUE_END.has(bytes[valueEnd] ?? 0x3e)) valueEnd += 1;
			if (valueEnd > index) return latin1(bytes, index, valueEnd);
		}
		from = tagEnd;
	}
}

/** The label `decodeBody` decodes `bytes` with (see the module header). */
export function bodyEncoding(bytes: Uint8Array, contentType: string | null): string {
	const bom = bomLabel(bytes);
	if (bom !== null) return bom;
	const header = contentTypeCharset(contentType);
	const fromHeader = header === null ? null : supported(header);
	if (fromHeader !== null) return fromHeader;
	const end = Math.min(bytes.byteLength, CHARSET_SNIFF_BYTES);
	const xml = xmlDeclarationLabel(bytes, end);
	const fromXml = xml === null ? null : supported(xml);
	if (fromXml !== null) return fromXml;
	const meta = metaCharsetLabel(bytes, end);
	const fromMeta = meta === null ? null : supported(meta);
	return fromMeta ?? UTF8;
}

/** `bytes` as text, decoded by the charset they declare (see the module header). */
export function decodeBody(bytes: Uint8Array, contentType: string | null): string {
	// The decoder of the chosen encoding drops that encoding's own byte-order mark.
	return new TextDecoder(bodyEncoding(bytes, contentType)).decode(bytes);
}
