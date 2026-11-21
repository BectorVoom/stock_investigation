import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import { priceEarningsRatio } from "../../apps/web/src/stocks/stockValuation.ts";

const vectors = z
	.object({
		stockValuation: z.array(
			z.object({
				price: z.number(),
				eps: z.number(),
				sameCurrency: z.boolean(),
				result: z.tuple([z.number(), z.number()]).nullable(),
			}),
		),
	})
	.parse(JSON.parse(readFileSync(new URL("../../formal/vectors.json", import.meta.url), "utf8")));

it("matches the Lean P/E model for positive, zero, and negative values and different currencies", () => {
	for (const { price, eps, sameCurrency, result } of vectors.stockValuation) {
		expect(priceEarningsRatio(price, "USD", eps, sameCurrency ? "USD" : "JPY")).toBe(
			result === null ? null : result[0] / result[1],
		);
	}
});
