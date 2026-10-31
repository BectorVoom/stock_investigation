import { describe, expect, it } from "vitest";
import { equityFixture } from "../../../examples/equities/fixture.ts";
import {
	equityDecimalSchema,
	equityDocumentSchema,
	equityImportSchema,
	equityInstantSchema,
	materialsSourceUpdatedAtSchema,
} from "../src/equities.ts";

describe("equity import boundary", () => {
	it("keeps exact decimal text and rejects ambiguous or unbounded numbers", () => {
		for (const value of [
			"0",
			"-2",
			"9007199254740993.25",
			"0.000000000000000000000000000001",
			"9".repeat(100),
		])
			expect(equityDecimalSchema.safeParse(value).success).toBe(true);
		for (const value of [
			0,
			1.2,
			"-0",
			"1.0",
			"01",
			"+1",
			"1e6",
			"NaN",
			"Infinity",
			`0.${"0".repeat(30)}1`,
			"9".repeat(101),
		])
			expect(equityDecimalSchema.safeParse(value).success).toBe(false);
	});
	it("requires fixed-width real UTC instants and real calendar dates", () => {
		for (const value of [
			"2026-02-30T00:00:00.000Z",
			"2026-01-01",
			"2026-01-01T00:00:00Z",
			"2026-01-01T00:00:00.000+09:00",
		])
			expect(equityInstantSchema.safeParse(value).success).toBe(false);
	});
	it("bounds imports and requires explicit missing-value semantics", () => {
		expect(equityImportSchema.safeParse({ schemaVersion: 1, coverageNote: "empty" }).success).toBe(
			false,
		);
		expect(
			equityImportSchema.safeParse({
				...equityFixture,
				facts: equityFixture.facts.map((f) => ({ ...f, valueDecimal: null })),
			}).success,
		).toBe(false);
		expect(
			equityImportSchema.safeParse({
				...equityFixture,
				facts: equityFixture.facts.map((f) => ({
					...f,
					valueDecimal: null,
					unavailableReason: "NOT_REPORTED",
				})),
			}).success,
		).toBe(true);
	});
	it("rejects credentials and query-string secrets in stored document URLs", () => {
		for (const url of [
			"https://example.com/report?api_key=secret",
			"https://user:pass@example.com/report",
			"javascript:alert(1)",
		])
			expect(
				equityImportSchema.safeParse({
					...equityFixture,
					documents: equityFixture.documents.map((d) => ({ ...d, url })),
				}).success,
			).toBe(false);
	});
});

it("bounds source update timestamps to canonical UTC milliseconds", () => {
	expect(materialsSourceUpdatedAtSchema.parse("2026-10-29T09:30:45.123Z")).toBe(
		"2026-10-29T09:30:45.123Z",
	);
	for (const value of [
		"2026-02-30T09:30:45.000Z",
		"2026-10-29",
		"2026-10-29T09:30:45Z",
		"2026-10-29T09:30:45.000+09:00",
		"2026-10-29T24:00:00.000Z",
		"x".repeat(10000),
	]) {
		expect(materialsSourceUpdatedAtSchema.safeParse(value).success).toBe(false);
	}
});

it("normalizes absent source timestamps without changing legacy record serialization", () => {
	const document = equityFixture.documents[0];
	if (document === undefined) throw new Error("fixture needs a document");
	expect(JSON.stringify(equityDocumentSchema.parse(document))).toBe(
		JSON.stringify(equityDocumentSchema.parse({ ...document, materialsSourceUpdatedAt: null })),
	);
	expect(
		equityDocumentSchema.safeParse({
			...document,
			materialsSourceUpdatedAt: "9999-01-01T00:00:00.000Z",
		}).success,
	).toBe(false);
});
