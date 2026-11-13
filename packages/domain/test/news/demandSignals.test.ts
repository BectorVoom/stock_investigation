import { describe, expect, it } from "vitest";
import { analyzeDemand, DEMAND_THEMES, matchesDemand } from "../../src/news/demandSignals.ts";

const cases = [
	["ai", "Data center orders surge", "データセンターの需要が拡大"],
	["semiconductors", "Semiconductor orders double", "半導体の需要増加"],
	["energy", "Growing demand for batteries", "蓄電池の需要が急増"],
	["mobility", "Electric vehicle sales increase", "物流の需要拡大"],
	["automation", "Robot orders rise", "ロボットの受注増加"],
	["security", "Cybersecurity spending grows", "防衛の需要増加"],
	["healthcare", "Growing demand for medical services", "医療の需要拡大"],
	["infrastructure", "Growing demand for water treatment", "水処理の需要増加"],
	["consumer", "Growing demand for travel", "観光の需要急増"],
	["finance", "Growing demand for payment services", "決済の需要増加"],
	["materials", "Growing demand for copper", "銅の需要増加"],
	["agriculture", "Growing demand for fertilizer", "肥料の需要増加"],
	["telecom", "Growing demand for broadband", "通信の需要増加"],
] as const;

describe("cross-theme demand investigation benchmark (synthetic, not live evidence)", () => {
	it.each(cases)("finds expanding demand in %s in English and Japanese", (theme, en, ja) => {
		for (const title of [en, ja]) {
			const candidate = analyzeDemand({ articleId: title, title, excerpt: null });
			expect(candidate.themes).toContain(theme);
			expect(matchesDemand(candidate, { theme, kind: "expanding", query: "" })).toBe(true);
		}
	});
	it("covers every catalog theme", () => {
		expect(cases.map(([theme]) => theme)).toEqual([...DEMAND_THEMES]);
	});
	it.each([
		["First commercial orders for AI cooling", "emerging"],
		["初受注：半導体製造装置", "emerging"],
		["New demand for eldercare services", "emerging"],
		["No growing demand for batteries", "uncertain"],
		["Growing demand for chips is expected next year", "uncertain"],
		["半導体の需要拡大を見込む", "uncertain"],
		["Declining demand for electric vehicles", "weakening"],
		["Declining demand for electric vehicles is expected", "uncertain"],
		["電池の需要が減少", "weakening"],
	] as const)("distinguishes %s", (title, kind) => {
		expect(
			analyzeDemand({ articleId: "test", title, excerpt: null }).passages.map((p) => p.kind),
		).toEqual([kind]);
	});
	it.each([
		"New market regulations for banks",
		"AI changes the world",
		"Oil prices fall",
		"Strong demand for tourism",
	])("does not turn contextual news into growth: %s", (title) => {
		expect(analyzeDemand({ articleId: "test", title, excerpt: null }).passages).toEqual([]);
	});
	it("retains mixed evidence and verbatim passages", () => {
		const candidate = analyzeDemand({
			articleId: "mixed",
			title: "Battery outlook",
			excerpt: "Growing demand for storage. Orders fall in Europe.",
		});
		expect(candidate.passages).toEqual([
			{ kind: "expanding", text: "Growing demand for storage." },
			{ kind: "weakening", text: "Orders fall in Europe." },
		]);
		expect(
			matchesDemand(candidate, { theme: "energy", kind: "weakening", query: " EUROPE " }),
		).toBe(true);
		expect(matchesDemand(candidate, { theme: "healthcare", kind: "weakening", query: "" })).toBe(
			false,
		);
	});
	it("finds uncatalogued products in All themes and normalizes fullwidth search", () => {
		const candidate = analyzeDemand({
			articleId: "x",
			title: "Growing demand for ＸＹＺ products",
			excerpt: null,
		});
		expect(candidate.themes).toEqual([]);
		expect(matchesDemand(candidate, { theme: "all", kind: "all", query: "xyz" })).toBe(true);
	});
});

it.each([
	["Data center electricity demand rose 12% year on year", "expanding"],
	["Orders for industrial robots grew 30%", "expanding"],
	["Semiconductor demand is increasing", "expanding"],
	["Battery adoption has doubled", "expanding"],
	["電力需要が前年比で30%増加", "expanding"],
	["半導体の受注は前年同期比で20%増加", "expanding"],
	["Demand for travel is expected to grow next year", "uncertain"],
	["Demand for chips is not growing", "uncertain"],
	["New market for food packaging, but no customer orders", "uncertain"],
	["No new demand for cooling services", "uncertain"],
] as const)("reads natural demand wording: %s", (title, kind) => {
	expect(
		analyzeDemand({ articleId: "natural", title, excerpt: null }).passages.map((p) => p.kind),
	).toEqual([kind]);
});
