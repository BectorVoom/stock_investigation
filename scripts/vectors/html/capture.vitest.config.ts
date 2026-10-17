/**
 * Runs the converter's TypeScript test suites with `htmlToMarkdown` replaced
 * by a recorder (see `captureRecorder.ts`):
 *
 *     HTML_CAPTURE_FILE=/tmp/calls.jsonl \
 *       node_modules/.bin/vitest run --config scripts/vectors/html/capture.vitest.config.ts
 *
 * `testInputs.ts` must contain every recorded input (the fast-check runs
 * without a fixed seed excepted — the corpus samples those arbitraries with
 * fixed seeds instead).
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^\.\.\/\.\.\/src\/tools\/htmlToMarkdown\.ts$/,
				replacement: fileURLToPath(new URL("./captureRecorder.ts", import.meta.url)),
			},
		],
	},
	test: {
		root: fileURLToPath(new URL("../../..", import.meta.url)),
		include: ["packages/adapters/test/tools/htmlToMarkdown*.test.ts"],
	},
});
