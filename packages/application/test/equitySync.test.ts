import type { EquityMetricCode } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	createEquitySyncService,
	type EquitySyncServiceDeps,
	equityFilingId,
	equityMetricCell,
	equityReadKeys,
	equitySyncRequestOf,
	equitySyncRetryDelayMs,
	equitySyncStatus,
	jstDateOf,
	type PlannedEquityFact,
	planCompletionFilings,
	recomputeEquityValues,
	shapeEquityRows,
} from "../src/equitySync.ts";
import {
	EMPTY_EQUITY_SYNC_STATE,
	type EquityClaimContext,
	type EquitySyncRepository,
	type StoredEquityFiling,
	type StoredEquityMetricValue,
} from "../src/equitySyncPorts.ts";

const COMPANY = "eqc_0123456789abcdef01234567";
const AT = "2026-10-11T00:00:00.000Z";
const MINUTE = 60_000;

function filing(overrides: Partial<StoredEquityFiling> = {}): StoredEquityFiling {
	const sourceDocumentId = overrides.sourceDocumentId ?? "0000320193-25-000001";
	return {
		filingId: equityFilingId(COMPANY, "sec", sourceDocumentId),
		companyId: COMPANY,
		provider: "sec",
		sourceDocumentId,
		form: "10-K",
		filedOn: "2025-11-01",
		submittedAt: null,
		periodStart: "2024-10-01",
		periodEnd: "2025-09-30",
		accountingStandard: "US-GAAP",
		amendsSourceDocumentId: null,
		sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/",
		factsStatus: "extracted",
		factCount: 1,
		...overrides,
	};
}

function fact(
	metricCode: EquityMetricCode | null,
	concept: string,
	valueDecimal: string,
	overrides: Partial<PlannedEquityFact> = {},
): PlannedEquityFact {
	return {
		filingId: equityFilingId(COMPANY, "sec", "0000320193-25-000001"),
		concept,
		scope: "consolidated",
		periodType: "duration",
		periodStart: "2024-10-01",
		periodEnd: "2025-09-30",
		unit: "USD",
		fiscalYear: 2025,
		metricCode,
		valueDecimal,
		filedOn: "2025-11-01",
		accountingStandard: "US-GAAP",
		...overrides,
	};
}

const completionFiling = (
	overrides: Partial<Parameters<typeof planCompletionFilings>[0]["filings"][number]> = {},
) => ({
	sourceDocumentId: "0000320193-25-000001",
	form: "10-K" as const,
	filedOn: "2025-11-01",
	submittedAt: null,
	periodStart: "2024-10-01",
	periodEnd: "2025-09-30",
	amendsSourceDocumentId: null,
	sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/000032019325000001/",
	accountingStandard: "US-GAAP" as const,
	factsStatus: "extracted" as const,
	facts: [
		{
			concept: "us-gaap:Revenues",
			unit: "USD",
			valueDecimal: "100",
			periodType: "duration" as const,
			periodStart: "2024-10-01",
			periodEnd: "2025-09-30",
			scope: "consolidated" as const,
		},
	],
	...overrides,
});

describe("equitySyncRetryDelayMs (ADR-0048 §6)", () => {
	it("doubles from 30 minutes and stops at 24 hours", () => {
		expect([1, 2, 3, 4, 5, 6, 7, 8, 50].map((n) => equitySyncRetryDelayMs(n) / MINUTE)).toEqual([
			30, 60, 120, 240, 480, 960, 1440, 1440, 1440,
		]);
	});
});

describe("equitySyncStatus", () => {
	it("derives queued, running, failed, succeeded and never", () => {
		const succeeded = { ...EMPTY_EQUITY_SYNC_STATE, lastSucceededAt: AT };
		expect(equitySyncStatus(EMPTY_EQUITY_SYNC_STATE, null)).toBe("never");
		expect(equitySyncStatus(succeeded, "pending")).toBe("queued");
		expect(equitySyncStatus(succeeded, "collecting")).toBe("running");
		expect(equitySyncStatus(succeeded, null)).toBe("succeeded");
		expect(
			equitySyncStatus(
				{ ...succeeded, failureCode: "X", failureAt: "2026-10-12T00:00:00.000Z" },
				null,
			),
		).toBe("failed");
		// A failure older than the last success is history, not the status.
		expect(
			equitySyncStatus(
				{ ...succeeded, failureCode: "X", failureAt: "2026-10-10T00:00:00.000Z" },
				null,
			),
		).toBe("succeeded");
	});
});

describe("planCompletionFilings", () => {
	const plan = (
		filings: ReturnType<typeof completionFiling>[],
		stored: StoredEquityFiling[] = [],
		todayUtc = "2026-10-11",
	) =>
		planCompletionFilings({
			companyId: COMPANY,
			provider: "sec",
			stored: new Map(stored.map((entry) => [entry.filingId, entry])),
			filings,
			todayUtc,
			at: AT,
		});

	it("inserts a new extracted filing with its facts and touches their keys", () => {
		const result = plan([completionFiling()]);
		expect(result.newFilings).toHaveLength(1);
		expect(result.newFilings[0]).toMatchObject({ factsStatus: "extracted", factCount: 1 });
		expect(result.facts.map((entry) => [entry.metricCode, entry.fiscalYear])).toEqual([
			["revenue", 2025],
		]);
		expect(result.touchedKeys).toEqual([["revenue", 2025]]);
	});

	it("never touches a filing already stored with a final status", () => {
		const result = plan([completionFiling()], [filing()]);
		expect(result.newFilings).toEqual([]);
		expect(result.finalizedFilings).toEqual([]);
		expect(result.facts).toEqual([]);
		expect(result.touchedKeys).toEqual([]);
	});

	it("keeps a recent filing without facts pending, records an old one as unavailable", () => {
		const recent = plan(
			[completionFiling({ filedOn: "2026-10-05", factsStatus: "not-available", facts: [] })],
			[],
			"2026-10-11",
		);
		expect(recent.newFilings[0]?.factsStatus).toBe("pending");
		const old = plan(
			[completionFiling({ filedOn: "2026-10-04", factsStatus: "not-available", facts: [] })],
			[],
			"2026-10-11",
		);
		expect(old.newFilings[0]?.factsStatus).toBe("unavailable");
		const deferred = plan([completionFiling({ factsStatus: "deferred", facts: [] })]);
		expect(deferred.newFilings[0]?.factsStatus).toBe("pending");
		expect(deferred.deferredWaiting).toBe(true);
	});

	it("moves a stored pending filing to extracted with the standard it learnt", () => {
		const pending = filing({ factsStatus: "pending", accountingStandard: null, factCount: 0 });
		const result = plan([completionFiling()], [pending]);
		expect(result.newFilings).toEqual([]);
		expect(result.finalizedFilings).toEqual([
			{
				filingId: pending.filingId,
				factsStatus: "extracted",
				factCount: 1,
				accountingStandard: "US-GAAP",
			},
		]);
		expect(result.facts).toHaveLength(1);
	});

	it("drops facts that are not annual and keys reported twice with different values", () => {
		const revenue = {
			concept: "us-gaap:Revenues",
			unit: "USD",
			valueDecimal: "100",
			periodType: "duration" as const,
			periodStart: "2024-10-01",
			periodEnd: "2025-09-30",
			scope: "consolidated" as const,
		};
		const result = plan([
			completionFiling({
				facts: [
					revenue,
					// A quarter.
					{ ...revenue, periodStart: "2025-07-01", valueDecimal: "25" },
					// The same key again with another value: both dropped.
					{ ...revenue, concept: "us-gaap:GrossProfit", valueDecimal: "1" },
					{ ...revenue, concept: "us-gaap:GrossProfit", valueDecimal: "2" },
				],
			}),
		]);
		expect(result.facts.map((entry) => entry.concept)).toEqual(["us-gaap:Revenues"]);
		expect(result.droppedFacts).toBe(3);
	});

	it("touches every metric of the year of a filing under a standard without mappings", () => {
		const result = plan([completionFiling({ accountingStandard: "IFRS" })]);
		expect(result.facts[0]?.metricCode).toBeNull();
		expect(result.unmappedYears).toEqual(new Set([2025]));
		expect(result.touchedKeys).toContainEqual(["ordinary-income", 2025]);
		expect(result.touchedKeys).toContainEqual(["free-cash-flow", 2025]);
	});
});

describe("recomputeEquityValues", () => {
	const facts = [
		fact(
			"net-cash-from-operating-activities",
			"us-gaap:NetCashProvidedByUsedInOperatingActivities",
			"500",
		),
		fact("capital-expenditures", "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment", "120"),
		fact("revenue", "us-gaap:Revenues", "1000"),
	];
	const touched: [EquityMetricCode, number][] = [
		["net-cash-from-operating-activities", 2025],
		["capital-expenditures", 2025],
		["free-cash-flow", 2025],
		["revenue", 2025],
	];

	it("writes the selections, derives free cash flow, and writes nothing on a re-run", () => {
		const first = recomputeEquityValues({
			touchedKeys: touched,
			unmappedYears: new Set(),
			storedFacts: [],
			newFacts: facts,
			storedValues: [],
		});
		expect(first.find((row) => row.metricCode === "free-cash-flow")).toMatchObject({
			valueDecimal: "380",
			derived: true,
		});
		expect(first).toHaveLength(4);
		const stored: StoredEquityMetricValue[] = first.map((row) => ({ ...row, updatedAt: AT }));
		// The same facts, now stored, in any order: nothing changes.
		for (const order of [facts, [...facts].reverse()]) {
			expect(
				recomputeEquityValues({
					touchedKeys: touched,
					unmappedYears: new Set(),
					storedFacts: order.map(({ ...entry }) => entry),
					newFacts: [],
					storedValues: stored,
				}),
			).toEqual([]);
		}
	});

	it("leaves a key without evidence absent and never writes a zero for it", () => {
		const rows = recomputeEquityValues({
			touchedKeys: [["gross-profit", 2025]],
			unmappedYears: new Set(),
			storedFacts: [],
			newFacts: [],
			storedValues: [],
		});
		expect(rows).toEqual([]);
		expect(equityMetricCell("gross-profit", 2025, undefined)).toMatchObject({
			valueDecimal: null,
			unavailableReason: "not-reported",
		});
		expect(equityMetricCell("free-cash-flow", 2025, undefined).unavailableReason).toBe(
			"not-derivable",
		);
	});

	it("says no-mapping-for-standard for a year only an unmapped filing covers", () => {
		const rows = recomputeEquityValues({
			touchedKeys: [["revenue", 2025]],
			unmappedYears: new Set([2025]),
			storedFacts: [],
			newFacts: [],
			storedValues: [],
		});
		expect(rows).toEqual([
			expect.objectContaining({
				metricCode: "revenue",
				valueDecimal: null,
				unavailableReason: "no-mapping-for-standard",
			}),
		]);
	});

	it("reads the free-cash-flow inputs for a touched free-cash-flow key", () => {
		expect(equityReadKeys([["free-cash-flow", 2024]])).toEqual([
			["net-cash-from-operating-activities", 2024],
			["capital-expenditures", 2024],
		]);
	});
});

describe("shapeEquityRows", () => {
	it("fills every metric and year and lists cited filings newest first", () => {
		const older = filing({ sourceDocumentId: "0000320193-24-000001", filedOn: "2024-11-01" });
		const newer = filing();
		const value = (year: number, cited: StoredEquityFiling): StoredEquityMetricValue => ({
			metricCode: "revenue",
			fiscalYear: year,
			valueDecimal: String(year),
			currency: "USD",
			unavailableReason: null,
			filingId: cited.filingId,
			concept: "us-gaap:Revenues",
			scope: "consolidated",
			periodStart: null,
			periodEnd: `${year}-09-30`,
			derived: false,
			reportedValueCount: 1,
			updatedAt: AT,
		});
		const shaped = shapeEquityRows(
			["revenue", "gross-profit"],
			[2024, 2025],
			[
				{ value: value(2024, older), filing: older },
				{ value: value(2025, newer), filing: newer },
			],
		);
		expect(shaped.rows.map((row) => row.cells.map((cell) => cell.valueDecimal))).toEqual([
			["2024", "2025"],
			[null, null],
		]);
		expect(shaped.filings.map((entry) => entry.filingId)).toEqual([newer.filingId, older.filingId]);
	});
});

describe("equitySyncRequestOf (claim payload)", () => {
	const nowMs = Date.parse(AT);
	const context = (overrides: Partial<EquityClaimContext> = {}): EquityClaimContext => ({
		company: {
			companyId: COMPANY,
			market: "JP",
			symbol: "7974",
			provider: "edinet",
			sourceCompanyId: "E02367",
			name: null,
			fiscalYearEnd: null,
			tracked: true,
			trackedAt: AT,
		},
		state: EMPTY_EQUITY_SYNC_STATE,
		filings: [],
		scannedDays: [],
		...overrides,
	});

	it("plans EDINET dates in Japan's calendar and names the securities code", () => {
		const request = equitySyncRequestOf(context(), nowMs);
		if (request.provider !== "edinet") throw new Error("expected EDINET");
		expect(request.secCode).toBe("79740");
		expect(request.edinetCode).toBe("E02367");
		expect(request.scanDays).toHaveLength(40);
		// 2026-10-10T15:00Z is already 11 October in Japan.
		expect(jstDateOf(Date.parse("2026-10-10T15:00:00.000Z"))).toBe("2026-10-11");
	});

	it("caps known and pending filings, newest first", () => {
		const filings = Array.from({ length: 450 }, (_, index) =>
			filing({
				sourceDocumentId: `S1${String(index).padStart(6, "0")}`,
				provider: "edinet",
				factsStatus: index % 10 === 0 ? "pending" : "extracted",
			}),
		);
		const request = equitySyncRequestOf(context({ filings }), nowMs);
		if (request.provider !== "edinet") throw new Error("expected EDINET");
		expect(request.knownDocIds).toHaveLength(400);
		expect(request.knownDocIds[0]).toBe("S1000001");
		expect(request.pendingFilings).toHaveLength(20);
		expect(request.pendingFilings[0]?.sourceDocumentId).toBe("S1000000");
	});
});

describe("materializeDue", () => {
	function deps(insert: EquitySyncServiceDeps["jobs"]["insert"]) {
		const logged: { event: string; fields: Readonly<Record<string, string | number>> }[] = [];
		const rescheduled: string[] = [];
		const unexpected = (name: string) => async (): Promise<never> => {
			throw new Error(`unexpected repository call ${name}`);
		};
		const repo: EquitySyncRepository = {
			probe: async () => ({ seeded: true, activeJob: false, dueCompanyId: COMPANY }),
			claimContext: async () => ({
				company: {
					companyId: COMPANY,
					market: "US",
					symbol: "AAPL",
					provider: "sec",
					sourceCompanyId: null,
					name: null,
					fiscalYearEnd: null,
					tracked: true,
					trackedAt: AT,
				},
				state: EMPTY_EQUITY_SYNC_STATE,
				filings: [],
				scannedDays: [],
			}),
			reschedule: async (_owner, companyId) => {
				rescheduled.push(companyId);
			},
			seedDefaults: unexpected("seedDefaults"),
			track: unexpected("track"),
			untrack: unexpected("untrack"),
			requestSync: unexpected("requestSync"),
			listSummaries: unexpected("listSummaries"),
			findByListing: unexpected("findByListing"),
			findBySourceId: unexpected("findBySourceId"),
			factsOfKeys: unexpected("factsOfKeys"),
			valuesOfYears: unexpected("valuesOfYears"),
			valueYears: unexpected("valueYears"),
			valuesWithFilings: unexpected("valuesWithFilings"),
			revisions: unexpected("revisions"),
			recordFailure: unexpected("recordFailure"),
		};
		const service = createEquitySyncService({
			equitySync: repo,
			jobs: { insert, findActiveByKind: async () => null },
			stockDirectory: { getEntry: async () => null },
			clock: { nowMs: () => Date.parse(AT), nowIso: () => AT },
			ids: { newId: (prefix) => `${prefix}_1` },
			audit: { record: async () => undefined },
			seedDefaults: false,
			log: (event, fields) => logged.push({ event, fields }),
		});
		return { service, logged, rescheduled };
	}

	it("queues the due company's job outside the owner's allowance", async () => {
		const { service, rescheduled } = deps(async () => ({ kind: "inserted" }));
		expect(await service.materializeDue("owner")).toEqual({
			kind: "queued",
			companyId: COMPANY,
			runId: "run_1",
		});
		expect(rescheduled).toEqual([COMPANY]);
	});

	it("skips and logs when the unfinished-run cap refuses the job", async () => {
		const { service, logged, rescheduled } = deps(async () => ({ kind: "at-capacity" }));
		expect(await service.materializeDue("owner")).toMatchObject({ kind: "refused" });
		expect(logged).toEqual([
			{ event: "equity_sync_skipped", fields: { companyId: COMPANY, reason: "at-capacity" } },
		]);
		// The company stays due for the next claim.
		expect(rescheduled).toEqual([]);
	});
});
