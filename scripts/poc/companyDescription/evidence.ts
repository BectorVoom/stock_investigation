import { isBareSegment } from "@research/contracts";
import type {
	CompanyDescription,
	CompanySource,
	Evidence,
	VerifiedDescription,
} from "./template.ts";

/**
 * The evidence check: a field is shown only when every quote it gives is
 * found, word for word, in the source it names. Comparison ignores what a
 * model rewrites without changing the words — Unicode width (NFKC), curly
 * versus straight quotes and dashes, letter case and runs of whitespace —
 * and nothing else, so a paraphrase is a failure. Numbers get a second
 * rule: a stated percentage must appear in one of its quotes, and text with
 * a digit must quote something with a digit — a figure is never the model's.
 */
export function normalizeForQuote(text: string): string {
	return text
		.normalize("NFKC")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/** The numbers written in `text` ("1,234.5" → 1234.5). */
export function numbersIn(text: string): number[] {
	const matches = text.normalize("NFKC").match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
	return matches.map((match) => Number(match.replaceAll(",", "")));
}

export type EvidenceProblem =
	| { readonly kind: "unknown-source"; readonly evidence: Evidence }
	| { readonly kind: "quote-not-found"; readonly evidence: Evidence }
	| { readonly kind: "number-not-quoted"; readonly value: number }
	| { readonly kind: "digit-without-quote" }
	| { readonly kind: "unquoted-term"; readonly term: string };

/** One model-written field as the check sees it. */
export interface CheckedField {
	/** Where it is in the reply: "feature", "segments[1]", "themes[0].reason". */
	readonly path: string;
	readonly problems: readonly EvidenceProblem[];
}

interface FieldToCheck {
	readonly path: string;
	readonly texts: readonly string[];
	/** The English and the Japanese texts apart: the claim check reads the one in the quotes' language. */
	readonly textsEn: readonly string[];
	readonly textsJa: readonly string[];
	/** Numbers the field states as data (a sales share, a margin): each must be quoted. */
	readonly numbers: readonly number[];
	readonly evidence: readonly Evidence[];
}

const DIGIT = /[0-9０-９]/;
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/;

/** Katakana words that name no particular thing: not checked against the quotes. */
const GENERIC_KATAKANA = new Set([
	"メーカー",
	"サービス",
	"グループ",
	"ビジネス",
	"セグメント",
	"システム",
	"ソリューション",
	"ブランド",
	"ユーザー",
	"カテゴリー",
	"ライン",
	"マーケット",
	"アジア",
	"ヨーロッパ",
	"アメリカ",
	"アフリカ",
	"オセアニア",
	"グローバル",
	"トップ",
	"シェア",
	"リーディング",
	"パートナー",
	"ネットワーク",
	"プラットフォーム",
	"コンテンツ",
	"テクノロジー",
	"エリア",
	"チェーン",
	"センター",
	"クライアント",
	"カンパニー",
	"ホールディングス",
]);

/** Katakana endings that describe rather than name (「シートメーカー」 is a maker of シート). */
const DESCRIPTIVE_SUFFIXES = [
	"メーカー",
	"チェーン",
	"ブランド",
	"サービス",
	"システム",
	"ソリューション",
	"ビジネス",
	"カンパニー",
	"センター",
] as const;

/** Capitalised English words that name no particular thing. */
const GENERIC_LATIN = new Set([
	"the",
	"and",
	"inc",
	"ltd",
	"co",
	"corp",
	"corporation",
	"company",
	"group",
	"holdings",
	"segment",
	"segments",
	"business",
	"products",
	"services",
	"japan",
	"japanese",
	"us",
	"usa",
	"u.s",
	"tse",
	"jpx",
]);

/**
 * The words of a field that name a particular thing — katakana words and
 * Latin-script names in Japanese text, capitalised words after the first
 * of each English sentence — and its numbers. Each must appear in the
 * field's quotes or in the sources it cites: a quote proves only that the
 * quote is in the source, so 「トヨタグループの」 with a quote that never
 * says it passed the quote check (2026-11-04). Requiring the quote itself
 * rejected 34–45% of fields (mostly names the source states a line away),
 * so the cited sources' text counts too. Kanji names are not checked.
 */
export function claimTerms(text: string, japanese: boolean): string[] {
	const terms = new Set<string>();
	if (japanese) {
		for (const match of text.match(/[ァ-ヶー]{3,}/g) ?? []) {
			if (GENERIC_KATAKANA.has(match)) continue;
			// 「シートメーカー」 names シート: a descriptive suffix says nothing. 「グループ」
			// is not one — 「トヨタグループ」 claims a membership.
			const suffix = DESCRIPTIVE_SUFFIXES.find(
				(word) => match.endsWith(word) && match.length >= word.length + 3,
			);
			terms.add(suffix === undefined ? match : match.slice(0, -suffix.length));
		}
		for (const match of text.normalize("NFKC").match(/[A-Za-z][A-Za-z0-9&+-]+/g) ?? []) {
			if (!GENERIC_LATIN.has(match.toLowerCase())) terms.add(match);
		}
	} else {
		for (const sentence of text.split(/(?<=[.;:!?])\s+/)) {
			const words = sentence.match(/[A-Za-z][A-Za-z0-9&+.-]*/g) ?? [];
			for (const word of words.slice(1)) {
				const clean = word.replace(/[.-]+$/, "");
				if (/^[A-Z]/.test(clean) && clean.length >= 2 && !GENERIC_LATIN.has(clean.toLowerCase())) {
					terms.add(clean);
				}
			}
		}
	}
	return [...terms];
}

/** The year before an era's first year: 昭和5年 is 1925 + 5 = 1930. */
const ERA_BASE: Readonly<Record<string, number>> = {
	明治: 1867,
	大正: 1911,
	昭和: 1925,
	平成: 1988,
	令和: 2018,
};

/** Japanese-era years written in `text` as Western years (「昭和5年」 → 1930, 「平成元年」 → 1989). */
export function westernYearsIn(text: string): number[] {
	const years: number[] = [];
	for (const match of text
		.normalize("NFKC")
		.matchAll(/(明治|大正|昭和|平成|令和)\s*(\d+|元)\s*年/g)) {
		const base = match[1] === undefined ? undefined : ERA_BASE[match[1]];
		const number = match[2] === "元" ? 1 : Number(match[2]);
		if (base !== undefined && Number.isInteger(number)) years.push(base + number);
	}
	return years;
}

function claimProblems(
	field: FieldToCheck,
	sources: ReadonlyMap<string, string>,
): EvidenceProblem[] {
	if (field.evidence.length === 0) return [];
	const quotes = field.evidence.map((evidence) => evidence.quote).join("\n");
	const japanese = JAPANESE.test(quotes);
	const texts = japanese ? field.textsJa : field.textsEn;
	// The text of the sources the field cites, not only the quotes: a name the
	// quote leaves out but its source states is a quoting slip; a name in none
	// of them came from the model's own knowledge.
	const cited = [...new Set(field.evidence.map((evidence) => evidence.source))]
		.map((id) => sources.get(id) ?? "")
		.join("\n");
	const normalizedQuotes = `${normalizeForQuote(quotes)}\n${cited}`;
	const quotedNumbers = new Set([
		...numbersIn(quotes),
		...numbersIn(cited),
		...westernYearsIn(quotes),
		...westernYearsIn(cited),
	]);
	const problems: EvidenceProblem[] = [];
	for (const text of texts) {
		for (const term of claimTerms(text, japanese)) {
			if (!normalizedQuotes.includes(normalizeForQuote(term))) {
				problems.push({ kind: "unquoted-term", term });
			}
		}
		// With no digit in any quote, "digit-without-quote" has already said so.
		if (DIGIT.test(quotes)) {
			for (const value of numbersIn(text)) {
				if (!quotedNumbers.has(value))
					problems.push({ kind: "unquoted-term", term: String(value) });
			}
		}
	}
	return problems;
}

function fieldProblems(
	field: FieldToCheck,
	sources: ReadonlyMap<string, string>,
): EvidenceProblem[] {
	const problems: EvidenceProblem[] = [];
	for (const evidence of field.evidence) {
		const normalizedSource = sources.get(evidence.source);
		if (normalizedSource === undefined) {
			problems.push({ kind: "unknown-source", evidence });
		} else if (!normalizedSource.includes(normalizeForQuote(evidence.quote))) {
			problems.push({ kind: "quote-not-found", evidence });
		}
	}
	const quoted = new Set(field.evidence.flatMap((evidence) => numbersIn(evidence.quote)));
	for (const value of field.numbers) {
		if (!quoted.has(value)) problems.push({ kind: "number-not-quoted", value });
	}
	if (
		field.texts.some((text) => DIGIT.test(text)) &&
		!field.evidence.some((evidence) => DIGIT.test(evidence.quote))
	) {
		problems.push({ kind: "digit-without-quote" });
	}
	problems.push(...claimProblems(field, sources));
	return problems;
}

function fieldsOf(description: CompanyDescription): FieldToCheck[] {
	const statement = (
		path: string,
		item: { en: string; ja: string; evidence: readonly Evidence[] },
	): FieldToCheck => ({
		path,
		texts: [item.en, item.ja],
		textsEn: [item.en],
		textsJa: [item.ja],
		numbers: [],
		evidence: item.evidence,
	});
	return [
		statement("feature", description.feature),
		...description.businesses.map((item, index) => statement(`businesses[${index}]`, item)),
		...description.segments.map((segment, index) => ({
			path: `segments[${index}]`,
			texts: [
				segment.name.en,
				segment.name.ja,
				...(segment.activity === null ? [] : [segment.activity.en, segment.activity.ja]),
			],
			textsEn: [segment.name.en, ...(segment.activity === null ? [] : [segment.activity.en])],
			textsJa: [segment.name.ja, ...(segment.activity === null ? [] : [segment.activity.ja])],
			numbers: [segment.salesSharePercent, segment.marginPercent].flatMap((value) =>
				value === null ? [] : [Math.abs(value)],
			),
			evidence: segment.evidence,
		})),
		...(description.overseasSales === null
			? []
			: [
					{
						path: "overseasSales",
						texts: [],
						textsEn: [],
						textsJa: [],
						numbers: [description.overseasSales.percent],
						evidence: description.overseasSales.evidence,
					},
				]),
		...description.profile.map((fact, index) => ({
			path: `profile[${index}]`,
			texts: [fact.value.en, fact.value.ja],
			textsEn: [fact.value.en],
			textsJa: [fact.value.ja],
			numbers: [],
			evidence: fact.evidence,
		})),
		...description.themes.map((theme, index) => statement(`themes[${index}].reason`, theme.reason)),
	];
}

/** Every model-written field of a description with its problems (none = verified). */
export function checkDescription(
	description: CompanyDescription,
	sources: readonly CompanySource[],
): CheckedField[] {
	const normalized = new Map(sources.map((source) => [source.id, normalizeForQuote(source.text)]));
	return fieldsOf(description).map((field) => ({
		path: field.path,
		problems: fieldProblems(field, normalized),
	}));
}

/** One line per problem, for the repair turn and the report. */
export function describeProblems(checked: readonly CheckedField[]): string[] {
	return checked.flatMap((field) =>
		field.problems.map((problem) => {
			switch (problem.kind) {
				case "unknown-source":
					return `${field.path}: source ${problem.evidence.source} does not exist.`;
				case "quote-not-found":
					return `${field.path}: the quote "${problem.evidence.quote}" is not in ${problem.evidence.source} word for word.`;
				case "number-not-quoted":
					return `${field.path}: the number ${problem.value} is not in any of its quotes; use null when no source states it.`;
				case "digit-without-quote":
					return `${field.path}: the text has a number but no quote with a number.`;
				case "unquoted-term":
					return `${field.path}: "${problem.term}" is in the text but in none of its quotes or cited sources; leave it out, or quote the passage that states it.`;
			}
			return `${field.path}: unknown problem.`;
		}),
	);
}

/**
 * The description with every unverified field and every bare segment removed — what is stored and
 * what the Company tab shows. A failing feature leaves it null.
 */
export function keepVerified(
	description: CompanyDescription,
	checked: readonly CheckedField[],
): VerifiedDescription {
	const failed = new Set(
		checked.filter((field) => field.problems.length > 0).map((field) => field.path),
	);
	const ok = (path: string) => !failed.has(path);
	return {
		feature: ok("feature") ? description.feature : null,
		businesses: description.businesses.filter((_, index) => ok(`businesses[${index}]`)),
		// A segment that is only its name (a region heading) says nothing; it is not stored.
		segments: description.segments.filter(
			(segment, index) => ok(`segments[${index}]`) && !isBareSegment(segment),
		),
		overseasSales: ok("overseasSales") ? description.overseasSales : null,
		profile: description.profile.filter((_, index) => ok(`profile[${index}]`)),
		themes: description.themes.filter((_, index) => ok(`themes[${index}].reason`)),
	};
}
