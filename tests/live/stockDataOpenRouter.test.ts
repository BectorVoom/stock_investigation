/**
 * Opt-in live check of `stocks.search_data` (ADR-0071) on OpenRouter: a real
 * OpenRouter model runs the whole research pipeline with the stored-stock-data
 * tool as its only tool, so it must retrieve the passages to answer, cite them
 * and pass the pipeline's quote and number verification.
 *
 * The stored records are a fixture (Apple's FY2024 / FY2025 annual figures as
 * in its 10-Ks, a business paragraph, an earnings date and closes); the tool's
 * reader cuts and ranks them with the API's own code (`rankStockDataPassages`),
 * so only the HTTP hop and the database are left out — the API route itself is
 * covered on a real local D1 by `apps/api/test/stockData.test.ts`.
 *
 * Skipped unless RUN_LIVE_OPENROUTER=1, so `bun run test` and CI stay offline.
 * It spends OpenRouter credit (or free-model quota):
 *
 *   RUN_LIVE_OPENROUTER=1 OPENROUTER_API_KEY=sk-or-... OPENROUTER_MODEL=<model id> \
 *     node_modules/.bin/vitest run --project node tests/live/stockDataOpenRouter.test.ts
 *
 * Without OPENROUTER_MODEL the free-model backend (`openrouter-free`) picks a
 * free model itself.
 */
import { createAgentRuntimes, createNodeProcessRunner } from "@research/adapters/providers";
import { systemClock, webCryptoHasher } from "@research/adapters/runtime";
import { createStockDataTools, type StockDataReader } from "@research/adapters/tools";
import { createToolRegistry } from "@research/agent-core";
import {
	type PipelineReporter,
	rankStockDataPassages,
	runResearchPipeline,
	type StockDataRecords,
} from "@research/application";
import {
	equityStatementResponseSchema,
	marketSeriesSchema,
	STOCK_DATA_SECTIONS,
	type StockDataSection,
	stockProfileResponseSchema,
} from "@research/contracts";
import { EMPTY_USAGE, EQUITY_STATEMENTS, ok } from "@research/domain";
import { describe, expect, it } from "vitest";

const LIVE = process.env.RUN_LIVE_OPENROUTER === "1";
const PIPELINE_TIMEOUT_MS = 900_000;
const FILING_URL =
	"https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm";

/* ---------- the stored records (fixture) ---------- */

const COMPANY = {
	companyId: "eqc_live_aapl",
	market: "US",
	symbol: "AAPL",
	name: "Apple Inc.",
	provider: "sec",
	sourceCompanyId: "0000320193",
	fiscalYearEnd: "09-27",
	tracked: true,
	latestFiscalYear: 2025,
	filingCount: 2,
	sync: {
		status: "succeeded",
		lastCheckedAt: "2026-11-01T00:00:00.000Z",
		lastSucceededAt: "2026-11-01T00:00:00.000Z",
		nextDueAt: "2026-11-08T00:00:00.000Z",
		failure: null,
	},
} as const;

const FILINGS = [
	{
		filingId: "fil_2024",
		provider: "sec",
		sourceDocumentId: "0000320193-24-000123",
		form: "10-K",
		isAmendment: false,
		filedOn: "2024-11-01",
		periodEnd: "2024-09-28",
		accountingStandard: "US-GAAP",
		sourceUrl:
			"https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
	},
	{
		filingId: "fil_2025",
		provider: "sec",
		sourceDocumentId: "0000320193-25-000079",
		form: "10-K",
		isAmendment: false,
		filedOn: "2025-10-31",
		periodEnd: "2025-09-27",
		accountingStandard: "US-GAAP",
		sourceUrl: FILING_URL,
	},
] as const;

/** Annual values in USD base units, by statement, metric and fiscal year. */
const VALUES: Readonly<Record<string, Readonly<Record<number, string>>>> = {
	revenue: { 2024: "391035000000", 2025: "416161000000" },
	"operating-income": { 2024: "123216000000", 2025: "133050000000" },
	"profit-attributable-to-owners": { 2024: "93736000000", 2025: "112010000000" },
	"total-assets": { 2024: "364980000000", 2025: "359241000000" },
	"net-cash-from-operating-activities": { 2024: "118254000000", 2025: "111482000000" },
};

const STATEMENT_METRICS: Readonly<Record<string, readonly string[]>> = {
	"income-statement": ["revenue", "operating-income", "profit-attributable-to-owners"],
	"balance-sheet": ["total-assets"],
	"cash-flow": ["net-cash-from-operating-activities"],
};

function statement(kind: (typeof EQUITY_STATEMENTS)[number]) {
	return equityStatementResponseSchema.parse({
		company: COMPANY,
		statement: kind,
		fiscalYears: [2024, 2025],
		rows: (STATEMENT_METRICS[kind] ?? []).map((metric) => ({
			metric,
			cells: [2024, 2025].map((fiscalYear) => ({
				fiscalYear,
				periodEnd: fiscalYear === 2025 ? "2025-09-27" : "2024-09-28",
				valueDecimal: VALUES[metric]?.[fiscalYear] ?? null,
				currency: "USD",
				unavailableReason: null,
				filingId: fiscalYear === 2025 ? "fil_2025" : "fil_2024",
				concept: "us-gaap:Revenues",
				scope: "consolidated",
				derived: false,
				reportedValueCount: 1,
			})),
		})),
		filings: FILINGS,
		dataUpdatedAt: "2026-11-01T00:00:00.000Z",
	});
}

const RECORDS: StockDataRecords = {
	profile: stockProfileResponseSchema.parse({
		stockId: "us:AAPL",
		market: "US",
		symbol: "AAPL",
		priceSeriesId: "twelve-data:AAPL",
		directory: { name: "Apple Inc.", localName: null, listing: "nasdaq" },
		business: {
			status: "extracted",
			source: {
				sourceDocumentId: "0000320193-25-000079",
				form: "10-K",
				filedOn: "2025-10-31",
				periodEnd: "2025-09-27",
				sourceUrl: FILING_URL,
			},
			paragraphs: [
				{
					kind: "text",
					text: "The Company designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories, and sells a variety of related services.",
				},
			],
			truncated: false,
			fetchedAt: "2026-11-01T00:00:00.000Z",
		},
		companyProfile: null,
		summary: null,
		overview: null,
		company: COMPANY,
		earningsCalendar: {
			source: "finnhub",
			publisher: "Finnhub",
			sourceUrl: "https://finnhub.io/docs/api/earnings-calendar",
			syncedAt: "2026-11-04T00:00:00.000Z",
			events: [
				{
					periodKey: "2026-q1",
					announcementDate: "2027-01-28",
					fiscalPeriodLabel: "Q1 FY2027",
					fiscalPeriodEnd: null,
					timing: "after-close",
				},
			],
		},
	}),
	series: marketSeriesSchema.parse({
		seriesId: "twelve-data:AAPL",
		provider: "twelve-data",
		symbol: "AAPL",
		title: "AAPL",
		unit: "USD",
		frequency: "daily",
		publisher: "Twelve Data",
		sourceUrl: "https://twelvedata.com/",
		lastRefreshedAt: "2026-11-04T00:00:00.000Z",
		retrievedAt: "2026-11-04T00:00:00.000Z",
		unavailable: null,
		observations: [
			["2026-11-02", 268.4],
			["2026-11-03", 269.1],
			["2026-11-04", 270.25],
		],
	}),
	statements: EQUITY_STATEMENTS.map(statement),
};

/** The API's search over the fixture: the stock named or found, then the API's own ranking. */
function fixtureReader(calls: string[]): StockDataReader {
	return {
		async searchStockData(_runId, request) {
			calls.push(request.query);
			const named =
				request.stockIds?.includes("us:AAPL") === true || /aapl|apple/i.test(request.query);
			if (!named) return ok({ searchedStocks: [], passages: [] });
			const sections = new Set<StockDataSection>(request.sections ?? STOCK_DATA_SECTIONS);
			return ok({
				searchedStocks: ["us:AAPL"],
				passages: rankStockDataPassages([RECORDS], sections, request.query, request.limit),
			});
		},
	};
}

function recordingReporter() {
	const tools: { toolId: string; outcome: string; detail: string }[] = [];
	const reporter: PipelineReporter = {
		async state() {},
		async note() {},
		async tool(toolId, outcome, detail) {
			tools.push({ toolId, outcome, detail });
		},
		async usage() {},
	};
	return { reporter, tools };
}

/** Offline, always: the fixture the live run reads answers its question with the right passages. */
describe("stock-data fixture for the live OpenRouter run", () => {
	it("ranks the FY2025 income statement first for the question's words, cited to the 10-K", async () => {
		const found = await fixtureReader([]).searchStockData("run_offline", {
			leaseGeneration: 1,
			query: "Apple revenue net income fiscal year 2025",
		});
		if (!found.ok) throw new Error(found.error.code);
		const [best] = found.value.passages;
		expect(best?.title).toBe("Income statement FY2025 — Apple Inc.");
		expect(best?.text).toContain("revenue (net sales) 416161000000 USD (416.16 billion)");
		expect(best?.text).toContain(
			"net income (profit attributable to owners of the parent) 112010000000 USD",
		);
		expect(best?.sourceUrl).toBe(FILING_URL);

		const earnings = await fixtureReader([]).searchStockData("run_offline", {
			leaseGeneration: 1,
			query: "AAPL next earnings announcement date",
			limit: 1,
		});
		expect(earnings.ok && earnings.value.passages[0]?.text).toContain(
			"2027-01-28 (Q1 FY2027, after-close)",
		);
	});
});

describe.skipIf(!LIVE)("live OpenRouter run with stocks.search_data (spends credit)", () => {
	it(
		"retrieves the stored figures, cites the 10-K and passes verification",
		async () => {
			const model = process.env.OPENROUTER_MODEL?.trim() ?? "";
			const agentId = model === "" ? "openrouter-free" : "openrouter";
			const agent = createAgentRuntimes({
				processRunner: createNodeProcessRunner(),
				fetch,
				env: process.env,
			}).find((runtime) => runtime.agentId === agentId);
			if (agent === undefined) throw new Error(`no ${agentId} runtime`);
			const probe = await agent.probe();
			if (probe.availability.status !== "available") {
				throw new Error(`${agentId} is not available: ${probe.availability.reasonCode}`);
			}

			const calls: string[] = [];
			const { reporter, tools } = recordingReporter();
			const outcome = await runResearchPipeline(
				{
					runId: "run_live_stock_data",
					leaseGeneration: 1,
					request: {
						workspaceId: "ws_live",
						question:
							"Using the app's stored stock data, what were Apple's (us:AAPL) revenue and net income in fiscal year 2025 compared with fiscal year 2024, and when is its next earnings announcement?",
						agentId,
						model: model === "" ? null : model,
						effort: "low",
						horizonYears: 3,
						markets: ["US"],
						budget: {
							maxAgentSteps: 6,
							maxToolCalls: 6,
							maxWallClockMs: 600_000,
							maxInputBytes: 400_000,
							maxSpendUsd: 1,
						},
						webAccess: "off",
					},
					sources: [],
					workspaceComponents: [],
					conversationContext: [],
					priorUsage: EMPTY_USAGE,
					signal: new AbortController().signal,
					allowUnverifiedToolIsolation: false,
				},
				{
					agent,
					tools: createToolRegistry(
						createStockDataTools({ reader: fixtureReader(calls), hasher: webCryptoHasher }),
					),
					clock: systemClock,
					reporter,
					newFenceToken: () => crypto.randomUUID(),
					scratchDirectory: null,
				},
			);

			const bundle =
				outcome.kind === "completed" || outcome.kind === "partial" ? outcome.bundle : null;
			const claims = bundle?.claims ?? [];
			const supported = claims.filter((claim) => claim.status === "supported");
			process.stdout.write(
				`${JSON.stringify({
					agentId,
					model: model === "" ? "(free model)" : model,
					outcome: outcome.kind,
					failureCode:
						outcome.kind === "partial" || outcome.kind === "failed" ? outcome.failureCode : null,
					queries: calls,
					tools,
					evidence: bundle?.evidence.map((item) => item.sourceUrl) ?? [],
					claims: claims.map((claim) => ({ status: claim.status, text: claim.text })),
					usage: outcome.usage,
				})}\n`,
			);

			expect(["completed", "partial"]).toContain(outcome.kind);
			// The model retrieved through the tool, and the tool answered.
			expect(
				tools.some(
					(entry) => entry.toolId === "stocks.search_data" && entry.outcome === "executed",
				),
			).toBe(true);
			// The bundle cites the stored 10-K passage...
			expect(bundle?.evidence.some((item) => item.sourceUrl === FILING_URL)).toBe(true);
			// ...and at least one claim survived quote and number verification.
			expect(supported.length).toBeGreaterThan(0);
		},
		PIPELINE_TIMEOUT_MS,
	);
});
