/** Worker bindings and variables (see infra/wrangler.jsonc). Secrets never leave this object. */
export interface Env {
	readonly DB: D1Database;
	readonly ASSETS?: Fetcher;
	/** "cloudflare-access" in production; "local-dev" is honoured for localhost requests only. */
	readonly AUTH_MODE?: string;
	/** Which local environment this Worker runs in (ADR-0011); anything else means production. */
	readonly APP_ENV?: string;
	/**
	 * Which release generation this Worker was built into (ADR-0011). Baked
	 * into the generation's Wrangler configuration at build time and reported
	 * by GET /api/v1/version; absent outside a release (development, tests).
	 */
	readonly RELEASE_GENERATION?: string;
	/** ISO build time of the release generation, baked in the same way. */
	readonly RELEASE_BUILT_AT?: string;
	/** The single owner's email address, as asserted by the identity provider. */
	readonly OWNER_EMAIL?: string;
	/** e.g. "your-team.cloudflareaccess.com". */
	readonly ACCESS_TEAM_DOMAIN?: string;
	/** The Access application's audience (AUD) tag. */
	readonly ACCESS_AUDIENCE?: string;
	/**
	 * ADR-0045: "off" stops the claim-time scheduler from adding the default
	 * companies (AAPL, MSFT, KO, 7974, 8035, 6367) for a new owner — the E2E
	 * Worker sets it so specs track only the companies they add.
	 */
	readonly EQUITY_DEFAULT_COMPANIES?: string;
}
