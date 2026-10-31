import { z } from "zod";
import { equityDecimalSchema, materialsSourceUpdatedAtSchema } from "./equities.ts";
import { marketFrequencySchema } from "./market.ts";
import { httpsUrlSchema, isoDateSchema } from "./primitives.ts";

export const MATERIAL_LIMITS = {
	maxSeries: 20,
	maxObservations: 800,
	maxImportBytes: 750_000,
	maxStoredSeries: 200,
} as const;
const label = z.string().trim().min(1).max(200);
export const materialObservationSchema = z.strictObject({
	observedOn: isoDateSchema,
	valueDecimal: equityDecimalSchema.refine(
		(value) => Number.isFinite(Number(value)),
		"price must be chartable",
	),
	materialsSourceUpdatedAt: materialsSourceUpdatedAtSchema.nullable(),
});
/** One immutable source/grade/basis snapshot. Corrections require a new series ID. */
export const materialSeriesSchema = z
	.strictObject({
		seriesId: z
			.string()
			.max(35)
			.regex(/^materials:[A-Z0-9]{1,25}$/)
			.refine((value) => value.trim() === value),
		material: label,
		product: label,
		grade: label,
		basis: label,
		sourceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/),
		title: z.string().trim().min(1).max(120),
		unit: z.string().trim().min(1).max(80),
		frequency: marketFrequencySchema.exclude(["unknown"]),
		publisher: label,
		sourceUrl: httpsUrlSchema,
		retrievedAt: materialsSourceUpdatedAtSchema,
		observations: z.array(materialObservationSchema).min(1).max(MATERIAL_LIMITS.maxObservations),
	})
	.superRefine((series, context) => {
		const dates = new Set<string>();
		for (const [index, observation] of series.observations.entries()) {
			if (dates.has(observation.observedOn))
				context.addIssue({
					code: "custom",
					path: ["observations", index],
					message: "duplicate assessment date",
				});
			dates.add(observation.observedOn);
			if (observation.observedOn > series.retrievedAt.slice(0, 10))
				context.addIssue({
					code: "custom",
					path: ["observations", index],
					message: "assessment follows retrieval",
				});
			if (
				observation.materialsSourceUpdatedAt !== null &&
				observation.materialsSourceUpdatedAt > series.retrievedAt
			)
				context.addIssue({
					code: "custom",
					path: ["observations", index],
					message: "source update follows retrieval",
				});
		}
	});
export const materialImportSchema = z
	.strictObject({
		schemaVersion: z.literal(1),
		series: z.array(materialSeriesSchema).min(1).max(MATERIAL_LIMITS.maxSeries),
	})
	.refine(
		(payload) =>
			new Set(payload.series.map((series) => series.seriesId)).size === payload.series.length,
		"duplicate series id",
	);
export type MaterialSeries = z.infer<typeof materialSeriesSchema>;
export type MaterialImport = z.infer<typeof materialImportSchema>;
