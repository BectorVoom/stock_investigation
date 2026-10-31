import {
	ANNUAL_DURATION_DAYS,
	EDINET_SCAN,
	type EdinetScanInput,
	type EdinetScanPlan,
	EQUITY_ACCOUNTING_STANDARDS,
	EQUITY_CONCEPT_MAPPINGS,
	EQUITY_METRIC_CODES,
	type EquityMetricSelection,
	type EquityReportedFact,
	edinetScanPlan,
	equityMetricDefinition,
	fiscalYearOfPeriodEnd,
	isAnnualDuration,
	selectMetricValue,
	standardHasMappings,
	subtractDecimals,
} from "@research/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import vectors from "../../formal/vectors.json";

/**
 * Conformance between the annual financial statements core
 * (`packages/domain/src/finance/financialStatements.ts`, ADR-0048) and the
 * Lean 4 model in `formal/ResearchFormal/FinancialStatements.lean`.
 *
 * `formal/Export.lean` evaluates the verified definitions over exhaustive
 * small grids and every vector is replayed here against the implementation:
 * 1,966 selections (every ordered list of at most three facts, repeats
 * included, over a 10-fact revenue alphabet, an 8-fact profit alphabet and a
 * 6-fact capital-expenditure alphabet; one fact for the derived free cash
 * flow), each with integer and with fractional decimal text; 294 EDINET scan
 * plans and 7 whole syncs run job by job to `idle` / `not-found`; 48 annual
 * durations; 100 fiscal years; 1,444 exact subtractions. The model's dates
 * are day numbers since 1970-01-01 and become ISO dates here (the code
 * compares ISO dates as text, the order of the day numbers); its filing ids
 * become zero-padded ids, so text order is number order.
 */
const day = z.number().int().nonnegative();
const standard = z.enum(EQUITY_ACCOUNTING_STANDARDS);
const scope = z.enum(["consolidated", "separate"]);
const fact = z.object({
	filingId: z.number().int().nonnegative(),
	filedOn: day,
	standard,
	concept: z.string(),
	scope,
	unit: z.string(),
	value: z.number().int(),
	periodStart: day.nullable(),
	periodEnd: day,
});
const selection = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("value"),
		value: z.number().int(),
		currency: z.string(),
		filingId: z.number().int().nonnegative(),
		filedOn: day,
		concept: z.string(),
		scope,
		standard,
		periodStart: day.nullable(),
		periodEnd: day,
		reportedValueCount: z.number().int().positive(),
	}),
	z.object({
		kind: z.literal("unavailable"),
		reason: z.enum([
			"not-reported",
			"no-mapping-for-standard",
			"ambiguous",
			"unexpected-sign",
			"unsupported-unit",
			"not-derivable",
		]),
	}),
]);
const metricCode = z.enum(EQUITY_METRIC_CODES);
const phase = z.enum(["discovery", "backfill", "forward", "idle", "not-found"]);
const plan = z.object({ phase, days: z.array(day) });
const scanInput = z.object({
	today: day,
	scannedDays: z.array(day),
	annualReports: z.array(z.object({ periodEnd: day, filedOn: day })),
	backfillYears: z.number().int().nonnegative(),
	maxDays: z.number().int().nonnegative(),
});

const financialVectors = z.object({
	financialConstants: z.object({
		discoveryDays: z.number().int(),
		windowStartDays: z.number().int(),
		windowEndDays: z.number().int(),
		annualMin: z.number().int(),
		annualMax: z.number().int(),
	}),
	financialSelect: z.array(
		z.object({
			metric: metricCode,
			derived: z.boolean(),
			nonNegative: z.boolean(),
			mappings: z.array(
				z.object({
					standard,
					concept: z.string(),
					rank: z.number().int().nonnegative(),
					sign: z.union([z.literal(1), z.literal(-1)]),
					scope: z.enum(["consolidated", "separate", "any"]),
				}),
			),
			standardsWithMappings: z.array(standard),
			alphabet: z.array(fact),
			cases: z.array(z.object({ facts: z.array(z.number().int().nonnegative()), selection })),
		}),
	),
	financialScanPlan: z.array(z.object({ input: scanInput, plan })),
	financialScanRun: z.array(z.object({ input: scanInput, plans: z.array(plan) })),
	financialAnnualDuration: z.array(
		z.object({ periodStart: day, periodEnd: day, annual: z.boolean() }),
	),
	financialFiscalYear: z.array(z.object({ periodEnd: day, fiscalYear: z.number().int() })),
	financialSubtract: z.array(
		z.object({ left: z.string(), right: z.string(), difference: z.string() }),
	),
});

const parsed = financialVectors.parse(vectors);

const DAY_MS = 86_400_000;

function isoOf(dayNumber: number): string {
	return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function filingIdOf(id: number): string {
	return `F${String(id).padStart(8, "0")}`;
}

/** Two decimal encodings of a model integer: as is, and divided by 100 (canonical text). */
const ENCODINGS = {
	integer: (value: number): string => String(value),
	hundredths: (value: number): string => {
		const magnitude = Math.abs(value);
		const whole = Math.floor(magnitude / 100);
		const fraction = String(magnitude % 100)
			.padStart(2, "0")
			.replace(/0+$/, "");
		const text = fraction === "" ? String(whole) : `${whole}.${fraction}`;
		return value < 0 ? `-${text}` : text;
	},
} as const;

type Encode = (value: number) => string;

function toFact(row: z.infer<typeof fact>, encode: Encode): EquityReportedFact {
	return {
		filingId: filingIdOf(row.filingId),
		filedOn: isoOf(row.filedOn),
		standard: row.standard,
		concept: row.concept,
		scope: row.scope,
		unit: row.unit,
		valueDecimal: encode(row.value),
		periodStart: row.periodStart === null ? null : isoOf(row.periodStart),
		periodEnd: isoOf(row.periodEnd),
	};
}

function toSelection(row: z.infer<typeof selection>, encode: Encode): EquityMetricSelection {
	if (row.kind === "unavailable") return row;
	return {
		kind: "value",
		valueDecimal: encode(row.value),
		currency: row.currency,
		filingId: filingIdOf(row.filingId),
		filedOn: isoOf(row.filedOn),
		concept: row.concept,
		scope: row.scope,
		standard: row.standard,
		periodStart: row.periodStart === null ? null : isoOf(row.periodStart),
		periodEnd: isoOf(row.periodEnd),
		reportedValueCount: row.reportedValueCount,
	};
}

function toScanInput(row: z.infer<typeof scanInput>): EdinetScanInput {
	return {
		today: isoOf(row.today),
		scannedDays: row.scannedDays.map(isoOf),
		annualReports: row.annualReports.map((report) => ({
			periodEnd: isoOf(report.periodEnd),
			filedOn: isoOf(report.filedOn),
		})),
		backfillYears: row.backfillYears,
		maxDays: row.maxDays,
	};
}

function toPlan(row: z.infer<typeof plan>): EdinetScanPlan {
	return { phase: row.phase, days: row.days.map(isoOf) };
}

describe("annual financial statements conform to the Lean model (ADR-0048)", () => {
	it("models the code's constants", () => {
		expect(parsed.financialConstants).toEqual({
			discoveryDays: EDINET_SCAN.discoveryDays,
			windowStartDays: EDINET_SCAN.windowStartDays,
			windowEndDays: EDINET_SCAN.windowEndDays,
			annualMin: ANNUAL_DURATION_DAYS.min,
			annualMax: ANNUAL_DURATION_DAYS.max,
		});
	});

	it("models each vector metric with exactly the code's definition and mapping rows", () => {
		for (const block of parsed.financialSelect) {
			const definition = equityMetricDefinition(block.metric);
			expect(block.derived, block.metric).toBe(definition.derived);
			expect(block.nonNegative, block.metric).toBe(definition.nonNegative);
			expect(block.mappings, block.metric).toEqual(
				EQUITY_CONCEPT_MAPPINGS.filter((m) => m.metric === block.metric).map(
					({ standard, concept, rank, sign, scope }) => ({ standard, concept, rank, sign, scope }),
				),
			);
			expect(block.standardsWithMappings, block.metric).toEqual(
				EQUITY_ACCOUNTING_STANDARDS.filter(standardHasMappings),
			);
		}
	});

	it("the real mapping table meets the model's table precondition (TableCoherent)", () => {
		// Within one metric, standard and scope, a rank names one row: otherwise
		// two concepts of one filing could tie and the order of the facts would
		// pick the reported concept.
		const fitsBoth = (a: string, b: string, scopeName: string) =>
			(a === "any" || a === scopeName) && (b === "any" || b === scopeName);
		EQUITY_CONCEPT_MAPPINGS.forEach((a, i) => {
			EQUITY_CONCEPT_MAPPINGS.forEach((b, j) => {
				if (i >= j || a.metric !== b.metric || a.standard !== b.standard || a.rank !== b.rank)
					return;
				const clash =
					fitsBoth(a.scope, b.scope, "consolidated") || fitsBoth(a.scope, b.scope, "separate");
				expect(clash, `${a.concept} / ${b.concept}`).toBe(false);
			});
		});
	});

	for (const [name, encode] of Object.entries(ENCODINGS)) {
		it(`selects every metric value like the model (${name} decimals)`, () => {
			const counts = parsed.financialSelect.map((block) => block.cases.length);
			expect(counts).toEqual([1111, 585, 259, 11]);
			for (const block of parsed.financialSelect) {
				const alphabet = block.alphabet.map((row) => toFact(row, encode));
				for (const row of block.cases) {
					const facts = row.facts.map((index) => {
						const picked = alphabet[index];
						if (picked === undefined) throw new Error(`fact index ${index} out of range`);
						return picked;
					});
					expect(
						selectMetricValue(block.metric, facts),
						`${block.metric} ${JSON.stringify(row.facts)}`,
					).toEqual(toSelection(row.selection, encode));
				}
			}
		});
	}

	it("plans every EDINET scan like the model", () => {
		expect(parsed.financialScanPlan).toHaveLength(294);
		for (const row of parsed.financialScanPlan) {
			expect(edinetScanPlan(toScanInput(row.input)), JSON.stringify(row.input)).toEqual(
				toPlan(row.plan),
			);
		}
	});

	it("runs whole syncs job by job to idle or not-found like the model", () => {
		expect(parsed.financialScanRun).toHaveLength(7);
		for (const run of parsed.financialScanRun) {
			let input = toScanInput(run.input);
			for (const expected of run.plans) {
				const actual = edinetScanPlan(input);
				expect(actual, JSON.stringify(input.annualReports)).toEqual(toPlan(expected));
				input = { ...input, scannedDays: [...input.scannedDays, ...actual.days] };
			}
			expect(["idle", "not-found"]).toContain(run.plans.at(-1)?.phase);
		}
	});

	it("tells annual durations like the model", () => {
		expect(parsed.financialAnnualDuration).toHaveLength(48);
		for (const row of parsed.financialAnnualDuration) {
			expect(
				isAnnualDuration(isoOf(row.periodStart), isoOf(row.periodEnd)),
				JSON.stringify(row),
			).toBe(row.annual);
		}
	});

	it("labels fiscal years like the model", () => {
		expect(parsed.financialFiscalYear).toHaveLength(100);
		for (const row of parsed.financialFiscalYear) {
			expect(fiscalYearOfPeriodEnd(isoOf(row.periodEnd)), isoOf(row.periodEnd)).toBe(
				row.fiscalYear,
			);
		}
	});

	it("subtracts decimals exactly like the model", () => {
		expect(parsed.financialSubtract).toHaveLength(1444);
		for (const row of parsed.financialSubtract) {
			expect(subtractDecimals(row.left, row.right), `${row.left} - ${row.right}`).toBe(
				row.difference,
			);
		}
	});
});
