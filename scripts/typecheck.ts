/**
 * Strict typecheck of every project. Each project is checked against the
 * globals of the runtime it actually ships to (Worker, Node, browser, or the
 * runtime-neutral WebWorker lib), which is what catches Node-only code leaking
 * into the Worker bundle at compile time.
 */
import { spawnSync } from "node:child_process";

const PROJECTS = [
	"packages/domain",
	"packages/contracts",
	"packages/agent-core",
	"packages/application",
	"packages/effects",
	"packages/i18n",
	"packages/i18n/tsconfig.neutral.json",
	"packages/ui-registry",
	"packages/widget-grid",
	"packages/widget-grid/tsconfig.neutral.json",
	"packages/adapters",
	"packages/adapters/tsconfig.worker.json",
	"apps/api",
	"apps/runner",
	"apps/mcp",
	"apps/web",
	"tests",
];

let failed = false;
for (const project of PROJECTS) {
	const result = spawnSync("node_modules/.bin/tsc", ["--noEmit", "-p", project], {
		stdio: "inherit",
	});
	if (result.status !== 0) {
		failed = true;
		console.error(`typecheck failed: ${project}`);
	}
}
process.exit(failed ? 1 : 0);
