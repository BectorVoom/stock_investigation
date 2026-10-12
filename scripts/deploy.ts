/**
 * Optional deployment to Cloudflare. The workspace runs locally by default
 * (`bun run prod`); nothing requires this script.
 *
 *     bun run deploy
 *
 * It deploys the `production` environment of infra/wrangler.jsonc. Steps: check the Wrangler login, make sure the D1 database exists and its id
 * is in infra/wrangler.jsonc, build the SPA, apply migrations, deploy the
 * Worker. Every step that changes something on Cloudflare is printed before it
 * runs. Safe to re-run: an existing database is reused and applied migrations
 * are skipped.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";

const CONFIG = "infra/wrangler.jsonc";
const ENVIRONMENT = "production";
const DATABASE_NAME = "research";
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
const WRANGLER = "node_modules/.bin/wrangler";

function fail(message: string): never {
	console.error(`deploy: ${message}`);
	process.exit(1);
}

/** Runs a command with its output shown; stops the deployment if it fails. */
function run(label: string, command: string, args: readonly string[]): void {
	console.log(`\n▶ ${label}`);
	const result = spawnSync(command, args, { stdio: "inherit" });
	if (result.status !== 0) fail(`step failed: ${label}`);
}

/** Runs a Wrangler command and returns its stdout, or null if it failed. */
function capture(args: readonly string[]): string | null {
	const result = spawnSync(WRANGLER, args, { encoding: "utf8" });
	return result.status === 0 ? result.stdout : null;
}

const databaseListSchema = z.array(z.looseObject({ name: z.string(), uuid: z.string() }));

function findDatabaseId(): string | null {
	const listed = capture(["d1", "list", "--json"]);
	if (listed === null) fail("could not list D1 databases");
	const parsed = databaseListSchema.safeParse(JSON.parse(listed));
	if (!parsed.success) fail("unexpected output from `wrangler d1 list --json`");
	return parsed.data.find((database) => database.name === DATABASE_NAME)?.uuid ?? null;
}

if (capture(["whoami"]) === null) {
	fail(
		"not logged in to Cloudflare. Run `bunx wrangler login` (or set CLOUDFLARE_API_TOKEN) and retry.",
	);
}

const config = readFileSync(CONFIG, "utf8");
if (config.includes(PLACEHOLDER_ID)) {
	let databaseId = findDatabaseId();
	if (databaseId === null) {
		run(`create D1 database "${DATABASE_NAME}"`, WRANGLER, ["d1", "create", DATABASE_NAME]);
		databaseId = findDatabaseId();
	}
	if (databaseId === null) fail(`D1 database "${DATABASE_NAME}" was not found after creation`);
	writeFileSync(CONFIG, config.replace(PLACEHOLDER_ID, databaseId));
	console.log(`\n✔ wrote database id ${databaseId} to ${CONFIG} (commit this change)`);
}

for (const name of ["OWNER_EMAIL", "ACCESS_TEAM_DOMAIN", "ACCESS_AUDIENCE"]) {
	if (new RegExp(`"${name}":\\s*""`).test(readFileSync(CONFIG, "utf8"))) {
		console.warn(
			`\n⚠ ${name} is empty in ${CONFIG}: the deployed API will refuse every request until owner sign-in is configured (docs/OPERATIONS.md).`,
		);
	}
}

run("build the SPA", "node_modules/.bin/vite", ["build", "--config", "apps/web/vite.config.ts"]);
run("apply D1 migrations (remote)", WRANGLER, [
	"d1",
	"migrations",
	"apply",
	DATABASE_NAME,
	"--remote",
	"--env",
	ENVIRONMENT,
	"--config",
	CONFIG,
]);
run("deploy the Worker and static assets", WRANGLER, [
	"deploy",
	"--env",
	ENVIRONMENT,
	"--config",
	CONFIG,
]);
console.log("\n✔ deployed");
