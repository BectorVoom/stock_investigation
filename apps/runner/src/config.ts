import { z } from "zod";
import {
	DEFAULT_TWELVE_DATA_DAILY_LIMIT,
	DEFAULT_TWELVE_DATA_REQUESTS_PER_MINUTE,
	TWELVE_DATA_DAILY_LIMIT_MAX,
	TWELVE_DATA_REQUESTS_PER_MINUTE_MAX,
	TWELVE_DATA_REQUESTS_PER_MINUTE_MIN,
} from "./marketPacing.ts";

/**
 * Runner configuration, read once from the process environment. Secrets stay
 * in this object: they are never logged, never placed in prompts and never
 * forwarded to agent CLIs (which get their own allowlisted environment).
 */
/** One message for every refusal of TWELVE_DATA_DAILY_LIMIT; zod's own would not name the setting. */
const DAILY_LIMIT_PROBLEM = `TWELVE_DATA_DAILY_LIMIT must be a whole number from 0 to ${TWELVE_DATA_DAILY_LIMIT_MAX} (0: no daily limit)`;

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
	/** FRED API key for Home market data; without it FRED series are unavailable. */
	fredApiKey: z.string().min(1).nullable(),
	/** Twelve Data API key for Home market data; without it Twelve Data series are unavailable. */
	twelveDataApiKey: z.string().min(1).nullable(),
	/** Finnhub API key for earnings dates (FR-018); without it US stocks are unavailable. */
	finnhubApiKey: z.string().min(1).nullable(),
	/**
	 * Tavily API key for `web.search` (ADR-0025); without it only `news.search`
	 * is offered. It travels as `Authorization: Bearer <key>`, so it must fit the
	 * fetcher's header rule (printable ASCII, no spaces).
	 */
	tavilyApiKey: z
		.string()
		.regex(
			/^[\x21-\x7e]{8,280}$/,
			"TAVILY_API_KEY must be 8–280 printable characters without spaces",
		)
		.nullable(),
	/**
	 * EDINET API v2 subscription key (ADR-0045 §9); without it Japanese
	 * companies' financial syncs fail with FINANCIAL_SOURCE_NOT_CONFIGURED.
	 * It travels as the `Subscription-Key` query parameter, so it must be
	 * printable ASCII without spaces; a URL carrying it is never logged.
	 */
	edinetApiKey: z
		.string()
		.regex(
			/^[\x21-\x7e]{8,200}$/,
			"EDINET_API_KEY must be 8–200 printable characters without spaces",
		)
		.nullable(),
	/**
	 * Google OAuth "Desktop app" client (FR-019). Without both, every
	 * google-calendar job fails honestly with GOOGLE_NOT_CONFIGURED; the
	 * values never leave this object (never logged, never sent to the API).
	 */
	googleOAuthClientId: z.string().min(1).nullable(),
	googleOAuthClientSecret: z.string().min(1).nullable(),
	/** Runner-side refresh-token file (mode 0600, beside runner-credential.json; the plan sets it). */
	googleTokenFile: z.string().min(1),
	/** Twelve Data request starts per minute (free plan: 8); FRED is paced at 100 per minute. */
	twelveDataRequestsPerMinute: z
		.number()
		.int()
		.min(TWELVE_DATA_REQUESTS_PER_MINUTE_MIN)
		.max(TWELVE_DATA_REQUESTS_PER_MINUTE_MAX),
	/**
	 * Twelve Data request starts per UTC day (Basic plan: 800, the default);
	 * 0 for a paid plan, which has no daily limit.
	 */
	twelveDataDailyLimit: z
		.number({ error: DAILY_LIMIT_PROBLEM })
		.int({ error: DAILY_LIMIT_PROBLEM })
		.min(0, { error: DAILY_LIMIT_PROBLEM })
		.max(TWELVE_DATA_DAILY_LIMIT_MAX, { error: DAILY_LIMIT_PROBLEM }),
});

export type RunnerConfig = z.infer<typeof configSchema>;

export type ConfigResult =
	| { readonly ok: true; readonly value: RunnerConfig }
	| { readonly ok: false; readonly problems: readonly string[] };

const blankToNull = (value: string | undefined): string | null => {
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? null : trimmed;
};

/** Default when blank; otherwise up to 7 ASCII digits, or NaN for zod to refuse. */
const dailyLimit = (value: string | undefined): number => {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") return DEFAULT_TWELVE_DATA_DAILY_LIMIT;
	return /^\d{1,7}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
};

/** Free-plan default; blank means "unset", anything else must be an integer for zod to judge. */
const requestsPerMinute = (value: string | undefined): number => {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") return DEFAULT_TWELVE_DATA_REQUESTS_PER_MINUTE;
	return /^\d{1,3}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
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
		fredApiKey: blankToNull(env.FRED_API_KEY),
		twelveDataApiKey: blankToNull(env.TWELVE_DATA_API_KEY),
		finnhubApiKey: blankToNull(env.FINNHUB_API_KEY),
		tavilyApiKey: blankToNull(env.TAVILY_API_KEY),
		edinetApiKey: blankToNull(env.EDINET_API_KEY),
		googleOAuthClientId: blankToNull(env.GOOGLE_OAUTH_CLIENT_ID),
		googleOAuthClientSecret: blankToNull(env.GOOGLE_OAUTH_CLIENT_SECRET),
		googleTokenFile:
			env.GOOGLE_TOKEN_FILE?.trim() === "" || env.GOOGLE_TOKEN_FILE === undefined
				? "google-token.json"
				: env.GOOGLE_TOKEN_FILE.trim(),
		twelveDataRequestsPerMinute: requestsPerMinute(env.TWELVE_DATA_REQUESTS_PER_MINUTE),
		twelveDataDailyLimit: dailyLimit(env.TWELVE_DATA_DAILY_LIMIT),
	});
	if (parsed.success) return { ok: true, value: parsed.data };
	// Report which settings are wrong without echoing their values.
	return { ok: false, problems: parsed.error.issues.map((issue) => issue.message) };
}
