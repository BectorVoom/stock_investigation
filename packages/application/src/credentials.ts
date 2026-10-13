import type { RunnerCredential } from "@research/contracts";
import { ok } from "@research/domain";
import { fail, type UseCaseResult } from "./errors.ts";
import type {
	AuditLog,
	Clock,
	Hasher,
	IdGenerator,
	RunnerCredentialRepository,
	SecretGenerator,
} from "./ports.ts";
import type { RunnerIdentity } from "./runnerJobs.ts";

const DAY_MS = 86_400_000;
const MAX_LIVE_CREDENTIALS = 5;

export interface IssuedCredential {
	readonly credential: RunnerCredential;
	/** Shown to the owner exactly once; only its hash is stored. */
	readonly token: string;
}

export interface RunnerCredentialServiceDeps {
	readonly credentials: RunnerCredentialRepository;
	readonly clock: Clock;
	readonly ids: IdGenerator;
	readonly hasher: Hasher;
	readonly secrets: SecretGenerator;
	readonly audit: AuditLog;
}

/**
 * Runner bearer credentials (section 10): separately scoped from the owner
 * session, expiring, renewable by the runner and revocable by the owner.
 * Tokens are 256-bit random secrets, so a plain SHA-256 lookup hash suffices —
 * there is no low-entropy password to stretch.
 */
export function createRunnerCredentialService(deps: RunnerCredentialServiceDeps) {
	const isLive = (credential: RunnerCredential, now: string) =>
		credential.revokedAt === null && credential.expiresAt > now;

	return {
		list: (ownerId: string): Promise<readonly RunnerCredential[]> => deps.credentials.list(ownerId),

		async issue(
			ownerId: string,
			label: string,
			expiresInDays: number,
		): Promise<UseCaseResult<IssuedCredential>> {
			const now = deps.clock.nowIso();
			const live = (await deps.credentials.list(ownerId)).filter((c) => isLive(c, now));
			if (live.length >= MAX_LIVE_CREDENTIALS) {
				return fail("CONFLICT", "Revoke an existing runner credential before issuing another.");
			}
			const token = deps.secrets.newSecret();
			const credential: RunnerCredential = {
				credentialId: deps.ids.newId("rc"),
				label,
				createdAt: now,
				expiresAt: new Date(deps.clock.nowMs() + expiresInDays * DAY_MS).toISOString(),
				revokedAt: null,
				lastUsedAt: null,
			};
			await deps.credentials.insert(ownerId, credential, await deps.hasher.sha256Hex(token));
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "runner-credential.issue",
				resource: credential.credentialId,
				detail: "",
				at: now,
			});
			return ok({ credential, token });
		},

		async revoke(ownerId: string, credentialId: string): Promise<UseCaseResult<void>> {
			const now = deps.clock.nowIso();
			const revoked = await deps.credentials.revoke(ownerId, credentialId, now);
			if (!revoked) return fail("NOT_FOUND", "Runner credential not found.");
			await deps.audit.record({
				ownerId,
				actor: "owner",
				action: "runner-credential.revoke",
				resource: credentialId,
				detail: "",
				at: now,
			});
			return ok(undefined);
		},

		/** Resolves a bearer token to a runner identity, or null when it is unknown, expired or revoked. */
		async authenticate(token: string): Promise<RunnerIdentity | null> {
			const credential = await deps.credentials.authenticate(
				await deps.hasher.sha256Hex(token),
				deps.clock.nowIso(),
			);
			return credential === null
				? null
				: { ownerId: credential.ownerId, credentialId: credential.credentialId };
		},

		/** Lets a runner swap its token for a fresh one before expiry; the old token stops working. */
		async renew(
			runner: RunnerIdentity,
			expiresInDays: number,
		): Promise<UseCaseResult<IssuedCredential>> {
			const token = deps.secrets.newSecret();
			const credential = await deps.credentials.rotate(
				runner.ownerId,
				runner.credentialId,
				await deps.hasher.sha256Hex(token),
				new Date(deps.clock.nowMs() + expiresInDays * DAY_MS).toISOString(),
			);
			if (credential === null)
				return fail("UNAUTHENTICATED", "Runner credential is no longer valid.");
			return ok({ credential, token });
		},
	};
}

export type RunnerCredentialService = ReturnType<typeof createRunnerCredentialService>;
