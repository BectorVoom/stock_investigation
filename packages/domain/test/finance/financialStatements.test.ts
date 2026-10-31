import "../support/seededProperties.ts";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	annualFactsOfFiling,
	deriveFreeCashFlow,
	EQUITY_CONCEPT_MAPPINGS,
	EQUITY_METRIC_CODES,
	EQUITY_METRICS,
	type EquityExtractedFact,
	type EquityReportedFact,
	edinetScanPlan,
	edinetSecuritiesCode,
	equityConceptsOfProvider,
	equityStatementMetrics,
	filingStaysPending,
	fiscalYearOfPeriodEnd,
	isAnnualDuration,
	isoDayNumber,
	selectFiscalYearMetrics,
	selectMetricValue,
	shiftIsoDateYears,
	subtractDecimals,
} from "../../src/finance/financialStatements.ts";

function fact(overrides: Partial<EquityReportedFact>): EquityReportedFact {
	return {
		filingId: "sec:0000320193-24-000123",
		filedOn: "2024-11-01",
		standard: "US-GAAP",
		concept: "us-gaap:Revenues",
		scope: "consolidated",
		unit: "USD",
		valueDecimal: "100",
		periodStart: "2023-10-01",
		periodEnd: "2024-09-28",
		...overrides,
	};
}

describe("metric registry", () => {
	it("lists every metric code once, in code order, and every mapping names a real metric", () => {
		expect(EQUITY_METRICS.map((m) => m.code)).toEqual([...EQUITY_METRIC_CODES]);
		for (const mapping of EQUITY_CONCEPT_MAPPINGS) {
			expect(EQUITY_METRIC_CODES).toContain(mapping.metric);
		}
	});

	it("never maps one concept to two metrics under one standard and scope", () => {
		const seen = new Set<string>();
		for (const m of EQUITY_CONCEPT_MAPPINGS) {
			const key = `${m.standard}|${m.concept}|${m.scope}`;
			expect(seen.has(key), key).toBe(false);
			seen.add(key);
		}
	});

	it("sends each provider only its own taxonomy's concepts, sorted", () => {
		const sec = equityConceptsOfProvider("sec");
		expect(sec.every((c) => c.startsWith("us-gaap:"))).toBe(true);
		expect([...sec].sort()).toEqual(sec);
		expect(equityConceptsOfProvider("edinet").every((c) => c.startsWith("jppfs_cor:"))).toBe(true);
	});

	it("groups metrics into the three statements", () => {
		expect(equityStatementMetrics("balance-sheet")).toEqual([
			"total-assets",
			"total-liabilities",
			"total-equity",
			"cash-and-cash-equivalents",
		]);
		expect(equityStatementMetrics("cash-flow")).toContain("free-cash-flow");
	});
});

describe("annual periods and fiscal years", () => {
	it("accepts calendar and 52/53-week years and refuses interim periods", () => {
		expect(isAnnualDuration("2024-01-01", "2024-12-31")).toBe(true);
		expect(isAnnualDuration("2023-10-01", "2024-09-28")).toBe(true); // 364 days
		expect(isAnnualDuration("2022-09-25", "2023-09-30")).toBe(true); // 371 days
		expect(isAnnualDuration("2024-07-01", "2024-09-28")).toBe(false); // a quarter
		expect(isAnnualDuration("2024-01-01", "2024-09-30")).toBe(false); // year to date
		expect(isAnnualDuration("2024-02-30", "2024-12-31")).toBe(false);
	});

	it("labels a fiscal year by the year it ends in, early-January ends by the year before", () => {
		expect(fiscalYearOfPeriodEnd("2025-03-31")).toBe(2025);
		expect(fiscalYearOfPeriodEnd("2024-09-28")).toBe(2024);
		expect(fiscalYearOfPeriodEnd("2023-01-01")).toBe(2022);
		expect(fiscalYearOfPeriodEnd("2023-01-08")).toBe(2023);
		expect(fiscalYearOfPeriodEnd("2023-13-01")).toBeNull();
	});

	it("keeps year-end instants and annual durations of a filing and drops the rest", () => {
		const base = { unit: "USD", valueDecimal: "1", scope: "consolidated" } as const;
		const facts: EquityExtractedFact[] = [
			{
				...base,
				concept: "a",
				periodType: "duration",
				periodStart: "2023-10-01",
				periodEnd: "2024-09-28",
			},
			{
				...base,
				concept: "b",
				periodType: "duration",
				periodStart: "2024-07-01",
				periodEnd: "2024-09-28",
			},
			{ ...base, concept: "c", periodType: "instant", periodStart: null, periodEnd: "2024-09-28" },
			{ ...base, concept: "d", periodType: "instant", periodStart: null, periodEnd: "2024-06-29" },
			{
				...base,
				concept: "e",
				periodType: "instant",
				periodStart: null,
				periodEnd: "2024-09-28",
				valueDecimal: "1.0",
			},
		];
		const { kept, dropped } = annualFactsOfFiling(facts);
		expect(kept.map((f) => f.concept)).toEqual(["a", "c"]);
		expect(dropped.map((d) => [d.fact.concept, d.problem])).toEqual([
			["b", "NOT_ANNUAL_DURATION"],
			["d", "INSTANT_NOT_AT_YEAR_END"],
			["e", "INVALID_DECIMAL"],
		]);
	});

	it("shifts dates by whole years and clamps 29 February", () => {
		expect(shiftIsoDateYears("2024-02-29", -1)).toBe("2023-02-28");
		expect(shiftIsoDateYears("2025-03-31", -4)).toBe("2021-03-31");
	});
});

describe("selectMetricValue", () => {
	it("takes the latest filing, so a restatement supersedes the original and counts as a revision", () => {
		const original = fact({ filingId: "sec:a", filedOn: "2024-11-01", valueDecimal: "100" });
		const restated = fact({ filingId: "sec:b", filedOn: "2025-10-31", valueDecimal: "90" });
		const selection = selectMetricValue("revenue", [original, restated]);
		expect(selection).toMatchObject({
			kind: "value",
			valueDecimal: "90",
			filingId: "sec:b",
			reportedValueCount: 2,
		});
	});

	it("prefers the best-ranked concept within the chosen filing", () => {
		const selection = selectMetricValue("revenue", [
			fact({
				concept: "us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax",
				valueDecimal: "7",
			}),
			fact({ concept: "us-gaap:Revenues", valueDecimal: "8" }),
		]);
		expect(selection).toMatchObject({
			kind: "value",
			valueDecimal: "8",
			concept: "us-gaap:Revenues",
		});
	});

	it("reports two different values for the best concept as ambiguous, never a guess", () => {
		const selection = selectMetricValue("revenue", [
			fact({ valueDecimal: "7" }),
			fact({ valueDecimal: "8" }),
		]);
		expect(selection).toEqual({ kind: "unavailable", reason: "ambiguous" });
	});

	it("prefers consolidated facts over separate ones even from an older filing", () => {
		const selection = selectMetricValue("total-assets", [
			fact({
				concept: "us-gaap:Assets",
				scope: "consolidated",
				filedOn: "2024-11-01",
				valueDecimal: "5",
				periodStart: null,
			}),
			fact({
				concept: "us-gaap:Assets",
				scope: "separate",
				filingId: "sec:z",
				filedOn: "2025-11-01",
				valueDecimal: "3",
				periodStart: null,
			}),
		]);
		expect(selection).toMatchObject({ kind: "value", valueDecimal: "5", scope: "consolidated" });
	});

	it("applies the EDINET payment sign and the scope rule of profit attributable to owners", () => {
		const jp = {
			standard: "JGAAP" as const,
			unit: "JPY",
			filingId: "edinet:S1",
			periodStart: "2024-04-01",
			periodEnd: "2025-03-31",
		};
		expect(
			selectMetricValue("capital-expenditures", [
				fact({
					...jp,
					concept: "jppfs_cor:PurchaseOfPropertyPlantAndEquipmentInvCF",
					valueDecimal: "-1200",
				}),
			]),
		).toMatchObject({ kind: "value", valueDecimal: "1200", currency: "JPY" });
		expect(
			selectMetricValue("profit-attributable-to-owners", [
				fact({ ...jp, concept: "jppfs_cor:ProfitLoss", scope: "consolidated", valueDecimal: "10" }),
			]),
		).toEqual({ kind: "unavailable", reason: "not-reported" });
		expect(
			selectMetricValue("profit-attributable-to-owners", [
				fact({ ...jp, concept: "jppfs_cor:ProfitLoss", scope: "separate", valueDecimal: "10" }),
			]),
		).toMatchObject({ kind: "value", valueDecimal: "10", scope: "separate" });
	});

	it("says a filer under an unmapped standard has no mapping instead of 'not reported'", () => {
		expect(
			selectMetricValue("revenue", [fact({ standard: "IFRS", concept: "jpigp_cor:RevenueIFRS" })]),
		).toEqual({ kind: "unavailable", reason: "no-mapping-for-standard" });
	});

	it("refuses an unexpected sign and a non-currency unit", () => {
		expect(
			selectMetricValue("total-assets", [
				fact({ concept: "us-gaap:Assets", valueDecimal: "-1", periodStart: null }),
			]),
		).toEqual({ kind: "unavailable", reason: "unexpected-sign" });
		expect(selectMetricValue("revenue", [fact({ unit: "shares" })])).toEqual({
			kind: "unavailable",
			reason: "unsupported-unit",
		});
	});

	it("depends only on the set of facts, and older filings never change the result", () => {
		// One filing has one filing date (the filing table's key), as in storage.
		const filedOnOf = {
			"sec:a": "2023-11-01",
			"sec:b": "2024-11-01",
			"sec:c": "2024-11-01",
		} as const;
		const factArb = fc.record({
			filingId: fc.constantFrom("sec:a" as const, "sec:b" as const, "sec:c" as const),
			concept: fc.constantFrom("us-gaap:Revenues", "us-gaap:SalesRevenueNet"),
			valueDecimal: fc.constantFrom("1", "2", "3"),
			scope: fc.constantFrom("consolidated" as const, "separate" as const),
		});
		fc.assert(
			fc.property(
				fc.array(factArb, { maxLength: 8 }),
				fc.array(factArb, { maxLength: 4 }),
				(base, extra) => {
					const facts = base.map((f) => fact({ ...f, filedOn: filedOnOf[f.filingId] }));
					const selection = selectMetricValue("revenue", facts);
					expect(selectMetricValue("revenue", [...facts].reverse())).toEqual(selection);
					if (selection.kind !== "value") return;
					const older = extra
						.map((f) =>
							fact({
								...f,
								filingId: `sec:old-${f.filingId}`,
								filedOn: "2020-01-01",
								scope: selection.scope,
							}),
						)
						.filter((f) => f.filedOn < selection.filedOn);
					const after = selectMetricValue("revenue", [...facts, ...older]);
					expect(after.kind === "value" && after.valueDecimal).toBe(selection.valueDecimal);
				},
			),
		);
	});
});

describe("free cash flow", () => {
	it("is derived only from one filing's operating cash flow and capital expenditures", () => {
		const metrics = selectFiscalYearMetrics([
			fact({
				concept: "us-gaap:NetCashProvidedByUsedInOperatingActivities",
				valueDecimal: "118254000000",
			}),
			fact({
				concept: "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
				valueDecimal: "9447000000",
			}),
		]);
		expect(metrics.get("free-cash-flow")).toMatchObject({
			kind: "value",
			valueDecimal: "108807000000",
			concept: "derived:free-cash-flow",
		});
		const other = selectMetricValue("capital-expenditures", [
			fact({
				filingId: "sec:other",
				concept: "us-gaap:PaymentsToAcquirePropertyPlantAndEquipment",
				valueDecimal: "1",
			}),
		]);
		expect(
			deriveFreeCashFlow(metrics.get("net-cash-from-operating-activities") ?? other, other),
		).toEqual({
			kind: "unavailable",
			reason: "not-derivable",
		});
	});

	it("subtracts exact decimals", () => {
		expect(subtractDecimals("1.5", "2.25")).toBe("-0.75");
		expect(subtractDecimals("9007199254740993", "1")).toBe("9007199254740992");
		expect(subtractDecimals("2", "2")).toBe("0");
	});
});

describe("filings without facts", () => {
	it("stay pending for seven days", () => {
		expect(filingStaysPending("2026-10-25", "2026-10-31")).toBe(true);
		expect(filingStaysPending("2026-10-24", "2026-10-31")).toBe(false);
	});
});

describe("edinetScanPlan", () => {
	const base = {
		today: "2026-10-31",
		scannedDays: [],
		annualReports: [],
		backfillYears: 5,
		maxDays: 40,
	};

	it("discovers the latest report from the June peak first, newest first, weekdays only", () => {
		const plan = edinetScanPlan(base);
		expect(plan.phase).toBe("discovery");
		expect(plan.days.length).toBe(40);
		expect(plan.days[0]).toBe("2026-06-30");
		expect(
			plan.days.slice(0, 12).every((d) => d.slice(5) >= "06-15" && d.slice(5) <= "06-30"),
		).toBe(true);
		for (const day of plan.days) {
			const weekday = ((((isoDayNumber(day) ?? 0) + 4) % 7) + 7) % 7;
			expect([0, 6]).not.toContain(weekday);
		}
	});

	it("never repeats a scanned day and says not-found when discovery is exhausted", () => {
		let scanned: string[] = [];
		for (let i = 0; i < 20; i++) {
			const plan = edinetScanPlan({ ...base, scannedDays: scanned });
			if (plan.phase === "not-found") break;
			expect(plan.days.some((d) => scanned.includes(d))).toBe(false);
			scanned = [...scanned, ...plan.days];
		}
		expect(edinetScanPlan({ ...base, scannedDays: scanned }).phase).toBe("not-found");
	});

	it("backfills earlier years in windows after each year end, then scans forward to yesterday", () => {
		const annualReports = [{ periodEnd: "2026-03-31", filedOn: "2026-06-26" }];
		const plan = edinetScanPlan({ ...base, annualReports, maxDays: 500 });
		expect(plan.phase).toBe("backfill");
		expect(plan.days[0]).toBe("2025-07-09");
		expect(plan.days.every((d) => d >= "2022-04-30" && d <= "2025-07-09")).toBe(true);
		const found = [
			...annualReports,
			{ periodEnd: "2025-03-31", filedOn: "2025-06-25" },
			{ periodEnd: "2024-03-31", filedOn: "2024-06-26" },
			{ periodEnd: "2023-03-31", filedOn: "2023-06-28" },
			{ periodEnd: "2022-03-31", filedOn: "2022-06-29" },
		];
		const forward = edinetScanPlan({ ...base, annualReports: found, maxDays: 500 });
		expect(forward.phase).toBe("forward");
		expect(forward.days[0]).toBe("2026-06-29");
		expect(forward.days.at(-1)).toBe("2026-10-30");
		expect(edinetScanPlan({ ...base, annualReports: found, scannedDays: forward.days }).phase).toBe(
			"idle",
		);
	});

	it("maps a JPX code to EDINET's five-character securities code", () => {
		expect(edinetSecuritiesCode("7974")).toBe("79740");
		expect(edinetSecuritiesCode("130A")).toBe("130A0");
	});
});
