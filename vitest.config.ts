import { fileURLToPath } from "node:url";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

/**
 * Four projects: plain Node for runtime-neutral packages and the runner, a
 * DOM for the SPA (and the Solid side of the widget grid), the real Workers runtime (workerd + D1) for the API and
 * D1 adapters, and `api-sqlite`, which runs the SAME API suite in Node
 * against `node:sqlite` (ADR-0008). `api-sqlite` aliases `cloudflare:test` to
 * a shim with an in-memory database; nothing else differs.
 */
export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					environment: "node",
					include: [
						"packages/{domain,contracts,agent-core,application,effects}/test/**/*.test.ts",
						"packages/widget-grid/test/{core,agent}/**/*.test.ts",
						"packages/i18n/test/**/*.test.ts",
						"packages/adapters/test/{feed,node,providers,finance,tools,sqlite,google}/**/*.test.ts",
						"apps/runner/test/**/*.test.ts",
						"apps/mcp/test/**/*.test.ts",
						"tests/{architecture,contracts,security,formal,local,live,ui-review}/**/*.test.ts",
					],
				},
			},
			{
				// Hot reloading pulls in a virtual module that cannot resolve solid-js from the repo root.
				plugins: [solid({ hot: false })],
				resolve: { conditions: ["development", "browser"] },
				test: {
					name: "web",
					environment: "happy-dom",
					// stylesMetrics reads the package stylesheet through `?raw`;
					// only that file is processed, every other stylesheet stays mocked.
					css: { include: [/packages\/widget-grid\/src\/solid\/styles\.css/] },
					setupFiles: ["apps/web/test/setup.ts"],
					include: [
						"apps/web/test/**/*.test.{ts,tsx}",
						"packages/ui-registry/test/**/*.test.{ts,tsx}",
						"packages/widget-grid/test/solid/**/*.test.{ts,tsx}",
						"packages/i18n/test/**/*.test.tsx",
					],
				},
			},
			"apps/api/vitest.config.ts",
			{
				resolve: {
					alias: [
						{
							find: /^cloudflare:test$/,
							replacement: fileURLToPath(
								new URL("./tests/persistence/cloudflareTestShim.ts", import.meta.url),
							),
						},
					],
				},
				test: {
					name: "api-sqlite",
					environment: "node",
					root: fileURLToPath(new URL("./apps/api", import.meta.url)),
					include: ["test/**/*.test.ts"],
					setupFiles: ["./test/applyMigrations.ts"],
				},
			},
		],
	},
});
