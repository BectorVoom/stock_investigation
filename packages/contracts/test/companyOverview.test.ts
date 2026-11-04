import { describe, expect, it } from "vitest";
import {
	citedSourceIds,
	companyOverviewDraftSchema,
	companyOverviewEntrySchema,
	companyOverviewViewSchema,
	isBareSegment,
	overseasSalesFromDraft,
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

describe("bare segments (ADR-0064)", () => {
	const segment = {
		name: { en: "Americas", ja: "米州" },
		activity: null,
		salesSharePercent: null,
		marginPercent: null,
		evidence: [{ source: "S5", quote: "Our operating structure includes the following segments:" }],
	};

	it("finds a segment that is only its name, whatever its quote", () => {
		expect(isBareSegment(segment)).toBe(true);
		expect(isBareSegment({ ...segment, evidence: [{ source: "S5", quote: "### 米州" }] })).toBe(
			true,
		);
	});

	it("keeps a segment with an activity, a stated share or a stated margin", () => {
		expect(isBareSegment({ ...segment, activity: { en: "Seats.", ja: "シートを製造。" } })).toBe(
			false,
		);
		expect(isBareSegment({ ...segment, salesSharePercent: 32 })).toBe(false);
		expect(isBareSegment({ ...segment, marginPercent: 4 })).toBe(false);
	});
});

describe("【海外】 countries and shares (ADR-0064 §5f)", () => {
	const evidence = [{ source: "S4", quote: "所在地別売上高 日本 42,000" }];
	const region = (ja: string, percent: number | null, amount: number | null) => ({
		name: { en: ja, ja },
		percent,
		amount,
	});

	it("computes each region's share from its amount and the table's total, largest first", () => {
		expect(
			overseasSalesFromDraft({
				percent: null,
				totalAmount: 300,
				homeAmount: 100,
				regions: [region("欧州", null, 50), region("米国", null, 150), region("中国", 12.5, null)],
				evidence,
			}),
		).toEqual({
			percent: 66.7,
			regions: [
				{ name: { en: "米国", ja: "米国" }, percent: 50 },
				{ name: { en: "欧州", ja: "欧州" }, percent: 16.7 },
				{ name: { en: "中国", ja: "中国" }, percent: 12.5 },
			],
			evidence,
		});
	});

	it("keeps a stated overseas share and drops a region with no share and no total", () => {
		expect(
			overseasSalesFromDraft({
				percent: 42,
				totalAmount: null,
				homeAmount: null,
				regions: [region("米国", null, 150)],
				evidence,
			}),
		).toEqual({ percent: 42, regions: [], evidence });
		expect(
			overseasSalesFromDraft({
				percent: null,
				totalAmount: 0,
				homeAmount: null,
				regions: [region("米国", null, 150)],
				evidence,
			}),
		).toBeNull();
	});

	it("reads an entry stored before regions existed, and refuses one with neither part", () => {
		const stored = { ...draft, overseasSales: { percent: 29, evidence } };
		expect(companyOverviewEntrySchema.parse(stored).overseasSales).toEqual({
			percent: 29,
			regions: [],
			evidence,
		});
		const empty = { ...draft, overseasSales: { percent: null, regions: [], evidence } };
		expect(companyOverviewEntrySchema.safeParse(empty).success).toBe(false);
	});
});
