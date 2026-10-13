import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_ROOTS = ["apps/web/src", "packages/ui-registry/src"] as const;
const SOURCE_FILE = /\.(ts|tsx)$/;

/** Guideline section 2: the only colour families in UI source. */
const ALLOWED_COLOUR_FAMILIES = ["slate", "blue", "red", "amber", "emerald"] as const;
/**
 * Guideline section 2: white and black exist only as bare utilities for
 * surfaces and inverse text (`bg-white`, `text-white`); never with a shade.
 */
const ALLOWED_BARE_COLOURS = ["white", "black"] as const;
/** Guideline section 4: the one corner radius, plus `rounded-full` for pill badges. */
const ALLOWED_RADII = ["rounded", "rounded-full"] as const;
/**
 * Guideline section 12: the chat surface additionally uses the large radius
 * for bubbles, the input container and suggestion chips — in
 * `apps/web/src/chat/` only, nowhere else.
 */
const CHAT_EXTRA_RADII = ["rounded-2xl"] as const;
const CHAT_PREFIX = "apps/web/src/chat/";
/**
 * Guideline section 2: secondary text is never lighter than slate-600.
 * (Measured: slate-400 on white is 2.6:1, slate-300 is 1.5:1; 50/100/200 are
 * lighter still.)
 */
const FORBIDDEN_LIGHT_TEXT = ["50", "100", "200", "300", "400", "500"] as const;
/** Guideline section 7: `h1` is the app name and lives only here. */
const H1_ALLOWED_FILES = ["apps/web/src/App.tsx"] as const;
/** Guideline section 7: `h2` is the page title and lives only in `PageHeader`. */
const H2_ALLOWED_FILES = ["apps/web/src/components/ui.tsx"] as const;
/**
 * Guideline section 7: registry renderers were reviewed and use only
 * component-scoped `h3`/`h4`, so no file needs an `h2` exception today. Any
 * future `h2` in the registry must add a commented entry here.
 */
const H2_ALLOWLIST: readonly string[] = [];
/** Guideline section 10: the chart palette is the only hex colour in UI source. */
const HEX_ALLOWED_FILES = ["packages/ui-registry/src/charts/chartMath.ts"] as const;

const COLOUR_PREFIX =
	"(?:bg|text|border|ring|decoration|divide|outline|stroke|fill|placeholder|accent|caret)";
const SHADED_COLOUR = new RegExp(`\\b${COLOUR_PREFIX}-([a-z]+)-(\\d+)\\b`, "g");
const BARE_SPECIAL_COLOUR = new RegExp(
	`\\b${COLOUR_PREFIX}-(white|black|transparent|current|inherit)\\b`,
	"g",
);
/**
 * Guideline section 3: arbitrary sizes (`text-[…]`) are not allowed. `text-[…]`
 * is shared with arbitrary text colours, so the checker classifies each token
 * below: a bracket value starting with a digit (or `length:`) is a size, every
 * other bracket value on a `text-` token is a colour.
 */
const TEXT_ARBITRARY = /\btext-\[([^\]]+)\]/g;
/**
 * Guideline section 2: arbitrary colours (`bg-[…]`, `text-[rgb(…)]`, …) are not
 * allowed — every bracket syntax, not only hex. Non-text colour prefixes take
 * no size, so any bracket value on them is a colour.
 */
const OTHER_ARBITRARY_COLOUR =
	/\b(?:bg|border|ring|decoration|divide|outline|stroke|fill|placeholder|accent|caret)-\[[^\]]+\]/g;
/** Guideline section 10: hex literals live only in the chart palette file. */
const HEX_LITERAL = /#[0-9a-fA-F]{3,8}\b/g;
/** Guideline section 4: no inline `style=` attribute anywhere in UI source. */
const INLINE_STYLE = /\bstyle\s*=/g;
/**
 * Guideline section 4: the radius token after `rounded`, if any — matched as a
 * complete token including arbitrary values, so `rounded-[12px]` is one token
 * (prohibited) rather than a bare `rounded` (allowed) followed by brackets.
 * The token ends where a word character, `[` or `-` no longer continues it
 * (a trailing `\b` cannot match after `]`, e.g. before a closing quote).
 */
const RADIUS = /\brounded(?:-(?:[a-z0-9]+|\[[^\]]+\]))?(?![\w[-])/g;
/** Guideline section 2: secondary text lighter than slate-600. */
const LIGHT_SECONDARY_TEXT = /\btext-slate-(50|100|200|300|400|500)\b/g;
/** Guideline section 7. */
const H1 = /<h1[\s>]/g;
const H2 = /<h2[\s>]/g;

interface Violation {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
	readonly token: string;
}

function violation(file: string, line: number, rule: string, token: string): Violation {
	return { file, line, rule, token };
}

/** Membership in an `as const` allowlist without loosening its element type. */
function allows(list: readonly string[], value: string): boolean {
	return list.some((entry) => entry === value);
}

/**
 * Checks one source file. Pure over (file, text) so the self-test below can
 * feed it synthetic strings; a checker that can never fail proves nothing.
 */
function checkSourceFile(file: string, text: string): Violation[] {
	const violations: Violation[] = [];
	const lines = text.split("\n");
	for (const [index, line] of lines.entries()) {
		const lineNumber = index + 1;
		const content = line ?? "";
		for (const match of content.matchAll(SHADED_COLOUR)) {
			const family = match[1] ?? "";
			// Single-letter "families" are border directions (`border-l-2`), not colours.
			if (family.length > 1 && !allows(ALLOWED_COLOUR_FAMILIES, family)) {
				violations.push(violation(file, lineNumber, "colour-family", match[0] ?? ""));
			}
		}
		for (const match of content.matchAll(BARE_SPECIAL_COLOUR)) {
			const colour = match[1] ?? "";
			if (!allows(ALLOWED_BARE_COLOURS, colour)) {
				violations.push(violation(file, lineNumber, "colour-family", match[0] ?? ""));
			}
		}
		for (const match of content.matchAll(TEXT_ARBITRARY)) {
			const inner = (match[1] ?? "").trim();
			// WHY the split: `text-[…]` is either an arbitrary size or an
			// arbitrary colour. Sizes start with a digit (`13px`, `1rem`) or
			// the `length:` prefix; every other bracket value is a colour
			// (`rgb(…)`, `#…`, `red`, `var(…)`). Either way it is prohibited;
			// only the rule name differs.
			if (inner.startsWith("length:") || /^[0-9.]/.test(inner)) {
				violations.push(violation(file, lineNumber, "arbitrary-font-size", match[0] ?? ""));
			} else {
				violations.push(violation(file, lineNumber, "arbitrary-colour", match[0] ?? ""));
			}
		}
		for (const match of content.matchAll(OTHER_ARBITRARY_COLOUR)) {
			violations.push(violation(file, lineNumber, "arbitrary-colour", match[0] ?? ""));
		}
		if (!allows(HEX_ALLOWED_FILES, file)) {
			for (const match of content.matchAll(HEX_LITERAL)) {
				violations.push(violation(file, lineNumber, "hex-colour", match[0] ?? ""));
			}
		}
		for (const match of content.matchAll(INLINE_STYLE)) {
			violations.push(violation(file, lineNumber, "inline-style", match[0] ?? ""));
		}
		for (const match of content.matchAll(RADIUS)) {
			const token = match[0] ?? "";
			if (allows(ALLOWED_RADII, token)) continue;
			if (file.startsWith(CHAT_PREFIX) && allows(CHAT_EXTRA_RADII, token)) continue;
			violations.push(violation(file, lineNumber, "corner-radius", token));
		}
		for (const match of content.matchAll(LIGHT_SECONDARY_TEXT)) {
			violations.push(violation(file, lineNumber, "secondary-text", match[0] ?? ""));
		}
		if (!allows(H1_ALLOWED_FILES, file)) {
			for (const match of content.matchAll(H1)) {
				violations.push(violation(file, lineNumber, "heading-level", match[0] ?? ""));
			}
		}
		if (!allows(H2_ALLOWED_FILES, file) && !allows(H2_ALLOWLIST, file)) {
			for (const match of content.matchAll(H2)) {
				violations.push(violation(file, lineNumber, "heading-level", match[0] ?? ""));
			}
		}
	}
	return violations;
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/** Every `.ts`/`.tsx` file below `directory`; an absent directory has none. */
function collectSourceFiles(directory: string): readonly string[] {
	if (!existsSync(directory)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "node_modules" && entry.name !== "dist") {
				files.push(...collectSourceFiles(path));
			}
		} else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
			files.push(path);
		}
	}
	return files.sort();
}

function formatViolations(violations: readonly Violation[]): string {
	return violations
		.map((entry) => `${entry.file}:${entry.line} [${entry.rule}] ${entry.token}`)
		.join("\n");
}

describe("design guideline conformance of the UI source", () => {
	const files = SCAN_ROOTS.flatMap((root) => collectSourceFiles(join(REPO_ROOT, root)));

	it("scans both UI roots, so the check is not vacuous", () => {
		expect(files.length).toBeGreaterThan(20);
		expect(files.some((file) => file.endsWith("components/ui.tsx"))).toBe(true);
		expect(files.some((file) => file.endsWith("charts/chartMath.ts"))).toBe(true);
	});

	it("has no guideline violation in any scanned file", () => {
		const violations = files.flatMap((absolutePath) =>
			checkSourceFile(
				toPosix(relative(REPO_ROOT, absolutePath)),
				readFileSync(absolutePath, "utf8"),
			),
		);
		expect(formatViolations(violations)).toBe("");
	});
});

describe("self-test: the checker reports each rule", () => {
	const FAKE = "apps/web/src/Fake.tsx";

	function rulesFor(file: string, text: string): readonly string[] {
		return checkSourceFile(file, text).map((entry) => entry.rule);
	}

	it("flags a non-guideline colour family, but not the five families or white surfaces", () => {
		expect(rulesFor(FAKE, '<div class="bg-gray-100 text-green-800">x</div>')).toEqual([
			"colour-family",
			"colour-family",
		]);
		expect(
			rulesFor(
				FAKE,
				'<div class="bg-slate-100 text-slate-900 border-blue-600 bg-red-50 text-amber-900 bg-emerald-50">x</div>',
			),
		).toEqual([]);
		expect(rulesFor(FAKE, '<div class="bg-white text-white">x</div>')).toEqual([]);
		expect(rulesFor(FAKE, '<div class="border-l-2 border-slate-300 pl-2">x</div>')).toEqual([]);
		expect(rulesFor(FAKE, '<div class="bg-transparent">x</div>')).toEqual(["colour-family"]);
	});

	it("flags arbitrary font sizes and arbitrary colours", () => {
		expect(rulesFor(FAKE, '<p class="text-[13px]">x</p>')).toEqual(["arbitrary-font-size"]);
		expect(rulesFor(FAKE, '<p class="text-[1.5rem]">x</p>')).toEqual(["arbitrary-font-size"]);
		expect(rulesFor(FAKE, '<p class="text-2xs">x</p>')).toEqual([]);
		expect(rulesFor(FAKE, '<div class="bg-[#ff0000]">x</div>')).toContain("arbitrary-colour");
	});

	it("flags every arbitrary colour syntax, not only hex", () => {
		for (const token of [
			"bg-[#ff0000]",
			"bg-[rgb(255,0,255)]",
			"bg-[rgba(255,0,255,0.5)]",
			"bg-[hsl(300,100%,50%)]",
			"bg-[red]",
			"bg-[var(--brand)]",
			"bg-[oklch(0.7_0.2_300)]",
			"text-[#ff0000]",
			"text-[rgb(255,0,255)]",
			"text-[red]",
			"border-[#00ff00]",
			"ring-[blue]",
		]) {
			expect(rulesFor(FAKE, `<div class="${token}">x</div>`)).toContain("arbitrary-colour");
		}
		expect(rulesFor(FAKE, '<p class="text-[13px]">x</p>')).toEqual(["arbitrary-font-size"]);
	});

	it("flags hex literals except in the chart palette file", () => {
		expect(rulesFor(FAKE, "const ink = '#52514e';")).toEqual(["hex-colour"]);
		expect(
			rulesFor("packages/ui-registry/src/charts/chartMath.ts", "const ink = '#52514e';"),
		).toEqual([]);
	});

	it("flags inline style attributes", () => {
		expect(rulesFor(FAKE, '<div style="color: red">x</div>')).toEqual(["inline-style"]);
		expect(rulesFor(FAKE, "<div style={{ color: 'red' }}>x</div>")).toEqual(["inline-style"]);
		expect(rulesFor(FAKE, "<div>costStatement(x)</div>")).toEqual([]);
	});

	it("flags corner radii other than rounded and rounded-full", () => {
		expect(rulesFor(FAKE, '<div class="rounded-lg">x</div>')).toEqual(["corner-radius"]);
		expect(rulesFor(FAKE, '<div class="rounded rounded-full">x</div>')).toEqual([]);
	});

	it("flags every arbitrary radius as one token, not as bare rounded", () => {
		for (const token of ["rounded-[12px]", "rounded-[2rem]", "rounded-[50%]"]) {
			expect(rulesFor(FAKE, `<div class="${token}">x</div>`)).toEqual(["corner-radius"]);
			expect(
				rulesFor("apps/web/src/chat/Conversation.tsx", `<div class="${token}">x</div>`),
			).toEqual(["corner-radius"]);
		}
	});

	it("allows the large chat radius only inside the chat surface", () => {
		const chatFile = "apps/web/src/chat/Conversation.tsx";
		expect(rulesFor(chatFile, '<div class="rounded-2xl">x</div>')).toEqual([]);
		expect(rulesFor(chatFile, '<button class="rounded-full">x</button>')).toEqual([]);
		expect(rulesFor(FAKE, '<div class="rounded-2xl">x</div>')).toEqual(["corner-radius"]);
		expect(rulesFor(chatFile, '<div class="rounded-lg">x</div>')).toEqual(["corner-radius"]);
	});

	it("flags secondary text lighter than slate-600", () => {
		for (const step of FORBIDDEN_LIGHT_TEXT) {
			expect(rulesFor(FAKE, `<p class="text-slate-${step}">x</p>`)).toEqual(["secondary-text"]);
		}
		// Neighbours of the reported `text-slate-200`: every lighter step fails.
		expect(rulesFor(FAKE, '<p class="text-slate-200">x</p>')).toEqual(["secondary-text"]);
		expect(rulesFor(FAKE, '<p class="text-slate-100">x</p>')).toEqual(["secondary-text"]);
		expect(rulesFor(FAKE, '<p class="text-slate-50">x</p>')).toEqual(["secondary-text"]);
		expect(rulesFor(FAKE, '<p class="text-slate-600">x</p>')).toEqual([]);
		expect(rulesFor(FAKE, '<p class="text-slate-700">x</p>')).toEqual([]);
		expect(rulesFor(FAKE, '<div class="border-slate-400">x</div>')).toEqual([]);
	});

	it("flags h1 outside App.tsx and h2 outside the page header", () => {
		expect(rulesFor(FAKE, "<h1>App</h1>")).toEqual(["heading-level"]);
		expect(rulesFor("apps/web/src/App.tsx", "<h1>App</h1>")).toEqual([]);
		expect(rulesFor(FAKE, "<h2>Section</h2>")).toEqual(["heading-level"]);
		expect(rulesFor("apps/web/src/components/ui.tsx", "<h2>Page</h2>")).toEqual([]);
		expect(rulesFor(FAKE, "<h3>Section</h3><h4>Sub</h4>")).toEqual([]);
	});

	it("reports the file, line and offending token", () => {
		const [entry] = checkSourceFile(FAKE, '<div class="a">x</div>\n<p class="rounded-md">y</p>\n');
		expect(entry).toMatchObject({
			file: FAKE,
			line: 2,
			rule: "corner-radius",
			token: "rounded-md",
		});
	});
});
