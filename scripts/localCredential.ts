/**
 * Decides whether the launcher can keep using the runner credential it
 * stored on an earlier start, or has to issue a new one. Pure, so that the
 * rule is tested without a server.
 */

/** What the launcher keeps in the data directory between starts. */
export interface StoredCredential {
	readonly credentialId: string;
	readonly token: string;
}

/** The fields of a server-side credential record this decision depends on. */
export interface ListedCredential {
	readonly credentialId: string;
	readonly expiresAt: string;
	readonly revokedAt: string | null;
}

export type CredentialPlan =
	| { readonly kind: "reuse"; readonly token: string }
	/** `revokeCredentialId` is a still-valid credential being replaced; it must not stay usable. */
	| { readonly kind: "issue"; readonly revokeCredentialId: string | null };

/** Longest lifetime the API grants. */
export const CREDENTIAL_LIFETIME_DAYS = 90;
/**
 * A credential closer to expiry than this is replaced at start, so that a
 * workspace left running for weeks does not lose its runner mid-session.
 */
export const MIN_REMAINING_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * `tokenAccepted` is whether the API accepted the stored token just now. A file
 * can name an active credential and still hold a token that does not belong to
 * it (edited, truncated, or restored from another backup); reusing that would
 * leave the runner unable to authenticate on every start.
 */
export function planCredential(
	stored: StoredCredential | null,
	listed: readonly ListedCredential[],
	nowMs: number,
	tokenAccepted: boolean,
): CredentialPlan {
	if (stored === null) return { kind: "issue", revokeCredentialId: null };
	const record = listed.find((credential) => credential.credentialId === stored.credentialId);
	// Unknown to this database (e.g. the data directory was replaced) or already revoked:
	// there is nothing left to revoke.
	if (record === undefined || record.revokedAt !== null) {
		return { kind: "issue", revokeCredentialId: null };
	}
	const expiresMs = Date.parse(record.expiresAt);
	// An unreadable expiry is treated as expired (fail closed) and the record is revoked.
	const remainingMs = Number.isNaN(expiresMs) ? 0 : expiresMs - nowMs;
	if (tokenAccepted && remainingMs >= MIN_REMAINING_DAYS * DAY_MS) {
		return { kind: "reuse", token: stored.token };
	}
	return { kind: "issue", revokeCredentialId: record.credentialId };
}
