import { err, ok, type Result } from "@research/domain";
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";
import type { Env } from "./env.ts";

/**
 * Owner authentication (section 9.1). Identity is established by Cloudflare
 * Access — an established identity-aware proxy — so this application stores no
 * password and implements no password cryptography (ADR-0002). Access issues
 * the HttpOnly/Secure session cookie and a signed JWT per request; the Worker
 * verifies that JWT itself on every request rather than trusting the edge.
 */
export type AuthFailure = "UNAUTHENTICATED" | "FORBIDDEN";

export interface OwnerIdentity {
	readonly ownerId: string;
	readonly authMode: "cloudflare-access" | "local-dev";
}

export type OwnerAuthenticator = (request: Request) => Promise<Result<OwnerIdentity, AuthFailure>>;

const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function ownerIdFromEmail(email: string): string {
	return email.trim().toLowerCase();
}

export interface AccessConfig {
	readonly teamDomain: string;
	readonly audience: string;
	readonly ownerEmail: string;
	/** Injectable for tests; defaults to the team's published signing keys. */
	readonly keys?: JWTVerifyGetKey;
}

export function createAccessAuthenticator(config: AccessConfig): OwnerAuthenticator {
	const issuer = `https://${config.teamDomain}`;
	const keys = config.keys ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
	const owner = ownerIdFromEmail(config.ownerEmail);
	return async (request) => {
		const token = request.headers.get(ACCESS_JWT_HEADER);
		if (token === null || token === "") return err("UNAUTHENTICATED");
		let email: unknown;
		try {
			const verified = await jwtVerify(token, keys, {
				issuer,
				audience: config.audience,
				algorithms: ["RS256"],
			});
			email = verified.payload.email;
		} catch {
			// Expired, malformed, wrong audience/issuer or bad signature: all are simply "not signed in".
			return err("UNAUTHENTICATED");
		}
		// A valid Access identity that is not the owner (or a service token with no email) is refused.
		if (typeof email !== "string" || ownerIdFromEmail(email) !== owner) return err("FORBIDDEN");
		return ok({ ownerId: owner, authMode: "cloudflare-access" });
	};
}

/**
 * Development-only identity. It is honoured solely for requests addressed to a
 * loopback hostname, which a deployed Worker never receives, so setting
 * AUTH_MODE=local-dev in production by mistake does not open the API.
 */
export function createLocalDevAuthenticator(ownerEmail: string): OwnerAuthenticator {
	const owner = ownerIdFromEmail(ownerEmail);
	return async (request) => {
		if (!LOCAL_HOSTNAMES.has(new URL(request.url).hostname)) return err("UNAUTHENTICATED");
		return ok({ ownerId: owner, authMode: "local-dev" });
	};
}

const denyAll: OwnerAuthenticator = async () => err("UNAUTHENTICATED");

/**
 * One authenticator per distinct configuration, kept for the life of the
 * isolate. The Access authenticator holds the team's signing-key cache; building
 * it per request would refetch the keys on every poll and would turn a brief
 * outage of the key endpoint into failed logins.
 */
const authenticators = new Map<string, OwnerAuthenticator>();

export function ownerAuthenticatorFor(env: Env): OwnerAuthenticator {
	const key = JSON.stringify([
		env.AUTH_MODE ?? "",
		env.OWNER_EMAIL ?? "",
		env.ACCESS_TEAM_DOMAIN ?? "",
		env.ACCESS_AUDIENCE ?? "",
	]);
	let authenticator = authenticators.get(key);
	if (authenticator === undefined) {
		authenticator = createOwnerAuthenticator(env);
		authenticators.set(key, authenticator);
	}
	return authenticator;
}

/** Selects the authenticator from configuration; anything incomplete or unknown denies (ARCH-017). */
export function createOwnerAuthenticator(env: Env): OwnerAuthenticator {
	const ownerEmail = env.OWNER_EMAIL?.trim() ?? "";
	if (env.AUTH_MODE === "local-dev") {
		return createLocalDevAuthenticator(ownerEmail === "" ? "owner@localhost" : ownerEmail);
	}
	if (env.AUTH_MODE === "cloudflare-access") {
		const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim() ?? "";
		const audience = env.ACCESS_AUDIENCE?.trim() ?? "";
		if (ownerEmail === "" || teamDomain === "" || audience === "") return denyAll;
		return createAccessAuthenticator({ teamDomain, audience, ownerEmail });
	}
	return denyAll;
}
