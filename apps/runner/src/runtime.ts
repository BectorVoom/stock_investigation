/**
 * Runtime guard (Defect 0): the runner's pinned HTTPS fetcher never completes
 * under Bun's Node compatibility layer, so the runner must refuse to start
 * anywhere but Node. Detection is `process.versions.bun`; the helpers take
 * the versions object explicitly so the mapping is unit-testable without
 * starting a process.
 */

/** The name logged as `runtime` in the runner's first log line. */
export function runtimeName(versions: Readonly<Record<string, string | undefined>>): string {
	return versions.bun === undefined ? "node" : "bun";
}

/** True for any runtime that is not Node (today: only Bun is observed). */
export function isUnsupportedRuntime(
	versions: Readonly<Record<string, string | undefined>>,
): boolean {
	return versions.bun !== undefined;
}
