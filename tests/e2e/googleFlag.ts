import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * While this file exists, the scripted Google handler of the E2E runner
 * fails every `google-calendar` job with `GOOGLE_NOT_CONFIGURED` (the
 * unconfigured runner, honestly). A test creates it to cover the fixed
 * failure sentence, then removes it. E2E-only: production never reads it.
 *
 * The path is derived from the repository, never from `os.tmpdir()`: the
 * runner harness is spawned with an allowlisted environment that carries no
 * `TMPDIR`, so its temporary directory differs from the test process's on
 * macOS and the two would look at different files (same reason
 * `marketFailureFile` lives under `test-results/`).
 */
export function googleUnconfiguredFlagFile(): string {
	return join(REPO_ROOT, "test-results", "e2e-google-unconfigured");
}
