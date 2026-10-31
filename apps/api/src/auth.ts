import { err, ok, parseJson, type Result, thrownName } from "@research/domain";
import {
	createRemoteJWKSet,
	customFetch,
	type FetchImplementation,
	type JWTVerifyGetKey,
	jwtVerify,
} from "jose";
import { z } from "zod";
import type { Env } from "./env.ts";

/**
 * Owner authentication (section 9.1). Identity is established by Cloudflare
 * Access — an established identity-aware proxy — so this application stores no
 * password and implements no password cryptography (ADR-0002). Access issues
 * the HttpOnly/Secure session cookie and a signed JWT per request; the Worker
 * verifies that JWT itself on every request rather than trusting the edge.
 */
export type AuthFailure = "UNAUTHENTICATED" | "FORBIDDEN" | KeysUnavailable;

/** Why the team's signing keys could not be read (`AUTH_KEYS_UNAVAILABLE.detail`). */
export type KeyFetchFailure =
	| "KEY_FETCH_HTTP_ERROR"
	| "KEY_FETCH_TIMEOUT"
	| "KEY_FETCH_FAILED"
	| "KEY_SET_INVALID";

/**
 * The signing keys could not be fetched, so no token can be verified. Still
 * no access (fail closed, ARCH-017), but not "sign in": the session may be
 * fine, and signing in again would not help while the key endpoint is down.
 */
export interface KeysUnavailable {
	readonly code: "AUTH_KEYS_UNAVAILABLE";
	readonly detail: KeyFetchFailure;
	/** The key endpoint's status when it answered, unchanged (§4a); absent when it did not. */
	readonly upstreamStatus?: number;
}

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
	/** Injectable for tests: the fetch the default key set uses. */
	readonly fetch?: typeof fetch;
	/** Injectable for tests: the key fetch's deadline, headers and body together (`jose`'s 5 s by default). */
	readonly keyFetchTimeoutMs?: number;
}

/** Thrown by the key fetch so `jwtVerify`'s caller can tell a key-endpoint failure from a bad token. */
class KeysUnavailableError extends Error {
	constructor(readonly failure: KeysUnavailable) {
		super(failure.detail);
		this.name = "KeysUnavailableError";
	}
}

/** A key set larger than this is not Cloudflare's (about 5 KB live). */
const MAX_KEY_SET_BYTES = 1_048_576;
/** The shape `jose` requires of a key set, checked here so a bad set is a key failure, not a bad token. */
const keySetSchema = z.looseObject({ keys: z.array(z.looseObject({})) });

function keysUnavailable(detail: KeyFetchFailure, status?: number): KeysUnavailableError {
	return new KeysUnavailableError(
		status === undefined
			? { code: "AUTH_KEYS_UNAVAILABLE", detail }
			: { code: "AUTH_KEYS_UNAVAILABLE", detail, upstreamStatus: status },
	);
}

/** Resolves once `signal` aborts; `release` removes the listener. */
function abortedPromise(signal: AbortSignal): {
	readonly aborted: Promise<"aborted">;
	release(): void;
} {
	let release = (): void => undefined;
	const aborted = new Promise<"aborted">((resolve) => {
		if (signal.aborted) {
			resolve("aborted");
			return;
		}
		const onAbort = (): void => resolve("aborted");
		signal.addEventListener("abort", onAbort, { once: true });
		release = () => signal.removeEventListener("abort", onAbort);
	});
	return { aborted, release };
}

/**
 * The key set's text, read chunk by chunk: at most MAX_KEY_SET_BYTES and
 * within the fetch's deadline (`signal`), even when the body stalls or never
 * ends. The stream is cancelled on every early exit.
 */
async function readKeySetText(
	body: ReadableStream<Uint8Array> | null,
	signal: AbortSignal,
): Promise<string> {
	if (body === null) throw keysUnavailable("KEY_SET_INVALID");
	const reader = body.getReader();
	const deadline = abortedPromise(signal);
	const chunks: Uint8Array[] = [];
	let size = 0;
	let complete = false;
	try {
		while (true) {
			// A failed read is a failed fetch (null), told apart from the deadline below.
			const next = await Promise.race([reader.read(), deadline.aborted]).catch(() => null);
			if (next === "aborted") throw keysUnavailable("KEY_FETCH_TIMEOUT");
			if (next === null) throw keysUnavailable("KEY_FETCH_FAILED");
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_KEY_SET_BYTES) throw keysUnavailable("KEY_SET_INVALID");
			chunks.push(next.value);
		}
		complete = true;
	} finally {
		deadline.release();
		// Only releases the connection of a body we stopped reading; the outcome is already decided.
		if (!complete) await reader.cancel().catch(() => undefined);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * The fetch `jose` uses for the key set: any failure to obtain a valid set
 * throws a `KeysUnavailableError` carrying the endpoint's status, which
 * `jose` passes through unchanged.
 */
function keySetFetch(fetchImpl: typeof fetch): FetchImplementation {
	return async (url, options) => {
		let response: Response;
		try {
			response = await fetchImpl(url, options);
		} catch (error) {
			// `jose` aborts the request with AbortSignal.timeout (5 s by default).
			throw keysUnavailable(
				thrownName(error) === "TimeoutError" || options.signal.aborted
					? "KEY_FETCH_TIMEOUT"
					: "KEY_FETCH_FAILED",
			);
		}
		if (response.status !== 200) {
			// Only releases the connection; the status already decides the answer.
			await response.body?.cancel().catch(() => undefined);
			throw keysUnavailable("KEY_FETCH_HTTP_ERROR", response.status);
		}
		// A 200 is not an error status, so these failures carry none (§4a).
		const text = await readKeySetText(response.body, options.signal);
		const json = parseJson(text);
		if (!json.ok || !keySetSchema.safeParse(json.value).success) {
			throw keysUnavailable("KEY_SET_INVALID");
		}
		// `jose` reads the body again, so it gets an unread copy of the checked text.
		return new Response(text, { status: 200, headers: response.headers });
	};
}

export function createAccessAuthenticator(config: AccessConfig): OwnerAuthenticator {
	const issuer = `https://${config.teamDomain}`;
	const fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
	const keys =
		config.keys ??
		createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
			[customFetch]: keySetFetch(fetchImpl),
			...(config.keyFetchTimeoutMs === undefined
				? {}
				: { timeoutDuration: config.keyFetchTimeoutMs }),
		});
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
		} catch (error) {
			// The keys could not be read: still no access, but the session is not the problem.
			if (error instanceof KeysUnavailableError) return err(error.failure);
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
