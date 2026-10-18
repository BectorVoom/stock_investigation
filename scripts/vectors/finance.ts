/**
 * Market data, earnings dates, SEC and the runner's refresh jobs (crate
 * `research-finance`). The parts live in `scripts/vectors/finance/`; this
 * file only names the exporter and concatenates their files.
 */
import type { VectorExporter, VectorFile } from "./shared.ts";
import { jobsFiles } from "./finance/jobs.ts";
import { jpxFiles } from "./finance/jpx.ts";
import { marketFiles } from "./finance/market.ts";
import { secFiles } from "./finance/sec.ts";

export const financeExporter: VectorExporter = {
	name: "finance",
	async build(): Promise<readonly VectorFile[]> {
		const parts = [await marketFiles(), await jpxFiles(), await secFiles(), await jobsFiles()];
		return parts.flat().map((file) => ({ path: file.path, content: file.content }));
	},
};
