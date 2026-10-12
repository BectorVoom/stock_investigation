import { z } from "zod";

/**
 * Runner configuration, read once from the process environment. Secrets stay
 * in this object: they are never logged, never placed in prompts and never
 * forwarded to agent CLIs (which get their own allowlisted environment).
 */
const configSchema = z.object({
	/** Base URL of the deployed Worker, e.g. https://research.example.workers.dev */
	apiUrl: z.string().refine(
		(value) => {
			if (!URL.canParse(value)) return false;
			const url = new URL(value);
			const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
			// Plain HTTP would expose the runner token; allow it only for a local dev Worker.
			return url.protocol === "https:" || (url.protocol === "http:" && loopback);
		},
		{ message: "RESEARCH_API_URL must be https (http is allowed for localhost only)" },
	),
	runnerToken: z.string().regex(/^[A-Za-z0-9_]{20,200}$/, "RUNNER_TOKEN is missing or malformed"),
	/** Optional Cloudflare Access service token, when the runner path sits behind Access. */
	accessClientId: z.string().min(1).nullable(),
	accessClientSecret: z.string().min(1).nullable(),
	/** SEC fair-access policy requires a contact User-Agent; without it SEC tools are disabled. */
	secUserAgent: z.string().min(8).max(200).nullable(),
	/** Owner opt-in to backends whose own tools could not be verified as disabled. Default: refuse. */
	allowUnverifiedToolIsolation: z.boolean(),
	scratchRoot: z.string().min(1).nullable(),
	/** Where retrieved public pages are archived; without it web page retrieval is disabled. */
	pagesDirectory: z.string().min(1).nullable(),
});

export type RunnerConfig = z.infer<typeof configSchema>;

export type ConfigResult =
	| { readonly ok: true; readonly value: RunnerConfig }
	| { readonly ok: false; readonly problems: readonly string[] };

const blankToNull = (value: string | undefined): string | null => {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
};

export function loadConfig(env: Readonly<Record<string, string | undefined>>): ConfigResult {
	const parsed = configSchema.safeParse({
		apiUrl: env.RESEARCH_API_URL?.trim() ?? "",
		runnerToken: env.RUNNER_TOKEN?.trim() ?? "",
		accessClientId: blankToNull(env.CF_ACCESS_CLIENT_ID),
		accessClientSecret: blankToNull(env.CF_ACCESS_CLIENT_SECRET),
		secUserAgent: blankToNull(env.SEC_USER_AGENT),
		allowUnverifiedToolIsolation: env.ALLOW_UNVERIFIED_TOOL_ISOLATION === "1",
		scratchRoot: blankToNull(env.RUNNER_SCRATCH_ROOT),
		pagesDirectory: blankToNull(env.RUNNER_PAGES_DIR),
	});
	if (parsed.success) return { ok: true, value: parsed.data };
	// Report which settings are wrong without echoing their values.
	return { ok: false, problems: parsed.error.issues.map((issue) => issue.message) };
}
