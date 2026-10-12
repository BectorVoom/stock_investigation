import { describe, expect, it } from "vitest";
import {
	classifyReportedPositionChange,
	describeReportedPositionChange,
	type ReportedPositionChange,
	type ReportedPositionContext,
} from "../../src/finance/filings.ts";

describe("classifyReportedPositionChange (FR-008 / DATA-007)", () => {
	it.each<[number | null, number | null, ReportedPositionChange]>([
		[null, 1000, "newly-reported-holding"],
		[0, 1000, "newly-reported-holding"],
		[1000, 1500, "increase-in-reported-position"],
		[1000, 1001, "increase-in-reported-position"],
		[1500, 1000, "decrease-in-reported-position"],
		[1000, 1000, "unchanged-reported-position"],
		[1000, null, "no-longer-reported"],
		[1000, 0, "no-longer-reported"],
		[null, null, "not-reported"],
		[0, 0, "not-reported"],
		[null, 0, "not-reported"],
	])("previous %s -> current %s is %s", (previous, current, expected) => {
		expect(classifyReportedPositionChange(previous, current)).toBe(expected);
	});

	it("treats a negative share count as an absent position rather than a holding", () => {
		expect(classifyReportedPositionChange(-5, 100)).toBe("newly-reported-holding");
		expect(classifyReportedPositionChange(100, -5)).toBe("no-longer-reported");
		expect(classifyReportedPositionChange(-5, -5)).toBe("not-reported");
	});
});

describe("describeReportedPositionChange", () => {
	const context: ReportedPositionContext = {
		investorName: "Example Capital LP",
		issuerName: "Example Semiconductor Inc",
		reportPeriodEnd: "2026-06-30",
		filedAt: "2026-08-14",
		form: "13F-HR",
	};

	const changes: readonly ReportedPositionChange[] = [
		"newly-reported-holding",
		"increase-in-reported-position",
		"decrease-in-reported-position",
		"no-longer-reported",
		"unchanged-reported-position",
		"not-reported",
	];

	it("says 'newly reported holding' for a first appearance, with period and filing date", () => {
		expect(describeReportedPositionChange("newly-reported-holding", context)).toBe(
			"Example Capital LP: newly reported holding in Example Semiconductor Inc as of 2026-06-30 (13F-HR filed 2026-08-14; quarter-end holdings, not a dated transaction).",
		);
	});

	it("says 'increase in reported position' rather than describing a purchase", () => {
		expect(describeReportedPositionChange("increase-in-reported-position", context)).toContain(
			"increase in reported position",
		);
	});

	it.each(changes)("never words '%s' as a verified, dated trade", (change) => {
		const sentence = describeReportedPositionChange(change, context);
		expect(sentence).not.toMatch(/\b(bought|buys|purchased?|acquired|sold|sells|sale|traded)\b/i);
		expect(sentence).toContain("quarter-end holdings, not a dated transaction");
		expect(sentence).toContain("as of 2026-06-30");
		expect(sentence).toContain("filed 2026-08-14");
		expect(sentence).toContain("13F-HR");
	});

	it("gives each classification distinct wording", () => {
		const sentences = changes.map((change) => describeReportedPositionChange(change, context));
		expect(new Set(sentences).size).toBe(changes.length);
	});
});
