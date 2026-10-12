import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/+$/, "");

/**
 * Files that may name the D1 engine types: the D1 binding itself, the Worker
 * env declaration, and the workerd test setup (ADR-0008). Everywhere else —
 * in particular `packages/adapters/src/sql` and `apps/api/src` — persistence
 * is typed against the engine-neutral seams, so a stray engine type would
 * recouple the code to one engine.
 */
const ALLOWED = new Set([
	"packages/adapters/src/d1/index.ts",
	"apps/api/src/env.ts",
	"apps/api/test/env.d.ts",
]);

const SOURCE_FILE = /\.(ts|tsx)$/;
// Written without the identifier literals so this file itself stays clean.
const D1_IDENTIFIER = new RegExp(`\\b${"D1"}(${"Database"}|${"PreparedStatement"})\\b`);

function collect(directory: string, files: string[] = []): string[] {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		// Never descend into generated, vendored or local-state directories.
		if (
			entry.name === "node_modules" ||
			entry.name === "dist" ||
			entry.name === "data" ||
			entry.name === ".git"
		) {
			continue;
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			collect(path, files);
		} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

describe("persistence stays engine-neutral outside the D1 binding", () => {
	it("names the engine types only where the engine is wired in", () => {
		const offenders: string[] = [];
		for (const absolute of collect(REPO_ROOT)) {
			const relative = absolute
				.slice(REPO_ROOT.length + 1)
				.split("\\")
				.join("/");
			if (ALLOWED.has(relative)) continue;
			if (D1_IDENTIFIER.test(readFileSync(absolute, "utf8"))) {
				offenders.push(relative);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("keeps the allowlist itself tight", () => {
		expect([...ALLOWED].sort()).toEqual([
			"apps/api/src/env.ts",
			"apps/api/test/env.d.ts",
			"packages/adapters/src/d1/index.ts",
		]);
	});
});
