/**
 * Japanese statements and company profiles from J-Quants (ADR-0059): the
 * pure summaries → filings and master → profiles rules over J-Quants' live
 * answers (captured 2026-11-02, `fixtures/jquants-*.json`), and the sources'
 * paging, pacing and status mapping over a scripted fetcher.
 */
import { readFileSync } from "node:fs";
import { completeJobRequestSchema } from "@research/contracts";
import { EMPTY_USAGE } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	canonicalJquantsDecimal,
	createJquantsFinancialsSource,
	createJquantsProfileSource,
	jquantsAccountingStandard,
	jquantsDisclosureInstant,
	jquantsMasterToProfiles,
	jquantsSummariesToSync,
} from "../../src/finance/jquantsFinancials.ts";
import { createScriptedFetcher, type ScriptedPage } from "../tools/support.ts";
import { jquantsTarget, queryFor } from "./equitySyncSupport.ts";
import { expectErr, expectOk } from "./support.ts";

const KEY = "jquants-test-key-01";
const SUMMARY_URL = "https://api.jquants.com/v2/fins/summary?code=72030";
const MASTER_URL = "https://api.jquants.com/v2/equities/master";

function fixtureRecords(name: string): unknown[] {
	const page: unknown = JSON.parse(
		readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
	);
	if (typeof page !== "object" || page === null || !("data" in page) || !Array.isArray(page.data)) {
		throw new Error(`${name} is not a J-Quants page`);
	}
	return page.data;
}

const summaries = (code: string) => fixtureRecords(`jquants-fins-summary-code-${code}.json`);

function http(status: number): ScriptedPage {
	return { error: { code: "HTTP_ERROR", detail: `HTTP ${status}`, status } };
}

describe("J-Quants amounts, instants and standards", () => {
	it("canonicalises plain decimals and drops anything else", () => {
		const cases: [string, string | null][] = [
			["697203000000", "697203000000"],
			["-142640000000", "-142640000000"],
			["+0048036704000000", "48036704000000"],
			["4795586000000.000", "4795586000000"],
			["-0003.10", "-3.1"],
			["-0", "0"],
			["00", "0"],
			["", null],
			["4.765086E12", null],
			[".5", null],
			["5.", null],
			[" 1", null],
			["1,000", null],
		];
		for (const [text, canonical] of cases)
			expect(canonicalJquantsDecimal(text), text).toBe(canonical);
	});

	it("reads the disclosure instant in Tokyo time, null when the time is not HH:MM:SS", () => {
		expect(jquantsDisclosureInstant("2025-02-13", "15:30:00")).toBe("2025-02-13T06:30:00.000Z");
		expect(jquantsDisclosureInstant("2025-01-01", "08:00:00")).toBe("2024-12-31T23:00:00.000Z");
		expect(jquantsDisclosureInstant("2025-02-13", "9:00")).toBeNull();
		expect(jquantsDisclosureInstant("2025-02-13", "24:00:00")).toBeNull();
		expect(jquantsDisclosureInstant("2025-02-30", "15:30:00")).toBeNull();
	});

	it("names the standard by the DocType's suffix", () => {
		expect(jquantsAccountingStandard("FYFinancialStatements_Consolidated_JP")).toBe("JGAAP");
		expect(jquantsAccountingStandard("FYFinancialStatements_Consolidated_IFRS")).toBe("IFRS");
		expect(jquantsAccountingStandard("FYFinancialStatements_Consolidated_US")).toBe("US-GAAP");
		expect(jquantsAccountingStandard("FYFinancialStatements_NonConsolidated_JP")).toBe("JGAAP");
		expect(jquantsAccountingStandard("FYFinancialStatements_Consolidated_JMIS")).toBeNull();
	});
});

describe("jquantsSummariesToSync (ADR-0059 §2)", () => {
	it("makes one filing per full-year summary, newest first, valid for the completion contract", () => {
		const data = jquantsSummariesToSync("72030", [], summaries("7203"));
		expect(data.identity).toEqual({ sourceCompanyId: "72030", name: null, fiscalYearEnd: "03-31" });
		expect(data.filings.map((filing) => [filing.form, filing.periodEnd])).toEqual([
			["earnings-report", "2026-03-31"],
			["earnings-report", "2025-03-31"],
		]);
		const completion = {
			outcome: "financial-synced",
			leaseGeneration: 1,
			usage: EMPTY_USAGE,
			companyId: "eqc_jp",
			provider: "jquants",
			fetchedAt: "2026-11-02T00:00:00.000Z",
			identity: data.identity,
			filings: data.filings,
			more: data.more,
			description: null,
		};
		expect(completeJobRequestSchema.safeParse(completion).success).toBe(true);
	});

	it("reads a correction as an amendment of the summary before it, stored or not", () => {
		const records = summaries("2914");
		const all = jquantsSummariesToSync("29140", [], records);
		const correction = all.filings.find((filing) => filing.sourceDocumentId === "20250310590632");
		expect(correction).toMatchObject({
			form: "amended-earnings-report",
			amendsSourceDocumentId: "20250212569311",
		});
		const later = jquantsSummariesToSync("29140", ["20250212569311"], records);
		expect(later.filings.map((filing) => filing.sourceDocumentId)).toEqual([
			"20260212555840",
			"20250310590632",
		]);
		expect(later.filings[1]?.amendsSourceDocumentId).toBe("20250212569311");
	});

	it("keeps consolidated and non-consolidated items apart under one concept", () => {
		const [newest] = jquantsSummariesToSync("72030", [], summaries("7203")).filings;
		const sales = newest?.facts.filter((fact) => fact.concept === "jquants:Sales");
		expect(sales?.map((fact) => fact.scope).sort()).toEqual(["consolidated", "separate"]);
		const nonConsolidated = jquantsSummariesToSync(
			"96250",
			[],
			fixtureRecords("jquants-fins-summary-date-2026-05-14-code-96250.json"),
		);
		const facts = nonConsolidated.filings[0]?.facts ?? [];
		expect(facts.length).toBeGreaterThan(0);
		expect(facts.every((fact) => fact.scope === "separate" && fact.unit === "JPY")).toBe(true);
	});

	it("states no ordinary profit for an IFRS or US-GAAP filer and no operating profit for a bank", () => {
		const concepts = (code: string) =>
			new Set(
				jquantsSummariesToSync(`${code}0`, [], summaries(code)).filings.flatMap((filing) =>
					filing.facts.filter((fact) => fact.scope === "consolidated").map((fact) => fact.concept),
				),
			);
		expect(concepts("8604").has("jquants:OdP")).toBe(false);
		expect(concepts("8604").has("jquants:Sales")).toBe(true);
		expect(concepts("8306").has("jquants:OP")).toBe(false);
		expect(concepts("8306").has("jquants:OdP")).toBe(true);
	});

	it("has no identity and no filings without a full-year summary", () => {
		const revisionsOnly = summaries("4385").filter(
			(record) =>
				typeof record === "object" &&
				record !== null &&
				"DocType" in record &&
				!String(record.DocType).startsWith("FYFinancialStatements_"),
		);
		expect(jquantsSummariesToSync("43850", [], revisionsOnly)).toEqual({
			identity: null,
			filings: [],
			more: false,
		});
		expect(jquantsSummariesToSync("99990", [], [])).toEqual({
			identity: null,
			filings: [],
			more: false,
		});
	});
});

describe("jquantsMasterToProfiles (ADR-0059 §3)", () => {
	it("keeps common stocks only, under their directory symbol, with '-' and '' as null", () => {
		const records = fixtureRecords("jquants-equities-master-trimmed.json");
		const profiles = jquantsMasterToProfiles(records);
		// ITO EN's common stock (25930) is kept, its preferred line (25935) is not.
		expect(profiles.filter((profile) => profile.symbol === "2593")).toHaveLength(1);
		expect(profiles.find((profile) => profile.symbol === "2593")?.nameEn).not.toContain(
			"preferred",
		);
		expect(profiles.map((profile) => profile.symbol)).toContain("130A");
		expect(profiles).toHaveLength(records.length - 1);
		expect(profiles.find((profile) => profile.symbol === "130A")?.scaleCategory).toBeNull();
		const [toyota] = jquantsMasterToProfiles(
			records.flatMap((record) =>
				typeof record === "object" && record !== null && "Code" in record && record.Code === "72030"
					? [{ ...record, CoNameEn: "" }]
					: [],
			),
		);
		expect(toyota?.nameEn).toBeNull();
	});
});

describe("the J-Quants statements source", () => {
	it("fails unconfigured without a request", async () => {
		const fetcher = createScriptedFetcher({});
		const source = createJquantsFinancialsSource({ apiKey: null, fetcher });
		const { query, grants } = queryFor(jquantsTarget());
		expect(expectErr(await source.sync(query))).toEqual({
			code: "FINANCIAL_SOURCE_NOT_CONFIGURED",
			upstreamStatus: null,
			requests: 0,
		});
		expect(fetcher.calls).toEqual([]);
		expect(grants()).toBe(0);
	});

	it("follows pagination_key, one grant per page, with the key in the header only", async () => {
		const records = summaries("7203");
		const fetcher = createScriptedFetcher({
			[SUMMARY_URL]: { text: JSON.stringify({ data: records.slice(0, 4), pagination_key: "p2" }) },
			[`${SUMMARY_URL}&pagination_key=p2`]: { text: JSON.stringify({ data: records.slice(4) }) },
		});
		const source = createJquantsFinancialsSource({ apiKey: KEY, fetcher });
		const { query, grants } = queryFor(jquantsTarget());
		const data = expectOk(await source.sync(query));
		expect(data.filings).toEqual(jquantsSummariesToSync("72030", [], records).filings);
		expect(data).toMatchObject({ requests: 2, description: null, descriptionUnread: null });
		expect(grants()).toBe(2);
		for (const call of fetcher.calls) {
			expect(call.url).not.toContain(KEY);
			expect(call.options.xApiKey).toBe(KEY);
			expect([...(call.options.allowedHosts ?? [])]).toEqual(["api.jquants.com"]);
		}
	});

	it("maps J-Quants' statuses, keeping each unchanged", async () => {
		const cases: [number, string][] = [
			[400, "FINANCIAL_PARSE_FAILED"],
			[401, "FINANCIAL_ACCESS_DENIED"],
			[403, "FINANCIAL_ACCESS_DENIED"],
			[404, "FINANCIAL_SOURCE_FAILED"],
			[429, "FINANCIAL_RATE_LIMITED"],
			[503, "FINANCIAL_SOURCE_FAILED"],
		];
		for (const [status, code] of cases) {
			const fetcher = createScriptedFetcher({ [SUMMARY_URL]: http(status) });
			const source = createJquantsFinancialsSource({ apiKey: KEY, fetcher });
			expect(expectErr(await source.sync(queryFor(jquantsTarget()).query))).toEqual({
				code,
				upstreamStatus: status,
				requests: 1,
			});
		}
	});

	it("fails an answer of the wrong shape or past 20 pages as a parse failure", async () => {
		const notAPage = createScriptedFetcher({ [SUMMARY_URL]: { text: '{"message":"x"}' } });
		expect(
			expectErr(
				await createJquantsFinancialsSource({ apiKey: KEY, fetcher: notAPage }).sync(
					queryFor(jquantsTarget()).query,
				),
			),
		).toEqual({ code: "FINANCIAL_PARSE_FAILED", upstreamStatus: null, requests: 1 });
		const pages: Record<string, ScriptedPage> = {};
		for (let page = 0; page < 21; page += 1) {
			const url = page === 0 ? SUMMARY_URL : `${SUMMARY_URL}&pagination_key=p${page}`;
			pages[url] = { text: JSON.stringify({ data: [], pagination_key: `p${page + 1}` }) };
		}
		const endless = createScriptedFetcher(pages);
		expect(
			expectErr(
				await createJquantsFinancialsSource({ apiKey: KEY, fetcher: endless }).sync(
					queryFor(jquantsTarget()).query,
				),
			),
		).toEqual({ code: "FINANCIAL_PARSE_FAILED", upstreamStatus: null, requests: 20 });
	});

	it("stops when the gate refuses, sending nothing more", async () => {
		const fetcher = createScriptedFetcher({ [SUMMARY_URL]: { text: '{"data":[]}' } });
		const source = createJquantsFinancialsSource({ apiKey: KEY, fetcher });
		expect(expectErr(await source.sync(queryFor(jquantsTarget(), [false]).query))).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: null,
			requests: 0,
		});
		expect(fetcher.calls).toEqual([]);
	});
});

describe("the J-Quants profile source", () => {
	const query = (grant = true) => ({
		signal: new AbortController().signal,
		beforeRequest: () => Promise.resolve(grant),
	});

	it("reads every page of the master", async () => {
		const records = fixtureRecords("jquants-equities-master-trimmed.json");
		const fetcher = createScriptedFetcher({
			[MASTER_URL]: { text: JSON.stringify({ data: records.slice(0, 5), pagination_key: "m2" }) },
			[`${MASTER_URL}?pagination_key=m2`]: { text: JSON.stringify({ data: records.slice(5) }) },
		});
		const fetched = expectOk(
			await createJquantsProfileSource({ apiKey: KEY, fetcher }).fetchProfiles(query()),
		);
		expect(fetched).toEqual({ profiles: jquantsMasterToProfiles(records), requests: 2 });
	});

	it("names each failure by a code and keeps J-Quants' status", async () => {
		const cases: [ScriptedPage, string, number | null][] = [
			[http(401), "ACCESS_DENIED", 401],
			[http(403), "ACCESS_DENIED", 403],
			[http(429), "RATE_LIMITED", 429],
			[http(500), "SOURCE_FAILED", 500],
			[{ text: "[]" }, "PARSE_FAILED", null],
			[{ error: { code: "TIMEOUT", detail: "x" } }, "SOURCE_FAILED", null],
		];
		for (const [page, code, upstreamStatus] of cases) {
			const fetcher = createScriptedFetcher({ [MASTER_URL]: page });
			expect(
				expectErr(
					await createJquantsProfileSource({ apiKey: KEY, fetcher }).fetchProfiles(query()),
				),
			).toEqual({ code, upstreamStatus, requests: 1 });
		}
		const stopped = createScriptedFetcher({});
		expect(
			expectErr(
				await createJquantsProfileSource({ apiKey: KEY, fetcher: stopped }).fetchProfiles(
					query(false),
				),
			),
		).toEqual({ code: "SOURCE_FAILED", upstreamStatus: null, requests: 0 });
	});
});
