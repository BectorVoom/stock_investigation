import { describe, expect, it } from "vitest";
import {
	foldAscii,
	matchingThemes,
	normalizeThemeQuery,
	THEME_QUERY_MAX_CHARS,
	themeMatches,
	themeNeedle,
} from "../../src/watchlist/themeSearch.ts";

describe("normalizeThemeQuery", () => {
	it("applies NFKC, collapses whitespace and trims", () => {
		expect(normalizeThemeQuery("  ＡＩ　 半導体\t")).toBe("AI 半導体");
		expect(normalizeThemeQuery("ｱﾅﾛｸﾞ")).toBe("アナログ");
	});

	it("removes control characters that are not whitespace", () => {
		expect(normalizeThemeQuery("Cloud\u0000 Software\u007f")).toBe("Cloud Software");
	});

	it("is null for a blank query or one longer than any theme name", () => {
		expect(normalizeThemeQuery(" \n ")).toBeNull();
		expect(normalizeThemeQuery("\u0001")).toBeNull();
		expect(normalizeThemeQuery("あ".repeat(THEME_QUERY_MAX_CHARS))).toBe(
			"あ".repeat(THEME_QUERY_MAX_CHARS),
		);
		expect(normalizeThemeQuery("あ".repeat(THEME_QUERY_MAX_CHARS + 1))).toBeNull();
	});
});

describe("foldAscii and themeNeedle", () => {
	it("folds ASCII letters only, as SQLite's lower does", () => {
		expect(foldAscii("Natural FOODS É Ａ")).toBe("natural foods É Ａ");
	});

	it("escapes the query as it appears inside a JSON string", () => {
		expect(themeNeedle('Free-range "Chicken"')).toBe('free-range \\"chicken\\"');
		expect(themeNeedle("a\\b")).toBe("a\\\\b");
		expect(themeNeedle("無農薬野菜")).toBe("無農薬野菜");
	});
});

describe("themeMatches", () => {
	const theme = { en: "Analog Semiconductors", ja: "アナログ半導体" };

	it("matches a substring of either name, ignoring ASCII case", () => {
		expect(themeMatches(theme, "analog")).toBe(true);
		expect(themeMatches(theme, "SEMICONDUCTOR")).toBe(true);
		expect(themeMatches(theme, "半導体")).toBe(true);
	});

	it("does not match across the two names or other words", () => {
		expect(themeMatches(theme, "Semiconductorsアナログ")).toBe(false);
		expect(themeMatches(theme, "memory")).toBe(false);
	});

	it("keeps the matching themes in stored order", () => {
		const themes = [
			{ en: "Organic Vegetables", ja: "無農薬野菜" },
			{ en: "Frozen Chicken", ja: "冷凍鶏加工食品" },
			{ en: "Vegetable Delivery", ja: "野菜宅配" },
		];
		expect(matchingThemes(themes, "野菜")).toEqual([themes[0], themes[2]]);
	});
});
