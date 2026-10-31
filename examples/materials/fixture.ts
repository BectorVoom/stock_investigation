import { materialImportSchema } from "@research/contracts";

/** Synthetic observations for tests and the documented import format; never seeded. */
export const materialFixture = materialImportSchema.parse({
	schemaVersion: 1,
	series: [
		{
			seriesId: "materials:NDTESTV1",
			material: "Neodymium",
			product: "Neodymium oxide",
			grade: "Synthetic 99.5%",
			basis: "Synthetic ex-works China, VAT-exclusive",
			sourceId: "synthetic-a",
			title: "Synthetic neodymium oxide (source A)",
			unit: "USD/kg product",
			frequency: "daily",
			publisher: "Synthetic material source A",
			sourceUrl: "https://example.com/materials/neodymium",
			retrievedAt: "2026-01-03T12:00:00.000Z",
			observations: [
				{
					observedOn: "2026-01-01",
					valueDecimal: "70.25",
					materialsSourceUpdatedAt: "2026-01-01T10:30:45.000Z",
				},
				{
					observedOn: "2026-01-02",
					valueDecimal: "72.5",
					materialsSourceUpdatedAt: "2026-01-02T10:45:30.000Z",
				},
			],
		},
	],
});
