/**
 * The financial statement sync (ADR-0048): conformance vectors the Rust
 * runner replays (crates `research-domain`, `research-finance`,
 * `research-runner`). Expected values come from the TypeScript reference:
 *
 * - `domain/equity_financials.json` — `isCanonicalDecimal`,
 *   `isAnnualDuration`, `fiscalYearOfPeriodEnd`, `annualFactsOfFiling`, and
 *   the SEC JSON-number → decimal text rule (`secValueDecimal`);
 * - `finance/equity_sync_shared.json` — failure mapping, canonical fact
 *   order, completion caps;
 * - `finance/equity_sync_sec.json` — submissions, company facts, the SEC
 *   sync result;
 * - `finance/equity_sync_edinet.json` — date lists, metadata, identity,
 *   download plan, UTF-16, TSV, CSV, report entry, report extraction;
 * - `finance/equity_sync_sources.json` — whole source runs over a URL-keyed
 *   scripted fetcher (requests, pacing grants, results, the EDINET cache);
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
	EquityFilingResult,
	EquityPendingFiling,
	SecSyncRequest,
} from "@research/contracts";
import { EQUITY_SYNC_FAILURE_CODES } from "@research/contracts";
import {
	annualFactsOfFiling,
	type EquityExtractedFact,
	type EquityProvider,
	equityConceptsOfProvider,
	err,
	fiscalYearOfPeriodEnd,
	isAnnualDuration,
	isCanonicalDecimal,
	isoDateOfDayNumber,
	ok,
	type Result,
} from "@research/domain";
import type { EventLogger, LogFields } from "@research/effects";
import { executeJob } from "../../../apps/runner/src/jobExecution.ts";
import type { MarketPacer } from "../../../apps/runner/src/marketPacing.ts";
import { createDeps, createFakeApi } from "../../../apps/runner/test/support.ts";
import {
	decodeUtf16Le,
	EDINET_CSV_HEADER,
	edinetContext,
	extractEdinetReport,
	forEachTsvRow,
	parseEdinetCsv,
	selectEdinetReportEntry,
} from "../../../packages/adapters/src/finance/edinetCsv.ts";
import {
	type EdinetAnnualRow,
	edinetDocumentListUrl,
	edinetDocumentUrl,
	edinetDownloadPlan,
	edinetErrorStatus,
	edinetFilingMetadata,
	edinetIdentity,
	parseEdinetDocumentList,
} from "../../../packages/adapters/src/finance/edinetDocuments.ts";
import {
	createEdinetSource,
	EDINET_DAY_CACHE_TTL_MS,
} from "../../../packages/adapters/src/finance/edinetSync.ts";
import {
	annualFactsInOrder,
	compareFacts,
	type EquitySyncData,
	type EquitySyncFailure,
	type EquitySyncSource,
	equitySyncCodeOfStatus,
	equitySyncFailureOfFetch,
	fitCompletionCaps,
	isRetryableEquitySyncFailure,
} from "../../../packages/adapters/src/finance/equitySync.ts";
import {
	createSecAnnualFilingsSource,
	equitySyncFailureOfSec,
	indexSecCompanyFacts,
	parseSecSubmissions,
	type SecFactsIndex,
	secFilingUrl,
	secNeedsCompanyFacts,
	secSyncResult,
	secValueDecimal,
} from "../../../packages/adapters/src/finance/secAnnualFilings.ts";
import { type SecErrorCode, secError } from "../../../packages/adapters/src/finance/secClient.ts";
import { SEC_TICKER_DIRECTORY_URL } from "../../../packages/adapters/src/finance/secFinancials.ts";
import { listZipEntries, readZipEntries } from "../../../packages/adapters/src/node/zipReader.ts";
import { buildTestZip } from "../../../packages/adapters/test/zipTestUtils.ts";
import { doubleBits, randomDouble, type VectorExporter, type VectorFile } from "../shared.ts";
import {
	EDINET_FIXTURE_DOCUMENTS,
	EQUITY_SYNC_FIXTURE_DIR,
	edinetFixtureDates,
	edinetReportCsv,
	equitySyncFixtureFiles,
} from "./equitySyncFixtures.ts";
import { base64, normalizeCall, plain, type RecordedCall, Rng } from "./support.ts";

const SEC_CONCEPTS = equityConceptsOfProvider("sec");
const EDINET_CONCEPTS = equityConceptsOfProvider("edinet");
const SEC_CIK = "0009999981";
const SUBMISSIONS = `sec-submissions-CIK${SEC_CIK}.synthetic.json`;
const COMPANY_FACTS = `sec-companyfacts-CIK${SEC_CIK}.synthetic.json`;

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
			secValueDecimal: values.map((json) => {
				const value: number = JSON.parse(json);
				return { json, bits: doubleBits(value), output: secValueDecimal(value) };
			}),
		},
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
		[],
	];
	const factsInputs: unknown[] = [
		{ fixture: COMPANY_FACTS },
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
	const addSync = (
		request: SecSyncRequest,
		facts: "fixture" | "empty" | null,
		caps: { maxFilings: number; maxFacts: number } | null,
	) => {
		const factsIndex = facts === "fixture" ? index.value : facts === "empty" ? new Map() : null;
		const input = {
			request,
			cik: SEC_CIK,
			submissions: parsedSubmissions.value,
			facts: factsIndex,
		};
		syncCases.push({
			request,
			cik: SEC_CIK,
			submissions: { fixture: SUBMISSIONS },
			facts: facts === "fixture" ? { fixture: COMPANY_FACTS, concepts: SEC_CONCEPTS } : facts,
			caps,
			needsCompanyFacts: secNeedsCompanyFacts(request, parsedSubmissions.value),
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
			secSyncResult: syncCases,
			secFilingUrl: urlCases.map(([cik, accession, primaryDocument]) => ({
				cik,
				accession,
				primaryDocument,
				output: secFilingUrl(cik, accession, primaryDocument),
			})),
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
	const allRows = dates.flatMap((date) => rowsOf(date).map((r) => ({ row: r, listedOn: date })));
	const metadataRows: EdinetAnnualRow[] = [
		...allRows.map((listed) => listed.row),
		...allRows.slice(0, 3).map((listed) => ({ ...listed.row, periodEnd: null })),
		...allRows
			.slice(0, 3)
			.map((listed) => ({ ...listed.row, periodStart: null, submitDateTime: "2025-01-02 00:05" })),
	];
	const ours = allRows.filter((listed) => listed.row.secCode === "99990");
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
		const found = rng.shuffle(allRows.filter(() => rng.chance(0.6)));
		const known = ours.filter(() => rng.chance(0.3)).map((listed) => listed.row.docId);
		const pending = [
			...ours.filter(() => rng.chance(0.2)).map((listed) => listed.row.docId),
			...(rng.chance(0.3) ? ["S100PEND"] : []),
		].map(pendingOf);
		const maxDownloads = rng.int(0, 9);
		return {
			pending,
			found,
			knownDocIds: known,
			maxDownloads,
			output: plain(edinetDownloadPlan({ pending, found, knownDocIds: known, maxDownloads })),
		};
	});
	const identityCases = [
		...dates.map((date) => ({
			matched: rowsOf(date).filter((r) => r.secCode === "99990"),
			claimEdinetCode: null,
		})),
		{ matched: ours.map((listed) => listed.row), claimEdinetCode: "E11111" },
		{ matched: [], claimEdinetCode: "E11111" },
		{ matched: [], claimEdinetCode: null },
		{
			matched: ours.slice(0, 1).map((listed) => ({ ...listed.row, filerName: "x".repeat(201) })),
			claimEdinetCode: null,
		},
	].map((input) => ({ ...input, output: edinetIdentity(input.matched, input.claimEdinetCode) }));

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
			edinetFilingMetadata: metadataRows.map((input) => ({
				row: input,
				output: edinetFilingMetadata(input),
			})),
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
			: createEdinetSource({ fetcher, binaryFetcher: fetcher, apiKey: scenario.credential, clock });
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
			knownDocIds: [],
			pendingFilings: [],
			scanDays: [],
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
	];
	const edinetPages: [string, Answer][] = [
		...edinetFixtureDates().map((date): [string, Answer] => [
			edinetDocumentListUrl(date, EDINET_KEY),
			{ fixture: listName(date) },
		]),
		...EDINET_FIXTURE_DOCUMENTS.map((document): [string, Answer] => [
			edinetDocumentUrl(document.docId, EDINET_KEY),
			{ fixture: `edinet-${document.docId}.synthetic.zip` },
		]),
	];
	const dates = [...edinetFixtureDates()];
	const withPage = (url: string, answer: Answer): [string, Answer][] => [
		[url, answer],
		...edinetPages.filter(([page]) => page !== url),
	];
	const s25 = edinetDocumentUrl("S100SY25", EDINET_KEY);
	const l25 = edinetDocumentListUrl("2025-06-20", EDINET_KEY);
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
	scenarios.push(
		{
			name: "edinet unconfigured",
			provider: "edinet",
			credential: null,
			answers: edinetPages,
			jobs: [job(edinetTarget({ scanDays: dates }))],
		},
		{
			name: "edinet full scan",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [job(edinetTarget({ scanDays: dates }))],
		},
		{
			name: "edinet pending first, a pending document gone",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(
					edinetTarget({
						scanDays: dates,
						pendingFilings: [pending25, { ...pending25, sourceDocumentId: "S100GONE" }],
						knownDocIds: ["S100SY20"],
					}),
				),
			],
		},
		{
			name: "edinet cache across jobs and expiry",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ scanDays: ["2025-06-20", "2025-07-01"] })),
				job(edinetTarget({ scanDays: ["2025-06-20", "2025-07-01"], secCode: "88880" }), [], 60_000),
				job(
					edinetTarget({ scanDays: ["2025-06-20"], knownDocIds: ["S100SY25"] }),
					[],
					EDINET_DAY_CACHE_TTL_MS,
				),
			],
		},
		{
			name: "edinet nothing found",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(
					edinetTarget({
						scanDays: ["2023-06-23", "2023-06-23"],
						secCode: "77770",
						edinetCode: "E77777",
					}),
				),
				job(edinetTarget({ scanDays: [], secCode: "77770" })),
			],
		},
		...[401, 403, 404, 429, 500].map(
			(status): SourceScenario => ({
				name: `edinet list ${status}`,
				provider: "edinet",
				credential: EDINET_KEY,
				answers: withPage(l25, http(status)),
				jobs: [job(edinetTarget({ scanDays: ["2024-06-21", "2025-06-20"] }))],
			}),
		),
		...[401, 404, 429, 503].map(
			(status): SourceScenario => ({
				name: `edinet document ${status}`,
				provider: "edinet",
				credential: EDINET_KEY,
				answers: withPage(s25, http(status)),
				jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
			}),
		),
		{
			name: "edinet list metadata 400",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(l25, { text: '{"metadata":{"status":"400","message":"Bad Request"}}' }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet list not JSON",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(l25, { text: "<html>" }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet document JSON 404",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(s25, { text: '{"metadata":{"status":"404","message":"Not Found"}}' }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet document gateway 401",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(s25, { text: '{"StatusCode":401,"message":"Access denied"}' }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet document JSON 200",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(s25, { text: '{"metadata":{"status":"200"}}' }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet document garbage",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(s25, { text: "maintenance" }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet document without report",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(s25, {
				base64: base64(buildTestZip([{ name: "XBRL_TO_CSV/jpaud.csv", text: "x", method: 0 }])),
			}),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet document timeout",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: withPage(s25, { error: { code: "TIMEOUT", detail: "x" } }),
			jobs: [job(edinetTarget({ scanDays: ["2025-06-20"] }))],
		},
		{
			name: "edinet gate stops",
			provider: "edinet",
			credential: EDINET_KEY,
			answers: edinetPages,
			jobs: [
				job(edinetTarget({ scanDays: dates }), [true, false]),
				job(edinetTarget({ scanDays: ["2025-06-20"] }), [false]),
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
					scannedDays: [],
					filings: filingsOf(e2eSec),
					more: false,
					requests: 2,
				},
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: identityOf(e2eEdinet),
					scannedDays: ["2025-06-20", "2025-06-23"],
					filings: filingsOf(e2eEdinet),
					more: true,
					requests: 9,
				},
			},
		},
		{
			provider: "edinet",
			answer: { ok: { identity: null, scannedDays: [], filings: [], more: false, requests: 0 } },
		},
		{
			provider: "sec",
			answer: {
				ok: {
					identity: { sourceCompanyId: "E99991", name: null, fiscalYearEnd: null },
					scannedDays: [],
					filings: [],
					more: false,
					requests: 1,
				},
			},
		},
		{
			provider: "sec",
			answer: {
				ok: { identity: null, scannedDays: ["2025-06-20"], filings: [], more: false, requests: 1 },
			},
		},
		{
			provider: "edinet",
			answer: {
				ok: {
					identity: null,
					scannedDays: [],
					filings: filingsOf(e2eSec).slice(0, 1),
					more: false,
					requests: 1,
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
		const pacer: MarketPacer = {
			async pace(provider, _signal, requests) {
				paced.push([provider, requests ?? null]);
				return true;
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
				: edinetTarget({ scanDays: ["2025-06-20"] })),
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
