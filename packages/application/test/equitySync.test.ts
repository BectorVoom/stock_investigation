import { EQUITY_FINANCIAL_LIMITS } from "@research/contracts";
import { EMPTY_USAGE, type EquityMetricCode } from "@research/domain";
import { describe, expect, it } from "vitest";
import { createSyncCheckGate } from "../src/dataSync.ts";
import {
	compareDescriptionKeys,
	createEquitySyncService,
	createOwnerMemo,
	describeFilingOf,
	descriptionReplaces,
	EQUITY_NOT_FOUND_RETRY_MS,
	EQUITY_REFUSED_JOB_RETRY_MS,
	type EquitySyncServiceDeps,
	edinetIndexedPlan,
	equityCompletionDelayMs,
	equityFactRows,
	equityFailureRetryDelayMs,
	equityFilingId,
	equityMetricCell,
	equityReadKeys,
	equitySyncIntervalMs,
	equitySyncRequestOf,
	equitySyncRetryDelayMs,
	equitySyncStatus,
	equityTrackDueAt,
	jstDateOf,
	type PlannedEquityFact,
	planCompletionFilings,
	recomputeEquityValues,
	shapeEquityRows,
} from "../src/equitySync.ts";
import {
	type EdinetIndexedReport,
	EMPTY_EQUITY_SYNC_STATE,
	type EquityClaimContext,
	type EquityDirectoryCandidate,
	type EquityListingToTrack,
	type EquitySyncRepository,
	type StoredEquityFiling,
	type StoredEquityMetricValue,
} from "../src/equitySyncPorts.ts";
import type { JobRecord } from "../src/ports.ts";

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
		firstSeenAt: "2025-11-01T00:00:00.000Z",
		// Set exactly when the facts are recorded (the table's CHECK).
		primaryScope:
			overrides.factsStatus === undefined || overrides.factsStatus === "extracted"
				? "consolidated"
				: null,
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
		primaryScope: "consolidated",
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
		provider: "sec" | "edinet" = "sec",
	) =>
		planCompletionFilings({
			companyId: COMPANY,
			provider,
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

	it("keeps an EDINET report that could not be read pending for 7 days after it was first seen", () => {
		const report = completionFiling({
			sourceDocumentId: "S100AB10",
			form: "securities-report",
			filedOn: "2023-06-27",
			factsStatus: "not-available",
			accountingStandard: null,
			facts: [],
		});
		// New, though filed long ago: pending (SEC would record it unavailable).
		const fresh = plan([report], [], "2026-10-11", "edinet");
		expect(fresh.newFilings[0]?.factsStatus).toBe("pending");
		expect(
			plan([{ ...report, form: "10-K", sourceDocumentId: "0000320193-23-000001" }]).newFilings[0]
				?.factsStatus,
		).toBe("unavailable");
		const stored = (firstSeenAt: string) =>
			filing({
				filingId: equityFilingId(COMPANY, "edinet", "S100AB10"),
				provider: "edinet",
				sourceDocumentId: "S100AB10",
				form: "securities-report",
				filedOn: "2023-06-27",
				factsStatus: "pending",
				accountingStandard: null,
				factCount: 0,
				firstSeenAt,
			});
		const within = plan([report], [stored("2026-10-05T09:00:00.000Z")], "2026-10-11", "edinet");
		expect(within.finalizedFilings).toEqual([]);
		const after = plan([report], [stored("2026-10-04T09:00:00.000Z")], "2026-10-11", "edinet");
		expect(after.finalizedFilings).toEqual([
			expect.objectContaining({ factsStatus: "unavailable" }),
		]);
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
				primaryScope: "consolidated",
			},
		]);
		expect(result.facts).toHaveLength(1);
	});

	it("drops facts that are not annual and exact repeats, and keeps a key reported with two values", () => {
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
					// An exact repeat collapses.
					{ ...revenue },
					// A quarter.
					{ ...revenue, periodStart: "2025-07-01", valueDecimal: "25" },
					// The same key again with another value: both kept, so the
					// selection sees the conflict (never an older filing's value).
					{ ...revenue, concept: "us-gaap:GrossProfit", valueDecimal: "1" },
					{ ...revenue, concept: "us-gaap:GrossProfit", valueDecimal: "2" },
				],
			}),
		]);
		expect(result.facts.map((entry) => [entry.concept, entry.valueDecimal])).toEqual([
			["us-gaap:Revenues", "100"],
			["us-gaap:GrossProfit", "1"],
			["us-gaap:GrossProfit", "2"],
		]);
		expect(result.droppedFacts).toBe(2);
		expect(result.newFilings[0]?.factCount).toBe(3);
	});

	it("records the filing's primary scope with its facts", () => {
		const consolidated = completionFiling().facts[0];
		if (consolidated === undefined) throw new Error("fixture");
		const separate = { ...consolidated, scope: "separate" as const, valueDecimal: "40" };
		const both = equityFactRows("f", "edinet", [separate, consolidated], "JGAAP", {
			filedOn: "2025-06-27",
		});
		expect(both.primaryScope).toBe("consolidated");
		expect(both.rows.map((row) => row.primaryScope)).toEqual(["consolidated", "consolidated"]);
		const parentOnly = equityFactRows("f", "edinet", [separate], "JGAAP", {
			filedOn: "2025-06-27",
		});
		expect(parentOnly.primaryScope).toBe("separate");
		expect(plan([completionFiling()]).newFilings[0]?.primaryScope).toBe("consolidated");
		const pending = plan([completionFiling({ factsStatus: "deferred", facts: [] })]);
		expect(pending.newFilings[0]?.primaryScope).toBeNull();
	});

	it("decides mappings per provider: an EDINET filing under US-GAAP has none", () => {
		const edinet = plan(
			[
				completionFiling({
					sourceDocumentId: "S100AB10",
					form: "securities-report",
					accountingStandard: "US-GAAP",
				}),
			],
			[],
			"2026-10-11",
			"edinet",
		);
		expect(edinet.facts[0]?.metricCode).toBeNull();
		expect(edinet.unmappedYears).toEqual(new Set([2025]));
		expect(edinet.touchedKeys).toContainEqual(["revenue", 2025]);
	});

	it("touches every metric of the year of a filing under a standard without mappings", () => {
		const result = plan(
			[
				completionFiling({
					sourceDocumentId: "S100AB10",
					form: "securities-report",
					accountingStandard: "IFRS",
					facts: [
						{
							concept: "jpigp_cor:RevenueIFRS",
							unit: "JPY",
							valueDecimal: "100",
							periodType: "duration",
							periodStart: "2024-10-01",
							periodEnd: "2025-09-30",
							scope: "consolidated",
						},
					],
				}),
			],
			[],
			"2026-10-11",
			"edinet",
		);
		expect(result.facts[0]?.metricCode).toBeNull();
		expect(result.unmappedYears).toEqual(new Set([2025]));
		expect(result.touchedKeys).toContainEqual(["ordinary-income", 2025]);
		expect(result.touchedKeys).toContainEqual(["free-cash-flow", 2025]);
	});

	it("maps an SEC filer's IFRS facts (a 20-F) with the reviewed ifrs-full mappings", () => {
		const result = plan([
			completionFiling({
				sourceDocumentId: "0000863064-25-000010",
				form: "20-F",
				accountingStandard: "IFRS",
				facts: [
					{
						concept: "ifrs-full:Revenue",
						unit: "USD",
						valueDecimal: "53658000000",
						periodType: "duration",
						periodStart: "2024-01-01",
						periodEnd: "2024-12-31",
						scope: "consolidated",
					},
				],
			}),
		]);
		expect(result.newFilings[0]).toMatchObject({ form: "20-F", accountingStandard: "IFRS" });
		expect(result.facts.map((entry) => [entry.metricCode, entry.fiscalYear])).toEqual([
			["revenue", 2024],
		]);
		expect(result.unmappedYears).toEqual(new Set());
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
			provider: "sec",
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
					provider: "sec",
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
			provider: "sec",
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
		// EDINET: SEC maps every standard its filings use (US GAAP and IFRS),
		// EDINET only JGAAP — the marker must stay per provider (ADR-0058 §5).
		const rows = recomputeEquityValues({
			provider: "edinet",
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

	it("answers ambiguous when the latest filing reports its best concept twice", () => {
		const older = equityFilingId(COMPANY, "sec", "0000320193-25-000001");
		const amendment = equityFilingId(COMPANY, "sec", "0000320193-26-000002");
		const rows = recomputeEquityValues({
			provider: "sec",
			touchedKeys: [["revenue", 2025]],
			unmappedYears: new Set(),
			storedFacts: [fact("revenue", "us-gaap:Revenues", "100", { filingId: older })],
			newFacts: [
				fact("revenue", "us-gaap:Revenues", "110", { filingId: amendment, filedOn: "2026-02-01" }),
				fact("revenue", "us-gaap:Revenues", "120", { filingId: amendment, filedOn: "2026-02-01" }),
				// A lower-ranked concept of the same filing never stands in.
				fact("revenue", "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax", "999", {
					filingId: amendment,
					filedOn: "2026-02-01",
				}),
			],
			storedValues: [],
		});
		expect(rows).toEqual([
			expect.objectContaining({ metricCode: "revenue", unavailableReason: "ambiguous" }),
		]);
	});

	it("selects only facts of their filing's primary scope", () => {
		const rows = recomputeEquityValues({
			provider: "edinet",
			touchedKeys: [
				["revenue", 2025],
				["gross-profit", 2025],
			],
			unmappedYears: new Set(),
			storedFacts: [],
			newFacts: [
				fact("revenue", "jppfs_cor:NetSales", "1000", { accountingStandard: "JGAAP" }),
				// A parent-only figure of a consolidated filer: history, not a value.
				fact("gross-profit", "jppfs_cor:GrossProfit", "300", {
					accountingStandard: "JGAAP",
					scope: "separate",
				}),
			],
			storedValues: [],
		});
		expect(rows).toEqual([
			expect.objectContaining({ metricCode: "revenue", valueDecimal: "1000" }),
		]);
		// A filer without subsidiaries: its separate figures are its values.
		const separateFiler = recomputeEquityValues({
			provider: "edinet",
			touchedKeys: [["gross-profit", 2025]],
			unmappedYears: new Set(),
			storedFacts: [],
			newFacts: [
				fact("gross-profit", "jppfs_cor:GrossProfit", "300", {
					accountingStandard: "JGAAP",
					scope: "separate",
					primaryScope: "separate",
				}),
			],
			storedValues: [],
		});
		expect(separateFiler).toEqual([
			expect.objectContaining({ valueDecimal: "300", scope: "separate" }),
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

/** A repository whose every call fails the test unless `overrides` provides it. */
function repository(overrides: Partial<EquitySyncRepository> = {}): EquitySyncRepository {
	const unexpected = (name: string) => async (): Promise<never> => {
		throw new Error(`unexpected repository call ${name}`);
	};
	return {
		probe: unexpected("probe"),
		untrackedDirectoryListings: unexpected("untrackedDirectoryListings"),
		trackListings: unexpected("trackListings"),
		untrackDelisted: unexpected("untrackDelisted"),
		claimContext: unexpected("claimContext"),
		reschedule: unexpected("reschedule"),
		listFilings: unexpected("listFilings"),
		listSummaries: unexpected("listSummaries"),
		findByListing: unexpected("findByListing"),
		businessByListing: unexpected("businessByListing"),
		findBySourceId: unexpected("findBySourceId"),
		factsOfKeys: unexpected("factsOfKeys"),
		valuesOfYears: unexpected("valuesOfYears"),
		valueYears: unexpected("valueYears"),
		valuesWithFilings: unexpected("valuesWithFilings"),
		revisions: unexpected("revisions"),
		recordFailure: unexpected("recordFailure"),
		...overrides,
	};
}

/** The service over `repo` with the directory reconcile off unless asked for. */
function serviceOver(
	repo: EquitySyncRepository,
	overrides: Partial<EquitySyncServiceDeps> = {},
): ReturnType<typeof createEquitySyncService> {
	return createEquitySyncService({
		equitySync: repo,
		jobs: {
			insert: async () => {
				throw new Error("unexpected insert");
			},
			findActiveByKind: async () => null,
		},
		stockDirectory: {
			listMeta: async () => {
				throw new Error("unexpected listMeta");
			},
		},
		clock: { nowMs: () => Date.parse(AT), nowIso: () => AT },
		ids: { newId: (prefix) => `${prefix}_1` },
		audit: { record: async () => undefined },
		trackDirectory: false,
		gate: createSyncCheckGate(5_000),
		reconciled: createOwnerMemo(),
		log: () => undefined,
		...overrides,
	});
}

const JP_COMPANY: EquityClaimContext["company"] = {
	companyId: COMPANY,
	market: "JP",
	symbol: "7974",
	provider: "edinet",
	sourceCompanyId: "E02367",
	name: null,
	fiscalYearEnd: null,
	tracked: true,
	trackedAt: AT,
};

/** One report of the shared EDINET index, submitted on `submittedOn` (JST). */
function indexed(
	docId: string,
	overrides: Partial<EdinetIndexedReport> & { readonly submittedOn?: string } = {},
): EdinetIndexedReport {
	const { submittedOn = "2025-06-27", ...rest } = overrides;
	return {
		docId,
		secCode: "79740",
		edinetCode: "E02367",
		filerName: "任天堂株式会社",
		docTypeCode: "120",
		periodStart: "2024-04-01",
		periodEnd: "2025-03-31",
		submittedAt: `${submittedOn}T15:30:00+09:00`,
		parentDocId: null,
		listedOn: submittedOn,
		...rest,
	};
}

describe("equitySyncRequestOf (claim payload)", () => {
	const nowMs = Date.parse(AT);
	const context = (overrides: Partial<EquityClaimContext> = {}): EquityClaimContext => ({
		company: JP_COMPANY,
		state: EMPTY_EQUITY_SYNC_STATE,
		onWatchlist: false,
		filings: [],
		indexedReports: [],
		describedReport: null,
		...overrides,
	});

	it("names the securities code and the index's unstored reports, oldest first, with their viewer page", () => {
		const stored = filing({
			sourceDocumentId: "S100OLD1",
			provider: "edinet",
			form: "securities-report",
			periodStart: "2023-04-01",
			periodEnd: "2024-03-31",
		});
		const request = equitySyncRequestOf(
			context({
				filings: [stored],
				indexedReports: [
					indexed("S100OLD1", {
						submittedOn: "2024-06-27",
						periodStart: "2023-04-01",
						periodEnd: "2024-03-31",
					}),
					// An amendment of the stored report takes its stored period.
					indexed("S100AMD1", {
						submittedOn: "2024-09-02",
						docTypeCode: "130",
						periodStart: null,
						periodEnd: null,
						parentDocId: "S100OLD1",
					}),
					indexed("S100NEW1"),
					// Its original is neither stored nor indexed: never downloadable, left out.
					indexed("S100AMD2", {
						submittedOn: "2025-07-01",
						docTypeCode: "130",
						periodStart: null,
						periodEnd: null,
						parentDocId: "S100GONE",
					}),
				],
			}),
			nowMs,
		);
		if (request.provider !== "edinet") throw new Error("expected EDINET");
		expect(request.secCode).toBe("79740");
		expect(request.edinetCode).toBe("E02367");
		expect(request.indexedFilings).toEqual([
			{
				sourceDocumentId: "S100AMD1",
				form: "amended-securities-report",
				filedOn: "2024-09-02",
				submittedAt: "2024-09-02T15:30:00+09:00",
				periodStart: "2023-04-01",
				periodEnd: "2024-03-31",
				amendsSourceDocumentId: "S100OLD1",
				sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100AMD1",
			},
			{
				sourceDocumentId: "S100NEW1",
				form: "securities-report",
				filedOn: "2025-06-27",
				submittedAt: "2025-06-27T15:30:00+09:00",
				periodStart: "2024-04-01",
				periodEnd: "2025-03-31",
				amendsSourceDocumentId: null,
				sourceUrl: "https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100NEW1",
			},
		]);
		expect("scanDays" in request).toBe(false);
		// 2026-10-10T15:00Z is already 11 October in Japan.
		expect(jstDateOf(Date.parse("2026-10-10T15:00:00.000Z"))).toBe("2026-10-11");
	});

	it("takes the filer code from the index until the company is resolved", () => {
		const request = equitySyncRequestOf(
			context({
				company: { ...JP_COMPANY, sourceCompanyId: null },
				indexedReports: [indexed("S100NEW1", { edinetCode: "E99999" })],
			}),
			nowMs,
		);
		if (request.provider !== "edinet") throw new Error("expected EDINET");
		expect(request.edinetCode).toBe("E99999");
		const none = equitySyncRequestOf(
			context({ company: { ...JP_COMPANY, sourceCompanyId: null } }),
			nowMs,
		);
		if (none.provider !== "edinet") throw new Error("expected EDINET");
		expect(none.edinetCode).toBeNull();
	});

	it("names at most maxPendingFilings indexed reports and says more are left", () => {
		const reports = Array.from({ length: 25 }, (_, index) =>
			indexed(`S1${String(index).padStart(6, "0")}`, {
				submittedOn: `2025-06-${String(index + 1).padStart(2, "0")}`,
			}),
		);
		const plan = edinetIndexedPlan(context({ indexedReports: reports }));
		expect(plan.filings).toHaveLength(20);
		expect(plan.filings[0]?.sourceDocumentId).toBe("S1000000");
		expect(plan.more).toBe(true);
		expect(plan.phase).toBe("idle");
		expect(edinetIndexedPlan(context()).phase).toBe("not-found");
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
		expect(request.knownFilings).toHaveLength(400);
		// With the stored period, so an amendment can take its original's.
		expect(request.knownFilings[0]).toEqual({
			docId: "S1000001",
			periodStart: filings[1]?.periodStart,
			periodEnd: filings[1]?.periodEnd,
		});
		expect(request.pendingFilings).toHaveLength(20);
		expect(request.pendingFilings[0]?.sourceDocumentId).toBe("S1000000");
	});
});

describe("the order of newly tracked companies (ADR-0058 §3)", () => {
	it("is the batch's order a millisecond apart, a Watchlist stock a day earlier", () => {
		const at = Date.parse(AT);
		expect(equityTrackDueAt(at, 0, false)).toBe(AT);
		expect(equityTrackDueAt(at, 2, false)).toBe("2026-10-11T00:00:00.002Z");
		// Before every directory stock of an earlier batch still waiting.
		expect(equityTrackDueAt(at, 0, true) < equityTrackDueAt(at - 60_000, 499, false)).toBe(true);
	});
});

describe("cadence and backoff (ADR-0058 §3)", () => {
	const DAY = 24 * 60 * MINUTE;
	const context = (overrides: Partial<EquityClaimContext> = {}): EquityClaimContext => ({
		company: { ...JP_COMPANY, market: "US", symbol: "AAPL", provider: "sec" },
		state: EMPTY_EQUITY_SYNC_STATE,
		onWatchlist: false,
		filings: [filing()],
		indexedReports: [],
		describedReport: null,
		...overrides,
	});
	const quiet = { newFilings: [], finalizedFilings: [], deferredWaiting: false };

	it("checks a Watchlist company daily and every other company weekly", () => {
		expect(equitySyncIntervalMs(true)).toBe(DAY);
		expect(equitySyncIntervalMs(false)).toBe(7 * DAY);
		expect(equityCompletionDelayMs(context({ onWatchlist: true }), quiet, false)).toBe(DAY);
		expect(equityCompletionDelayMs(context(), quiet, false)).toBe(7 * DAY);
	});

	it("comes back at once when work is left", () => {
		expect(equityCompletionDelayMs(context(), quiet, true)).toBe(0);
		expect(equityCompletionDelayMs(context(), { ...quiet, deferredWaiting: true }, false)).toBe(0);
		const many = Array.from({ length: 21 }, (_, index) =>
			indexed(`S1${String(index).padStart(6, "0")}`),
		);
		expect(
			equityCompletionDelayMs(
				context({ company: JP_COMPANY, filings: [], indexedReports: many }),
				quiet,
				false,
			),
		).toBe(0);
	});

	it("waits 30 days for a company with no annual report at all", () => {
		expect(EQUITY_NOT_FOUND_RETRY_MS).toBe(30 * DAY);
		expect(equityCompletionDelayMs(context({ filings: [] }), quiet, false)).toBe(30 * DAY);
		expect(
			equityCompletionDelayMs(context({ company: JP_COMPANY, filings: [] }), quiet, false),
		).toBe(30 * DAY);
	});

	it("keeps the daily check while a filing waits as pending", () => {
		const pending = filing({ factsStatus: "pending" });
		expect(equityCompletionDelayMs(context({ filings: [pending] }), quiet, false)).toBe(DAY);
		expect(
			equityCompletionDelayMs(
				context({ filings: [pending] }),
				{
					...quiet,
					finalizedFilings: [
						{
							filingId: pending.filingId,
							factsStatus: "unavailable",
							factCount: 0,
							accountingStandard: null,
							primaryScope: null,
						},
					],
				},
				false,
			),
		).toBe(7 * DAY);
	});

	it("backs off an identity conflict and an unknown company for 30 days", () => {
		expect(equityFailureRetryDelayMs("FINANCIAL_IDENTITY_CONFLICT", 1)).toBe(30 * DAY);
		expect(equityFailureRetryDelayMs("FINANCIAL_COMPANY_NOT_FOUND", 3)).toBe(30 * DAY);
		expect(equityFailureRetryDelayMs("FINANCIAL_RATE_LIMITED", 1)).toBe(30 * MINUTE);
	});
});

describe("materializeDue", () => {
	function deps(
		insert: EquitySyncServiceDeps["jobs"]["insert"],
		context: Partial<EquityClaimContext> = {},
	) {
		const logged: { event: string; fields: Readonly<Record<string, string | number>> }[] = [];
		const rescheduled: { companyId: string; nextDueAt: string; checkedAt: string | null }[] = [];
		const repo = repository({
			probe: async () => ({ activeJob: false, dueCompanyId: COMPANY }),
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
				onWatchlist: false,
				filings: [],
				indexedReports: [],
				describedReport: null,
				...context,
			}),
			reschedule: async (_owner, companyId, patch) => {
				rescheduled.push({ companyId, nextDueAt: patch.nextDueAt, checkedAt: patch.checkedAt });
			},
		});
		const service = serviceOver(repo, {
			jobs: { insert, findActiveByKind: async () => null },
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
		// Held a day ahead while the job runs; not yet checked.
		expect(rescheduled).toEqual([
			{
				companyId: COMPANY,
				nextDueAt: new Date(Date.parse(AT) + 24 * 60 * MINUTE).toISOString(),
				checkedAt: null,
			},
		]);
	});

	it("queues no job for a Japanese company the index holds nothing new for", async () => {
		const unqueued = async (): Promise<never> => {
			throw new Error("no job expected");
		};
		const none = deps(unqueued, { company: JP_COMPANY });
		expect(await none.service.materializeDue("owner")).toEqual({
			kind: "rescheduled",
			companyId: COMPANY,
			phase: "not-found",
		});
		// Checked now (it leaves the never-checked set); the index makes it due earlier.
		expect(none.rescheduled).toEqual([
			{
				companyId: COMPANY,
				nextDueAt: new Date(Date.parse(AT) + EQUITY_NOT_FOUND_RETRY_MS).toISOString(),
				checkedAt: AT,
			},
		]);
		const stored = filing({ sourceDocumentId: "S100NEW1", provider: "edinet" });
		const settled = deps(unqueued, {
			company: JP_COMPANY,
			onWatchlist: true,
			filings: [stored],
			indexedReports: [indexed("S100NEW1")],
			describedReport: {
				sourceDocumentId: "S100NEW1",
				filedOn: stored.filedOn,
				periodEnd: stored.periodEnd,
			},
		});
		expect(await settled.service.materializeDue("owner")).toMatchObject({ phase: "idle" });
		expect(settled.rescheduled[0]?.nextDueAt).toBe(
			new Date(Date.parse(AT) + 24 * 60 * MINUTE).toISOString(),
		);
	});

	it("queues a Japanese company's job when the index lists a report it has not stored", async () => {
		const { service } = deps(async () => ({ kind: "inserted" }), {
			company: JP_COMPANY,
			indexedReports: [indexed("S100NEW1")],
		});
		expect(await service.materializeDue("owner")).toMatchObject({ kind: "queued" });
	});

	it("writes nothing when a concurrent claim already queued the kind's job", async () => {
		const winner: JobRecord = {
			runId: "run_winner",
			ownerId: "owner",
			kind: "financial-sync",
			state: "pending",
			request: { companyId: COMPANY },
			workspaceId: null,
			usage: EMPTY_USAGE,
			attempt: 0,
			maxAttempts: 3,
			leaseGeneration: 0,
			leaseOwnerId: null,
			leaseExpiresAt: null,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			failureUpstreamStatus: null,
			approvalRequest: null,
			retryOfRunId: null,
			contextAnchorSeq: null,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 0,
			createdAt: AT,
			updatedAt: AT,
		};
		const { service, rescheduled } = deps(async () => ({ kind: "kind-active", job: winner }));
		expect(await service.materializeDue("owner")).toMatchObject({ kind: "refused" });
		// The winner's schedule stands: the loser writes nothing over it.
		expect(rescheduled).toEqual([]);
	});

	it("skips and logs when the unfinished-run cap refuses the job", async () => {
		const { service, logged, rescheduled } = deps(async () => ({ kind: "at-capacity" }));
		expect(await service.materializeDue("owner")).toMatchObject({ kind: "refused" });
		expect(logged).toEqual([
			{ event: "equity_sync_skipped", fields: { companyId: COMPANY, reason: "at-capacity" } },
		]);
		// Looked at again in a few minutes, not at every runner poll.
		expect(EQUITY_REFUSED_JOB_RETRY_MS).toBe(5 * MINUTE);
		const noWorkspace = deps(async () => ({ kind: "no-workspace" }));
		await noWorkspace.service.materializeDue("owner");
		expect(noWorkspace.rescheduled).toHaveLength(1);
		expect(rescheduled).toEqual([
			{
				companyId: COMPANY,
				nextDueAt: new Date(Date.parse(AT) + EQUITY_REFUSED_JOB_RETRY_MS).toISOString(),
				checkedAt: null,
			},
		]);
	});
});

describe("every directory stock is tracked (ADR-0058 §3)", () => {
	interface Meta {
		market: "US" | "JP";
		entryCount: number;
		retrievedAt: string;
	}

	function setup(options: {
		readonly metas: readonly Meta[];
		readonly candidates: readonly EquityDirectoryCandidate[];
		readonly untracked?: number;
		readonly trackDirectory?: boolean;
	}) {
		const metas = options.metas.map((meta) => ({ ...meta }));
		const audits: { action: string; resource: string; actor: string; detail: string }[] = [];
		const batches: (readonly EquityListingToTrack[])[] = [];
		const reads = { meta: 0, candidates: 0, untrack: 0 };
		let nowMs = Date.parse(AT);
		let nextId = 0;
		const repo = repository({
			probe: async () => ({ activeJob: false, dueCompanyId: null }),
			untrackedDirectoryListings: async (_owner, limit) => {
				reads.candidates += 1;
				expect(limit).toBe(EQUITY_FINANCIAL_LIMITS.trackBatch);
				return options.candidates;
			},
			trackListings: async (_owner, listings) => {
				batches.push(listings);
				return {
					inserted: listings.filter((listing) => !listing.existing).length,
					retracked: listings.filter((listing) => listing.existing).length,
				};
			},
			untrackDelisted: async () => {
				reads.untrack += 1;
				return options.untracked ?? 0;
			},
		});
		const service = serviceOver(repo, {
			stockDirectory: {
				listMeta: async () => {
					reads.meta += 1;
					return metas.map((meta) => ({ ...meta, asOf: null, foldVersion: 1 }));
				},
			},
			clock: { nowMs: () => nowMs, nowIso: () => new Date(nowMs).toISOString() },
			ids: {
				newId: (prefix) => {
					nextId += 1;
					return `${prefix}_${nextId}`;
				},
			},
			audit: {
				record: async (entry) => {
					audits.push({
						action: entry.action,
						resource: entry.resource,
						actor: entry.actor,
						detail: entry.detail,
					});
				},
			},
			trackDirectory: options.trackDirectory ?? true,
		});
		return {
			service,
			metas,
			audits,
			batches,
			reads,
			advance: (ms: number) => {
				nowMs += ms;
			},
		};
	}

	const US_META: Meta = { market: "US", entryCount: 7_682, retrievedAt: AT };
	const JP_META: Meta = { market: "JP", entryCount: 3_700, retrievedAt: AT };

	it("tracks the untracked directory stocks in one batch and audits each kind once", async () => {
		const run = setup({
			metas: [US_META, JP_META],
			candidates: [
				{
					market: "US",
					symbol: "NFLX",
					name: " Netflix, Inc. ",
					localName: null,
					companyId: null,
					onWatchlist: false,
				},
				{
					market: "US",
					symbol: "KO",
					name: "Coca-Cola Co",
					localName: null,
					companyId: "eqc_ko",
					onWatchlist: false,
				},
				{
					market: "JP",
					symbol: "7974",
					name: "Nintendo",
					localName: "任天堂",
					companyId: null,
					onWatchlist: true,
				},
			],
			untracked: 2,
		});
		expect(await run.service.materializeDue("owner")).toEqual({ kind: "idle" });
		expect(run.batches).toEqual([
			[
				{
					companyId: "eqc_1",
					market: "US",
					symbol: "NFLX",
					provider: "sec",
					name: "Netflix, Inc.",
					existing: false,
					dueAt: AT,
				},
				{
					companyId: "eqc_ko",
					market: "US",
					symbol: "KO",
					provider: "sec",
					name: "Coca-Cola Co",
					existing: true,
					// The batch's order, a millisecond apart (the never-checked queue's order).
					dueAt: "2026-10-11T00:00:00.001Z",
				},
				// A Japanese company takes the list's Japanese name.
				{
					companyId: "eqc_2",
					market: "JP",
					symbol: "7974",
					provider: "edinet",
					name: "任天堂",
					existing: false,
					// A Watchlist stock is due a day earlier: before every stock of an earlier batch.
					dueAt: "2026-10-10T00:00:00.002Z",
				},
			],
		]);
		expect(run.audits).toEqual([
			{ action: "equity.track", resource: "equity_company", actor: "scheduler", detail: "count=2" },
			{
				action: "equity.retrack",
				resource: "equity_company",
				actor: "scheduler",
				detail: "count=1",
			},
			{
				action: "equity.untrack",
				resource: "equity_company",
				actor: "scheduler",
				detail: "count=2",
			},
		]);
	});

	it("does not scan the directory again until a stored list changes", async () => {
		const run = setup({ metas: [US_META], candidates: [] });
		await run.service.materializeDue("owner");
		expect(run.reads).toEqual({ meta: 1, candidates: 1, untrack: 1 });
		run.advance(5_000);
		await run.service.materializeDue("owner");
		// The same lists: one meta read, no scan, no audit.
		expect(run.reads).toEqual({ meta: 2, candidates: 1, untrack: 1 });
		expect(run.audits).toEqual([]);
		run.metas.push(JP_META);
		run.advance(5_000);
		await run.service.materializeDue("owner");
		expect(run.reads).toEqual({ meta: 3, candidates: 2, untrack: 2 });
	});

	it("keeps going batch after batch while a full batch was tracked", async () => {
		const full = Array.from({ length: EQUITY_FINANCIAL_LIMITS.trackBatch }, (_, index) => ({
			market: "US" as const,
			symbol: `S${index}`,
			name: `Stock ${index}`,
			localName: null,
			companyId: null,
			onWatchlist: false,
		}));
		const run = setup({ metas: [US_META], candidates: full });
		await run.service.materializeDue("owner");
		run.advance(5_000);
		await run.service.materializeDue("owner");
		expect(run.reads.candidates).toBe(2);
		// The check period still spaces the batches.
		await run.service.materializeDue("owner");
		expect(run.reads.candidates).toBe(2);
	});

	it("reads nothing without a stored directory or while the reconcile is off", async () => {
		const none = setup({ metas: [], candidates: [] });
		await none.service.materializeDue("owner");
		expect(none.reads).toEqual({ meta: 1, candidates: 0, untrack: 0 });
		const off = setup({ metas: [US_META], candidates: [], trackDirectory: false });
		await off.service.materializeDue("owner");
		expect(off.reads).toEqual({ meta: 0, candidates: 0, untrack: 0 });
	});
});

describe("business description (ADR-0053 §2)", () => {
	const nowMs = Date.parse(AT);
	const ACCESSION = "0000320193-25-000001";
	const key = (periodEnd: string, filedOn: string, sourceDocumentId: string) => ({
		periodEnd,
		filedOn,
		sourceDocumentId,
	});
	const secCompany = {
		companyId: COMPANY,
		market: "US" as const,
		symbol: "AAPL",
		provider: "sec" as const,
		sourceCompanyId: "0000320193",
		name: null,
		fiscalYearEnd: null,
		tracked: true,
		trackedAt: AT,
	};
	const edinetCompany = {
		...secCompany,
		market: "JP" as const,
		symbol: "7974",
		provider: "edinet" as const,
		sourceCompanyId: "E02367",
	};
	const context = (overrides: Partial<EquityClaimContext> = {}): EquityClaimContext => ({
		company: secCompany,
		state: EMPTY_EQUITY_SYNC_STATE,
		onWatchlist: false,
		filings: [],
		indexedReports: [],
		describedReport: null,
		...overrides,
	});
	const report = (
		sourceDocumentId: string,
		periodEnd: string,
		filedOn: string,
		form: StoredEquityFiling["form"] = "securities-report",
	) =>
		filing({
			sourceDocumentId,
			provider: "edinet",
			form,
			periodEnd,
			filedOn,
			sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${sourceDocumentId}`,
		});

	it("orders reports by period end, then filing date, then document id", () => {
		const stored = key("2025-03-31", "2025-06-20", "S100AAAA");
		expect(descriptionReplaces(null, stored)).toBe(true);
		expect(descriptionReplaces(stored, stored)).toBe(true);
		expect(descriptionReplaces(stored, key("2026-03-31", "2025-01-01", "S0000000"))).toBe(true);
		expect(descriptionReplaces(stored, key("2025-03-31", "2025-06-21", "S0000000"))).toBe(true);
		expect(descriptionReplaces(stored, key("2025-03-31", "2025-06-20", "S100AAAB"))).toBe(true);
		expect(descriptionReplaces(stored, key("2024-03-31", "2026-06-20", "S9999999"))).toBe(false);
		expect(descriptionReplaces(stored, key("2025-03-31", "2025-06-19", "S9999999"))).toBe(false);
		expect(compareDescriptionKeys(stored, key("2025-03-31", "2025-06-20", "S100AAA0"))).toBe(1);
	});

	it("SEC claims name the described accession, or null", () => {
		const none = equitySyncRequestOf(context(), nowMs);
		if (none.provider !== "sec") throw new Error("expected SEC");
		expect(none.describedDocumentId).toBeNull();
		const stored = equitySyncRequestOf(
			context({ describedReport: key("2025-09-30", "2025-11-01", ACCESSION) }),
			nowMs,
		);
		if (stored.provider !== "sec") throw new Error("expected SEC");
		expect(stored.describedDocumentId).toBe(ACCESSION);
	});

	it("EDINET claims ask for the newest annual report newer than the described one", () => {
		const older = report("S100OLD1", "2024-03-31", "2024-06-20");
		const newest = report("S100NEW1", "2025-03-31", "2025-06-20");
		// An amendment filed later is never read for a description.
		const amendment = report("S100AMD1", "2025-03-31", "2025-08-01", "amended-securities-report");
		const filings = [amendment, newest, older];
		const describeOf = (describedReport: EquityClaimContext["describedReport"]) => {
			const request = equitySyncRequestOf(
				context({ company: edinetCompany, filings, describedReport }),
				nowMs,
			);
			if (request.provider !== "edinet") throw new Error("expected EDINET");
			return request.describeFiling;
		};
		expect(describeOf(null)).toEqual({
			sourceDocumentId: "S100NEW1",
			form: "securities-report",
			filedOn: "2025-06-20",
			submittedAt: null,
			periodStart: newest.periodStart,
			periodEnd: "2025-03-31",
			amendsSourceDocumentId: null,
			sourceUrl: newest.sourceUrl,
		});
		expect(describeOf(key("2024-03-31", "2024-06-20", "S100OLD1"))?.sourceDocumentId).toBe(
			"S100NEW1",
		);
		expect(describeOf(key("2025-03-31", "2025-06-20", "S100NEW1"))).toBeNull();
		// A stored description from a newer report than any stored filing stands.
		expect(describeOf(key("2026-03-31", "2026-06-20", "S100NEXT"))).toBeNull();
		expect(describeFilingOf([amendment], null)).toBeNull();
		expect(describeFilingOf([], null)).toBeNull();
	});

	describe("completionEffects", () => {
		const description = (
			sourceDocumentId: string,
			periodEnd: string,
			filedOn: string,
			status: "extracted" | "not-found",
		) => ({
			source: {
				sourceDocumentId,
				form: "10-K" as const,
				filedOn,
				periodEnd,
				sourceUrl: `https://www.sec.gov/Archives/edgar/data/320193/${sourceDocumentId.replaceAll("-", "")}/aapl.htm`,
			},
			status,
			paragraphs:
				status === "extracted"
					? [
							{ kind: "heading" as const, text: "Company Background" },
							{ kind: "text" as const, text: "The Company designs smartphones." },
						]
					: [],
			truncated: false,
		});
		const job: JobRecord = {
			runId: "run_1",
			ownerId: "owner",
			kind: "financial-sync",
			state: "collecting",
			request: { companyId: COMPANY },
			workspaceId: null,
			usage: EMPTY_USAGE,
			attempt: 1,
			maxAttempts: 3,
			leaseGeneration: 1,
			leaseOwnerId: "runner",
			leaseExpiresAt: null,
			lastEventSeq: -1,
			cancelRequested: false,
			failureCode: null,
			failureDetail: null,
			failureUpstreamStatus: null,
			approvalRequest: null,
			retryOfRunId: null,
			contextAnchorSeq: null,
			verificationStatus: null,
			providerModel: null,
			providerSessionRef: null,
			completedGeneration: null,
			provenance: null,
			version: 1,
			createdAt: AT,
			updatedAt: AT,
		};
		const FETCHED_AT = "2026-10-11T00:00:05.000Z";
		function serviceWith(described: EquityClaimContext["describedReport"]) {
			return serviceOver(
				repository({ claimContext: async () => context({ describedReport: described }) }),
			);
		}
		const completion = (
			read: ReturnType<typeof description> | null,
			sourceCompanyId = "0000320193",
		) => ({
			outcome: "financial-synced" as const,
			leaseGeneration: 1,
			usage: EMPTY_USAGE,
			companyId: COMPANY,
			provider: "sec" as const,
			fetchedAt: FETCHED_AT,
			identity: { sourceCompanyId, name: "Apple Inc.", fiscalYearEnd: "09-27" },
			filings: [],
			more: false,
			description: read,
		});
		async function storedDescription(
			described: EquityClaimContext["describedReport"],
			read: ReturnType<typeof description> | null,
		) {
			const effects = await serviceWith(described).completionEffects(
				"owner",
				job,
				completion(read),
			);
			if (!effects.ok || effects.value.kind !== "synced") throw new Error("expected synced");
			return effects.value.description;
		}
		const STORED = key("2024-09-28", "2024-11-01", "0000320193-24-000123");

		it("stores a first description with the completion's fetch time", async () => {
			const read = description(ACCESSION, "2025-09-27", "2025-10-31", "extracted");
			expect(await storedDescription(null, read)).toEqual({ ...read, fetchedAt: FETCHED_AT });
			expect(await storedDescription(null, null)).toBeNull();
		});

		it("replaces with a newer or equal report, whatever either's status", async () => {
			const newerNotFound = description(ACCESSION, "2025-09-27", "2025-10-31", "not-found");
			expect((await storedDescription(STORED, newerNotFound))?.status).toBe("not-found");
			const sameExtracted = description(
				STORED.sourceDocumentId,
				STORED.periodEnd,
				STORED.filedOn,
				"extracted",
			);
			expect((await storedDescription(STORED, sameExtracted))?.status).toBe("extracted");
		});

		it("keeps the stored description against an older report", async () => {
			const older = description("0000320193-23-000106", "2023-09-30", "2023-11-03", "extracted");
			expect(await storedDescription(STORED, older)).toBeNull();
		});

		it("stores nothing, description included, on an identity conflict", async () => {
			const read = description(ACCESSION, "2025-09-27", "2025-10-31", "extracted");
			const effects = await serviceWith(null).completionEffects(
				"owner",
				job,
				completion(read, "0000789019"),
			);
			if (!effects.ok) throw new Error("expected effects");
			expect(effects.value).toMatchObject({
				kind: "failed",
				failureCode: "FINANCIAL_IDENTITY_CONFLICT",
			});
			expect("description" in effects.value).toBe(false);
		});
	});
});
