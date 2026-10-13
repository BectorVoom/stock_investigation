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

const anyRecordSchema = z.record(z.string(), z.unknown());
const anyArraySchema = z.array(z.unknown());

/**
 * Exports written before approved images were withdrawn (owner's decision of
 * 2026-10-13) carry a top-level `assets` array this contract no longer
 * defines. An EMPTY one is dropped so image-free older files still validate;
 * a non-empty one is left in place, so the strict schema rejects the file and
 * the server can name the reason. One rule for the web client and the server.
 */
export function dropLegacyEmptyAssets(payload: unknown): unknown {
	const root = anyRecordSchema.safeParse(payload);
	if (!root.success) return payload;
	const assets = anyArraySchema.safeParse(root.data.assets);
	if (!assets.success || assets.data.length > 0) return payload;
	const { assets: _dropped, ...rest } = root.data;
	return rest;
}
