/**
 * Splits a byte/text stream into lines without ever holding more than
 * `maxLineChars` of an unterminated line: a provider that never sends a newline
 * cannot make the runner buffer without bound. An over-long line is flushed in
 * pieces, which the caller's output budget then rejects.
 */
export async function* splitLines(
	chunks: AsyncIterable<Uint8Array | string>,
	maxLineChars: number,
): AsyncGenerator<string, void, undefined> {
	const decoder = new TextDecoder("utf-8");
	let pending = "";
	for await (const chunk of chunks) {
		pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		let lineStart = 0;
		let newlineIndex = pending.indexOf("\n", lineStart);
		while (newlineIndex !== -1) {
			yield stripCarriageReturn(pending.slice(lineStart, newlineIndex));
			lineStart = newlineIndex + 1;
			newlineIndex = pending.indexOf("\n", lineStart);
		}
		pending = pending.slice(lineStart);
		while (pending.length > maxLineChars) {
			yield pending.slice(0, maxLineChars);
			pending = pending.slice(maxLineChars);
		}
	}
	pending += decoder.decode();
	if (pending.length > 0) yield stripCarriageReturn(pending);
}

function stripCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}
