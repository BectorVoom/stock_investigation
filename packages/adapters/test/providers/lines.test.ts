import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { splitLines } from "../../src/providers/lines.ts";

async function* fromChunks<T>(chunks: readonly T[]): AsyncGenerator<T, void, undefined> {
	for (const chunk of chunks) yield chunk;
}

async function linesOf(
	chunks: readonly (Uint8Array | string)[],
	maxLineChars = 1_000,
): Promise<string[]> {
	const lines: string[] = [];
	for await (const line of splitLines(fromChunks(chunks), maxLineChars)) lines.push(line);
	return lines;
}

/** Cuts `bytes` at the given offsets, so a multi-byte character can straddle two chunks. */
function cutAt(bytes: Uint8Array, offsets: readonly number[]): Uint8Array[] {
	const cuts = [...new Set(offsets.map((offset) => offset % (bytes.length + 1)))].sort(
		(left, right) => left - right,
	);
	const chunks: Uint8Array[] = [];
	let start = 0;
	for (const cut of [...cuts, bytes.length]) {
		chunks.push(bytes.slice(start, cut));
		start = cut;
	}
	return chunks;
}

describe("splitLines", () => {
	it("joins a line that is split across chunks", async () => {
		expect(await linesOf(['data: {"a"', ":1}\nsecond", "\n"])).toEqual(['data: {"a":1}', "second"]);
	});

	it("yields a final line that has no trailing newline", async () => {
		expect(await linesOf(["one\ntwo"])).toEqual(["one", "two"]);
	});

	it("strips carriage returns and keeps blank lines", async () => {
		expect(await linesOf(["a\r\n\r\nb\r\n"])).toEqual(["a", "", "b"]);
	});

	it("flushes an unterminated line in bounded pieces instead of buffering it", async () => {
		const lines = await linesOf(["x".repeat(25)], 10);
		expect(lines).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
	});

	it("yields nothing for an empty stream", async () => {
		expect(await linesOf([])).toEqual([]);
	});

	it("reassembles the same lines however the bytes are chunked", async () => {
		const lineArbitrary = fc.string({ unit: "grapheme" }).filter((line) => !/[\r\n]/.test(line));
		await fc.assert(
			fc.asyncProperty(
				fc.array(lineArbitrary, { maxLength: 8 }),
				fc.array(fc.nat(), { maxLength: 12 }),
				async (expectedLines, offsets) => {
					const bytes = new TextEncoder().encode(expectedLines.map((line) => `${line}\n`).join(""));
					expect(await linesOf(cutAt(bytes, offsets), 100_000)).toEqual(expectedLines);
				},
			),
		);
	});
});
