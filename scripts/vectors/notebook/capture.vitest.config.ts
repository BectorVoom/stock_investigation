/** Runs existing notebook tests with recording wrappers, never production seams. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
	test: {
		root: fileURLToPath(new URL("../../..", import.meta.url)),
		include: [
			"packages/application/test/notebook*.test.ts",
			"packages/application/test/scriptedNotebookAgent.test.ts",
			"apps/runner/test/notebookAssist.test.ts",
		],
		setupFiles: ["scripts/vectors/notebook/capture.ts"],
		fileParallelism: false,
	},
});
