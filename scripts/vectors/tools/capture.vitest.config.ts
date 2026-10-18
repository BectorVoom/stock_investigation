import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^(?:\.\/|\.\.\/\.\.\/src\/tools\/)(?:newsTools|searchTools|webTools|robotsPolicy)\.ts$/,
				replacement: fileURLToPath(new URL("./recorder.ts", import.meta.url)),
			},
		],
	},
	test: {
		root: fileURLToPath(new URL("../../..", import.meta.url)),
		include: [
			"packages/adapters/test/tools/{newsTools,searchTools,webTools,webToolsOmitted,robotsPolicy,catalogue}.test.ts",
		],
		fileParallelism: false,
		setupFiles: [fileURLToPath(new URL("./setup.ts", import.meta.url))],
	},
});
