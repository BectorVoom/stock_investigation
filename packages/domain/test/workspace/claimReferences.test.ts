import { describe, expect, it } from "vitest";
import {
	applyUiCommand,
	type ClaimReference,
	type CommandContext,
	emptyWorkspaceState,
	type JsonObject,
	NO_REFERENCES,
	ok,
	type UiCommand,
} from "../../src/index.ts";

/**
 * A component may present a claim's verification result only exactly as stored
 * (AGT-013 / DATA-001): props cannot award a badge the claim did not earn.
 */
function context(stored: readonly ClaimReference[]): CommandContext {
	return {
		// Stand-in registry: a "report" presents the claims listed in `props.claims`.
		validateProps: (_type, schemaVersion, props) =>
			ok({
				props,
				schemaVersion,
				references: { ...NO_REFERENCES, claims: readClaims(props) },
			}),
		knownDatasetRefs: new Set(),
		knownSourceIds: new Set(),
		knownClaims: new Map(stored.map((claim) => [claim.claimId, claim])),
		maxComponents: 10,
	};
}

function readClaims(props: JsonObject): ClaimReference[] {
	const claims = props.claims;
	if (!Array.isArray(claims)) return [];
	return claims.flatMap((entry) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
		const { claimId, status, claimType } = entry;
		return typeof claimId === "string" &&
			typeof status === "string" &&
			typeof claimType === "string"
			? [{ claimId, status, claimType }]
			: [];
	});
}

function create(claims: readonly ClaimReference[], componentId = "report"): UiCommand {
	return {
		protocolVersion: 1,
		commandId: `create_${componentId}`,
		workspaceId: "ws",
		expectedWorkspaceVersion: 0,
		operation: "component.create",
		componentId,
		componentType: "report",
		schemaVersion: 1,
		props: { claims: claims.map((claim) => ({ ...claim })) },
	};
}

const STORED: ClaimReference = { claimId: "cl1", status: "unsupported", claimType: "forecast" };
const state = emptyWorkspaceState("ws");

describe("claim references in component props", () => {
	it("accepts a claim presented exactly as stored", () => {
		const result = applyUiCommand(state, create([STORED]), context([STORED]));
		expect(result.ok).toBe(true);
	});

	it("rejects a badge the stored claim did not earn", () => {
		const forged = { ...STORED, status: "supported" };
		const result = applyUiCommand(state, create([forged]), context([STORED]));
		expect(result).toMatchObject({ ok: false, error: { code: "CLAIM_MISMATCH" } });
	});

	it("rejects a relabelled claim type", () => {
		const relabelled = { ...STORED, claimType: "observation" };
		const result = applyUiCommand(state, create([relabelled]), context([STORED]));
		expect(result).toMatchObject({ ok: false, error: { code: "CLAIM_MISMATCH" } });
	});

	it("rejects a claim id that is not stored", () => {
		const invented = { claimId: "cl_invented", status: "supported", claimType: "observation" };
		const result = applyUiCommand(state, create([invented]), context([STORED]));
		expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_CLAIM" } });
	});

	it("checks the merged props of an update, not only the patch", () => {
		const created = applyUiCommand(state, create([STORED]), context([STORED]));
		if (!created.ok) throw new Error("setup failed");
		const update: UiCommand = {
			protocolVersion: 1,
			commandId: "update",
			workspaceId: "ws",
			expectedWorkspaceVersion: 1,
			operation: "component.update",
			componentId: "report",
			props: { claims: [{ ...STORED, status: "supported" }] },
		};
		expect(applyUiCommand(created.value, update, context([STORED]))).toMatchObject({
			ok: false,
			error: { code: "CLAIM_MISMATCH" },
		});
		// The rejected update left the stored component untouched.
		expect(created.value.components[0]?.props).toEqual({ claims: [STORED] });
	});

	it("treats props without claim references as before", () => {
		expect(applyUiCommand(state, create([]), context([])).ok).toBe(true);
	});
});
