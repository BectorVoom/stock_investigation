import { readFileSync } from "node:fs";
import { resolveClaimEvidenceId } from "@research/domain";
import { expect, it } from "vitest";
import { z } from "zod";

const vectors = z
	.object({
		citationReference: z.array(
			z.object({
				runId: z.string(),
				reference: z.string(),
				shown: z.array(z.string()),
				result: z.string(),
			}),
		),
	})
	.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));
it("matches the Lean citation model and resolves only shown evidence", () => {
	for (const vector of vectors.citationReference) {
		const result = resolveClaimEvidenceId(vector.runId, vector.reference, new Set(vector.shown));
		expect(result).toBe(vector.result);
		expect(result === vector.reference || vector.shown.includes(result)).toBe(true);
	}
});
