/**
 * The financial statement sync (ADR-0048): conformance vectors the Rust
 * runner replays (crates `research-domain`, `research-finance`,
 * `research-runner`). Expected values come from the TypeScript reference:
 *
 * - `domain/equity_financials.json` — `isCanonicalDecimal`,
 *   `isAnnualDuration`, `fiscalYearOfPeriodEnd`, `annualFactsOfFiling`, and
 *   the SEC JSON-number → decimal text rule (`secValueDecimal`);
 * - `finance/equity_sync_shared.json` — failure mapping, canonical fact
 *   order, completion caps, the business description of a report and the
 *   newer of two (ADR-0053);
 * - `finance/equity_sync_sec.json` — submissions, company facts, the SEC
 *   sync result; the newest 10-K, the 10-K section finder (Markdown block
 *   → text, block → mark, Markdown → cleaned blocks → paragraphs) and the
 *   whole description of a primary document (HTML in);
 * - `finance/equity_sync_edinet.json` — date lists, identity, download plan
 *   (by the shared index, ADR-0058 §4), UTF-16, TSV, CSV (the 事業の内容 text
 *   block included), report entry, report extraction, 事業の内容 paragraphs;
 * - `finance/equity_sync_sources.json` — whole source runs over a URL-keyed
 *   scripted fetcher (requests, pacing grants, results);
 * - `finance/equity_sync_jobs.json` — the runner's `financial-sync` body
 *   (completion, log lines, pacing keys) over scripted source answers.
 *
 * Inputs that are fixture files are named, not inlined
 * (`{"fixture": "<name>"}` under examples/fixtures/equity-sync/); the build
 * first checks those files are what `equitySyncFixtures.ts` generates.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SafeFetchError } from "@research/application";
import type {
	ClaimedJob,
	EdinetKnownFiling,
	EquityBusinessDescription,
	EquityBusinessSource,
	EquityFilingResult,
	EquityPendingFiling,
	SecSyncRequest,
} from "@research/contracts";
import { EQUITY_SYNC_FAILURE_CODES, equityBusinessDescriptionSchema } from "@research/contracts";
import {
	annualFactsOfFiling,
	type EquityExtractedFact,
	type EquityProvider,
	equityConceptsOfProvider,
	err,
	filingStaysPending,
	fiscalYearOfPeriodEnd,
	isAnnualDuration,
	isCanonicalDecimal,
	isoDateOfDayNumber,
	isoDayNumber,
	ok,
	type Result,
} from "@research/domain";
import type { EventLogger, LogFields } from "@research/effects";
import { executeJob } from "../../../apps/runner/src/jobExecution.ts";
import type { MarketRequestPacer } from "../../../apps/runner/src/marketPacing.ts";
import { createDeps, createFakeApi } from "../../../apps/runner/test/support.ts";
import {
	decodeUtf16Le,
	EDINET_CSV_HEADER,
	edinetBusinessParagraphs,
	edinetContext,
	extractEdinetReport,
	forEachTsvRow,
	parseEdinetCsv,
	selectEdinetReportEntry,
} from "../../../packages/adapters/src/finance/edinetCsv.ts";
import {
	type EdinetAnnualRow,
	edinetDocumentUrl,
	edinetDownloadPlan,
	edinetErrorStatus,
	edinetIdentity,
	parseEdinetDocumentList,
} from "../../../packages/adapters/src/finance/edinetDocuments.ts";
import { createEdinetSource } from "../../../packages/adapters/src/finance/edinetSync.ts";
import {
	annualFactsInOrder,
	businessDescriptionOf,
	compareFacts,
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncSource,
	equitySyncCodeOfStatus,
	equitySyncFailureOfFetch,
	fitCompletionCaps,
	isRetryableEquitySyncFailure,
	newerBusinessDescription,
} from "../../../packages/adapters/src/finance/equitySync.ts";
import {
	createSecAnnualFilingsSource,
	equitySyncFailureOfSec,
	indexSecCompanyFacts,
	parseSecSubmissions,
	type SecFactsIndex,
	type SecSubmissionRow,
	type SecSubmissions,
	secAnnualReportDescription,
	secAnnualReportSource,
	secFilingFacts,
	secFilingUrl,
	secNeedsCompanyFacts,
	secNewestAnnualReport,
	secSyncResult,
	secValueDecimal,
} from "../../../packages/adapters/src/finance/secAnnualFilings.ts";
import {
	SEC_BUSINESS_SECTIONS,
	secBlock,
	secBusinessBlocks,
	secBusinessParagraphs,
	secSectionMark,
} from "../../../packages/adapters/src/finance/secBusiness.ts";
import { type SecErrorCode, secError } from "../../../packages/adapters/src/finance/secClient.ts";
import { SEC_TICKER_DIRECTORY_URL } from "../../../packages/adapters/src/finance/secFinancials.ts";
import { listZipEntries, readZipEntries } from "../../../packages/adapters/src/node/zipReader.ts";
import { htmlToMarkdown } from "../../../packages/adapters/src/tools/htmlToMarkdown.ts";
import { buildTestZip } from "../../../packages/adapters/test/zipTestUtils.ts";
import { doubleBits, randomDouble, type VectorExporter, type VectorFile } from "../shared.ts";
import {
	EDINET_FIXTURE_DOCUMENTS,
	EQUITY_SYNC_FIXTURE_DIR,
	edinetBusinessText,
	edinetFixtureDates,
	edinetIndexedFilings,
	edinetReportCsv,
	equitySyncFixtureFiles,
	SEC_EQUITY_FIXTURE_CIK,
	SEC_EQUITY_FIXTURE_FILINGS,
	SEC_FIXTURE_TEN_K,
	SEC_FOREIGN_FIXTURE_CIK,
	SEC_FOREIGN_FIXTURE_TWENTY_F,
} from "./equitySyncFixtures.ts";
import { base64, normalizeCall, plain, type RecordedCall, Rng } from "./support.ts";

const SEC_CONCEPTS = equityConceptsOfProvider("sec");
const EDINET_CONCEPTS = equityConceptsOfProvider("edinet");
const SEC_CIK = "0009999981";
const SUBMISSIONS = `sec-submissions-CIK${SEC_CIK}.synthetic.json`;
const COMPANY_FACTS = `sec-companyfacts-CIK${SEC_CIK}.synthetic.json`;
const EQUITY_SUBMISSIONS = `sec-submissions-CIK${SEC_EQUITY_FIXTURE_CIK}.synthetic.json`;
const FOREIGN_SUBMISSIONS = `sec-submissions-CIK${SEC_FOREIGN_FIXTURE_CIK}.synthetic.json`;
const FOREIGN_COMPANY_FACTS = `sec-companyfacts-CIK${SEC_FOREIGN_FIXTURE_CIK}.synthetic.json`;
const EQUITY_COMPANY_FACTS = `sec-companyfacts-CIK${SEC_EQUITY_FIXTURE_CIK}.synthetic.json`;

function fixtureText(name: string): string {
	return readFileSync(join(EQUITY_SYNC_FIXTURE_DIR, name), "utf8");
}
function fixtureJson(name: string): unknown {
	return JSON.parse(fixtureText(name));
}
function fixtureBytes(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(EQUITY_SYNC_FIXTURE_DIR, name)));
}

function resultJson<T, E>(result: Result<T, E>): unknown {
	return result.ok ? { ok: plain(result.value) } : { err: plain(result.error) };
}

/* ---------- Fixture freshness ---------- */

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Committed fixtures equal a fresh build (ZIPs by entry names and contents). */
function checkFixtures(): void {
	const stale: string[] = [];
	for (const file of equitySyncFixtureFiles()) {
		if (file.text !== undefined) {
			let committed: string | null = null;
			try {
				committed = fixtureText(file.name);
			} catch {
				committed = null;
			}
			if (committed !== file.text) stale.push(file.name);
			continue;
		}
		if (file.bytes === undefined) continue;
		const fresh = file.bytes;
		let committed: Uint8Array;
		try {
			committed = fixtureBytes(file.name);
		} catch {
			stale.push(file.name);
			continue;
		}
		const names = listZipEntries(committed);
		const freshNames = listZipEntries(fresh);
		if (!names.ok || !freshNames.ok || names.value.join("\n") !== freshNames.value.join("\n")) {
			stale.push(file.name);
			continue;
		}
		const a = readZipEntries(committed, names.value);
		const b = readZipEntries(fresh, names.value);
		if (
			!a.ok ||
			!b.ok ||
			names.value.some(
				(name) =>
					!sameBytes(a.value.get(name) ?? new Uint8Array(), b.value.get(name) ?? new Uint8Array(1)),
			)
		) {
			stale.push(file.name);
		}
	}
	if (stale.length > 0) {
		throw new Error(
			`stale equity-sync fixtures (run: node scripts/vectors/finance/equitySyncFixtures.ts): ${stale.join(", ")}`,
		);
	}
}

/* ---------- Domain ---------- */

function randomText(rng: Rng, alphabet: string, max: number): string {
	return Array.from({ length: rng.int(0, max) }, () => rng.pick([...alphabet])).join("");
}

function randomDate(rng: Rng, from = 7_000, to = 22_000): string {
	return isoDateOfDayNumber(rng.int(from, to));
}

function domainFile(): VectorFile {
	const rng = new Rng(0xe9f1);
	const decimals = [
		"0",
		"-0",
		"1",
		"-1",
		"10",
		"01",
		"1.0",
		"1.5",
		"-1.50",
		"0.5",
		".5",
		"5.",
		"1e3",
		"1E3",
		"+1",
		"- 1",
		"",
		" 1",
		"1 ",
		"１",
		"－",
		"12345678901234567890",
		"0.000001",
		"-0.0",
		"00",
		"1..2",
		"9".repeat(64),
		"9".repeat(65),
		`-${"9".repeat(63)}`,
		`-${"9".repeat(64)}`,
	];
	for (let index = 0; index < 1500; index += 1)
		decimals.push(randomText(rng, "0123456789.-e+ ", 8));
	const durations: [string, string][] = [
		["2024-01-01", "2024-12-31"],
		["2023-10-01", "2024-09-28"],
		["2024-10-01", "2025-09-30"],
		["2024-04-01", "2025-03-31"],
		["2024-01-01", "2024-12-15"],
		["2024-01-01", "2025-01-15"],
		["2024-01-01", "2025-01-16"],
		["2024-12-31", "2024-01-01"],
		["2024-02-30", "2025-02-28"],
		["2024-1-1", "2024-12-31"],
		["", ""],
	];
	for (let index = 0; index < 1500; index += 1) {
		const start = rng.int(7_000, 22_000);
		const length = rng.chance(0.7) ? rng.int(340, 390) : rng.int(-5, 800);
		durations.push([
			rng.chance(0.03) ? "2023-02-29" : isoDateOfDayNumber(start),
			isoDateOfDayNumber(start + length - 1),
		]);
	}
	const ends = [
		"2025-01-07",
		"2025-01-08",
		"2025-01-01",
		"2024-12-31",
		"2025-02-29",
		"2024-02-29",
		"1999-1-1",
		"x",
	];
	for (const year of [1999, 2000, 2024, 2025, 2100]) {
		for (let day = 1; day <= 10; day += 1) ends.push(`${year}-01-${String(day).padStart(2, "0")}`);
		for (let day = 25; day <= 31; day += 1) ends.push(`${year - 1}-12-${day}`);
	}
	for (let index = 0; index < 300; index += 1) ends.push(randomDate(rng));

	const factSets: EquityExtractedFact[][] = [];
	const index = indexSecCompanyFacts(fixtureJson(COMPANY_FACTS), SEC_CONCEPTS);
	if (index.ok) for (const record of index.value.values()) factSets.push([...record.facts]);
	for (const document of EDINET_FIXTURE_DOCUMENTS) {
		const parsed = parseEdinetCsv(edinetReportCsv(document), EDINET_CONCEPTS);
		if (parsed.ok) factSets.push([...parsed.value.facts]);
	}
	for (let count = 0; count < 300; count += 1) {
		const year = rng.int(2015, 2026);
		const ends = [
			`${year}-03-31`,
			`${year - 1}-03-31`,
			`${year}-09-30`,
			`${year}-06-30`,
			"2024-02-30",
		];
		factSets.push(
			Array.from({ length: rng.int(0, 8) }, (): EquityExtractedFact => {
				const instant = rng.chance(0.4);
				const end = rng.pick(ends);
				const start = rng.pick([
					`${Number(end.slice(0, 4)) - 1}${end.slice(4, 8)}${rng.pick(["01", "02"])}`,
					`${end.slice(0, 8)}01`,
					"bad",
				]);
				return {
					concept: rng.pick(["a:X", "a:Y"]),
					unit: rng.pick(["USD", "JPY"]),
					valueDecimal: rng.pick(["1", "-2", "1.50", "3.25", "x", "0"]),
					periodType: instant ? "instant" : "duration",
					periodStart: instant
						? rng.chance(0.05)
							? start
							: null
						: rng.chance(0.05)
							? null
							: start,
					periodEnd: end,
					scope: rng.pick(["consolidated", "separate"]),
				};
			}),
		);
	}

	const values = [
		"391035000000",
		"-1234.5",
		"-0",
		"0",
		"0.1",
		"1E2",
		"1e-7",
		"1.5E-7",
		"1e21",
		"1e+21",
		"999999999999999999999",
		"100000000000000000000",
		"9007199254740993",
		"123.4500",
		"1.0",
		"0.000001",
		"0.0000001",
		"-12.5e3",
		"5e-324",
		"1.7976931348623157e308",
		"12345678.9",
	];
	for (let count = 0; count < 400; count += 1) {
		const double = randomDouble(() => rng.float());
		if (Number.isFinite(double)) values.push(String(double));
	}
	for (let count = 0; count < 400; count += 1) {
		const digits =
			String(rng.int(0, 999_999_999)) + (rng.chance(0.5) ? String(rng.int(0, 999_999)) : "");
		values.push(
			rng.chance(0.5) ? `-${digits}` : rng.chance(0.5) ? `${digits}.${rng.int(0, 9999)}` : digits,
		);
	}

	return {
		path: "domain/equity_financials.json",
		content: {
			isCanonicalDecimal: decimals.map((input) => ({ input, output: isCanonicalDecimal(input) })),
			isAnnualDuration: durations.map(([start, end]) => ({
				start,
				end,
				output: isAnnualDuration(start, end),
			})),
			fiscalYearOfPeriodEnd: ends.map((input) => ({ input, output: fiscalYearOfPeriodEnd(input) })),
			annualFactsOfFiling: factSets.map((facts) => ({
				facts,
				output: plain(annualFactsOfFiling(facts)),
			})),
			// The pending grace the API applies, and the runner to an undatable amendment.
			filingStaysPending: [
				["2026-10-25", "2026-10-31"],
				["2026-10-24", "2026-10-31"],
				["2026-10-31", "2026-10-31"],
				["2026-11-01", "2026-10-31"],
				["2024-02-23", "2024-03-01"],
				["2024-02-22", "2024-03-01"],
				["2025-12-26", "2026-01-01"],
				["2025-12-25", "2026-01-01"],
				["2026-02-30", "2026-03-01"],
				["2026-10-25", "x"],
				["", ""],
				...ends.slice(0, 20).map((end, index) => [end, ends[(index * 7 + 3) % ends.length] ?? end]),
			].map(([filedOn, today]) => ({
				filedOn,
				today,
				output: filingStaysPending(filedOn ?? "", today ?? ""),
			})),
			secValueDecimal: values.map((json) => {
				const value: number = JSON.parse(json);
				return { json, bits: doubleBits(value), output: secValueDecimal(value) };
			}),
		},
	};
}

/* ---------- The business description (ADR-0053) ---------- */

/** Blocks a 10-K's Markdown is made of, in the shapes the live 10-Ks showed. */
const TEN_K_BLOCKS: readonly string[] = [
	"Item 1. Business",
	"ITEM 1. BUSINESS",
	"Item 1. Business.",
	"Item 1 Business",
	"**Item 1.\u00a0\u00a0\u00a0\u00a0Business**",
	"## Items 1 and 2. Business and Properties",
	"Item 1: Business Overview",
	"| Item 1. | Business |\n| --- | --- |",
	"| Item 1. | Business | 3 |\n| --- | --- | --- |\n| Item 1A. | Risk Factors | 9 |",
	"Item 1",
	"Item 1.",
	"Item 12. Business Combinations",
	"Item 1A",
	"ITEM 1A. RISK FACTORS",
	"| Item 1A. | Risk Factors |\n| --- | --- |",
	"Item 1B. Unresolved Staff Comments",
	"Item 1C. Cybersecurity",
	"Item 2. Properties",
	"Item 3. Legal Proceedings",
	"Item 4. Mine Safety Disclosures",
	"PART I",
	"Part II",
	"Table of Contents",
	"TABLE OF CONTENTS",
	"3",
	"104",
	"---",
	"----",
	"Synthetic Inc. | 2025 Form 10-K | 4",
	"Our annual report on Form 10-K is available free of charge on our website, together with every quarterly report on Form 10-Q.",
	"General",
	"Overview",
	"**Company Background**",
	"### __Products__",
	"Human Capital",
	"•",
	"-",
	"• Already bulleted item text.",
	"The Company designs, manufactures and sells laboratory instruments.",
	"We seek to be the most customer-centric company; we are guided by four principles.",
	"In this report, the terms “Company,” “we” and “our” mean the Company and its subsidiaries.",
	"This Annual Report on Form 10-K contains forward-looking statements that involve risks and uncertainties.",
	"A line\nwith a single line break inside",
	"  Spaced   out\ttext  with\u3000ideographic space.  ",
	"Emoji 😀 and a surrogate pair 𝔘 in text.",
	"当社グループは機械を製造しています。",
	"（1）経営方針",
	"| Segment | Share |\n| --- | --- |\n| North America | 60% |",
	"|  |  |",
	"",
	`${"Long paragraph text. ".repeat(20)}End.`,
	`Item 1. Business ${"x".repeat(44)}`,
	`Item 2. ${"Properties ".repeat(12)}`,
];

/** Blocks a 20-F's Markdown is made of (ADR-0058 §5), in the shapes of the Form 20-F items. */
const TWENTY_F_BLOCKS: readonly string[] = [
	"Item 4. Information on the Company",
	"ITEM 4. INFORMATION ON THE COMPANY",
	"**Item 4.\u00a0Information on the Company**",
	"Item 4",
	"Item 4.",
	"A. History and Development of the Company",
	"Item 4.A History and Development",
	"Item 4.B Business Overview",
	"ITEM 4.B. BUSINESS OVERVIEW",
	"4B. Business overview",
	"B. Business Overview",
	"**B.\u00a0\u00a0Business overview**",
	"| Item 4.B | Business Overview | 21 |\n| --- | --- | --- |",
	"Item 4.C Organizational Structure",
	"C. Organisational structure",
	"D. Property, Plants and Equipment",
	"4.D Property, plants and equipment",
	"Item 4A. Unresolved Staff Comments",
	"Item 5. Operating and Financial Review and Prospects",
	"Synthetic Mining plc | 2024 Form 20-F | 21",
	"Our annual report on Form 20-F is available on our website together with every report on Form 6-K we furnish.",
	"The information set forth under “Our business” on pages 12 to 45 of the 2024 Annual Report is incorporated herein by reference.",
	`${"See the Annual Report, which is incorporated by reference. ".repeat(8)}End.`,
	"Overview",
	"Our business",
	"The Group mines iron ore, copper and aluminium and sells them worldwide.",
	"The Group operates 17 mines in six countries.",
	"PART I",
	"21",
	"---",
	"•",
	"",
];

/** A random 20-F-like Markdown document over `TWENTY_F_BLOCKS` and `TEN_K_BLOCKS`. */
function randomTwentyFMarkdown(rng: Rng): string {
	const pool = [...TWENTY_F_BLOCKS, ...TWENTY_F_BLOCKS, ...TEN_K_BLOCKS];
	const blocks = Array.from({ length: rng.int(0, 40) }, () => rng.pick(pool));
	return blocks
		.map((block, index) => (index === 0 ? block : `${rng.pick(["\n\n", "\n\n\n"])}${block}`))
		.join("");
}

/** A random 10-K-like Markdown document over `TEN_K_BLOCKS`. */
function randomTenKMarkdown(rng: Rng): string {
	const blocks = Array.from({ length: rng.int(0, 40) }, () => rng.pick([...TEN_K_BLOCKS]));
	return blocks
		.map((block, index) => (index === 0 ? block : `${rng.pick(["\n\n", "\n\n\n"])}${block}`))
		.join("");
}

/** Paragraph texts of a 事業の内容 text block, line by line. */
const JP_BUSINESS_LINES: readonly string[] = [
	"３【事業の内容】",
	"　当社グループは、当社及び連結子会社5社で構成され、産業機械の製造・販売を主な事業としています。",
	"（1）機械事業",
	"当社が製造し、販売子会社を通じて販売しています。",
	"(2) Measuring instruments",
	"・",
	"国内販売",
	"[事業系統図]",
	"",
	"　",
	"事業の系統図は次のとおりであります。",
	`${"長い文章です。".repeat(40)}`,
];

function randomBusinessText(rng: Rng): string {
	const lines = Array.from({ length: rng.int(0, 12) }, () => rng.pick([...JP_BUSINESS_LINES]));
	return lines
		.map((line, index) => (index === 0 ? line : `${rng.pick(["\r\n", "\n", "\r"])}${line}`))
		.join("");
}

function randomBusinessSource(rng: Rng, provider: "sec" | "edinet"): EquityBusinessSource {
	const year = rng.int(2022, 2026);
	return provider === "sec"
		? {
				sourceDocumentId: `0000000001-${String(year).slice(2)}-00000${rng.int(1, 3)}`,
				form: "10-K",
				filedOn: `${year}-${rng.pick(["02-20", "11-05"])}`,
				periodEnd: `${year - rng.int(0, 1)}-${rng.pick(["09-30", "12-31"])}`,
				sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000125000001/a.htm",
			}
		: {
				sourceDocumentId: `S100SY${rng.int(20, 25)}`,
				form: "securities-report",
				filedOn: `${year}-06-${rng.pick(["20", "26"])}`,
				periodEnd: `${year}-03-31`,
				sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SY20",
			};
}

/** The business description cases of `equity_sync_sec.json`. */
function secBusinessCases(submissionsDocs: readonly unknown[]): Record<string, unknown> {
	const rng = new Rng(0xb051);
	const row = (
		accession: string,
		form: "10-K" | "10-K/A" | "20-F" | "20-F/A" | "40-F" | "40-F/A",
		filingDate: string,
		reportDate: string,
		primaryDocument: string,
	): SecSubmissionRow => ({
		accession,
		form,
		filingDate,
		reportDate,
		acceptanceDateTime: "",
		primaryDocument,
	});
	const tenKInputs: SecSubmissions[] = [];
	for (const document of submissionsDocs) {
		const parsed = parseSecSubmissions(document);
		if (parsed.ok) tenKInputs.push(parsed.value);
	}
	for (let count = 0; count < 120; count += 1) {
		const rows = Array.from({ length: rng.int(0, 6) }, () =>
			row(
				`0000000001-2${rng.int(3, 6)}-00000${rng.int(1, 4)}`,
				rng.pick(["10-K", "10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"] as const),
				rng.pick(["2024-11-05", "2025-11-05", "2025-11-06", "2025-02-30", ""]),
				rng.pick(["2025-09-30", "2024-09-30", "", "2025-13-01"]),
				rng.pick(["a-20250930.htm", "x/a.htm", "", "a b.htm", "A_1.htm"]),
			),
		);
		tenKInputs.push({ name: null, fiscalYearEnd: null, annualRows: rows });
	}
	const markdowns: string[] = [
		"",
		[
			"FORM 10-K",
			"Item 1. Business",
			"Item 1A. Risk Factors",
			"PART I",
			"Item 1. Business",
			"This Annual Report on Form 10-K contains forward-looking statements that involve risks.",
			"Company Background",
			"The Company designs, manufactures and sells laboratory instruments.",
			"Item 1A. Risk Factors",
		].join("\n\n"),
		[
			"| Item 1. | Business |\n| --- | --- |",
			"In this report, the terms “Company,” “we” and “our” mean the Company and its subsidiaries.",
			"•",
			"An item.",
			"General",
			"We seek to be the most customer-centric company.",
			"| Item 1A. | Risk Factors |\n| --- | --- |",
		].join("\n\n"),
	];
	for (let count = 0; count < 200; count += 1) markdowns.push(randomTenKMarkdown(rng));
	// Over the stored-text limit: the leading paragraphs are kept, truncated.
	markdowns.push(
		[
			"Item 1. Business",
			"Overview",
			...Array.from({ length: 30 }, () => `${"We make instruments. ".repeat(40)}End.`),
			"Item 1A",
		].join("\n\n"),
	);
	const page = htmlToMarkdown(fixtureText(SEC_FIXTURE_TEN_K.fileName), {
		baseUrl: SEC_FIXTURE_TEN_K.url,
		maxChars: 4_000_000,
	});
	markdowns.push(page.markdown);
	// 20-F documents (ADR-0058 §5): Item 4.B, else Item 4, and a cross-reference only.
	const twentyFMarkdowns: string[] = [
		"",
		[
			"FORM 20-F",
			"Item 4. Information on the Company",
			"Item 4.B Business Overview",
			"Item 4.C Organizational Structure",
			"PART I",
			"Item 4. Information on the Company",
			"A. History and Development of the Company",
			"The Company was incorporated in 1873.",
			"B. Business Overview",
			"Item 4",
			"Overview",
			"The Group mines iron ore, copper and aluminium.",
			"Synthetic Mining plc | 2024 Form 20-F | 31",
			"C. Organizational Structure",
			"Item 4A. Unresolved Staff Comments",
		].join("\n\n"),
		[
			"ITEM 4 — INFORMATION ON THE COMPANY",
			"Overview",
			"The Group mines iron ore, copper and aluminium.",
			"Item 4A. Unresolved Staff Comments",
		].join("\n\n"),
		[
			"Item 4.B Business Overview",
			"The information under “Our business” in the Annual Report, Exhibit 15.1, is incorporated herein by reference.",
			"Item 4.C Organizational Structure",
		].join("\n\n"),
		htmlToMarkdown(fixtureText(SEC_FOREIGN_FIXTURE_TWENTY_F.fileName), {
			baseUrl: SEC_FOREIGN_FIXTURE_TWENTY_F.url,
			maxChars: 4_000_000,
		}).markdown,
	];
	for (let count = 0; count < 200; count += 1) twentyFMarkdowns.push(randomTwentyFMarkdown(rng));
	const tenKSource = {
		sourceDocumentId: SEC_FIXTURE_TEN_K.accession,
		form: "10-K" as const,
		filedOn: "2025-11-05",
		periodEnd: "2025-09-30",
		sourceUrl: SEC_FIXTURE_TEN_K.url,
	};
	const htmlInputs: { readonly html: unknown; readonly text: string }[] = [
		{
			html: { fixture: SEC_FIXTURE_TEN_K.fileName },
			text: fixtureText(SEC_FIXTURE_TEN_K.fileName),
		},
		{
			html: {
				inline: "<html><body><p>Item 1. Business</p><p>Item 1A. Risk Factors</p></body></html>",
			},
			text: "<html><body><p>Item 1. Business</p><p>Item 1A. Risk Factors</p></body></html>",
		},
		{
			html: {
				inline:
					"<html><body><p><b>ITEM 1. BUSINESS</b></p><p>Overview</p><p>We make things.</p><table><tr><td>Item 1A.</td><td>Risk Factors</td></tr></table><p>Risks.</p></body></html>",
			},
			text: "<html><body><p><b>ITEM 1. BUSINESS</b></p><p>Overview</p><p>We make things.</p><table><tr><td>Item 1A.</td><td>Risk Factors</td></tr></table><p>Risks.</p></body></html>",
		},
		{ html: { inline: "not html at all" }, text: "not html at all" },
	];
	const twentyFSource = {
		sourceDocumentId: SEC_FOREIGN_FIXTURE_TWENTY_F.accession,
		form: "20-F" as const,
		filedOn: "2025-02-27",
		periodEnd: "2024-12-31",
		sourceUrl: SEC_FOREIGN_FIXTURE_TWENTY_F.url,
	};
	const descriptionInputs = [
		...htmlInputs.map((input) => ({ source: tenKSource, ...input })),
		{
			source: twentyFSource,
			html: { fixture: SEC_FOREIGN_FIXTURE_TWENTY_F.fileName },
			text: fixtureText(SEC_FOREIGN_FIXTURE_TWENTY_F.fileName),
		},
		// A 10-K read as a 20-F finds no Item 4.
		{
			source: twentyFSource,
			html: { fixture: SEC_FIXTURE_TEN_K.fileName },
			text: fixtureText(SEC_FIXTURE_TEN_K.fileName),
		},
		// A 40-F is never read: not found whatever the document says.
		{
			source: { ...twentyFSource, form: "40-F" as const },
			html: { fixture: SEC_FOREIGN_FIXTURE_TWENTY_F.fileName },
			text: fixtureText(SEC_FOREIGN_FIXTURE_TWENTY_F.fileName),
		},
	];
	return {
		secNewestAnnualReport: tenKInputs.map((input) => ({
			annualRows: input.annualRows,
			output: secNewestAnnualReport(input)?.accession ?? null,
		})),
		secAnnualReportSource: tenKInputs
			.flatMap((input) => {
				const newest = secNewestAnnualReport(input);
				return newest === null ? [] : [newest];
			})
			.slice(0, 40)
			.map((newest) => ({
				cik: SEC_CIK,
				row: newest,
				output: secAnnualReportSource(SEC_CIK, newest),
			})),
		secBlock: [
			...TEN_K_BLOCKS,
			...TWENTY_F_BLOCKS,
			"|a|\n|b",
			"|a|\nb",
			"# ",
			"#Heading",
			"**",
			"a**b__c",
		].map((block) => ({ block, output: secBlock(block) })),
		secSectionMark: [
			...TEN_K_BLOCKS.map((block) => secBlock(block).text),
			...TWENTY_F_BLOCKS.map((block) => secBlock(block).text),
			"Items 1 & 2 — Business",
			"item1business",
			"Item 1 - Business",
			"Item 1A Business",
			"Item 10",
			"Item 3",
			"Item 2",
			`${"Item 1. Business".padEnd(60, "x")}`,
			`${"Item 1. Business".padEnd(61, "x")}`,
			`${"Item 2".padEnd(120, "x")}`,
			`${"Item 2".padEnd(121, "x")}`,
			`Item 1. Business ${"😀".repeat(21)}`,
			"item4bbusiness overview",
			"Item 4 . b — Business\u00a0Overview",
			"Item b Business Overview",
			"4 B Business Overview",
			"B Business Overview",
			"bbusiness overview",
			"Item4Information on the Company",
			"Item 4 Information onthe Company",
			"Item 4 Information on the Companyx",
			"4D",
			"4 d",
			"Item 4dx",
			"C: Organizational Structure",
			"C Organizational Structure",
			"D — Properties",
			"D. Propertyx",
			"C. organizsational structure",
			"Item 4a",
			"Item 4A1",
			"Item 5x",
			"Item 50",
			`${"B. Business Overview".padEnd(60, "x")}`,
			`${"B. Business Overview".padEnd(61, "x")}`,
			`${"Item 5".padEnd(121, "x")}`,
		].flatMap((text) =>
			SEC_BUSINESS_SECTIONS.map((section) => ({
				text,
				section,
				output: secSectionMark(text, section),
			})),
		),
		secBusinessParagraphs: [
			...markdowns.map((markdown) => ({ markdown, form: "10-K" as const })),
			...twentyFMarkdowns.map((markdown) => ({ markdown, form: "20-F" as const })),
			// Each form's finder on the other's documents.
			...markdowns.slice(0, 40).map((markdown) => ({ markdown, form: "20-F" as const })),
			...twentyFMarkdowns.slice(0, 40).map((markdown) => ({ markdown, form: "10-K" as const })),
		].map(({ markdown, form }) => ({
			markdown,
			form,
			blocks: secBusinessBlocks(markdown, form),
			output: secBusinessParagraphs(markdown, form),
		})),
		secAnnualReportDescription: descriptionInputs.map((input) => ({
			source: input.source,
			html: input.html,
			output: secAnnualReportDescription(input.source, input.text),
		})),
	};
}

/** The business description cases of `equity_sync_shared.json`. */
function sharedBusinessCases(): Record<string, unknown> {
	const rng = new Rng(0xb052);
	const paragraphSets = [
		{ paragraphs: [], truncated: false },
		{ paragraphs: [{ kind: "text" as const, text: "We make things." }], truncated: true },
		{
			paragraphs: [
				{ kind: "heading" as const, text: "General" },
				{ kind: "text" as const, text: "We make things." },
			],
			truncated: false,
		},
	];
	const describe = (): EquityBusinessDescription | null =>
		rng.chance(0.15)
			? null
			: businessDescriptionOf(
					randomBusinessSource(rng, rng.pick(["sec", "edinet"] as const)),
					rng.pick(paragraphSets),
				);
	return {
		businessDescriptionOf: paragraphSets.flatMap((business) =>
			(["sec", "edinet"] as const).map((provider) => {
				const source = randomBusinessSource(rng, provider);
				return { source, business, output: businessDescriptionOf(source, business) };
			}),
		),
		newerBusinessDescription: Array.from({ length: 200 }, () => {
			const a = describe();
			const b = rng.chance(0.1) ? a : describe();
			return { a, b, output: newerBusinessDescription(a, b) };
		}),
	};
}

/** The 事業の内容 cases of `equity_sync_edinet.json`. */
function edinetBusinessCases(): unknown[] {
	const rng = new Rng(0xb053);
	const texts: (string | null)[] = [
		null,
		"",
		"\r\n",
		...EDINET_FIXTURE_DOCUMENTS.map(edinetBusinessText),
		// Over the stored-text limit: the leading paragraphs are kept, truncated.
		["３【事業の内容】", ...Array.from({ length: 4 }, () => "長い文章です。".repeat(800))].join(
			"\r\n",
		),
	];
	for (let count = 0; count < 120; count += 1) texts.push(randomBusinessText(rng));
	return texts.map((text) => ({ text, output: edinetBusinessParagraphs(text) }));
}

/* ---------- Shared ---------- */

const FETCH_CODES: readonly Exclude<SafeFetchError["code"], "HTTP_ERROR">[] = [
	"UNSAFE_URL",
	"HOST_NOT_ALLOWED",
	"UNSAFE_REDIRECT",
	"TOO_MANY_REDIRECTS",
	"REDIRECT_NOT_AUTHORIZED",
	"TIMEOUT",
	"RESPONSE_TOO_LARGE",
	"NETWORK_ERROR",
];
const SEC_CODES: readonly SecErrorCode[] = [
	"NOT_CONFIGURED",
	"INVALID_IDENTIFIER",
	"NOT_FOUND",
	"ACCESS_DENIED",
	"RATE_LIMITED",
	"FETCH_FAILED",
	"RESPONSE_TOO_LARGE",
	"UNEXPECTED_RESPONSE",
	"NO_DATA",
];

function randomFiling(rng: Rng, id: string): EquityFilingResult {
	const facts = rng.int(0, 6);
	return {
		sourceDocumentId: id,
		form: "10-K",
		filedOn: rng.pick(["2024-01-01", "2024-06-30", "2025-01-01", "2025-01-02"]),
		submittedAt: null,
		periodStart: null,
		periodEnd: "2024-12-31",
		amendsSourceDocumentId: null,
		sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/1/",
		accountingStandard: facts === 0 ? null : "US-GAAP",
		factsStatus: facts === 0 ? rng.pick(["not-available", "deferred"]) : "extracted",
		facts: Array.from({ length: facts }, (_, index) => ({
			concept: "us-gaap:Revenues",
			unit: "USD",
			valueDecimal: String(index),
			periodType: "duration",
			periodStart: "2024-01-01",
			periodEnd: "2024-12-31",
			scope: "consolidated",
		})),
	};
}

function sharedFile(): VectorFile {
	const rng = new Rng(0x5a7e);
	const statuses = Array.from({ length: 500 }, (_, index) => index + 100);
	const fetchFailures: { error: SafeFetchError; requests: number }[] = [];
	for (const code of FETCH_CODES) fetchFailures.push({ error: { code, detail: "x" }, requests: 2 });
	fetchFailures.push({ error: { code: "UNSAFE_REDIRECT", detail: "x", status: 302 }, requests: 1 });
	for (const status of [400, 401, 403, 404, 408, 429, 500, 502, 503, 520]) {
		fetchFailures.push({
			error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status },
			requests: 3,
		});
	}
	const secFailures: { code: SecErrorCode; upstreamStatus: number | null }[] = [];
	for (const code of SEC_CODES) {
		for (const upstreamStatus of [null, 401, 403, 404, 429, 500])
			secFailures.push({ code, upstreamStatus });
	}
	const factLists: EquityExtractedFact[][] = [];
	for (let count = 0; count < 200; count += 1) {
		const pool: EquityExtractedFact[] = Array.from({ length: rng.int(1, 4) }, () => ({
			concept: rng.pick(["us-gaap:A", "us-gaap:B", "jppfs_cor:A"]),
			unit: rng.pick(["USD", "EUR"]),
			valueDecimal: rng.pick(["1", "2", "-1"]),
			periodType: "duration",
			periodStart: rng.pick(["2023-01-01", "2023-10-01"]),
			periodEnd: "2023-12-31",
			scope: rng.pick(["consolidated", "separate"]),
		}));
		const instant: EquityExtractedFact = {
			concept: "us-gaap:A",
			unit: "USD",
			valueDecimal: "5",
			periodType: "instant",
			periodStart: null,
			periodEnd: rng.pick(["2023-12-31", "2023-06-30"]),
			scope: "consolidated",
		};
		factLists.push(rng.shuffle([...rng.picks([...pool, instant], rng.int(0, 7))]));
	}
	const capCases = Array.from({ length: 300 }, () => {
		const filings = Array.from({ length: rng.int(0, 7) }, (_, index) =>
			randomFiling(rng, `0000000001-2${rng.int(0, 5)}-00000${index}`),
		);
		const caps = { maxFilings: rng.int(0, 6), maxFacts: rng.int(0, 20) };
		const fitted = fitCompletionCaps(filings, caps);
		return {
			filings,
			caps,
			output: {
				filings: fitted.filings.map((filing) => ({
					id: filing.sourceDocumentId,
					status: filing.factsStatus,
					facts: filing.facts.length,
				})),
				cut: fitted.cut.map((filing) => filing.sourceDocumentId),
			},
		};
	});
	return {
		path: "finance/equity_sync_shared.json",
		content: {
			...sharedBusinessCases(),
			codeOfStatus: statuses.map((status) => ({ status, output: equitySyncCodeOfStatus(status) })),
			failureOfFetch: fetchFailures.map((input) => ({
				...input,
				output: equitySyncFailureOfFetch(input.error, input.requests),
			})),
			failureOfSec: secFailures.map((input) => ({
				...input,
				output: equitySyncFailureOfSec(secError(input.code, "x", false, input.upstreamStatus), 4),
			})),
			retryable: EQUITY_SYNC_FAILURE_CODES.map((code) => ({
				code,
				output: isRetryableEquitySyncFailure(code),
			})),
			compareFacts: factLists
				.slice(0, 50)
				.flatMap((facts) =>
					facts.flatMap((a) => facts.map((b) => ({ a, b, output: Math.sign(compareFacts(a, b)) }))),
				),
			annualFactsInOrder: factLists.map((facts) => ({ facts, output: annualFactsInOrder(facts) })),
			fitCompletionCaps: capCases,
		},
	};
}

/* ---------- SEC ---------- */

function indexJson(index: SecFactsIndex): unknown {
	return [...index.entries()]
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([accession, record]) => ({
			accession,
			form: record.form,
			filed: record.filed,
			standard: record.standard,
			entryCount: record.entryCount,
			facts: [...record.facts].sort(compareFacts),
		}));
}

function secFile(): VectorFile {
	const rng = new Rng(0x5ec1);
	const submissionsDoc = fixtureJson(SUBMISSIONS);
	const variant = (
		mutate: (
			document: Record<string, unknown> & { filings: { recent: Record<string, unknown[]> } },
		) => void,
	) => {
		const document = JSON.parse(fixtureText(SUBMISSIONS));
		mutate(document);
		return document;
	};
	const submissionInputs: unknown[] = [
		{ fixture: SUBMISSIONS },
		{ inline: variant((d) => d.filings.recent.form?.pop()) },
		{
			inline: variant((d) => {
				d.fiscalYearEnd = "1231";
				d.name = " Spaced Name Inc. ";
			}),
		},
		{
			inline: variant((d) => {
				d.fiscalYearEnd = "0230";
			}),
		},
		{
			inline: variant((d) => {
				d.fiscalYearEnd = "1301";
				d.name = "";
			}),
		},
		{
			inline: variant((d) => {
				d.fiscalYearEnd = null;
				d.name = "x".repeat(201);
			}),
		},
		{
			inline: variant((d) => {
				delete d.fiscalYearEnd;
				delete d.name;
			}),
		},
		{
			inline: variant((d) => {
				d.filings.recent.accessionNumber = (d.filings.recent.accessionNumber ?? []).map((a, i) =>
					i === 4 ? "bad" : a,
				);
			}),
		},
		{
			inline: variant((d) => {
				d.filings.recent.form = (d.filings.recent.form ?? []).map((f) =>
					f === "10-Q" ? "10-K" : f,
				);
			}),
		},
		// A foreign private issuer (ADR-0058 §5): 20-F, 20-F/A, 6-K; then its
		// 20-Fs as 40-Fs.
		{ fixture: FOREIGN_SUBMISSIONS },
		{
			inline: (() => {
				const document = JSON.parse(fixtureText(FOREIGN_SUBMISSIONS));
				document.filings.recent.form = document.filings.recent.form.map((form: string) =>
					form.replace("20-F", "40-F"),
				);
				return document;
			})(),
		},
		{ inline: { filings: { recent: {} } } },
		{ inline: [] },
		{ inline: null },
		{
			inline: {
				name: 5,
				filings: {
					recent: {
						accessionNumber: [],
						filingDate: [],
						reportDate: [],
						acceptanceDateTime: [],
						form: [],
						primaryDocument: [],
					},
				},
			},
		},
	];
	const resolve = (input: unknown): unknown => {
		if (
			typeof input === "object" &&
			input !== null &&
			"fixture" in input &&
			typeof input.fixture === "string"
		)
			return fixtureJson(input.fixture);
		if (typeof input === "object" && input !== null && "inline" in input) return input.inline;
		return input;
	};

	const factsDoc = fixtureJson(COMPANY_FACTS);
	const conceptSets: (readonly string[])[] = [
		SEC_CONCEPTS,
		["us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax"],
		[
			"us-gaap:Assets",
			"us-gaap:Assets",
			"us-gaap:EarningsPerShareDiluted",
			"jppfs_cor:NetSales",
			"us-gaap:Missing",
		],
		["ifrs-full:Revenue", "ifrs-full:Assets", "us-gaap:Revenues", "ifrs-full:__proto__"],
		[],
	];
	const ifrsEntry = (accn: string, val: number, form: string) => ({
		start: "2024-01-01",
		end: "2024-12-31",
		val,
		accn,
		form,
		filed: "2025-02-27",
	});
	const factsInputs: unknown[] = [
		{ fixture: COMPANY_FACTS },
		{ fixture: FOREIGN_COMPANY_FACTS },
		// One accession tagged in both taxonomies (the larger wins, US GAAP on a
		// tie), forms of one accession that disagree, an ifrs-full that is not an object.
		{
			inline: {
				facts: {
					"ifrs-full": {
						Revenue: {
							units: {
								GBP: [
									ifrsEntry("0000000003-25-000001", 10, "20-F"),
									ifrsEntry("0000000003-25-000002", 11, "20-F"),
									ifrsEntry("0000000003-25-000003", 12, "40-F"),
									ifrsEntry("0000000003-25-000003", 12, "40-F/A"),
									ifrsEntry("0000000003-25-000004", 1.5e-7, "20-F/A"),
								],
							},
						},
						Assets: {
							units: {
								GBP: [{ ...ifrsEntry("0000000003-25-000001", 30, "20-F"), start: undefined }],
							},
						},
					},
					"us-gaap": {
						Revenues: {
							units: {
								USD: [
									ifrsEntry("0000000003-25-000001", 13, "20-F"),
									ifrsEntry("0000000003-25-000002", 14, "20-F"),
									ifrsEntry("0000000003-25-000005", 15, "6-K"),
								],
							},
						},
					},
				},
			},
		},
		{ inline: { facts: { "ifrs-full": [], "us-gaap": {} } } },
		{ inline: { facts: {} } },
		{ inline: { facts: { "us-gaap": "x" } } },
		{ inline: { entityName: "x" } },
		{
			inline: {
				facts: {
					"us-gaap": {
						Assets: {
							units: {
								USD: [
									{
										end: "2024-12-31",
										val: 5,
										accn: "0000000001-25-000001",
										form: "10-K",
										filed: "2025-02-01",
									},
									{
										end: "2024-12-31",
										val: 5,
										accn: "0000000001-25-000001",
										form: "10-K/A",
										filed: "2025-01-15",
									},
									{
										end: "2024-12-31",
										val: 1.5e-7,
										accn: "0000000001-25-000002",
										form: "10-K",
										filed: "2025-02-01",
									},
									{
										end: "2024-12-31",
										val: "5",
										accn: "0000000001-25-000003",
										form: "10-K",
										filed: "2025-02-01",
									},
									{
										end: "2024-02-30",
										val: 5,
										accn: "0000000001-25-000004",
										form: "10-K",
										filed: "2025-02-01",
									},
									{
										start: "bad",
										end: "2024-12-31",
										val: 5,
										accn: "0000000001-25-000005",
										form: "10-K",
										filed: "2025-02-01",
									},
									{ end: "2024-12-31", val: 5, accn: "1-25-6", form: "10-K", filed: "2025-02-01" },
									{
										end: "2024-12-31",
										val: 5,
										accn: "0000000001-25-000007",
										form: "10-Q",
										filed: "2025-02-01",
									},
									"junk",
								],
								[`U${"x".repeat(40)}`]: [
									{
										end: "2024-12-31",
										val: 5,
										accn: "0000000001-25-000008",
										form: "10-K",
										filed: "2025-02-01",
									},
								],
							},
						},
						Liabilities: { units: "x" },
					},
				},
			},
		},
	];
	const indexCases = factsInputs.flatMap((input) =>
		conceptSets.map((concepts) => {
			const result = indexSecCompanyFacts(resolve(input), concepts);
			return {
				document: input,
				concepts,
				output: result.ok ? { ok: indexJson(result.value) } : { err: result.error },
			};
		}),
	);

	const parsedSubmissions = parseSecSubmissions(submissionsDoc);
	const index = indexSecCompanyFacts(factsDoc, SEC_CONCEPTS);
	if (!parsedSubmissions.ok || !index.ok) throw new Error("SEC fixtures do not parse");
	const allAnnual = [
		...new Set([
			...parsedSubmissions.value.annualRows.map((row) => row.accession),
			...index.value.keys(),
		]),
	].sort();
	const pendingOf = (accession: string): EquityPendingFiling => ({
		sourceDocumentId: accession,
		form: "10-K",
		filedOn: "2020-01-02",
		submittedAt: "2020-01-02T10:00:00.000Z",
		periodStart: "2019-01-01",
		periodEnd: "2019-12-31",
		amendsSourceDocumentId: null,
		sourceUrl: `https://www.sec.gov/Archives/edgar/data/9999981/${accession.replaceAll("-", "")}/`,
	});
	const syncCases: unknown[] = [];
	/** One sync case; `filer` picks the fixture pair (the main filer, or the equity-statement one). */
	const addSync = (
		request: SecSyncRequest,
		facts: "fixture" | "empty" | null,
		caps: { maxFilings: number; maxFacts: number } | null,
		filer: "main" | "equity" | "foreign" = "main",
	) => {
		const files =
			filer === "main"
				? { cik: SEC_CIK, submissions: SUBMISSIONS, facts: COMPANY_FACTS }
				: filer === "equity"
					? {
							cik: SEC_EQUITY_FIXTURE_CIK,
							submissions: EQUITY_SUBMISSIONS,
							facts: EQUITY_COMPANY_FACTS,
						}
					: {
							cik: SEC_FOREIGN_FIXTURE_CIK,
							submissions: FOREIGN_SUBMISSIONS,
							facts: FOREIGN_COMPANY_FACTS,
						};
		const submissions = parseSecSubmissions(fixtureJson(files.submissions));
		const fixtureFacts = indexSecCompanyFacts(fixtureJson(files.facts), SEC_CONCEPTS);
		if (!submissions.ok || !fixtureFacts.ok) throw new Error(`${filer} SEC fixtures do not parse`);
		const factsIndex =
			facts === "fixture" ? fixtureFacts.value : facts === "empty" ? new Map() : null;
		const input = {
			request,
			cik: files.cik,
			submissions: submissions.value,
			facts: factsIndex,
		};
		syncCases.push({
			request,
			cik: files.cik,
			submissions: { fixture: files.submissions },
			facts: facts === "fixture" ? { fixture: files.facts, concepts: SEC_CONCEPTS } : facts,
			caps,
			needsCompanyFacts: secNeedsCompanyFacts(request, submissions.value),
			output: plain(caps === null ? secSyncResult(input) : secSyncResult(input, caps)),
		});
	};
	const base: SecSyncRequest = {
		provider: "sec",
		cik: SEC_CIK,
		knownAccessions: [],
		pendingFilings: [],
		filedSince: "2020-10-31",
		fullCheck: true,
		describedDocumentId: null,
	};
	addSync(base, "fixture", null);
	addSync({ ...base, filedSince: "2000-01-01" }, "fixture", null);
	addSync({ ...base, filedSince: "2025-01-01" }, "fixture", null);
	addSync({ ...base, fullCheck: false, knownAccessions: allAnnual }, null, null);
	addSync(
		{
			...base,
			fullCheck: false,
			knownAccessions: allAnnual.filter((a) => a !== "0009999981-26-000005"),
		},
		"fixture",
		null,
	);
	addSync(
		{
			...base,
			fullCheck: false,
			knownAccessions: allAnnual,
			pendingFilings: [pendingOf("0009999981-25-000110"), pendingOf("0009999981-99-000001")],
		},
		"fixture",
		null,
	);
	addSync({ ...base, fullCheck: false }, "empty", null);
	addSync(base, "fixture", { maxFilings: 2, maxFacts: 3000 });
	addSync(base, "fixture", { maxFilings: 60, maxFacts: 70 });
	addSync(base, "fixture", { maxFilings: 60, maxFacts: 10 });
	for (let count = 0; count < 60; count += 1) {
		const known = allAnnual.filter(() => rng.chance(0.5));
		const pending = allAnnual.filter(() => rng.chance(0.15)).map(pendingOf);
		addSync(
			{
				...base,
				knownAccessions: known,
				pendingFilings: pending,
				fullCheck: rng.chance(0.4),
				filedSince: rng.pick(["2019-01-01", "2020-10-31", "2023-01-01", "2026-01-15"]),
			},
			rng.pick(["fixture", "empty", null] as const),
			rng.chance(0.3) ? { maxFilings: rng.int(0, 8), maxFacts: rng.int(0, 200) } : null,
		);
	}
	// The equity-statement filer: instants only at each 10-K's two balance-sheet
	// year ends; its 10-K/A without a report date and without facts is never
	// stored and does not trigger the company facts on its own.
	const equityBase: SecSyncRequest = {
		...base,
		cik: SEC_EQUITY_FIXTURE_CIK,
		filedSince: "2020-01-01",
	};
	const equityTenKs = [SEC_EQUITY_FIXTURE_FILINGS.fy2023, SEC_EQUITY_FIXTURE_FILINGS.fy2024];
	addSync(equityBase, "fixture", null, "equity");
	addSync({ ...equityBase, fullCheck: false }, "fixture", null, "equity");
	addSync({ ...equityBase, fullCheck: false, knownAccessions: equityTenKs }, null, null, "equity");
	addSync(
		{ ...equityBase, fullCheck: false, knownAccessions: equityTenKs },
		"empty",
		null,
		"equity",
	);
	addSync(
		{
			...equityBase,
			fullCheck: false,
			knownAccessions: [SEC_EQUITY_FIXTURE_FILINGS.fy2023],
		},
		"fixture",
		null,
		"equity",
	);
	// The 20-F filer (ADR-0058 §5): IFRS facts in GBP, a US GAAP 20-F before
	// the switch, a 20-F/A, 6-K rows that are not annual reports.
	const foreignBase: SecSyncRequest = {
		...base,
		cik: SEC_FOREIGN_FIXTURE_CIK,
		filedSince: "2020-01-01",
	};
	addSync(foreignBase, "fixture", null, "foreign");
	addSync({ ...foreignBase, fullCheck: false }, "empty", null, "foreign");
	addSync({ ...foreignBase, filedSince: "2024-01-01" }, "fixture", null, "foreign");
	addSync(foreignBase, "fixture", { maxFilings: 2, maxFacts: 3000 }, "foreign");
	// secFilingFacts: the fixtures' filings plus random multi-year statements
	// (durations of one to four years, interim periods, instants at every year end).
	const filingFactSets: EquityExtractedFact[][] = [];
	for (const record of index.value.values()) filingFactSets.push([...record.facts]);
	const equityIndex = indexSecCompanyFacts(fixtureJson(EQUITY_COMPANY_FACTS), SEC_CONCEPTS);
	if (!equityIndex.ok) throw new Error("equity SEC fixture does not parse");
	for (const record of equityIndex.value.values()) filingFactSets.push([...record.facts]);
	for (let count = 0; count < 200; count += 1) {
		const year = rng.int(2016, 2026);
		const monthDay = rng.pick(["12-31", "09-30", "03-31"]);
		const yearEnd = (y: number) => `${y}-${monthDay}`;
		const durationYears = rng.int(0, 4);
		const facts: EquityExtractedFact[] = [];
		for (let back = 0; back < durationYears; back += 1) {
			const end = yearEnd(year - back);
			const start = isoDateOfDayNumber((isoDayNumber(yearEnd(year - back - 1)) ?? 0) + 1);
			facts.push({
				concept: rng.pick(["us-gaap:Revenues", "us-gaap:NetIncomeLoss"]),
				unit: "USD",
				valueDecimal: String(rng.int(1, 999)),
				periodType: "duration",
				periodStart: rng.chance(0.15) ? `${end.slice(0, 8)}01` : start,
				periodEnd: end,
				scope: "consolidated",
			});
		}
		for (let instants = rng.int(0, 6); instants > 0; instants -= 1) {
			facts.push({
				concept: rng.pick(["us-gaap:Assets", "us-gaap:StockholdersEquity"]),
				unit: rng.pick(["USD", "EUR"]),
				valueDecimal: String(rng.int(1, 999)),
				periodType: "instant",
				periodStart: null,
				periodEnd: yearEnd(year - rng.int(0, 4)),
				scope: "consolidated",
			});
		}
		filingFactSets.push(rng.shuffle(facts));
	}
	const urlCases = [
		[SEC_CIK, "0009999981-24-000108", "synd-20240930.htm"],
		[SEC_CIK, "0009999981-24-000108", null],
		[SEC_CIK, "0009999981-24-000108", ""],
		[SEC_CIK, "0009999981-24-000108", "a b.htm"],
		[SEC_CIK, "0009999981-24-000108", "dir/x.htm"],
		["0000320193", "0000320193-24-000123", "aapl-20240928.htm"],
		["1000000000", "1000000000-24-000123", `${"x".repeat(200)}`],
		["1000000000", "1000000000-24-000123", `${"x".repeat(201)}`],
	] as const;
	return {
		path: "finance/equity_sync_sec.json",
		content: {
			parseSecSubmissions: submissionInputs.map((input) => ({
				document: input,
				output: resultJson(parseSecSubmissions(resolve(input))),
			})),
			indexSecCompanyFacts: indexCases,
			secFilingFacts: filingFactSets.map((facts) => ({ facts, output: secFilingFacts(facts) })),
			secSyncResult: syncCases,
			secFilingUrl: urlCases.map(([cik, accession, primaryDocument]) => ({
				cik,
				accession,
				primaryDocument,
				output: secFilingUrl(cik, accession, primaryDocument),
			})),
			...secBusinessCases(submissionInputs.map(resolve)),
		},
	};
}

/* ---------- EDINET ---------- */

function listName(date: string): string {
	return `edinet-documents-${date}.synthetic.json`;
}

function rowsOf(date: string): readonly EdinetAnnualRow[] {
	const parsed = parseEdinetDocumentList(fixtureJson(listName(date)));
	if (!parsed.ok) throw new Error(`fixture list ${date}`);
	return parsed.value;
}

function utf16(text: string, bom: boolean): Uint8Array {
	const body = new Uint8Array(Buffer.from(text, "utf16le"));
	if (!bom) return body;
	const bytes = new Uint8Array(body.length + 2);
	bytes.set([0xff, 0xfe]);
	bytes.set(body, 2);
	return bytes;
}

/**
 * A stored filing of the synthetic EDINET filer with its period: the last
 * digit of its document id is the fiscal year ending March 202X.
 */
function knownOf(docId: string): EdinetKnownFiling {
	const year = 2020 + Number(docId.slice(-1));
	return { docId, periodStart: `${year - 1}-04-01`, periodEnd: `${year}-03-31` };
}

function edinetFile(): VectorFile {
	const rng = new Rng(0xed1e);
	const dates = edinetFixtureDates();
	const row = (fields: Record<string, unknown>) => ({
		docID: "S100AAAA",
		edinetCode: "E99991",
		secCode: "99990",
		filerName: "名",
		docTypeCode: "120",
		periodStart: "2024-04-01",
		periodEnd: "2025-03-31",
		submitDateTime: "2025-06-20 15:00",
		parentDocID: null,
		withdrawalStatus: "0",
		csvFlag: "1",
		...fields,
	});
	const listInputs: unknown[] = [
		...dates.map((date) => ({ fixture: listName(date) })),
		{ inline: { metadata: { status: "401", message: "Unauthorized" } } },
		{ inline: { metadata: { status: "404" }, results: [] } },
		{ inline: { metadata: { status: "999" } } },
		{ inline: { metadata: { status: "oops" } } },
		{ inline: { metadata: { status: 200 } } },
		{ inline: { metadata: { status: "200" } } },
		{ inline: { results: [] } },
		{ inline: "x" },
		// The gateway's errors with HTTP 200 and no metadata (spec §3-3 B, C): their status.
		{ inline: { StatusCode: 401, message: "Access denied due to invalid subscription key." } },
		{ inline: { StatusCode: 429, message: "Too Many Requests" } },
		{ inline: { statusCode: 503 } },
		{ inline: { StatusCode: 200 } },
		{ inline: { StatusCode: 99 } },
		{ inline: { StatusCode: "429" } },
		{ inline: { metadata: { status: "500" }, results: 5 } },
		{ inline: { metadata: { status: 500 }, StatusCode: 429 } },
		{
			inline: {
				metadata: { status: "200" },
				results: [
					row({}),
					row({ docID: "bad" }),
					row({ edinetCode: "X1" }),
					row({ docTypeCode: "140" }),
					row({ docTypeCode: null }),
					row({ withdrawalStatus: "1" }),
					row({ withdrawalStatus: null }),
					row({ submitDateTime: "2025-06-31 15:00" }),
					row({ submitDateTime: "2025-06-20 24:00" }),
					row({ submitDateTime: "2025-06-20T15:00" }),
					row({ periodEnd: "2025-02-30", periodStart: null }),
					row({
						filerName: "  ",
						secCode: null,
						parentDocID: "S100BBBB",
						csvFlag: "0",
						docTypeCode: "130",
					}),
					row({ parentDocID: "bad", csvFlag: null, filerName: null }),
					row({ docID: 5 }),
					"junk",
					null,
				],
			},
		},
	];
	const resolve = (input: unknown): unknown => {
		if (
			typeof input === "object" &&
			input !== null &&
			"fixture" in input &&
			typeof input.fixture === "string"
		)
			return fixtureJson(input.fixture);
		if (typeof input === "object" && input !== null && "inline" in input) return input.inline;
		return input;
	};
	const allRows = dates.flatMap((date) => rowsOf(date));
	const ours = allRows.filter((r) => r.secCode === "99990");
	// The reports the index names for the synthetic filer, oldest first (ADR-0058 §4).
	const indexedOurs = edinetIndexedFilings(ours);
	const pendingOf = (docId: string): EquityPendingFiling => ({
		sourceDocumentId: docId,
		form: "securities-report",
		filedOn: "2019-06-21",
		submittedAt: null,
		periodStart: null,
		periodEnd: "2019-03-31",
		amendsSourceDocumentId: null,
		sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${docId}`,
	});
	const planCases = Array.from({ length: 120 }, () => {
		const indexed = rng.shuffle(indexedOurs.filter(() => rng.chance(0.7)));
		const known = indexedOurs
			.filter(() => rng.chance(0.3))
			.map((filing) => knownOf(filing.sourceDocumentId));
		const pending = [
			...indexedOurs.filter(() => rng.chance(0.2)).map((filing) => filing.sourceDocumentId),
			...(rng.chance(0.3) ? ["S100PEND"] : []),
		].map(pendingOf);
		const maxDownloads = rng.int(0, 9);
		return {
			pending,
			indexed,
			knownFilings: known,
			maxDownloads,
			output: plain(edinetDownloadPlan({ pending, indexed, knownFilings: known, maxDownloads })),
		};
	});
	const identityCases = [
		{ claimEdinetCode: "E99991", filings: indexedOurs },
		{
			claimEdinetCode: "E99991",
			filings: indexedOurs.filter((f) => f.form !== "securities-report"),
		},
		{ claimEdinetCode: "E11111", filings: [] },
		{ claimEdinetCode: null, filings: indexedOurs },
		{ claimEdinetCode: null, filings: [] },
	].map((input) => ({ ...input, output: edinetIdentity(input.claimEdinetCode, input.filings) }));

	const utfCases: Uint8Array[] = [
		utf16("要素ID\t値\r\n", true),
		utf16("abc", false),
		new Uint8Array([0xff, 0xfe]),
		new Uint8Array([]),
		new Uint8Array([0xff]),
		new Uint8Array([0xff, 0xfe, 0x41]),
		new Uint8Array([0x00, 0xd8, 0x41, 0x00]),
		new Uint8Array([0x3d, 0xd8, 0x00, 0xde]),
		new Uint8Array([0x00, 0xdc]),
		new Uint8Array([0xfe, 0xff, 0x00, 0x41]),
		new Uint8Array([0xff, 0xfe, 0xff, 0xfe, 0x41, 0x00]),
	];
	for (let count = 0; count < 200; count += 1) {
		utfCases.push(
			new Uint8Array(
				Array.from({ length: rng.int(0, 12) }, () =>
					rng.pick([0x00, 0x41, 0xd8, 0xdc, 0xff, 0xfe, 0x30, rng.int(0, 255)]),
				),
			),
		);
	}
	const tsvTexts = [
		'"a"\t"b"\r\n"c\td"\t"e\nf ""g"""\n"h"\r"i"',
		'\r\n"a"\t""\n\n"b"x\tplain\n',
		"",
		"\n\n",
		"\t",
		'"',
		'"unterminated\tfield\n',
		'a"b"\t"c"d"\n',
		'""""\t"x""y"',
		"plain\r\n\r\nrow",
		"\r",
		"a\tb\t\t",
	];
	for (let count = 0; count < 600; count += 1) tsvTexts.push(randomText(rng, '"\t\r\nab', 14));
	const tsvRows = (text: string) => {
		const rows: string[][] = [];
		forEachTsvRow(text, (fields) => {
			rows.push([...fields]);
			return true;
		});
		return rows;
	};
	const contexts = [
		"CurrentYearDuration",
		"Prior1YearDuration",
		"CurrentYearInstant",
		"Prior1YearInstant",
		"CurrentYearDuration_NonConsolidatedMember",
		"Prior1YearInstant_NonConsolidatedMember",
		"CurrentYearDuration_jpcrp030000-asr_E99991-000MachineryReportableSegmentMember",
		"InterimDuration",
		"Prior2YearDuration",
		"FilingDateInstant",
		"_NonConsolidatedMember",
		"CurrentYearDuration_NonConsolidatedMember_NonConsolidatedMember",
		"currentyearduration",
		"",
	];
	const header = EDINET_CSV_HEADER.map((field) => `"${field}"`).join("\t");
	const line = (fields: readonly string[]) => fields.map((field) => `"${field}"`).join("\t");
	const dei = (element: string, value: string) =>
		line([element, "x", "FilingDateInstant", "提出日時点", "その他", "時点", "－", "－", value]);
	const fact = (concept: string, context: string, value: string, unit = "JPY") =>
		line([concept, "x", context, "当期", "連結", "期間", unit, "円", value]);
	const csvTexts: string[] = [
		...EDINET_FIXTURE_DOCUMENTS.map(edinetReportCsv),
		[
			header,
			fact("jppfs_cor:NetSales", "CurrentYearDuration", "100"),
			dei("jpdei_cor:CurrentFiscalYearStartDateDEI", "2024-04-01"),
			dei("jpdei_cor:CurrentFiscalYearEndDateDEI", "2025-03-31"),
		].join("\n"),
		[
			header,
			dei("jpdei_cor:AccountingStandardsDEI", "IFRS"),
			dei("jpdei_cor:CurrentFiscalYearEndDateDEI", "2025-03-31"),
			fact("jppfs_cor:Assets", "CurrentYearInstant", "1"),
			fact("jppfs_cor:NetSales", "CurrentYearDuration", "1"),
		].join("\r\n"),
		[
			header,
			dei("jpdei_cor:AccountingStandardsDEI", "US GAAP"),
			dei("jpdei_cor:PreviousFiscalYearStartDateDEI", "2023-04-01"),
			dei("jpdei_cor:PreviousFiscalYearEndDateDEI", "2024-02-30"),
			fact("jppfs_cor:NetSales", "Prior1YearDuration", "1"),
			fact("jppfs_cor:Assets", "Prior1YearInstant", "2"),
		].join("\n"),
		[
			header,
			dei("jpdei_cor:AccountingStandardsDEI", "Japan GAAP "),
			fact("jppfs_cor:NetSales", "CurrentYearDuration", "1", ""),
			fact("jppfs_cor:NetSales", "CurrentYearDuration", "1", "x".repeat(41)),
			fact("jppfs_cor:NetSales", "CurrentYearDuration", "－"),
		].join("\n"),
		`${header}\textra\n${fact("jppfs_cor:NetSales", "CurrentYearDuration", "1")}`,
		fact("jppfs_cor:NetSales", "CurrentYearDuration", "1"),
		"",
		`\n${header}\n`,
		`${header}\n"short"\t"row"\n${line(["jppfs_cor:NetSales", "x", "CurrentYearDuration", "", "", "", "JPY", "", "1", "extra"])}`,
	];
	const entryLists: string[][] = [
		[
			"XBRL_TO_CSV/jpaud-aar-cn-001_E1.csv",
			"XBRL_TO_CSV/jpcrp030000-asr-001_E1_02.csv",
			"XBRL_TO_CSV/jpcrp030000-asr-001_E1_01.csv",
			"XBRL_TO_CSV/sub/jpcrp-x.csv",
			"jpcrp-root.csv",
			"XBRL_TO_CSV/jpcrp-notes.txt",
		],
		["XBRL_TO_CSV/jpaud.csv"],
		[],
		["XBRL_TO_CSV/jpcrp.csv", "XBRL_TO_CSV/jpcrp.csv"],
		[
			"XBRL_TO_CSV/JPCRP.csv",
			"xbrl_to_csv/jpcrp.csv",
			"XBRL_TO_CSV/jpcrp.CSV",
			"XBRL_TO_CSV/jpcrpZ.csv",
			"XBRL_TO_CSV/jpcrpA.csv",
		],
	];
	const zips: { name: string; input: unknown; bytes: Uint8Array }[] = [
		...EDINET_FIXTURE_DOCUMENTS.map((document) => {
			const name = `edinet-${document.docId}.synthetic.zip`;
			return { name, input: { fixture: name }, bytes: fixtureBytes(name) };
		}),
	];
	const inlineZip = (name: string, bytes: Uint8Array) =>
		zips.push({ name, input: { base64: base64(bytes) }, bytes });
	inlineZip("json-error", new TextEncoder().encode('{"metadata":{"status":"404"}}'));
	inlineZip(
		"audit-only",
		buildTestZip([{ name: "XBRL_TO_CSV/jpaud-x.csv", bytes: utf16(header, true), method: 0 }]),
	);
	inlineZip(
		"no-header",
		buildTestZip([{ name: "XBRL_TO_CSV/jpcrp-x.csv", bytes: utf16('"a"\t"b"', true), method: 0 }]),
	);
	inlineZip(
		"odd-utf16",
		buildTestZip([
			{ name: "XBRL_TO_CSV/jpcrp-x.csv", bytes: new Uint8Array([0xff, 0xfe, 0x22]), method: 0 },
		]),
	);
	inlineZip(
		"two-reports",
		buildTestZip([
			{
				name: "XBRL_TO_CSV/jpcrp-b.csv",
				bytes: utf16(`${header}\n${dei("jpdei_cor:AccountingStandardsDEI", "IFRS")}`, true),
				method: 0,
			},
			{
				name: "XBRL_TO_CSV/jpcrp-a.csv",
				bytes: utf16(`${header}\n${dei("jpdei_cor:AccountingStandardsDEI", "Japan GAAP")}`, false),
				method: 0,
			},
		]),
	);
	return {
		path: "finance/equity_sync_edinet.json",
		content: {
			concepts: EDINET_CONCEPTS,
			parseEdinetDocumentList: listInputs.map((input) => ({
				document: input,
				output: resultJson(parseEdinetDocumentList(resolve(input))),
			})),
			edinetErrorStatus: [
				{ metadata: { status: "404", message: "Not Found" } },
				{ metadata: { status: "200" } },
				{ metadata: { status: "4040" } },
				{ metadata: { status: 404 } },
				{ StatusCode: 401, message: "Access denied" },
				{ statusCode: 429 },
				{ StatusCode: 99 },
				{ StatusCode: 600 },
				{ StatusCode: 401.5 },
				{ metadata: { status: "x" }, StatusCode: 403 },
				{ message: "x" },
				"x",
				null,
				[],
			].map((body) => ({ body, output: edinetErrorStatus(body) })),
			edinetIdentity: identityCases,
			edinetDownloadPlan: planCases,
			decodeUtf16Le: utfCases.map((bytes) => ({
				base64: base64(bytes),
				output: resultJson(decodeUtf16Le(bytes)),
			})),
			forEachTsvRow: tsvTexts.map((text) => ({ text, output: tsvRows(text) })),
			edinetContext: contexts.map((input) => ({ input, output: edinetContext(input) })),
			parseEdinetCsv: csvTexts.flatMap((text) =>
				[EDINET_CONCEPTS, ["jppfs_cor:NetSales"]].map((concepts) => ({
					text,
					concepts,
					output: resultJson(parseEdinetCsv(text, concepts)),
				})),
			),
			selectEdinetReportEntry: entryLists.map((names) => ({
				names,
				output: selectEdinetReportEntry(names),
			})),
			edinetBusinessParagraphs: edinetBusinessCases(),
			extractEdinetReport: zips.map((zip) => ({
				name: zip.name,
				archive: zip.input,
				output: resultJson(extractEdinetReport(zip.bytes, EDINET_CONCEPTS)),
			})),
		},
	};
}

/* ---------- Whole source runs ---------- */

type Answer =
	| { readonly fixture: string }
	| { readonly text: string }
	| { readonly base64: string }
	| { readonly error: SafeFetchError };

function answerOf(
	answer: Answer,
): { text: string } | { bytes: Uint8Array } | { error: SafeFetchError } {
	if ("fixture" in answer)
		return answer.fixture.endsWith(".zip")
			? { bytes: fixtureBytes(answer.fixture) }
			: { text: fixtureText(answer.fixture) };
	if ("base64" in answer) return { bytes: new Uint8Array(Buffer.from(answer.base64, "base64")) };
	return answer;
}

interface SourceJob {
	readonly target: Omit<
		Extract<ClaimedJob, { kind: "financial-sync" }>,
		| "kind"
		| "runId"
		| "leaseGeneration"
		| "leaseExpiresAt"
		| "attempt"
		| "heartbeatIntervalMs"
		| "sources"
	>;
	/** Pacing answers (true once used up). */
	readonly grants: readonly boolean[];
	/** Clock advance before this job. */
	readonly advanceMs: number;
}

interface SourceScenario {
	readonly name: string;
	readonly provider: EquityProvider;
	/** SEC_USER_AGENT or EDINET_API_KEY. */
	readonly credential: string | null;
	readonly answers: readonly (readonly [string, Answer])[];
	readonly jobs: readonly SourceJob[];
}

const SOURCE_START_MS = Date.UTC(2026, 9, 31, 3, 0, 0);
const EDINET_KEY = "vector-edinet-key-01";
const SEC_AGENT = "Synthetic Research Workspace owner@synthetic-wire.org";

async function runScenario(scenario: SourceScenario): Promise<unknown> {
	let now = SOURCE_START_MS;
	const clock = { nowMs: () => now, nowIso: () => new Date(now).toISOString() };
	const answers = new Map(scenario.answers.map(([url, answer]) => [url, answerOf(answer)]));
	let calls: (RecordedCall & { kind: string })[] = [];
	const take = (url: string) =>
		answers.get(url) ?? { error: { code: "HTTP_ERROR" as const, detail: "HTTP 404", status: 404 } };
	const fetcher = {
		async fetchText(url: string, options: Parameters<typeof normalizeCall>[1]) {
			calls.push({ ...normalizeCall(url, options), kind: "text" });
			const answer = take(url);
			if ("error" in answer) return err(answer.error);
			if ("bytes" in answer)
				return err({ code: "NETWORK_ERROR" as const, detail: "bytes for text" });
			return ok({ finalUrl: url, contentType: "application/json", text: answer.text });
		},
		async fetchBytes(url: string, options: Parameters<typeof normalizeCall>[1]) {
			calls.push({ ...normalizeCall(url, options), kind: "bytes" });
			const answer = take(url);
			if ("error" in answer) return err(answer.error);
			return ok({
				finalUrl: url,
				contentType: null,
				bytes: "bytes" in answer ? answer.bytes : new TextEncoder().encode(answer.text),
			});
		},
	};
	const source: EquitySyncSource =
		scenario.provider === "sec"
			? createSecAnnualFilingsSource({
					fetcher,
					clock,
					userAgent: scenario.credential,
					sleep: async () => {},
				})
			: createEdinetSource({ binaryFetcher: fetcher, apiKey: scenario.credential });
	const runs: unknown[] = [];
	for (const job of scenario.jobs) {
		now += job.advanceMs;
		calls = [];
		let grants = 0;
		const result = await source.sync({
			target: job.target,
			signal: new AbortController().signal,
			beforeRequest: async () => {
				const answer = job.grants[grants] ?? true;
				grants += 1;
				return answer;
			},
		});
		runs.push({ requests: calls, grants, result: resultJson(result) });
	}
	return { ...scenario, runs };
}

function secTarget(source: Partial<SecSyncRequest>, symbol = "SYND"): SourceJob["target"] {
	return {
		companyId: "eqc_us",
		market: "US",
		symbol,
		concepts: [...SEC_CONCEPTS],
		source: {
			provider: "sec",
			cik: SEC_CIK,
			knownAccessions: [],
			pendingFilings: [],
			filedSince: "2020-10-31",
			fullCheck: false,
			describedDocumentId: null,
			...source,
		},
	};
}

function edinetTarget(
	source: Partial<Extract<SourceJob["target"]["source"], { provider: "edinet" }>>,
): SourceJob["target"] {
	return {
		companyId: "eqc_jp",
		market: "JP",
		symbol: "9999",
		concepts: [...EDINET_CONCEPTS],
		source: {
			provider: "edinet",
			secCode: "99990",
			edinetCode: null,
			knownFilings: [],
			pendingFilings: [],
			indexedFilings: [],
			describeFiling: null,
			...source,
		},
	};
}

async function sourcesFile(): Promise<VectorFile> {
	const http = (status: number): Answer => ({
		error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status },
	});
	const secPages: [string, Answer][] = [
		[`https://data.sec.gov/submissions/CIK${SEC_CIK}.json`, { fixture: SUBMISSIONS }],
		[`https://data.sec.gov/api/xbrl/companyfacts/CIK${SEC_CIK}.json`, { fixture: COMPANY_FACTS }],
		[
			SEC_TICKER_DIRECTORY_URL,
			{
				text: JSON.stringify({
					fields: ["cik", "name", "ticker", "exchange"],
					data: [[9999981, "Synthetic Devices Inc.", "SYND", "Nasdaq"]],
				}),
			},
		],
		[SEC_FIXTURE_TEN_K.url, { fixture: SEC_FIXTURE_TEN_K.fileName }],
	];
	const job = (
		target: SourceJob["target"],
		grants: readonly boolean[] = [],
		advanceMs = 0,
	): SourceJob => ({ target, grants, advanceMs });
	const allAnnual = [
		"0009999981-20-000105",
		"0009999981-21-000107",
		"0009999981-22-000104",
		"0009999981-23-000106",
		"0009999981-24-000108",
		"0009999981-25-000110",
		"0009999981-26-000005",
	];
	const scenarios: SourceScenario[] = [
		{
			name: "sec unconfigured",
			provider: "sec",
			credential: null,
			answers: secPages,
			jobs: [job(secTarget({}))],
		},
		{
			name: "sec unusable agent",
			provider: "sec",
			credential: "no contact",
			answers: secPages,
			jobs: [job(secTarget({}))],
		},
		{
			name: "sec first sync resolves the CIK, then the list is cached",
			provider: "sec",
			credential: SEC_AGENT,
			answers: secPages,
			jobs: [
				job(secTarget({ cik: null, fullCheck: true })),
				job(secTarget({ cik: null, knownAccessions: allAnnual }), [], 60_000),
				job(secTarget({ cik: null, knownAccessions: allAnnual }), [], 12 * 3_600_000),
			],
		},
		{
			name: "sec nothing new",
			provider: "sec",
			credential: SEC_AGENT,
			answers: secPages,
			jobs: [job(secTarget({ knownAccessions: allAnnual }))],
		},
		{
			name: "sec ticker not listed",
			provider: "sec",
			credential: SEC_AGENT,
			answers: secPages,
			jobs: [job(secTarget({ cik: null }, "NOPE"))],
		},
		{
			name: "sec ticker list missing",
			provider: "sec",
			credential: SEC_AGENT,
			answers: [[SEC_TICKER_DIRECTORY_URL, http(404)]],
			jobs: [job(secTarget({ cik: null }))],
		},
		{
			name: "sec ticker list malformed",
			provider: "sec",
			credential: SEC_AGENT,
			answers: [[SEC_TICKER_DIRECTORY_URL, { text: "[]" }]],
			jobs: [job(secTarget({ cik: null }))],
		},
		...[401, 403, 404, 429, 500, 503].map(
			(status): SourceScenario => ({
				name: `sec submissions ${status}`,
				provider: "sec",
				credential: SEC_AGENT,
				answers: [[secPages[0]?.[0] ?? "", http(status)], ...secPages.slice(1)],
				jobs: [job(secTarget({}))],
			}),
		),
		...[403, 404, 429, 500].map(
			(status): SourceScenario => ({
				name: `sec company facts ${status}`,
				provider: "sec",
				credential: SEC_AGENT,
				answers: [secPages[0] ?? ["", http(500)], [secPages[1]?.[0] ?? "", http(status)]],
				jobs: [job(secTarget({}))],
			}),
		),
		{
			name: "sec submissions malformed",
			provider: "sec",
			credential: SEC_AGENT,
			answers: [[secPages[0]?.[0] ?? "", { text: '{"filings":{}}' }]],
			jobs: [job(secTarget({}))],
		},
		{
			name: "sec company facts not JSON",
			provider: "sec",
			credential: SEC_AGENT,
			answers: [secPages[0] ?? ["", http(500)], [secPages[1]?.[0] ?? "", { text: "{" }]],
			jobs: [job(secTarget({}))],
		},
		{
			name: "sec timeout",
			provider: "sec",
			credential: SEC_AGENT,
			answers: [[secPages[0]?.[0] ?? "", { error: { code: "TIMEOUT", detail: "x" } }]],
			jobs: [job(secTarget({}))],
		},
		{
			name: "sec too large",
			provider: "sec",
			credential: SEC_AGENT,
			answers: [[secPages[0]?.[0] ?? "", { error: { code: "RESPONSE_TOO_LARGE", detail: "x" } }]],
			jobs: [job(secTarget({}))],
		},
		{
			name: "sec gate stops",
			provider: "sec",
			credential: SEC_AGENT,
			answers: secPages,
			jobs: [
				job(secTarget({}), [false]),
				job(secTarget({ fullCheck: true }), [true, false]),
				job(secTarget({ cik: null }), [false]),
			],
		},
		// The business description (ADR-0053): the newest original 10-K's primary document.
		{
			name: "sec business description read only for a 10-K not described yet",
			provider: "sec",
			credential: SEC_AGENT,
			answers: secPages,
			jobs: [
				job(secTarget({ knownAccessions: allAnnual })),
				job(
					secTarget({
						knownAccessions: allAnnual,
						describedDocumentId: SEC_FIXTURE_TEN_K.accession,
					}),
				),
				job(secTarget({ knownAccessions: allAnnual, describedDocumentId: "0009999981-24-000108" })),
				job(secTarget({ fullCheck: true, describedDocumentId: null })),
			],
		},
		...(
			[
				["404", http(404)],
				["429", http(429)],
				["503", http(503)],
				["timeout", { error: { code: "TIMEOUT", detail: "x" } }],
				["too large", { error: { code: "RESPONSE_TOO_LARGE", detail: "x" } }],
				["off-host redirect", { error: { code: "UNSAFE_REDIRECT", detail: "x", status: 302 } }],
				[
					"without the section",
					{ text: "<html><body><p>Item 1. Business</p><p>Item 1A. Risk Factors</p></body></html>" },
				],
				["empty", { text: "" }],
			] as const
		).map(
			([label, answer]): SourceScenario => ({
				name: `sec business description ${label}`,
				provider: "sec",
				credential: SEC_AGENT,
				answers: [[SEC_FIXTURE_TEN_K.url, answer], ...secPages.slice(0, 3)],
				jobs: [job(secTarget({ knownAccessions: allAnnual }))],
			}),
		),
		{
			name: "sec business description gate stops",
			provider: "sec",
			credential: SEC_AGENT,
			answers: secPages,
			jobs: [job(secTarget({ knownAccessions: allAnnual }), [true, false])],
		},
	];
	// The EDINET source downloads what the claim names (ADR-0058 §4): no date list here.
	const edinetPages: [string, Answer][] = EDINET_FIXTURE_DOCUMENTS.map(
		(document): [string, Answer] => [
			edinetDocumentUrl(document.docId, EDINET_KEY),
			{ fixture: `edinet-${document.docId}.synthetic.zip` },
		],
	);
	const indexedAll = edinetIndexedFilings(
		edinetFixtureDates()
			.flatMap((date) => rowsOf(date))
			.filter((row) => row.secCode === "99990"),
	);
	const indexedOf = (...docIds: string[]): EquityPendingFiling[] =>
		docIds.map((docId) => {
			const filing = indexedAll.find((entry) => entry.sourceDocumentId === docId);
			if (filing === undefined) throw new Error(`no indexed fixture ${docId}`);
			return filing;
		});
	const withPage = (url: string, answer: Answer): [string, Answer][] => [
		[url, answer],
		...edinetPages.filter(([page]) => page !== url),
	];
	const s25 = edinetDocumentUrl("S100SY25", EDINET_KEY);
	const pending25: EquityPendingFiling = {
		sourceDocumentId: "S100SY25",
		form: "securities-report",
		filedOn: "2025-06-20",
		submittedAt: null,
		periodStart: null,
		periodEnd: "2025-03-31",
		amendsSourceDocumentId: null,
		sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100SY25",
	};
	const one25 = { edinetCode: "E99991", indexedFilings: indexedOf("S100SY25") };
	scenarios.push(
		{
			name: "edinet unconfigured",
			provider: "edinet",
			credential: null,
			answers: edinetPages,
			jobs: [job(edinetTarget({ indexedFilings: indexedAll }))],
		},
		{
			name: "edinet every indexed report",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [job(edinetTarget({ edinetCode: "E99991", indexedFilings: indexedAll }))],
		},
		{
			name: "edinet pending first, a pending document gone, a stored one skipped",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(
					edinetTarget({
						indexedFilings: indexedAll,
						pendingFilings: [pending25, { ...pending25, sourceDocumentId: "S100GONE" }],
						knownFilings: [knownOf("S100SY20")],
					}),
				),
			],
		},
		{
			name: "edinet nothing indexed",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ secCode: "77770", edinetCode: "E77777" })),
				job(edinetTarget({ secCode: "77770" })),
			],
		},
		...[401, 403, 404, 429, 500].map(
			(status): SourceScenario => ({
				name: `edinet document ${status}`,
				provider: "edinet",
				credential: EDINET_KEY,
				answers: withPage(s25, http(status)),
				jobs: [
					job(edinetTarget({ indexedFilings: indexedOf("S100SY24", "S100SY25", "S100SYA4") })),
				],
			}),
		),
		{
			name: "edinet amendment named with its original's period, CSV not there yet",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(edinetDocumentUrl("S100SYA4", EDINET_KEY), http(404)),
			jobs: [
				job(
					edinetTarget({
						indexedFilings: indexedOf("S100SYA4"),
						knownFilings: [knownOf("S100SY24"), knownOf("S100SY25")],
					}),
				),
			],
		},
		...(
			[
				["JSON 404", { text: '{"metadata":{"status":"404","message":"Not Found"}}' }],
				["gateway 401", { text: '{"StatusCode":401,"message":"Access denied"}' }],
				["gateway 429", { text: '{"StatusCode":429,"message":"Too Many Requests"}' }],
				["JSON 200", { text: '{"metadata":{"status":"200"}}' }],
				["garbage", { text: "maintenance" }],
				[
					"without report",
					{
						base64: base64(buildTestZip([{ name: "XBRL_TO_CSV/jpaud.csv", text: "x", method: 0 }])),
					},
				],
				["timeout", { error: { code: "TIMEOUT", detail: "x" } }],
				["too large", { error: { code: "RESPONSE_TOO_LARGE", detail: "x" } }],
			] as const
		).map(
			([label, answer]): SourceScenario => ({
				name: `edinet document ${label}`,
				provider: "edinet",
				credential: EDINET_KEY,
				answers: withPage(s25, answer),
				jobs: [job(edinetTarget(one25))],
			}),
		),
		{
			// One unreadable document never stops the others (each is not available, listed once).
			name: "edinet every indexed report with unreadable documents",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: [
				[
					edinetDocumentUrl("S100SY23", EDINET_KEY),
					{ base64: base64(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 1, 2])) },
				],
				[
					edinetDocumentUrl("S100SY21", EDINET_KEY),
					{
						base64: base64(
							buildTestZip([
								{
									name: "XBRL_TO_CSV/jpcrp030000-asr-001.csv",
									bytes: utf16('"a"\t"b"', true),
									method: 0,
								},
							]),
						),
					},
				],
				...edinetPages.filter(
					([page]) =>
						page !== edinetDocumentUrl("S100SY23", EDINET_KEY) &&
						page !== edinetDocumentUrl("S100SY21", EDINET_KEY),
				),
			],
			jobs: [job(edinetTarget({ indexedFilings: indexedAll }))],
		},
		{
			name: "edinet over the download cap",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(
					edinetTarget({
						pendingFilings: [
							{ ...pending25, sourceDocumentId: "S100PD01" },
							{ ...pending25, sourceDocumentId: "S100PD02" },
						],
						indexedFilings: indexedAll,
					}),
				),
			],
		},
		{
			name: "edinet gate stops",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ indexedFilings: indexedAll }), [true, false]),
				job(edinetTarget(one25), [false]),
			],
		},
	);
	// The business description (ADR-0053): 事業の内容 of the reports read, and the claim's describeFiling.
	const allKnown = EDINET_FIXTURE_DOCUMENTS.map((document) => knownOf(document.docId));
	const stored = (docId: string): EquityPendingFiling => {
		const year = 2020 + Number(docId.slice(-1));
		return {
			sourceDocumentId: docId,
			form: "securities-report",
			filedOn: `${year}-06-20`,
			submittedAt: null,
			periodStart: `${year - 1}-04-01`,
			periodEnd: `${year}-03-31`,
			amendsSourceDocumentId: null,
			sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${docId}`,
		};
	};
	const s23 = edinetDocumentUrl("S100SY23", EDINET_KEY);
	scenarios.push(
		{
			name: "edinet business description of a report without 事業の内容, and of an amendment alone",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ indexedFilings: indexedOf("S100SY20") })),
				job(
					edinetTarget({
						indexedFilings: indexedOf("S100SYA4"),
						knownFilings: [knownOf("S100SY24")],
					}),
				),
			],
		},
		{
			name: "edinet describeFiling read alone, planned anyway, or older than a report read",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ knownFilings: allKnown, describeFiling: stored("S100SY23") })),
				job(edinetTarget({ indexedFilings: indexedOf("S100SY25"), describeFiling: pending25 })),
				job(
					edinetTarget({
						indexedFilings: indexedOf("S100SY25"),
						describeFiling: stored("S100SY22"),
					}),
				),
				job(edinetTarget({ pendingFilings: [pending25], describeFiling: pending25 })),
			],
		},
		{
			name: "edinet describeFiling over the download cap or not an original report",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(
					edinetTarget({
						indexedFilings: indexedAll,
						pendingFilings: [{ ...stored("S100SY21"), sourceDocumentId: "S100SZ01" }],
						describeFiling: { ...stored("S100SY23"), sourceDocumentId: "S100SX19" },
					}),
				),
				job(
					edinetTarget({
						knownFilings: allKnown,
						describeFiling: { ...stored("S100SY24"), form: "amended-securities-report" },
					}),
				),
			],
		},
		...(
			[
				["404", http(404)],
				["500", http(500)],
				["timeout", { error: { code: "TIMEOUT", detail: "x" } }],
				["error body", { text: '{"metadata":{"status":"404","message":"Not Found"}}' }],
				[
					"not a report",
					{ base64: base64(buildTestZip([{ name: "a.txt", text: "x", method: 0 }])) },
				],
			] as const
		).map(
			([label, answer]): SourceScenario => ({
				name: `edinet describeFiling ${label}`,
				provider: "edinet",
				credential: EDINET_KEY,
				answers: withPage(s23, answer),
				jobs: [job(edinetTarget({ knownFilings: allKnown, describeFiling: stored("S100SY23") }))],
			}),
		),
		{
			name: "edinet describeFiling gate stops",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ knownFilings: allKnown, describeFiling: stored("S100SY23") }), [false]),
			],
		},
	);
	const runs: unknown[] = [];
	for (const scenario of scenarios) runs.push(plain(await runScenario(scenario)));
	return {
		path: "finance/equity_sync_sources.json",
		content: { startMs: SOURCE_START_MS, scenarios: runs },
	};
}

/* ---------- The runner's job body ---------- */

function recordingLogger(lines: unknown[]): EventLogger {
	const record = (level: string) => (event: string, fields?: LogFields) => {
		lines.push({ level, event, ...(fields ?? {}) });
	};
	return {
		info: record("info"),
		warn: record("warn"),
		error: record("error"),
		logFailures: () => 0,
	};
}

async function jobsFile(): Promise<VectorFile> {
	const e2eSec = fixtureJson("e2e-sec.json");
	const e2eEdinet = fixtureJson("e2e-edinet.json");
	const filingsOf = (value: unknown): EquityFilingResult[] =>
		typeof value === "object" &&
		value !== null &&
		"filings" in value &&
		Array.isArray(value.filings)
			? value.filings
			: [];
	const identityOf = (value: unknown): EquitySyncData["identity"] =>
		typeof value === "object" &&
		value !== null &&
		"identity" in value &&
		typeof value.identity === "object" &&
		value.identity !== null &&
		"sourceCompanyId" in value.identity &&
		typeof value.identity.sourceCompanyId === "string"
			? {
					sourceCompanyId: value.identity.sourceCompanyId,
					name:
						"name" in value.identity && typeof value.identity.name === "string"
							? value.identity.name
							: null,
					fiscalYearEnd:
						"fiscalYearEnd" in value.identity && typeof value.identity.fiscalYearEnd === "string"
							? value.identity.fiscalYearEnd
							: null,
				}
			: null;
	const descriptionOf = (value: unknown): EquityBusinessDescription => {
		if (typeof value !== "object" || value === null || !("description" in value)) {
			throw new Error("an E2E completion without a description");
		}
		return equityBusinessDescriptionSchema.parse(value.description);
	};
	type Scripted =
		| { readonly ok: EquitySyncData }
		| { readonly err: EquitySyncFailure }
		| { readonly throws: string }
		| "absent";
	const cases: { provider: EquityProvider; answer: Scripted }[] = [
		{ provider: "sec", answer: "absent" },
		{ provider: "edinet", answer: "absent" },
		{
			provider: "sec",
			answer: {
				ok: {
					identity: identityOf(e2eSec),
					filings: filingsOf(e2eSec),
					more: false,
					requests: 3,
					unreadableDocuments: [],
					descriptionUnread: null,
					description: descriptionOf(e2eSec),
				},
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: identityOf(e2eEdinet),
					filings: filingsOf(e2eEdinet),
					more: true,
					requests: 9,
					unreadableDocuments: [
						{ sourceDocumentId: "S100SY23", problem: "NOT_A_ZIP" },
						{ sourceDocumentId: "S100SY21", problem: "MISSING_HEADER" },
					],
					descriptionUnread: null,
					description: descriptionOf(e2eEdinet),
				},
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: null,
					filings: [],
					more: false,
					requests: 0,
					unreadableDocuments: [],
					descriptionUnread: null,
					description: null,
				},
			},
		},
		{
			provider: "sec",
			answer: {
				ok: {
					identity: { sourceCompanyId: "E99991", name: null, fiscalYearEnd: null },
					filings: [],
					more: false,
					requests: 1,
					unreadableDocuments: [],
					descriptionUnread: null,
					description: null,
				},
			},
		},
		{
			provider: "sec",
			answer: {
				ok: {
					identity: null,
					filings: [],
					more: false,
					requests: 1,
					unreadableDocuments: [
						{ sourceDocumentId: "S100SY25", problem: "NO_REPORT_ENTRY" },
						{ sourceDocumentId: "S100SYA4", problem: "PERIOD_UNKNOWN" },
					],
					descriptionUnread: null,
					description: null,
				},
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: null,
					filings: filingsOf(e2eSec).slice(0, 1),
					more: false,
					requests: 1,
					unreadableDocuments: [],
					descriptionUnread: null,
					description: null,
				},
			},
		},
		// A description of the other provider's filing: refused before it is sent (ADR-0053).
		{
			provider: "sec",
			answer: {
				ok: {
					identity: identityOf(e2eSec),
					filings: [],
					more: false,
					requests: 2,
					unreadableDocuments: [],
					descriptionUnread: null,
					description: descriptionOf(e2eEdinet),
				},
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: identityOf(e2eEdinet),
					filings: [],
					more: false,
					requests: 1,
					unreadableDocuments: [],
					descriptionUnread: null,
					description: {
						...descriptionOf(e2eEdinet),
						status: "not-found",
						paragraphs: [],
						truncated: false,
					},
				},
			},
		},
		// A description read that failed: logged, the job still completes (ADR-0053).
		{
			provider: "sec",
			answer: {
				ok: {
					identity: identityOf(e2eSec),
					filings: filingsOf(e2eSec),
					more: false,
					requests: 4,
					unreadableDocuments: [],
					description: null,
					descriptionUnread: { code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: 503 },
				},
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: identityOf(e2eEdinet),
					filings: [],
					more: false,
					requests: 1,
					unreadableDocuments: [],
					description: null,
					descriptionUnread: { code: "NOT_A_ZIP", upstreamStatus: null },
				},
			},
		},
		{ provider: "sec", answer: { throws: "TypeError" } },
	];
	for (const code of EQUITY_SYNC_FAILURE_CODES) {
		for (const upstreamStatus of [null, 403, 429, 503] as const) {
			cases.push({ provider: "sec", answer: { err: { code, upstreamStatus, requests: 1 } } });
		}
	}
	const out: unknown[] = [];
	for (const [index, entry] of cases.entries()) {
		const { api, calls } = createFakeApi();
		const harness = createDeps(api);
		const logs: unknown[] = [];
		const paced: unknown[] = [];
		const pacer: MarketRequestPacer = {
			async pace(provider, _signal, requests) {
				paced.push([provider, requests ?? null]);
				return true;
			},
			// Financial sources pace through `pace`; an admission would show as its own entry.
			async admit(provider) {
				paced.push([provider, "admit"]);
				return "granted";
			},
		};
		const answer = entry.answer;
		const source: EquitySyncSource = {
			provider: entry.provider,
			async sync(query) {
				await query.beforeRequest();
				// "absent" registers no source, so it never runs.
				if (answer === "absent") throw new Error("no source");
				if ("throws" in answer) throw new TypeError(answer.throws);
				if ("err" in answer) return err(answer.err);
				return ok(answer.ok);
			},
		};
		const job: Extract<ClaimedJob, { kind: "financial-sync" }> = {
			kind: "financial-sync",
			runId: `run_fs_${index}`,
			leaseGeneration: 3,
			leaseExpiresAt: "2026-10-31T00:01:30.000Z",
			attempt: 1,
			heartbeatIntervalMs: 20_000,
			sources: [],
			...(entry.provider === "sec"
				? secTarget({ fullCheck: true })
				: edinetTarget({ edinetCode: "E99991" })),
		};
		await executeJob(
			job,
			{
				...harness.deps,
				logger: recordingLogger(logs),
				marketPacer: pacer,
				equitySyncSources: answer === "absent" ? new Map() : new Map([[entry.provider, source]]),
			},
			new AbortController().signal,
		);
		out.push(
			plain({
				job,
				answer,
				clockIso: harness.time.clock.nowIso(),
				output: {
					completion: calls.completions[0] ?? null,
					logs: logs.filter(
						(line) =>
							typeof line === "object" &&
							line !== null &&
							"event" in line &&
							typeof line.event === "string" &&
							(line.event.startsWith("financial_sync") || line.event === "job_finished"),
					),
					paced,
				},
			}),
		);
	}
	return { path: "finance/equity_sync_jobs.json", content: { cases: out } };
}

export const equitySyncExporter: VectorExporter = {
	name: "equity-sync",
	async build(): Promise<readonly VectorFile[]> {
		checkFixtures();
		return [
			domainFile(),
			sharedFile(),
			secFile(),
			edinetFile(),
			await sourcesFile(),
			await jobsFile(),
		];
	},
};
