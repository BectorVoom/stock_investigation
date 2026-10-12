import type { ProcessRunner } from "./processRunner.ts";

export interface ProviderEnvironment {
	readonly processRunner: ProcessRunner;
	readonly fetch: typeof fetch;
	/** The runner's own environment, read-only. Adapters pick an explicit allowlist from it. */
	readonly env: Readonly<Record<string, string | undefined>>;
}

/** Variables every CLI needs to locate itself, its home and a temp directory. */
export const BASE_CHILD_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TERM",
] as const;

/**
 * Builds a child's complete environment from an explicit allowlist (AGT-003,
 * SEC-005): the base keys plus the provider's own documented variables. Runner
 * secrets, Cloudflare credentials and other providers' API keys are never
 * forwarded because they are simply not on any list.
 */
export function buildChildEnv(
	source: Readonly<Record<string, string | undefined>>,
	providerKeys: readonly string[],
): Record<string, string> {
	const childEnv: Record<string, string> = {};
	for (const key of [...BASE_CHILD_ENV_KEYS, ...providerKeys]) {
		const value = source[key];
		if (value !== undefined && value !== "") childEnv[key] = value;
	}
	return childEnv;
}

/** Directory for commands that need no workspace (version and auth-status probes). */
export function probeWorkingDirectory(
	source: Readonly<Record<string, string | undefined>>,
): string {
	return source.TMPDIR ?? source.HOME ?? "/";
}
