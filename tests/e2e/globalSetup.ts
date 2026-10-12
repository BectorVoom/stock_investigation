import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeDir } from "../../scripts/releaseOps.ts";
import { baseChildEnv, ISOLATION_RECORD_ENV_VAR } from "../../scripts/testEnv.ts";

/**
 * Starts the E2E runner process once the Worker is up (Playwright starts
 * `webServer` first) and stops it when the run ends.
 *
 * Isolation guard (finding 15, task 23b): the old modification-time snapshot
 * blamed the tests for the owner's own activity while an owner instance kept
 * writing to its database, so it is gone. Isolation is enforced directly
 * instead —
 * - every suite that starts a launcher, a runner or a build constructs its
 *   child environment through `scripts/testEnv.ts` (explicit allowlist plus
 *   throwaway values, never the caller's environment), and `buildChildEnv`
 *   records every configured directory in TEST_ISOLATION_RECORD;
 * - this teardown asserts THAT: every recorded directory canonicalises
 *   outside the repository's operational directories (`data/`, `data-dev/`,
 *   `release/`, `release.previous/`, checked with the canonical-path
 *   validation from task 23a — symlinks, case variants and containment),
 * - plus a check that none of the operational directories was CREATED by
 *   the suite when it did not exist before.
 */
const OPERATIONAL = ["data", "data-dev", "release", "release.previous"] as const;

function operationalAbs(repoRoot: string): string[] {
	return OPERATIONAL.map((name) => resolve(repoRoot, name));
}

function isOutside(childCanonical: string, parentCanonical: string): boolean {
	return childCanonical !== parentCanonical && !childCanonical.startsWith(`${parentCanonical}/`);
}

export default function globalSetup(): () => Promise<void> {
	const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
	const operational = operationalAbs(repoRoot);
	const existedBefore = new Map(
		OPERATIONAL.map((name) => [name, existsSync(join(repoRoot, name))]),
	);
	// Fresh audit record for this run; specs append through `buildChildEnv`.
	const recordFile = join(tmpdir(), `research-e2e-isolation-${process.pid}-${Date.now()}.log`);
	process.env[ISOLATION_RECORD_ENV_VAR] = recordFile;
	const runner = spawn("node", ["tests/e2e/runnerHarness.ts"], {
		cwd: repoRoot,
		// Explicit passthrough (finding 5): the harness is a test runner, so
		// it gets the allowlist plus only what its seams need — the suite's
		// addressing and the documented live switches, nothing else from the
		// caller's environment.
		env: {
			...baseChildEnv(),
			...(process.env.E2E_PORT === undefined ? {} : { E2E_PORT: process.env.E2E_PORT }),
			...(process.env.RUN_LIVE_OPENCODE === undefined
				? {}
				: { RUN_LIVE_OPENCODE: process.env.RUN_LIVE_OPENCODE }),
			...(process.env.OPENCODE_MODEL === undefined
				? {}
				: { OPENCODE_MODEL: process.env.OPENCODE_MODEL }),
		},
		stdio: ["ignore", "inherit", "inherit"],
	});
	return async () => {
		if (runner.exitCode === null) {
			const exited = new Promise<void>((resolve) => runner.once("exit", () => resolve()));
			runner.kill("SIGTERM");
			await exited;
		}
		const failures: string[] = [];
		// No operational directory may have been CREATED by the suite.
		for (const name of OPERATIONAL) {
			if (!existedBefore.get(name) && existsSync(join(repoRoot, name))) {
				failures.push(
					`the suite created the repository-root ${name}/, which did not exist before the run. ` +
						`Specs must use throwaway OS-temp directories through scripts/testEnv.ts.`,
				);
			}
		}
		// Every directory a test process was configured with must be outside
		// the operational directories (canonical check, task 23a).
		let recorded: string[] = [];
		try {
			recorded = readFileSync(recordFile, "utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line !== "");
		} catch {
			recorded = [];
		}
		const operationalCanonical = operational.map((dir) => canonicalizeDir(repoRoot, dir).canonical);
		for (const dir of new Set(recorded)) {
			const canonical = canonicalizeDir(repoRoot, dir).canonical;
			for (let index = 0; index < OPERATIONAL.length; index += 1) {
				const guard = operationalCanonical[index];
				const name = OPERATIONAL[index];
				if (guard !== undefined && name !== undefined && !isOutside(canonical, guard)) {
					failures.push(
						`a test process was configured with ${dir}, which is inside (or is) the ` +
							`repository-root ${name}/. Specs must use throwaway OS-temp directories.`,
					);
				}
			}
		}
		try {
			rmSync(recordFile, { force: true });
		} catch {
			// Best effort.
		}
		delete process.env[ISOLATION_RECORD_ENV_VAR];
		if (failures.length > 0) {
			throw new Error(`E2E isolation guard (finding 15):\n- ${failures.join("\n- ")}`);
		}
	};
}
