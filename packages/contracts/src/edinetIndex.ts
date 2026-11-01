/**
 * One shared index of EDINET annual securities reports (ADR-0058 §4): the
 * `edinet-index` claim and completion. Each day's document list is read
 * once for every company; a JP company's `financial-sync` then downloads
 * only the reports the index names for its securities code.
 */
import { z } from "zod";
import {
	edinetCodeSchema,
	edinetDocIdSchema,
	edinetSecuritiesCodeSchema,
	equityCalendarDateSchema,
} from "./equityFinancials.ts";
import { isoDateTimeSchema } from "./primitives.ts";

export const EDINET_INDEX_LIMITS = {
	/** Days one job lists: 40 seconds at EDINET's 1 request a second. */
	maxDaysPerJob: 40,
	/** The busiest June day lists ~1,500 annual reports; room above it. */
	maxDocumentsPerDay: 4_000,
	maxFilerNameChars: 200,
} as const;

/** EDINET's document types the index keeps: 120 annual securities report, 130 its amendment. */
export const edinetIndexDocTypeSchema = z.enum(["120", "130"]);

/** One annual report row of a day's list, as EDINET states it. */
export const edinetIndexDocumentSchema = z.strictObject({
	docId: edinetDocIdSchema,
	secCode: edinetSecuritiesCodeSchema,
	edinetCode: edinetCodeSchema,
	filerName: z.string().min(1).max(EDINET_INDEX_LIMITS.maxFilerNameChars),
	docTypeCode: edinetIndexDocTypeSchema,
	/** An amendment's (130) row states no period (EDINET API spec §3-1-2-2 *3). */
	periodStart: equityCalendarDateSchema.nullable(),
	periodEnd: equityCalendarDateSchema.nullable(),
	/** `submitDateTime` in JST, as an ISO instant. */
	submittedAt: isoDateTimeSchema,
	/** The report an amendment amends (parentDocID), else null. */
	parentDocId: edinetDocIdSchema.nullable(),
});
export type EdinetIndexDocument = z.infer<typeof edinetIndexDocumentSchema>;

/** The fields of an `edinet-index` claimed job besides the lease shape. */
export const edinetIndexClaimShape = {
	/** Newest first, distinct weekdays, each before today in JST. */
	days: z.array(equityCalendarDateSchema).min(1).max(EDINET_INDEX_LIMITS.maxDaysPerJob),
};

export const edinetIndexDayResultSchema = z.strictObject({
	date: equityCalendarDateSchema,
	documents: z.array(edinetIndexDocumentSchema).max(EDINET_INDEX_LIMITS.maxDocumentsPerDay),
});
export type EdinetIndexDayResult = z.infer<typeof edinetIndexDayResultSchema>;

/**
 * The fields of an `edinet-indexed` completion besides the completion base:
 * only days whose list was read in full; a day the job could not list is
 * left out and planned again.
 */
export const edinetIndexCompletionShape = {
	fetchedAt: isoDateTimeSchema,
	days: z.array(edinetIndexDayResultSchema).max(EDINET_INDEX_LIMITS.maxDaysPerJob),
};

/** The first problem of a completion's cross-field rules, or null. */
export function edinetIndexCompletionProblem(completion: {
	readonly days: readonly EdinetIndexDayResult[];
}): string | null {
	const dates = new Set<string>();
	for (const day of completion.days) {
		if (dates.has(day.date)) return `day ${day.date} is reported twice`;
		dates.add(day.date);
		const docIds = new Set<string>();
		for (const document of day.documents) {
			if (docIds.has(document.docId)) return `document ${document.docId} is listed twice`;
			docIds.add(document.docId);
			if (document.docTypeCode === "120" && document.periodEnd === null) {
				return `annual report ${document.docId} states no period end`;
			}
		}
	}
	return null;
}
