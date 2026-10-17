/**
 * Conformance vectors for the Rust runner (ADR-0030 decision 2).
 *
 * Each exporter runs the TypeScript implementation — or JavaScript itself —
 * over a corpus and writes `{ input, output }` cases to `vectors/<name>.json`;
 * `cargo test` replays them against the Rust port. Run under Node, never Bun:
 * the runner's semantics are V8's (`Date.parse`, number formatting), and
 * JavaScriptCore differs.
 *
 *     node scripts/vectors/index.ts            # regenerate every vector file
 *     node scripts/vectors/index.ts --check    # fail when a committed file is stale
 *     node scripts/vectors/index.ts js html    # only these exporters
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exporters } from "./registry.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function main(): Promise<number> {
	const args = process.argv.slice(2);
	const check = args.includes("--check");
	const only = new Set(args.filter((arg) => !arg.startsWith("--")));
	let stale = 0;
	for (const exporter of exporters) {
		if (only.size > 0 && !only.has(exporter.name)) continue;
		for (const file of await exporter.build()) {
			const path = join(repoRoot, "vectors", file.path);
			const text = `${JSON.stringify(file.content, null, "\t")}\n`;
			if (check) {
				const committed = await readFile(path, "utf8").catch(() => null);
				if (committed !== text) {
					console.error(`stale: vectors/${file.path} (run: node scripts/vectors/index.ts)`);
					stale += 1;
				}
			} else {
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, text);
				console.log(`wrote vectors/${file.path}`);
			}
		}
	}
	return stale === 0 ? 0 : 1;
}

process.exitCode = await main();
