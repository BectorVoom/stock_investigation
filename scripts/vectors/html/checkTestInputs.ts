/**
 * Checks `testInputs.ts` against a recording of the converter's real test
 * suites (see `capture.vitest.config.ts`):
 *
 *     node scripts/vectors/html/checkTestInputs.ts /tmp/calls.jsonl
 *
 * Prints every recorded call missing from the corpus. The two fast-check
 * properties (arbitrary strings with a random base URL, structured HTML)
 * are expected to be missing: the corpus samples them with fixed seeds.
 */
import { readFileSync } from "node:fs";
import { wellFormed } from "../shared.ts";
import { joinPieces, TEST_INPUTS } from "./testInputs.ts";

interface Recorded {
	readonly html: string;
	readonly options: { readonly baseUrl: string; readonly maxChars: number };
}

function key(html: string, baseUrl: string, maxChars: number): string {
	return JSON.stringify([wellFormed(html), baseUrl, maxChars]);
}

const path = process.argv[2];
if (path === undefined) throw new Error("usage: checkTestInputs.ts <calls.jsonl>");
const corpus = new Set(
	TEST_INPUTS.map((input) => key(joinPieces(input.html), input.baseUrl, input.maxChars)),
);
const recorded = new Set<string>();
let missing = 0;
for (const line of readFileSync(path, "utf8").split("\n")) {
	if (line === "") continue;
	const call = JSON.parse(line) as Recorded;
	const callKey = key(call.html, call.options.baseUrl, call.options.maxChars);
	recorded.add(callKey);
	if (!corpus.has(callKey)) {
		missing += 1;
		console.log(`missing: ${callKey.slice(0, 160)}`);
	}
}
let unused = 0;
for (const entry of corpus) {
	if (!recorded.has(entry)) {
		unused += 1;
		console.log(`not recorded: ${entry.slice(0, 160)}`);
	}
}
console.log(
	`${corpus.size} corpus inputs, ${recorded.size} distinct recorded, ${missing} missing, ${unused} not recorded`,
);
