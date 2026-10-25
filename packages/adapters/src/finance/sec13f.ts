/**
 * Form 13F-HR holdings of an institutional investment manager, from SEC EDGAR
 * (FR-008, DATA-007).
 *
 * Endpoints (official, free):
 *   https://data.sec.gov/submissions/CIK##########.json       filing index of the manager
 *   https://www.sec.gov/Archives/edgar/data/{cik}/{accession-without-dashes}/{accession}.txt
 *       the complete submission text file; the information table is the
 *       <DOCUMENT> whose <TYPE> is "INFORMATION TABLE", as XML.
 *
 * What a 13F is, and is not: a list of positions HELD AT QUARTER END, filed up
 * to 45 days later. It carries no trade dates and no prices paid. This adapter
 * therefore only ever reports quantities and a quarter-over-quarter comparison
 * classified by the domain's `classifyReportedPositionChange`; it never says
 * "bought" or "sold".
 *
 * Rules applied here:
 *  - Only form "13F-HR" exactly. Amendments ("13F-HR/A") and notices
 *    ("13F-NT") are ignored, so a restated quarter is NOT reflected.
 *  - "Two most recent" means the two latest distinct report periods.
 *  - Share amounts are summed per CUSIP over rows whose amount type is "SH"
 *    and which are not option rows (`putCall` absent). Principal-amount rows
 *    ("PRN", debt) and put/call rows are excluded and counted, because they
 *    are not share holdings.
 *  - INCOMPLETE FILINGS: a row that cannot be read (bad CUSIP, share count,
 *    value or amount type) is never silently dropped from the picture. The
 *    CUSIP it belongs to is left out of that filing's holdings (a total built
 *    from its other rows would be understated) and is listed in
 *    `incompleteCusips`. And because an unread row may belong to ANY position,
 *    a filing with even one such row is not compared at all: no change
 *    classification is produced against it, in either direction, and the
 *    reason is reported instead. A position is called "no longer reported"
 *    only when every row of both filings was read.
 *  - VALUE UNITS: Form 13F reported value in thousands of dollars until the
 *    amended form took effect on 2023-01-03; filings made on or after that
 *    date report whole dollars. The unit is decided by the FILING date, and
 *    older filings are converted (x1000).
 *    Basis: the SEC's 2022 amendments to Form 13F, as summarised by filing
 *    agents, which state that the reports for the quarter ended 2022-12-31
 *    (filed in early 2023) were the first to use whole dollars — i.e. the
 *    cutover follows the date of filing, not the period reported.
 *    Uncertainty: this was NOT checked against the SEC's own FAQ or release
 *    text (sec.gov was not reachable when this was written), and the only
 *    filings where the two readings differ are those filed on or after
 *    2023-01-03 for a period ending before it. Individual filers have also
 *    been known to use the wrong unit; that cannot be detected here.
 *  - A CUSIP change (merger, reorganisation) shows up as one position no
 *    longer reported plus one newly reported; this adapter does not link them.
 *  - The submissions API lists only a manager's most recent filings; a 13F-HR
 *    older than that window is not found.
 */
import {
	classifyReportedPositionChange,
	err,
	ok,
	type ReportedPositionChange,
	type Result,
} from "@research/domain";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { z } from "zod";
import { childrenOf, firstNodeOf, isXmlNode, textOf } from "../feed/xmlTree.ts";
import { createBoundedCache } from "./boundedCache.ts";
import {
	normalizeCik,
	parseSecJson,
	type SecClient,
	type SecError,
	secCancelledError,
	secError,
} from "./secClient.ts";

export const FORM_13F_HR = "13F-HR";
/** First filing date on which the amended Form 13F (whole-dollar values) applied. */
export const FORM_13F_WHOLE_DOLLAR_FROM = "2023-01-03";

const SUBMISSIONS_MAX_BYTES = 8_000_000;
/** Larger information tables (index-fund complexes) are refused rather than half-read. */
const FILING_MAX_BYTES = 16_000_000;
const MAX_FIELD_CHARS = 400;

export function secSubmissionsUrl(cik: string): string {
	return `https://data.sec.gov/submissions/CIK${cik}.json`;
}

export function secFilingTextUrl(cik: string, accessionNumber: string): string {
	const folder = accessionNumber.replace(/-/g, "");
	return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${folder}/${accessionNumber}.txt`;
}

/* ---------- Vendor-shaped records (DATA-012) ---------- */

const submissionsSchema = z.object({
	name: z.string().min(1),
	filings: z.object({
		recent: z.object({
			accessionNumber: z.array(z.string()),
			filingDate: z.array(z.string()),
			reportDate: z.array(z.string()),
			form: z.array(z.string()),
		}),
	}),
});

const accessionSchema = z.string().regex(/^\d{10}-\d{2}-\d{6}$/);

const cusipSchema = z
	.string()
	.trim()
	.regex(/^[0-9A-Za-z]{9}$/);

const shareRowSchema = z.object({
	nameOfIssuer: z.string().trim().min(1).max(300),
	value: z.string().regex(/^\d+(\.\d+)?$/),
	shares: z.string().regex(/^\d+(\.\d+)?$/),
});

/* ---------- Normalized output ---------- */

export interface FilingRef {
	readonly accessionNumber: string;
	/** Quarter end the holdings are reported as of (YYYY-MM-DD). */
	readonly reportPeriodEnd: string;
	/** Date the filing was made (YYYY-MM-DD). */
	readonly filedAt: string;
}

export interface Reported13FHolding {
	readonly issuerName: string;
	readonly cusip: string;
	readonly reportedShares: number;
	/** Whole US dollars, converted from thousands for pre-2023 filings. */
	readonly reportedValueUsd: number;
}

export interface Sec13FFiling extends FilingRef {
	readonly form: typeof FORM_13F_HR;
	/** The complete submission text file that was retrieved. */
	readonly filingUrl: string;
	/**
	 * One entry per CUSIP whose rows were all read, largest reported value first.
	 * Complete only when `unreadableRowCount` is 0.
	 */
	readonly holdings: readonly Reported13FHolding[];
	readonly valueUnitAsFiled: "usd" | "usd-thousands";
	/** Rows left out of the share totals: options (put/call) and principal amounts. */
	readonly excludedRowCount: number;
	/** Rows that could not be read. Any value above 0 means the holdings are incomplete. */
	readonly unreadableRowCount: number;
	/** CUSIPs left out of `holdings` because one of their rows could not be read. */
	readonly incompleteCusips: readonly string[];
}

export interface ReportedPositionComparison {
	readonly cusip: string;
	readonly issuerName: string;
	readonly previousReportedShares: number | null;
	readonly currentReportedShares: number | null;
	readonly change: ReportedPositionChange;
}

export interface Sec13FReport {
	readonly manager: { readonly cik: string; readonly name: string };
	readonly submissionsUrl: string;
	readonly current: Sec13FFiling;
	/** null when the manager has only one 13F-HR in SEC's recent-filings window. */
	readonly previous: Sec13FFiling | null;
	/** Empty whenever `comparisonUnavailableReason` is set. */
	readonly changes: readonly ReportedPositionComparison[];
	/**
	 * Why no quarter-over-quarter comparison was made: there is no previous
	 * filing, or one of the two filings has rows that could not be read.
	 * null when `changes` is a complete comparison.
	 */
	readonly comparisonUnavailableReason: string | null;
}

export interface Sec13FSource {
	latestHoldings(managerCik: string, signal?: AbortSignal): Promise<Result<Sec13FReport, SecError>>;
}

/* ---------- Pure parsing ---------- */

/** The two latest distinct report periods filed on form 13F-HR, newest first. */
export function selectRecent13FFilings(
	submissions: unknown,
): Result<{ readonly managerName: string; readonly filings: readonly FilingRef[] }, SecError> {
	const parsed = submissionsSchema.safeParse(submissions);
	if (!parsed.success) {
		return err(secError("UNEXPECTED_RESPONSE", "SEC submissions have an unexpected shape"));
	}
	const { accessionNumber, filingDate, reportDate, form } = parsed.data.filings.recent;
	const candidates: FilingRef[] = [];
	form.forEach((formType, index) => {
		if (formType !== FORM_13F_HR) return;
		const accession = accessionSchema.safeParse(accessionNumber[index]);
		const filed = z.iso.date().safeParse(filingDate[index]);
		const period = z.iso.date().safeParse(reportDate[index]);
		if (!accession.success || !filed.success || !period.success) return;
		candidates.push({
			accessionNumber: accession.data,
			reportPeriodEnd: period.data,
			filedAt: filed.data,
		});
	});
	candidates.sort(
		(a, b) =>
			b.reportPeriodEnd.localeCompare(a.reportPeriodEnd) ||
			b.filedAt.localeCompare(a.filedAt) ||
			b.accessionNumber.localeCompare(a.accessionNumber),
	);
	const filings: FilingRef[] = [];
	for (const candidate of candidates) {
		if (filings.some((kept) => kept.reportPeriodEnd === candidate.reportPeriodEnd)) continue;
		filings.push(candidate);
		if (filings.length === 2) break;
	}
	return ok({ managerName: parsed.data.name.trim(), filings });
}

/** Pulls the information-table XML out of an EDGAR complete submission text file. */
export function extractInformationTableXml(submissionText: string): string | null {
	for (const segment of submissionText.split("<DOCUMENT>").slice(1)) {
		const type = /<TYPE>([^\r\n<]*)/.exec(segment)?.[1]?.trim().toUpperCase();
		if (type !== "INFORMATION TABLE") continue;
		const start = segment.indexOf("<XML>");
		const end = segment.indexOf("</XML>");
		if (start === -1 || end <= start) return null;
		return segment.slice(start + "<XML>".length, end).trim();
	}
	return null;
}

const informationTableParser = new XMLParser({
	ignoreAttributes: true,
	// Filers use arbitrary namespace prefixes ("ns1:infoTable"); the local names are fixed.
	removeNSPrefix: true,
	processEntities: false,
	htmlEntities: false,
	parseTagValue: false,
	trimValues: true,
	ignoreDeclaration: true,
	ignorePiTags: true,
	maxNestedTags: 16,
});

interface ParsedInformationTable {
	/** Only CUSIPs whose rows were all read. */
	readonly holdings: readonly {
		readonly issuerName: string;
		readonly cusip: string;
		readonly reportedShares: number;
		readonly valueAsFiled: number;
	}[];
	readonly excludedRowCount: number;
	readonly unreadableRowCount: number;
	/** CUSIPs that had at least one unreadable row, sorted. */
	readonly incompleteCusips: readonly string[];
}

type InfoTableRow =
	/** Not even the CUSIP could be read, so the row may belong to any position. */
	| { readonly kind: "unreadable"; readonly cusip: string | null }
	/** An option or principal-amount row: read, and deliberately not a share holding. */
	| { readonly kind: "excluded" }
	| {
			readonly kind: "shares";
			readonly cusip: string;
			readonly issuerName: string;
			readonly reportedShares: number;
			readonly valueAsFiled: number;
	  };

function readInfoTableRow(rawRow: unknown): InfoTableRow {
	if (!isXmlNode(rawRow)) return { kind: "unreadable", cusip: null };
	const parsedCusip = cusipSchema.safeParse(textOf(rawRow.cusip, MAX_FIELD_CHARS) ?? "");
	if (!parsedCusip.success) return { kind: "unreadable", cusip: null };
	const cusip = parsedCusip.data.toUpperCase();
	const amount = firstNodeOf(rawRow, ["shrsOrPrnAmt"]);
	const amountType =
		amount === null ? null : (textOf(amount.sshPrnamtType, MAX_FIELD_CHARS)?.toUpperCase() ?? null);
	const isOption = textOf(rawRow.putCall, MAX_FIELD_CHARS) !== null;
	// What kind of row it is decides whether its numbers matter at all.
	if (isOption || amountType === "PRN") return { kind: "excluded" };
	if (amount === null || amountType !== "SH") return { kind: "unreadable", cusip };
	const row = shareRowSchema.safeParse({
		nameOfIssuer: textOf(rawRow.nameOfIssuer, MAX_FIELD_CHARS) ?? "",
		value: textOf(rawRow.value, MAX_FIELD_CHARS) ?? "",
		shares: textOf(amount.sshPrnamt, MAX_FIELD_CHARS) ?? "",
	});
	if (!row.success) return { kind: "unreadable", cusip };
	return {
		kind: "shares",
		cusip,
		issuerName: row.data.nameOfIssuer,
		reportedShares: Number(row.data.shares),
		valueAsFiled: Number(row.data.value),
	};
}

/**
 * Parses a 13F information table and aggregates share holdings per CUSIP.
 * A CUSIP with any unreadable row is reported in `incompleteCusips` and has no
 * holding: its readable rows alone would understate the position.
 */
export function parseInformationTable(xml: string): Result<ParsedInformationTable, SecError> {
	const malformed = err(
		secError("UNEXPECTED_RESPONSE", "13F information table is not the expected XML"),
	);
	let document: unknown;
	try {
		if (XMLValidator.validate(xml) !== true) return malformed;
		document = informationTableParser.parse(xml);
	} catch {
		return malformed;
	}
	const table = isXmlNode(document) ? firstNodeOf(document, ["informationTable"]) : null;
	if (table === null) return malformed;

	const byCusip = new Map<
		string,
		{ issuerName: string; cusip: string; reportedShares: number; valueAsFiled: number }
	>();
	const incomplete = new Set<string>();
	let excludedRowCount = 0;
	let unreadableRowCount = 0;
	for (const rawRow of childrenOf(table, ["infoTable"])) {
		const row = readInfoTableRow(rawRow);
		if (row.kind === "excluded") {
			excludedRowCount += 1;
			continue;
		}
		if (row.kind === "unreadable") {
			unreadableRowCount += 1;
			if (row.cusip !== null) incomplete.add(row.cusip);
			continue;
		}
		const existing = byCusip.get(row.cusip);
		if (existing === undefined) {
			byCusip.set(row.cusip, {
				issuerName: row.issuerName,
				cusip: row.cusip,
				reportedShares: row.reportedShares,
				valueAsFiled: row.valueAsFiled,
			});
		} else {
			existing.reportedShares += row.reportedShares;
			existing.valueAsFiled += row.valueAsFiled;
		}
	}
	return ok({
		holdings: [...byCusip.values()].filter((holding) => !incomplete.has(holding.cusip)),
		excludedRowCount,
		unreadableRowCount,
		incompleteCusips: [...incomplete].sort(),
	});
}

/** Quarter-over-quarter comparison per CUSIP; classification is the domain's alone. */
export function compareReportedPositions(
	previous: readonly Reported13FHolding[],
	current: readonly Reported13FHolding[],
): readonly ReportedPositionComparison[] {
	const previousByCusip = new Map(previous.map((holding) => [holding.cusip, holding]));
	const currentByCusip = new Map(current.map((holding) => [holding.cusip, holding]));
	const cusips = [...new Set([...currentByCusip.keys(), ...previousByCusip.keys()])];
	return cusips.map((cusip) => {
		const before = previousByCusip.get(cusip);
		const after = currentByCusip.get(cusip);
		const previousReportedShares = before?.reportedShares ?? null;
		const currentReportedShares = after?.reportedShares ?? null;
		return {
			cusip,
			issuerName: after?.issuerName ?? before?.issuerName ?? cusip,
			previousReportedShares,
			currentReportedShares,
			change: classifyReportedPositionChange(previousReportedShares, currentReportedShares),
		};
	});
}

function toFiling(ref: FilingRef, filingUrl: string, table: ParsedInformationTable): Sec13FFiling {
	const filedInWholeDollars = ref.filedAt >= FORM_13F_WHOLE_DOLLAR_FROM;
	const holdings = table.holdings
		.map((holding) => ({
			issuerName: holding.issuerName,
			cusip: holding.cusip,
			reportedShares: holding.reportedShares,
			reportedValueUsd: filedInWholeDollars ? holding.valueAsFiled : holding.valueAsFiled * 1000,
		}))
		.sort((a, b) => b.reportedValueUsd - a.reportedValueUsd || a.cusip.localeCompare(b.cusip));
	return {
		...ref,
		form: FORM_13F_HR,
		filingUrl,
		holdings,
		valueUnitAsFiled: filedInWholeDollars ? "usd" : "usd-thousands",
		excludedRowCount: table.excludedRowCount,
		unreadableRowCount: table.unreadableRowCount,
		incompleteCusips: table.incompleteCusips,
	};
}

function describeFilingRef(filing: FilingRef): string {
	return `the filing for ${filing.reportPeriodEnd} (accession ${filing.accessionNumber})`;
}

/**
 * A comparison is only meaningful between two filings read in full. Returns
 * why one cannot be made, or null when it can.
 */
function comparisonObstacle(current: Sec13FFiling, previous: Sec13FFiling | null): string | null {
	if (previous === null) {
		return "no previous 13F-HR filing was found among this filer's recent SEC submissions";
	}
	const incomplete = [current, previous].filter((filing) => filing.unreadableRowCount > 0);
	if (incomplete.length === 0) return null;
	const which = incomplete
		.map((filing) => `${filing.unreadableRowCount} row(s) of ${describeFilingRef(filing)}`)
		.join(" and ");
	return `${which} could not be read, so its holdings are incomplete and no change in reported positions is stated`;
}

/* ---------- Source ---------- */

/**
 * Parsed filings kept per source (ADR-0039): a quarter's comparison needs two
 * per manager, and each one can be up to 16 MB of text to download again.
 */
export const SEC_13F_FILING_CACHE_ENTRIES = 32;
/** The filing cache has no TTL, so it needs no clock: every stamp is this. */
const NO_TTL_STAMP = 0;

function sameFilingRef(a: FilingRef, b: FilingRef): boolean {
	return (
		a.accessionNumber === b.accessionNumber &&
		a.reportPeriodEnd === b.reportPeriodEnd &&
		a.filedAt === b.filedAt
	);
}

export function createSec13FSource(deps: { readonly client: SecClient }): Sec13FSource {
	// Parsed filings by normalised CIK and accession number. A filing never
	// changes once filed, so no TTL; only successful parses enter. The
	// submissions index stays uncached, so a new filing shows up at once.
	const filings = createBoundedCache<string, Sec13FFiling>(SEC_13F_FILING_CACHE_ENTRIES, null);

	/** The parsed filing, from the cache when this accession was read before. */
	async function loadFiling(
		cik: string,
		ref: FilingRef,
		signal: AbortSignal | undefined,
	): Promise<Result<Sec13FFiling, SecError>> {
		const key = `${cik} ${ref.accessionNumber}`;
		const cached = filings.get(key, NO_TTL_STAMP);
		// The submissions index describes an accession the same way every
		// time; should it ever differ, the filing is read again.
		if (cached !== undefined && sameFilingRef(cached, ref)) {
			// A real fetch fails once the job is stopped; a cache hit must too.
			if (signal?.aborted === true) return err(secCancelledError());
			return ok(cached);
		}
		const parsed = await parseFiling(cik, ref, signal);
		if (parsed.ok) filings.set(key, parsed.value, NO_TTL_STAMP);
		return parsed;
	}

	async function parseFiling(
		cik: string,
		ref: FilingRef,
		signal: AbortSignal | undefined,
	): Promise<Result<Sec13FFiling, SecError>> {
		const document = await deps.client.fetchDocument(secFilingTextUrl(cik, ref.accessionNumber), {
			maxBytes: FILING_MAX_BYTES,
			accept: "text/plain",
			...(signal === undefined ? {} : { signal }),
		});
		if (!document.ok) return document;
		const xml = extractInformationTableXml(document.value.text);
		if (xml === null) {
			return err(
				secError("UNEXPECTED_RESPONSE", "13F-HR submission contains no information table document"),
			);
		}
		const table = parseInformationTable(xml);
		if (!table.ok) return table;
		return ok(toFiling(ref, document.value.url, table.value));
	}

	return {
		async latestHoldings(managerCik, signal) {
			const cik = normalizeCik(managerCik);
			if (cik === null) return err(secError("INVALID_IDENTIFIER", "managerCik is not a CIK"));
			const submissions = await deps.client.fetchDocument(secSubmissionsUrl(cik), {
				maxBytes: SUBMISSIONS_MAX_BYTES,
				accept: "application/json",
				...(signal === undefined ? {} : { signal }),
			});
			if (!submissions.ok) return submissions;
			const json = parseSecJson(submissions.value);
			if (!json.ok) return json;
			const recent = selectRecent13FFilings(json.value);
			if (!recent.ok) return recent;
			const [currentRef, previousRef] = recent.value.filings;
			if (currentRef === undefined) {
				return err(
					secError("NO_DATA", "no 13F-HR filing among this filer's recent SEC submissions"),
				);
			}
			const current = await loadFiling(cik, currentRef, signal);
			if (!current.ok) return current;
			let previous: Sec13FFiling | null = null;
			if (previousRef !== undefined) {
				const loaded = await loadFiling(cik, previousRef, signal);
				if (!loaded.ok) return loaded;
				previous = loaded.value;
			}
			const comparisonUnavailableReason = comparisonObstacle(current.value, previous);
			return ok({
				manager: { cik, name: recent.value.managerName },
				submissionsUrl: submissions.value.url,
				current: current.value,
				previous,
				changes:
					previous === null || comparisonUnavailableReason !== null
						? []
						: compareReportedPositions(previous.holdings, current.value.holdings),
				comparisonUnavailableReason,
			});
		},
	};
}
