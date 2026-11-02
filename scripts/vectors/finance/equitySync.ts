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
 * - `finance/equity_sync_sources.json` — whole source runs (SEC and
 *   J-Quants, ADR-0059 §2) over a URL-keyed scripted fetcher (requests,
 *   pacing grants, results);
 * - `finance/equity_sync_jobs.json` — the runner's `financial-sync` body
 *   (completion, log lines, pacing keys and holds) over scripted source answers.
 *
 * J-Quants' summaries → filings rule has its own vectors
 * (`jquantsFinancials.ts`).
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
	EquityBusinessDescription,
	EquityBusinessSource,
	EquityFilingResult,
	EquityPendingFiling,
	JquantsSyncRequest,
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
	createJquantsFinancialsSource,
	jquantsSummariesToSync,
} from "../../../packages/adapters/src/finance/jquantsFinancials.ts";
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
import { htmlToMarkdown } from "../../../packages/adapters/src/tools/htmlToMarkdown.ts";
import { doubleBits, randomDouble, type VectorExporter, type VectorFile } from "../shared.ts";
import {
	EQUITY_SYNC_FIXTURE_DIR,
	equitySyncFixtureFiles,
	JQUANTS_FIXTURE_CODE,
	jquantsFixtureRecords,
	SEC_EQUITY_FIXTURE_CIK,
	SEC_EQUITY_FIXTURE_FILINGS,
	SEC_FIXTURE_TEN_K,
	SEC_FOREIGN_FIXTURE_CIK,
	SEC_FOREIGN_FIXTURE_TWENTY_F,
} from "./equitySyncFixtures.ts";
import { normalizeCall, plain, type RecordedCall, Rng } from "./support.ts";

const SEC_CONCEPTS = equityConceptsOfProvider("sec");
const JQUANTS_CONCEPTS = equityConceptsOfProvider("jquants");
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
function resultJson<T, E>(result: Result<T, E>): unknown {
	return result.ok ? { ok: plain(result.value) } : { err: plain(result.error) };
}

/* ---------- Fixture freshness ---------- */

/** Committed fixtures equal a fresh build. */
function checkFixtures(): void {
	const stale: string[] = [];
	for (const file of equitySyncFixtureFiles()) {
		let committed: string | null = null;
		try {
			committed = fixtureText(file.name);
		} catch {
			committed = null;
		}
		if (committed !== file.text) stale.push(file.name);
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
	const jquants = jquantsSummariesToSync(JQUANTS_FIXTURE_CODE, [], jquantsFixtureRecords());
	for (const filing of jquants.filings) factSets.push([...filing.facts]);
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

/** A 10-K, 20-F or 40-F a description was read from (only SEC filings describe, ADR-0059 §3). */
function randomBusinessSource(rng: Rng): EquityBusinessSource {
	const year = rng.int(2022, 2026);
	return {
		sourceDocumentId: `0000000001-${String(year).slice(2)}-00000${rng.int(1, 3)}`,
		form: rng.pick(["10-K", "20-F", "40-F"] as const),
		filedOn: `${year}-${rng.pick(["02-20", "06-26", "11-05"])}`,
		periodEnd: `${year - rng.int(0, 1)}-${rng.pick(["03-31", "09-30", "12-31"])}`,
		sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/000000000125000001/a.htm",
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
			: businessDescriptionOf(randomBusinessSource(rng), rng.pick(paragraphSets));
	return {
		businessDescriptionOf: paragraphSets.flatMap((business) =>
			[0, 1].map(() => {
				const source = randomBusinessSource(rng);
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
			concept: rng.pick(["us-gaap:A", "us-gaap:B", "jquants:A"]),
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

/* ---------- Whole source runs ---------- */

type Answer =
	| { readonly fixture: string }
	| { readonly text: string }
	| { readonly error: SafeFetchError };

function answerOf(answer: Answer): { text: string } | { error: SafeFetchError } {
	return "fixture" in answer ? { text: fixtureText(answer.fixture) } : answer;
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
	/** SEC_USER_AGENT or JQUANTS_API_KEY. */
	readonly credential: string | null;
	readonly answers: readonly (readonly [string, Answer])[];
	readonly jobs: readonly SourceJob[];
}

const SOURCE_START_MS = Date.UTC(2026, 9, 31, 3, 0, 0);
const JQUANTS_KEY = "vector-jquants-key-01";
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
			return ok({ finalUrl: url, contentType: "application/json", text: answer.text });
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
			: createJquantsFinancialsSource({ fetcher, apiKey: scenario.credential });
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

function jquantsTarget(source: Partial<JquantsSyncRequest>): SourceJob["target"] {
	return {
		companyId: "eqc_jp",
		market: "JP",
		symbol: JQUANTS_FIXTURE_CODE.slice(0, 4),
		concepts: [...JQUANTS_CONCEPTS],
		source: {
			provider: "jquants",
			code: JQUANTS_FIXTURE_CODE,
			knownDisclosures: [],
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
	// J-Quants (ADR-0059 §2): one query, every page, each page admitted by the gate.
	const summaryUrl = (page: string | null) =>
		`https://api.jquants.com/v2/fins/summary?code=${JQUANTS_FIXTURE_CODE}${page === null ? "" : `&pagination_key=${page}`}`;
	const records = jquantsFixtureRecords();
	const fullYears = records.flatMap((record) =>
		typeof record === "object" &&
		record !== null &&
		"DocType" in record &&
		"DiscNo" in record &&
		String(record.DocType).startsWith("FYFinancialStatements_")
			? [String(record.DiscNo)]
			: [],
	);
	const page = (data: readonly unknown[], next: string | null): Answer => ({
		text: JSON.stringify(next === null ? { data } : { data, pagination_key: next }),
	});
	const onePage: [string, Answer][] = [[summaryUrl(null), page(records, null)]];
	const half = Math.ceil(records.length / 2);
	const fetchError = (code: Exclude<SafeFetchError["code"], "HTTP_ERROR">): Answer => ({
		error: { code, detail: "x" },
	});
	scenarios.push(
		{
			name: "jquants unconfigured",
			provider: "jquants",
			credential: null,
			answers: onePage,
			jobs: [job(jquantsTarget({}))],
		},
		{
			name: "jquants first sync, then everything stored",
			provider: "jquants",
			credential: JQUANTS_KEY,
			answers: onePage,
			jobs: [
				job(jquantsTarget({})),
				job(jquantsTarget({ knownDisclosures: fullYears.slice(0, 1) }), [], 60_000),
				job(jquantsTarget({ knownDisclosures: fullYears }), [], 60_000),
			],
		},
		{
			name: "jquants two pages",
			provider: "jquants",
			credential: JQUANTS_KEY,
			answers: [
				[summaryUrl(null), page(records.slice(0, half), "p2")],
				[summaryUrl("p2"), page(records.slice(half), null)],
			],
			jobs: [job(jquantsTarget({}))],
		},
		{
			name: "jquants empty answer",
			provider: "jquants",
			credential: JQUANTS_KEY,
			answers: [[summaryUrl(null), page([], null)]],
			jobs: [job(jquantsTarget({}))],
		},
		{
			name: "jquants more pages than allowed",
			provider: "jquants",
			credential: JQUANTS_KEY,
			answers: Array.from({ length: 21 }, (_, index): [string, Answer] => [
				summaryUrl(index === 0 ? null : `p${index}`),
				page([], `p${index + 1}`),
			]),
			jobs: [job(jquantsTarget({}))],
		},
		...[{ text: '{"message":"x"}' }, { text: "[]" }, { text: "not json" }].map(
			(answer, index): SourceScenario => ({
				name: `jquants answer not a page ${index}`,
				provider: "jquants",
				credential: JQUANTS_KEY,
				answers: [[summaryUrl(null), answer]],
				jobs: [job(jquantsTarget({}))],
			}),
		),
		...[400, 401, 403, 404, 429, 500, 503].map(
			(status): SourceScenario => ({
				name: `jquants HTTP ${status}`,
				provider: "jquants",
				credential: JQUANTS_KEY,
				answers: [[summaryUrl(null), http(status)]],
				jobs: [job(jquantsTarget({}))],
			}),
		),
		...(["TIMEOUT", "NETWORK_ERROR", "RESPONSE_TOO_LARGE"] as const).map(
			(code): SourceScenario => ({
				name: `jquants ${code}`,
				provider: "jquants",
				credential: JQUANTS_KEY,
				answers: [[summaryUrl(null), fetchError(code)]],
				jobs: [job(jquantsTarget({}))],
			}),
		),
		{
			name: "jquants second page failed",
			provider: "jquants",
			credential: JQUANTS_KEY,
			answers: [
				[summaryUrl(null), page(records.slice(0, half), "p2")],
				[summaryUrl("p2"), http(429)],
			],
			jobs: [job(jquantsTarget({}))],
		},
		{
			name: "jquants gate stops",
			provider: "jquants",
			credential: JQUANTS_KEY,
			answers: [
				[summaryUrl(null), page(records.slice(0, half), "p2")],
				[summaryUrl("p2"), page(records.slice(half), null)],
			],
			jobs: [job(jquantsTarget({}), [false]), job(jquantsTarget({}), [true, false])],
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
	const e2eJquants = fixtureJson("e2e-jquants.json");
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
	const synced = (
		data: Partial<EquitySyncData> & Pick<EquitySyncData, "identity" | "filings">,
	): Scripted => ({
		ok: { more: false, requests: 1, description: null, descriptionUnread: null, ...data },
	});
	const cases: { provider: EquityProvider; answer: Scripted }[] = [
		{ provider: "sec", answer: "absent" },
		{ provider: "jquants", answer: "absent" },
		{
			provider: "sec",
			answer: synced({
				identity: identityOf(e2eSec),
				filings: filingsOf(e2eSec),
				requests: 3,
				description: descriptionOf(e2eSec),
			}),
		},
		{
			provider: "jquants",
			answer: synced({ identity: identityOf(e2eJquants), filings: filingsOf(e2eJquants) }),
		},
		{
			provider: "jquants",
			answer: synced({
				identity: identityOf(e2eJquants),
				filings: filingsOf(e2eJquants).slice(0, 1),
				more: true,
				requests: 2,
			}),
		},
		// An empty answer (an ETF, a REIT without XBRL): a success with nothing (ADR-0059 §2).
		{ provider: "jquants", answer: synced({ identity: null, filings: [] }) },
		// Identity and filings of the other provider: refused before they are sent.
		{ provider: "sec", answer: synced({ identity: identityOf(e2eJquants), filings: [] }) },
		{ provider: "sec", answer: synced({ identity: null, filings: filingsOf(e2eJquants) }) },
		{ provider: "jquants", answer: synced({ identity: identityOf(e2eSec), filings: [] }) },
		{
			provider: "jquants",
			answer: synced({ identity: null, filings: filingsOf(e2eSec).slice(0, 1) }),
		},
		// Only an SEC sync reads a business description (ADR-0059 §3).
		{
			provider: "jquants",
			answer: synced({
				identity: identityOf(e2eJquants),
				filings: [],
				description: descriptionOf(e2eSec),
			}),
		},
		// A description read that failed: logged, the job still completes (ADR-0053).
		{
			provider: "sec",
			answer: synced({
				identity: identityOf(e2eSec),
				filings: filingsOf(e2eSec),
				requests: 4,
				descriptionUnread: { code: "FINANCIAL_SOURCE_FAILED", upstreamStatus: 503 },
			}),
		},
		{ provider: "sec", answer: { throws: "TypeError" } },
		{ provider: "jquants", answer: { throws: "TypeError" } },
	];
	// A J-Quants rate limit also holds `jquants-fins` (ADR-0059 §2).
	for (const code of EQUITY_SYNC_FAILURE_CODES) {
		for (const upstreamStatus of [null, 429] as const) {
			cases.push({ provider: "jquants", answer: { err: { code, upstreamStatus, requests: 1 } } });
		}
	}
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
			hold(provider, ms) {
				paced.push([provider, "hold", ms]);
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
			...(entry.provider === "sec" ? secTarget({ fullCheck: true }) : jquantsTarget({})),
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
		return [domainFile(), sharedFile(), secFile(), await sourcesFile(), await jobsFile()];
	},
};
