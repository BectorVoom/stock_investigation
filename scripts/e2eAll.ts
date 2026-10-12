/**
 * Runs the browser E2E suite once per engine, sequentially, each with a fresh
 * server and database. The specs are stateful (they build on one database in
 * order) and the first-run test needs a fresh database, so the engines must
 * not share a run: every Playwright invocation below starts its own
 * `webServer` (see `tests/e2e/start-worker.sh`, which wipes and rebuilds the
 * E2E state) on the port derived from `E2E_PORT`. One config file, one set of
 * specs — only `E2E_BROWSER` differs per run. Extra CLI arguments are passed
 * through to every invocation (e.g. a spec file filter).
 */
import { spawnSync } from "node:child_process";
import { baseChildEnv } from "./testEnv.ts";

const ENGINES = ["chrome", "firefox", "webkit"] as const;

const extraArgs = process.argv.slice(2);
let failed = false;
for (const engine of ENGINES) {
	console.log(`\n=== test:e2e [${engine}] ===`);
	const result = spawnSync(
		"node_modules/.bin/playwright",
		["test", "--config", "tests/e2e/playwright.config.ts", ...extraArgs],
		{
			// Explicit passthrough (finding 5): the test runner needs the
			// allowlist plus the suite's own addressing (E2E_PORT is how one
			// checkout's suite is kept off another's ports) and the engine
			// under test — never the launcher/runner settings, which each
			// spec sets explicitly through `buildChildEnv`.
			env: {
				...baseChildEnv(),
				...(process.env.E2E_PORT === undefined ? {} : { E2E_PORT: process.env.E2E_PORT }),
				E2E_BROWSER: engine,
			},
			stdio: "inherit",
		},
	);
	if (result.status !== 0) {
		failed = true;
		console.error(`test:e2e [${engine}] failed with status ${result.status}`);
		break;
	}
}
process.exit(failed ? 1 : 0);
