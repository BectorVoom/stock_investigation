import { parseMarkdownTables, splitMarkdownPipeCells } from "@research/domain";
import { describe, expect, it } from "vitest";

describe("parseMarkdownTables", () => {
	it("parses GFM pipe tables with alignments, outer pipes and escaped pipes", () => {
		const input = [
			"日本の造船銘柄の比較は以下の通りです。",
			"",
			"| 銘柄 | 証券コード | 純利益率 | 備考 |",
			"| :--- | :---: | ---: | --- |",
			"| 名村造船所 | 7014 | 13.6% | A \\| B |",
			"| 内海造船 | 7018 | 4.9% |",
			"",
			"以上です。",
		].join("\n");

		const segments = parseMarkdownTables(input);
		expect(segments).toEqual([
			{ kind: "text", text: "日本の造船銘柄の比較は以下の通りです。" },
			{
				kind: "table",
				columns: ["銘柄", "証券コード", "純利益率", "備考"],
				alignments: ["left", "center", "right", null],
				rows: [
					["名村造船所", "7014", "13.6%", "A | B"],
					["内海造船", "7018", "4.9%", ""],
				],
				raw: [
					"| 銘柄 | 証券コード | 純利益率 | 備考 |",
					"| :--- | :---: | ---: | --- |",
					"| 名村造船所 | 7014 | 13.6% | A \\| B |",
					"| 内海造船 | 7018 | 4.9% |",
				].join("\n"),
			},
			{ kind: "text", text: "以上です。" },
		]);
	});

	it("keeps HTML markup and fenced code blocks as literal text", () => {
		const input = [
			"<script>alert(1)</script>",
			"```",
			"| A | B |",
			"| --- | --- |",
			"| 1 | 2 |",
			"```",
			"| Col | Value |",
			"| --- | --- |",
			"| <b>raw</b> | 42 |",
		].join("\n");

		const segments = parseMarkdownTables(input);
		expect(segments).toHaveLength(2);
		expect(segments[0]).toEqual({
			kind: "text",
			text: [
				"<script>alert(1)</script>",
				"```",
				"| A | B |",
				"| --- | --- |",
				"| 1 | 2 |",
				"```",
			].join("\n"),
		});
		expect(segments[1]?.kind).toBe("table");
		if (segments[1]?.kind === "table") {
			expect(segments[1].rows).toEqual([["<b>raw</b>", "42"]]);
		}
	});

	it("rejects mismatched delimiter column counts and tables without body rows", () => {
		const mismatched = "| A | B |\n| --- |\n| 1 | 2 |";
		expect(parseMarkdownTables(mismatched)).toEqual([{ kind: "text", text: mismatched }]);

		const headerOnly = "| A | B |\n| --- | --- |";
		expect(parseMarkdownTables(headerOnly)).toEqual([{ kind: "text", text: headerOnly }]);
	});

	it("splits pipe cells without outer pipes and rejects pipe-less lines", () => {
		expect(splitMarkdownPipeCells("plain sentence without pipes")).toBeNull();
		expect(splitMarkdownPipeCells("A | B | C")).toEqual(["A", "B", "C"]);
	});
});
