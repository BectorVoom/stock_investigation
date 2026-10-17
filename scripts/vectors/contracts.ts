/**
 * Wire-contract vectors (crate `research-contracts`, ADR-0030 decision 4):
 * every runner-reached zod schema run over fixtures and systematic
 * mutations, with zod's verdict, issues and parsed output; plus the
 * `JSON.parse` / `JSON.stringify` vectors of `research_js::json`.
 */

import { jsonVectors } from "./contracts/json.ts";
import { evaluate, mutationCases } from "./contracts/mutations.ts";
import { SCHEMAS } from "./contracts/schemas.ts";
import type { VectorExporter, VectorFile } from "./shared.ts";

export const contractsExporter: VectorExporter = {
	name: "contracts",
	async build() {
		const files: VectorFile[] = [{ path: "js/json.json", content: jsonVectors() }];
		for (const [index, entry] of SCHEMAS.entries()) {
			const cases = mutationCases(entry.schema, entry.baselines, entry.options, index + 1);
			for (const text of entry.extra ?? []) cases.push(evaluate(entry.schema, text));
			files.push({ path: `contracts/${entry.name}.json`, content: { schema: entry.name, cases } });
		}
		files.push({ path: "contracts/index.json", content: SCHEMAS.map((entry) => entry.name) });
		return files;
	},
};
