import { describe, expect, it } from "vitest";
import {
	chipLabel,
	numberEvidence,
	numbersForClaim,
	sourceHost,
	titleOrHost,
} from "../src/citationModel.ts";

describe("citation numbering (per scope, first appearance wins)", () => {
	it("numbers distinct evidence in order of first appearance starting at 1", () => {
		const numbering = numberEvidence([
			{
				claimId: "claim_1",
				links: [{ evidenceId: "ev_b" }, { evidenceId: "ev_a" }],
			},
			{ claimId: "claim_2", links: [{ evidenceId: "ev_a" }, { evidenceId: "ev_c" }] },
		]);
		expect([...numbering.numberByEvidenceId]).toEqual([
			["ev_b", 1],
			["ev_a", 2],
			["ev_c", 3],
		]);
		expect(numbering.evidenceIdsInOrder).toEqual(["ev_b", "ev_a", "ev_c"]);
	});

	it("gives shared evidence the same number in every claim", () => {
		const numbering = numberEvidence([
			{ claimId: "claim_1", links: [{ evidenceId: "ev_a" }] },
			{ claimId: "claim_2", links: [{ evidenceId: "ev_a" }] },
		]);
		expect(numbering.numberByEvidenceId.get("ev_a")).toBe(1);
		expect(
			numbersForClaim({ claimId: "claim_1", links: [{ evidenceId: "ev_a" }] }, numbering),
		).toEqual([1]);
		expect(
			numbersForClaim({ claimId: "claim_2", links: [{ evidenceId: "ev_a" }] }, numbering),
		).toEqual([1]);
	});

	it("keeps link order within a claim and skips unknown ids", () => {
		const numbering = numberEvidence([
			{ claimId: "claim_1", links: [{ evidenceId: "ev_a" }, { evidenceId: "ev_b" }] },
		]);
		expect(
			numbersForClaim(
				{ claimId: "claim_1", links: [{ evidenceId: "ev_b" }, { evidenceId: "ev_a" }] },
				numbering,
			),
		).toEqual([2, 1]);
		expect(
			numbersForClaim({ claimId: "claim_1", links: [{ evidenceId: "ev_missing" }] }, numbering),
		).toEqual([]);
	});

	it("names hosts, titles and chip labels", () => {
		expect(sourceHost("https://news.example.org/a/1?utm=x")).toBe("news.example.org");
		expect(sourceHost("not a url")).toBeNull();
		expect(titleOrHost("  ", "https://news.example.org/a")).toBe("news.example.org");
		expect(titleOrHost("Grid outlook", "https://news.example.org/a")).toBe("Grid outlook");
		expect(chipLabel(2, "Grid outlook", "https://news.example.org/a")).toBe(
			"Source 2: Grid outlook",
		);
	});
});
