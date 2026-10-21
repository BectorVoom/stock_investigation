import { describe, expect, it } from "vitest";
import { parseJson, parseJsonOrNull } from "../src/json.ts";
import { describeThrown, thrownCode, thrownName, UNKNOWN_ERROR } from "../src/thrown.ts";
import { parseUrl } from "../src/url.ts";

/** Thrown values whose message is a secret; no label may ever contain it. */
const SECRET = "Bearer sk-live-secret /home/owner/data 10.0.0.7:443";

describe("thrownName", () => {
	it("names built-in, DOM and custom errors by their name", () => {
		expect(thrownName(new TypeError(SECRET))).toBe("TypeError");
		expect(thrownName(new DOMException(SECRET, "AbortError"))).toBe("AbortError");
		class StoredDataError extends Error {
			constructor() {
				super(SECRET);
				this.name = "StoredDataError";
			}
		}
		expect(thrownName(new StoredDataError())).toBe("StoredDataError");
	});

	it.each([
		["a thrown string", SECRET],
		["a thrown number", 42],
		["null", null],
		["undefined", undefined],
		["a name carrying free text", Object.assign(new Error("x"), { name: SECRET })],
		["an empty name", Object.assign(new Error("x"), { name: "" })],
		["a non-string name", { name: 7 }],
	])("falls back to unknown for %s", (_label, thrown) => {
		expect(thrownName(thrown)).toBe("unknown");
	});
});

describe("thrownCode", () => {
	it("keeps a safe OS or library code", () => {
		expect(thrownCode(Object.assign(new Error(SECRET), { code: "EACCES" }))).toBe("EACCES");
		expect(thrownCode({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe(
			"ERR_TLS_CERT_ALTNAME_INVALID",
		);
	});

	it.each([
		["free text", SECRET],
		["lowercase", "eacces"],
		["a single letter", "E"],
		["a leading digit", "1ABC"],
		["a 61-character token", `E${"1".repeat(60)}`],
		["a non-string", 13],
	])("drops %s", (_label, code) => {
		expect(thrownCode(Object.assign(new Error("x"), { code }))).toBeUndefined();
	});
});

describe("describeThrown", () => {
	it("prefers the code, then the name, then the shared fallback", () => {
		expect(describeThrown(Object.assign(new Error(SECRET), { code: "ECONNRESET" }))).toBe(
			"ECONNRESET",
		);
		expect(describeThrown(new RangeError(SECRET))).toBe("RangeError");
		expect(describeThrown(SECRET)).toBe(UNKNOWN_ERROR);
	});

	it("keeps the label the Rust runner mirrors", () => {
		// crates/research-net/src/errors.rs: UNKNOWN_ERROR
		expect(UNKNOWN_ERROR).toBe("unknown error");
	});
});

describe("parseJson", () => {
	it("returns the parsed value", () => {
		expect(parseJson('{"a":[1,null]}')).toEqual({ ok: true, value: { a: [1, null] } });
		expect(parseJson("null")).toEqual({ ok: true, value: null });
	});

	it.each([
		["empty text", ""],
		["prose", "rate limit exceeded"],
		["truncated", '{"a":'],
	])("reports %s as INVALID_JSON instead of throwing", (_label, text) => {
		expect(parseJson(text)).toEqual({ ok: false, error: "INVALID_JSON" });
	});

	it("parseJsonOrNull turns text that is not JSON into null", () => {
		expect(parseJsonOrNull('{"ok":true}')).toEqual({ ok: true });
		expect(parseJsonOrNull("<html>")).toBeNull();
	});
});

describe("parseUrl", () => {
	it("parses absolute and relative URLs", () => {
		expect(parseUrl("https://example.com/a?b=1")?.href).toBe("https://example.com/a?b=1");
		expect(parseUrl("../c", "https://example.com/a/b")?.href).toBe("https://example.com/c");
	});

	it("returns null instead of throwing for a malformed URL or base", () => {
		expect(parseUrl("not a url")).toBeNull();
		expect(parseUrl("/path", "also not a url")).toBeNull();
	});
});
