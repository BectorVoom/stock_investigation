/** Explicit, foreground real-network comparison. Eight searches total across runtimes. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@research/agent-core";
import { createNodeSafeFetcher } from "../../../packages/adapters/src/node/index.ts";
import { createFilePageArchive } from "../../../packages/adapters/src/node/pageArchive.ts";
import { systemClock, webCryptoHasher } from "../../../packages/adapters/src/runtime/index.ts";
import { createSearchTools } from "../../../packages/adapters/src/tools/searchTools.ts";
import { createWebTools } from "../../../packages/adapters/src/tools/webTools.ts";

const directory = await mkdtemp(join(tmpdir(), "rr-tools-live-"));
try {
	const fetcher = createNodeSafeFetcher();
	const sleep = (ms: number, signal: AbortSignal) =>
		new Promise<void>((resolve) => {
			if (signal.aborted) {
				resolve();
				return;
			}
			const timer = setTimeout(done, ms);
			function done() {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			}
			signal.addEventListener("abort", done, { once: true });
		});
	const deps = { fetcher, hasher: webCryptoHasher, clock: systemClock, sleep };
	const [search] = createSearchTools(deps);
	const [web] = createWebTools({
		...deps,
		pageArchive: createFilePageArchive({ directory, hasher: webCryptoHasher }),
	});
	let next = 0;
	const context: ToolContext = {
		runId: "run_live",
		signal: new AbortController().signal,
		subscribedSources: [],
		nowIso: () => new Date().toISOString(),
		nextId: (prefix) => `run_live_${prefix}${++next}`,
	};
	const results = [];
	for (const [kind, tool, input] of [
		["search", search, "gold price"],
		["search", search, "battery storage"],
		["search", search, "gold price"],
		["search", search, "battery storage"],
		["page", web, "https://www.rfc-editor.org/rfc/rfc9309.txt"],
		["page", web, "https://www.rfc-editor.org/rfc/rfc9110.txt"],
		["page", web, "https://www.iana.org/domains/reserved"],
		["page", web, "https://www.iana.org/help/example-domains"],
	] as const) {
		if (tool === undefined) throw new Error("missing tool");
		const started = performance.now();
		const result = await tool.execute(
			kind === "search" ? { query: input } : { url: input },
			context,
		);
		const row = {
			runtime: "TypeScript",
			kind,
			input,
			ms: Math.round(performance.now() - started),
			status: result.ok ? "ok" : result.error.code,
			detail: result.ok
				? result.value.modelText.split("\n").filter((line) => line.includes("search failed"))
				: result.error.detail,
			evidence: result.ok ? result.value.evidence.length : 0,
		};
		results.push(row);
		console.log(JSON.stringify(row));
	}
	await writeFile("/tmp/rr-tools-live-ts.json", `${JSON.stringify(results, null, 2)}\n`);
} finally {
	await rm(directory, { recursive: true, force: true });
}
