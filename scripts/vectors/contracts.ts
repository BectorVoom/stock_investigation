/**
 * Wire-contract vectors (crate `research-contracts`, ADR-0030 decision 4):
 * every runner-reached zod schema run over fixtures and systematic
 * mutations, with zod's verdict, issues and parsed output; plus the
 * `JSON.parse` / `JSON.stringify` vectors of `research_js::json`.
 */

import { jsonVectors } from "./contracts/json.ts";
import type { VectorExporter } from "./shared.ts";

export const contractsExporter: VectorExporter = {
	name: "contracts",
	async build() {
		return [{ path: "js/json.json", content: jsonVectors() }];
	},
};
