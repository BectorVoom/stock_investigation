import { parseMarketSeriesId } from "@research/domain";
import { expect, it } from "vitest";
import { z } from "zod";
import vectors from "../../formal/vectors.json";

it("matches the Lean material namespace and bounded ASCII symbol model", () => {
	const rows = z
		.object({
			materialSeries: z.array(
				z.object({ provider: z.string(), symbol: z.string(), accepted: z.boolean() }),
			),
		})
		.parse(vectors);
	for (const row of rows.materialSeries) {
		const result = parseMarketSeriesId(`${row.provider}:${row.symbol}`);
		expect(result.ok && result.value.provider === "materials").toBe(row.accepted);
	}
});
