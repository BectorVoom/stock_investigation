import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { docTextChunks, isAllowedLinkTarget } from "../../src/notebook/richText/model.ts";
import { parseInline, parseRichText } from "../../src/notebook/richText/parser.ts";
import {
	serializeInline,
	serializeRichText,
	toggleTodoLine,
} from "../../src/notebook/richText/serializer.ts";

describe("rich-text link targets", () => {
	it("allows only http, https and mailto", () => {
		expect(isAllowedLinkTarget("https://example.com/x")).toBe(true);
		expect(isAllowedLinkTarget("http://example.org")).toBe(true);
		expect(isAllowedLinkTarget("mailto:owner@example.test")).toBe(true);
		expect(isAllowedLinkTarget("HTTPS://EXAMPLE.COM")).toBe(true);
		expect(isAllowedLinkTarget("javascript:alert(1)")).toBe(false);
		expect(isAllowedLinkTarget("data:text/plain,hi")).toBe(false);
		expect(isAllowedLinkTarget("https:")).toBe(false);
		expect(isAllowedLinkTarget("notaurl")).toBe(false);
		expect(isAllowedLinkTarget("https://exa mple.com")).toBe(false);
		expect(isAllowedLinkTarget("")).toBe(false);
	});
});

describe("rich-text block parser", () => {
	it("parses headings and keeps deeper hashes literal", () => {
		const doc = parseRichText("# Plan\n\n## Costs\n\n### Detail\n\n#### Not a heading");
		expect(doc.blocks.map((block) => block.kind)).toEqual([
			"heading",
			"heading",
			"heading",
			"paragraph",
		]);
		const first = doc.blocks[0];
		if (first?.kind !== "heading") throw new Error("no heading");
		expect(first.level).toBe(1);
		expect(serializeInline(first.inline)).toBe("Plan");
	});

	it("renders legacy plain text as before: blank line splits, one newline breaks", () => {
		const doc = parseRichText("First paragraph.\n\nSecond paragraph.");
		expect(doc.blocks).toHaveLength(2);
		expect(doc.blocks[0]?.kind).toBe("paragraph");
		const single = parseRichText("line one\nline two");
		expect(single.blocks).toHaveLength(1);
		const paragraph = single.blocks[0];
		if (paragraph?.kind !== "paragraph") throw new Error("no paragraph");
		expect(paragraph.lines).toHaveLength(2);
	});

	it("parses bullet, numbered and to-do lists, renumbering on serialize", () => {
		const doc = parseRichText("- a\n* b\n\n3. x\n1. y\n\n- [ ] open\n- [X] done");
		expect(doc.blocks.map((block) => block.kind)).toEqual(["bullet", "ordered", "todo"]);
		expect(serializeRichText(doc)).toBe("- a\n- b\n\n1. x\n2. y\n\n- [ ] open\n- [x] done");
	});

	it("parses quotes, code blocks (unclosed runs to the end) and dividers", () => {
		const doc = parseRichText(
			"> quoted\n> more\n\n```js\nconst x = 1;\n```\n\n---\n\n```\nunclosed",
		);
		expect(doc.blocks.map((block) => block.kind)).toEqual(["quote", "code", "divider", "code"]);
		const code = doc.blocks[1];
		if (code?.kind !== "code") throw new Error("no code block");
		expect(code.language).toBe("js");
		expect(code.code).toBe("const x = 1;");
		const tail = doc.blocks[3];
		if (tail?.kind !== "code") throw new Error("no trailing code block");
		expect(tail.code).toBe("unclosed");
	});

	it("keeps anything outside the subset as literal text", () => {
		const doc = parseRichText("| table | no |\n\n<img src=x>\n\n#nope\n\n****");
		expect(doc.blocks.map((block) => block.kind)).toEqual([
			"paragraph",
			"paragraph",
			"paragraph",
			"paragraph",
		]);
		expect(serializeRichText(doc)).toBe("| table | no |\n\n<img src=x>\n\n#nope\n\n****");
	});

	it("stores the source line of every list item for to-do toggles", () => {
		const doc = parseRichText("# Title\n\n- [ ] first\n- [x] second");
		const todos = doc.blocks[1];
		if (todos?.kind !== "todo") throw new Error("no todos");
		expect(todos.items.map((item) => item.line)).toEqual([2, 3]);
	});
});

describe("rich-text inline parser", () => {
	it("parses bold, italic, strike, code and links", () => {
		const nodes = parseInline("**b** and *i* and ~~s~~ and `c` and [L](https://example.com)");
		expect(nodes.map((node) => node.kind)).toEqual([
			"strong",
			"text",
			"em",
			"text",
			"strike",
			"text",
			"code",
			"text",
			"link",
		]);
		const link = nodes[nodes.length - 1];
		if (link?.kind !== "link") throw new Error("no link");
		expect(link.href).toBe("https://example.com");
	});

	it("leaves unclosed markers and unsafe links as literal text", () => {
		expect(serializeInline(parseInline("**open and *open"))).toBe("**open and *open");
		expect(serializeInline(parseInline("[x](javascript:evil())"))).toBe("[x](javascript:evil())");
		expect(serializeInline(parseInline("[x](notaurl)"))).toBe("[x](notaurl)");
		expect(serializeInline(parseInline("a `b c"))).toBe("a `b c");
	});

	it("nests formatting inside bold and link labels", () => {
		const nodes = parseInline("**bold *both* end** and [**label** text](https://example.com)");
		expect(serializeInline(nodes)).toBe(
			"**bold *both* end** and [**label** text](https://example.com)",
		);
	});
});

describe("toggleTodoLine", () => {
	it("flips one to-do line and leaves everything else alone", () => {
		expect(toggleTodoLine("# T\n\n- [ ] buy\n- [x] pack", 2)).toBe("# T\n\n- [x] buy\n- [x] pack");
		expect(toggleTodoLine("# T\n\n- [ ] buy\n- [X] pack", 3)).toBe("# T\n\n- [ ] buy\n- [ ] pack");
		expect(toggleTodoLine("- item", 0)).toBe("- item");
		expect(toggleTodoLine("- [ ] a", 9)).toBe("- [ ] a");
	});
});

describe("rich-text performance", () => {
	it("parses a pathological 8000-char input quickly and totally", () => {
		const inputs = [
			"*".repeat(8000),
			"**".repeat(4000),
			"[a](b)".repeat(1334).slice(0, 8000),
			"- [ ] ".repeat(1334).slice(0, 8000),
			"# ".concat("a *b* c **d** [e](https://example.com) ".repeat(200)).slice(0, 8000),
		];
		for (const input of inputs) {
			const started = performance.now();
			const doc = parseRichText(input);
			const roundTripped = serializeRichText(parseRichText(serializeRichText(doc)));
			expect(serializeRichText(doc)).toBe(roundTripped);
			expect(performance.now() - started).toBeLessThan(1000);
		}
	});
});

// ---------- Property tests ----------

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

describe("rich-text round trip properties", () => {
	it("serialize∘parse is a fixpoint", () => {
		fc.assert(
			fc.property(docArb(), (source) => {
				const once = serializeRichText(parseRichText(source));
				expect(serializeRichText(parseRichText(once))).toBe(once);
			}),
			{ numRuns: 250 },
		);
	});

	it("the serializer keeps every text chunk", () => {
		fc.assert(
			fc.property(docArb(), (source) => {
				const serialized = serializeRichText(parseRichText(source));
				for (const chunk of docTextChunks(parseRichText(source))) {
					expect(serialized).toContain(chunk);
				}
			}),
			{ numRuns: 250 },
		);
	});

	it("parsing is total over arbitrary strings", () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 500 }), (source) => {
				const doc = parseRichText(source);
				expect(Array.isArray(doc.blocks)).toBe(true);
				// And the fixpoint holds there too.
				const once = serializeRichText(doc);
				expect(serializeRichText(parseRichText(once))).toBe(once);
			}),
			{ numRuns: 250 },
		);
	});
});
