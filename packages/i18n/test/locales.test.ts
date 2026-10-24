import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, isLocale, LOCALE_NAMES, LOCALES, negotiateLocale } from "../src/index.ts";

describe("negotiateLocale", () => {
	it("takes the first supported language in preference order", () => {
		expect(negotiateLocale(["fr-FR", "ja-JP", "en-US"])).toBe("ja");
		expect(negotiateLocale(["en-GB", "ja"])).toBe("en");
	});

	it("matches the primary subtag without regard to case or separator", () => {
		expect(negotiateLocale(["JA"])).toBe("ja");
		expect(negotiateLocale(["ja_JP"])).toBe("ja");
		expect(negotiateLocale([" ja-Jpan-JP "])).toBe("ja");
	});

	it("falls back to the default language", () => {
		expect(negotiateLocale([])).toBe(DEFAULT_LOCALE);
		expect(negotiateLocale(["de-DE", "", "zh-Hans"])).toBe(DEFAULT_LOCALE);
	});
});

describe("locales", () => {
	it("names every language in itself", () => {
		expect(Object.keys(LOCALE_NAMES).sort()).toEqual([...LOCALES].sort());
		expect(LOCALE_NAMES.ja).toBe("日本語");
	});

	it("recognises only supported codes", () => {
		expect(isLocale("ja")).toBe(true);
		expect(isLocale("ja-JP")).toBe(false);
		expect(isLocale(null)).toBe(false);
	});
});
