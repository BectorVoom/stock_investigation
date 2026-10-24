import { describe, expect, it } from "vitest";
import { catalogProblems, defineMessages, type MessagesOf } from "../src/index.ts";

describe("defineMessages", () => {
	it("keeps the tables as given", () => {
		const catalog = defineMessages({
			en: { save: "Save", count: (n: number) => (n === 1 ? "1 item" : `${n} items`) },
			ja: { save: "保存", count: (n) => `${n} 件` },
		});
		expect(catalog.ja.save).toBe("保存");
		expect(catalog.en.count(2)).toBe("2 items");
		expect(catalog.ja.count(2)).toBe("2 件");
		expect(catalogProblems(catalog)).toEqual([]);
		const describe = (n: number, text: MessagesOf<typeof catalog>) => text.count(n);
		expect(describe(4, catalog.ja)).toBe("4 件");
	});

	it("rejects a missing translation at compile time", () => {
		defineMessages({
			en: { save: "Save", cancel: "Cancel" },
			// @ts-expect-error -- `cancel` has no Japanese text
			ja: { save: "保存" },
		});
	});

	it("rejects a parameter of another type at compile time", () => {
		defineMessages({
			en: { count: (n: number) => `${n}` },
			// @ts-expect-error -- the English function takes a number
			ja: { count: (n: string) => n },
		});
	});
});

describe("catalogProblems", () => {
	it("reports what a cast could hide", () => {
		expect(
			catalogProblems({
				en: { a: "A", b: (n: number) => `${n}`, c: "C" },
				ja: { a: "", b: "B", d: "D" },
				fr: { a: "A" },
			}),
		).toEqual([
			"unsupported language fr",
			"ja.a is empty",
			"ja.d is not in en",
			"ja.b is a string, en a function",
			"ja.c is missing",
		]);
	});

	it("reports a function with another number of parameters", () => {
		expect(
			catalogProblems({
				en: { b: (n: number) => `${n}` },
				ja: { b: () => "" },
			}),
		).toEqual(["ja.b takes 0 parameters, en 1"]);
	});

	it("reports a missing language and a table that is not an object", () => {
		expect(catalogProblems({ en: { a: "A" } })).toEqual([
			"missing language ja",
			"ja is not a message table",
		]);
		expect(catalogProblems({ en: "x", ja: {} })).toEqual(["en is not a message table"]);
	});
});
