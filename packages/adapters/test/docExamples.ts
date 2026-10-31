/**
 * Reads a marked example from an external API document
 * (docs/external-apis/conventions.md §4): the code block on the line after
 * `<!-- example: <id> -->` in `docs/external-apis/apis/<api>.md`. The
 * `*DocExamples.test.ts` files feed these bodies through the runner's own
 * parsers, so a document whose example the code would reject fails the build.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const APIS_DIR = fileURLToPath(new URL("../../../docs/external-apis/apis/", import.meta.url));

/** The raw text of example `id` in `docs/external-apis/apis/<api>.md`. */
export function docExampleText(api: string, id: string): string {
	const lines = readFileSync(`${APIS_DIR}${api}.md`, "utf8").split("\n");
	const marker = lines.indexOf(`<!-- example: ${id} -->`);
	if (marker < 0) throw new Error(`example ${id} not found in docs/external-apis/apis/${api}.md`);
	const open = lines[marker + 1] ?? "";
	if (!open.startsWith("```"))
		throw new Error(`example ${id}: no code block right after its marker`);
	const close = lines.findIndex((line, at) => at > marker + 1 && line.startsWith("```"));
	if (close < 0) throw new Error(`example ${id}: unclosed code block`);
	return lines.slice(marker + 2, close).join("\n");
}

/** Example `id` parsed as JSON. */
export function docExampleJson(api: string, id: string): unknown {
	return JSON.parse(docExampleText(api, id));
}
