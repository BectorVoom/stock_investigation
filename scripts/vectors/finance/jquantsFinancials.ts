/**
 * Japanese statements and company profiles from J-Quants (ADR-0059):
 * conformance vectors the Rust runner replays (`research-finance`).
 *
 * - `finance/jquants_financials.json` — `jquantsSummariesToSync`: cases
 *   `{ name, code, knownDisclosures, records, expected: { identity, filings, more } }`;
 * - `finance/jquants_profiles.json` — `jquantsMasterToProfiles`: cases
 *   `{ name, records, expected }`.
 *
 * Records are J-Quants' own answers captured live on 2026-11-02
 * (`packages/adapters/test/finance/fixtures/jquants-*.json`, each record
 * trimmed to the fields the runner reads). A case named "derived: …" edits
 * a copy of a live record to reach one rule (a skipped record, a decimal
 * form, a duplicate, the completion cap); its figures are still the live
 * record's unless the rule is about the figure's text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	jquantsMasterToProfiles,
	jquantsSummariesToSync,
} from "../../../packages/adapters/src/finance/jquantsFinancials.ts";
import type { VectorExporter, VectorFile } from "../shared.ts";
import { plain } from "./support.ts";

const FIXTURE_DIR = fileURLToPath(
	new URL("../../../packages/adapters/test/finance/fixtures/", import.meta.url),
);

type JsonRecord = Record<string, unknown>;

function fixtureRecords(name: string): JsonRecord[] {
	const parsed: unknown = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8"));
	if (typeof parsed !== "object" || parsed === null || !("data" in parsed)) {
		throw new Error(`${name}: not a J-Quants page`);
	}
	const data = parsed.data;
	if (!Array.isArray(data)) throw new Error(`${name}: no data array`);
	return data.map((row: unknown, index: number): JsonRecord => {
		if (typeof row !== "object" || row === null || Array.isArray(row)) {
			throw new Error(`${name}: record ${index} is not an object`);
		}
		return { ...row };
	});
}

function summaries(code: string): JsonRecord[] {
	return fixtureRecords(`jquants-fins-summary-code-${code}.json`);
}

function isFullYear(record: JsonRecord): boolean {
	return String(record.DocType).startsWith("FYFinancialStatements_");
}

function fullYearOf(records: readonly JsonRecord[], index = 0): JsonRecord {
	const record = records.filter(isFullYear)[index];
	if (record === undefined) throw new Error(`no full-year record ${index}`);
	return record;
}

function discNos(records: readonly JsonRecord[]): string[] {
	return records.filter(isFullYear).map((record) => String(record.DiscNo));
}

interface FinancialsCase {
	readonly name: string;
	readonly code: string;
	readonly knownDisclosures: readonly string[];
	readonly records: readonly unknown[];
}

function financialsCases(): FinancialsCase[] {
	const toyota = summaries("7203");
	const jt = summaries("2914");
	const softbank = summaries("9984");
	const mercari = summaries("4385");
	const toyotaYear = fullYearOf(toyota);
	const [jtOriginal] = discNos(jt);
	const [softbankOriginal] = discNos(softbank);
	if (jtOriginal === undefined || softbankOriginal === undefined) {
		throw new Error("fixtures lost their full-year records");
	}
	return [
		{ name: "toyota 7203 IFRS, first sync", code: "72030", knownDisclosures: [], records: toyota },
		{
			name: "toyota 7203, the older year stored",
			code: "72030",
			knownDisclosures: discNos(toyota).slice(0, 1),
			records: toyota,
		},
		{
			name: "toyota 7203, everything stored",
			code: "72030",
			knownDisclosures: discNos(toyota),
			records: toyota,
		},
		{
			name: "toyota 7203, records in reverse order",
			code: "72030",
			knownDisclosures: [],
			records: [...toyota].reverse(),
		},
		{ name: "jt 2914 IFRS correction", code: "29140", knownDisclosures: [], records: jt },
		{
			name: "jt 2914 correction after the original was stored",
			code: "29140",
			knownDisclosures: [jtOriginal],
			records: jt,
		},
		{
			name: "softbank 9984 IFRS correction",
			code: "99840",
			knownDisclosures: [],
			records: softbank,
		},
		{
			name: "softbank 9984 correction after the original was stored",
			code: "99840",
			knownDisclosures: [softbankOriginal],
			records: softbank,
		},
		{
			name: "mufg 8306 JGAAP bank (no OP)",
			code: "83060",
			knownDisclosures: [],
			records: summaries("8306"),
		},
		{
			name: "nomura 8604 US-GAAP",
			code: "86040",
			knownDisclosures: [],
			records: summaries("8604"),
		},
		{ name: "kyokuyo 1301 JGAAP", code: "13010", knownDisclosures: [], records: summaries("1301") },
		{ name: "sony 6758 IFRS", code: "67580", knownDisclosures: [], records: summaries("6758") },
		{
			name: "nintendo 7974 JGAAP",
			code: "79740",
			knownDisclosures: [],
			records: summaries("7974"),
		},
		{
			name: "mercari 4385 IFRS with an earnings forecast revision",
			code: "43850",
			knownDisclosures: [],
			records: mercari,
		},
		{
			name: "mercari 4385 without its full-year records (revisions and quarters only)",
			code: "43850",
			knownDisclosures: [],
			records: mercari.filter((record) => !isFullYear(record)),
		},
		{
			name: "non-consolidated 96250 (2026-05-14 day answer)",
			code: "96250",
			knownDisclosures: [],
			records: fixtureRecords("jquants-fins-summary-date-2026-05-14-code-96250.json"),
		},
		{
			name: "empty answer 99999",
			code: "99990",
			knownDisclosures: [],
			records: fixtureRecords("jquants-fins-summary-code-99999.json"),
		},
		{
			name: "derived: records the rules skip",
			code: "72030",
			knownDisclosures: [],
			records: [
				null,
				7203,
				"FYFinancialStatements_Consolidated_IFRS",
				[toyotaYear],
				{ ...toyotaYear, DiscNo: "2025050812345" },
				{ ...toyotaYear, DiscNo: 20250508123456 },
				{ ...toyotaYear, DiscNo: "20250508x23456" },
				{ ...toyotaYear, DocType: "fyFinancialStatements_Consolidated_IFRS" },
				{ ...toyotaYear, DocType: undefined },
				{ ...toyotaYear, DiscDate: "2025-02-30" },
				{ ...toyotaYear, DiscTime: null },
				{ ...toyotaYear, CurFYSt: "2024/04/01" },
				{ ...toyotaYear, CurFYEn: "" },
				{ ...toyotaYear, CurPerSt: "2025-04-01" },
				{ ...toyotaYear, CurFYSt: "2025-04-01" },
				{ ...toyotaYear, CurPerEn: "2025-03-32" },
			],
		},
		{
			name: "derived: amounts as text in other forms",
			code: "72030",
			knownDisclosures: [],
			records: [
				{
					...toyotaYear,
					Sales: "+0048036704000000",
					OP: "4795586000000.000",
					OdP: "-0",
					NP: "4.765086E12",
					TA: ".5",
					Eq: "5.",
					CashEq: " 8982404000000",
					CFO: 3696934000000,
					CFI: "-0003.10",
					CFF: "1,000",
					NCSales: "0",
					NCOP: "-0.000",
					NCNP: "00",
				},
			],
		},
		{
			name: "derived: a disclosure listed twice, an unreadable time, another standard",
			code: "72030",
			knownDisclosures: [],
			records: [
				toyotaYear,
				toyotaYear,
				{
					...toyotaYear,
					DiscNo: "20250601000001",
					DiscDate: "2025-06-01",
					DiscTime: "9:00",
					DocType: "FYFinancialStatements_Consolidated_JMIS",
				},
				{
					...toyotaYear,
					DiscNo: "20250601000002",
					DiscDate: "2025-06-01",
					DiscTime: "24:00:00",
				},
				{
					...toyotaYear,
					DiscNo: "20250601000000",
					DiscDate: "2025-06-01",
					DiscTime: "23:59:59",
				},
			],
		},
		{
			name: "derived: the completion cap keeps the newest 60 summaries",
			code: "72030",
			knownDisclosures: [],
			records: Array.from({ length: 62 }, (_, index) => ({
				...toyotaYear,
				DiscNo: `202505${String(index + 1).padStart(8, "0")}`,
				DiscDate: `2025-05-${String((index % 28) + 1).padStart(2, "0")}`,
			})),
		},
	];
}

function profilesCases(): { readonly name: string; readonly records: readonly unknown[] }[] {
	const master = fixtureRecords("jquants-equities-master-trimmed.json");
	const toyota = master.find((record) => record.Code === "72030");
	if (toyota === undefined) throw new Error("the master fixture lost 72030");
	return [
		{ name: "trimmed master (live, 2026-11-02)", records: master },
		{ name: "empty master", records: [] },
		{
			name: "derived: an empty English name",
			records: [{ ...toyota, CoNameEn: "" }],
		},
		{
			name: "derived: a duplicate keeps the first",
			records: [toyota, { ...toyota, CoNameEn: "TOYOTA MOTOR CORP. (second row)" }],
		},
		{
			name: "derived: records the rules skip, then a valid duplicate",
			records: [
				null,
				"72030",
				[toyota],
				{ ...toyota, Code: "7203" },
				{ ...toyota, Code: "720300" },
				{ ...toyota, Code: "72035" },
				{ ...toyota, Code: "a2030" },
				{ ...toyota, Code: 72030 },
				{ ...toyota, CoNameEn: null },
				{ ...toyota, S17: "" },
				{ ...toyota, S17Nm: " " },
				{ ...toyota, S33: "123456789" },
				{ ...toyota, S33Nm: undefined },
				{ ...toyota, ScaleCat: "" },
				{ ...toyota, Mkt: "" },
				{ ...toyota, MktNm: "x".repeat(201) },
				{ ...toyota, Date: "2026-02-30" },
				{ ...toyota, Date: "20260810" },
				toyota,
			],
		},
	];
}

export const jquantsFinancialsExporter: VectorExporter = {
	name: "jquants-financials",
	async build(): Promise<readonly VectorFile[]> {
		return [
			{
				path: "finance/jquants_financials.json",
				content: financialsCases().map((entry) => ({
					...entry,
					records: plain(entry.records),
					expected: plain(
						jquantsSummariesToSync(entry.code, entry.knownDisclosures, entry.records),
					),
				})),
			},
			{
				path: "finance/jquants_profiles.json",
				content: profilesCases().map((entry) => ({
					...entry,
					records: plain(entry.records),
					expected: plain(jquantsMasterToProfiles(entry.records)),
				})),
			},
		];
	},
};
