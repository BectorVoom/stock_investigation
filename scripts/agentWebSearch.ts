/** Operator launcher for the independently built Rust search service. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { agentSearchEndpoint } from "../packages/adapters/src/tools/agentSearchEndpoint.ts";

const base = process.env.AGENT_WEB_SEARCH_URL?.trim() || "http://127.0.0.1:8090";
const endpoint = agentSearchEndpoint(base);
const key = process.env.AGENT_WEB_SEARCH_API_KEY?.trim() ?? "";
const binary = resolve(
	process.env.AGENT_WEB_SEARCH_BINARY || "../agent-web-search/target/release/agent-web-search",
);
const database = resolve(process.env.AGENT_WEB_SEARCH_DB || "data-search/corpus.sqlite");
if (endpoint === null || !/^[\x21-\x7e]{16,256}$/.test(key) || !existsSync(binary)) {
	console.error(
		"Set a loopback AGENT_WEB_SEARCH_URL, AGENT_WEB_SEARCH_API_KEY and a built AGENT_WEB_SEARCH_BINARY.",
	);
	process.exitCode = 2;
} else {
	mkdirSync(dirname(database), { recursive: true });
	const url = new URL(endpoint);
	const child = spawn(binary, ["serve"], {
		stdio: "inherit",
		env: {
			PATH: process.env.PATH,
			SEARCH_API_KEY: key,
			SEARCH_BIND: `${url.hostname}:${url.port || "80"}`,
			SEARCH_DB: database,
			SEARCH_ENGINE: process.env.AGENT_WEB_SEARCH_ENGINE || "searxng",
			SEARXNG_URL: process.env.AGENT_WEB_SEARCH_SEARXNG_URL || "http://127.0.0.1:8888/",
			RUST_LOG: process.env.RUST_LOG || "info",
		},
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => child.kill(signal));
	child.once("error", () => {
		console.error("Could not start Agent Web Search; check the binary and configuration.");
		process.exitCode = 1;
	});
	child.once("exit", (code) => {
		process.exitCode = code ?? 1;
	});
}
