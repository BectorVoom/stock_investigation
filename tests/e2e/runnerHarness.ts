/**
 * E2E runner entry point, started by `globalSetup.ts` and by the specs that
 * need a second runner. `RESEARCH_RUNNER` (default from `DEFAULT_RUNNER_KIND`, ADR-0030) picks
 * the implementation under test:
 *
 * - `node`: `nodeRunnerHarness.ts`, the real TypeScript runner loop with the
 *   scripted agent and fixture fetchers (unchanged behaviour);
 * - `rust`: `rustRunnerHarness.ts`, a thin wrapper that builds and spawns the
 *   Rust E2E runner (`research-runner-e2e`), which carries the same seams.
 *
 * An unknown value is refused rather than guessed, so a typo can never
 * silently test the Node runner.
 */
import { parseRunnerKind } from "../../scripts/launchPlan.ts";

const kind = parseRunnerKind(process.env.RESEARCH_RUNNER);
if (!kind.ok) {
	process.stderr.write(`${kind.error.message}\n`);
	process.exit(2);
}
await import(kind.value === "rust" ? "./rustRunnerHarness.ts" : "./nodeRunnerHarness.ts");
