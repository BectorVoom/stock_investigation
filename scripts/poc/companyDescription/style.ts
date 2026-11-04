import { normalizeForQuote } from "./evidence.ts";
import type { CompanySource, DescriptionToCheck, Evidence } from "./template.ts";

/**
 * The style rules (template.ts STYLE_RULES) as a check: the prompt alone
 * left 222 of 993 entries with a banned pattern (158 English texts starting
 * "The company", 41 「を通じて」, 26 「注力」; review of 2026-11-04). A hit
 * asks for the repair turn; it never removes a field, because the wording
 * is not a factual error. A phrase the cited source itself uses is allowed.
 */

const BANNED_JA = [
	"幅広い",
	"多岐にわたる",
	"さまざまな",
	"様々な",
	"多様な",
	"革新的な",
	"先進的な",
	"包括的な",
	"注力",
	"を通じて",
	"に取り組む",
	"をリード",
	"重要な役割を果たす",
	"強み",
	"高品質な",
	"しています",
	"となっています",
	"を行っています",
] as const;

const BANNED_EN = [
	"leading",
	"innovative",
	"comprehensive",
	"diverse",
	"robust",
	"cutting-edge",
	"seamless",
	"renowned",
	"key player",
	"a wide range of",
	"various",
	"plays a vital role",
	"is committed to",
	"strives to",
	"not only",
] as const;

interface StyledText {
	readonly path: string;
	readonly en: string;
	readonly ja: string;
	readonly evidence: readonly Evidence[];
}

function styledTexts(description: DescriptionToCheck): StyledText[] {
	return [
		...(description.feature === null ? [] : [{ path: "feature", ...description.feature }]),
		...description.businesses.map((item, index) => ({ path: `businesses[${index}]`, ...item })),
		...description.segments.flatMap((segment, index) =>
			segment.activity === null
				? []
				: [{ path: `segments[${index}]`, ...segment.activity, evidence: segment.evidence }],
		),
		...description.themes.map((theme, index) => ({
			path: `themes[${index}].reason`,
			...theme.reason,
		})),
	];
}

/** One line per style problem, for the repair turn; empty when the text reads as the rules ask. */
export function styleProblems(
	description: DescriptionToCheck,
	sources: readonly CompanySource[],
): string[] {
	const sourceText = new Map(sources.map((source) => [source.id, normalizeForQuote(source.text)]));
	const problems: string[] = [];
	for (const item of styledTexts(description)) {
		const cited = item.evidence.map((evidence) => sourceText.get(evidence.source) ?? "").join("\n");
		const inSource = (phrase: string) => cited.includes(normalizeForQuote(phrase));
		if (/^the company\b/i.test(item.en.trim())) {
			problems.push(
				`${item.path}: the English starts with "The company"; start with what it does.`,
			);
		}
		if (item.en.includes("—") || item.ja.includes("——") || item.ja.includes("—")) {
			problems.push(`${item.path}: no em dashes.`);
		}
		const english = normalizeForQuote(item.en);
		for (const phrase of BANNED_EN) {
			if (new RegExp(`\\b${phrase}\\b`).test(english) && !inSource(phrase)) {
				problems.push(`${item.path}: "${phrase}" is a banned phrase; name the thing instead.`);
			}
		}
		for (const phrase of BANNED_JA) {
			if (item.ja.includes(phrase) && !inSource(phrase)) {
				problems.push(`${item.path}: 「${phrase}」 is a banned phrase; write it plainly.`);
			}
		}
	}
	return problems;
}
