import { describe, expect, it } from "vitest";
import { demandDiscoveryQuery, demandDiscoveryUrl } from "../../src/news/demandDiscovery.ts";
import { analyzeDemand, DEMAND_THEMES, matchesDemand } from "../../src/news/demandSignals.ts";

describe("retrieval rather than exact-phrase coverage", () => {
	it.each(DEMAND_THEMES)("has a bounded public-news query for %s in both languages", (theme) => {
		for (const language of ["en", "ja"] as const) {
			const url = new URL(demandDiscoveryUrl(theme, language, ""));
			expect(url.hostname).toBe("news.google.com");
			expect(url.pathname).toBe("/search");
			expect(url.searchParams.get("q")).toContain("when:30d");
			expect(url.searchParams.get("q")).toBe(demandDiscoveryQuery(theme, language, ""));
			expect(url.searchParams.get("ceid")).toBe(language === "ja" ? "JP:ja" : "US:en");
		}
	});
	it("keeps product text from injecting provider operators", () => {
		const query = demandDiscoveryQuery("energy", "en", 'batteries" OR site:example.com');
		expect(query).not.toContain("site:");
		expect(query).toContain('"batteries OR site example com"');
	});
	it("makes topical news discoverable without pretending it is confirmed demand", () => {
		const candidate = analyzeDemand({
			articleId: "realistic",
			title: "Renishaw Q1 revenue jumps 47% on semiconductor demand",
			excerpt: null,
		});
		expect(candidate.passages).toHaveLength(0);
		expect(matchesDemand(candidate, { theme: "semiconductors", kind: "coverage", query: "" })).toBe(
			true,
		);
		expect(
			matchesDemand(candidate, { theme: "semiconductors", kind: "expanding", query: "" }),
		).toBe(false);
		expect(matchesDemand(candidate, { theme: "agriculture", kind: "coverage", query: "" })).toBe(
			false,
		);
	});
});
