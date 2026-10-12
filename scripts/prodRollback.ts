/**
 * Moves the production pointer to the previous release generation (ADR-0011):
 *
 *     bun run prod:rollback
 *
 * Only the pointer moves (an atomic temp-file + rename); nothing is deleted,
 * so a failure cannot leave no release at all (finding 4). Restart
 * production afterwards (`bun run prod:start`) for the restored generation
 * to take effect — a running instance keeps serving the generation it
 * started with. Refuses when there is no previous generation with a valid
 * manifest. Serialised against builds and pruning through the release lock.
 */
import { resolve } from "node:path";
import { DEFAULT_DEV_DATA_DIR, DEFAULT_PROD_DATA_DIR } from "./launchPlan.ts";
import {
	acquireReleaseLock,
	previousDirFromEnv,
	releaseDirFromEnv,
	releaseReleaseLock,
	rollbackRelease,
	validateDirectorySet,
} from "./releaseOps.ts";

function nonEmptyEnv(name: string, fallback: string): string {
	const raw = process.env[name]?.trim() ?? "";
	return raw === "" ? fallback : raw;
}

const repoRoot = process.cwd();
const releaseDir = releaseDirFromEnv(process.env);

// The whole directory set is validated before anything else (finding 2),
// exactly as in `prod:build`: a mispointed setting refuses instead of acting.
const validated = validateDirectorySet(repoRoot, [
	{
		label: "production data directory",
		dir: nonEmptyEnv("RESEARCH_DATA_DIR", DEFAULT_PROD_DATA_DIR),
	},
	{
		label: "development data directory",
		dir: nonEmptyEnv("RESEARCH_DEV_DATA_DIR", DEFAULT_DEV_DATA_DIR),
	},
	{ label: "release area", dir: releaseDir },
	{ label: "previous release directory", dir: previousDirFromEnv(process.env) },
]);
if (!validated.ok) {
	console.error(`prod:rollback: ${validated.error}`);
	process.exit(1);
}
const areaAbs = validated.value.canonical[2]?.canonical ?? resolve(repoRoot, releaseDir);

const locked = acquireReleaseLock(areaAbs);
if (!locked.ok) {
	console.error(`prod:rollback: ${locked.error}`);
	process.exit(1);
}
try {
	const result = rollbackRelease(repoRoot, releaseDir);
	if (!result.ok) {
		console.error(`prod:rollback: ${result.error}`);
		process.exit(1);
	}
	console.log(
		`\n✔ the release pointer now names generation ${result.value.activated} (was ${result.value.previous}).`,
	);
	console.log("  restart production (`bun run prod:start`) for it to take effect.");
} finally {
	releaseReleaseLock(areaAbs);
}
