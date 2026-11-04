import { describe, expect, it } from "vitest";
import {
	asSentence,
	fiscalMonthText,
	localDayOf,
	sourceIdsOf,
} from "../src/stocks/companyOverviewModel.ts";

describe("company overview helpers (ADR-0064)", () => {
	it("names the fiscal year end's month in the UI language", () => {
		expect(fiscalMonthText("09-26", "en")).toBe("September");
		expect(fiscalMonthText("03-31", "ja")).toBe("3月");
		expect(fiscalMonthText("13-01", "en")).toBeNull();
	});

	it("dates an instant by this browser's day", () => {
		const instant = "2026-11-02T23:30:39.229Z";
		expect(localDayOf(instant)).toBe(new Date(instant).toLocaleDateString("sv-SE"));
		expect(localDayOf(instant)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("lists a field's sources once each, in id order", () => {
		expect(
			sourceIdsOf([
				{ source: "S2", quote: "quoted words" },
				{ source: "S1", quote: "other words" },
				{ source: "S2", quote: "more words" },
			]),
		).toEqual(["S1", "S2"]);
	});

	it("closes a 事業内容 statement as a sentence of the summary paragraph", () => {
		expect(asSentence("炭酸飲料。Coca-Cola、Sprite、Fanta", "ja")).toBe(
			"炭酸飲料。Coca-Cola、Sprite、Fanta。",
		);
		expect(asSentence("繊維関連製品を製造・販売。", "ja")).toBe("繊維関連製品を製造・販売。");
		expect(asSentence("Sparkling soft drinks", "en")).toBe("Sparkling soft drinks.");
		expect(asSentence(" Sells concentrate. ", "en")).toBe("Sells concentrate.");
	});
});
