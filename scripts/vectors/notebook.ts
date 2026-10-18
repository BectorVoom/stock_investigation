/** Whole-turn transcripts from real TypeScript tests plus a seeded notebook corpus. */
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { notebookAssistPrompt } from "../../packages/application/src/notebook/prompts.ts";
import { benchmarkNotebook, heavyChartsNotebook } from "./notebook/benchmark.ts";
import { encodeNumbers } from "./notebook/record.ts";
import type { VectorExporter, VectorFile } from "./shared.ts";

export const notebookExporter: VectorExporter = {
	name: "notebook",
	async build() {
		const root = fileURLToPath(new URL("../..", import.meta.url));
		const temp = await mkdtemp(join(tmpdir(), "rr-notebook-"));
		const capture = join(temp, "capture.jsonl");
		try {
			execFileSync(
				process.execPath,
				[
					"node_modules/vitest/vitest.mjs",
					"run",
					"--config",
					"scripts/vectors/notebook/capture.vitest.config.ts",
				],
				{
					cwd: root,
					env: {
						...process.env,
						NOTEBOOK_CAPTURE_FILE: capture,
						NOTEBOOK_SKIP_OVER_BYTES: "1500000",
					},
					stdio: "pipe",
					timeout: 60_000,
				},
			);
			execFileSync(process.execPath, ["scripts/vectors/notebook/runGenerated.ts"], {
				cwd: root,
				env: {
					...process.env,
					NOTEBOOK_CAPTURE_FILE: capture,
					NOTEBOOK_SKIP_OVER_BYTES: "150000",
				},
				stdio: "pipe",
				timeout: 60_000,
			});
			const cases = [...new Set((await readFile(capture, "utf8")).trim().split("\n"))]
				.sort()
				.map((line): unknown => encodeNumbers(JSON.parse(line)));
			const files: VectorFile[] = [];
			let part: unknown[] = [];
			let bytes = 0;
			for (const entry of cases) {
				const size = Buffer.byteLength(JSON.stringify(entry, null, "\t"));
				if (bytes + size > 4_000_000 && part.length > 0) {
					files.push({ path: `notebook/transcripts-${files.length}.json`, content: part });
					part = [];
					bytes = 0;
				}
				part.push(entry);
				bytes += size;
			}
			if (part.length > 0)
				files.push({ path: `notebook/transcripts-${files.length}.json`, content: part });
			const prompt = notebookAssistPrompt({
				notebook: { widgets: [] },
				selectedWidgetIds: [],
				instruction: "Task",
				conversationContext: [],
				fenceToken: "token",
				repairNote: null,
			});
			files.push({ path: "notebook/benchmark.json", content: encodeNumbers(benchmarkNotebook()) });
			files.push({ path: "notebook/heavy.json", content: encodeNumbers(heavyChartsNotebook()) });
			const promptParts = {
				head: prompt.split("Selected widget ids:")[0],
				tail: prompt.slice(prompt.indexOf("Return exactly one JSON object")),
			};
			files.push({ path: "notebook/prompt.json", content: promptParts });
			// The production copy `include_str!`ed by the Rust crate. Its path leaves
			// `vectors/` on purpose: `--check` then fails when it drifts from the TS prompt,
			// and a Rust test pins it to the vector copy above.
			files.push({
				path: "../crates/research-application/src/notebook/prompt-parts.json",
				content: promptParts,
			});
			return files;
		} finally {
			await rm(temp, { recursive: true, force: true });
		}
	},
};
