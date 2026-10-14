import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { modelToPm, pmToModel } from "../../src/notebook/richText/docConvert.ts";
import type { RichTextDoc } from "../../src/notebook/richText/model.ts";
import { parseRichText } from "../../src/notebook/richText/parser.ts";
import { serializeRichText } from "../../src/notebook/richText/serializer.ts";

/** Model → ProseMirror → model → Markdown equals the canonical serialization. */
function roundTrip(source: string): string {
	return serializeRichText(pmToModel(modelToPm(parseRichText(source))));
}

describe("rich-text ProseMirror conversion", () => {
	it("round-trips every block kind", () => {
		const source = [
			"# Plan",
			"",
			"Pack **light** and *far* with ~~old~~ `code` and [docs](https://example.com).",
			"",
			"## Costs",
			"",
			"- one",
			"- two",
			"",
			"1. first",
			"2. second",
			"",
			"- [ ] open",
			"- [x] done",
			"",
			"> quoted",
			"> more",
			"",
			"```js",
			"const x = 1;",
			"```",
			"",
			"---",
			"",
			"legacy line one",
			"legacy line two",
		].join("\n");
		expect(roundTrip(source)).toBe(serializeRichText(parseRichText(source)));
		expect(roundTrip(source)).toContain("- [x] done");
		expect(roundTrip(source)).toContain("```js");
	});

	it("keeps to-do state, code language and link targets", () => {
		const doc = pmToModel(
			modelToPm(parseRichText("- [ ] a\n- [x] b\n\n```ts\nx()\n```\n\n[y](mailto:z@t.test)")),
		);
		const todos = doc.blocks[0];
		if (todos?.kind !== "todo") throw new Error("no todos");
		expect(todos.items.map((item) => item.checked)).toEqual([false, true]);
		const code = doc.blocks[1];
		if (code?.kind !== "code") throw new Error("no code");
		expect(code.language).toBe("ts");
		expect(code.code).toBe("x()");
		const link = doc.blocks[2];
		if (link?.kind !== "paragraph") throw new Error("no paragraph");
		expect(link.lines[0]?.[0]).toEqual({
			kind: "link",
			label: [{ kind: "text", text: "y" }],
			href: "mailto:z@t.test",
		});
	});

	it("drops unsafe link targets but keeps their labels", () => {
		const pm = modelToPm(parseRichText("[x](javascript:evil())"));
		const back = pmToModel(pm);
		expect(serializeRichText(back)).toBe("[x](javascript:evil())");
		const paragraph = back.blocks[0];
		if (paragraph?.kind !== "paragraph") throw new Error("no paragraph");
		expect(paragraph.lines[0]?.[0]).toEqual({ kind: "text", text: "[x](javascript:evil())" });
	});

	it("maps an empty document to one empty paragraph and back", () => {
		const pm = modelToPm(parseRichText(""));
		expect(pm.childCount).toBe(1);
		expect(pm.firstChild?.type.name).toBe("paragraph");
		expect(pmToModel(pm)).toEqual({ blocks: [] });
	});

	it("nests bold, italic and code deterministically", () => {
		const source = "**bold *both* end** and `code` and [**label** text](https://example.com)";
		expect(roundTrip(source)).toBe(source);
	});

	it("renumbers ordered lists through the conversion", () => {
		expect(roundTrip("3. x\n1. y")).toBe("1. x\n2. y");
	});
});

const leafText = () =>
	fc.string({
		minLength: 1,
		maxLength: 12,
		unit: fc.constantFrom(..."abcdefxyz019 ,.".split("")),
	});

function inlineArb(depth: number): fc.Arbitrary<string> {
	const leaf = leafText();
	if (depth <= 0) return leaf;
	const inner = inlineArb(depth - 1);
	const url = fc.constantFrom(
		"https://example.com",
		"https://example.com/a/b?c=d",
		"http://example.org",
		"mailto:owner@example.test",
	);
	return fc.oneof(
		{ weight: 3, arbitrary: leaf },
		{ weight: 1, arbitrary: inner.map((s) => `**${s}**`) },
		{ weight: 1, arbitrary: inner.map((s) => `*${s}*`) },
		{ weight: 1, arbitrary: inner.map((s) => `~~${s}~~`) },
		{ weight: 1, arbitrary: leaf.map((s) => `\`${s}\``) },
		{
			weight: 1,
			arbitrary: fc.tuple(inner, url).map(([label, target]) => `[${label}](${target})`),
		},
	);
}

function blockArb(): fc.Arbitrary<string> {
	const inline = inlineArb(2);
	const line = inlineArb(1);
	return fc.oneof(
		{
			weight: 3,
			arbitrary: fc.array(line, { minLength: 1, maxLength: 3 }).map((ls) => ls.join("\n")),
		},
		{
			weight: 1,
			arbitrary: fc
				.tuple(fc.integer({ min: 1, max: 3 }), inline)
				.map(([level, text]) => `${"#".repeat(level)} ${text}`),
		},
		{
			weight: 1,
			arbitrary: fc
				.array(line, { minLength: 1, maxLength: 4 })
				.map((ls) => ls.map((l) => `- ${l}`).join("\n")),
		},
		{
			weight: 1,
			arbitrary: fc
				.array(line, { minLength: 1, maxLength: 4 })
				.map((ls) => ls.map((l, i) => `${i + 1}. ${l}`).join("\n")),
		},
		{
			weight: 1,
			arbitrary: fc
				.array(fc.tuple(fc.boolean(), line), { minLength: 1, maxLength: 4 })
				.map((ls) => ls.map(([checked, l]) => `- [${checked ? "x" : " "}] ${l}`).join("\n")),
		},
		{
			weight: 1,
			arbitrary: fc
				.array(line, { minLength: 1, maxLength: 3 })
				.map((ls) => ls.map((l) => `> ${l}`).join("\n")),
		},
		{
			weight: 1,
			arbitrary: fc
				.array(leafText(), { minLength: 1, maxLength: 3 })
				.map((ls) => `\`\`\`\n${ls.join("\n")}\n\`\`\``),
		},
		{ weight: 1, arbitrary: fc.constant("---") },
	);
}

const docArb = () =>
	fc.array(blockArb(), { minLength: 1, maxLength: 5 }).map((bs) => bs.join("\n\n"));

describe("rich-text ProseMirror round trip properties", () => {
	it("doc-from-model then model-from-doc then serialize equals the canonical form", () => {
		fc.assert(
			fc.property(docArb(), (source) => {
				const canonical = serializeRichText(parseRichText(source));
				expect(roundTrip(source)).toBe(canonical);
			}),
			{ numRuns: 250 },
		);
	});

	it("holds for arbitrary strings too", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (source) => {
				const canonical = serializeRichText(parseRichText(source));
				expect(roundTrip(source)).toBe(canonical);
			}),
			{ numRuns: 250 },
		);
	});

	it("every text chunk survives the document round trip", () => {
		fc.assert(
			fc.property(docArb(), (source) => {
				const doc: RichTextDoc = pmToModel(modelToPm(parseRichText(source)));
				expect(serializeRichText(doc)).toBe(serializeRichText(parseRichText(source)));
			}),
			{ numRuns: 100 },
		);
	});
});
