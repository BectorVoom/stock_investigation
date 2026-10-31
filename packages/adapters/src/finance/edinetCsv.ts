/**
 * EDINET XBRL-to-CSV reports (ADR-0048 §4, §6), pure.
 *
 * `GET /api/v2/documents/{docID}?type=5` answers a ZIP whose entries under
 * `XBRL_TO_CSV/` are CSV renderings of the filing's XBRL; the main report is
 * the entry whose file name starts with `jpcrp` (the `jpaud…` audit reports
 * are ignored). Each CSV is UTF-16 LE with a byte-order mark, tab-separated,
 * every field double-quoted (a text block value may span lines and hold
 * tabs and doubled quotes), lines ending CRLF or LF, with the header
 *   "要素ID" "項目名" "コンテキストID" "相対年度" "連結・個別" "期間・時点"
 *   "ユニットID" "単位" "値"
 * A fact is taken only from the contexts CurrentYearDuration,
 * Prior1YearDuration, CurrentYearInstant and Prior1YearInstant —
 * consolidated, or separate with the `_NonConsolidatedMember` suffix — with
 * its dates from the report's DEI elements; every segment or other
 * dimensional context is skipped.
 */
import {
	type EquityAccountingStandard,
	type EquityExtractedFact,
	type EquityScope,
	err,
	isCanonicalDecimal,
	isoDayNumber,
	ok,
	type Result,
} from "@research/domain";
import { listZipEntries, readZipEntries, type ZipLimits } from "../node/zipReader.ts";
import { annualFactsInOrder, type EdinetReportProblem } from "./equitySync.ts";

/** The download (16 MB) and one CSV entry inflated (64 MB): the largest reports stay well inside. */
export const EDINET_ZIP_LIMITS: ZipLimits = {
	maxArchiveBytes: 16_000_000,
	maxEntryBytes: 64_000_000,
};

export const EDINET_CSV_HEADER: readonly string[] = [
	"要素ID",
	"項目名",
	"コンテキストID",
	"相対年度",
	"連結・個別",
	"期間・時点",
	"ユニットID",
	"単位",
	"値",
];

const CSV_DIRECTORY = "XBRL_TO_CSV/";
const REPORT_PREFIX = "jpcrp";
const MAX_UNIT_CHARS = 40;

/* ---------- Text ---------- */

/**
 * UTF-16 LE bytes as text: a leading byte-order mark (FF FE) is dropped; an
 * odd byte count or an unpaired surrogate fails rather than being replaced.
 */
export function decodeUtf16Le(bytes: Uint8Array): Result<string, "ENCODING"> {
	const body =
		bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2) : bytes;
	if (body.length % 2 !== 0) return err("ENCODING");
	try {
		return ok(new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(body));
	} catch {
		return err("ENCODING");
	}
}

const TAB = 9;
const LF = 10;
const CR = 13;
const QUOTE = 34;

/**
 * Tab-separated rows in one linear scan. A field that starts with `"` is
 * quoted: `""` inside it is one quote, and tabs and line breaks are part of
 * it; the next lone `"` ends the quoting, and anything after it up to the
 * separator is kept as written. Rows end at LF, CRLF or a lone CR. A blank
 * line yields no row. `visit` returns false to stop early.
 */
export function forEachTsvRow(text: string, visit: (fields: readonly string[]) => boolean): void {
	let fields: string[] = [];
	let field = "";
	let quoted = false;
	let fieldStart = true;
	let rowHasContent = false;
	const endField = (): void => {
		fields.push(field);
		field = "";
		fieldStart = true;
	};
	const endRow = (): boolean => {
		endField();
		const keep = rowHasContent || fields.length > 1 || fields[0] !== "";
		const row = fields;
		fields = [];
		rowHasContent = false;
		return keep ? visit(row) : true;
	};
	const length = text.length;
	let index = 0;
	let runStart = 0;
	while (index < length) {
		const code = text.charCodeAt(index);
		if (quoted) {
			if (code === QUOTE) {
				field += text.slice(runStart, index);
				if (text.charCodeAt(index + 1) === QUOTE) {
					field += '"';
					index += 2;
				} else {
					quoted = false;
					index += 1;
				}
				runStart = index;
				continue;
			}
			index += 1;
			continue;
		}
		if (code === QUOTE && fieldStart) {
			quoted = true;
			fieldStart = false;
			rowHasContent = true;
			index += 1;
			runStart = index;
			continue;
		}
		if (code === TAB || code === LF || code === CR) {
			field += text.slice(runStart, index);
			if (code === TAB) {
				endField();
				rowHasContent = true;
				index += 1;
			} else {
				index += code === CR && text.charCodeAt(index + 1) === LF ? 2 : 1;
				if (!endRow()) return;
			}
			runStart = index;
			continue;
		}
		fieldStart = false;
		index += 1;
	}
	field += text.slice(runStart, length);
	if (rowHasContent || field !== "" || fields.length > 0) endRow();
}

/* ---------- Report ---------- */

/** The report's fiscal years as its DEI elements state them (valid dates or null). */
export interface EdinetFiscalYears {
	readonly currentStart: string | null;
	readonly currentEnd: string | null;
	readonly previousStart: string | null;
	readonly previousEnd: string | null;
}

export interface EdinetReport {
	/** `jpdei_cor:AccountingStandardsDEI`: "Japan GAAP", "IFRS", "US GAAP"; null otherwise. */
	readonly accountingStandard: EquityAccountingStandard | null;
	readonly fiscalYears: EdinetFiscalYears;
	/** Facts of the claimed concepts in the four year contexts, in row order (before the annual filter). */
	readonly facts: readonly EquityExtractedFact[];
}

const ACCOUNTING_STANDARDS: { readonly [text: string]: EquityAccountingStandard } = {
	"Japan GAAP": "JGAAP",
	IFRS: "IFRS",
	"US GAAP": "US-GAAP",
};

const DEI = {
	standard: "jpdei_cor:AccountingStandardsDEI",
	currentStart: "jpdei_cor:CurrentFiscalYearStartDateDEI",
	currentEnd: "jpdei_cor:CurrentFiscalYearEndDateDEI",
	previousStart: "jpdei_cor:PreviousFiscalYearStartDateDEI",
	previousEnd: "jpdei_cor:PreviousFiscalYearEndDateDEI",
} as const;

const SEPARATE_SUFFIX = "_NonConsolidatedMember";
type YearContext =
	| "CurrentYearDuration"
	| "Prior1YearDuration"
	| "CurrentYearInstant"
	| "Prior1YearInstant";
const YEAR_CONTEXTS: ReadonlySet<string> = new Set<YearContext>([
	"CurrentYearDuration",
	"Prior1YearDuration",
	"CurrentYearInstant",
	"Prior1YearInstant",
]);

function isYearContext(text: string): text is YearContext {
	return YEAR_CONTEXTS.has(text);
}

/** The context's year and scope, or null for any other (segment, interim, dimensional) context. */
export function edinetContext(
	contextId: string,
): { readonly context: YearContext; readonly scope: EquityScope } | null {
	if (isYearContext(contextId)) return { context: contextId, scope: "consolidated" };
	if (contextId.endsWith(SEPARATE_SUFFIX)) {
		const base = contextId.slice(0, -SEPARATE_SUFFIX.length);
		if (isYearContext(base)) return { context: base, scope: "separate" };
	}
	return null;
}

interface ConceptRow {
	readonly concept: string;
	readonly context: YearContext;
	readonly scope: EquityScope;
	readonly unit: string;
	readonly valueDecimal: string;
}

function dateOrNull(text: string): string | null {
	return isoDayNumber(text) !== null ? text : null;
}

/**
 * The DEI and the claimed concepts' year facts of one report CSV, or
 * "MISSING_HEADER" when the first row is not the documented header. A
 * concept row is skipped when its value is not canonical decimal text ("－"
 * is EDINET's nil), its unit id is empty or over 40 characters, or the DEI
 * dates its context needs are missing.
 */
export function parseEdinetCsv(
	text: string,
	concepts: readonly string[],
): Result<EdinetReport, "MISSING_HEADER"> {
	const wanted = new Set(concepts);
	// Written from the row callback: an object, so the checks after the scan see the writes.
	const state: {
		header: boolean | null;
		standard: EquityAccountingStandard | null;
		currentStart: string | null;
		currentEnd: string | null;
		previousStart: string | null;
		previousEnd: string | null;
	} = {
		header: null,
		standard: null,
		currentStart: null,
		currentEnd: null,
		previousStart: null,
		previousEnd: null,
	};
	const rows: ConceptRow[] = [];
	forEachTsvRow(text, (fields) => {
		if (state.header === null) {
			state.header =
				fields.length === EDINET_CSV_HEADER.length &&
				fields.every((field, index) => field === EDINET_CSV_HEADER[index]);
			return state.header;
		}
		if (fields.length !== EDINET_CSV_HEADER.length) return true;
		const element = fields[0] ?? "";
		const value = fields[8] ?? "";
		switch (element) {
			case DEI.standard:
				state.standard = ACCOUNTING_STANDARDS[value] ?? null;
				return true;
			case DEI.currentStart:
				state.currentStart = dateOrNull(value);
				return true;
			case DEI.currentEnd:
				state.currentEnd = dateOrNull(value);
				return true;
			case DEI.previousStart:
				state.previousStart = dateOrNull(value);
				return true;
			case DEI.previousEnd:
				state.previousEnd = dateOrNull(value);
				return true;
		}
		if (!wanted.has(element)) return true;
		const context = edinetContext(fields[2] ?? "");
		const unit = fields[6] ?? "";
		if (context === null || unit.length < 1 || unit.length > MAX_UNIT_CHARS) return true;
		if (!isCanonicalDecimal(value)) return true;
		rows.push({ concept: element, ...context, unit, valueDecimal: value });
		return true;
	});
	if (state.header !== true) return err("MISSING_HEADER");
	const accountingStandard = state.standard;
	const fiscalYears: EdinetFiscalYears = {
		currentStart: state.currentStart,
		currentEnd: state.currentEnd,
		previousStart: state.previousStart,
		previousEnd: state.previousEnd,
	};
	const facts: EquityExtractedFact[] = [];
	for (const row of rows) {
		const period = periodOf(row.context, fiscalYears);
		if (period === null) continue;
		facts.push({
			concept: row.concept,
			unit: row.unit,
			valueDecimal: row.valueDecimal,
			scope: row.scope,
			...period,
		});
	}
	return ok({ accountingStandard, fiscalYears, facts });
}

function periodOf(
	context: YearContext,
	years: EdinetFiscalYears,
): Pick<EquityExtractedFact, "periodType" | "periodStart" | "periodEnd"> | null {
	switch (context) {
		case "CurrentYearDuration":
			return years.currentStart === null || years.currentEnd === null
				? null
				: { periodType: "duration", periodStart: years.currentStart, periodEnd: years.currentEnd };
		case "Prior1YearDuration":
			return years.previousStart === null || years.previousEnd === null
				? null
				: {
						periodType: "duration",
						periodStart: years.previousStart,
						periodEnd: years.previousEnd,
					};
		case "CurrentYearInstant":
			return years.currentEnd === null
				? null
				: { periodType: "instant", periodStart: null, periodEnd: years.currentEnd };
		case "Prior1YearInstant":
			return years.previousEnd === null
				? null
				: { periodType: "instant", periodStart: null, periodEnd: years.previousEnd };
	}
}

/**
 * The main report's entry: under `XBRL_TO_CSV/` (no deeper folder), a file
 * name starting `jpcrp` and ending `.csv`; when several do, the first in
 * code-unit order. Null when there is none.
 */
export function selectEdinetReportEntry(names: readonly string[]): string | null {
	let chosen: string | null = null;
	for (const name of names) {
		if (!name.startsWith(CSV_DIRECTORY)) continue;
		const file = name.slice(CSV_DIRECTORY.length);
		if (!file.startsWith(REPORT_PREFIX) || !file.endsWith(".csv") || file.includes("/")) continue;
		if (chosen === null || name < chosen) chosen = name;
	}
	return chosen;
}

/**
 * One XBRL-to-CSV download as the report's standard and annual facts
 * (canonical order, `annualFactsOfFiling`). Any problem — an archive the
 * reader refuses, no `jpcrp` entry, undecodable text, no header — fails.
 */
export function extractEdinetReport(
	archive: Uint8Array,
	concepts: readonly string[],
): Result<
	{
		readonly accountingStandard: EquityAccountingStandard | null;
		/** The DEI fiscal years: an amendment's period when the list states none. */
		readonly fiscalYears: EdinetFiscalYears;
		readonly facts: readonly EquityExtractedFact[];
	},
	EdinetReportProblem
> {
	const names = listZipEntries(archive, EDINET_ZIP_LIMITS);
	if (!names.ok) return err("NOT_A_ZIP");
	const entry = selectEdinetReportEntry(names.value);
	if (entry === null) return err("NO_REPORT_ENTRY");
	const entries = readZipEntries(archive, [entry], EDINET_ZIP_LIMITS);
	if (!entries.ok) return err("NOT_A_ZIP");
	const bytes = entries.value.get(entry);
	if (bytes === undefined) return err("NO_REPORT_ENTRY");
	const text = decodeUtf16Le(bytes);
	if (!text.ok) return err(text.error);
	const report = parseEdinetCsv(text.value, concepts);
	if (!report.ok) return err(report.error);
	return ok({
		accountingStandard: report.value.accountingStandard,
		fiscalYears: report.value.fiscalYears,
		facts: annualFactsInOrder(report.value.facts),
	});
}
