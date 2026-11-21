import { readFileSync } from "node:fs";
import {
	classifyCompanyMembership,
	fuzzyAllowedEdits,
	osaWithinCodePoints,
	prefilterSlices,
	themeQualifiesDirect,
	themeQualifiesRelated,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const vectors = z
	.object({
		companyAllowedEdits: z.array(
			z.object({
				kind: z.enum(["numericOrTicker", "cjk", "katakana", "ascii", "mixed"]),
				len: z.number(),
				result: z.number(),
			}),
		),
		companyOsa: z.array(
			z.object({
				maxEdits: z.number(),
				q: z.array(z.number()),
				w: z.array(z.number()),
				distance: z.number().nullable(),
				prefilter1: z.boolean(),
				prefilter2: z.boolean(),
			}),
		),
		companyThemeQualifies: z.array(
			z.object({
				matchesTargetOnly: z.boolean(),
				isAncillary: z.boolean(),
				matchesDirect: z.boolean(),
				matchesRelated: z.boolean(),
				direct: z.boolean(),
				related: z.boolean(),
			}),
		),
		companyMembership: z.array(
			z.object({
				hasSummary: z.boolean(),
				isBlankCheck: z.boolean(),
				terms: z.array(
					z.object({
						identity: z.boolean(),
						directTheme: z.boolean(),
						relatedTheme: z.boolean(),
						sectorOrSegment: z.boolean(),
						activeBody: z.boolean(),
					}),
				),
				result: z
					.enum(["identity", "directTheme", "relatedTheme", "sectorSegment", "activeFiling"])
					.nullable(),
			}),
		),
	})
	.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));

describe("company screening Lean conformance", () => {
	it("matches Lean allowedEdits across all token kinds and lengths", () => {
		for (const vector of vectors.companyAllowedEdits) {
			expect(fuzzyAllowedEdits(vector.kind, vector.len)).toBe(vector.result);
		}
	});

	it("matches Lean osaWithin and pigeonhole slice soundness across edit distances", () => {
		for (const vector of vectors.companyOsa) {
			const actual = osaWithinCodePoints(vector.maxEdits, vector.q, vector.w);
			expect(actual).toBe(vector.distance);

			const qStr = vector.q.map((n) => String.fromCodePoint(97 + n)).join("");
			const wStr = vector.w.map((n) => String.fromCodePoint(97 + n)).join("");
			if (vector.q.length >= 5) {
				const slices1 = prefilterSlices(qStr, 1);
				expect(slices1.some((s) => wStr.includes(s))).toBe(vector.prefilter1);
				if (vector.maxEdits === 1 && actual !== null) {
					expect(vector.prefilter1).toBe(true);
				}
			}
			if (vector.q.length >= 8) {
				const slices2 = prefilterSlices(qStr, 2);
				expect(slices2.some((s) => wStr.includes(s))).toBe(vector.prefilter2);
				if (vector.maxEdits === 2 && actual !== null) {
					expect(vector.prefilter2).toBe(true);
				}
			}
		}
	});

	it("matches Lean theme qualification and customer/ancillary exclusion", () => {
		for (const vector of vectors.companyThemeQualifies) {
			expect(themeQualifiesDirect(vector)).toBe(vector.direct);
			expect(themeQualifiesRelated(vector)).toBe(vector.related);
			if (vector.matchesTargetOnly || vector.isAncillary) {
				expect(vector.direct).toBe(false);
				expect(vector.related).toBe(false);
			}
		}
	});

	it("matches Lean company membership classification and body-only/SPAC exclusions", () => {
		for (const vector of vectors.companyMembership) {
			expect(classifyCompanyMembership(vector.hasSummary, vector.isBlankCheck, vector.terms)).toBe(
				vector.result,
			);
		}
	});
});
