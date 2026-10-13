import type { Clock, Hasher, IdGenerator, SecretGenerator } from "@research/application";

/**
 * Environment adapters built only on web-standard globals (`crypto`, `Date`),
 * so the same implementations serve the Worker and the Node runner.
 */
export const systemClock: Clock = {
	nowMs: () => Date.now(),
	nowIso: () => new Date().toISOString(),
};

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export const randomIdGenerator: IdGenerator = {
	newId: (prefix) => `${prefix}_${randomHex(12)}`,
};

export const webCryptoHasher: Hasher = {
	sha256Hex: async (text) => {
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
		return toHex(new Uint8Array(digest));
	},
};

export const randomSecretGenerator: SecretGenerator = {
	// 32 random bytes = 256 bits; hex keeps the token header-safe.
	newSecret: () => `rk_${randomHex(32)}`,
};

/**
 * Feed-token generator with its own prefix (FR-018 item 14): calendar
 * subscription tokens live in URL paths and are looked up by hash in
 * `calendar_feeds`, while `rk_` secrets authenticate the runner — the prefix
 * keeps the two shapes distinguishable in code, tests and log triage. Same
 * narrow `SecretGenerator` port (no widening): 32 random bytes, hex body, so
 * every token-shape check (`FEED_TOKEN_PATTERN`, the contract regexes) is
 * unchanged. Wired into the watchlist service only; runner credentials keep
 * `randomSecretGenerator`.
 */
export const randomFeedTokenGenerator: SecretGenerator = {
	newSecret: () => `cal_${randomHex(32)}`,
};
