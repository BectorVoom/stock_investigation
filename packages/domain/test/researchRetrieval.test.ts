import { describe, expect, it } from "vitest";
import { z } from "zod";
import { interleaveSearchResults } from "../src/researchRetrieval.ts";

const imported: unknown = await import(
	/* @vite-ignore */ new URL("../../../formal/vectors.json", import.meta.url).pathname,
	{ with: { type: "json" } }
);
const vectors = z
	.object({
		default: z.object({
			researchRetrieval: z.array(
				z.object({
					groups: z.array(z.array(z.number())),
					limit: z.number(),
					result: z.array(z.number()),
				}),
			),
		}),
	})
	.parse(imported).default.researchRetrieval;

describe("corpus-interleaved retrieval", () => {
	it("agrees with Lean 4 for empty, uneven and capped corpora", () => {
		for (const vector of vectors)
			expect(interleaveSearchResults(vector.groups, vector.limit)).toEqual(vector.result);
	});
	it("preserves passage identity and never crowds out another corpus's first result", () => {
		const company = { kind: "company" },
			financials = { kind: "financials" },
			news = { kind: "news" };
		const result = interleaveSearchResults([[company, company], [financials], [news, news]], 3);
		expect(result).toEqual([company, financials, news]);
		expect(result[0]).toBe(company);
		expect(interleaveSearchResults([[company]], -1)).toEqual([]);
	});
});
