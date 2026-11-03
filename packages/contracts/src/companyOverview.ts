import { z } from "zod";
import { agentIdSchema } from "./agent.ts";
import { isoDateTimeSchema } from "./primitives.ts";

/**
 * The company overview (事業概要, ADR-0064): the Company tab's AI-written
 * entry laid out like a 会社四季報 company entry — 【特色】【事業内容】
 * 【連結事業】【海外】【テーマ】, a 会社概要 table and a 業績 table — in which
 * every model-written field carries evidence: the id of a numbered source
 * the server built from its own stored records and a word-for-word quote
 * from it, checked by code before it is stored. Only 四季報's layout is
 * followed; none of its (licensed) text is used.
 */
export const COMPANY_OVERVIEW_LIMITS = {
	maxStatementChars: 300,
	/** 四季報's 【特色】 is one line: about 60 Japanese characters. */
	maxFeatureJaChars: 70,
	minQuoteChars: 6,
	maxQuoteChars: 400,
	maxEvidencePerField: 3,
	maxBusinesses: 4,
	maxSegments: 8,
	maxSegmentNameChars: 60,
	/** One line on what a segment does: its products, customers or operations. */
	maxSegmentActivityChars: 200,
	maxProfileValueChars: 120,
	maxProfileFacts: 3,
	maxThemes: 6,
	maxThemeChars: 40,
	maxReferences: 9,
	maxReferenceTextChars: 300,
	maxFigures: 4,
} as const;

const limits = COMPANY_OVERVIEW_LIMITS;

/** A source id the server assigned: S1, S2, … */
export const overviewSourceIdSchema = z.string().regex(/^S[1-9]$/);
export type OverviewSourceId = z.infer<typeof overviewSourceIdSchema>;

/** One piece of evidence: which source, and the exact words in it. */
export const overviewEvidenceSchema = z.strictObject({
	source: overviewSourceIdSchema,
	quote: z.string().trim().min(limits.minQuoteChars).max(limits.maxQuoteChars),
});
export type OverviewEvidence = z.infer<typeof overviewEvidenceSchema>;

const evidenceList = z.array(overviewEvidenceSchema).min(1).max(limits.maxEvidencePerField);

function localized(max: number) {
	return z.strictObject({
		en: z.string().trim().min(1).max(max),
		ja: z.string().trim().min(1).max(max),
	});
}

/** One sentence in English and Japanese with the evidence behind it. */
export const overviewStatementSchema = z.strictObject({
	en: z.string().trim().min(1).max(limits.maxStatementChars),
	ja: z.string().trim().min(1).max(limits.maxStatementChars),
	evidence: evidenceList,
});
export type OverviewStatement = z.infer<typeof overviewStatementSchema>;

const percentSchema = z.number().min(-100).max(100).nullable();

/**
 * One reportable segment, 四季報's "外航海運79(4)": its name, what it does
 * (its products, customers or operations, as the sources say), its share
 * of sales and its profit margin in percent — each number only when a
 * source states it, null otherwise. `activity` defaults to null so an entry
 * stored before it existed still reads.
 */
export const overviewSegmentSchema = z.strictObject({
	name: localized(limits.maxSegmentNameChars),
	activity: localized(limits.maxSegmentActivityChars).nullable().default(null),
	salesSharePercent: percentSchema,
	marginPercent: percentSchema,
	evidence: evidenceList,
});
export type OverviewSegment = z.infer<typeof overviewSegmentSchema>;

/** The overseas share of sales a source states. */
export const overviewStatedPercentSchema = z.strictObject({
	percent: z.number().min(0).max(100),
	evidence: evidenceList,
});

/** A 会社概要 row a source states: founded, employees, headquarters. */
export const overviewProfileFactSchema = z.strictObject({
	field: z.enum(["founded", "employees", "headquarters"]),
	value: localized(limits.maxProfileValueChars),
	evidence: evidenceList,
});
export type OverviewProfileFact = z.infer<typeof overviewProfileFactSchema>;

export const overviewThemeSchema = z.strictObject({
	label: localized(limits.maxThemeChars),
	reason: overviewStatementSchema,
});
export type OverviewTheme = z.infer<typeof overviewThemeSchema>;

const featureSchema = overviewStatementSchema.refine(
	(statement) => statement.ja.length <= limits.maxFeatureJaChars,
	`feature.ja is one line: at most ${limits.maxFeatureJaChars} characters`,
);

/**
 * What the model writes: every field present, each with evidence. The
 * lists may be empty: a sector classification is not a business activity
 * or a theme, so a company whose sources describe neither gets none.
 */
export const companyOverviewDraftSchema = z.strictObject({
	feature: featureSchema,
	businesses: z.array(overviewStatementSchema).max(limits.maxBusinesses),
	segments: z.array(overviewSegmentSchema).max(limits.maxSegments),
	overseasSales: overviewStatedPercentSchema.nullable(),
	profile: z.array(overviewProfileFactSchema).max(limits.maxProfileFacts),
	themes: z.array(overviewThemeSchema).max(limits.maxThemes),
});
export type CompanyOverviewDraft = z.infer<typeof companyOverviewDraftSchema>;

/**
 * What is stored and shown: the draft with every field whose evidence
 * failed the check removed, so the feature may be null and a list empty.
 */
export const companyOverviewEntrySchema = z.strictObject({
	feature: featureSchema.nullable(),
	businesses: z.array(overviewStatementSchema).max(limits.maxBusinesses),
	segments: z.array(overviewSegmentSchema).max(limits.maxSegments),
	overseasSales: overviewStatedPercentSchema.nullable(),
	profile: z.array(overviewProfileFactSchema).max(limits.maxProfileFacts),
	themes: z.array(overviewThemeSchema).max(limits.maxThemes),
});
export type CompanyOverviewEntry = z.infer<typeof companyOverviewEntrySchema>;

export const overviewFigureMetricSchema = z.enum([
	"revenue",
	"operating-income",
	"ordinary-income",
	"profit-attributable-to-owners",
]);
export type OverviewFigureMetric = z.infer<typeof overviewFigureMetricSchema>;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One stored annual figure as it was when the entry was written (decimal text, as stored). */
export const overviewFigureSchema = z.strictObject({
	metric: overviewFigureMetricSchema,
	fiscalYear: z.number().int().min(1900).max(2200),
	periodEnd: isoDateSchema,
	value: z.string().regex(/^-?\d+(\.\d+)?$/),
	currency: z.string().regex(/^[A-Z]{3}$/),
});
export type OverviewFigure = z.infer<typeof overviewFigureSchema>;

/**
 * The parts the server fills from its own records, as they were when the
 * entry was written, each with the source it cites (null when not stored).
 */
export const companyOverviewFactsSchema = z.strictObject({
	/** The directory listing (`nasdaq`, `tse-prime`, …). */
	listing: z.string().min(1).max(40).nullable(),
	/** A Japanese stock's TSE 33-sector (J-Quants). */
	sector: z.string().min(1).max(200).nullable(),
	/** "MM-DD" as stored. */
	fiscalYearEnd: z
		.string()
		.regex(/^\d{2}-\d{2}$/)
		.nullable(),
	figures: z.array(overviewFigureSchema).max(limits.maxFigures),
	cites: z.strictObject({
		listing: overviewSourceIdSchema.nullable(),
		sector: overviewSourceIdSchema.nullable(),
		figures: overviewSourceIdSchema.nullable(),
	}),
});
export type CompanyOverviewFacts = z.infer<typeof companyOverviewFactsSchema>;

const referenceText = z.string().trim().min(1).max(limits.maxReferenceTextChars);

/** One numbered source as the 出典 list shows it; the server built it from its records. */
export const overviewReferenceSchema = z.strictObject({
	id: overviewSourceIdSchema,
	title: z.strictObject({ en: referenceText, ja: referenceText }),
	publisher: referenceText,
	/** The day the source states its information for. */
	asOf: isoDateSchema.nullable(),
	/** A public https page, or null. */
	url: z
		.string()
		.max(2048)
		.regex(/^https:\/\//)
		.nullable(),
	/** Filing date, or why the link is a specification rather than the data. */
	note: z.strictObject({ en: referenceText, ja: referenceText }).nullable(),
});
export type OverviewReference = z.infer<typeof overviewReferenceSchema>;

/** Every source id an entry and its facts cite. */
export function citedSourceIds(
	entry: CompanyOverviewEntry,
	facts: CompanyOverviewFacts,
): Set<OverviewSourceId> {
	const ids = new Set<OverviewSourceId>();
	const add = (evidence: readonly OverviewEvidence[]) => {
		for (const item of evidence) ids.add(item.source);
	};
	if (entry.feature !== null) add(entry.feature.evidence);
	for (const item of entry.businesses) add(item.evidence);
	for (const item of entry.segments) add(item.evidence);
	if (entry.overseasSales !== null) add(entry.overseasSales.evidence);
	for (const item of entry.profile) add(item.evidence);
	for (const item of entry.themes) add(item.reason.evidence);
	for (const id of [facts.cites.listing, facts.cites.sector, facts.cites.figures]) {
		if (id !== null) ids.add(id);
	}
	return ids;
}

/**
 * A stored overview as the Stocks API returns it (`overview`): the entry,
 * the server-filled facts, the references, and who wrote it and when.
 * Every cited source is in the references, and their ids are unique.
 */
export const companyOverviewViewSchema = z
	.strictObject({
		entry: companyOverviewEntrySchema,
		facts: companyOverviewFactsSchema,
		references: z.array(overviewReferenceSchema).min(1).max(limits.maxReferences),
		agentId: agentIdSchema,
		/** The model that wrote it; null when the backend's default was used. */
		model: z.string().min(1).max(100).nullable(),
		generatedAt: isoDateTimeSchema,
	})
	.refine(
		(view) =>
			new Set(view.references.map((reference) => reference.id)).size === view.references.length,
		{ message: "reference ids must be unique", path: ["references"] },
	)
	.refine(
		(view) => {
			const known = new Set(view.references.map((reference) => reference.id));
			return [...citedSourceIds(view.entry, view.facts)].every((id) => known.has(id));
		},
		{ message: "every cited source must be in the references", path: ["references"] },
	);
export type CompanyOverviewView = z.infer<typeof companyOverviewViewSchema>;
