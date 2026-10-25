/**
 * The SEC and position research tools (crate `research-tools`:
 * `sec`, `positions`): the real `createSecTools` / `createPositionTools` run
 * over scripted sources and a fixed context (run id, clock, a shared id
 * counter). A case records the raw arguments, what the argument schema made
 * of them, and the whole tool result: model text byte for byte, evidence with
 * its retrieved text and checksum, securities, observations, filings.
 *
 * Inputs reach the Rust side as data: the company-facts document and issuer
 * (the Rust tool re-derives the selection with the already verified
 * `select_annual_financials`), the 13F report, the position-source answers.
 */
import { createHash } from "node:crypto";
import type { CollectedEvidence, ToolDefinition, ToolOutput } from "@research/agent-core";
import type { Hasher } from "@research/application";
import { err, ok } from "@research/domain";
import {
	type JpMarginBalanceReport,
	type MarketDataUnavailable,
	type SharePriceReport,
	type UsShortInterestReport,
	unconfiguredSharePriceSource,
} from "../../../packages/adapters/src/finance/marketData.ts";
import {
	compareReportedPositions,
	type FilingRef,
	type Reported13FHolding,
	type Sec13FFiling,
	type Sec13FReport,
} from "../../../packages/adapters/src/finance/sec13f.ts";
import type { SecError } from "../../../packages/adapters/src/finance/secClient.ts";
import {
	type SecCompanyFinancials,
	selectAnnualFinancials,
} from "../../../packages/adapters/src/finance/secFinancials.ts";
import { createPositionTools } from "../../../packages/adapters/src/tools/positionTools.ts";
import { createSecTools } from "../../../packages/adapters/src/tools/secTools.ts";
import { createToolContext } from "../../../packages/adapters/test/tools/support.ts";
import { alignedFacts, FACTS_ONE, FACTS_TWO, randomFacts } from "./sec.ts";
import { plain, Rng } from "./support.ts";

const sha256Hasher: Hasher = {
	async sha256Hex(text) {
		return createHash("sha256").update(text, "utf8").digest("hex");
	},
};

/* ---------- running a tool ---------- */

interface ToolCase {
	readonly toolId: string;
	readonly args: unknown;
	readonly setup: unknown;
	readonly output: unknown;
}

function summarizeOutput(output: ToolOutput): unknown {
	return {
		modelText: output.modelText,
		evidence: output.evidence.map((item: CollectedEvidence) => ({
			evidence: item.evidence,
			retrievedText: item.retrievedText,
			retainQuotes: item.retainQuotes,
		})),
		securities: output.securities,
		financialObservations: output.financialObservations,
		positionObservations: output.positionObservations,
		investorFilings: output.investorFilings,
		articles: output.articles,
	};
}

async function runTool(
	tools: readonly ToolDefinition[],
	toolId: string,
	args: unknown,
	setup: unknown,
): Promise<ToolCase> {
	const tool = tools.find((candidate) => candidate.toolId === toolId);
	if (tool === undefined) throw new Error(`no tool ${toolId}`);
	const parsed = tool.argsSchema.safeParse(args);
	const context = createToolContext();
	const result = await tool.execute(args, context);
	const output = result.ok ? { ok: summarizeOutput(result.value) } : { err: result.error };
	return {
		toolId,
		args: plain(args),
		setup,
		output: plain({ parsedArgs: parsed.success ? parsed.data : null, result: output }),
	};
}

/* ---------- company financials ---------- */

interface FinancialsSetup {
	readonly issuer: {
		readonly cik: string;
		readonly name: string;
		readonly ticker: string;
		readonly secExchange: string | null;
	};
	readonly facts: unknown;
	readonly directoryUrl: string;
	readonly factsUrl: string;
	/** `error` scripts the source's failure instead of a result. */
	readonly sourceError: SecError | null;
	readonly price: "unconfigured" | "failed" | "available";
	readonly priceReason: string;
}

async function runFinancials(args: unknown, setup: FinancialsSetup): Promise<ToolCase> {
	const selected = selectAnnualFinancials(setup.facts);
	const price = setup.price;
	const tools = createSecTools({
		financials: {
			async latestAnnualFinancials() {
				if (setup.sourceError !== null) return err(setup.sourceError);
				if (!selected.ok) return err(selected.error);
				const financials: SecCompanyFinancials = {
					issuer: setup.issuer,
					...selected.value,
					tickerDirectoryUrl: setup.directoryUrl,
					companyFactsUrl: setup.factsUrl,
				};
				return ok(financials);
			},
		},
		filings: {
			latestHoldings: async () =>
				err({ code: "NO_DATA", detail: "unused", retryable: false, upstreamStatus: null }),
		},
		sharePrice:
			price === "unconfigured"
				? unconfiguredSharePriceSource
				: {
						async latestQuote() {
							if (price === "failed") {
								const failure: MarketDataUnavailable = {
									code: "NO_DATA",
									reason: setup.priceReason,
								};
								return err(failure);
							}
							const report: SharePriceReport = {
								quote: {
									securityId: "x",
									price: { amount: 1, currency: "USD" },
									priceAsOf: "2026-10-01T00:00:00.000Z",
									adjustmentBasis: "split-adjusted",
								},
								provenance: {
									sourceUrl: "https://example.com/",
									title: "t",
									publisher: "p",
									publishedAt: null,
									retrievedText: "x",
								},
							};
							return ok(report);
						},
					},
		hasher: sha256Hasher,
	});
	return runTool(tools, "finance.sec_company_financials", args, plain(setup));
}

const EXCHANGES: readonly (string | null)[] = [
	"Nasdaq",
	"NYSE",
	" nyse ",
	"NYSE American",
	"nyse arca",
	"Cboe BZX",
	"OTC",
	"CBOE",
	"",
	" ",
	null,
	"N".repeat(60),
	"NASDAQ",
];
const TICKERS = [
	"MSFT",
	"BRK-B",
	"XTESTA",
	"A",
	"BRK.B",
	"msft",
	"TOOLONGTICKERS",
	"A B",
	"A_B",
	"",
];
const NAMES = [
	"Microsoft Corp",
	"  Padded Inc  ",
	"N".repeat(301),
	"名".repeat(301),
	"😀".repeat(200),
	"Synthetic Alpha Devices Inc.",
	"",
];

async function financialsCases(): Promise<ToolCase[]> {
	const rng = new Rng(0x5ec70015);
	const cases: ToolCase[] = [];
	const issuer = (exchange: string | null) => ({
		cik: "0000789019",
		name: "Microsoft Corp",
		ticker: "MSFT",
		secExchange: exchange,
	});
	const base = (facts: unknown, over: Partial<FinancialsSetup> = {}): FinancialsSetup => ({
		issuer: issuer("Nasdaq"),
		facts,
		directoryUrl: "https://www.sec.gov/files/company_tickers_exchange.json",
		factsUrl: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json",
		sourceError: null,
		price: "unconfigured",
		priceReason: "",
		...over,
	});
	const factsPool: unknown[] = [JSON.parse(FACTS_ONE), JSON.parse(FACTS_TWO)];
	for (let index = 0; index < 20; index += 1) factsPool.push(alignedFacts(rng));
	for (const facts of factsPool) {
		cases.push(await runFinancials({ ticker: "MSFT" }, base(facts)));
		cases.push(await runFinancials({ ticker: "MSFT" }, base(facts, { price: "available" })));
		cases.push(
			await runFinancials(
				{ ticker: "MSFT" },
				base(facts, { price: "failed", priceReason: "N".repeat(400) }),
			),
		);
	}
	for (const args of [
		{ ticker: "  msft  " },
		{ ticker: "BRK.B" },
		{ ticker: "" },
		{ ticker: "TOOLONGTICKERS" },
		{ ticker: "A B" },
		{ ticker: 5 },
		{ ticker: null },
		{},
		{ ticker: "MSFT", extra: 1 },
		[],
		null,
		"MSFT",
		{ ticker: "ＭＳＦＴ" },
		{ ticker: "﻿MSFT" },
		{ ticker: "\u0085MSFT" },
	]) {
		cases.push(await runFinancials(args, base(factsPool[0])));
	}
	for (const error of [
		{
			code: "NOT_CONFIGURED",
			detail: "SEC EDGAR access is not configured",
			retryable: false,
			upstreamStatus: null,
		},
		{
			code: "NOT_FOUND",
			detail: "ticker is not in SEC's ticker directory",
			retryable: false,
			upstreamStatus: 404,
		},
		{
			code: "RATE_LIMITED",
			detail: "SEC rate limit reached (HTTP 429)",
			retryable: true,
			upstreamStatus: 429,
		},
		{ code: "FETCH_FAILED", detail: "TIMEOUT: x", retryable: true, upstreamStatus: null },
	] as const) {
		cases.push(await runFinancials({ ticker: "MSFT" }, base(factsPool[0], { sourceError: error })));
	}
	cases.push(await runFinancials({ ticker: "MSFT" }, base(null)));
	for (let index = 0; index < 300; index += 1) {
		const facts = rng.chance(0.5) ? alignedFacts(rng) : randomFacts(rng);
		const exchange = rng.pick(EXCHANGES);
		cases.push(
			await runFinancials(
				{ ticker: rng.pick(["MSFT", "brk.b", " X "]) },
				{
					...base(facts),
					issuer: {
						cik: rng.pick(["0000789019", "0000000001"]),
						name: rng.pick(NAMES),
						ticker: rng.chance(0.85) ? rng.pick(["MSFT", "BRK-B", "A"]) : rng.pick(TICKERS),
						secExchange: rng.chance(0.8)
							? rng.pick(["Nasdaq", "NYSE", " nyse ", "NYSE American"])
							: exchange,
					},
					price: rng.pick(["unconfigured", "failed", "available"]),
					priceReason: rng.pick([
						"none",
						"x".repeat(299),
						"x".repeat(300),
						"x".repeat(301),
						"é".repeat(301),
					]),
				},
			),
		);
	}
	return cases;
}

/* ---------- 13F ---------- */

function holdings(
	rng: Rng,
	count: number,
	pool: readonly string[],
	shared: boolean,
): Reported13FHolding[] {
	const cusips = rng.shuffle([...pool]).slice(0, count);
	void shared;
	return cusips.map((cusip) => ({
		issuerName: rng.pick([
			"APPLE INC",
			"MICROSOFT CORP",
			"N".repeat(310),
			"日本".repeat(160),
			"A | B",
			"Z",
		]),
		cusip,
		reportedShares: rng.pick([
			1,
			100,
			250.5,
			1e9,
			3,
			0,
			123456789012,
			Number.POSITIVE_INFINITY,
			Number.POSITIVE_INFINITY,
		]),
		reportedValueUsd: rng.pick([1000, 52000, 4400, 1e12, 0.5, 7e21]),
	}));
}

function filing(
	rng: Rng,
	ref: FilingRef,
	list: Reported13FHolding[],
	unreadable: number,
): Sec13FFiling {
	return {
		...ref,
		form: "13F-HR",
		filingUrl: `https://www.sec.gov/Archives/edgar/data/9999993/${ref.accessionNumber.replaceAll("-", "")}/${ref.accessionNumber}.txt`,
		holdings: list,
		valueUnitAsFiled: rng.pick(["usd", "usd-thousands"]),
		excludedRowCount: rng.int(0, 5),
		unreadableRowCount: unreadable,
		incompleteCusips:
			unreadable === 0
				? []
				: rng.picks(["CCCCCCCC3", "DDDDDDDD4", "AAAAAAAA1"], rng.int(0, 2)).sort(),
	};
}

async function runHoldings(args: unknown, report: Sec13FReport | SecError): Promise<ToolCase> {
	const tools = createSecTools({
		financials: {
			latestAnnualFinancials: async () =>
				err({ code: "NO_DATA", detail: "unused", retryable: false, upstreamStatus: null }),
		},
		filings: {
			async latestHoldings() {
				return "manager" in report ? ok(report) : err(report);
			},
		},
		sharePrice: unconfiguredSharePriceSource,
		hasher: sha256Hasher,
	});
	return runTool(tools, "filings.sec_13f_holdings", args, plain(report));
}

async function holdingsCases(): Promise<ToolCase[]> {
	const rng = new Rng(0x13f70015);
	const cases: ToolCase[] = [];
	const pool = Array.from({ length: 80 }, (_, index) => `C${String(index).padStart(8, "0")}`);
	const refA: FilingRef = {
		accessionNumber: "0009999993-26-000004",
		reportPeriodEnd: "2026-06-30",
		filedAt: "2026-08-14",
	};
	const refB: FilingRef = {
		accessionNumber: "0009999993-26-000001",
		reportPeriodEnd: "2026-03-31",
		filedAt: "2026-05-15",
	};
	for (const args of [
		{ managerCik: "0009999993" },
		{ managerCik: "CIK9999993" },
		{ managerCik: " cik123 " },
		{ managerCik: "12345678901" },
		{ managerCik: "" },
		{ managerCik: "abc" },
		{ managerCik: "CIKCIK1" },
		{ managerCik: 5 },
		{},
		{ managerCik: "1", extra: true },
	]) {
		const current = filing(rng, refA, holdings(rng, 5, pool, true), 0);
		const previous = filing(rng, refB, holdings(rng, 4, pool, true), 0);
		cases.push(
			await runHoldings(args, {
				manager: { cik: "0009999993", name: "Synthetic Capital Management LP" },
				submissionsUrl: "https://data.sec.gov/submissions/CIK0009999993.json",
				current,
				previous,
				changes: compareReportedPositions(previous.holdings, current.holdings),
				comparisonUnavailableReason: null,
			}),
		);
	}
	for (let index = 0; index < 70; index += 1) {
		const currentCount = rng.pick([0, 1, 5, 12, 30, 61, 70]);
		const previousCount = rng.pick([0, 3, 12, 30, 70]);
		const unreadableCurrent = rng.chance(0.15) ? rng.int(1, 4) : 0;
		const unreadablePrevious = rng.chance(0.15) ? rng.int(1, 4) : 0;
		const current = filing(rng, refA, holdings(rng, currentCount, pool, true), unreadableCurrent);
		const hasPrevious = rng.chance(0.8);
		const previous = hasPrevious
			? filing(rng, refB, holdings(rng, previousCount, pool, true), unreadablePrevious)
			: null;
		let reason: string | null = null;
		if (previous === null)
			reason = "no previous 13F-HR filing was found among this filer's recent SEC submissions";
		else if (unreadableCurrent > 0 || unreadablePrevious > 0) {
			reason =
				"N row(s) of the filing could not be read, so its holdings are incomplete and no change in reported positions is stated";
		}
		cases.push(
			await runHoldings(
				{ managerCik: rng.pick(["0009999993", "CIK9999993"]) },
				{
					manager: {
						cik: "0009999993",
						name: rng.pick(["Synthetic Capital Management LP", "N".repeat(310), "名".repeat(310)]),
					},
					submissionsUrl: "https://data.sec.gov/submissions/CIK0009999993.json",
					current,
					previous,
					changes:
						previous === null || reason !== null
							? []
							: compareReportedPositions(previous.holdings, current.holdings),
					comparisonUnavailableReason: reason,
				},
			),
		);
	}
	for (const error of [
		{
			code: "NOT_CONFIGURED",
			detail: "SEC EDGAR access is not configured",
			retryable: false,
			upstreamStatus: null,
		},
		{
			code: "NO_DATA",
			detail: "no 13F-HR filing among this filer's recent SEC submissions",
			retryable: false,
			upstreamStatus: null,
		},
		{
			code: "RATE_LIMITED",
			detail: "SEC rate limit reached (HTTP 429)",
			retryable: true,
			upstreamStatus: 429,
		},
	] as const) {
		cases.push(await runHoldings({ managerCik: "0009999993" }, error));
	}
	return cases;
}

/* ---------- positions ---------- */

interface PositionSetup {
	readonly us: PositionAnswer;
	readonly jp: PositionAnswer;
}

type PositionAnswer =
	| { readonly unavailable: MarketDataUnavailable }
	| {
			readonly report: {
				readonly asOfDate: string;
				readonly disseminatedAt: string | null;
				readonly figures: { readonly [key: string]: unknown };
				readonly provenance: {
					readonly sourceUrl: string;
					readonly title: string;
					readonly publisher: string;
					readonly publishedAt: string | null;
					readonly retrievedText: string;
				};
			};
	  };

async function runPosition(toolId: string, args: unknown, setup: PositionSetup): Promise<ToolCase> {
	const tools = createPositionTools({
		usShortInterest: {
			async latestShortInterest() {
				if ("unavailable" in setup.us) return err(setup.us.unavailable);
				const report = setup.us.report;
				return ok({
					figures: report.figures,
					settlementDate: report.asOfDate,
					disseminatedAt: report.disseminatedAt,
					provenance: report.provenance,
				} as unknown as UsShortInterestReport);
			},
		},
		jpMarginBalance: {
			async latestMarginBalance() {
				if ("unavailable" in setup.jp) return err(setup.jp.unavailable);
				const report = setup.jp.report;
				return ok({
					figures: report.figures,
					asOfDate: report.asOfDate,
					disseminatedAt: report.disseminatedAt,
					provenance: report.provenance,
				} as unknown as JpMarginBalanceReport);
			},
		},
		hasher: sha256Hasher,
	});
	return runTool(tools, toolId, args, plain(setup));
}

function positionAnswer(rng: Rng, jurisdiction: "US" | "JP"): PositionAnswer {
	if (rng.chance(0.4)) {
		return {
			unavailable: {
				code: rng.pick(["SOURCE_NOT_CONFIGURED", "NO_DATA", "SOURCE_FAILED"] as const),
				reason: rng.pick([
					"No source is configured.",
					"x".repeat(300),
					"x".repeat(301),
					"é".repeat(400),
					"line1\nline2",
				]),
			},
		};
	}
	const figures =
		jurisdiction === "US"
			? {
					jurisdiction: "US",
					metric: "us-short-interest",
					reportedShortInterestShares: rng.pick([1000, 0, 2.5e9, 12345.5]),
					averageDailyVolumeShares: rng.pick([null, 500, 0]),
				}
			: {
					jurisdiction: "JP",
					metric: "jp-margin-balance",
					marginBuyBalanceShares: rng.pick([1000, 0, 2.5e9]),
					marginSellBalanceShares: rng.pick([10, 0, 7e7]),
				};
	return {
		report: {
			asOfDate: rng.pick(["2026-09-15", "2026-02-28"]),
			disseminatedAt: rng.pick([null, "2026-09-25T00:00:00.000Z"]),
			figures,
			provenance: {
				sourceUrl: "https://example.org/data",
				title: rng.pick(["Short interest", "T".repeat(400), "日本".repeat(200)]),
				publisher: rng.pick(["FINRA", "P".repeat(400)]),
				publishedAt: rng.pick([null, "2026-09-25T00:00:00.000Z"]),
				retrievedText: rng.chance(0.03)
					? "R".repeat(25_000)
					: rng.pick(["short interest text", "日本語"]),
			},
		},
	};
}

async function positionCases(): Promise<ToolCase[]> {
	const rng = new Rng(0x9051);
	const cases: ToolCase[] = [];
	const argSets: [string, unknown][] = [
		["positions.us_short_interest", { ticker: "aapl" }],
		["positions.us_short_interest", { ticker: " BRK.B ", securityId: "sec_1" }],
		["positions.us_short_interest", { ticker: "AAPL", securityId: "" }],
		["positions.us_short_interest", { ticker: "AAPL", securityId: "bad id" }],
		["positions.us_short_interest", { ticker: "AAPL", securityId: null }],
		["positions.us_short_interest", { ticker: "AAPL", other: 1 }],
		["positions.us_short_interest", { ticker: "TOOLONGTICKERS" }],
		["positions.us_short_interest", {}],
		["positions.jp_margin_balance", { code: "7203" }],
		["positions.jp_margin_balance", { code: " 130a ", securityId: "sec_2" }],
		["positions.jp_margin_balance", { code: "A203" }],
		["positions.jp_margin_balance", { code: "72033" }],
		["positions.jp_margin_balance", { code: "７２０３" }],
		["positions.jp_margin_balance", { code: "7203", securityId: "x".repeat(97) }],
		["positions.jp_margin_balance", { code: "7203", securityId: "x".repeat(96) }],
		["positions.jp_margin_balance", "7203"],
	];
	for (const [toolId, args] of argSets) {
		for (let variant = 0; variant < 6; variant += 1) {
			cases.push(
				await runPosition(toolId, args, {
					us: positionAnswer(rng, "US"),
					jp: positionAnswer(rng, "JP"),
				}),
			);
		}
	}
	for (let index = 0; index < 250; index += 1) {
		const toolId = rng.pick(["positions.us_short_interest", "positions.jp_margin_balance"]);
		const args =
			toolId === "positions.us_short_interest"
				? {
						ticker: rng.pick(["AAPL", "brk.b"]),
						...(rng.chance(0.5) ? { securityId: "sec_9" } : {}),
					}
				: { code: rng.pick(["7203", "130a"]), ...(rng.chance(0.5) ? { securityId: "sec_9" } : {}) };
		cases.push(
			await runPosition(toolId, args, {
				us: positionAnswer(rng, "US"),
				jp: positionAnswer(rng, "JP"),
			}),
		);
	}
	return cases;
}

export async function toolsFiles(): Promise<{ path: string; content: unknown }[]> {
	return [
		{ path: "finance/tools_financials.json", content: await financialsCases() },
		{ path: "finance/tools_holdings.json", content: await holdingsCases() },
		{ path: "finance/tools_positions.json", content: await positionCases() },
	];
}
