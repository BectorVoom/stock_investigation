import { describe, expect, it } from "vitest";
import {
	citedSourceIds,
	companyOverviewDraftSchema,
	companyOverviewEntrySchema,
	companyOverviewViewSchema,
} from "../src/index.ts";

/** The company overview's contract (事業概要, ADR-0064). */

const statement = (source: string, ja = "総合飲料会社。") => ({
	en: "Total beverage company.",
	ja,
	evidence: [{ source, quote: "total beverage company" }],
});

const draft = {
	feature: statement("S2"),
	businesses: [statement("S2")],
	segments: [],
	overseasSales: null,
	profile: [],
	themes: [{ label: { en: "Beverages", ja: "飲料" }, reason: statement("S2") }],
};

const reference = (id: string) => ({
	id,
	title: { en: `Source ${id}`, ja: `出典 ${id}` },
	publisher: "U.S. SEC",
	asOf: null,
	url: "https://www.sec.gov/",
	note: null,
});

const view = {
	entry: draft,
	facts: {
		listing: "nyse",
		sector: null,
		fiscalYearEnd: "12-31",
		figures: [],
		cites: { listing: "S1", sector: null, figures: null },
	},
	references: [reference("S1"), reference("S2")],
	agentId: "claude-api",
	model: "claude-haiku-5-5",
	generatedAt: "2026-11-03T00:00:00.000Z",
};

describe("company overview contract (ADR-0064)", () => {
	it("needs every model field in a draft, but lets a stored entry drop failed ones", () => {
		expect(companyOverviewDraftSchema.safeParse(draft).success).toBe(true);
		const dropped = { ...draft, feature: null, businesses: [], themes: [] };
		expect(companyOverviewDraftSchema.safeParse(dropped).success).toBe(false);
		expect(companyOverviewEntrySchema.safeParse(dropped).success).toBe(true);
	});

	it("keeps 【特色】 to one handbook line and quotes within bounds", () => {
		const long = { ...draft, feature: statement("S2", "あ".repeat(71)) };
		expect(companyOverviewDraftSchema.safeParse(long).success).toBe(false);
		const shortQuote = {
			...draft,
			feature: { ...statement("S2"), evidence: [{ source: "S2", quote: "short" }] },
		};
		expect(companyOverviewDraftSchema.safeParse(shortQuote).success).toBe(false);
	});

	it("collects every cited source, the server-filled ones included", () => {
		expect([...citedSourceIds(view.entry, view.facts)].sort()).toEqual(["S1", "S2"]);
	});

	it("refuses a view whose citations are not all in its references, or with duplicate ids", () => {
		expect(companyOverviewViewSchema.safeParse(view).success).toBe(true);
		expect(
			companyOverviewViewSchema.safeParse({ ...view, references: [reference("S1")] }).success,
		).toBe(false);
		expect(
			companyOverviewViewSchema.safeParse({
				...view,
				references: [reference("S1"), reference("S2"), reference("S2")],
			}).success,
		).toBe(false);
	});

	it("reads a segment stored before segments had an activity as having none", () => {
		const segment = {
			name: { en: "North America", ja: "北米" },
			salesSharePercent: null,
			marginPercent: null,
			evidence: [{ source: "S2", quote: "North America operating segment" }],
		};
		const parsed = companyOverviewEntrySchema.parse({ ...draft, segments: [segment] });
		expect(parsed.segments[0]?.activity).toBeNull();
	});

	it("lets a draft have no businesses and no themes when the sources describe none", () => {
		expect(
			companyOverviewDraftSchema.safeParse({ ...draft, businesses: [], themes: [] }).success,
		).toBe(true);
	});

	it("accepts only https reference links", () => {
		const insecure = {
			...view,
			references: [reference("S1"), { ...reference("S2"), url: "http://x.example/" }],
		};
		expect(companyOverviewViewSchema.safeParse(insecure).success).toBe(false);
	});
});
