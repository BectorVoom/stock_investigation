/** The pieces both financial statement sources share (ADR-0045 §6). */
import type { EquityFilingResult } from "@research/contracts";
import type { EquityExtractedFact } from "@research/domain";
import { describe, expect, it } from "vitest";
import {
	annualFactsInOrder,
	equitySyncCodeOfStatus,
	equitySyncFailureOfFetch,
	fitCompletionCaps,
	isRetryableEquitySyncFailure,
} from "../../src/finance/equitySync.ts";
import { equitySyncFailureOfSec } from "../../src/finance/secAnnualFilings.ts";
import { secError } from "../../src/finance/secClient.ts";
import { listZipEntries, readZipEntries } from "../../src/node/zipReader.ts";
import { buildTestZip } from "../zipTestUtils.ts";
import { expectErr, expectOk } from "./support.ts";

function fact(overrides: Partial<EquityExtractedFact>): EquityExtractedFact {
	return {
		concept: "us-gaap:Revenues",
		unit: "USD",
		valueDecimal: "100",
		periodType: "duration",
		periodStart: "2024-01-01",
		periodEnd: "2024-12-31",
		scope: "consolidated",
		...overrides,
	};
}

function filing(id: string, filedOn: string, facts: number): EquityFilingResult {
	return {
		sourceDocumentId: id,
		form: "10-K",
		filedOn,
		submittedAt: null,
		periodStart: null,
		periodEnd: "2024-12-31",
		amendsSourceDocumentId: null,
		sourceUrl: "https://www.sec.gov/Archives/edgar/data/1/1/",
		accountingStandard: "US-GAAP",
		factsStatus: "extracted",
		facts: Array.from({ length: facts }, (_, index) => fact({ valueDecimal: String(index) })),
	};
}

describe("failure mapping", () => {
	it("maps statuses: 401/403 denied, 429 rate limited, the rest a source failure", () => {
		expect(equitySyncCodeOfStatus(401)).toBe("FINANCIAL_ACCESS_DENIED");
		expect(equitySyncCodeOfStatus(403)).toBe("FINANCIAL_ACCESS_DENIED");
		expect(equitySyncCodeOfStatus(429)).toBe("FINANCIAL_RATE_LIMITED");
		for (const status of [400, 404, 500, 502, 503, 520]) {
			expect(equitySyncCodeOfStatus(status)).toBe("FINANCIAL_SOURCE_FAILED");
		}
	});

	it("maps fetch errors, keeping the status", () => {
		expect(equitySyncFailureOfFetch({ code: "HTTP_ERROR", detail: "", status: 503 }, 2)).toEqual({
			code: "FINANCIAL_SOURCE_FAILED",
			upstreamStatus: 503,
			requests: 2,
		});
		expect(equitySyncFailureOfFetch({ code: "TIMEOUT", detail: "" }, 1).code).toBe(
			"FINANCIAL_SOURCE_FAILED",
		);
		expect(equitySyncFailureOfFetch({ code: "RESPONSE_TOO_LARGE", detail: "" }, 1).code).toBe(
			"FINANCIAL_PARSE_FAILED",
		);
	});

	it("maps SEC client errors", () => {
		expect(equitySyncFailureOfSec(secError("NOT_CONFIGURED", ""), 0).code).toBe(
			"FINANCIAL_SOURCE_NOT_CONFIGURED",
		);
		expect(equitySyncFailureOfSec(secError("FETCH_FAILED", "", false, 401), 1)).toEqual({
			code: "FINANCIAL_ACCESS_DENIED",
			upstreamStatus: 401,
			requests: 1,
		});
		expect(equitySyncFailureOfSec(secError("UNEXPECTED_RESPONSE", ""), 1).code).toBe(
			"FINANCIAL_PARSE_FAILED",
		);
		expect(equitySyncFailureOfSec(secError("FETCH_FAILED", "", true), 1).code).toBe(
			"FINANCIAL_SOURCE_FAILED",
		);
	});

	it("retries rate limits and source failures only", () => {
		expect(isRetryableEquitySyncFailure("FINANCIAL_RATE_LIMITED")).toBe(true);
		expect(isRetryableEquitySyncFailure("FINANCIAL_SOURCE_FAILED")).toBe(true);
		for (const code of [
			"FINANCIAL_SOURCE_NOT_CONFIGURED",
			"FINANCIAL_COMPANY_NOT_FOUND",
			"FINANCIAL_ACCESS_DENIED",
			"FINANCIAL_PARSE_FAILED",
		] as const) {
			expect(isRetryableEquitySyncFailure(code)).toBe(false);
		}
	});
});

describe("annualFactsInOrder", () => {
	it("orders canonically, removes exact repeats and keeps only annual facts", () => {
		const facts = [
			fact({
				concept: "us-gaap:Assets",
				periodType: "instant",
				periodStart: null,
				valueDecimal: "5",
			}),
			fact({ valueDecimal: "100" }),
			fact({ valueDecimal: "100" }),
			fact({ periodStart: "2024-10-01", valueDecimal: "30" }),
			fact({
				concept: "us-gaap:Assets",
				periodType: "instant",
				periodStart: null,
				periodEnd: "2024-06-30",
			}),
		];
		expect(annualFactsInOrder(facts)).toEqual([
			fact({
				concept: "us-gaap:Assets",
				periodType: "instant",
				periodStart: null,
				valueDecimal: "5",
			}),
			fact({ valueDecimal: "100" }),
		]);
	});
});

describe("fitCompletionCaps", () => {
	it("keeps whole filings newest first within both caps, cutting the rest", () => {
		const filings = [
			filing("a", "2023-01-01", 10),
			filing("c", "2025-01-01", 10),
			filing("b", "2024-01-01", 10),
		];
		const kept = fitCompletionCaps(filings, { maxFilings: 60, maxFacts: 25 });
		expect(kept.filings.map((f) => f.sourceDocumentId)).toEqual(["c", "b"]);
		expect(kept.cut.map((f) => f.sourceDocumentId)).toEqual(["a"]);
		const byCount = fitCompletionCaps(filings, { maxFilings: 1, maxFacts: 3000 });
		expect(byCount.filings.map((f) => f.sourceDocumentId)).toEqual(["c"]);
		expect(fitCompletionCaps(filings).cut).toEqual([]);
	});

	it("orders a same-day tie by document id, newest id first", () => {
		const kept = fitCompletionCaps([filing("a", "2025-01-01", 0), filing("b", "2025-01-01", 0)]);
		expect(kept.filings.map((f) => f.sourceDocumentId)).toEqual(["b", "a"]);
	});

	it("reports a filing too large for any completion as not available", () => {
		const kept = fitCompletionCaps([filing("a", "2025-01-01", 11)], {
			maxFilings: 60,
			maxFacts: 10,
		});
		expect(kept.filings[0]).toMatchObject({
			factsStatus: "not-available",
			facts: [],
			accountingStandard: null,
		});
	});
});

describe("listZipEntries and per-call ZIP limits", () => {
	const archive = buildTestZip([
		{ name: "XBRL_TO_CSV/a.csv", text: "x".repeat(100), method: 8 },
		{ name: "XBRL_TO_CSV/b.csv", bytes: new Uint8Array([0xff, 0xfe]), method: 0 },
	]);

	it("lists names in directory order without inflating", () => {
		expect(expectOk(listZipEntries(archive))).toEqual(["XBRL_TO_CSV/a.csv", "XBRL_TO_CSV/b.csv"]);
		expect(expectErr(listZipEntries(new Uint8Array([1, 2, 3])))).toBe("NOT_A_ZIP");
	});

	it("applies the caller's ceilings to that read only", () => {
		expect(expectErr(listZipEntries(archive, { maxArchiveBytes: 10, maxEntryBytes: 1000 }))).toBe(
			"ARCHIVE_TOO_LARGE",
		);
		expect(
			expectErr(
				readZipEntries(archive, ["XBRL_TO_CSV/a.csv"], {
					maxArchiveBytes: 10_000,
					maxEntryBytes: 50,
				}),
			),
		).toBe("ENTRY_TOO_LARGE");
		expect(
			expectOk(readZipEntries(archive, ["XBRL_TO_CSV/a.csv"])).get("XBRL_TO_CSV/a.csv")?.length,
		).toBe(100);
	});
});
