import { equityConceptsOfProvider } from "@research/domain";
import { describe, expect, it } from "vitest";
import { claimedJobSchema, completeJobRequestSchema } from "../src/index.ts";
import { resourceUsage } from "./fixtures.ts";

/** A JP `financial-sync` lease (ADR-0059 §2). */
function lease(source: Record<string, unknown>, market = "JP") {
	return {
		kind: "financial-sync",
		runId: "run_1",
		leaseGeneration: 1,
		leaseExpiresAt: "2026-11-02T00:05:00Z",
		attempt: 1,
		heartbeatIntervalMs: 10_000,
		sources: [],
		companyId: "eqc_1",
		market,
		symbol: "7203",
		concepts: [...equityConceptsOfProvider("jquants")],
		source,
	};
}

const SOURCE = { provider: "jquants", code: "72030", knownDisclosures: ["20250508412345"] };

/** Toyota's FY2026 summary as `GET /v2/fins/summary?code=7203` answered it on 2026-11-02. */
const FILING = {
	sourceDocumentId: "20260508533000",
	form: "earnings-report",
	filedOn: "2026-05-08",
	submittedAt: "2026-05-08T04:25:00.000Z",
	periodStart: "2025-04-01",
	periodEnd: "2026-03-31",
	amendsSourceDocumentId: null,
	sourceUrl: "https://api.jquants.com/v2/fins/summary?code=72030&date=2026-05-08",
	accountingStandard: "IFRS",
	factsStatus: "extracted",
	facts: [
		{
			concept: "jquants:Sales",
			unit: "JPY",
			valueDecimal: "50684952000000",
			periodType: "duration",
			periodStart: "2025-04-01",
			periodEnd: "2026-03-31",
			scope: "consolidated",
		},
	],
};

function completion(fields: Record<string, unknown> = {}) {
	return {
		outcome: "financial-synced",
		leaseGeneration: 1,
		usage: resourceUsage,
		companyId: "eqc_1",
		provider: "jquants",
		fetchedAt: "2026-11-02T00:00:00Z",
		identity: { sourceCompanyId: "72030", name: null, fiscalYearEnd: "03-31" },
		filings: [FILING],
		more: false,
		description: null,
		...fields,
	};
}

describe("J-Quants financial-sync claim (ADR-0059 §2)", () => {
	it("leases a JP company with its issue code and known disclosure numbers", () => {
		expect(claimedJobSchema.safeParse(lease(SOURCE)).success).toBe(true);
		expect(claimedJobSchema.safeParse(lease({ ...SOURCE, code: "130A0" })).success).toBe(true);
	});

	it("refuses a US company from J-Quants, a 4-character code and a malformed disclosure number", () => {
		expect(claimedJobSchema.safeParse(lease(SOURCE, "US")).success).toBe(false);
		expect(claimedJobSchema.safeParse(lease({ ...SOURCE, code: "7203" })).success).toBe(false);
		expect(claimedJobSchema.safeParse(lease({ ...SOURCE, code: "72031" })).success).toBe(false);
		expect(
			claimedJobSchema.safeParse(lease({ ...SOURCE, knownDisclosures: ["S100ABCD"] })).success,
		).toBe(false);
	});

	it("knows no EDINET claim any more", () => {
		const edinet = { provider: "edinet", secCode: "72030", edinetCode: null };
		expect(claimedJobSchema.safeParse(lease(edinet)).success).toBe(false);
	});
});

describe("J-Quants financial-synced completion (ADR-0059 §2)", () => {
	it("accepts earnings summaries keyed by disclosure number, a correction, and no filings", () => {
		expect(completeJobRequestSchema.safeParse(completion()).success).toBe(true);
		const correction = {
			...FILING,
			sourceDocumentId: "20260515538975",
			form: "amended-earnings-report",
			filedOn: "2026-05-15",
			amendsSourceDocumentId: FILING.sourceDocumentId,
		};
		expect(
			completeJobRequestSchema.safeParse(completion({ filings: [FILING, correction] })).success,
		).toBe(true);
		expect(
			completeJobRequestSchema.safeParse(completion({ filings: [], identity: null })).success,
		).toBe(true);
	});

	it("refuses an SEC form, an SEC accession, a CIK identity and a business description", () => {
		const refused = [
			completion({ filings: [{ ...FILING, form: "10-K" }] }),
			completion({ filings: [{ ...FILING, sourceDocumentId: "0000320193-25-000001" }] }),
			completion({
				identity: { sourceCompanyId: "0000320193", name: null, fiscalYearEnd: null },
			}),
			completion({
				description: {
					source: {
						sourceDocumentId: FILING.sourceDocumentId,
						form: "10-K",
						filedOn: FILING.filedOn,
						periodEnd: FILING.periodEnd,
						sourceUrl: FILING.sourceUrl,
					},
					status: "not-found",
					paragraphs: [],
					truncated: false,
				},
			}),
			completion({ filings: [FILING, FILING] }),
		];
		for (const body of refused) {
			expect(completeJobRequestSchema.safeParse(body).success).toBe(false);
		}
	});

	it("knows no EDINET forms or completion any more", () => {
		expect(
			completeJobRequestSchema.safeParse(
				completion({ filings: [{ ...FILING, form: "securities-report" }] }),
			).success,
		).toBe(false);
		expect(
			completeJobRequestSchema.safeParse({
				outcome: "edinet-indexed",
				leaseGeneration: 1,
				usage: resourceUsage,
				days: [],
			}).success,
		).toBe(false);
	});
});
