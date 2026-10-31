/**
 * The charset-decoding cases (`src/runtime/charset.ts`), run in Node
 * (`test/node/charset.test.ts`, the runner) and in workerd
 * (`test/worker/charset.test.ts`, the API Worker's source preview), so both
 * runtimes' `TextDecoder` are shown to decode them alike. The Rust twin
 * (`crates/research-net/src/charset.rs`) checks the same cases.
 */
import { expect, it } from "vitest";
import { contentTypeCharset, decodeBody } from "../src/runtime/charset.ts";

/** "日本語" in Shift_JIS and EUC-JP. */
const SJIS = [0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea];
const EUC = [0xc6, 0xfc, 0xcb, 0xdc, 0xb8, 0xec];

function bytes(...parts: readonly (string | readonly number[])[]): Uint8Array {
	const out: number[] = [];
	for (const part of parts) {
		if (typeof part === "string") out.push(...new TextEncoder().encode(part));
		else out.push(...part);
	}
	return new Uint8Array(out);
}

export function charsetCases(): void {
	it("decodes by the Content-Type charset", () => {
		expect(decodeBody(bytes(SJIS), "text/html; charset=Shift_JIS")).toBe("日本語");
		expect(decodeBody(bytes(EUC), 'text/xml; Charset="euc-jp"')).toBe("日本語");
	});

	it("reads an XML declaration at the very start, but the header wins", () => {
		const xml = bytes(
			`<?xml version="1.0" encoding='Shift_JIS'?><rss><title>`,
			SJIS,
			"</title></rss>",
		);
		expect(decodeBody(xml, "text/xml")).toContain("<title>日本語</title>");
		expect(decodeBody(xml, "text/xml; charset=utf-8")).not.toContain("日本語");
	});

	it("reads an HTML meta charset in either form", () => {
		const httpEquiv = bytes(
			'<html><head><META http-equiv="Content-Type" content="text/html; charset=euc-jp">',
			EUC,
		);
		expect(decodeBody(httpEquiv, null).endsWith("日本語")).toBe(true);
		expect(
			decodeBody(bytes("<meta charset=shift_jis><p>", SJIS), "text/html").endsWith("日本語"),
		).toBe(true);
	});

	it("skips unknown labels and the replacement encoding, then decodes UTF-8", () => {
		const unknown = bytes('<meta charset="x-unknown"><p>', "日本語");
		expect(decodeBody(unknown, "text/html; charset=bogus").endsWith("日本語")).toBe(true);
		expect(decodeBody(bytes("é"), "text/html; charset=iso-2022-kr")).toBe("é");
	});

	it("reads neither a late declaration nor a meta past the first 1,024 bytes", () => {
		const late = bytes(' <?xml version="1.0" encoding="shift_jis"?>', SJIS);
		expect(decodeBody(late, null).endsWith("�")).toBe(true);
		const far = bytes(" ".repeat(1_024), "<meta charset=shift_jis>", SJIS);
		expect(decodeBody(far, null)).toContain("�");
	});

	it("lets a byte-order mark win and drops it", () => {
		expect(decodeBody(bytes([0xff, 0xfe, 0x61, 0x00]), "text/plain; charset=shift_jis")).toBe("a");
		expect(decodeBody(bytes([0xef, 0xbb, 0xbf], "a"), null)).toBe("a");
	});

	it("decodes an 8-bit page by its latin-1 label (windows-1252)", () => {
		expect(decodeBody(bytes("caf", [0xe9]), "text/html; charset=ISO-8859-1")).toBe("café");
	});

	it("reads the charset parameter of Content-Type", () => {
		expect(contentTypeCharset("text/html; charset=UTF-8")).toBe("UTF-8");
		expect(contentTypeCharset("text/html;charset='x'")).toBe("x");
		expect(contentTypeCharset("text/html; charset=")).toBeNull();
		expect(contentTypeCharset("charset=utf-8")).toBeNull();
		expect(contentTypeCharset(null)).toBeNull();
	});
}
