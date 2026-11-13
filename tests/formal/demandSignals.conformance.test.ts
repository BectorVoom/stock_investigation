import { readFileSync } from "node:fs";
import { demandKind, matchesDemand } from "@research/domain";
import { expect, it } from "vitest";
import { z } from "zod";

const vectors = z
	.object({
		demandKind: z.array(
			z.object({
				expanding: z.boolean(),
				emerging: z.boolean(),
				weakening: z.boolean(),
				uncertain: z.boolean(),
				result: z.enum(["expanding", "emerging", "weakening", "uncertain"]).nullable(),
			}),
		),
		demandFilter: z.array(
			z.object({
				signal: z.boolean(),
				theme: z.boolean(),
				query: z.boolean(),
				result: z.boolean(),
			}),
		),
	})
	.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));

it("replays every classification flag combination from Lean", () => {
	for (const vector of vectors.demandKind) expect(demandKind(vector)).toBe(vector.result);
});
it("replays conjunctive filtering and cannot bypass a failed condition", () => {
	for (const vector of vectors.demandFilter) {
		const candidate = {
			articleId: "test",
			text: "battery",
			themes: vector.theme ? ["energy" as const] : [],
			passages: vector.signal ? [{ kind: "expanding" as const, text: "Growing demand" }] : [],
		};
		expect(
			matchesDemand(candidate, {
				theme: "energy",
				kind: "expanding",
				query: vector.query ? "battery" : "copper",
			}),
		).toBe(vector.result);
	}
});

it("replays coverage browsing without bypassing theme or text filters", () => {
	const cases = z
		.object({
			demandCoverage: z.array(
				z.object({
					coverage: z.boolean(),
					signal: z.boolean(),
					theme: z.boolean(),
					query: z.boolean(),
					result: z.boolean(),
				}),
			),
		})
		.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));
	for (const vector of cases.demandCoverage) {
		const candidate = {
			articleId: "test",
			text: "battery",
			themes: vector.theme ? ["energy" as const] : [],
			passages: vector.signal ? [{ kind: "expanding" as const, text: "Growing demand" }] : [],
		};
		expect(
			matchesDemand(candidate, {
				theme: "energy",
				kind: vector.coverage ? "coverage" : "expanding",
				query: vector.query ? "battery" : "copper",
			}),
		).toBe(vector.result);
	}
});
