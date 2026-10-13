/**
 * ZIP reader tests: round-trips plus the fail-closed ceilings (archive size,
 * entry size, bombs) and corrupt/unsupported shapes. Archives are built
 * in-test with `test/zipTestUtils.ts` — no fixture files.
 */
import { describe, expect, it } from "vitest";
import {
	MAX_ZIP_ARCHIVE_BYTES,
	MAX_ZIP_ENTRY_BYTES,
	readZipEntries,
} from "../../src/node/zipReader.ts";
import { expectErr, expectOk } from "../finance/support.ts";
import { buildTestZip, findSignature, patchByte, patchU16, patchU32 } from "../zipTestUtils.ts";

function textOf(map: ReadonlyMap<string, Uint8Array>, name: string): string {
	const entry = map.get(name);
	if (entry === undefined) throw new Error(`missing entry ${name}`);
	return new TextDecoder("utf-8").decode(entry);
}

describe("readZipEntries", () => {
	it("round-trips stored and deflated entries", () => {
		const archive = buildTestZip([
			{ name: "xl/worksheets/sheet1.xml", text: "<sheet>data</sheet>".repeat(100), method: 8 },
			{ name: "xl/sharedStrings.xml", text: "<strings>tiny</strings>", method: 0 },
		]);
		const entries = expectOk(
			readZipEntries(archive, ["xl/worksheets/sheet1.xml", "xl/sharedStrings.xml"]),
		);
		expect(textOf(entries, "xl/worksheets/sheet1.xml")).toBe("<sheet>data</sheet>".repeat(100));
		expect(textOf(entries, "xl/sharedStrings.xml")).toBe("<strings>tiny</strings>");
	});

	it("returns the first entry when a name repeats", () => {
		const archive = buildTestZip([
			{ name: "dup.txt", text: "first", method: 0 },
			{ name: "dup.txt", text: "second", method: 0 },
		]);
		const entries = expectOk(readZipEntries(archive, ["dup.txt"]));
		expect(textOf(entries, "dup.txt")).toBe("first");
	});

	it("accepts an empty request list", () => {
		const archive = buildTestZip([{ name: "a.txt", text: "x", method: 0 }]);
		expect(expectOk(readZipEntries(archive, [])).size).toBe(0);
	});

	it("rejects oversized archives before parsing", () => {
		expect(expectErr(readZipEntries(new Uint8Array(MAX_ZIP_ARCHIVE_BYTES + 1), ["a"]))).toBe(
			"ARCHIVE_TOO_LARGE",
		);
	});

	it("rejects non-ZIP bytes and unknown entry names", () => {
		expect(expectErr(readZipEntries(new TextEncoder().encode("hello"), ["a"]))).toBe("NOT_A_ZIP");
		const archive = buildTestZip([{ name: "a.txt", text: "x", method: 0 }]);
		expect(expectErr(readZipEntries(archive, ["missing.txt"]))).toBe("ENTRY_NOT_FOUND");
	});

	it("rejects corrupt signatures", () => {
		const archive = buildTestZip([{ name: "a.txt", text: "x".repeat(100), method: 8 }]);
		expect(expectErr(readZipEntries(patchByte(archive, 0, 0), ["a.txt"]))).toBe("CORRUPT_ENTRY");
		const central = findSignature(archive, 0x02014b50);
		expect(central).toBeGreaterThan(0);
		expect(expectErr(readZipEntries(patchByte(archive, central, 0), ["a.txt"]))).toBe(
			"CORRUPT_ENTRY",
		);
	});

	it("rejects encrypted entries and unknown methods", () => {
		const archive = buildTestZip([{ name: "a.txt", text: "x".repeat(100), method: 8 }]);
		const central = findSignature(archive, 0x02014b50);
		expect(expectErr(readZipEntries(patchU16(archive, central + 8, 1), ["a.txt"]))).toBe(
			"UNSUPPORTED_ZIP",
		);
		// Central and local methods must agree: patching both to an unknown
		// method is unsupported, patching only one is corrupt.
		const both = patchU16(patchU16(archive, central + 10, 12), 8, 12);
		expect(expectErr(readZipEntries(both, ["a.txt"]))).toBe("UNSUPPORTED_ZIP");
		const centralOnly = patchU16(archive, central + 10, 12);
		expect(expectErr(readZipEntries(centralOnly, ["a.txt"]))).toBe("CORRUPT_ENTRY");
	});

	it("rejects ZIP64 and multi-disk archives", () => {
		const archive = buildTestZip([{ name: "a.txt", text: "x", method: 0 }]);
		const eocd = archive.byteLength - 22;
		expect(findSignature(archive, 0x06054b50)).toBe(eocd);
		expect(expectErr(readZipEntries(patchU16(archive, eocd + 8, 0xffff), ["a.txt"]))).toBe(
			"UNSUPPORTED_ZIP",
		);
		expect(expectErr(readZipEntries(patchU16(archive, eocd + 4, 1), ["a.txt"]))).toBe(
			"UNSUPPORTED_ZIP",
		);
	});

	it("rejects stored entries whose sizes disagree", () => {
		const archive = buildTestZip([{ name: "a.txt", text: "x".repeat(64), method: 0 }]);
		const central = findSignature(archive, 0x02014b50);
		expect(expectErr(readZipEntries(patchU32(archive, central + 20, 65), ["a.txt"]))).toBe(
			"CORRUPT_ENTRY",
		);
	});

	it("rejects declared-huge entries without inflating them", () => {
		const archive = buildTestZip([{ name: "a.txt", text: "x", method: 0 }]);
		const central = findSignature(archive, 0x02014b50);
		expect(
			expectErr(
				readZipEntries(patchU32(archive, central + 24, MAX_ZIP_ENTRY_BYTES + 1), ["a.txt"]),
			),
		).toBe("ENTRY_TOO_LARGE");
	});

	it("stops a deflate bomb at the inflation ceiling", () => {
		const bomb = buildTestZip([{ name: "bomb.bin", text: "0".repeat(20_000_000), method: 8 }]);
		const central = findSignature(bomb, 0x02014b50);
		// Forge a small declared size in both headers: the reader must still
		// stop at the ceiling (local header is at 0, its size field at +22).
		const forged = patchU32(patchU32(bomb, central + 24, 100), 22, 100);
		expect(expectErr(readZipEntries(forged, ["bomb.bin"]))).toBe("ENTRY_TOO_LARGE");
	}, 30_000);
});
