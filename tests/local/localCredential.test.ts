import { describe, expect, it } from "vitest";
import {
	type ListedCredential,
	MIN_REMAINING_DAYS,
	planCredential,
	type StoredCredential,
} from "../../scripts/localCredential.ts";

const NOW = Date.parse("2026-10-12T00:00:00.000Z");
const DAY_MS = 86_400_000;
const stored: StoredCredential = { credentialId: "rc_1", token: "rk_stored" };

function listed(overrides: Partial<ListedCredential> = {}): ListedCredential {
	return {
		credentialId: "rc_1",
		expiresAt: new Date(NOW + 60 * DAY_MS).toISOString(),
		revokedAt: null,
		...overrides,
	};
}

describe("planCredential", () => {
	it("issues a credential on the first start", () => {
		expect(planCredential(null, [], NOW, false)).toEqual({
			kind: "issue",
			revokeCredentialId: null,
		});
	});

	it("reuses a stored credential that is active and far from expiry", () => {
		expect(
			planCredential(stored, [listed({ credentialId: "rc_other" }), listed()], NOW, true),
		).toEqual({
			kind: "reuse",
			token: "rk_stored",
		});
	});

	it("reuses at exactly the minimum remaining lifetime and replaces just below it", () => {
		const boundary = NOW + MIN_REMAINING_DAYS * DAY_MS;
		expect(
			planCredential(stored, [listed({ expiresAt: new Date(boundary).toISOString() })], NOW, true)
				.kind,
		).toBe("reuse");
		expect(
			planCredential(
				stored,
				[listed({ expiresAt: new Date(boundary - 1).toISOString() })],
				NOW,
				true,
			),
		).toEqual({ kind: "issue", revokeCredentialId: "rc_1" });
	});

	it("replaces and revokes an expired credential", () => {
		expect(
			planCredential(
				stored,
				[listed({ expiresAt: new Date(NOW - DAY_MS).toISOString() })],
				NOW,
				true,
			),
		).toEqual({ kind: "issue", revokeCredentialId: "rc_1" });
	});

	it("issues without revoking when the stored credential was revoked by the owner", () => {
		expect(
			planCredential(
				stored,
				[listed({ revokedAt: new Date(NOW - DAY_MS).toISOString() })],
				NOW,
				true,
			),
		).toEqual({ kind: "issue", revokeCredentialId: null });
	});

	it("issues without revoking when the database no longer knows the credential", () => {
		expect(planCredential(stored, [listed({ credentialId: "rc_other" })], NOW, true)).toEqual({
			kind: "issue",
			revokeCredentialId: null,
		});
	});

	it("replaces and revokes an active credential whose stored token the API rejected", () => {
		expect(planCredential(stored, [listed()], NOW, false)).toEqual({
			kind: "issue",
			revokeCredentialId: "rc_1",
		});
	});

	it("treats an unreadable expiry as expired", () => {
		expect(planCredential(stored, [listed({ expiresAt: "not a date" })], NOW, true)).toEqual({
			kind: "issue",
			revokeCredentialId: "rc_1",
		});
	});
});
