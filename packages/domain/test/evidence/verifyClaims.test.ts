import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	type ClaimType,
	type DraftClaim,
	type DraftEvidenceLink,
	type EvidenceRelation,
	type EvidenceText,
	extractNumberTokens,
	verifyClaim,
	verifyClaims,
} from "../../src/evidence/verifyClaims.ts";
import { deepFreeze } from "../support/deepFreeze.ts";

const EVIDENCE: readonly EvidenceText[] = [
	{
		evidenceId: "ev_earnings",
		retrievedText:
			"Example Corp reported revenue of 1,234 million yen, up 12% year on year. Operating margin widened to 8.5%.",
	},
	{
		evidenceId: "ev_analyst",
		retrievedText: "Analysts warn that demand may fall as subsidies expire in 2027.",
	},
	{
		evidenceId: "ev_context",
		retrievedText: "Example Corp is listed on the Tokyo Stock Exchange.",
	},
];

function link(
	evidenceId: string,
	relation: EvidenceRelation,
	quote: string | null,
): DraftEvidenceLink {
	return { evidenceId, relation, quote };
}

function claim(overrides: Partial<DraftClaim> = {}): DraftClaim {
	return {
		claimId: "claim_1",
		text: "Example Corp revenue rose 12% year on year.",
		claimType: "observation",
		links: [link("ev_earnings", "supports", "up 12% year on year")],
		...overrides,
	};
}

function verifyOne(draft: DraftClaim, evidence: readonly EvidenceText[] = EVIDENCE) {
	const [verified] = verifyClaims([draft], evidence);
	if (verified === undefined) throw new Error("verifyClaims dropped the claim");
	return verified;
}

describe("extractNumberTokens", () => {
	it("extracts integers, decimals and thousands-separated numbers", () => {
		expect(
			extractNumberTokens("Revenue of 1,234.5 million, up 12% from 2025; margin 8.5%."),
		).toEqual(["1234.5", "12", "2025", "8.5"]);
	});

	it("normalizes full-width digits", () => {
		expect(extractNumberTokens("売上高は１２３４億円")).toEqual(["1234"]);
	});

	it("returns nothing for text without digits", () => {
		expect(extractNumberTokens("no figures here")).toEqual([]);
		expect(extractNumberTokens("")).toEqual([]);
	});
});

describe("verifyClaims: supported claims", () => {
	it("marks a claim supported when its quote occurs in the cited evidence", () => {
		const draft = claim();
		expect(verifyOne(draft)).toEqual({
			claimId: "claim_1",
			text: draft.text,
			claimType: "observation",
			status: "supported",
			links: draft.links,
			issues: [],
		});
	});

	it("matches quotes regardless of case, whitespace runs and compatibility forms", () => {
		const verified = verifyOne(
			claim({ links: [link("ev_earnings", "supports", "  UP   12%\n year on YEAR ")] }),
		);
		expect(verified.status).toBe("supported");
		expect(verified.issues).toEqual([]);
	});

	it("accepts a context link with no quote", () => {
		const verified = verifyOne(
			claim({
				links: [
					link("ev_earnings", "supports", "up 12% year on year"),
					link("ev_context", "context", null),
				],
			}),
		);
		expect(verified.status).toBe("supported");
		expect(verified.links).toHaveLength(2);
		expect(verified.issues).toEqual([]);
	});

	it("does not mutate its inputs", () => {
		const claims = deepFreeze([claim()]);
		const evidence = deepFreeze(EVIDENCE.map((entry) => ({ ...entry })));
		expect(() => verifyClaims(claims, evidence)).not.toThrow();
	});
});

describe("verifyClaims: fabricated citations (AGT-009)", () => {
	it("rejects an evidence id this run never fetched", () => {
		const verified = verifyOne(
			claim({ links: [link("ev_invented", "supports", "up 12% year on year")] }),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.links).toEqual([]);
		expect(verified.issues).toContainEqual({ code: "UNKNOWN_EVIDENCE", evidenceId: "ev_invented" });
		expect(verified.issues).toContainEqual({ code: "NO_SUPPORTING_EVIDENCE" });
	});

	it("rejects a quote that does not occur in the cited evidence", () => {
		const verified = verifyOne(
			claim({ links: [link("ev_earnings", "supports", "revenue tripled year on year")] }),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.links).toEqual([]);
		expect(verified.issues).toContainEqual({ code: "QUOTE_NOT_FOUND", evidenceId: "ev_earnings" });
	});

	it("rejects a quote that occurs only in a different evidence item", () => {
		const verified = verifyOne(
			claim({ links: [link("ev_analyst", "supports", "up 12% year on year")] }),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toContainEqual({ code: "QUOTE_NOT_FOUND", evidenceId: "ev_analyst" });
	});

	it("rejects a quote stitched together from non-adjacent passages", () => {
		const verified = verifyOne(
			claim({ links: [link("ev_earnings", "supports", "revenue of 1,234 million yen widened")] }),
		);
		expect(verified.status).toBe("unsupported");
	});

	it.each([null, "", "   "])("requires a quote for a supporting link (quote %j)", (quote) => {
		const verified = verifyOne(claim({ links: [link("ev_earnings", "supports", quote)] }));
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toContainEqual({ code: "MISSING_QUOTE", evidenceId: "ev_earnings" });
	});

	it("requires a quote for a contradicting link", () => {
		const verified = verifyOne(
			claim({
				links: [
					link("ev_earnings", "supports", "up 12% year on year"),
					link("ev_analyst", "contradicts", null),
				],
			}),
		);
		expect(verified.issues).toContainEqual({ code: "MISSING_QUOTE", evidenceId: "ev_analyst" });
		// The unverifiable contradiction is reported, not silently counted or silently dropped.
		expect(verified.links).toEqual([link("ev_earnings", "supports", "up 12% year on year")]);
	});

	it("reports a claim with no links at all as unsupported", () => {
		const verified = verifyOne(claim({ text: "Example Corp revenue rose.", links: [] }));
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toEqual([{ code: "NO_SUPPORTING_EVIDENCE" }]);
	});

	it("flags the numbers of an uncited observation as well", () => {
		const verified = verifyOne(claim({ links: [] }));
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toEqual([
			{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "12" },
			{ code: "NO_SUPPORTING_EVIDENCE" },
		]);
	});

	it("does not count context-only citations as support", () => {
		const verified = verifyOne(
			claim({
				text: "Example Corp is listed in Tokyo.",
				links: [link("ev_context", "context", null)],
			}),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toEqual([{ code: "NO_SUPPORTING_EVIDENCE" }]);
		expect(verified.links).toHaveLength(1);
	});

	it("is unsupported when there is no evidence at all", () => {
		const verified = verifyOne(claim(), []);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toContainEqual({ code: "UNKNOWN_EVIDENCE", evidenceId: "ev_earnings" });
	});
});

describe("verifyClaims: numbers in observations", () => {
	it("rejects an observation whose number does not appear in its supporting evidence", () => {
		const verified = verifyOne(
			claim({
				text: "Example Corp revenue rose 21% year on year.",
				links: [link("ev_earnings", "supports", "up 12% year on year")],
			}),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toEqual([{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "21" }]);
		// The citation itself was genuine and stays visible.
		expect(verified.links).toHaveLength(1);
	});

	it("reports every unsupported number", () => {
		const verified = verifyOne(
			claim({ text: "Revenue was 1,234 million yen, up 15%, with a 9.5% margin." }),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toEqual([
			{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "15" },
			{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "9.5" },
		]);
	});

	it("accepts numbers written with different thousands separators than the source", () => {
		const verified = verifyOne(claim({ text: "Revenue was 1234 million yen, up 12%." }));
		expect(verified.status).toBe("supported");
	});

	it("does not accept a number found only in evidence the claim does not validly cite", () => {
		const verified = verifyOne(
			claim({
				text: "Subsidies expire in 2027 and revenue rose 12%.",
				links: [
					link("ev_earnings", "supports", "up 12% year on year"),
					// 2027 appears here, but the quote is fabricated so the link does not count.
					link("ev_analyst", "supports", "subsidies will certainly expire"),
				],
			}),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toContainEqual({ code: "QUOTE_NOT_FOUND", evidenceId: "ev_analyst" });
		expect(verified.issues).toContainEqual({ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "2027" });
	});

	it("does not accept a number that appears only in contradicting or context evidence", () => {
		const verified = verifyOne(
			claim({
				text: "Revenue rose 12% and subsidies run to 2027.",
				links: [
					link("ev_earnings", "supports", "up 12% year on year"),
					link("ev_analyst", "context", null),
				],
			}),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.issues).toEqual([{ code: "NUMBER_NOT_IN_EVIDENCE", numberText: "2027" }]);
	});

	it.each<ClaimType>([
		"inference",
		"hypothesis",
		"forecast",
	])("lets a %s state numbers no source contains yet", (claimType) => {
		const verified = verifyOne(
			claim({ claimType, text: "Demand could reach 40 GWh by 2030, a 25% CAGR." }),
		);
		expect(verified.status).toBe("supported");
		expect(verified.issues).toEqual([]);
	});

	it("still requires supporting evidence for a forecast", () => {
		const verified = verifyOne(claim({ claimType: "forecast", links: [] }));
		expect(verified.status).toBe("unsupported");
	});
});

describe("verifyClaims: conflicting evidence (DATA-004)", () => {
	const conflicting = claim({
		text: "Demand for Example Corp products will keep growing.",
		claimType: "inference",
		links: [
			link("ev_earnings", "supports", "up 12% year on year"),
			link("ev_analyst", "contradicts", "demand may fall as subsidies expire"),
		],
	});

	it("marks a claim with verified support and verified contradiction as conflicting", () => {
		const verified = verifyOne(conflicting);
		expect(verified.status).toBe("conflicting");
		expect(verified.issues).toEqual([]);
	});

	it("preserves the contradicting link instead of cherry-picking the support", () => {
		const verified = verifyOne(conflicting);
		expect(verified.links).toEqual(conflicting.links);
	});

	it("is unsupported, not conflicting, when only the contradiction verifies", () => {
		const verified = verifyOne(
			claim({
				claimType: "inference",
				links: [link("ev_analyst", "contradicts", "demand may fall as subsidies expire")],
			}),
		);
		expect(verified.status).toBe("unsupported");
		expect(verified.links).toHaveLength(1);
		expect(verified.issues).toEqual([{ code: "NO_SUPPORTING_EVIDENCE" }]);
	});

	it("does not let a fabricated contradiction turn a supported claim into a conflict", () => {
		const verified = verifyOne(
			claim({
				links: [
					link("ev_earnings", "supports", "up 12% year on year"),
					link("ev_analyst", "contradicts", "revenue collapsed"),
				],
			}),
		);
		expect(verified.status).toBe("supported");
		expect(verified.issues).toEqual([{ code: "QUOTE_NOT_FOUND", evidenceId: "ev_analyst" }]);
	});
});

describe("verifyClaims: nothing is silently dropped", () => {
	it("returns one result per claim, in order, including unsupported ones", () => {
		const drafts = [
			claim({ claimId: "c_supported" }),
			claim({ claimId: "c_fabricated", links: [link("ev_nope", "supports", "x")] }),
			claim({ claimId: "c_empty", links: [] }),
			claim({ claimId: "c_supported" }),
		];
		const verified = verifyClaims(drafts, EVIDENCE);
		expect(verified.map((entry) => entry.claimId)).toEqual([
			"c_supported",
			"c_fabricated",
			"c_empty",
			"c_supported",
		]);
		expect(verified.map((entry) => entry.status)).toEqual([
			"supported",
			"unsupported",
			"unsupported",
			"supported",
		]);
	});

	it("returns an empty list for no claims", () => {
		expect(verifyClaims([], EVIDENCE)).toEqual([]);
	});

	it("accounts for every draft link either as a kept link or as an issue", () => {
		const draft = claim({
			links: [
				link("ev_earnings", "supports", "up 12% year on year"),
				link("ev_missing", "supports", "anything"),
				link("ev_analyst", "contradicts", "not in the text"),
				link("ev_analyst", "supports", null),
				link("ev_context", "context", null),
			],
		});
		const verified = verifyOne(draft);
		expect(verified.links).toEqual([draft.links[0], draft.links[4]]);
		expect(verified.issues).toEqual([
			{ code: "UNKNOWN_EVIDENCE", evidenceId: "ev_missing" },
			{ code: "QUOTE_NOT_FOUND", evidenceId: "ev_analyst" },
			{ code: "MISSING_QUOTE", evidenceId: "ev_analyst" },
		]);
	});
});

describe("verifyClaim", () => {
	// verifyClaim takes evidence text that is already normalized (lower case, single spaces).
	const normalized = new Map([
		["ev_earnings", "revenue of 1,234 million yen, up 12% year on year."],
	]);

	it("verifies one claim against pre-normalized evidence text", () => {
		expect(verifyClaim(claim(), normalized)).toMatchObject({ status: "supported", issues: [] });
	});

	it("rejects fabricated ids and quotes exactly as verifyClaims does", () => {
		expect(
			verifyClaim(claim({ links: [link("ev_ghost", "supports", "up 12%")] }), normalized).issues,
		).toContainEqual({ code: "UNKNOWN_EVIDENCE", evidenceId: "ev_ghost" });
		expect(
			verifyClaim(
				claim({ links: [link("ev_earnings", "supports", "down 12% year on year")] }),
				normalized,
			).issues,
		).toContainEqual({ code: "QUOTE_NOT_FOUND", evidenceId: "ev_earnings" });
	});

	it("does not accept a quote too short to be a passage, even if it occurs in the source", () => {
		// "up 12%" really is in the evidence, but a fragment that short would "verify" anything.
		const short = verifyClaim(
			claim({ links: [link("ev_earnings", "supports", "up 12%")] }),
			normalized,
		);
		expect(short.status).toBe("unsupported");
		expect(short.links).toEqual([]);
		expect(short.issues).toContainEqual({ code: "QUOTE_TOO_SHORT", evidenceId: "ev_earnings" });

		// Whitespace padding does not make a short quote long enough.
		const padded = verifyClaim(
			claim({ links: [link("ev_earnings", "contradicts", "   up    12%      ")] }),
			normalized,
		);
		expect(padded.issues).toContainEqual({ code: "QUOTE_TOO_SHORT", evidenceId: "ev_earnings" });
	});

	it("is unsupported against an empty evidence map", () => {
		expect(verifyClaim(claim(), new Map()).status).toBe("unsupported");
	});
});

describe("verifyClaims properties", () => {
	const evidenceIds = ["ev_a", "ev_b", "ev_c"] as const;
	const evidenceArb: fc.Arbitrary<readonly EvidenceText[]> = fc
		.tuple(fc.lorem({ maxCount: 12 }), fc.lorem({ maxCount: 12 }), fc.lorem({ maxCount: 12 }))
		.map((texts) =>
			texts.map((retrievedText, index) => ({
				evidenceId: evidenceIds[index] ?? "ev_a",
				retrievedText: `${retrievedText} ${index * 7 + 3} units`,
			})),
		);
	const linkArb: fc.Arbitrary<DraftEvidenceLink> = fc.record({
		evidenceId: fc.constantFrom(...evidenceIds, "ev_fabricated", "ev_ghost"),
		relation: fc.constantFrom<EvidenceRelation>("supports", "contradicts", "context"),
		quote: fc.option(
			fc.oneof(fc.lorem({ maxCount: 3 }), fc.constantFrom("", " ", "3 units", "10 units", "zzz")),
			{ nil: null },
		),
	});
	const claimArb: fc.Arbitrary<DraftClaim> = fc.record({
		claimId: fc.stringMatching(/^claim_[a-z0-9]{1,6}$/),
		text: fc.oneof(fc.lorem({ maxCount: 6 }), fc.constantFrom("3 units sold", "99 units sold")),
		claimType: fc.constantFrom<ClaimType>("observation", "inference", "hypothesis", "forecast"),
		links: fc.array(linkArb, { maxLength: 6 }),
	});

	it("keeps every claim, and every link is either kept or explained by exactly one issue", () => {
		fc.assert(
			fc.property(fc.array(claimArb, { maxLength: 8 }), evidenceArb, (claims, evidence) => {
				const verified = verifyClaims(claims, evidence);
				expect(verified).toHaveLength(claims.length);
				verified.forEach((result, index) => {
					const draft = claims[index];
					if (draft === undefined) throw new Error("result without a draft");
					expect(result.claimId).toBe(draft.claimId);
					expect(result.text).toBe(draft.text);
					expect(result.claimType).toBe(draft.claimType);
					const linkIssues = result.issues.filter((issue) => "evidenceId" in issue);
					expect(result.links.length + linkIssues.length).toBe(draft.links.length);
					for (const kept of result.links) expect(draft.links).toContain(kept);
				});
			}),
			{ numRuns: 300 },
		);
	});

	it("never keeps a link to evidence that was not fetched, and never supports on it", () => {
		fc.assert(
			fc.property(fc.array(claimArb, { maxLength: 8 }), evidenceArb, (claims, evidence) => {
				const known = new Set(evidence.map((entry) => entry.evidenceId));
				for (const result of verifyClaims(claims, evidence)) {
					for (const kept of result.links) expect(known.has(kept.evidenceId)).toBe(true);
					const hasSupport = result.links.some((kept) => kept.relation === "supports");
					if (result.status !== "unsupported") expect(hasSupport).toBe(true);
					if (!hasSupport) {
						expect(result.issues).toContainEqual({ code: "NO_SUPPORTING_EVIDENCE" });
					}
					if (result.status === "supported") {
						expect(result.links.some((kept) => kept.relation === "contradicts")).toBe(false);
					}
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("a claim citing only fabricated evidence is always unsupported", () => {
		fc.assert(
			fc.property(claimArb, evidenceArb, (draft, evidence) => {
				const fabricated: DraftClaim = {
					...draft,
					links: draft.links.map((entry) => ({ ...entry, evidenceId: "ev_fabricated" })),
				};
				const [result] = verifyClaims([fabricated], evidence);
				expect(result?.status).toBe("unsupported");
				expect(result?.links).toEqual([]);
			}),
			{ numRuns: 200 },
		);
	});
});
