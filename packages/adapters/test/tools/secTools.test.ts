import { createHash } from "node:crypto";
import type { ToolDefinition } from "@research/agent-core";
import {
	evidenceSchema,
	financialObservationSchema,
	investorFilingSchema,
	securitySchema,
} from "@research/contracts";
import { ok } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createFeedParser } from "../../src/feed/index.ts";
import { NO_SHARE_PRICE_SOURCE_REASON } from "../../src/finance/marketData.ts";
import { createSec13FSource } from "../../src/finance/sec13f.ts";
import { createSecClient } from "../../src/finance/secClient.ts";
import { createSecFinancialsSource } from "../../src/finance/secFinancials.ts";
import { webCryptoHasher } from "../../src/runtime/index.ts";
import { createResearchTools } from "../../src/tools/index.ts";
import { createSecTools } from "../../src/tools/secTools.ts";
import { MAX_MODEL_TEXT_BYTES } from "../../src/tools/shared.ts";
import {
	createScriptedFetcher,
	createToolContext,
	fixedClock,
	fixtureText,
	NOW_ISO,
	type ScriptedPage,
	SEC_USER_AGENT,
} from "./support.ts";

const DIRECTORY_URL = "https://www.sec.gov/files/company_tickers_exchange.json";
const FACTS_ALPHA_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999991.json";
const FACTS_BETA_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK0009999992.json";
const SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK0009999993.json";
const Q1_URL =
	"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000001/0009999993-26-000001.txt";
const Q2_URL =
	"https://www.sec.gov/Archives/edgar/data/9999993/000999999326000004/0009999993-26-000004.txt";

const SEC_PAGES: { readonly [url: string]: ScriptedPage } = {
	[DIRECTORY_URL]: { text: fixtureText("sec/company_tickers_exchange.synthetic.json") },
	[FACTS_ALPHA_URL]: { text: fixtureText("sec/companyfacts-CIK0009999991.synthetic.json") },
	[FACTS_BETA_URL]: { text: fixtureText("sec/companyfacts-CIK0009999992.synthetic.json") },
	[SUBMISSIONS_URL]: { text: fixtureText("sec/submissions-CIK0009999993.synthetic.json") },
	[Q1_URL]: { text: fixtureText("sec/13f-0009999993-26-000001.synthetic.txt") },
	[Q2_URL]: { text: fixtureText("sec/13f-0009999993-26-000004.synthetic.txt") },
};

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function setup(secUserAgent: string | null = SEC_USER_AGENT, pages = SEC_PAGES) {
	const fetcher = createScriptedFetcher(pages);
	const tools = createResearchTools({
		fetcher,
		feedParser: createFeedParser(),
		hasher: webCryptoHasher,
		clock: fixedClock(),
		secUserAgent,
		tavilyApiKey: null,
		pageArchive: null,
		sleep: async () => {},
	});
	const tool = (toolId: string): ToolDefinition => {
		const found = tools.find((candidate) => candidate.toolId === toolId);
		if (found === undefined) throw new Error(`no tool ${toolId}`);
		return found;
	};
	return { fetcher, tool, tools };
}

const FISCAL_2025 = {
	fiscalYear: 2025,
	fiscalPeriod: "FY",
	periodStart: "2024-07-01",
	periodEnd: "2025-06-30",
};

describe("finance.sec_company_financials", () => {
	it("produces a security, observations and evidence that satisfy the contracts", async () => {
		const { fetcher, tool } = setup();
		const context = createToolContext();
		const result = await tool("finance.sec_company_financials").execute(
			{ ticker: "xtesta" },
			context,
		);
		if (!result.ok)
			throw new Error(`unexpected failure ${result.error.code}: ${result.error.detail}`);
		const output = result.value;

		// Only SEC, only with the owner's User-Agent, only pinned to the two SEC hosts.
		expect(fetcher.urls()).toEqual([DIRECTORY_URL, FACTS_ALPHA_URL]);
		for (const call of fetcher.calls) {
			expect(call.options.userAgent).toBe(SEC_USER_AGENT);
			expect([...(call.options.allowedHosts ?? [])].sort()).toEqual([
				"data.sec.gov",
				"www.sec.gov",
			]);
			expect(call.options.signal).toBe(context.signal);
		}

		expect(output.securities).toHaveLength(1);
		const [security] = output.securities;
		expect(securitySchema.safeParse(security).success).toBe(true);
		expect(security).toEqual({
			securityId: "run_test_sec3",
			country: "US",
			ticker: "XTESTA",
			exchange: "NASDAQ",
			issuerName: "Synthetic Alpha Devices Inc.",
			issuerIdentifier: { scheme: "CIK", value: "0009999991" },
			listingCurrency: "USD",
			reportingCurrency: "USD",
			// Ticker and exchange were read from SEC's directory by this call.
			listingVerification: "source-verified",
			formerTickers: [],
		});

		expect(output.evidence).toHaveLength(2);
		for (const collected of output.evidence) {
			expect(evidenceSchema.safeParse(collected.evidence).success).toBe(true);
			expect(collected.evidence.checksum).toBe(sha256(collected.retrievedText));
			expect(collected.evidence.retrievedAt).toBe(NOW_ISO);
			// SEC data is US-government public information: passages may be stored.
			expect(collected.retainQuotes).toBe(true);
			expect(collected.evidence.excerpt).not.toBeNull();
			expect(output.modelText).toContain(`[${collected.evidence.evidenceId}]`);
		}
		const [directoryEvidence, factsEvidence] = output.evidence;
		expect(directoryEvidence?.evidence.sourceUrl).toBe(DIRECTORY_URL);
		expect(factsEvidence?.evidence).toMatchObject({
			evidenceId: "run_test_ev2",
			sourceUrl: FACTS_ALPHA_URL,
			sourceClass: "regulatory-filing",
			// Filing date and period end of the 10-K the figures come from.
			publishedAt: "2025-08-20T00:00:00.000Z",
			effectiveAt: "2025-06-30T00:00:00.000Z",
		});
		// The figures a claim would quote are present in the text kept for verification.
		for (const figure of ["2000000000", "250000000", "2.5", "12.50", "0009999991-25-000010"]) {
			expect(factsEvidence?.retrievedText).toContain(figure);
		}

		expect(output.financialObservations).toHaveLength(5);
		for (const observation of output.financialObservations) {
			expect(financialObservationSchema.safeParse(observation).success).toBe(true);
			expect(observation.securityId).toBe("run_test_sec3");
			expect(observation.actualOrEstimate).toBe("actual");
			expect(observation.marketDataAsOf).toBeNull();
			expect(output.modelText).toContain(observation.observationId);
		}
		const byMetric = new Map(output.financialObservations.map((o) => [o.metricCode, o]));
		expect(byMetric.get("revenue")).toMatchObject({
			value: 2_000_000_000,
			unavailableReason: null,
			unit: "currency",
			currency: "USD",
			accountingStandard: "US-GAAP",
			period: FISCAL_2025,
			sourceEvidenceId: "run_test_ev2",
		});
		expect(byMetric.get("net-income")).toMatchObject({
			value: 250_000_000,
			unit: "currency",
			currency: "USD",
			period: FISCAL_2025,
			sourceEvidenceId: "run_test_ev2",
		});
		expect(byMetric.get("eps-diluted")).toMatchObject({
			value: 2.5,
			unit: "currency-per-share",
			currency: "USD",
			period: FISCAL_2025,
		});
		// 250,000,000 / 2,000,000,000
		expect(byMetric.get("net-profit-margin")).toMatchObject({
			value: 0.125,
			unit: "ratio",
			currency: null,
			accountingStandard: "US-GAAP",
			period: FISCAL_2025,
			sourceEvidenceId: "run_test_ev2",
		});
		expect(byMetric.get("net-profit-margin")?.formula).toContain("net income / revenue");
		expect(byMetric.get("net-profit-margin")?.formula).toContain("us-gaap:Revenues");
		// No price source: PER is unavailable with the reason, never a number.
		expect(byMetric.get("trailing-per")).toMatchObject({
			value: null,
			unavailableReason: NO_SHARE_PRICE_SOURCE_REASON,
			unit: "ratio",
			sourceEvidenceId: null,
		});
		expect(byMetric.has("share-price")).toBe(false);
		expect(byMetric.has("forward-per")).toBe(false);
		expect(new TextEncoder().encode(output.modelText).byteLength).toBeLessThanOrEqual(
			MAX_MODEL_TEXT_BYTES,
		);
	});

	it("marks the margin unavailable when revenue and net income are for different years", async () => {
		const { tool } = setup();
		const result = await tool("finance.sec_company_financials").execute(
			{ ticker: "XTESTB" },
			createToolContext(),
		);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		for (const observation of result.value.financialObservations) {
			expect(financialObservationSchema.safeParse(observation).success).toBe(true);
		}
		const byMetric = new Map(result.value.financialObservations.map((o) => [o.metricCode, o]));
		expect(result.value.securities[0]?.exchange).toBe("NYSE");
		expect(byMetric.get("revenue")).toMatchObject({
			value: 500_000_000,
			period: { fiscalYear: 2025 },
		});
		expect(byMetric.get("net-income")).toMatchObject({
			value: 40_000_000,
			period: { fiscalYear: 2024 },
		});
		const margin = byMetric.get("net-profit-margin");
		expect(margin?.value).toBeNull();
		expect(margin?.period).toBeNull();
		expect(margin?.unavailableReason).toContain("not reported for the same fiscal period");
		expect(byMetric.get("eps-diluted")).toMatchObject({
			value: null,
			currency: null,
			period: null,
		});
		expect(byMetric.get("eps-diluted")?.unavailableReason).toContain("diluted EPS");
		// Neither mixed-period ratio (40/500, 40/450) appears anywhere.
		expect(JSON.stringify(result.value)).not.toMatch(/0\.08\d*/);
	});

	it("fails closed with NOT_CONFIGURED and no request when no SEC User-Agent is set", async () => {
		for (const userAgent of [null, "", "anonymous-bot/1.0"]) {
			const { fetcher, tool } = setup(userAgent);
			const context = createToolContext();
			const result = await tool("finance.sec_company_financials").execute(
				{ ticker: "XTESTA" },
				context,
			);
			expect(result).toMatchObject({
				ok: false,
				error: { code: "NOT_CONFIGURED", retryable: false },
			});
			expect(fetcher.calls).toHaveLength(0);
			expect(context.allocatedIds).toEqual([]);
		}
	});

	it.each([
		["XTESTC", "OTC"],
		["XTESTD", "no exchange"],
		["XTESTE", "CBOE"],
	])("creates no records for %s, whose exchange SEC states as %s", async (ticker, stated) => {
		const pages = {
			...SEC_PAGES,
			"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999994.json": SEC_PAGES[
				FACTS_ALPHA_URL
			] ?? { text: "{}" },
			"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999995.json": SEC_PAGES[
				FACTS_ALPHA_URL
			] ?? { text: "{}" },
			"https://data.sec.gov/api/xbrl/companyfacts/CIK0009999996.json": SEC_PAGES[
				FACTS_ALPHA_URL
			] ?? { text: "{}" },
		};
		const { tool } = setup(SEC_USER_AGENT, pages);
		const context = createToolContext();
		const result = await tool("finance.sec_company_financials").execute({ ticker }, context);
		expect(result).toMatchObject({ ok: false, error: { code: "SECURITY_NOT_IDENTIFIABLE" } });
		if (!result.ok) expect(result.error.detail).toContain(stated);
		expect(context.allocatedIds).toEqual([]);
	});

	it("reports unknown tickers and SEC refusals as typed failures", async () => {
		const { tool } = setup();
		expect(
			await tool("finance.sec_company_financials").execute(
				{ ticker: "NOSUCH" },
				createToolContext(),
			),
		).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

		const blocked = setup(SEC_USER_AGENT, {
			[DIRECTORY_URL]: { error: { code: "HTTP_ERROR", detail: "HTTP 403", status: 403 } },
		});
		expect(
			await blocked
				.tool("finance.sec_company_financials")
				.execute({ ticker: "XTESTA" }, createToolContext()),
		).toMatchObject({ ok: false, error: { code: "ACCESS_DENIED", retryable: false } });
	});

	it("rejects ticker arguments that are not tickers", async () => {
		const { fetcher, tool } = setup();
		for (const args of [
			{ ticker: "" },
			{ ticker: "../../etc/passwd" },
			{ ticker: "A B" },
			{ ticker: 5 },
			{},
		]) {
			expect(
				await tool("finance.sec_company_financials").execute(args, createToolContext()),
			).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
		}
		expect(fetcher.calls).toHaveLength(0);
	});

	it("still reports PER unavailable when a price source is configured (computation not implemented)", async () => {
		const fetcher = createScriptedFetcher(SEC_PAGES);
		const client = createSecClient({ fetcher, clock: fixedClock(), userAgent: SEC_USER_AGENT });
		const [financialsTool] = createSecTools({
			financials: createSecFinancialsSource({ client, nowMs: () => 0 }),
			filings: createSec13FSource({ client }),
			sharePrice: {
				latestQuote: async (query) =>
					ok({
						quote: {
							securityId: query.securityId,
							price: { amount: 100, currency: "USD" },
							priceAsOf: NOW_ISO,
							adjustmentBasis: "unadjusted",
						},
						provenance: {
							sourceUrl: "https://prices.synthetic-wire.org/xtesta",
							title: "Synthetic quote",
							publisher: "Synthetic Prices",
							publishedAt: null,
							retrievedText: "XTESTA 100.00 USD",
						},
					}),
			},
			hasher: webCryptoHasher,
		});
		const result = await financialsTool?.execute({ ticker: "XTESTA" }, createToolContext());
		if (result === undefined || !result.ok) throw new Error("unexpected failure");
		const per = result.value.financialObservations.find((o) => o.metricCode === "trailing-per");
		expect(per?.value).toBeNull();
		expect(per?.unavailableReason).toContain("not implemented");
		// 100 / 2.5 = 40 would be the ratio; it must not be reported.
		expect(result.value.financialObservations.some((o) => o.value === 40)).toBe(false);
	});
});

describe("filings.sec_13f_holdings", () => {
	it("produces filing records and evidence that satisfy the contracts", async () => {
		const { fetcher, tool } = setup();
		const context = createToolContext();
		const result = await tool("filings.sec_13f_holdings").execute(
			{ managerCik: "9999993" },
			context,
		);
		if (!result.ok)
			throw new Error(`unexpected failure ${result.error.code}: ${result.error.detail}`);
		const output = result.value;

		expect(fetcher.urls()).toEqual([SUBMISSIONS_URL, Q2_URL, Q1_URL]);
		for (const call of fetcher.calls) {
			expect(call.options.userAgent).toBe(SEC_USER_AGENT);
			expect([...(call.options.allowedHosts ?? [])].sort()).toEqual([
				"data.sec.gov",
				"www.sec.gov",
			]);
		}

		expect(output.investorFilings).toHaveLength(2);
		expect(output.evidence).toHaveLength(2);
		for (const filing of output.investorFilings) {
			expect(investorFilingSchema.safeParse(filing).success).toBe(true);
			expect(filing.investorName).toBe("Synthetic Capital Management LP");
			expect(filing.reportingEntityIdentifier).toEqual({ scheme: "CIK", value: "0009999993" });
			expect(filing.form).toBe("13F-HR");
		}
		for (const collected of output.evidence) {
			expect(evidenceSchema.safeParse(collected.evidence).success).toBe(true);
			expect(collected.evidence.checksum).toBe(sha256(collected.retrievedText));
			expect(collected.evidence.sourceClass).toBe("regulatory-filing");
			expect(collected.retainQuotes).toBe(true);
			expect(output.modelText).toContain(`[${collected.evidence.evidenceId}]`);
		}
		const [current, previous] = output.investorFilings;
		expect(current).toMatchObject({
			reportPeriodEnd: "2026-06-30",
			filedAt: "2026-08-14",
			filingUrl: Q2_URL,
			sourceEvidenceId: output.evidence[0]?.evidence.evidenceId,
		});
		expect(output.evidence[0]?.evidence).toMatchObject({
			sourceUrl: Q2_URL,
			publishedAt: "2026-08-14T00:00:00.000Z",
			effectiveAt: "2026-06-30T00:00:00.000Z",
		});
		expect(previous).toMatchObject({
			reportPeriodEnd: "2026-03-31",
			filedAt: "2026-05-15",
			filingUrl: Q1_URL,
			sourceEvidenceId: output.evidence[1]?.evidence.evidenceId,
		});

		// Hand-written from the two fixture quarters (see the fixture files).
		expect(current?.holdings).toEqual([
			{
				issuerName: "SYNTHETIC BETA INC",
				cusip: "222222BB2",
				securityId: null,
				reportedShares: 2500,
				reportedValueUsd: 55000,
				changeFromPriorFiling: "increase-in-reported-position",
			},
			{
				issuerName: "SYNTHETIC ALPHA CORP",
				cusip: "111111AA1",
				securityId: null,
				reportedShares: 1000,
				reportedValueUsd: 52000,
				changeFromPriorFiling: "unchanged-reported-position",
			},
			{
				issuerName: "SYNTHETIC ZETA SA",
				cusip: "666666FF6",
				securityId: null,
				reportedShares: 900,
				reportedValueUsd: 9000,
				changeFromPriorFiling: "newly-reported-holding",
			},
			{
				issuerName: "SYNTHETIC GAMMA LTD",
				cusip: "333333CC3",
				securityId: null,
				reportedShares: 400,
				reportedValueUsd: 4400,
				changeFromPriorFiling: "decrease-in-reported-position",
			},
			{
				issuerName: "SYNTHETIC EPSILON PLC",
				cusip: "555555EE5",
				securityId: null,
				reportedShares: 50,
				reportedValueUsd: 500,
				changeFromPriorFiling: "newly-reported-holding",
			},
			{
				issuerName: "SYNTHETIC DELTA CO",
				cusip: "444444DD4",
				securityId: null,
				reportedShares: 0,
				reportedValueUsd: null,
				changeFromPriorFiling: "no-longer-reported",
			},
		]);
		// The earlier filing was not compared with anything older.
		expect(
			previous?.holdings.map((holding) => [
				holding.cusip,
				holding.reportedShares,
				holding.changeFromPriorFiling,
			]),
		).toEqual([
			["111111AA1", 1000, null],
			["222222BB2", 2000, null],
			["333333CC3", 700, null],
			["444444DD4", 300, null],
		]);
		expect(output.securities).toEqual([]);
		expect(output.financialObservations).toEqual([]);
	});

	it("never words a change as a trade", async () => {
		const { tool } = setup();
		const result = await tool("filings.sec_13f_holdings").execute(
			{ managerCik: "CIK0009999993" },
			createToolContext(),
		);
		if (!result.ok) throw new Error("unexpected failure");
		const text = result.value.modelText;
		expect(text).toContain("increase in reported position");
		expect(text).toContain("newly reported holding");
		expect(text).toContain("position no longer reported");
		expect(text).toContain("quarter-end holdings, not a dated transaction");
		expect(text).toContain("as of 2026-06-30");
		const withoutTheCaveats = text
			.replace(/no trade dates and no prices paid/g, "")
			.replace(/not a dated transaction/g, "");
		expect(withoutTheCaveats).not.toMatch(
			/\b(bought|buys?|buying|purchas\w*|sold|sells?|selling|acquir\w*|dump\w*|trades?|traded)\b/i,
		);
		for (const collected of result.value.evidence) {
			expect(collected.retrievedText).not.toMatch(/\b(bought|purchas\w*|sold)\b/i);
		}
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_MODEL_TEXT_BYTES);
	});

	it("fails closed with NOT_CONFIGURED and no request when no SEC User-Agent is set", async () => {
		const { fetcher, tool } = setup(null);
		const context = createToolContext();
		const result = await tool("filings.sec_13f_holdings").execute(
			{ managerCik: "9999993" },
			context,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "NOT_CONFIGURED" } });
		expect(fetcher.calls).toHaveLength(0);
		expect(context.allocatedIds).toEqual([]);
	});

	it("reports a manager without 13F-HR filings and rejects non-CIK arguments", async () => {
		const { fetcher, tool } = setup(SEC_USER_AGENT, {});
		expect(
			await tool("filings.sec_13f_holdings").execute({ managerCik: "1234" }, createToolContext()),
		).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
		const before = fetcher.calls.length;
		for (const args of [
			{ managerCik: "Berkshire" },
			{ managerCik: "12345678901" },
			{ managerCik: "1/../2" },
			{},
		]) {
			expect(
				await tool("filings.sec_13f_holdings").execute(args, createToolContext()),
			).toMatchObject({
				ok: false,
				error: { code: "INVALID_ARGS" },
			});
		}
		expect(fetcher.calls).toHaveLength(before);
	});

	it("publishes no change and no zero-share row when a filing has an unreadable row (finding 16)", async () => {
		const row = (name: string, cusip: string, shares: string) =>
			`<infoTable><nameOfIssuer>${name}</nameOfIssuer><cusip>${cusip}</cusip><value>1000</value><shrsOrPrnAmt><sshPrnamt>${shares}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`;
		const wrap = (rows: string) =>
			`<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n<XML>\n<informationTable>${rows}</informationTable>\n</XML>\n</TEXT>\n</DOCUMENT>`;
		const { tool } = setup(SEC_USER_AGENT, {
			[SUBMISSIONS_URL]: SEC_PAGES[SUBMISSIONS_URL] ?? { text: "{}" },
			// ALPHA is still listed, but its share count is unreadable this quarter.
			[Q2_URL]: {
				text: wrap(
					`${row("SYNTHETIC ALPHA CORP", "111111AA1", "N/A")}${row("SYNTHETIC BETA INC", "222222BB2", "12")}`,
				),
			},
			[Q1_URL]: {
				text: wrap(
					`${row("SYNTHETIC ALPHA CORP", "111111AA1", "300")}${row("SYNTHETIC BETA INC", "222222BB2", "10")}`,
				),
			},
		});
		const result = await tool("filings.sec_13f_holdings").execute(
			{ managerCik: "9999993" },
			createToolContext(),
		);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		const [current, previous] = result.value.investorFilings;
		expect(investorFilingSchema.safeParse(current).success).toBe(true);
		// Only the position that was read in full, and without a change classification.
		expect(current?.holdings).toEqual([
			{
				issuerName: "SYNTHETIC BETA INC",
				cusip: "222222BB2",
				securityId: null,
				reportedShares: 12,
				reportedValueUsd: 1000,
				changeFromPriorFiling: null,
			},
		]);
		expect(current?.holdings.some((holding) => holding.reportedShares === 0)).toBe(false);
		expect(JSON.stringify(result.value.investorFilings)).not.toContain("no-longer-reported");
		expect(previous?.holdings).toHaveLength(2);

		const text = result.value.modelText;
		expect(text).toContain("could not be read");
		expect(text).toContain("111111AA1");
		expect(text).not.toContain("position no longer reported");
		expect(text).not.toContain("increase in reported position");
		// The stored evidence for the incomplete filing says so too.
		expect(result.value.evidence[0]?.retrievedText).toContain("1 rows unreadable");
		expect(result.value.evidence[0]?.retrievedText).toContain("111111AA1");
	});

	it("keeps a filing within the contract's holdings limit, with room for dropped positions", async () => {
		const cusip = (index: number) => `S${String(index).padStart(8, "0")}`;
		const table = (count: number, offset: number) =>
			`<informationTable>${Array.from({ length: count }, (_, index) => `<infoTable><nameOfIssuer>SYNTHETIC ISSUER ${index + offset}</nameOfIssuer><cusip>${cusip(index + offset)}</cusip><value>${(1000 - index) * 100}</value><shrsOrPrnAmt><sshPrnamt>${index + 1}</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt></infoTable>`).join("")}</informationTable>`;
		const wrap = (xml: string) =>
			`<SEC-DOCUMENT>\n<DOCUMENT>\n<TYPE>INFORMATION TABLE\n<TEXT>\n<XML>\n${xml}\n</XML>\n</TEXT>\n</DOCUMENT>`;
		const { tool } = setup(SEC_USER_AGENT, {
			[SUBMISSIONS_URL]: SEC_PAGES[SUBMISSIONS_URL] ?? { text: "{}" },
			// Current quarter: issuers 100..249. Previous quarter: issuers 0..149 (0..99 dropped out).
			[Q2_URL]: { text: wrap(table(150, 100)) },
			[Q1_URL]: { text: wrap(table(150, 0)) },
		});
		const result = await tool("filings.sec_13f_holdings").execute(
			{ managerCik: "9999993" },
			createToolContext(),
		);
		if (!result.ok) throw new Error(`unexpected failure ${result.error.code}`);
		const [current, previous] = result.value.investorFilings;
		expect(investorFilingSchema.safeParse(current).success).toBe(true);
		expect(investorFilingSchema.safeParse(previous).success).toBe(true);
		expect(current?.holdings).toHaveLength(60);
		expect(previous?.holdings).toHaveLength(60);
		const dropped = current?.holdings.filter(
			(holding) => holding.changeFromPriorFiling === "no-longer-reported",
		);
		expect(dropped).toHaveLength(10);
		expect(
			dropped?.every(
				(holding) => holding.reportedShares === 0 && holding.reportedValueUsd === null,
			),
		).toBe(true);
		for (const collected of result.value.evidence) {
			expect(collected.retrievedText.length).toBeLessThanOrEqual(20_000);
			expect(collected.evidence.excerpt?.length).toBeLessThanOrEqual(500);
		}
		expect(new TextEncoder().encode(result.value.modelText).byteLength).toBeLessThanOrEqual(
			MAX_MODEL_TEXT_BYTES,
		);
	});
});
