import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Runs the API and D1 adapter tests inside workerd with a real (local) D1
 * database built from the production migrations (API-010): Worker runtime
 * behaviour is exercised in the Worker runtime, not in Node mocks.
 */
export default defineConfig(async () => {
	const migrations = await readD1Migrations(
		fileURLToPath(new URL("../../infra/migrations", import.meta.url)),
	);
	return {
		plugins: [
			cloudflareTest({
				miniflare: {
					compatibilityDate: "2026-09-01",
					d1Databases: ["DB"],
					bindings: { TEST_MIGRATIONS: migrations },
				},
			}),
		],
		test: {
			name: "workers",
			root: fileURLToPath(new URL(".", import.meta.url)),
			include: ["test/**/*.test.ts", "../../packages/adapters/test/{d1,worker}/**/*.test.ts"],
			setupFiles: ["./test/applyMigrations.ts"],
		},
	};
});
