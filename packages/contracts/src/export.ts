import { z } from "zod";
import { chatMessageSchema, runRecordsResponseSchema } from "./api.ts";
import { boundedDatasets } from "./jobs.ts";
import { isoDateTimeSchema, shortTextSchema } from "./primitives.ts";
import { workspaceStateSchema } from "./ui.ts";

export const EXPORT_FORMAT_VERSION = 1;

/**
 * An export must be importable in one Worker request, so the same file is
 * bounded on the way out and on the way in. A workspace larger than this is
 * refused at export time with an explicit error rather than producing a file
 * that cannot be imported.
 */
export const EXPORT_LIMITS = { datasets: 40, datasetCells: 3_000 } as const;

/** Portable research record (FR-015). Imports are validated against this exact version. */
export const researchExportSchema = z.strictObject({
	format: z.literal("research-workspace-export"),
	formatVersion: z.literal(EXPORT_FORMAT_VERSION),
	exportedAt: isoDateTimeSchema,
	workspace: z.strictObject({ title: shortTextSchema, state: workspaceStateSchema }),
	messages: z.array(chatMessageSchema).max(2000),
	datasets: boundedDatasets(EXPORT_LIMITS.datasets, EXPORT_LIMITS.datasetCells),
	records: runRecordsResponseSchema,
});
export type ResearchExport = z.infer<typeof researchExportSchema>;
